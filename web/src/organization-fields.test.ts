import { afterEach, describe, expect, it, vi } from 'vitest';
import { updateCoreFieldsRecord } from './core-fields';
import { organizationPatch } from './WorkOrganization';

afterEach(() => vi.unstubAllGlobals());

const draft = {
  name: 'Acme', url: '', industry: 'Retail', legal_name: '', city: 'Lisbon', country: '', linkedin_url: '', domain: '', notes: '',
  is_partner: false, is_agency: false, is_existing_client: false,
};

describe('the organization editor (meet#1211)', () => {
  it('sends only the changed fields: a blank clears, a URL is made whole, a name is never blanked', () => {
    expect(organizationPatch(draft, { ...draft })).toEqual({});
    expect(organizationPatch(draft, { ...draft, name: ' ', url: 'acme.example', city: '', is_agency: true })).toEqual({
      url: 'https://acme.example', city: null, is_agency: true,
    });
  });
});

describe('the Fields pane writes an organization through Work (meet#1211)', () => {
  function stubFetch() {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (method === 'PATCH' && url.includes('/crm/subjects/organization/')) return Response.json({ subject: { id: 'org-1' } });
      return Response.json({ data: { id: 'org-1', website: 'https://acme.example' } });
    }));
    return calls;
  }

  it('sends the route’s columns to the organization route, with website as url, then reads the record', async () => {
    const calls = stubFetch();
    const record = await updateCoreFieldsRecord('organizations', 'org-1', { website: 'https://acme.example', city: 'Lisbon' });
    expect(record).toMatchObject({ website: 'https://acme.example' });
    expect(calls.map((call) => [call.method, new URL(call.url, 'http://local').pathname, call.body])).toEqual([
      ['PATCH', '/api/crm/subjects/organization/org-1', { city: 'Lisbon', url: 'https://acme.example' }],
      ['GET', '/api/core/fields/organizations/org-1', null],
    ]);
  });

  it('keeps Core’s record route for a column the organization route does not name', async () => {
    const calls = stubFetch();
    await updateCoreFieldsRecord('organizations', 'org-1', { billing_iban: 'NL00' });
    expect(calls.map((call) => [call.method, new URL(call.url, 'http://local').pathname])).toEqual([
      ['PATCH', '/api/core/fields/organizations/org-1'],
    ]);
  });
});
