import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrmContactResponse, CrmContactsResponse } from '@starlings/contracts';
import worker from '../src/index';
import { forgetCoreMemo } from '../src/core-gate';
import { resetCorePatCache } from '../src/crm';

/**
 * Contacts on a `core` workspace (meet#947): the Worker reads and writes
 * Core's `/api/agent/contacts` as the member, with the broker PAT, and hands
 * the clients the same wire as a D1 workspace. Core's `company_role` is the
 * wire's `title`; Core's other addresses arrive in `emails`.
 */

const contactID = '7a1d2c3e-4b5f-4a6b-8c7d-9e0f1a2b3c4d';
const orgID = '3f0c8a52-6a55-4b0e-9a1f-0a5c6f1d2e77';
const leadID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const configured = {
  ...env,
  CRM_SYNC_MODE: 'on',
  CORE_API_BASE_URL: 'https://core.test',
  INTERNAL_REQUEST_SECRET: 'a-shared-test-secret-with-at-least-32-characters',
} as Env;

const coreContact = {
  id: contactID,
  name: 'Ada Lovelace',
  email: 'Ada@Acme.example',
  corporate_email: 'ada.l@acme.example',
  email_aliases: ['ada@home.example'],
  company_role: 'Analyst',
  organization_id: orgID,
  organization: { id: orgID, name: 'Acme' },
};

interface Seen { method: string; path: string; search: URLSearchParams; body: Record<string, unknown> | null }

function mockCore(answer: (call: Seen) => Response): Seen[] {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/api/public/meet-owner-exchange') {
      return Response.json({
        ok: true,
        token: 'pat-sales',
        scopes: ['contacts:read', 'contacts:write'],
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        email: 'contacts-rosa@example.com',
      });
    }
    if (url.pathname.startsWith('/api/agent/')) {
      const call = {
        method: request.method,
        path: url.pathname,
        search: url.searchParams,
        body: request.method === 'GET' || request.method === 'DELETE' ? null : await request.json<Record<string, unknown>>(),
      };
      seen.push(call);
      return answer(call);
    }
    return Response.json({ error: `unmocked ${request.method} ${url.pathname}` }, { status: 500 });
  });
  return seen;
}

async function invoke(request: Request): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, configured, context);
  await waitOnExecutionContext(context);
  return response;
}

async function session(): Promise<Record<string, string>> {
  const response = await invoke(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'contacts-rosa@example.com', name: 'Rosa' }),
  }));
  return { authorization: `Bearer ${(await response.json<{ access_token: string }>()).access_token}`, 'content-type': 'application/json' };
}

beforeEach(async () => {
  await resetCorePatCache();
  forgetCoreMemo();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'contacts-%'").run();
});

describe('contacts on a core workspace', () => {
  it('lists Core\'s contacts in the wire shape, as the member', async () => {
    const seen = mockCore(() => Response.json({ data: [coreContact], meta: { count: 1 } }));
    const response = await invoke(new Request(`http://local/api/crm/contacts?q=ada&organization_id=${orgID}&limit=10`, { headers: await session() }));
    expect(response.status).toBe(200);
    expect(await response.json<CrmContactsResponse>()).toEqual({
      contacts: [{
        id: contactID, name: 'Ada Lovelace', title: 'Analyst', organization_id: orgID, organization_name: 'Acme',
        email: 'ada@acme.example', emails: ['ada@acme.example', 'ada.l@acme.example', 'ada@home.example'],
      }],
      has_more: false,
    });
    expect(seen.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /api/agent/contacts']);
    expect(Object.fromEntries(seen[0]!.search)).toEqual({ q: 'ada', organization_id: orgID, limit: '11' });
  });

  it('forwards the Contacts group\'s filters to Core and reads its facets (meet#1213)', async () => {
    const seen = mockCore(() => Response.json({ data: [coreContact], meta: { count: 1 }, facets: { countries: ['NL'], languages: ['en', 'pt'] } }));
    const filtered = await invoke(new Request(
      'http://local/api/crm/contacts?country=nl&partner=true&existing_client=true&signals_outreach_status=replied&preferred_language=pt&facets=true',
      { headers: await session() },
    ));
    expect(filtered.status).toBe(200);
    expect((await filtered.json<CrmContactsResponse>()).facets).toEqual({ countries: ['NL'], languages: ['en', 'pt'] });
    expect(Object.fromEntries(seen[0]!.search)).toEqual({
      limit: '51', country: 'NL', partner: 'true', existing_client: 'true',
      signals_outreach_status: 'replied', preferred_language: 'pt', facets: 'true',
    });
    // A picker sends no filter and gets no facets, from a Core that sends them or not.
    const picker = await invoke(new Request('http://local/api/crm/contacts?q=ada', { headers: await session() }));
    expect((await picker.json<CrmContactsResponse>()).facets).toBeUndefined();
    expect(Object.fromEntries(seen[1]!.search)).toEqual({ q: 'ada', limit: '51' });
  });

  it('finds the contacts a call\'s addresses belong to, one exact match each (meet#1259)', async () => {
    const seen = mockCore((call) => Response.json({
      data: call.search.get('q') === 'ada.l@acme.example' ? [coreContact, { ...coreContact, id: 'other', email: 'ada.lovelace@acme.example', corporate_email: null, email_aliases: [] }] : [],
    }));
    const response = await invoke(new Request('http://local/api/crm/contacts?emails=Ada.L@acme.example,nobody@acme.example,not-an-address', { headers: await session() }));
    expect(response.status).toBe(200);
    expect((await response.json<CrmContactsResponse>()).contacts.map((contact) => contact.id)).toEqual([contactID]);
    expect(seen.map((call) => call.search.get('q'))).toEqual(['ada.l@acme.example', 'nobody@acme.example']);
  });

  it('deletes through Core\'s guarded delete and passes on its refusal (meet#1214)', async () => {
    let refuse = true;
    const seen = mockCore((call) => {
      if (call.method === 'DELETE') {
        return refuse
          ? Response.json({ error: 'Contact is in use (tasks 2). Move or merge those records first.', code: 'contact_in_use' }, { status: 409 })
          : Response.json({ data: { id: contactID, deleted: true } });
      }
      return Response.json({ data: coreContact });
    });
    const headers = await session();
    const refused = await invoke(new Request(`http://local/api/crm/contacts/${contactID}`, { method: 'DELETE', headers }));
    expect(refused.status).toBe(409);
    expect((await refused.json<{ error: string }>()).error).toBe('Contact is in use (tasks 2). Move or merge those records first.');
    refuse = false;
    const deleted = await invoke(new Request(`http://local/api/crm/contacts/${contactID}`, { method: 'DELETE', headers }));
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ id: contactID, deleted: true });
    const deletes = seen.filter((call) => call.method === 'DELETE');
    expect(deletes.map((call) => `${call.path}?${call.search}`)).toEqual([
      `/api/agent/contacts/${contactID}?if_unreferenced=true`,
      `/api/agent/contacts/${contactID}?if_unreferenced=true`,
    ]);
  });

  it('offers Core\'s contact characteristics and languages (meet#1214)', async () => {
    const seen = mockCore(() => Response.json({ data: { contacts: [{ id: 'c-2', name: 'speaker' }, { id: 'c-1', name: 'board_member' }], leads: [{ id: 'l-1', name: 'budget' }] } }));
    const response = await invoke(new Request('http://local/api/crm/contact-options', { headers: await session() }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ characteristics: ['board_member', 'speaker'], languages: ['en', 'pt'] });
    expect(seen.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /api/agent/meta/characteristics']);
  });

  it('reads the contact page: Core\'s leads and calls for the contact', async () => {
    const seen = mockCore((call) => {
      if (call.path === `/api/agent/contacts/${contactID}`) return Response.json({ data: coreContact });
      if (call.path === '/api/agent/leads') return Response.json({ data: [{ id: leadID, title: 'Acme pilot', status: 'Conversations' }] });
      return Response.json({
        data: [{
          id: 'i-1', title: 'Kickoff', type: 'meeting', description: '## Notes\nWe agreed.', occurred_at: '2026-10-01T10:00:00.000Z',
          created_at: '2026-10-01T11:00:00.000Z', lead_id: leadID, project_id: null, organization_id: orgID, url: null,
          contacts: [{ id: contactID, name: 'Ada Lovelace', email: 'ada@acme.example', organization_id: orgID }],
        }],
      });
    });
    const response = await invoke(new Request(`http://local/api/crm/contacts/${contactID}`, { headers: await session() }));
    expect(response.status).toBe(200);
    const { contact } = await response.json<CrmContactResponse>();
    expect(contact).toMatchObject({
      id: contactID, title: 'Analyst', projects: [], met_by: [],
      leads: [{ id: leadID, title: 'Acme pilot', status: 'Conversations' }],
    });
    expect(contact.interactions).toMatchObject([{
      id: 'i-1', title: 'Kickoff', type: 'meeting', summary_preview: 'Notes', lead_id: leadID,
      contacts: [{ id: contactID, name: 'Ada Lovelace', email: 'ada@acme.example' }],
    }]);
    expect(seen.find((call) => call.path === '/api/agent/leads')?.search.get('contact_id')).toBe(contactID);
    expect(seen.find((call) => call.path === '/api/agent/interactions')?.search.get('contact_id')).toBe(contactID);
  });

  it('creates and edits with Core\'s names, and refuses a second address Core would drop', async () => {
    const seen = mockCore((call) => {
      if (call.method === 'POST') return Response.json({ data: { id: contactID } }, { status: 201 });
      if (call.path === `/api/agent/contacts/${contactID}`) return Response.json({ data: coreContact });
      return Response.json({ data: [] });
    });
    const headers = await session();
    const created = await invoke(new Request('http://local/api/crm/contacts', {
      method: 'POST', headers, body: JSON.stringify({ name: 'Ada Lovelace', title: 'Analyst', organization_id: orgID, emails: ['ada@acme.example'] }),
    }));
    expect(created.status).toBe(201);
    expect(seen.find((call) => call.method === 'POST')?.body).toEqual({
      name: 'Ada Lovelace', email: 'ada@acme.example', company_role: 'Analyst', organization_id: orgID,
    });

    const edited = await invoke(new Request(`http://local/api/crm/contacts/${contactID}`, {
      method: 'PATCH', headers, body: JSON.stringify({ title: null, emails: ['ada@acme.example', 'ada@home.example'] }),
    }));
    expect(edited.status).toBe(200);
    expect(seen.find((call) => call.method === 'PATCH')?.body).toEqual({ company_role: null, email: 'ada@acme.example' });

    const before = seen.length;
    const refused = await invoke(new Request('http://local/api/crm/contacts', {
      method: 'POST', headers, body: JSON.stringify({ name: 'Two', emails: ['a@x.example', 'b@x.example'] }),
    }));
    expect(refused.status).toBe(400);
    const added = await invoke(new Request(`http://local/api/crm/contacts/${contactID}`, {
      method: 'PATCH', headers, body: JSON.stringify({ emails: ['ada@acme.example', 'new@x.example'] }),
    }));
    expect(added.status).toBe(400);
    expect(seen.slice(before).filter((call) => call.method !== 'GET')).toEqual([]);
  });
});
