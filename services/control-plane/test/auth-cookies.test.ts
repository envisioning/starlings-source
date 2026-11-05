import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import { exports } from 'cloudflare:workers';
import {
  logoutResponse,
  REFRESH_GRACE_MS,
  refuseRevokedSignIn,
  resetDeviceCheckCache,
  signLegacyOwnerRefreshToken,
  signOwnerRefreshToken,
  completeGoogleWebAuth,
  startGoogleWebAuth,
} from '../src/auth';
import { redirectWithCookies } from '../src/http-cookies';

// Response.redirect() has immutable headers in workerd; appending set-cookie to
// one throws and used to 500 every cookie-carrying auth redirect. These tests
// pin the by-hand construction.
describe('auth redirects carry cookies', () => {
  it('redirectWithCookies sets location and every cookie', () => {
    const response = redirectWithCookies('https://example.com/next', ['a=1; Path=/', 'b=2; Path=/']);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://example.com/next');
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('login start redirects to Google with the sealed state cookie', async () => {
    const configured = { ...env, GOOGLE_WEB_CLIENT_ID: 'test-web-client-id' } as unknown as Env;
    const response = await startGoogleWebAuth(
      new Request('http://local/api/auth/google/start?return_to=/room/rosa'),
      configured,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin).toBe('https://accounts.google.com');
    expect(location.searchParams.get('client_id')).toBe('test-web-client-id');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    // The chooser is narrowed to Envisioning rather than `*` (any Workspace),
    // so a first sign-in is never offered somebody else's work account.
    expect(location.searchParams.get('hd')).toBe('example.com');
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^meet_oauth=.+; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  });

  // meet#1047: Cancel on Google's page is quiet. Back where sign-in began,
  // no session, the state cookie cleared, and no error page.
  it('a cancelled Google sign-in goes back quietly', async () => {
    const configured = { ...env, GOOGLE_WEB_CLIENT_ID: 'test-web-client-id' } as unknown as Env;
    const start = await startGoogleWebAuth(new Request('http://local/api/auth/google/start?return_to=/room/rosa'), configured);
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const sealed = (start.headers.getSetCookie()[0] ?? '').split(';')[0] ?? '';
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const response = await completeGoogleWebAuth(
      new Request(`http://local/api/auth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`, { headers: { cookie: sealed } }),
      configured,
      ctx,
    );
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location') ?? '').pathname).toBe('/room/rosa');
    expect(response.headers.getSetCookie()).toEqual([expect.stringMatching(/^meet_oauth=; Max-Age=0/)]);
  });

  it('logout clears the session cookie', () => {
    const response = logoutResponse(env as Env);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(env.WEB_ORIGIN);
    expect(response.headers.getSetCookie()).toEqual(['meet_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax']);
  });
});

describe('Native sessions renew without a new Google sign-in', () => {
  async function nativeSession() {
    const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }));
    return response.json<{ access_token: string }>();
  }

  function renew(body: Record<string, unknown>) {
    return exports.default.fetch(new Request('http://local/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  function renewWithClientVersion(body: Record<string, unknown>, clientVersion: string) {
    return exports.default.fetch(new Request('http://local/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-meet-client': clientVersion },
      body: JSON.stringify(body),
    }));
  }

  type Renewed = { access_token: string; refresh_token: string; owner: { email: string } };

  /** A pre-migration token minted after the slot was retired: legacy shape, slot untouched. */
  async function signLegacyOwnerRefreshTokenWithoutSlot(owner: { sub: string; email: string; name: string }) {
    const slot = await env.USAGE.prepare('SELECT refresh_jti FROM people WHERE sub = ?1')
      .bind(owner.sub).first<{ refresh_jti: string | null }>();
    const token = await signLegacyOwnerRefreshToken(owner, env);
    await env.USAGE.prepare('UPDATE people SET refresh_jti = ?2 WHERE sub = ?1')
      .bind(owner.sub, slot?.refresh_jti ?? null).run();
    return token;
  }

  it('mints a fresh pair, rotates the refresh token, and keeps the same owner', async () => {
    // `/api/dev/session` is the development stand-in for the Google exchange,
    // so build the refresh token the way the exchange would.
    const owner = { sub: 'dev:rosa@example.com', email: 'rosa@example.com', name: 'Rosa' };
    const refresh = await signOwnerRefreshToken(owner, env, { id: 'phone-rotates', client: 'ios' });

    const response = await renew({ refresh_token: refresh, client: 'ios' });
    expect(response.status).toBe(200);
    const renewed = await response.json<Renewed>();
    expect(renewed.owner.email).toBe('rosa@example.com');
    // Rotation: a stolen refresh token is good until the device next renews,
    // not for its whole 60 days.
    expect(renewed.refresh_token).not.toBe(refresh);

    const claims = decodeJwt(renewed.access_token);
    expect(claims.aud).toBe('meet-owner');
    expect(claims.sub).toBe(owner.sub);
    // The pair stays bound to the device that spent it.
    expect(decodeJwt(renewed.refresh_token).device).toBe('phone-rotates');

    // Single use, after the grace window: the token just spent is refused
    // once the rotation is older than REFRESH_GRACE_MS, so a stolen one dies
    // an hour after the device's next renewal rather than living out its 60
    // days.
    await env.USAGE.prepare('UPDATE owner_devices SET rotated_at = ?2 WHERE device_id = ?1')
      .bind('phone-rotates', Date.now() - REFRESH_GRACE_MS - 1).run();
    const replay = await renew({ refresh_token: refresh });
    expect(replay.status).toBe(401);
  });

  it('records a valid client version on refresh and ignores a malformed header', async () => {
    const owner = { sub: 'dev:versioned@example.com', email: 'versioned@example.com', name: 'Versioned' };
    const refresh = await signOwnerRefreshToken(owner, env, { id: 'versioned-device', client: 'ios' });
    const response = await renewWithClientVersion(
      { refresh_token: refresh, client: 'ios' },
      'ios/4.7.2 (812)',
    );
    expect(response.status).toBe(200);
    const device = await env.USAGE.prepare(
      'SELECT platform, app_version, version_seen_at FROM owner_devices WHERE device_id = ?1',
    ).bind('versioned-device').first<{ platform: string | null; app_version: string | null; version_seen_at: number | null }>();
    expect(device?.platform).toBe('ios');
    expect(device?.app_version).toBe('4.7.2 (812)');
    expect(device?.version_seen_at).toEqual(expect.any(Number));

    const secondOwner = { sub: 'dev:bad-version@example.com', email: 'bad-version@example.com', name: 'Bad Version' };
    const malformedRefresh = await signOwnerRefreshToken(secondOwner, env, { id: 'bad-version-device', client: 'ios' });
    expect((await renewWithClientVersion(
      { refresh_token: malformedRefresh, client: 'ios' },
      'ios/not-a-version (build)',
    )).status).toBe(200);
    const malformedDevice = await env.USAGE.prepare(
      'SELECT platform, app_version, version_seen_at FROM owner_devices WHERE device_id = ?1',
    ).bind('bad-version-device').first<{ platform: string | null; app_version: string | null; version_seen_at: number | null }>();
    expect(malformedDevice).toEqual({ platform: null, app_version: null, version_seen_at: null });
  });

  it('does not record version metadata on a normal authenticated API request', async () => {
    const owner = { sub: 'dev:other-route@example.com', email: 'other-route@example.com', name: 'Other Route' };
    const refresh = await signOwnerRefreshToken(owner, env, { id: 'other-route-device', client: 'ios' });
    const renewed = await (await renew({ refresh_token: refresh, client: 'ios' })).json<Renewed>();
    await env.USAGE.prepare(
      'UPDATE owner_devices SET platform = NULL, app_version = NULL, version_seen_at = NULL WHERE device_id = ?1',
    ).bind('other-route-device').run();

    const response = await exports.default.fetch(new Request('http://local/api/auth/devices', {
      headers: {
        authorization: `Bearer ${renewed.access_token}`,
        'x-meet-client': 'ios/4.7.2 (812)',
      },
    }));
    expect(response.status).toBe(200);
    const device = await env.USAGE.prepare(
      'SELECT platform, app_version, version_seen_at FROM owner_devices WHERE device_id = ?1',
    ).bind('other-route-device').first<{ platform: string | null; app_version: string | null; version_seen_at: number | null }>();
    expect(device).toEqual({ platform: null, app_version: null, version_seen_at: null });
  });

  it('honours the token a lost response left behind, once, inside the grace window', async () => {
    // The Worker rotated, the response never reached the phone, and the phone
    // still holds the token it just spent. That renewal is a network blip,
    // not a replay.
    const owner = { sub: 'dev:lost@example.com', email: 'lost@example.com', name: 'Lost Reply' };
    const held = await signOwnerRefreshToken(owner, env, { id: 'phone-of-lost', client: 'ios' });
    const unreceived = await renew({ refresh_token: held, client: 'ios' });
    expect(unreceived.status).toBe(200);

    const retry = await renew({ refresh_token: held, client: 'ios' });
    expect(retry.status).toBe(200);
    const pair = await retry.json<Renewed>();
    expect(pair.refresh_token).not.toBe(held);

    // The retired token bought one pair. A second use is a replay.
    expect((await renew({ refresh_token: held, client: 'ios' })).status).toBe(401);
    // The pair the device did receive renews as normal.
    expect((await renew({ refresh_token: pair.refresh_token, client: 'ios' })).status).toBe(200);
  });

  it('lets two devices of one owner renew without spending each other', async () => {
    // The bug this table exists for: rotation used to be per person, so a Mac
    // sign-in every morning signed the phone out.
    const owner = { sub: 'dev:two@example.com', email: 'two@example.com', name: 'Two Devices' };
    const phone = await signOwnerRefreshToken(owner, env, { id: 'phone-of-two', client: 'ios' });
    const mac = await signOwnerRefreshToken(owner, env, { id: 'mac-of-two', client: 'mac' });

    // The Mac renews twice — a morning and an afternoon.
    const macFirst = await renew({ refresh_token: mac, client: 'mac' });
    expect(macFirst.status).toBe(200);
    const macSecond = await renew({ refresh_token: (await macFirst.json<Renewed>()).refresh_token, client: 'mac' });
    expect(macSecond.status).toBe(200);

    // The phone's token is untouched by any of that.
    const phoneRenewal = await renew({ refresh_token: phone, client: 'ios' });
    expect(phoneRenewal.status).toBe(200);
    // And the phone renewing did not spend the Mac's newest token either.
    const macThird = await renew({ refresh_token: (await macSecond.json<Renewed>()).refresh_token, client: 'mac' });
    expect(macThird.status).toBe(200);
  });

  it('signing in again on one device leaves the other signed in', async () => {
    const owner = { sub: 'dev:again@example.com', email: 'again@example.com', name: 'Again' };
    const phone = await signOwnerRefreshToken(owner, env, { id: 'phone-of-again', client: 'ios' });
    // A fresh Google sign-in on the same Mac mints a new token for that device.
    await signOwnerRefreshToken(owner, env, { id: 'mac-of-again', client: 'mac' });
    await signOwnerRefreshToken(owner, env, { id: 'mac-of-again', client: 'mac' });

    expect((await renew({ refresh_token: phone, client: 'ios' })).status).toBe(200);
  });

  it('refuses a device token whose row names somebody else', async () => {
    const one = { sub: 'dev:one@example.com', email: 'one@example.com', name: 'One' };
    const other = { sub: 'dev:other@example.com', email: 'other@example.com', name: 'Other' };
    const token = await signOwnerRefreshToken(one, env, { id: 'shared-device-id', client: 'ios' });
    // The same device id is then claimed by another person's sign-in.
    await signOwnerRefreshToken(other, env, { id: 'shared-device-id', client: 'ios' });

    expect((await renew({ refresh_token: token, client: 'ios' })).status).toBe(401);
  });

  it('converts a token from before per-device rotation, once', async () => {
    const owner = { sub: 'dev:legacy@example.com', email: 'legacy@example.com', name: 'Legacy' };
    const legacy = await signLegacyOwnerRefreshToken(owner, env);
    expect(decodeJwt(legacy).device).toBeUndefined();

    const response = await renew({ refresh_token: legacy, client: 'ios', device_id: 'legacy-phone' });
    expect(response.status).toBe(200);
    const renewed = await response.json<Renewed>();
    // The client's own device id is honoured when it sends one.
    expect(decodeJwt(renewed.refresh_token).device).toBe('legacy-phone');

    // From here on it rotates per device like any other.
    expect((await renew({ refresh_token: renewed.refresh_token, client: 'ios' })).status).toBe(200);
    // The legacy token is spent, and so is every other pre-migration token
    // this person holds: the person-wide slot is retired, not rotated.
    expect((await renew({ refresh_token: legacy, client: 'ios' })).status).toBe(401);
    const second = await signLegacyOwnerRefreshTokenWithoutSlot(owner);
    expect((await renew({ refresh_token: second, client: 'ios' })).status).toBe(401);
  });

  it('refuses an access token spent as a refresh token', async () => {
    const session = await nativeSession();
    const response = await renew({ refresh_token: session.access_token });
    // Different audience, so the two can never be interchanged.
    expect(response.status).toBe(401);
  });

  it('refuses to renew somebody who has been revoked', async () => {
    const owner = { sub: 'dev:gone@example.com', email: 'gone@example.com', name: 'Gone' };
    const refresh = await signOwnerRefreshToken(owner, env, { id: 'device-of-gone', client: 'ios' });
    await env.USAGE.prepare(
      `INSERT INTO people (sub, email, name, first_seen_at, last_seen_at, revoked_at)
       VALUES (?1, ?2, ?3, 1, 1, 2)
       ON CONFLICT(sub) DO UPDATE SET revoked_at = 2`,
    ).bind(owner.sub, owner.email, owner.name).run();

    const response = await renew({ refresh_token: refresh });
    // The whole point of the column: leaving Envisioning ends access at the
    // next renewal, not at the end of a 60-day window.
    expect(response.status).toBe(403);
  });
});

// meet#638: the web callback and the native exchange both reach this through
// `exchangeGoogleCode`, before a session or a device row is written.
describe('A revoked person cannot sign in again with Google', () => {
  async function person(sub: string, email: string, revokedAt: number | null) {
    await env.USAGE.prepare(
      `INSERT INTO people (sub, email, name, first_seen_at, last_seen_at, revoked_at)
       VALUES (?1, ?2, 'Test', 1, 1, ?3)
       ON CONFLICT(sub) DO UPDATE SET revoked_at = excluded.revoked_at`,
    ).bind(sub, email, revokedAt).run();
    return { sub, email };
  }

  it('refuses a revoked person with 403 oauth_failed, as renewal does', async () => {
    const owner = await person('google:revoked-signin', 'left@example.com', 2);
    await expect(refuseRevokedSignIn(env, owner)).rejects.toMatchObject({ status: 403, code: 'oauth_failed' });
  });

  it('admits a member and a first sign-in', async () => {
    const member = await person('google:member-signin', 'stays@example.com', null);
    await expect(refuseRevokedSignIn(env, member)).resolves.toBeUndefined();
    await expect(refuseRevokedSignIn(env, { sub: 'google:never-seen', email: 'new@example.com' }))
      .resolves.toBeUndefined();
  });

  const broken = { ...env, USAGE: { prepare: () => { throw new Error('D1 down'); } } } as unknown as Env;

  it('refuses when the people table cannot be read', async () => {
    await expect(refuseRevokedSignIn(broken, { sub: 'google:any', email: 'any@example.com' }))
      .rejects.toMatchObject({ status: 401 });
  });

  it('never locks out a root admin: the column is not even read', async () => {
    await expect(refuseRevokedSignIn(broken, { sub: 'google:root', email: 'rosa@example.com' }))
      .resolves.toBeUndefined();
  });
});

describe('A signed-out device stops at its next request, not at its next renewal', () => {
  function renew(body: Record<string, unknown>) {
    return exports.default.fetch(new Request('http://local/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  type Renewed = { access_token: string; refresh_token: string };
  type Devices = { devices: Array<{ device_id: string; client: string; label: string | null; current: boolean }> };

  function devices(access: string) {
    return exports.default.fetch(new Request('http://local/api/auth/devices', {
      headers: { authorization: `Bearer ${access}` },
    }));
  }

  function revoke(access: string, deviceID: string) {
    return exports.default.fetch(new Request('http://local/api/auth/devices/revoke', {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ device_id: deviceID }),
    }));
  }

  it('lists the person’s devices with their labels, and marks the one asking', async () => {
    const owner = { sub: 'dev:lister@example.com', email: 'lister@example.com', name: 'Lister' };
    const phone = await signOwnerRefreshToken(owner, env, { id: 'phone-of-lister', client: 'ios' });
    await signOwnerRefreshToken(owner, env, { id: 'mac-of-lister', client: 'mac', label: 'Studio' });

    // The label arrives with the renewal, so a row from before the field
    // is named the first time its build renews.
    const renewed = await (await renew({ refresh_token: phone, client: 'ios', device_name: 'ROSA Air' })).json<Renewed>();
    const list = await (await devices(renewed.access_token)).json<Devices>();
    expect(list.devices.map((row) => [row.device_id, row.client, row.label, row.current])).toEqual([
      ['phone-of-lister', 'ios', 'ROSA Air', true],
      ['mac-of-lister', 'mac', 'Studio', false],
    ]);
  });

  it('refuses the access token of a device whose row is gone', async () => {
    const owner = { sub: 'dev:lostphone@example.com', email: 'lostphone@example.com', name: 'Lost' };
    const phone = await signOwnerRefreshToken(owner, env, { id: 'phone-of-lost-2', client: 'ios' });
    const mac = await signOwnerRefreshToken(owner, env, { id: 'mac-of-lost-2', client: 'mac' });
    const phonePair = await (await renew({ refresh_token: phone, client: 'ios' })).json<Renewed>();
    const macPair = await (await renew({ refresh_token: mac, client: 'mac' })).json<Renewed>();
    expect((await devices(phonePair.access_token)).status).toBe(200);

    // From the Mac: sign the phone out.
    const after = await revoke(macPair.access_token, 'phone-of-lost-2');
    expect(after.status).toBe(200);
    expect((await after.json<Devices>()).devices.map((row) => row.device_id)).toEqual(['mac-of-lost-2']);

    // The phone's 8h access token dies now — the whole point — and so does
    // its refresh token. The Mac is untouched.
    resetDeviceCheckCache();
    expect((await devices(phonePair.access_token)).status).toBe(401);
    expect((await renew({ refresh_token: phonePair.refresh_token, client: 'ios' })).status).toBe(401);
    expect((await devices(macPair.access_token)).status).toBe(200);
  });

  it('only drops the caller’s own devices', async () => {
    const one = { sub: 'dev:own1@example.com', email: 'own1@example.com', name: 'Own One' };
    const two = { sub: 'dev:own2@example.com', email: 'own2@example.com', name: 'Own Two' };
    const oneToken = await signOwnerRefreshToken(one, env, { id: 'mac-of-own1', client: 'mac' });
    await signOwnerRefreshToken(two, env, { id: 'mac-of-own2', client: 'mac' });
    const pair = await (await renew({ refresh_token: oneToken, client: 'mac' })).json<Renewed>();

    expect((await revoke(pair.access_token, 'mac-of-own2')).status).toBe(200);
    const row = await env.USAGE.prepare('SELECT device_id FROM owner_devices WHERE device_id = ?1')
      .bind('mac-of-own2').first();
    expect(row).toBeTruthy();
  });

  it('leaves a web session alone: no device claim, no device check', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }));
    const { access_token } = await response.json<{ access_token: string }>();
    expect(decodeJwt(access_token).device).toBeUndefined();
    expect((await devices(access_token)).status).toBe(200);
  });
});
