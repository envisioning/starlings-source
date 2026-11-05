import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { adminOverviewSchema, type JoinRequestReceipt, type PeersResponse } from '@starlings/contracts';
import type { AdminOverview } from '../src/admin';
import { resetPeerRosterCache } from '../src/peers';
import { signOwnerRefreshToken } from '../src/auth';
import { recordDownstreamUsage } from '../src/downstream-usage';

async function ownerSession(email = 'rosa@example.com', name = 'Rosa') {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email }),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}` };
}

describe('admin overview', () => {
  afterEach(async () => {
    await env.USAGE.prepare('DELETE FROM downstream_usage_reports').run();
  });

  it('answers 401 without a session', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/admin/overview', {
      headers: { origin: env.WEB_ORIGIN },
    }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'owner_auth_required' });
  });

  it('refuses a member who is not an admin, and says so on /api/auth/me', async () => {
    const headers = await ownerSession('unmapped@example.com', 'Ada');
    for (const path of ['/api/admin/overview', '/api/admin/workspace', '/api/admin/connectors', '/api/connectors']) {
      const response = await exports.default.fetch(new Request(`http://local${path}`, { headers }));
      expect(response.status, path).toBe(403);
      await expect(response.json(), path).resolves.toMatchObject({ code: 'not_org_admin' });
    }
    const me = await exports.default.fetch(new Request('http://local/api/auth/me', { headers }));
    await expect(me.json()).resolves.toMatchObject({ is_admin: false });
  });

  it('lets an admin read the overview, and says so on /api/auth/me', async () => {
    const headers = await ownerSession();
    const response = await exports.default.fetch(new Request('http://local/api/admin/overview', { headers }));
    expect(response.status).toBe(200);
    const body = await response.json<AdminOverview>();
    expect(body.now.rooms.some((row) => row.slug === 'rosa')).toBe(true);
    const me = await exports.default.fetch(new Request('http://local/api/auth/me', { headers }));
    await expect(me.json()).resolves.toMatchObject({ is_admin: true });
  });

  it('shows measured client-reported downstream RTP bytes without a plan cap', async () => {
    const now = Date.now();
    const date = new Date(now);
    const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    await recordDownstreamUsage(env, {
      reporter_id: crypto.randomUUID(),
      month_start: monthStart,
      received_bytes: 12_345_000_000,
    }, now);

    const headers = await ownerSession();
    const response = await exports.default.fetch(new Request('http://local/api/admin/overview', { headers }));
    expect(response.status).toBe(200);
    const body = await response.json<AdminOverview>();
    expect(adminOverviewSchema.safeParse(body).success).toBe(true);
    expect(body.downstream_usage).toMatchObject({
      received_bytes: 12_345_000_000,
      reporting_sessions: 1,
    });
    expect(body.downstream_usage?.last_reported_at).toEqual(expect.any(Number));
    expect(body.thresholds.some((row) => row.id === 'livekit_downstream_transfer')).toBe(false);
  });

  it('never returns guest emails, transcript, or summary text', async () => {
    const owner = await ownerSession();
    const start = await exports.default.fetch(new Request('http://local/api/rooms/rosa/start', {
      method: 'POST',
      headers: owner,
    }));
    expect(start.status).toBe(200);

    const knock = await exports.default.fetch(new Request('http://local/api/rooms/rosa/join-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({
        name: 'Ana',
        email: 'ana@acme.example',
      }),
    }));
    expect(knock.status).toBe(201);
    const receipt = await knock.json<JoinRequestReceipt>();

    const admit = await exports.default.fetch(new Request(
      `http://local/api/rooms/rosa/join-requests/${receipt.requestId}/decision`,
      {
        method: 'POST',
        headers: { ...owner, 'content-type': 'application/json' },
        body: JSON.stringify({ admit: true }),
      },
    ));
    expect(admit.status).toBe(200);

    const response = await exports.default.fetch(new Request('http://local/api/admin/overview', {
      headers: owner,
    }));
    expect(response.status).toBe(200);
    const dumped = JSON.stringify(await response.json());
    expect(dumped).not.toContain('ana@acme.example');
    expect(dumped).not.toMatch(/transcript/i);
    expect(dumped).not.toContain('"summary"');
  });

  it('mints a cookie session without Google in development', async () => {
    const login = await exports.default.fetch(new Request('http://local/api/dev/session?return_to=/admin', {
      redirect: 'manual',
    }));
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toBe('/admin');
    const setCookie = login.headers.getSetCookie().find((row) => row.startsWith('meet_session='));
    expect(setCookie).toBeTruthy();
    expect(setCookie).not.toMatch(/;\s*Secure(?:;|$)/i);
    const token = decodeURIComponent(setCookie!.split(';')[0]!.slice('meet_session='.length));
    const response = await exports.default.fetch(new Request('http://local/api/admin/overview', {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(response.status).toBe(200);
  });

  it('sets the same cookie on POST /api/dev/session', async () => {
    const login = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }));
    expect(login.status).toBe(200);
    const setCookie = login.headers.getSetCookie().find((row) => row.startsWith('meet_session='));
    expect(setCookie).toBeTruthy();
    expect(setCookie).not.toMatch(/;\s*Secure(?:;|$)/i);
  });

  it('reads the overview from the session cookie without an Origin header', async () => {
    const login = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }));
    const setCookie = login.headers.getSetCookie().find((row) => row.startsWith('meet_session='));
    const token = decodeURIComponent(setCookie!.split(';')[0]!.slice('meet_session='.length));
    const response = await exports.default.fetch(new Request('http://local/api/admin/overview', {
      headers: { cookie: `meet_session=${encodeURIComponent(token)}` },
    }));
    expect(response.status).toBe(200);
  });
});

describe('roster visibility', () => {
  const test = { email: 'accounts@example.org', name: 'Envisioning Accounts' };

  afterEach(async () => {
    resetPeerRosterCache();
    await env.USAGE.prepare('DELETE FROM people WHERE email = ?1').bind(test.email).run();
  });

  async function setHidden(headers: Record<string, string>, email: string, hidden: boolean) {
    return exports.default.fetch(new Request('http://local/api/admin/people/visibility', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({ email, hidden }),
    }));
  }

  async function overview(headers: Record<string, string>) {
    const response = await exports.default.fetch(new Request('http://local/api/admin/overview', { headers }));
    expect(response.status).toBe(200);
    return response.json<AdminOverview>();
  }

  it('takes a hidden person out of the roster but leaves them in Admin', async () => {
    await ownerSession(test.email, test.name);
    const headers = await ownerSession();
    resetPeerRosterCache();

    const before = await exports.default.fetch(new Request('http://local/api/peers', { headers }));
    const visible = await before.json<PeersResponse>();
    expect(visible.peers.some((peer) => peer.email === test.email)).toBe(true);

    const hide = await setHidden(headers, test.email, true);
    expect(hide.status).toBe(200);
    await expect(hide.json()).resolves.toEqual({ email: test.email, hidden: true });

    resetPeerRosterCache();
    const after = await exports.default.fetch(new Request('http://local/api/peers', { headers }));
    const hidden = await after.json<PeersResponse>();
    expect(hidden.peers.some((peer) => peer.email === test.email)).toBe(false);

    // The row is filtered, never deleted: Admin still has it, flagged.
    const admin = await overview(headers);
    expect(admin.people.find((row) => row.email === test.email)?.hidden).toBe(true);
  });

  it('puts them back', async () => {
    await ownerSession(test.email, test.name);
    const headers = await ownerSession();
    expect((await setHidden(headers, test.email, true)).status).toBe(200);
    expect((await setHidden(headers, test.email, false)).status).toBe(200);

    resetPeerRosterCache();
    const response = await exports.default.fetch(new Request('http://local/api/peers', { headers }));
    const roster = await response.json<PeersResponse>();
    expect(roster.peers.some((peer) => peer.email === test.email)).toBe(true);
  });

  it('404s on an address with no people row', async () => {
    const headers = await ownerSession();
    const response = await setHidden(headers, 'nobody@example.com', true);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: 'person_not_found' });
  });

  it('refuses a member who is not an admin, and takes them once they are', async () => {
    await ownerSession(test.email, test.name);
    const member = await ownerSession('ada@example.com', 'Ada');
    const owner = await ownerSession();

    // Any member may read the page. Changing what everyone sees is a role.
    const refused = await setHidden(member, test.email, true);
    expect(refused.status).toBe(403);
    await expect(refused.json()).resolves.toMatchObject({ code: 'not_org_admin' });

    const promote = await exports.default.fetch(new Request('http://local/api/admin/people/role', {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({ email: 'ada@example.com', role: 'admin' }),
    }));
    expect(promote.status).toBe(200);

    expect((await setHidden(member, test.email, true)).status).toBe(200);
    await env.USAGE.prepare('DELETE FROM people WHERE email = ?1').bind('ada@example.com').run();
  });

  it('will not let an admin change their own role, or demote a room owner', async () => {
    const owner = await ownerSession();
    async function role(email: string, value: 'member' | 'admin') {
      return exports.default.fetch(new Request('http://local/api/admin/people/role', {
        method: 'POST',
        headers: { ...owner, 'content-type': 'application/json', origin: env.WEB_ORIGIN },
        body: JSON.stringify({ email, role: value }),
      }));
    }

    // Self-demotion is what locks the only surface that could undo it.
    const own = await role('rosa@example.com', 'member');
    expect(own.status).toBe(409);
    await expect(own.json()).resolves.toMatchObject({ code: 'role_change_refused' });

    // A room owner is an admin by configuration, so writing the column would
    // be a change the guard ignores. Refused rather than pretended — and it
    // takes a *second* admin to attempt it, since the owner cannot try on
    // themselves.
    const ada = await ownerSession('ada@example.com', 'Ada');
    expect((await role('ada@example.com', 'admin')).status).toBe(200);

    const demoteOwner = await exports.default.fetch(new Request('http://local/api/admin/people/role', {
      method: 'POST',
      headers: { ...ada, 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({ email: 'rosa@example.com', role: 'member' }),
    }));
    expect(demoteOwner.status).toBe(409);
    await expect(demoteOwner.json()).resolves.toMatchObject({ code: 'role_change_refused' });

    await env.USAGE.prepare('DELETE FROM people WHERE email = ?1').bind('ada@example.com').run();
  });

  it('records every admin write on the page', async () => {
    const owner = await ownerSession();
    await ownerSession(test.email, test.name);
    expect((await setHidden(owner, test.email, true)).status).toBe(200);

    const admin = await overview(owner);
    const entry = admin.audit.find((row) => row.action === 'person.hide' && row.subject === test.email);
    expect(entry).toBeTruthy();
    expect(entry?.actor_email).toBe('rosa@example.com');
    expect(admin.viewer.is_admin).toBe(true);
  });

  it('remembers when each one-off job last ran, and says never before the first run', async () => {
    const owner = await ownerSession();
    const before = await overview(owner);
    expect(before.jobs['job.backfill']).toBeUndefined();

    const run = await exports.default.fetch(new Request('http://local/api/admin/backfill', {
      method: 'POST',
      headers: { ...owner, origin: env.WEB_ORIGIN },
    }));
    expect(run.status).toBe(200);

    const after = await overview(owner);
    const last = after.jobs['job.backfill'];
    expect(last?.actor_email).toBe('rosa@example.com');
    expect(last?.ts).toBeGreaterThan(0);
    // The jobs write the same trail as every other admin action: one history.
    expect(after.audit.some((row) => row.action === 'job.backfill')).toBe(true);
  });

  it('reports rooms it could not read instead of counting them as idle', async () => {
    const admin = await overview(await ownerSession());
    expect(Array.isArray(admin.degraded)).toBe(true);
    expect(admin.degraded).toEqual([]);
  });

  it('cuts somebody off and signs their devices out, then lets them back', async () => {
    const owner = await ownerSession();
    await ownerSession(test.email, test.name);

    async function access(email: string, revoked: boolean) {
      return exports.default.fetch(new Request('http://local/api/admin/people/access', {
        method: 'POST',
        headers: { ...owner, 'content-type': 'application/json', origin: env.WEB_ORIGIN },
        body: JSON.stringify({ email, revoked }),
      }));
    }

    const revoke = await access(test.email, true);
    expect(revoke.status).toBe(200);
    await expect(revoke.json()).resolves.toMatchObject({ email: test.email, revoked: true });

    const row = await env.USAGE.prepare('SELECT revoked_at FROM people WHERE email = ?1')
      .bind(test.email).first<{ revoked_at: number | null }>();
    expect(row?.revoked_at).toBeTruthy();

    const admin = await overview(owner);
    expect(admin.people.find((person) => person.email === test.email)?.revoked).toBe(true);

    expect((await access(test.email, false)).status).toBe(200);
    const restored = await env.USAGE.prepare('SELECT revoked_at FROM people WHERE email = ?1')
      .bind(test.email).first<{ revoked_at: number | null }>();
    expect(restored?.revoked_at).toBeNull();
  });

  it('lists a person’s devices and signs one out — the admin’s own included', async () => {
    const owner = await ownerSession();
    const me = { sub: 'dev:rosa@example.com', email: 'rosa@example.com', name: 'Rosa' };
    await signOwnerRefreshToken(me, env, { id: 'phone-of-admin', client: 'ios', label: 'ROSA Air' });
    await signOwnerRefreshToken(me, env, { id: 'mac-of-admin', client: 'mac', label: 'Studio' });

    const list = await exports.default.fetch(new Request(
      'http://local/api/admin/people/devices?email=rosa%40example.com',
      { headers: owner },
    ));
    expect(list.status).toBe(200);
    const before = await list.json<{ email: string; devices: Array<{ device_id: string; label: string | null }> }>();
    expect(before.devices.map((row) => row.device_id).sort()).toEqual(['mac-of-admin', 'phone-of-admin']);

    // Revoking the person is refused for yourself and for a root admin.
    // Signing one of your phones out is neither, and is the whole reason
    // the write exists.
    const revoke = await exports.default.fetch(new Request('http://local/api/admin/devices/revoke', {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({ device_id: 'phone-of-admin' }),
    }));
    expect(revoke.status).toBe(200);
    const after = await revoke.json<{ email: string; devices: Array<{ device_id: string }> }>();
    expect(after.devices.map((row) => row.device_id)).toEqual(['mac-of-admin']);

    const again = await exports.default.fetch(new Request('http://local/api/admin/devices/revoke', {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({ device_id: 'phone-of-admin' }),
    }));
    expect(again.status).toBe(404);
    await expect(again.json()).resolves.toMatchObject({ code: 'device_not_found' });

    const admin = await overview(owner);
    const entry = admin.audit.find((row) => row.action === 'device.revoke' && row.subject === 'rosa@example.com');
    expect(entry?.detail).toBe('ROSA Air');
    await env.USAGE.prepare('DELETE FROM owner_devices WHERE device_id = ?1').bind('mac-of-admin').run();
  });

  it('refuses to let an admin revoke themselves', async () => {
    const owner = await ownerSession();
    const response = await exports.default.fetch(new Request('http://local/api/admin/people/access', {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({ email: 'rosa@example.com', revoked: true }),
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'access_change_refused' });
  });

  it('needs an admin to revoke anyone', async () => {
    await ownerSession(test.email, test.name);
    const member = await ownerSession('cleo@example.com', 'Cleo');
    const response = await exports.default.fetch(new Request('http://local/api/admin/people/access', {
      method: 'POST',
      headers: { ...member, 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({ email: test.email, revoked: true }),
    }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'not_org_admin' });
    await env.USAGE.prepare('DELETE FROM people WHERE email = ?1').bind('cleo@example.com').run();
  });

  it('records a revocation on the trail', async () => {
    const owner = await ownerSession();
    await ownerSession(test.email, test.name);
    await exports.default.fetch(new Request('http://local/api/admin/people/access', {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({ email: test.email, revoked: true }),
    }));
    const admin = await overview(owner);
    expect(admin.audit.some((row) => row.action === 'person.revoke' && row.subject === test.email)).toBe(true);
  });

  it('says what the account is configured to do, without the secret', async () => {
    const admin = await overview(await ownerSession());
    expect(admin.configuration.rooms).toContainEqual({ slug: 'rosa', owner_email: 'rosa@example.com' });
    expect(admin.configuration.livekit_minutes_limit).toBeGreaterThan(0);
    expect(['on', 'off', 'not_configured']).toContain(admin.configuration.crm_sync);
    expect(admin.health.crm_sync).toBe(admin.configuration.crm_sync);

    // The state is reported; the shared secret behind it never is.
    const dumped = JSON.stringify(admin.configuration);
    expect(dumped).not.toContain(String(env.INTERNAL_REQUEST_SECRET || '__unset__'));
  });

  it('cannot demote, revoke, or lock out a root admin', async () => {
    const root = 'rosa@example.com';
    // A second admin, so every refusal below is the root rule and not the
    // last-admin rule wearing its coat.
    const owner = await ownerSession();
    await ownerSession('dana@example.com', 'Dana');
    const promote = await exports.default.fetch(new Request('http://local/api/admin/people/role', {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({ email: 'dana@example.com', role: 'admin' }),
    }));
    expect(promote.status).toBe(200);
    const dana = await ownerSession('dana@example.com', 'Dana');

    async function post(route: string, body: unknown) {
      return exports.default.fetch(new Request(`http://local/api/admin/people/${route}`, {
        method: 'POST',
        headers: { ...dana, 'content-type': 'application/json', origin: env.WEB_ORIGIN },
        body: JSON.stringify(body),
      }));
    }

    const demote = await post('role', { email: root, role: 'member' });
    expect(demote.status).toBe(409);
    await expect(demote.json()).resolves.toMatchObject({ code: 'role_change_refused' });

    const revoke = await post('access', { email: root, revoked: true });
    expect(revoke.status).toBe(409);
    await expect(revoke.json()).resolves.toMatchObject({ code: 'access_change_refused' });

    await env.USAGE.prepare('DELETE FROM people WHERE email = ?1').bind('dana@example.com').run();
  });

  it('keeps a root admin an admin even when the database says otherwise', async () => {
    const root = 'rosa@example.com';
    await ownerSession();

    // The states a bad restore or a mis-typed statement would leave behind.
    await env.USAGE.prepare(
      `UPDATE people SET role = 'member', revoked_at = ?2 WHERE email = ?1`,
    ).bind(root, Date.now()).run();

    try {
      const owner = await ownerSession();
      // Still an admin: the write path answers, so the guard did not consult
      // the columns above.
      const write = await setHidden(owner, root, true);
      expect(write.status).toBe(200);
      await setHidden(owner, root, false);

      const admin = await overview(owner);
      const row = admin.people.find((person) => person.email === root);
      expect(row?.role).toBe('admin');
      expect(row?.root).toBe(true);
      // The column is set, and the surface still refuses to call them cut off.
      expect(row?.revoked).toBe(false);
      expect(admin.viewer.is_admin).toBe(true);
    } finally {
      await env.USAGE.prepare(
        `UPDATE people SET role = 'admin', revoked_at = NULL WHERE email = ?1`,
      ).bind(root).run();
    }
  });

  it('leaves a renamed agent out of the list without deleting its row', async () => {
    // The `factory-www` / `factory-web` case: renaming an agent mints a new
    // sub, so the old spelling keeps its row while AGENT_ROSTER moves on.
    const retired = 'agent-oldname@example.com';
    await env.USAGE.prepare(
      `INSERT INTO people (sub, email, name, first_seen_at, last_seen_at, kind)
       VALUES (?1, ?2, ?3, ?4, ?4, 'agent')
       ON CONFLICT(sub) DO UPDATE SET kind = 'agent'`,
    ).bind('agent-oldname', retired, 'Old Name', Date.now()).run();

    try {
      const admin = await overview(await ownerSession());
      expect(admin.agents.some((row) => row.email === retired)).toBe(false);
      expect(admin.retired_agents).toBeGreaterThan(0);
      // Still in D1, so an old message can still resolve its sender.
      const row = await env.USAGE.prepare('SELECT email FROM people WHERE email = ?1')
        .bind(retired).first<{ email: string }>();
      expect(row?.email).toBe(retired);
    } finally {
      await env.USAGE.prepare('DELETE FROM people WHERE email = ?1').bind(retired).run();
    }
  });

  it('splits agents out of people', async () => {
    const headers = await ownerSession();
    const admin = await overview(headers);
    expect(admin.people.every((row) => row.kind === 'human')).toBe(true);
    expect(admin.agents.every((row) => row.kind === 'agent')).toBe(true);
  });
});
