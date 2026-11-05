import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { signingKey } from '../src/crypto';
import { resetCorePatCache } from '../src/crm';

/**
 * The folded `cms` tool with a CRM entity (docs/MCP.md): organizations,
 * contacts, interactions, projects and leads read and write through
 * `/api/core/*`, and Core sees the member's broker PAT on `/api/agent/<entity>`,
 * never the cms-editor one.
 */

const orgID = '3f0c8a52-6a55-4b0e-9a1f-0a5c6f1d2e77';
const busyOrgID = '9b1d5c3e-2f4a-4c8d-8e6b-7a0f1c2d3e4f';
const configured = {
  ...env,
  CRM_SYNC_MODE: 'on',
  CORE_API_BASE_URL: 'https://core.test',
  INTERNAL_REQUEST_SECRET: 'a-shared-test-secret-with-at-least-32-characters',
  SESSION_SIGNING_SECRET: 'mcp-records-signing-secret-with-32-characters',
} as Env;

beforeEach(() => resetCorePatCache());
afterEach(() => vi.restoreAllMocks());

async function bearer(scope: string): Promise<string> {
  const now = Date.now();
  await configured.USAGE.prepare(
    `INSERT OR REPLACE INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at) VALUES (?1, ?2, NULL, '["https://claude.ai/api/mcp/auth_callback"]', ?3)`,
  ).bind('client-orgs', 'claude.ai', now).run();
  await configured.USAGE.prepare(
    `INSERT OR REPLACE INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at)
     VALUES (?1, 'client-orgs', ?2, ?3, ?4, 'jti', NULL, ?5, ?5, NULL, NULL)`,
  ).bind('grant-orgs', 'dev:rosa@example.com', 'rosa@example.com', scope, now).run();
  return new SignJWT({ email: 'rosa@example.com', name: 'Rosa', scope, grant: 'grant-orgs', client: 'client-orgs' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('starlings.example')
    .setAudience('meet-mcp')
    .setSubject('dev:rosa@example.com')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey(configured.SESSION_SIGNING_SECRET));
}

async function rpc(token: string, method: string, params?: unknown, apiEnv: Env = configured) {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request('http://local/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params !== undefined ? { params } : {}) }),
  }), apiEnv, context);
  await waitOnExecutionContext(context);
  return response.json<{ result?: { isError?: boolean; content?: Array<{ text?: string }> }; error?: { message: string } }>();
}

function callTool(token: string, args: Record<string, unknown>, apiEnv: Env = configured) {
  return rpc(token, 'tools/call', { name: 'cms', arguments: args }, apiEnv);
}

interface Seen {
  presets: unknown[];
  agent: Array<{ method: string; path: string; search: string; bearer: string | null; body: Record<string, unknown> | null }>;
}

function mockCore(answer: (call: Seen['agent'][number]) => Response): Seen {
  const seen: Seen = { presets: [], agent: [] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/api/public/meet-owner-exchange') {
      const body = await request.json<Record<string, unknown>>();
      seen.presets.push(body.preset ?? null);
      return Response.json({
        ok: true,
        token: body.preset === 'cms-editor' ? 'pat-cms-editor' : 'pat-sales',
        scopes: ['organizations:read', 'organizations:write'],
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        email: 'rosa@example.com',
      });
    }
    if (/^\/api\/agent\/(entities\/)?(organizations|contacts|interactions|projects|leads)(\/|$)/u.test(url.pathname)) {
      const call = {
        method: request.method,
        path: url.pathname,
        search: url.search,
        bearer: request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? null,
        body: request.method === 'GET' || request.method === 'DELETE' ? null : await request.json<Record<string, unknown>>(),
      };
      seen.agent.push(call);
      return answer(call);
    }
    return Response.json({ error: `unmocked ${request.method} ${url.pathname}` }, { status: 500 });
  });
  return seen;
}

describe('cms tool, CRM records', () => {
  it('lists and searches the directory with the read scope', async () => {
    const seen = mockCore(() => Response.json({ data: [{ id: orgID, name: 'IIF', is_partner: true }] }));
    const token = await bearer('read');
    const answer = await callTool(token, { entity: 'organizations', q: 'future', limit: 5, offset: 10 });
    expect(answer.result?.isError).toBeFalsy();
    expect(JSON.parse(answer.result?.content?.[0]?.text ?? '')).toMatchObject({ data: [{ id: orgID, name: 'IIF' }] });
    expect(seen.agent.map((call) => `${call.method} ${call.path}${call.search}`)).toEqual([
      'GET /api/agent/organizations?q=future&limit=5&offset=10',
    ]);
    expect(seen.agent[0]!.bearer).toBe('pat-sales');
  });

  it('reads one organization by id', async () => {
    const seen = mockCore(() => Response.json({ data: { id: orgID, name: 'IIF' } }));
    await callTool(await bearer('read'), { entity: 'organizations', id: orgID });
    expect(seen.agent.map((call) => `${call.method} ${call.path}`)).toEqual([`GET /api/agent/organizations/${orgID}`]);
  });

  it('passes Core\'s own filters on contacts and interactions', async () => {
    const seen = mockCore(() => Response.json({ data: [] }));
    const token = await bearer('read');
    await callTool(token, { entity: 'contacts', filter: { organization_id: orgID }, limit: 20 });
    await callTool(token, { entity: 'interactions', filter: { type: 'note', lead_id: orgID } });
    expect(seen.agent.map((call) => `${call.method} ${call.path}${call.search}`)).toEqual([
      `GET /api/agent/contacts?limit=20&organization_id=${orgID}`,
      `GET /api/agent/interactions?type=note&lead_id=${orgID}`,
    ]);
  });

  it('refuses a filter Core would ignore, and never reaches Core', async () => {
    const seen = mockCore(() => Response.json({ data: [] }));
    const token = await bearer('read');
    for (const args of [
      { entity: 'leads', filter: { status: 'won' } },
      { entity: 'projects', filter: { organization_id: orgID } },
      { entity: 'contacts', filter: { lead_id: orgID } },
    ]) {
      const answer = await callTool(token, args);
      expect(answer.result?.isError).toBe(true);
      expect(answer.result?.content?.[0]?.text).toMatch(/^invalid_request: Core does not filter (leads|projects|contacts) by /u);
    }
    expect(seen.agent).toHaveLength(0);
  });

  it('passes organization_id and contact_id on leads', async () => {
    const seen = mockCore(() => Response.json({ data: [] }));
    const answer = await callTool(await bearer('read'), { entity: 'leads', filter: { organization_id: orgID, contact_id: busyOrgID }, limit: 5 });
    expect(answer.result?.isError).toBeFalsy();
    expect(seen.agent.map((call) => `${call.method} ${call.path}${call.search}`)).toEqual([
      `GET /api/agent/leads?limit=5&organization_id=${orgID}&contact_id=${busyOrgID}`,
    ]);
  });

  it('creates an organization with every field named, as the member', async () => {
    const seen = mockCore((call) => Response.json({ data: { id: orgID, ...call.body } }, { status: 201 }));
    const body = { name: 'Italian Institute for the Future', city: 'Naples', country: 'Italy', is_partner: true };
    const answer = await callTool(await bearer('read write'), { entity: 'organizations', body });
    expect(answer.result?.isError).toBeFalsy();
    expect(seen.agent).toEqual([expect.objectContaining({ method: 'POST', path: '/api/agent/organizations', bearer: 'pat-sales', body })]);
    expect(seen.presets).not.toContain('cms-editor');
  });

  it('updates an organization by id with PATCH', async () => {
    const seen = mockCore((call) => Response.json({ data: { id: orgID, ...call.body } }));
    await callTool(await bearer('read write'), { entity: 'organizations', id: orgID, body: { is_partner: false } });
    expect(seen.agent.map((call) => [call.method, call.path, call.body])).toEqual([
      ['PATCH', `/api/agent/organizations/${orgID}`, { is_partner: false }],
    ]);
  });

  it('refuses an organization write on a read grant, and never reaches Core', async () => {
    const seen = mockCore(() => Response.json({}));
    const answer = await callTool(await bearer('read'), { entity: 'organizations', body: { name: 'x' } });
    expect(answer.result?.isError ?? answer.error !== undefined).toBe(true);
    expect(seen.agent).toHaveLength(0);
  });

  it('passes Core\'s validation reason back', async () => {
    mockCore(() => Response.json({ error: 'Validation error', details: { _errors: [], city: { _errors: ['City cannot exceed 100 characters'] } } }, { status: 400 }));
    const answer = await callTool(await bearer('read write'), { entity: 'organizations', body: { name: 'x', city: 'y' } });
    expect(answer.result?.isError).toBe(true);
    expect(answer.result?.content?.[0]?.text).toContain('City cannot exceed');
  });

  it('creates a contact and a note, as the member', async () => {
    const seen = mockCore((call) => Response.json({ data: { id: orgID, ...call.body } }, { status: 201 }));
    const token = await bearer('read write');
    const contact = { first_name: 'Ada', last_name: 'Rossi', organization_id: orgID };
    const note = { title: 'Call with IIF', type: 'note', interaction_date: '2026-09-29T10:00:00', description: 'Intro.', organization_id: orgID };
    await callTool(token, { entity: 'contacts', body: contact });
    await callTool(token, { entity: 'interactions', body: note });
    expect(seen.agent.map((call) => [call.method, call.path, call.body])).toEqual([
      ['POST', '/api/agent/contacts', contact],
      ['POST', '/api/agent/interactions', note],
    ]);
  });

  it('creates and edits a project and a lead', async () => {
    const seen = mockCore((call) => Response.json({ data: { id: orgID, ...call.body } }, { status: call.method === 'POST' ? 201 : 200 }));
    const token = await bearer('read write');
    await callTool(token, { entity: 'projects', body: { organization_id: orgID, title: 'Atlas' } });
    await callTool(token, { entity: 'leads', body: { organization_id: orgID, title: 'IIF', start_date: '2026-09-29' } });
    await callTool(token, { entity: 'projects', id: orgID, body: { title: 'Atlas 2' } });
    expect(seen.agent.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /api/agent/projects',
      'POST /api/agent/leads',
      `PATCH /api/agent/projects/${orgID}`,
    ]);
  });

  it('deletes an organization only through Core\'s guard', async () => {
    const seen = mockCore(() => Response.json({ data: { id: orgID, deleted: true } }));
    const answer = await callTool(await bearer('read write'), { entity: 'organizations', id: orgID, delete: true });
    expect(answer.result?.isError).toBeFalsy();
    expect(seen.agent.map((call) => `${call.method} ${call.path}${call.search}`)).toEqual([
      `DELETE /api/agent/organizations/${orgID}?if_unreferenced=true`,
    ]);
  });

  it('says what still points at an organization, and deletes nothing', async () => {
    mockCore(() => Response.json({
      error: 'Organization is in use (leads 2, contacts 3). Move or merge those records first.',
      code: 'organization_in_use',
      references: [{ table: 'leads', column: 'organization_id', count: 2, onDelete: 'no action' }],
    }, { status: 409 }));
    const answer = await callTool(await bearer('read write'), { entity: 'organizations', id: busyOrgID, delete: true });
    expect(answer.result?.isError).toBe(true);
    expect(answer.result?.content?.[0]?.text).toContain('leads 2, contacts 3');
  });

  it('refuses delete on a read grant and for any other entity', async () => {
    const seen = mockCore(() => Response.json({}));
    const read = await callTool(await bearer('read'), { entity: 'organizations', id: orgID, delete: true });
    expect(read.result?.isError ?? read.error !== undefined).toBe(true);
    const contact = await callTool(await bearer('read write'), { entity: 'contacts', id: orgID, delete: true });
    expect(contact.result?.isError ?? contact.error !== undefined).toBe(true);
    expect(seen.agent).toHaveLength(0);
  });

  it('merges contacts through Core\'s merge, as the member', async () => {
    const dupe = '5b9abbd0-f9e1-4b09-9c77-a34ea013fe68';
    const seen = mockCore(() => Response.json({ data: { survivorId: orgID, mergedContactIds: [dupe] } }));
    const answer = await callTool(await bearer('read write'), { entity: 'contacts', merge: [orgID, dupe] });
    expect(answer.result?.isError).toBeFalsy();
    expect(seen.agent.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/agent/entities/contacts/merge']);
    expect(seen.agent[0]?.body).toEqual({ ids: [orgID, dupe] });
    expect(seen.agent[0]?.bearer).toBe('pat-sales');
  });

  it('refuses a merge on a read grant, of one id, or of another entity', async () => {
    const seen = mockCore(() => Response.json({}));
    const token = await bearer('read write');
    const read = await callTool(await bearer('read'), { entity: 'contacts', merge: [orgID, busyOrgID] });
    expect(read.result?.isError ?? read.error !== undefined).toBe(true);
    for (const args of [
      { entity: 'contacts', merge: [orgID] },
      { entity: 'contacts', merge: [orgID, orgID] },
      { entity: 'leads', merge: [orgID, busyOrgID] },
    ]) {
      const answer = await callTool(token, args);
      expect(answer.result?.isError ?? answer.error !== undefined).toBe(true);
    }
    expect(seen.agent).toHaveLength(0);
  });

  it('serves the Core registry as a resource', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === '/api/public/meet-owner-exchange') {
        return Response.json({ ok: true, token: 'pat-sales', scopes: ['meta:read'], expires_at: new Date(Date.now() + 86_400_000).toISOString(), email: 'rosa@example.com' });
      }
      if (url.pathname === '/api/agent/meta/registry') return Response.json({ data: { space: 'crm', entities: [] } });
      return Response.json({}, { status: 500 });
    });
    const answer = await rpc(await bearer('read'), 'resources/read', { uri: 'starlings://core/registry' });
    expect(answer.error).toBeUndefined();
    expect(answer.result?.isError).toBeFalsy();
  });
});

describe('cms tool, CRM records follow the group store (meet#1212)', () => {
  /** Envisioning after the subjects flip: subjects in D1, interactions still in Core. */
  const subjectsOnD1 = { ...configured, WORK_STORE_SUBJECTS: 'd1' } as Env;
  const created: Array<[table: string, id: string]> = [];
  const dataOf = (answer: Awaited<ReturnType<typeof callTool>>) => {
    expect(answer.result?.isError, JSON.stringify(answer)).toBeFalsy();
    return (JSON.parse(answer.result?.content?.[0]?.text ?? '{}') as { data: Record<string, unknown> }).data;
  };

  afterEach(async () => {
    // Children first: `created` keeps that order.
    for (const [table, id] of created) {
      if (table === 'contacts') await configured.USAGE.prepare('DELETE FROM contact_emails WHERE contact_id = ?1').bind(id).run();
      await configured.USAGE.prepare(`DELETE FROM ${table} WHERE id = ?1`).bind(id).run();
    }
    created.length = 0;
    await configured.USAGE.prepare('DELETE FROM work_group_moves').run();
  });

  it('writes and reads each subjects entity in D1 once the group has moved, and interactions in Core', async () => {
    const seen = mockCore((call) => Response.json({ data: { id: orgID, ...call.body } }, { status: 201 }));
    const token = await bearer('read write');

    const organization = dataOf(await callTool(token, { entity: 'organizations', body: { name: 'Moved Org', website: 'https://moved.example' } }, subjectsOnD1));
    created.push(['organizations', organization.id as string]);
    expect(organization).toMatchObject({ name: 'Moved Org', website: 'https://moved.example', is_partner: false });
    const contact = dataOf(await callTool(token, { entity: 'contacts', body: { name: 'Bo', email: 'bo@moved.example', organization_id: organization.id } }, subjectsOnD1));
    created.unshift(['contacts', contact.id as string]);
    expect(contact).toMatchObject({ name: 'Bo', email: 'bo@moved.example', company_role: null });
    const lead = dataOf(await callTool(token, { entity: 'leads', body: { organization_id: organization.id, title: 'Moved lead', start_date: '2026-10-20' } }, subjectsOnD1));
    created.unshift(['leads', lead.id as string]);
    const project = dataOf(await callTool(token, { entity: 'projects', body: { title: 'Moved project', is_internal: true } }, subjectsOnD1));
    created.unshift(['projects', project.id as string]);
    expect(project).toMatchObject({ title: 'Moved project', is_internal: true });

    expect(dataOf(await callTool(token, { entity: 'leads', id: lead.id, body: { title: 'Renamed lead' } }, subjectsOnD1))).toMatchObject({ title: 'Renamed lead' });
    expect(dataOf(await callTool(token, { entity: 'contacts', id: contact.id }, subjectsOnD1))).toMatchObject({ name: 'Bo' });
    // Nothing of the subjects group reached Core.
    expect(seen.agent).toEqual([]);

    // The interactions group has not moved: Core still answers it.
    await callTool(token, { entity: 'interactions', body: { title: 'Call', type: 'note', organization_id: organization.id } }, subjectsOnD1);
    expect(seen.agent.map((call) => `${call.method} ${call.path}`)).toEqual(['POST /api/agent/interactions']);
  });

  it('refuses every write to a frozen group with records_moving, before Core, and keeps reads', async () => {
    const seen = mockCore(() => Response.json({ data: [] }));
    const token = await bearer('read write');
    await configured.USAGE.prepare("INSERT INTO work_group_moves (work_group, frozen, frozen_at, updated_at) VALUES ('subjects', 1, 1, 1)").run();
    for (const entity of ['organizations', 'contacts', 'projects', 'leads']) {
      for (const args of [{ entity, body: { name: 'x', title: 'x', organization_id: orgID } }, { entity, id: orgID, body: { title: 'y' } }]) {
        const answer = await callTool(token, args);
        expect(answer.result?.isError, `${entity} ${JSON.stringify(args)}`).toBe(true);
        expect(answer.result?.content?.[0]?.text).toMatch(/records_moving|moving/u);
      }
    }
    // A fresh id: the tool replays an identical earlier call from this grant.
    const remove = await callTool(token, { entity: 'organizations', id: crypto.randomUUID(), delete: true });
    expect(remove.result?.content?.[0]?.text).toMatch(/records_moving|moving/u);
    expect(seen.agent.filter((call) => call.method !== 'GET')).toEqual([]);
    // Reads still answer from Core.
    expect(dataOf(await callTool(token, { entity: 'organizations', q: 'x' }))).toEqual([]);

    // The same on D1 after the flip, and for the interactions group on Core.
    await configured.USAGE.prepare("INSERT INTO work_group_moves (work_group, frozen, frozen_at, updated_at) VALUES ('interactions', 1, 1, 1)").run();
    const note = await callTool(token, { entity: 'interactions', body: { title: 'Call', type: 'note', organization_id: orgID } }, subjectsOnD1);
    expect(note.result?.content?.[0]?.text).toMatch(/records_moving|moving/u);
    const onD1 = await callTool(token, { entity: 'organizations', body: { name: 'Frozen' } }, subjectsOnD1);
    expect(onD1.result?.content?.[0]?.text).toMatch(/records_moving|moving/u);
    expect(seen.agent.filter((call) => call.method !== 'GET')).toEqual([]);
  });
});
