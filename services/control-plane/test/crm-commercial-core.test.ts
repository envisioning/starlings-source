import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrmSubjectCommercialResponse } from '@starlings/contracts';
import worker from '../src/index';
import { forgetCoreMemo } from '../src/core-gate';
import { resetCorePatCache } from '../src/crm';

/**
 * A lead's and an organization's offers and licences on a `core` workspace
 * (meet#1260): the Worker reads Core's agent lists by `lead_id` or
 * `organization_id` (envisioning/core#247), as the member, and answers null
 * for a list whose work module is off, without asking Core.
 */

const orgID = '3f0c8a52-6a55-4b0e-9a1f-0a5c6f1d2e77';
const leadID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const configured = {
  ...env,
  CRM_SYNC_MODE: 'on',
  CORE_API_BASE_URL: 'https://core.test',
  INTERNAL_REQUEST_SECRET: 'a-shared-test-secret-with-at-least-32-characters',
} as Env;

const older = {
  id: 'offer-older', title: 'Pilot', status: 'expired', total_amount: '1200.50', currency: 'EUR',
  valid_until: '2026-03-01T00:00:00Z', is_accepted: false, created_at: '2026-02-01T00:00:00Z', lead_id: leadID, organization_id: orgID,
};
const newer = {
  id: 'offer-newer', title: 'Annual', status: 'sent', total_amount: 9000, currency: 'EUR',
  valid_until: '2026-11-05T00:00:00Z', is_accepted: null, created_at: '2026-10-20T00:00:00Z', lead_id: leadID, organization_id: orgID,
};
const license = {
  id: 'license-1', product: 'radar', plan_type: 'team', seats: 12, amount_eur: '24000', start_date: '2025-11-15',
  renewal_date: '2026-11-15', is_active: true, offer_id: 'offer-older', lead_id: leadID, organization_id: orgID,
};

interface Seen { path: string; search: URLSearchParams }

function mockCore(): Seen[] {
  const seen: Seen[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/api/public/meet-owner-exchange') {
      return Response.json({
        ok: true,
        token: 'pat-sales',
        scopes: ['offers:read', 'licenses:read'],
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        email: 'commercial-rosa@example.com',
      });
    }
    if (url.pathname === '/api/agent/offers') {
      seen.push({ path: url.pathname, search: url.searchParams });
      return Response.json({ data: [older, newer], meta: { count: 2 } });
    }
    if (url.pathname === '/api/agent/licenses') {
      seen.push({ path: url.pathname, search: url.searchParams });
      return Response.json({ data: [license], meta: { count: 1 } });
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
    body: JSON.stringify({ email: 'commercial-rosa@example.com', name: 'Rosa' }),
  }));
  return { authorization: `Bearer ${(await response.json<{ access_token: string }>()).access_token}` };
}

async function setWorkModules(modules: string[] | null): Promise<void> {
  if (modules === null) {
    await env.USAGE.prepare("DELETE FROM workspace_settings WHERE key = 'work_modules'").run();
    return;
  }
  await env.USAGE.prepare(
    "INSERT OR REPLACE INTO workspace_settings (key, value, updated_by, updated_at) VALUES ('work_modules', ?1, 'test', 0)",
  ).bind(JSON.stringify({ on: modules })).run();
}

beforeEach(async () => {
  await resetCorePatCache();
  forgetCoreMemo();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await setWorkModules(null);
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'commercial-%'").run();
});

describe('a subject\'s offers and licences on a core workspace (meet#1260)', () => {
  it('reads a lead\'s offers and licences by lead_id, newest first, in the wire shape', async () => {
    await setWorkModules(['sales', 'offers', 'licenses']);
    const seen = mockCore();
    const response = await invoke(new Request(`http://local/api/crm/subjects/lead/${leadID}/commercial`, { headers: await session() }));
    expect(response.status).toBe(200);
    const body = await response.json<CrmSubjectCommercialResponse>();
    expect(body.offers?.map((offer) => offer.id)).toEqual(['offer-newer', 'offer-older']);
    expect(body.offers?.[1]?.total_amount).toBe(1200.5);
    expect(body.licenses).toEqual([{
      id: 'license-1', product: 'radar', plan_type: 'team', seats: 12, amount_eur: 24000, start_date: '2025-11-15',
      renewal_date: '2026-11-15', is_active: true, offer_id: 'offer-older', lead_id: leadID, organization_id: orgID, payment_type: null, billing_interval: null, notes: null,
    }]);
    expect(seen.map((call) => [call.path, Object.fromEntries(call.search)])).toEqual([
      ['/api/agent/offers', { lead_id: leadID, limit: '100' }],
      ['/api/agent/licenses', { lead_id: leadID, limit: '100' }],
    ]);
  });

  it('reads an organization\'s by organization_id', async () => {
    await setWorkModules(['partners', 'offers', 'licenses']);
    const seen = mockCore();
    const response = await invoke(new Request(`http://local/api/crm/subjects/organization/${orgID}/commercial`, { headers: await session() }));
    expect(response.status).toBe(200);
    expect(seen.map((call) => call.search.get('organization_id'))).toEqual([orgID, orgID]);
  });

  it('answers null for a work module that is off, and does not ask Core for it', async () => {
    await setWorkModules(['partners', 'licenses']);
    const seen = mockCore();
    const response = await invoke(new Request(`http://local/api/crm/subjects/organization/${orgID}/commercial`, { headers: await session() }));
    const body = await response.json<CrmSubjectCommercialResponse>();
    expect(body.offers).toBeNull();
    expect(body.licenses).toHaveLength(1);
    expect(seen.map((call) => call.path)).toEqual(['/api/agent/licenses']);

    await setWorkModules(['partners']);
    const none = await invoke(new Request(`http://local/api/crm/subjects/organization/${orgID}/commercial`, { headers: await session() }));
    expect(await none.json<CrmSubjectCommercialResponse>()).toEqual({ offers: null, licenses: null });
    expect(seen).toHaveLength(1);
  });
});
