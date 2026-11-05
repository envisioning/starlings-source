/**
 * The admin error overview (meet#419): `starlings://operational-errors/{window}`
 * reads `operational_error_daily` through `GET /api/admin/operational-errors`.
 * Grouped, ranked, bounded, redacted; an admin's own Claude reads it, a
 * member and an agent do not, and every read is on the record.
 */
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  agentSub,
  operationalErrorOverviewQuerySchema,
  operationalErrorOverviewSchema,
  type OperationalErrorOverview,
} from '@starlings/contracts';
import worker from '../src/index';
import { ensureAgentPeople } from '../src/agents';
import { signOwnerSessionToken } from '../src/auth';
import { resetRoleCache } from '../src/capabilities';
import { hmacSHA256Hex, signingKey } from '../src/crypto';
import { inboundKeyEnvName } from '../src/inbound-keys';
import { operationalErrorOverview } from '../src/operational-errors';
import { recordOwnerSignIn } from '../src/usage';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-04T12:00:00.000Z');
const secret = 'an-inbound-secret-for-the-error-overview-test';
const statusEmail = 'status-errors@example.com';

const configured = {
  ...env,
  SESSION_SIGNING_SECRET: 'mcp-operational-errors-signing-secret-32',
  [inboundKeyEnvName(statusEmail)]: secret,
  INTERNAL_REQUEST_SECRET: '',
  AGENT_ROSTER: JSON.stringify({ [statusEmail]: 'Status' }),
} as Env;

const admin = { sub: 'dev:rosa@example.com', email: 'rosa@example.com', name: 'Rosa' };
const member = { sub: 'errors-member', email: 'errors-member@example.com', name: 'Member' };
const adminActor = { sub: 'errors-admin-actor', email: 'errors-admin-actor@example.com', name: 'Admin Actor' };

interface Seed {
  daysAgo: number;
  key: string;
  count: number;
  release?: string;
  platform?: 'cloudflare' | 'macos' | 'ios' | 'web';
  source?: 'worker' | 'mac' | 'ios' | 'web';
  code?: string;
  requestIds?: string[];
  at?: number;
}

async function seed(rows: Seed[], now = NOW): Promise<void> {
  await configured.USAGE.batch(rows.map((row) => {
    const at = row.at ?? now - row.daysAgo * DAY_MS;
    const day = new Date(now - row.daysAgo * DAY_MS).toISOString().slice(0, 10);
    return configured.USAGE.prepare(
      `INSERT INTO operational_error_daily (
         day, fingerprint, source, platform, release, code, operation, error_class,
         http_status, server_code, count, first_at, last_at, max_retry_count, request_ids, route
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'calendar', 'upstream', 502, 'calendar_failed', ?7, ?8, ?9, 0, ?10, ?11)`,
    ).bind(
      day,
      row.key,
      row.source ?? 'worker',
      row.platform ?? 'cloudflare',
      row.release ?? 'abc1234',
      row.code ?? 'calendar_failed',
      row.count,
      at,
      at,
      JSON.stringify(row.requestIds ?? [crypto.randomUUID()]),
      row.platform && row.platform !== 'cloudflare' ? null : 'GET /api/calendar/events',
    );
  }));
}

const query = (input: Record<string, unknown> = {}) => operationalErrorOverviewQuerySchema.parse(input);

beforeEach(async () => {
  await configured.USAGE.prepare('DELETE FROM operational_error_daily').run();
  await configured.USAGE.prepare('DELETE FROM mcp_calls').run();
});

describe('operational error overview', () => {
  it('groups a fingerprint across days and ranks by count, then the latest occurrence', async () => {
    await seed([
      { daysAgo: 0, key: 'a', count: 3 },
      { daysAgo: 2, key: 'a', count: 4 },
      { daysAgo: 1, key: 'b', count: 5 },
      { daysAgo: 0, key: 'c', count: 5, at: NOW - 60_000 },
      { daysAgo: 6, key: 'd', count: 1 },
    ]);
    const overview = await operationalErrorOverview(configured, query({ window: 'week' }), NOW);
    expect(overview.groups.map((group) => group.count)).toEqual([7, 5, 5, 1]);
    // b and c tie at 5; c happened later.
    expect(overview.groups[1]!.last_at).toBe(new Date(NOW - 60_000).toISOString());
    expect(overview.groups[0]!.first_at).toBe(new Date(NOW - 2 * DAY_MS).toISOString());
    expect(overview.groups[0]!.last_at).toBe(new Date(NOW).toISOString());
    expect(overview.total).toEqual({ count: 18, groups: 4, previous_count: 0 });
    expect(overview.truncated).toBe(false);
    expect(operationalErrorOverviewSchema.parse(overview)).toEqual(overview);
  });

  it('gives each group its trend against the previous equal window', async () => {
    await seed([
      { daysAgo: 1, key: 'up', count: 5 },
      { daysAgo: 8, key: 'up', count: 2 },
      { daysAgo: 1, key: 'down', count: 1 },
      { daysAgo: 10, key: 'down', count: 3 },
      { daysAgo: 1, key: 'flat', count: 2 },
      { daysAgo: 13, key: 'flat', count: 2 },
      { daysAgo: 1, key: 'new', count: 4 },
    ]);
    const overview = await operationalErrorOverview(configured, query({ window: 'week' }), NOW);
    const byCount = Object.fromEntries(overview.groups.map((group) => [group.count, [group.trend, group.previous_count]]));
    expect(byCount[5]).toEqual(['up', 2]);
    expect(byCount[1]).toEqual(['down', 3]);
    expect(byCount[2]).toEqual(['flat', 2]);
    expect(byCount[4]).toEqual(['new', 0]);
    expect(overview.previous).toEqual({ from_day: '2026-09-21', to_day: '2026-09-27' });
    expect(overview.total.previous_count).toBe(7);
  });

  it('reads whole UTC days ending today and never past the retention', async () => {
    await seed([
      { daysAgo: 0, key: 'today', count: 1 },
      { daysAgo: 1, key: 'yesterday', count: 2 },
      { daysAgo: 29, key: 'edge', count: 3 },
      { daysAgo: 31, key: 'expired', count: 9 },
    ]);
    const day = await operationalErrorOverview(configured, query({ window: 'day' }), NOW);
    expect(day).toMatchObject({ days: 1, from_day: '2026-10-04', to_day: '2026-10-04', previous: { from_day: '2026-10-03', to_day: '2026-10-03' } });
    expect(day.groups.map((group) => [group.count, group.trend])).toEqual([[1, 'new']]);

    const month = await operationalErrorOverview(configured, query({ window: 'month' }), NOW);
    expect(month).toMatchObject({ days: 30, from_day: '2026-09-05', to_day: '2026-10-04', previous: null, retention_days: 30 });
    expect(month.groups.map((group) => group.count)).toEqual([3, 2, 1]);
    expect(month.groups.every((group) => group.trend === 'unknown' && group.previous_count === null)).toBe(true);
    expect(month.total.previous_count).toBeNull();

    expect(operationalErrorOverviewQuerySchema.safeParse({ window: 'year' }).success).toBe(false);
    expect(operationalErrorOverviewQuerySchema.safeParse({ window: 'week', days: '90' }).success).toBe(false);
    expect(query()).toMatchObject({ window: 'week', limit: 25 });
  });

  it('filters by release, platform and code', async () => {
    await seed([
      { daysAgo: 0, key: 'ios-old', count: 4, source: 'ios', platform: 'ios', release: '4.8.5 (475)', code: 'connect.timeout' },
      { daysAgo: 0, key: 'ios-new', count: 2, source: 'ios', platform: 'ios', release: '4.9.0 (480)', code: 'connect.timeout' },
      { daysAgo: 0, key: 'mac-new', count: 6, source: 'mac', platform: 'macos', release: '4.9.0 (480)', code: 'connect.network' },
      { daysAgo: 0, key: 'worker', count: 8 },
    ]);
    const release = await operationalErrorOverview(configured, query({ release: '4.9.0 (480)' }), NOW);
    expect(release.groups.map((group) => group.count)).toEqual([6, 2]);
    expect(release.filters).toEqual({ release: '4.9.0 (480)', platform: null, code: null });
    const platform = await operationalErrorOverview(configured, query({ platform: 'ios' }), NOW);
    expect(platform.groups.map((group) => group.count)).toEqual([4, 2]);
    expect(platform.total).toMatchObject({ count: 6, groups: 2 });
    const code = await operationalErrorOverview(configured, query({ code: 'connect.timeout', platform: 'ios', release: '4.8.5 (475)' }), NOW);
    expect(code.groups.map((group) => group.count)).toEqual([4]);
    expect(operationalErrorOverviewQuerySchema.safeParse({ platform: 'android' }).success).toBe(false);
    expect(operationalErrorOverviewQuerySchema.safeParse({ code: 'free text' }).success).toBe(false);
  });

  it('returns only the allowlisted fields and drops a request id that is not a UUID', async () => {
    const id = crypto.randomUUID();
    await seed([{ daysAgo: 0, key: 'redact', count: 1, requestIds: ['Bearer secret-token', 'person@example.net', id] }]);
    const overview = await operationalErrorOverview(configured, query(), NOW);
    const [group] = overview.groups;
    expect(Object.keys(group!).sort()).toEqual([
      'code', 'count', 'error_class', 'first_at', 'http_status', 'last_at', 'operation', 'platform',
      'previous_count', 'release', 'request_ids', 'route', 'server_code', 'source', 'trend',
    ]);
    expect(group!.request_ids).toEqual([id]);
    const text = JSON.stringify(overview);
    for (const forbidden of ['fingerprint', 'Bearer', 'example.com', 'email', 'room_slug', 'meeting', 'message', 'stack', 'max_retry_count']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('bounds the groups, the request ids and the size', async () => {
    const rows: Seed[] = [];
    for (let index = 0; index < 60; index += 1) {
      rows.push({ daysAgo: 0, key: `bulk-${index}`, count: index + 1, requestIds: [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()] });
      rows.push({ daysAgo: 1, key: `bulk-${index}`, count: 1, requestIds: [crypto.randomUUID(), crypto.randomUUID()] });
    }
    await seed(rows);
    const fallback = await operationalErrorOverview(configured, query(), NOW);
    expect(fallback.groups).toHaveLength(25);
    expect(fallback.truncated).toBe(true);
    expect(fallback.total.groups).toBe(60);
    const widest = await operationalErrorOverview(configured, query({ limit: '50' }), NOW);
    expect(widest.groups).toHaveLength(50);
    expect(widest.groups.every((group) => group.request_ids.length === 3)).toBe(true);
    expect(JSON.stringify(widest).length).toBeLessThan(32 * 1024);
    expect(operationalErrorOverviewQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Through /mcp

async function oauthBearer(person: { sub: string; email: string; name: string }, grant: string): Promise<string> {
  const now = Date.now();
  await configured.USAGE.prepare(
    `INSERT OR REPLACE INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at) VALUES (?1, ?2, NULL, '["https://claude.ai/api/mcp/auth_callback"]', ?3)`,
  ).bind('client-errors', 'claude.ai', now).run();
  await configured.USAGE.prepare(
    `INSERT OR REPLACE INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at)
     VALUES (?1, 'client-errors', ?2, ?3, 'read', 'jti', NULL, ?4, ?4, NULL, NULL)`,
  ).bind(grant, person.sub, person.email, now).run();
  return new SignJWT({ email: person.email, name: person.name, scope: 'read', grant, client: 'client-errors' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('starlings.example')
    .setAudience('meet-mcp')
    .setSubject(person.sub)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey(configured.SESSION_SIGNING_SECRET));
}

async function send(request: Request): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, configured, context);
  await waitOnExecutionContext(context);
  return response;
}

const readBody = (uri: string) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } });

async function readAsHuman(token: string, uri: string) {
  const response = await send(new Request('http://local/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: readBody(uri),
  }));
  return response.json<{ result?: { contents: Array<{ text: string }> }; error?: { code: number; message: string; data?: { code: string } } }>();
}

async function readAsAgent(actor: string, uri: string) {
  const raw = readBody(uri);
  const timestamp = String(Date.now());
  const response = await send(new Request('http://local/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-internal-key-id': statusEmail,
      'x-meet-agent': statusEmail,
      'x-meet-actor': actor,
      'x-internal-timestamp': timestamp,
      'x-internal-signature': await hmacSHA256Hex(secret, `${timestamp}.${statusEmail}.${actor}.${raw}`),
    },
    body: raw,
  }));
  expect(response.status).toBe(200);
  return response.json<{ result?: unknown; error?: { code: number; message: string; data?: { code: string } } }>();
}

async function lastCall(): Promise<{ principal: string; actor_email: string; name: string; outcome: string; detail: string | null } | null> {
  return configured.USAGE.prepare('SELECT principal, actor_email, name, outcome, detail FROM mcp_calls ORDER BY ts DESC LIMIT 1')
    .first();
}

describe('starlings://operational-errors/{window}', () => {
  it('is listed as a resource template', async () => {
    const token = await oauthBearer(admin, 'grant-errors-admin');
    const response = await send(new Request('http://local/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/templates/list' }),
    }));
    const { result } = await response.json<{ result: { resourceTemplates: Array<{ uriTemplate: string }> } }>();
    expect(result.resourceTemplates.map((template) => template.uriTemplate)).toContain('starlings://operational-errors/{window}');
  });

  it('answers an admin, with filters, and records the read', async () => {
    await seed([
      { daysAgo: 0, key: 'ios', count: 3, source: 'ios', platform: 'ios', release: '4.9.0 (480)', code: 'connect.timeout' },
      { daysAgo: 0, key: 'worker', count: 7 },
    ], Date.now());
    const token = await oauthBearer(admin, 'grant-errors-admin');
    const uri = 'starlings://operational-errors/day?platform=ios';
    const body = await readAsHuman(token, uri);
    expect(body.error).toBeUndefined();
    const overview = operationalErrorOverviewSchema.parse(JSON.parse(body.result!.contents[0]!.text)) as OperationalErrorOverview;
    expect(overview.window).toBe('day');
    expect(overview.groups.map((group) => [group.platform, group.count])).toEqual([['ios', 3]]);
    expect(await lastCall()).toMatchObject({ principal: 'session', actor_email: admin.email, name: uri, outcome: 'ok' });
  });

  it('refuses a window that is not day, week or month, and a query key it does not know', async () => {
    const token = await oauthBearer(admin, 'grant-errors-admin');
    expect((await readAsHuman(token, 'starlings://operational-errors/year')).error?.code).toBe(-32602);
    const unknown = await readAsHuman(token, 'starlings://operational-errors/week?email=someone@example.net');
    expect(unknown.error).toMatchObject({ code: -32002, data: { code: 'invalid_request' } });
  });

  it('refuses a member who is not an admin, and records the refusal', async () => {
    await recordOwnerSignIn(configured, member, 'mac');
    resetRoleCache();
    const token = await oauthBearer(member, 'grant-errors-member');
    const body = await readAsHuman(token, 'starlings://operational-errors/week');
    expect(body.error).toMatchObject({ code: -32002, data: { code: 'not_org_admin' } });
    expect(await lastCall()).toMatchObject({ actor_email: member.email, outcome: 'refused', detail: 'not_org_admin' });
  });

  it('refuses an agent, even one acting for an admin, and records the refusal', async () => {
    await recordOwnerSignIn(configured, adminActor, 'mac');
    await configured.USAGE.prepare("UPDATE people SET role = 'admin' WHERE sub = ?1").bind(adminActor.sub).run();
    resetRoleCache();
    await ensureAgentPeople(configured, Date.now());
    const thread = 'errors-agent-thread';
    await configured.USAGE.prepare("INSERT INTO threads (id, kind, created_at) VALUES (?1, 'dm', ?2) ON CONFLICT(id) DO NOTHING").bind(thread, Date.now()).run();
    for (const [sub, email] of [[agentSub(statusEmail), statusEmail], [adminActor.sub, adminActor.email]] as const) {
      await configured.USAGE.prepare(
        'INSERT INTO thread_members (thread_id, member_sub, member_email) VALUES (?1, ?2, ?3) ON CONFLICT(thread_id, member_sub) DO NOTHING',
      ).bind(thread, sub, email).run();
    }
    const body = await readAsAgent(adminActor.email, 'starlings://operational-errors/week');
    expect(body.error).toMatchObject({ code: -32002, data: { code: 'capability_denied' } });
    expect(await lastCall()).toMatchObject({ principal: 'agent', actor_email: adminActor.email, outcome: 'refused', detail: 'capability_denied' });
  });

  it('refuses a borrowed agent session at the route itself', async () => {
    const token = await signOwnerSessionToken(admin, configured, '2m', undefined, 'Status', agentSub(statusEmail));
    const response = await send(new Request('http://local/api/admin/operational-errors?window=week', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'capability_denied' });

    const human = await signOwnerSessionToken(admin, configured, '2m');
    const allowed = await send(new Request('http://local/api/admin/operational-errors?window=week', {
      headers: { authorization: `Bearer ${human}`, accept: 'application/json' },
    }));
    expect(allowed.status).toBe(200);
  });
});
