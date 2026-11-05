/**
 * The Fields pane's writes (meet#721): every field the Mac and iOS pane edits
 * goes through `PATCH /api/crm/subjects/:kind/:id`, and that route answers on
 * a Core workspace and on a D1 workspace. Before meet#721 the pane wrote to
 * Core directly with a device token, which a frozen Core table would break.
 */
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrmOrganizationResponse, CrmSubjectDetailResponse, CrmSubjectMutationResponse } from '@starlings/contracts';
import worker from '../src/index';
import { purgeAllCoreCache } from '../src/core-cache';
import { resetRoleCache } from '../src/capabilities';

const CORE_SECRET = 'core-test-secret-with-at-least-32-characters';
const EMAIL = 'fields-ana@example.com';
const core = env as Env;
const d1 = { ...env, WORK_STORE: 'd1' } as Env;
const WORK_TABLES = ['project_contacts', 'projects', 'leads', 'contacts', 'organizations'];

/** Every text field a project's Fields pane edits, with a value. */
const PROJECT_TEXT = {
  title: 'Northwind rollout',
  description: 'Phase one.',
  url: 'https://northwind.example/rollout',
  evid: 'EV-2026-014',
  specs: 'Two regions.',
  technical: 'Workers and D1.',
  research: 'Interviews in week two.',
  design: 'House look.',
  contract: 'Fixed fee, two milestones.',
  analytics: 'Weekly actives.',
  authentication: 'Google sign-in.',
  start_date: '2026-10-01',
  end_date: '2026-12-31',
};

async function invoke(request: Request, apiEnv: Env): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, apiEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

async function hit(apiEnv: Env, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  return invoke(new Request(`http://local${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json', origin: 'http://local' },
    body: body === undefined ? null : JSON.stringify(body),
  }), apiEnv);
}

async function ok<T>(apiEnv: Env, method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<T> {
  const response = await hit(apiEnv, method, path, headers, body);
  expect(response.status, `${method} ${path}: ${await response.clone().text()}`).toBeLessThan(300);
  return response.json<T>();
}

async function session(apiEnv: Env): Promise<Record<string, string>> {
  const response = await invoke(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, name: 'Ana' }),
  }), apiEnv);
  expect(response.status).toBe(200);
  return { authorization: `Bearer ${(await response.json<{ access_token: string }>()).access_token}` };
}

async function wipe(): Promise<void> {
  await d1.USAGE.batch(WORK_TABLES.map((table) => d1.USAGE.prepare(`DELETE FROM ${table}`)));
}

beforeEach(async () => {
  await purgeAllCoreCache();
  resetRoleCache();
  await wipe();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await wipe();
  await d1.USAGE.prepare("DELETE FROM workspace_settings WHERE key = 'work_modules'").run();
  await d1.USAGE.prepare("DELETE FROM people WHERE email LIKE 'fields-%'").run();
});

describe('the Fields pane on a Core workspace', () => {
  /** Core's subjects route, answering each PATCH with the subject it names. */
  function withCore() {
    const configured = core.INTERNAL_REQUEST_SECRET;
    core.INTERNAL_REQUEST_SECRET = CORE_SECRET;
    const patches: Array<{ kind: string | null; id: string | null; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith('meet-crm-subjects') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patches.push({ kind: url.searchParams.get('kind'), id: url.searchParams.get('id'), body });
        const kind = url.searchParams.get('kind');
        return new Response(JSON.stringify({
          ok: true,
          subject: { id: url.searchParams.get('id'), kind, title: 'Northwind', subtitle: null, status: kind === 'lead' ? 'Conversations' : 'Active', updated_at: null },
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    });
    return { patches, restore: () => { core.INTERNAL_REQUEST_SECRET = configured ?? ''; } };
  }

  it('forwards every project field, the internal flag included, to Core', async () => {
    const stub = withCore();
    const headers = await session(core);
    const id = 'c0ffee00-0000-4000-8000-0000000000f1';
    await ok<CrmSubjectMutationResponse>(core, 'PATCH', `/api/crm/subjects/project/${id}`, headers, {
      ...PROJECT_TEXT, status: 'Paused', is_internal: true,
    });
    expect(stub.patches).toHaveLength(1);
    expect(stub.patches[0]).toMatchObject({ kind: 'project', id, body: { ...PROJECT_TEXT, status: 'Paused', is_internal: true, actor: EMAIL } });
    stub.restore();
  });

  it('forwards every lead field, the checklist included, to Core', async () => {
    const stub = withCore();
    const headers = await session(core);
    const id = 'c0ffee00-0000-4000-8000-0000000000f2';
    const lead = { title: 'Northwind pilot', status: 'Proposal Out', start_date: '2026-10-01', notes: 'Second call.', characteristics: { budget: true, champion: false } };
    await ok<CrmSubjectMutationResponse>(core, 'PATCH', `/api/crm/subjects/lead/${id}`, headers, lead);
    expect(stub.patches[0]).toMatchObject({ kind: 'lead', id, body: { ...lead, actor: EMAIL } });
    stub.restore();
  });

  it('refuses an internal flag that is not a boolean', async () => {
    const stub = withCore();
    const headers = await session(core);
    const response = await hit(core, 'PATCH', '/api/crm/subjects/project/c0ffee00-0000-4000-8000-0000000000f3', headers, { is_internal: 'yes' });
    expect(response.status).toBe(400);
    expect(stub.patches).toHaveLength(0);
    stub.restore();
  });
});

describe('the Fields pane on a D1 workspace', () => {
  beforeEach(async () => {
    // Leads are the Sales work module, off on a new D1 workspace (docs/WORK_MODEL.md).
    await d1.USAGE.prepare(
      "INSERT OR REPLACE INTO workspace_settings (key, value, updated_by, updated_at) VALUES ('work_modules', ?1, 'test', 0)",
    ).bind(JSON.stringify({ on: ['sales'] })).run();
  });

  async function seed(headers: Record<string, string>) {
    const { organization } = await ok<CrmOrganizationResponse>(d1, 'POST', '/api/crm/organizations', headers, { name: 'Northwind Labs' });
    const lead = (await ok<CrmSubjectMutationResponse>(d1, 'POST', '/api/crm/subjects', headers, {
      kind: 'lead', title: 'Northwind pilot', organization_id: organization.id, start_date: '2026-10-01',
    })).subject;
    const project = (await ok<CrmSubjectMutationResponse>(d1, 'POST', '/api/crm/subjects', headers, {
      kind: 'project', title: 'Northwind', organization_id: organization.id,
    })).subject;
    return { lead, project };
  }

  it('writes and reads back every project field', async () => {
    const headers = await session(d1);
    const { project } = await seed(headers);
    const license = crypto.randomUUID();
    const saved = await ok<CrmSubjectMutationResponse>(d1, 'PATCH', `/api/crm/subjects/project/${project.id}`, headers, {
      ...PROJECT_TEXT, status: 'Paused', is_internal: true, license_id: license,
    });
    const expected = { ...PROJECT_TEXT, status: 'Paused', internal: true, license_id: license };
    expect(saved.subject).toMatchObject(expected);
    expect((await ok<CrmSubjectDetailResponse>(d1, 'GET', `/api/crm/subjects/project/${project.id}`, headers)).subject).toMatchObject(expected);

    // A field named with null clears; a field left out stays.
    const cleared = await ok<CrmSubjectMutationResponse>(d1, 'PATCH', `/api/crm/subjects/project/${project.id}`, headers, {
      contract: null, evid: null, is_internal: false,
    });
    expect(cleared.subject).toMatchObject({ contract: null, evid: null, internal: false, specs: 'Two regions.', title: 'Northwind rollout' });
  });

  it('writes and reads back every lead field, the checklist included', async () => {
    const headers = await session(d1);
    const { lead } = await seed(headers);
    const fields = { title: 'Northwind pilot, round two', status: 'Proposal Out', start_date: '2026-10-05', notes: 'Second call.' };
    const characteristics = { budget: true, champion: false };
    const saved = await ok<CrmSubjectMutationResponse>(d1, 'PATCH', `/api/crm/subjects/lead/${lead.id}`, headers, { ...fields, characteristics });
    expect(saved.subject).toMatchObject({ ...fields, characteristics });
    expect((await ok<CrmSubjectDetailResponse>(d1, 'GET', `/api/crm/subjects/lead/${lead.id}`, headers)).subject).toMatchObject({ ...fields, characteristics });

    const cleared = await ok<CrmSubjectMutationResponse>(d1, 'PATCH', `/api/crm/subjects/lead/${lead.id}`, headers, { characteristics: null });
    expect(cleared.subject).toMatchObject({ characteristics: null, notes: 'Second call.' });
  });
});
