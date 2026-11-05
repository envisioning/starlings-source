// The Sales inbox: untriaged CRM touches with no Meet subject yet
// (docs/WORK.md "Channels on the work itself"; envisioning/starlings#44).
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { resetCorePatCache } from '../src/crm';

const SECRET = 'meet-core-shared-secret-at-least-32-chars';
const secretEnv = { ...env, INTERNAL_REQUEST_SECRET: SECRET } as Env;

function coreAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const issuedToken = {
  ok: true,
  token: 'core_pat_sales_inbox',
  scopes: ['untriaged:read'],
  expires_at: '2026-12-07T09:00:00.000Z',
  email: 'rosa@example.com',
};

const touch = {
  id: 'evt-1',
  source: 'contact',
  occurred_at: '2026-09-10T08:00:00.000Z',
  organization: { id: 'org-1', name: 'Acme' },
  contact: { id: 'contact-1', name: 'Jamie Rivera', email: 'jamie@acme.test' },
  preview: 'Interested in the enterprise plan',
  dismissed: false,
  dismissed_at: null,
  prefill: {
    title: 'Acme — contact form',
    notes: 'Interested in the enterprise plan',
    organization_id: 'org-1',
    organization_name: 'Acme',
    contact_id: 'contact-1',
    contact_name: 'Jamie Rivera',
    contact_email: 'jamie@acme.test',
  },
  existing_lead_id: null,
  existing_offer_id: null,
  source_record: { type: 'contacts', id: 'contact-1' },
};

beforeEach(() => resetCorePatCache());

afterEach(async () => {
  await resetCorePatCache();
  vi.restoreAllMocks();
});

async function ownerSession(configured: Env, context: ExecutionContext, email = 'rosa@example.com'): Promise<string> {
  const response = await worker.fetch(new Request('http://local/api/dev/session', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Rosa', email }),
  }), configured, context);
  return (await response.json<{ access_token: string }>()).access_token;
}

describe('GET /api/crm/sales-inbox', () => {
  it('requires an Envisioning session', async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(new Request('http://local/api/crm/sales-inbox'), secretEnv, context);
    expect(response.status).toBe(401);
    await waitOnExecutionContext(context);
  });

  it('answers not_configured without the shared secret', async () => {
    const context = createExecutionContext();
    const unconfigured = { ...env, INTERNAL_REQUEST_SECRET: '' } as Env;
    const token = await ownerSession(unconfigured, context);
    const response = await worker.fetch(new Request('http://local/api/crm/sales-inbox', {
      headers: { authorization: `Bearer ${token}` },
    }), unconfigured, context);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'not_configured' });
    await waitOnExecutionContext(context);
  });

  it('mints its own broker PAT and forwards limit/offset/include_dismissed to Core’s agent route', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      calls.push(url.pathname + url.search);
      if (url.pathname === '/api/public/meet-owner-exchange') return coreAnswer(issuedToken);
      if (url.pathname === '/api/agent/untriaged-touches') return coreAnswer({ data: [touch], total: 1 });
      return coreAnswer({}, 404);
    });

    const response = await worker.fetch(new Request(
      'http://local/api/crm/sales-inbox?limit=25&offset=10&include_dismissed=true',
      { headers: { authorization: `Bearer ${token}` } },
    ), secretEnv, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [touch], total: 1 });
    expect(calls).toEqual([
      '/api/public/meet-owner-exchange',
      '/api/agent/untriaged-touches?limit=25&offset=10&include_dismissed=true',
    ]);
    await waitOnExecutionContext(context);
  });

  it('defaults to the widest read — no dismissed rows, limit 50 — and forwards the owner’s Bearer', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    let authorization: string | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === '/api/public/meet-owner-exchange') return coreAnswer(issuedToken);
      if (url.pathname === '/api/agent/untriaged-touches') {
        authorization = new Headers(init?.headers).get('authorization');
        expect(url.searchParams.get('include_dismissed')).toBeNull();
        expect(url.searchParams.get('limit')).toBe('50');
        return coreAnswer({ data: [], total: 0 });
      }
      return coreAnswer({}, 404);
    });

    const response = await worker.fetch(new Request('http://local/api/crm/sales-inbox', {
      headers: { authorization: `Bearer ${token}` },
    }), secretEnv, context);

    expect(response.status).toBe(200);
    expect(authorization).toBe(`Bearer ${issuedToken.token}`);
    await waitOnExecutionContext(context);
  });

  it('surfaces a non-2xx from Core’s agent route as a failure, not an empty inbox', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === '/api/public/meet-owner-exchange') return coreAnswer(issuedToken);
      // The migration behind this route (`untriaged_touch_dismissals`) may not
      // be applied yet — a 500 here is expected until a human runs it.
      return new Response('', { status: 500 });
    });

    const response = await worker.fetch(new Request('http://local/api/crm/sales-inbox', {
      headers: { authorization: `Bearer ${token}` },
    }), secretEnv, context);
    expect(response.status).toBe(500);
    await waitOnExecutionContext(context);
  });
});

describe('the broker PAT cache', () => {
  it('dedupes two overlapping sales-inbox reads onto one mint, so the second never self-revokes the first', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    let mints = 0;
    let releaseMint = () => {};
    const mintGate = new Promise<void>((resolve) => { releaseMint = resolve; });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === '/api/public/meet-owner-exchange') {
        mints += 1;
        // Held open until both reads have had a real chance to reach this
        // call. If concurrent callers were not deduped onto one in-flight
        // mint, the second read would mint its own token here too — exactly
        // the race in envisioning/starlings#44 (a second mint revokes the first).
        await mintGate;
        return coreAnswer(issuedToken);
      }
      if (url.pathname === '/api/agent/untriaged-touches') return coreAnswer({ data: [touch], total: 1 });
      return coreAnswer({}, 404);
    });

    const request = () => worker.fetch(new Request('http://local/api/crm/sales-inbox', {
      headers: { authorization: `Bearer ${token}` },
    }), secretEnv, context);

    const first = request();
    const second = request();
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseMint();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(await firstResponse.json()).toEqual({ data: [touch], total: 1 });
    expect(await secondResponse.json()).toEqual({ data: [touch], total: 1 });
    expect(mints).toBe(1);
    await waitOnExecutionContext(context);
  });

  it('retries once, minting fresh, when a cached token comes back 401', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    let mints = 0;
    let untriagedCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === '/api/public/meet-owner-exchange') {
        mints += 1;
        return coreAnswer(issuedToken);
      }
      if (url.pathname === '/api/agent/untriaged-touches') {
        untriagedCalls += 1;
        const authorization = new Headers(init?.headers).get('authorization');
        // First read seeds the cache, then something outside this cache's
        // control revokes it — the very first call on the cached token fails.
        if (untriagedCalls === 1) return coreAnswer({ data: [touch], total: 1 });
        if (authorization === `Bearer ${issuedToken.token}` && untriagedCalls === 2) {
          return new Response('', { status: 401 });
        }
        return coreAnswer({ data: [touch], total: 1 });
      }
      return coreAnswer({}, 404);
    });

    const first = await worker.fetch(new Request('http://local/api/crm/sales-inbox', {
      headers: { authorization: `Bearer ${token}` },
    }), secretEnv, context);
    expect(first.status).toBe(200);
    expect(mints).toBe(1);

    // Second read reuses the cached token, Core answers 401 (revoked from
    // outside this cache's control), and the fetch retries once with a fresh
    // mint rather than failing the request.
    const second = await worker.fetch(new Request('http://local/api/crm/sales-inbox', {
      headers: { authorization: `Bearer ${token}` },
    }), secretEnv, context);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ data: [touch], total: 1 });
    expect(mints).toBe(2);
    expect(untriagedCalls).toBe(3);
    await waitOnExecutionContext(context);
  });
});

describe('dismiss / undo one touch', () => {
  it('POST dismisses through Core, DELETE undoes it, and both require a trusted mutation', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    const calls: { method: string; url: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === '/api/public/meet-owner-exchange') return coreAnswer(issuedToken);
      calls.push({ method: init?.method ?? 'GET', url: url.pathname });
      return coreAnswer({ ok: true, dismissed: init?.method === 'POST' });
    });

    const dismiss = await worker.fetch(new Request('http://local/api/crm/sales-inbox/evt-1/dismiss', {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    }), secretEnv, context);
    expect(dismiss.status).toBe(200);
    expect(await dismiss.json()).toEqual({ ok: true, dismissed: true });

    const undo = await worker.fetch(new Request('http://local/api/crm/sales-inbox/evt-1/dismiss', {
      method: 'DELETE', headers: { authorization: `Bearer ${token}` },
    }), secretEnv, context);
    expect(undo.status).toBe(200);
    expect(await undo.json()).toEqual({ ok: true, dismissed: false });

    expect(calls).toEqual([
      { method: 'POST', url: '/api/agent/untriaged-touches/evt-1/dismiss' },
      { method: 'DELETE', url: '/api/agent/untriaged-touches/evt-1/dismiss' },
    ]);
    await waitOnExecutionContext(context);
  });

  it('requires an Envisioning session', async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(new Request('http://local/api/crm/sales-inbox/evt-1/dismiss', {
      method: 'POST',
    }), secretEnv, context);
    expect(response.status).toBe(401);
    await waitOnExecutionContext(context);
  });
});
