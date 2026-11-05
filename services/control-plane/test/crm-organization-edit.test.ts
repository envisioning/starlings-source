import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrmOrganizationDeleteResponse, CrmOrganizationResponse, CrmSubjectMutationResponse } from '@starlings/contracts';
import worker from '../src/index';
import { forgetCoreMemo } from '../src/core-gate';
import { resetCorePatCache } from '../src/crm';

/**
 * Edit and delete an organization (meet#1211): `PATCH` and `DELETE
 * /api/crm/subjects/organization/:id` on the subjects group's store. On Core
 * the Worker writes `/api/agent/organizations/:id` as the member, where Core
 * calls `url` `website`; on D1 it writes the row. The delete is refused
 * while a record points at the organization, on both stores.
 */

const orgID = '3f0c8a52-6a55-4b0e-9a1f-0a5c6f1d2e77';
const coreWorkspace = {
  ...env,
  CRM_SYNC_MODE: 'on',
  CORE_API_BASE_URL: 'https://core.test',
  INTERNAL_REQUEST_SECRET: 'a-shared-test-secret-with-at-least-32-characters',
} as Env;
const d1Workspace = { ...env, WORK_STORE: 'd1' } as Env;
const EMAIL = 'orgedit-rosa@example.com';

interface Seen { method: string; path: string; search: string; body: Record<string, unknown> | null }

function mockCore(answer: (call: Seen) => Response): Seen[] {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/api/public/meet-owner-exchange') {
      return Response.json({
        ok: true,
        token: 'pat-sales',
        scopes: ['organizations:read', 'organizations:write'],
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        email: EMAIL,
      });
    }
    const call = {
      method: request.method,
      path: url.pathname,
      search: url.search,
      body: request.method === 'GET' || request.method === 'DELETE' ? null : await request.json<Record<string, unknown>>(),
    };
    seen.push(call);
    return answer(call);
  });
  return seen;
}

async function invoke(request: Request, apiEnv: Env): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, apiEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

async function session(apiEnv: Env): Promise<Record<string, string>> {
  const response = await invoke(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, name: 'Rosa' }),
  }), apiEnv);
  return { authorization: `Bearer ${(await response.json<{ access_token: string }>()).access_token}`, 'content-type': 'application/json', origin: 'http://local' };
}

const hit = (apiEnv: Env, headers: Record<string, string>, method: string, path: string, body?: unknown) =>
  invoke(new Request(`http://local${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), apiEnv);

beforeEach(async () => {
  await resetCorePatCache();
  forgetCoreMemo();
});

afterEach(() => vi.restoreAllMocks());

describe('an organization on Core', () => {
  it('writes the changed fields to Core as the member and answers the detail', async () => {
    const seen = mockCore((call) => {
      if (call.path === `/api/agent/organizations/${orgID}`) return Response.json({ data: { id: orgID, ...call.body } });
      if (call.path === '/api/public/meet-crm-subjects') {
        return Response.json({ ok: true, subject: { id: orgID, kind: 'partner', title: 'Acme', subtitle: null, status: 'Active', updated_at: null, url: 'https://acme.example' }, subjects: [] });
      }
      return Response.json({ error: 'unmocked' }, { status: 500 });
    });
    const headers = await session(coreWorkspace);
    const response = await hit(coreWorkspace, headers, 'PATCH', `/api/crm/subjects/organization/${orgID}`, { url: 'https://acme.example', city: 'Lisbon', is_agency: true });
    expect(response.status).toBe(200);
    expect((await response.json<CrmSubjectMutationResponse>()).subject).toMatchObject({ id: orgID, url: 'https://acme.example' });
    expect(seen.filter((call) => call.path.startsWith('/api/agent/')).map((call) => [call.method, call.path, call.body])).toEqual([
      ['PATCH', `/api/agent/organizations/${orgID}`, { city: 'Lisbon', is_agency: true, website: 'https://acme.example' }],
    ]);
  });

  it('deletes through Core\'s guard, and passes Core\'s refusal on', async () => {
    let refuse = true;
    const seen = mockCore(() => (refuse
      ? Response.json({ error: 'Organization is in use (leads 2). Move or merge those records first.', code: 'organization_in_use' }, { status: 409 })
      : Response.json({ data: { id: orgID, deleted: true } })));
    const headers = await session(coreWorkspace);
    const busy = await hit(coreWorkspace, headers, 'DELETE', `/api/crm/subjects/organization/${orgID}`);
    expect(busy.status).toBe(409);
    expect(await busy.text()).toContain('leads 2');
    refuse = false;
    const done = await hit(coreWorkspace, headers, 'DELETE', `/api/crm/subjects/organization/${orgID}`);
    expect(await done.json<CrmOrganizationDeleteResponse>()).toEqual({ id: orgID, deleted: true });
    expect(seen.filter((call) => call.path.startsWith('/api/agent/')).map((call) => `${call.method} ${call.path}${call.search}`)).toEqual([
      `DELETE /api/agent/organizations/${orgID}?if_unreferenced=true`,
      `DELETE /api/agent/organizations/${orgID}?if_unreferenced=true`,
    ]);
  });

  it('refuses a write while the subjects group is frozen, before Core', async () => {
    const seen = mockCore(() => Response.json({}));
    await coreWorkspace.USAGE.prepare("INSERT OR REPLACE INTO work_group_moves (work_group, frozen, frozen_at, updated_at) VALUES ('subjects', 1, 1, 1)").run();
    try {
      const headers = await session(coreWorkspace);
      for (const [method, body] of [['PATCH', { city: 'Porto' }], ['DELETE', undefined]] as const) {
        const response = await hit(coreWorkspace, headers, method, `/api/crm/subjects/organization/${orgID}`, body);
        expect(response.status).toBe(503);
        expect((await response.json<{ code: string }>()).code).toBe('records_moving');
      }
      expect(seen.filter((call) => call.path.startsWith('/api/agent/'))).toEqual([]);
    } finally {
      await coreWorkspace.USAGE.prepare('DELETE FROM work_group_moves').run();
    }
  });
});

describe('an organization on D1', () => {
  // An organization is a subject while the Partners module is on (docs/WORK_MODEL.md).
  beforeEach(async () => {
    await d1Workspace.USAGE.prepare(
      "INSERT OR REPLACE INTO workspace_settings (key, value, updated_by, updated_at) VALUES ('work_modules', ?1, 'test', 0)",
    ).bind(JSON.stringify({ on: ['partners'] })).run();
  });
  afterEach(async () => {
    await d1Workspace.USAGE.prepare("DELETE FROM workspace_settings WHERE key = 'work_modules'").run();
  });

  it('edits the row, refuses a delete while a contact points at it, then deletes it', async () => {
    const headers = await session(d1Workspace);
    const created = await hit(d1Workspace, headers, 'POST', '/api/crm/organizations', { name: 'Edit Me Org' });
    expect(created.status, await created.clone().text()).toBe(201);
    const { organization } = await created.json<CrmOrganizationResponse>();
    const edited = await hit(d1Workspace, headers, 'PATCH', `/api/crm/subjects/organization/${organization.id}`, {
      name: 'Edited Org', url: 'https://edited.example', country: 'PT', is_existing_client: true,
    });
    expect(edited.status, await edited.clone().text()).toBe(200);
    expect((await edited.json<CrmSubjectMutationResponse>()).subject).toMatchObject({
      title: 'Edited Org', url: 'https://edited.example', country: 'PT', is_existing_client: true,
    });
    // A name is never blanked.
    expect((await hit(d1Workspace, headers, 'PATCH', `/api/crm/subjects/organization/${organization.id}`, { name: '' })).status).toBe(400);

    const contact = await hit(d1Workspace, headers, 'POST', '/api/crm/contacts', { name: 'Pinned', organization_id: organization.id });
    const contactID = (await contact.json<{ contact: { id: string } }>()).contact.id;
    const busy = await hit(d1Workspace, headers, 'DELETE', `/api/crm/subjects/organization/${organization.id}`);
    expect(busy.status).toBe(409);
    expect(await busy.text()).toContain('contacts 1');

    await hit(d1Workspace, headers, 'PATCH', `/api/crm/contacts/${contactID}`, { organization_id: null });
    const done = await hit(d1Workspace, headers, 'DELETE', `/api/crm/subjects/organization/${organization.id}`);
    expect(await done.json<CrmOrganizationDeleteResponse>()).toEqual({ id: organization.id, deleted: true });
    expect((await hit(d1Workspace, headers, 'GET', `/api/crm/subjects/organization/${organization.id}`)).status).toBe(404);
  });
});
