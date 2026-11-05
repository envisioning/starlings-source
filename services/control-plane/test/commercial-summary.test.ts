import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { normalizeCommercialSummary, resetCorePatCache } from '../src/crm';

const SECRET = 'meet-core-shared-secret-at-least-32-chars';
const secretEnv = { ...env, INTERNAL_REQUEST_SECRET: SECRET, CRM_SYNC_MODE: 'on' } as Env;

function coreAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const issuedToken = {
  ok: true,
  token: 'core_pat_commercial_summary',
  scopes: ['dashboard:read'],
  expires_at: '2026-12-07T09:00:00.000Z',
  email: 'rosa@example.com',
};

function points(make: (index: number) => Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.from({ length: 14 }, (_, index) => make(index));
}

function dashboard(overrides: Partial<{
  sales: Array<Record<string, unknown>>;
  offers: Array<Record<string, unknown>>;
  licenses: Array<Record<string, unknown>> | null;
  currencyCode: string;
}> = {}) {
  const sales = overrides.sales ?? points((index) => ({
    key: `2025-${String(index + 1).padStart(2, '0')}`,
    label: `Month ${index + 1}`,
    total: index < 2 ? 0 : 100 + index,
    positive: index < 2 ? 0 : 10 + index,
    negative: index < 2 ? 0 : 2,
  }));
  const offers = overrides.offers ?? points((index) => ({
    key: `2025-${String(index + 1).padStart(2, '0')}`,
    label: `Month ${index + 1}`,
    total: index < 2 ? 0 : index,
    positive: 0,
    negative: 0,
  }));
  const licenses = overrides.licenses ?? points((index) => ({
    key: `2025-${String(index + 1).padStart(2, '0')}`,
    label: `Month ${index + 1}`,
    total: index < 2 ? 0 : index - 1,
    positive: 0,
    negative: 0,
  }));
  return {
    data: {
      growthHistograms: [
        { id: 'sales', currencyCode: overrides.currencyCode ?? 'EUR', points: sales },
        { id: 'offers', points: offers },
        ...(overrides.licenses === undefined ? [{ id: 'licenses', points: licenses }] : overrides.licenses === null ? [] : [{ id: 'licenses', points: licenses }]),
      ],
    },
  };
}

beforeEach(() => resetCorePatCache());

afterEach(async () => {
  await resetCorePatCache();
  vi.restoreAllMocks();
});

async function ownerSession(context: ExecutionContext): Promise<string> {
  const response = await worker.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
  }), secretEnv, context);
  return (await response.json<{ access_token: string }>()).access_token;
}

describe('commercial summary normalization', () => {
  it('keeps the last twelve points and folds the Core series into the narrow contract', () => {
    const result = normalizeCommercialSummary(dashboard());

    expect(result.lookback_months).toBe(12);
    expect(result.offers).toBe(90);
    expect(result.sales_amount).toBe(210);
    expect(result.pipeline_amount).toBe(1056);
    expect(result.new_licenses).toBe(78);
    expect(result.currency_code).toBe('EUR');
    expect(result.points).toHaveLength(12);
    expect(result.points[0]).toMatchObject({ key: '2025-03', total: 102, positive: 12, negative: 2 });
    expect(Object.keys(result).sort()).toEqual([
      'currency_code', 'lookback_months', 'new_licenses', 'offers', 'pipeline_amount', 'points', 'sales_amount',
    ]);
  });

  it('returns null licenses when Core has no license series', () => {
    expect(normalizeCommercialSummary(dashboard({ licenses: null })).new_licenses).toBeNull();
  });

  it('rejects a missing or malformed required series instead of inventing zeros', () => {
    expect(() => normalizeCommercialSummary({ data: { growthHistograms: [] } })).toThrow('unusable commercial dashboard');
    const sales = dashboard().data.growthHistograms[0]?.points ?? [];
    expect(() => normalizeCommercialSummary(dashboard({
      sales: sales.map((point, index) => index === 13 ? { ...point, total: -1 } : point),
    }))).toThrow('unusable commercial dashboard');
  });
});

describe('GET /api/crm/commercial-summary', () => {
  it('requires an owner session', async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(new Request('http://local/api/crm/commercial-summary'), secretEnv, context);
    expect(response.status).toBe(401);
    await waitOnExecutionContext(context);
  });

  it('answers not_configured without calling Core when the bridge is off', async () => {
    const context = createExecutionContext();
    const unconfigured = { ...env, INTERNAL_REQUEST_SECRET: '' } as Env;
    const session = await worker.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }), unconfigured, context);
    const token = (await session.json<{ access_token: string }>()).access_token;
    const response = await worker.fetch(new Request('http://local/api/crm/commercial-summary', {
      headers: { authorization: `Bearer ${token}` },
    }), unconfigured, context);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'not_configured' });
    await waitOnExecutionContext(context);
  });

  it('forwards the owner read to Core and returns only the commercial projection', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(context);
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      calls.push(url.pathname + url.search);
      if (url.pathname === '/api/public/meet-owner-exchange') return coreAnswer(issuedToken);
      if (url.pathname === '/api/agent/dashboard') return coreAnswer(dashboard());
      return coreAnswer({}, 404);
    });

    const response = await worker.fetch(new Request('http://local/api/crm/commercial-summary', {
      headers: { authorization: `Bearer ${token}` },
    }), secretEnv, context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(normalizeCommercialSummary(dashboard()));
    expect(calls).toEqual(['/api/public/meet-owner-exchange', '/api/agent/dashboard']);
    await waitOnExecutionContext(context);
  });

  it('surfaces a Core failure instead of returning an empty card', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(context);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === '/api/public/meet-owner-exchange') return coreAnswer(issuedToken);
      return coreAnswer({}, 502);
    });

    const response = await worker.fetch(new Request('http://local/api/crm/commercial-summary', {
      headers: { authorization: `Bearer ${token}` },
    }), secretEnv, context);
    expect(response.status).toBe(502);
    await waitOnExecutionContext(context);
  });
});
