import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  guestOperationalErrorEventSchema,
  operationalErrorEventSchema,
  type OperationalErrorEvent,
} from '@starlings/contracts';
import {
  pruneOperationalErrors,
  recordOperationalErrors,
  shouldCaptureWorkerFailure,
  workerErrorEvent,
} from '../src/operational-errors';
import { assertUnderRateLimit } from '../src/http';

function event(overrides: Partial<OperationalErrorEvent> = {}): OperationalErrorEvent {
  return {
    event_id: crypto.randomUUID(),
    source: 'ios',
    platform: 'ios',
    release: '4.8.5 (475)',
    code: 'calendar_expired',
    operation: 'calendar',
    error_class: 'authorization',
    http_status: 401,
    server_code: 'calendar_expired',
    request_id: crypto.randomUUID(),
    retry_count: 1,
    ...overrides,
  };
}

describe('operational error events', () => {
  it('accepts only fixed fields and safe bounded values', () => {
    const safe = event();
    expect(operationalErrorEventSchema.safeParse(safe).success).toBe(true);
    expect(operationalErrorEventSchema.safeParse({ ...safe, diagnostic: 'Bearer secret' }).success).toBe(false);
    expect(operationalErrorEventSchema.safeParse({ ...safe, release: '4.8.5 https://private.example' }).success).toBe(false);
    expect(operationalErrorEventSchema.safeParse({ ...safe, operation: '/api/rooms/alice-private' }).success).toBe(false);
  });

  it('gives guest intake only the anonymous join-flow contract', () => {
    const safe = event({
      source: 'web', platform: 'web', code: 'guest.join_failed', operation: 'guest_join',
      error_class: 'network', http_status: undefined, server_code: undefined,
    });
    delete safe.server_code;
    expect(guestOperationalErrorEventSchema.safeParse(safe).success).toBe(true);
    expect(guestOperationalErrorEventSchema.safeParse({ ...safe, email: 'person@example.net' }).success).toBe(false);
    expect(guestOperationalErrorEventSchema.safeParse({ ...safe, server_code: 'internal_error' }).success).toBe(false);
  });

  it('captures only actionable Worker failures and normalizes paths to categories', () => {
    expect(shouldCaptureWorkerFailure(404, 'room_not_found')).toBe(false);
    expect(shouldCaptureWorkerFailure(401, 'owner_auth_required')).toBe(false);
    expect(shouldCaptureWorkerFailure(401, 'calendar_expired')).toBe(true);
    expect(shouldCaptureWorkerFailure(502, 'internal_error')).toBe(true);
    const normalized = workerErrorEvent({
      requestId: crypto.randomUUID(),
      pathname: '/api/calendar/accounts/personal-address@example.net/events',
      status: 502,
      code: 'internal_error',
    });
    expect(normalized).toMatchObject({ source: 'worker', operation: 'calendar', code: 'worker.internal_error' });
    expect(JSON.stringify(normalized)).not.toContain('personal-address');
  });

  it('aggregates repeated fingerprints by UTC day and retains only five request IDs', async () => {
    const now = Date.UTC(2026, 8, 27, 10);
    const original = event();
    const repeats = Array.from({ length: 7 }, () => event({
      event_id: crypto.randomUUID(),
      request_id: crypto.randomUUID(),
      retry_count: 3,
    }));
    await recordOperationalErrors(env, [original], now);
    await recordOperationalErrors(env, repeats, now + 60_000);

    const row = await env.USAGE.prepare(
      `SELECT day, count, first_at, last_at, max_retry_count, request_ids
       FROM operational_error_daily WHERE day = ?1`,
    ).bind(new Date(now).toISOString().slice(0, 10)).first<{
      day: string;
      count: number;
      first_at: number;
      last_at: number;
      max_retry_count: number;
      request_ids: string;
    }>();
    expect(row).toMatchObject({ count: 8, first_at: now, last_at: now + 60_000, max_retry_count: 3 });
    expect(JSON.parse(row!.request_ids)).toHaveLength(5);
    expect(JSON.stringify(row)).not.toContain('example.com');
  });

  it('prunes aggregates older than 30 days', async () => {
    const now = Date.UTC(2026, 8, 27, 12);
    const old = event({ event_id: crypto.randomUUID(), request_id: crypto.randomUUID() });
    await recordOperationalErrors(env, [old], now - 31 * 24 * 60 * 60 * 1000);
    await pruneOperationalErrors(env, now);
    const oldDay = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const row = await env.USAGE.prepare('SELECT day FROM operational_error_daily WHERE day = ?1').bind(oldDay).first();
    expect(row).toBeNull();
  });

  it('rate-limits anonymous error intake without writing the address to D1', async () => {
    let key = '';
    const limiter = {
      limit: async (input: { key: string }) => {
        key = input.key;
        return { success: false };
      },
    } as unknown as RateLimit;
    await expect(assertUnderRateLimit(
      limiter,
      new Request('https://meet.test/api/guest/operational-errors', { headers: { 'cf-connecting-ip': '203.0.113.8' } }),
      'guest-operational-errors',
    )).rejects.toMatchObject({ status: 429 });
    expect(key).toBe('guest-operational-errors:203.0.113.8');
    const columns = await env.USAGE.prepare('PRAGMA table_info(operational_error_daily)').all<{ name: string }>();
    expect(columns.results.map((column) => column.name)).not.toContain('ip');
  });

  it('accepts owner batches and the narrower anonymous guest schema', async () => {
    // Earlier tests write fixed dates; this one writes today. Start empty, or
    // the row count depends on whether today is one of those dates.
    await env.USAGE.prepare('DELETE FROM operational_error_daily').run();
    const session = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', email: 'private-owner@example.com' }),
    }));
    const { access_token: token } = await session.json<{ access_token: string }>();
    const ownerResponse = await exports.default.fetch(new Request('http://local/api/operational-errors', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events: [event()] }),
    }));
    expect(ownerResponse.status).toBe(202);
    expect(await ownerResponse.json()).toEqual({ accepted: 1 });

    const guestEvent = event({
      source: 'web', platform: 'web', code: 'guest.join_failed', operation: 'guest_join',
      error_class: 'network', http_status: undefined, server_code: undefined,
    });
    const guestResponse = await exports.default.fetch(new Request('http://local/api/guest/operational-errors', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({ events: [guestEvent] }),
    }));
    expect(guestResponse.status).toBe(202);
    expect(await guestResponse.json()).toEqual({ accepted: 1 });

    const rows = await env.USAGE.prepare('SELECT * FROM operational_error_daily').all<Record<string, unknown>>();
    expect(JSON.stringify(rows.results)).not.toContain('private-owner@example.com');
    expect(rows.results).toHaveLength(2);
  });

  it('files guest events under the served build, not the release the guest sent', async () => {
    const sent = (release: string) => event({
      source: 'web', platform: 'web', code: 'guest.join_failed', operation: 'guest_join',
      error_class: 'network', http_status: undefined, server_code: undefined, release,
    });
    await env.USAGE.prepare('DELETE FROM operational_error_daily').run();
    for (const release of ['Alice Example', 'rotated 1', 'rotated 2']) {
      const response = await exports.default.fetch(new Request('http://local/api/guest/operational-errors', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: env.WEB_ORIGIN, 'cf-connecting-ip': `198.51.100.${release.length}` },
        body: JSON.stringify({ events: [sent(release)] }),
      }));
      expect(response.status).toBe(202);
    }
    const rows = await env.USAGE.prepare(
      "SELECT release, count FROM operational_error_daily WHERE code = 'guest.join_failed'",
    ).all<{ release: string; count: number }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results?.[0]?.release).not.toContain('Alice');
    expect(rows.results?.[0]?.count).toBe(3);
  });

  it('keeps the highest retry count in one batch', async () => {
    await env.USAGE.prepare('DELETE FROM operational_error_daily').run();
    const now = Date.UTC(2026, 8, 28, 10);
    await recordOperationalErrors(env, [event({ retry_count: 0 }), event({ retry_count: 5 })], now);
    const row = await env.USAGE.prepare('SELECT max_retry_count FROM operational_error_daily WHERE day = ?1')
      .bind('2026-09-28').first<{ max_retry_count: number }>();
    expect(row?.max_retry_count).toBe(5);
  });

  it('rejects malformed intake bodies at the Worker route', async () => {
    const session = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', email: 'schema-test@example.com' }),
    }));
    const { access_token: token } = await session.json<{ access_token: string }>();
    const response = await exports.default.fetch(new Request('http://local/api/operational-errors', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ ...event(), email: 'person@example.net' }] }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
  });

  it('returns a quiet accepted response when D1 storage fails', async () => {
    const session = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', email: 'error-ingest@example.com' }),
    }));
    const { access_token: token } = await session.json<{ access_token: string }>();
    await env.USAGE.exec('DROP TABLE operational_error_daily');
    const response = await exports.default.fetch(new Request('http://local/api/operational-errors', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events: [event()] }),
    }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 0 });
  });
});
