// Failures that reach somebody (meet#601): a refused signature, Core gone
// quiet, a route answering 5xx, and a deploy check that cannot run.
import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { recordOwnerSignIn } from '../src/usage';
import { hmacSHA256Hex } from '../src/crypto';
import { inboundKeyEnvName } from '../src/inbound-keys';
import {
  CORE_CALLER,
  CORE_SILENCE_MS,
  INBOUND_REFUSAL_INTERVAL_MS,
  ROUTE_5XX_THRESHOLD,
  checkCoreSilence,
  checkDeployStale,
  checkRoute5xx,
  deployCheckBlocker,
  recentFailures,
  recordFailure,
  recordInboundAccepted,
  sendDueAlerts,
} from '../src/ops';
import { recordOperationalErrors, routePattern, workerErrorEvent } from '../src/operational-errors';

// Core's inbound key (vitest.config.ts).
const SECRET = 'inbound-test-secret-with-at-least-32-characters';
const HOUR_MS = 60 * 60_000;

async function failureRows(kind: string) {
  const { results } = await env.USAGE.prepare('SELECT day, count, last_detail FROM ops_failures WHERE kind = ?1')
    .bind(kind).all<{ day: string; count: number; last_detail: string | null }>();
  return results;
}

async function postChannelEvent(options: { secret?: string; keyId?: string; timestamp?: string; sign?: boolean; body?: unknown } = {}) {
  const raw = JSON.stringify(options.body ?? { thread_id: 'team', type: 'event', text: 'closed #1', idempotency_key: crypto.randomUUID() });
  const timestamp = options.timestamp ?? String(Date.now());
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-internal-key-id': options.keyId ?? 'core' };
  if (options.sign !== false) {
    headers['x-internal-timestamp'] = timestamp;
    headers['x-internal-signature'] = await hmacSHA256Hex(options.secret ?? SECRET, `${timestamp}.${raw}`);
  }
  return exports.default.fetch(new Request('http://local/api/internal/channel-events', { method: 'POST', headers, body: raw }));
}

function postmark() {
  const mails: Array<{ To: string; Subject: string; TextBody: string }> = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname === 'api.postmarkapp.com') {
      mails.push(await request.json());
      return Response.json({ ok: true });
    }
    return new Response('unexpected', { status: 500 });
  });
  return mails;
}

beforeEach(async () => {
  await env.USAGE.prepare('DELETE FROM ops_inbound').run();
  await env.USAGE.prepare('DELETE FROM ops_route_5xx_hourly').run();
  await env.USAGE.prepare("DELETE FROM ops_failures WHERE kind IN ('inbound_signature', 'core_events_silent', 'route_5xx', 'deploy_check_skipped')").run();
  await env.USAGE.prepare("DELETE FROM ops_alerts WHERE kind IN ('inbound_signature', 'core_events_silent', 'route_5xx')").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('signature refusals', () => {
  it('a wrong signature on channel-events leaves one failure row and one alert mail', async () => {
    const response = await postChannelEvent({ secret: 'not-the-inbound-secret-but-long-enough-to-pass' });
    expect(response.status).toBe(403);

    const rows = await failureRows('inbound_signature');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 1, last_detail: 'core: mismatch' });

    const mails = postmark();
    const alertEnv = { ...env, OPS_ALERT_EMAIL: 'ops@example.com', POSTMARK_API_KEY: 'pm-test' } as Env;
    expect(await sendDueAlerts(alertEnv, Date.now())).toContain('inbound_signature');
    const mail = mails.filter((row) => row.Subject === 'Starlings: inbound_signature failing');
    expect(mail).toHaveLength(1);
    expect(mail[0]!.TextBody).toContain('core: mismatch');
  });

  it('counts an expired timestamp, and not a request that carries no signature', async () => {
    expect((await postChannelEvent({ sign: false })).status).toBe(403);
    expect(await failureRows('inbound_signature')).toEqual([]);

    expect((await postChannelEvent({ timestamp: String(Date.now() - 3_600_000) })).status).toBe(403);
    expect((await failureRows('inbound_signature'))[0]).toMatchObject({ count: 1, last_detail: 'core: expired' });
  });

  it('writes at most one row per caller per ten minutes, however many calls are refused', async () => {
    for (let call = 0; call < 5; call += 1) {
      await postChannelEvent({ secret: 'not-the-inbound-secret-but-long-enough-to-pass' });
    }
    expect((await failureRows('inbound_signature'))[0]?.count).toBe(1);

    // The ten minutes are measured on the stored refusal time, so moving it back is the clock.
    await env.USAGE.prepare('UPDATE ops_inbound SET last_refused_at = ?1 WHERE caller = ?2')
      .bind(Date.now() - INBOUND_REFUSAL_INTERVAL_MS - 1000, CORE_CALLER).run();
    await postChannelEvent({ secret: 'not-the-inbound-secret-but-long-enough-to-pass' });
    expect((await failureRows('inbound_signature'))[0]?.count).toBe(2);
  });

  it('counts a forged agent call on /mcp against the key it names, never the header text', async () => {
    const configured = {
      ...env,
      [inboundKeyEnvName('status-test@example.com')]: SECRET,
      AGENT_ROSTER: JSON.stringify({ 'status-test@example.com': 'Status' }),
    } as Env;
    async function forged(agent: string) {
      const context = createExecutionContext();
      const response = await worker.fetch(new Request('http://local/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-internal-key-id': agent,
          'x-meet-agent': agent,
          'x-meet-actor': 'rosa@example.com',
          'x-internal-timestamp': String(Date.now()),
          'x-internal-signature': 'deadbeef'.repeat(8),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }), configured, context);
      await waitOnExecutionContext(context);
      return response.status;
    }
    expect(await forged('status-test@example.com')).toBe(403);
    expect(await forged('someone-made-up@example.com')).toBe(403);
    expect(await forged('another-made-up@example.com')).toBe(403);

    const callers = await env.USAGE.prepare('SELECT caller FROM ops_inbound ORDER BY caller').all<{ caller: string }>();
    // A key id nobody provisioned is counted under one fixed name, however many there are.
    expect(callers.results.map((row) => row.caller)).toEqual(['agent:status-test', 'unknown-key']);
    expect((await failureRows('inbound_signature'))[0]?.count).toBe(2);
  });
});

describe('Core gone quiet', () => {
  it('records an accepted call from Core, and not one from an agent', async () => {
    const dev = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'ops-signals-rosa@example.com' }),
    }));
    const { access_token: token } = await dev.json<{ access_token: string }>();
    await recordOwnerSignIn(env as Env, { sub: 'dev:ops-signals-rosa@example.com', email: 'ops-signals-rosa@example.com', name: 'Rosa' }, 'mac');
    await exports.default.fetch(new Request('http://local/api/threads', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'team' }),
    }));
    expect((await postChannelEvent()).status).toBe(200);
    const row = await env.USAGE.prepare('SELECT last_accepted_at FROM ops_inbound WHERE caller = ?1')
      .bind(CORE_CALLER).first<{ last_accepted_at: number | null }>();
    expect(row?.last_accepted_at).toBeGreaterThan(Date.now() - 60_000);

    await env.USAGE.prepare('DELETE FROM ops_inbound').run();
    // An agent's call names its sender; the roster refuses this one, and neither way is Core.
    await postChannelEvent({ keyId: 'agent-nobody@example.com', body: { thread_id: 'team', type: 'event', sender: 'agent-nobody@example.com', text: 'x', idempotency_key: 'k-agent' } });
    expect(await env.USAGE.prepare('SELECT 1 FROM ops_inbound WHERE caller = ?1').bind(CORE_CALLER).first()).toBeNull();
  });

  it('counts core_events_silent after 72 hours without an accepted call, and not before', async () => {
    const now = Date.parse('2036-04-01T10:00:00Z');
    await recordInboundAccepted(env, CORE_CALLER, now - CORE_SILENCE_MS + HOUR_MS);
    expect(await checkCoreSilence(env, now)).toBe(false);
    expect(await failureRows('core_events_silent')).toEqual([]);

    expect(await checkCoreSilence(env, now + 2 * HOUR_MS)).toBe(true);
    const rows = await failureRows('core_events_silent');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 1, last_detail: '73 h since the last call' });
  });

  it('waits 72 hours from the first check when no call is on record yet', async () => {
    const now = Date.parse('2036-04-02T10:00:00Z');
    expect(await checkCoreSilence(env, now)).toBe(false);
    expect(await checkCoreSilence(env, now + CORE_SILENCE_MS - HOUR_MS)).toBe(false);
    expect(await checkCoreSilence(env, now + CORE_SILENCE_MS + HOUR_MS)).toBe(true);
    expect((await failureRows('core_events_silent'))[0]?.last_detail).toBe('no call in 73 h');
  });

  it('a call after the silence ends it', async () => {
    const now = Date.parse('2036-04-03T10:00:00Z');
    await recordInboundAccepted(env, CORE_CALLER, now - 80 * HOUR_MS);
    expect(await checkCoreSilence(env, now)).toBe(true);
    await recordInboundAccepted(env, CORE_CALLER, now);
    expect(await checkCoreSilence(env, now + HOUR_MS)).toBe(false);
  });
});

describe('5xx by route', () => {
  it('turns a path into its route pattern, with no id, slug or address in it', () => {
    expect(routePattern('post', '/api/threads/4f1c9d2e-0000-4000-8000-000000000001/messages')).toBe('POST /api/threads/:id/messages');
    expect(routePattern('GET', '/api/rooms/rosa/join-requests/4f1c9d2e-0000-4000-8000-000000000001/exchange'))
      .toBe('GET /api/rooms/:id/join-requests/:id/exchange');
    expect(routePattern('GET', '/api/calendar/accounts/ada@example.net/events')).toBe('GET /api/calendar/accounts/:id/events');
    expect(routePattern('GET', '/room/team-offsite')).toBe('GET /room/:id');
    expect(routePattern('GET', '/api/docs/documents/Ab3dE9xY')).toBe('GET /api/docs/documents/:id');
    expect(routePattern('GET', `/${'a/'.repeat(40)}`).length).toBeLessThanOrEqual(100);
  });

  it('keeps the route on a Worker error event and nowhere else', () => {
    const event = workerErrorEvent({
      requestId: crypto.randomUUID(), pathname: '/api/threads/abcd1234/messages', status: 500, code: 'internal_error', method: 'POST',
    });
    expect(event.route).toBe('POST /api/threads/:id/messages');
    expect(workerErrorEvent({ requestId: crypto.randomUUID(), pathname: '/api/x', status: 500, code: 'internal_error' }))
      .not.toHaveProperty('route');
  });

  async function fail(route: string, times: number, at: number, status = 500) {
    const events = Array.from({ length: times }, () => ({
      ...workerErrorEvent({ requestId: crypto.randomUUID(), pathname: '/api/threads/abcd1234/messages', status, code: 'internal_error', method: 'POST' }),
      route,
    }));
    await recordOperationalErrors(env, events, at);
  }

  it('stores the route on the daily aggregate and counts it by hour', async () => {
    const now = Date.parse('2036-05-01T10:30:00Z');
    await fail('POST /api/threads/:id/messages', 3, now);
    const daily = await env.USAGE.prepare(
      'SELECT route, count FROM operational_error_daily WHERE route = ?1',
    ).bind('POST /api/threads/:id/messages').first<{ route: string; count: number }>();
    expect(daily).toMatchObject({ count: 3 });
    const hourly = await env.USAGE.prepare('SELECT hour, count FROM ops_route_5xx_hourly WHERE route = ?1')
      .bind('POST /api/threads/:id/messages').first<{ hour: number; count: number }>();
    expect(hourly).toEqual({ hour: Math.floor(now / HOUR_MS), count: 3 });
  });

  it('does not count a 4xx-shaped capture against the hour', async () => {
    const now = Date.parse('2036-05-02T10:30:00Z');
    await fail('GET /api/calendar/events', ROUTE_5XX_THRESHOLD + 5, now, 401);
    expect(await env.USAGE.prepare('SELECT 1 FROM ops_route_5xx_hourly').first()).toBeNull();
  });

  it('counts route_5xx for a route at the threshold in the hour that just ended, and not below it', async () => {
    const hourStart = Date.parse('2036-05-03T10:00:00Z');
    await fail('POST /api/threads/:id/messages', ROUTE_5XX_THRESHOLD, hourStart + 10 * 60_000);
    await fail('GET /api/feed', ROUTE_5XX_THRESHOLD - 1, hourStart + 20 * 60_000);

    const counted = await checkRoute5xx(env, hourStart + HOUR_MS + 2 * 60_000);
    expect(counted).toEqual(['POST /api/threads/:id/messages']);
    const rows = await failureRows('route_5xx');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.last_detail).toBe(`POST /api/threads/:id/messages x${ROUTE_5XX_THRESHOLD}`);

    const mails = postmark();
    const alertEnv = { ...env, OPS_ALERT_EMAIL: 'ops@example.com', POSTMARK_API_KEY: 'pm-test' } as Env;
    expect(await sendDueAlerts(alertEnv, Date.now())).toContain('route_5xx');
    expect(mails.some((row) => row.Subject === 'Starlings: route_5xx failing')).toBe(true);
  });

  it('drops hours older than two days', async () => {
    const now = Date.parse('2036-05-05T10:00:00Z');
    await fail('GET /api/old', 2, now - 49 * HOUR_MS);
    await fail('GET /api/new', 2, now - HOUR_MS);
    await checkRoute5xx(env, now);
    const routes = await env.USAGE.prepare('SELECT route FROM ops_route_5xx_hourly').all<{ route: string }>();
    expect(routes.results.map((row) => row.route)).toEqual(['GET /api/new']);
  });
});

describe('the deploy check without the GitHub App', () => {
  function compare(captured: Array<{ url: string; authorization: string | null }>, committedAt: number) {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      captured.push({ url: request.url, authorization: request.headers.get('authorization') });
      return Response.json({
        status: 'ahead',
        ahead_by: 1,
        commits: [{ sha: 'head0001', commit: { committer: { date: new Date(committedAt).toISOString() } } }],
      });
    });
  }

  it('says why it cannot run when there is no App and no token', () => {
    expect(deployCheckBlocker(env, 'abc1234')).toBe('no GITHUB_DEPLOY_CHECK_TOKEN');
    // A build with no recorded commit has nothing to compare; that is not a gap in configuration.
    expect(deployCheckBlocker(env, 'unknown')).toBeNull();
  });

  it('is skipped, not fresh, without a credential', async () => {
    expect(await checkDeployStale(env, Date.now(), 'abc1234')).toBe('skipped');
  });

  it('compares with the token when there is one, and counts deploy_stale', async () => {
    const now = Date.parse('2036-06-01T10:00:00Z');
    const captured: Array<{ url: string; authorization: string | null }> = [];
    compare(captured, now - 60 * 60_000);
    const withToken = { ...env, GITHUB_DEPLOY_CHECK_TOKEN: 'github_pat_test' } as Env;
    expect(deployCheckBlocker(withToken, 'abc1234')).toBeNull();
    expect(await checkDeployStale(withToken, now, 'abc1234')).toBe('stale');
    expect(captured).toEqual([{
      url: 'https://api.github.com/repos/envisioning/starlings/compare/abc1234...main',
      authorization: 'Bearer github_pat_test',
    }]);
    expect((await failureRows('deploy_stale')).some((row) => row.last_detail === 'head0001')).toBe(true);
  });

  it('mails a skipped deploy check, with the step that fixes it', async () => {
    await recordFailure(env, 'deploy_check_skipped', 'no GITHUB_DEPLOY_CHECK_TOKEN');
    const mails = postmark();
    const alertEnv = { ...env, OPS_ALERT_EMAIL: 'ops@example.com', POSTMARK_API_KEY: 'pm-test' } as Env;
    expect(await sendDueAlerts(alertEnv, Date.now())).toContain('deploy_check_skipped');
    const mail = mails.find((row) => row.Subject.includes('deploy_check_skipped'));
    expect(mail?.TextBody).toContain('GITHUB_DEPLOY_CHECK_TOKEN');
    const rows = await recentFailures(env);
    expect(rows.find((row) => row.kind === 'deploy_check_skipped')).toMatchObject({ count_today: 1, mailed: true });
  });
});

describe('Admin › Operations feed', () => {
  async function headers(email: string) {
    const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Admin', email }),
    }));
    const { access_token: token } = await response.json<{ access_token: string }>();
    return { authorization: `Bearer ${token}`, origin: env.WEB_ORIGIN };
  }

  it('lists the three new kinds and Core’s last call to an admin, and refuses a member', async () => {
    await recordFailure(env, 'inbound_signature', 'channel-events: mismatch');
    await recordFailure(env, 'core_events_silent', '80 h since the last call');
    await recordFailure(env, 'route_5xx', 'GET /api/feed x31');
    await recordInboundAccepted(env, CORE_CALLER, Date.now() - HOUR_MS);
    // The release line reads the public update feed; no test reaches it.
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }));

    const response = await exports.default.fetch(new Request('http://local/api/admin/ops-failures', { headers: await headers('rosa@example.com') }));
    expect(response.status).toBe(200);
    const body = await response.json<{ failures: Array<{ kind: string; count_today: number; last_detail: string | null; mailed: boolean }>; core_last_accepted_at: number | null }>();
    const kinds = body.failures.map((row) => row.kind);
    expect(kinds).toEqual(expect.arrayContaining(['inbound_signature', 'core_events_silent', 'route_5xx']));
    expect(body.failures.find((row) => row.kind === 'route_5xx')).toMatchObject({ count_today: 1, last_detail: 'GET /api/feed x31', mailed: false });
    expect(body.core_last_accepted_at).toBeGreaterThan(Date.now() - 2 * HOUR_MS);

    const member = await exports.default.fetch(new Request('http://local/api/admin/ops-failures', { headers: await headers('ops-signals-member@example.com') }));
    expect(member.status).toBe(403);
  });
});
