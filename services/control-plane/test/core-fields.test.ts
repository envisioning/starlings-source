import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { resetCorePatCache } from '../src/crm';

// The web's door to Core's CRM registry (meet#233): the Fields pane and the
// palette's Core search, answered with the member's broker PAT.

const SECRET = 'meet-core-shared-secret-at-least-32-chars';
const secretEnv = { ...env, INTERNAL_REQUEST_SECRET: SECRET, CRM_SYNC_MODE: 'on' } as Env;
const PROJECT_ID = 'c0ffee00-0000-4000-8000-000000000001';

function coreAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const issuedToken = {
  ok: true,
  token: 'core_pat_fields',
  scopes: ['projects:read', 'projects:write', 'search:read'],
  expires_at: '2026-12-07T09:00:00.000Z',
  email: 'rosa@example.com',
};

const projectsEntity = {
  id: 'projects',
  singularLabel: 'Project',
  pluralLabel: 'Projects',
  primaryField: 'name',
  capabilities: { create: true, update: true, delete: false, search: true },
  fields: [
    { name: 'basics', label: 'Basics', kind: 'section' },
    { name: 'name', label: 'Name', kind: 'text', required: true },
    { name: 'status', label: 'Status', kind: 'select', options: [{ value: 'active', label: 'Active' }] },
  ],
  access: { canRead: true, canWrite: true, missingScopes: [] },
};

interface Call { path: string; method: string; authorization: string | null; body: unknown }

function mockCore(answer: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    const text = request.method === 'GET' ? '' : await request.text();
    const call: Call = {
      path: url.pathname + url.search,
      method: request.method,
      authorization: request.headers.get('authorization'),
      body: text ? JSON.parse(text) : undefined,
    };
    calls.push(call);
    if (url.pathname === '/api/public/meet-owner-exchange') return coreAnswer(issuedToken);
    return answer(call);
  });
  return calls;
}

beforeEach(() => resetCorePatCache());

afterEach(async () => {
  await resetCorePatCache();
  vi.restoreAllMocks();
});

async function ownerSession(context: ExecutionContext, target: Env = secretEnv): Promise<string> {
  const response = await worker.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
  }), target, context);
  return (await response.json<{ access_token: string }>()).access_token;
}

function authed(token: string, path: string, init: RequestInit = {}): Request {
  return new Request(`http://local${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
}

describe('GET /api/core/registry', () => {
  it('requires an owner session', async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(new Request('http://local/api/core/registry'), secretEnv, context);
    expect(response.status).toBe(401);
    await waitOnExecutionContext(context);
  });

  it('answers not_configured without calling Core when the bridge is off', async () => {
    const context = createExecutionContext();
    const unconfigured = { ...env, INTERNAL_REQUEST_SECRET: '' } as Env;
    const token = await ownerSession(context, unconfigured);
    const calls = mockCore(() => coreAnswer({}, 500));
    const response = await worker.fetch(authed(token, '/api/core/registry'), unconfigured, context);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'not_configured' });
    expect(calls).toEqual([]);
    await waitOnExecutionContext(context);
  });

  it('reads the registry as the member and passes on only the entities it can read', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(context);
    const calls = mockCore((call) => call.path === '/api/agent/meta/registry'
      ? coreAnswer({ data: { space: 'crm', entities: [projectsEntity, { id: 'broken' }], operations: [{ id: 'projects.get' }] } })
      : coreAnswer({}, 404));

    const response = await worker.fetch(authed(token, '/api/core/registry'), secretEnv, context);

    expect(response.status).toBe(200);
    const body = await response.json<{ data: { entities: Array<{ id: string }>; operations?: unknown } }>();
    expect(body.data.entities.map((entity) => entity.id)).toEqual(['projects']);
    expect(body.data.operations).toBeUndefined();
    expect(calls.map((call) => call.path)).toEqual(['/api/public/meet-owner-exchange', '/api/agent/meta/registry']);
    expect(calls[1]!.authorization).toBe('Bearer core_pat_fields');
    await waitOnExecutionContext(context);
  });
});

describe('/api/core/fields/:entity/:id', () => {
  it('reads the record behind a subject', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(context);
    const calls = mockCore((call) => call.path === `/api/agent/projects/${PROJECT_ID}`
      ? coreAnswer({ data: { id: PROJECT_ID, name: 'Atlas', status: 'active' } })
      : coreAnswer({}, 404));

    const response = await worker.fetch(authed(token, `/api/core/fields/projects/${PROJECT_ID}`), secretEnv, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id: PROJECT_ID, name: 'Atlas', status: 'active' } });
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: `/api/agent/projects/${PROJECT_ID}` });
    await waitOnExecutionContext(context);
  });

  it('writes only what changed, as the member', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(context);
    const calls = mockCore((call) => call.method === 'PATCH'
      ? coreAnswer({ data: { id: PROJECT_ID, name: 'Atlas 2' } })
      : coreAnswer({}, 404));

    const response = await worker.fetch(authed(token, `/api/core/fields/projects/${PROJECT_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Atlas 2' }),
    }), secretEnv, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { id: PROJECT_ID, name: 'Atlas 2' } });
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', path: `/api/agent/projects/${PROJECT_ID}`, body: { name: 'Atlas 2' } });
    await waitOnExecutionContext(context);
  });

  it('refuses an entity that is not behind a Work subject, without calling Core', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(context);
    const calls = mockCore(() => coreAnswer({ data: {} }));

    const response = await worker.fetch(authed(token, '/api/core/fields/tasks/abc'), secretEnv, context);

    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
    await waitOnExecutionContext(context);
  });

  it('refuses a nested value before it reaches Core', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(context);
    const calls = mockCore(() => coreAnswer({ data: {} }));

    const response = await worker.fetch(authed(token, `/api/core/fields/leads/${PROJECT_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({ tags: ['a'] }),
    }), secretEnv, context);

    expect(response.status).toBe(400);
    expect(calls.filter((call) => call.path.startsWith('/api/agent/'))).toEqual([]);
    await waitOnExecutionContext(context);
  });

  it('passes Core\'s refusal on with the field that failed', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(context);
    mockCore(() => coreAnswer({ error: 'Validation error', details: { name: { _errors: ['Required'] } } }, 400));

    const response = await worker.fetch(authed(token, `/api/core/fields/projects/${PROJECT_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: null }),
    }), secretEnv, context);

    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toContain('name: Required');
    await waitOnExecutionContext(context);
  });
});

describe('GET /api/core/search', () => {
  it('asks Core as the member and keeps only hits with a Core dashboard page', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(context);
    const calls = mockCore((call) => call.path.startsWith('/api/agent/search')
      ? coreAnswer({
        data: [
          { entity: 'contacts', id: 'c1', name: 'Nadia Silva', description: 'Acme Corp', href: '/dashboard/contacts/c1' },
          { entity: 'contacts', id: 'c2', name: 'Elsewhere', href: 'https://evil.example/x' },
        ],
        meta: { count: 2, query: 'nadia', entity: null },
      })
      : coreAnswer({}, 404));

    const response = await worker.fetch(authed(token, '/api/core/search?q=nadia'), secretEnv, context);

    expect(response.status).toBe(200);
    const body = await response.json<{ data: Array<{ id: string }> }>();
    expect(body.data.map((hit) => hit.id)).toEqual(['c1']);
    expect(calls.at(-1)!.path).toBe('/api/agent/search?q=nadia&limit=20');
    await waitOnExecutionContext(context);
  });

  it('drops the hits of a group that answers from D1, and keeps the rest (meet#1221)', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(context);
    mockCore((call) => call.path.startsWith('/api/agent/search')
      ? coreAnswer({
        data: [
          { entity: 'contacts', id: 'c1', name: 'Nadia Silva', href: '/dashboard/contacts/c1' },
          { entity: 'organizations', id: 'o1', name: 'Nadia Labs', href: '/dashboard/organizations/o1' },
          { entity: 'tasks', id: 't1', name: 'Call Nadia', href: '/dashboard/tasks/t1' },
          { entity: 'offers', id: 'f1', name: 'Nadia offer', href: '/dashboard/offers/f1' },
        ],
      })
      : coreAnswer({}, 404));
    const subjectsOnD1 = { ...secretEnv, WORK_STORE_SUBJECTS: 'd1' } as Env;

    const response = await worker.fetch(authed(token, '/api/core/search?q=nadia'), subjectsOnD1, context);

    expect(response.status).toBe(200);
    const body = await response.json<{ data: Array<{ id: string }> }>();
    // Contacts and organizations moved; tasks have not, and offers are in no group.
    expect(body.data.map((hit) => hit.id)).toEqual(['t1', 'f1']);
    await waitOnExecutionContext(context);
  });

  it('refuses an empty query', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(context);
    const calls = mockCore(() => coreAnswer({ data: [] }));
    const response = await worker.fetch(authed(token, '/api/core/search?q=%20'), secretEnv, context);
    expect(response.status).toBe(400);
    expect(calls.filter((call) => call.path.startsWith('/api/agent/'))).toEqual([]);
    await waitOnExecutionContext(context);
  });
});

describe('GET /api/crm/organizations', () => {
  it('asks Core for organizations only, retries a 429, and lists the matches (meet#626)', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(context);
    let searches = 0;
    const calls = mockCore((call) => {
      if (!call.path.startsWith('/api/agent/search')) return coreAnswer({}, 404);
      searches += 1;
      if (searches === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
      return coreAnswer({ data: [{ entity: 'organizations', id: 'c0ffee00-0000-4000-8000-0000000000ee', name: 'Envisioning', href: '/dashboard/organizations/x' }] });
    });
    const response = await worker.fetch(authed(token, '/api/crm/organizations?q=env'), secretEnv, context);
    expect(response.status).toBe(200);
    expect((await response.json<{ organizations: Array<{ name: string }> }>()).organizations.map((o) => o.name)).toEqual(['Envisioning']);
    expect(calls.filter((call) => call.path.startsWith('/api/agent/search')).at(-1)!.path).toBe('/api/agent/search?q=env&entity=organizations&limit=20');
    expect(searches).toBe(2);
    await waitOnExecutionContext(context);
  });

  it('answers a two-letter query through the Worker path (meet#626)', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(context);
    const calls = mockCore((call) => {
      if (!call.path.startsWith('/api/agent/search')) return coreAnswer({}, 404);
      return coreAnswer({ data: [
        { entity: 'organizations', id: 'c0ffee00-0000-4000-8000-0000000000e1', name: 'Innocean', href: '/dashboard/organizations/a' },
        { entity: 'organizations', id: 'c0ffee00-0000-4000-8000-0000000000e2', name: 'Inspire Labs', href: '/dashboard/organizations/b' },
      ] });
    });
    const response = await worker.fetch(authed(token, '/api/crm/organizations?q=in'), secretEnv, context);
    expect(response.status).toBe(200);
    expect((await response.json<{ organizations: Array<{ name: string }> }>()).organizations.map((o) => o.name)).toEqual(['Innocean', 'Inspire Labs']);
    expect(calls.filter((call) => call.path.startsWith('/api/agent/search')).at(-1)!.path).toBe('/api/agent/search?q=in&entity=organizations&limit=20');
    await waitOnExecutionContext(context);
  });

  it('answers an error, never an empty list, when Core fails', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(context);
    mockCore(() => coreAnswer({ error: 'boom' }, 500));
    const response = await worker.fetch(authed(token, '/api/crm/organizations?q=env'), secretEnv, context);
    expect(response.status).toBe(500);
    await waitOnExecutionContext(context);
  });
});

describe('POST /api/crm/subjects', () => {
  const body = { kind: 'lead', title: 'Innocean', status: 'Opportunity Identified', start_date: '2026-09-29' };

  it('refuses a lead with no organization before it calls Core (meet#625)', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(context);
    const calls = mockCore(() => coreAnswer({}, 500));
    const response = await worker.fetch(authed(token, '/api/crm/subjects', { method: 'POST', body: JSON.stringify(body) }), secretEnv, context);
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('Choose an organization');
    expect(calls.filter((call) => call.path.startsWith('/api/public/meet-crm-subjects'))).toEqual([]);
    await waitOnExecutionContext(context);
  });

  it('turns a Core 500 into a readable 502 that carries Core\'s detail (meet#625)', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(context);
    mockCore((call) => call.path.startsWith('/api/public/meet-crm-subjects')
      ? coreAnswer({ error: 'null value in column "organization_id"' }, 500)
      : coreAnswer({}, 404));
    const response = await worker.fetch(authed(token, '/api/crm/subjects', {
      method: 'POST',
      body: JSON.stringify({ ...body, organization_id: 'c0ffee00-0000-4000-8000-0000000000e1' }),
    }), secretEnv, context);
    expect(response.status).toBe(502);
    const { error } = await response.json<{ error: string }>();
    expect(error).toContain('subject create');
    expect(error).toContain('(500)');
    expect(error).toContain('null value in column "organization_id"');
    await waitOnExecutionContext(context);
  });
});
