// Central sign-in across two Workers (docs/CENTRAL_AUTH.md, meet#812, meet#813,
// meet#847, meet#879).
//
// The workspace side runs as the `meet` Worker does. The auth Worker runs as
// its real `AuthService` entrypoint against its own D1 (`AUTH_DB`), with the
// `ctx.props` a service binding would carry. The fake `AUTH` binding copies
// every argument and answer, the way RPC does.
import { env, exports } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  CENTRAL_AUTH_COMPLETE_PATHS,
  CENTRAL_AUTH_START_PATH,
  EMAIL_LINK_REQUEST_PATH,
  type BrowserAuthKind,
  type CentralAuthResult,
} from '@starlings/contracts/browser-auth';
import { isWorkspaceHostOrigin } from '@starlings/contracts/workspace-slug';
import { REDEEM_MS, beginAttempt, caller, claimAttempt, finishAttempt, redeemAttempt } from '../src/auth-worker/attempts';
import type { AuthEnv } from '../src/auth-worker/env';
import { handleAuthFetch } from '../src/auth-worker/google';
import { AuthService } from '../src/auth-worker/index';
import { signInScreenHTML } from '../src/auth-worker/screen';
import { completeCentralWebAuth, listOwnerDevices, signOwnerSession, startGoogleWebAuth } from '../src/auth';
import { startWebCalendarConnect } from '../src/calendar';
import { randomToken, sha256 } from '../src/crypto';
import { finishNativeSignIn, redeemNativeSignIn, startNativeSignIn } from '../src/native-sign-in';
import {
  ANDROID_NATIVE_SIGN_IN_CALLBACK, LEGACY_NATIVE_SIGN_IN_CALLBACK, nativeAppId, NATIVE_SIGN_IN_CALLBACK, NATIVE_SIGN_IN_FINISH_PATH, NATIVE_SIGN_IN_HTTPS_PATH, nativeSignInHttpsCallback,
} from '@starlings/contracts';
import { beginCentralAuth, centralConsent, redeemCentralAuth, usesCentralAuth } from '../src/central-auth';
import { startGoogleGrant } from '../src/google-grants';
import { safeReturnPath } from '../src/http-cookies';

const hq = 'https://hq.starlings.example';
const firm = 'https://firm-two.starlings.example';
const auth = 'https://auth.starlings.example';
const authDB = (env as unknown as { AUTH_DB: D1Database }).AUTH_DB;
const authEnv: AuthEnv = {
  AUTH_DB: authDB,
  ENVIRONMENT: 'development',
  AUTH_ORIGIN: auth,
  RETURN_ORIGIN_ALIASES: 'https://meet.example.com',
  GOOGLE_WEB_CLIENT_ID: 'test-web',
  GOOGLE_CONNECTOR_CLIENT_ID: 'test-connector',
  AUTH_SIGNING_SECRET: 'auth-test-signing-secret-with-at-least-32-characters',
  GOOGLE_WEB_CLIENT_SECRET: 'test-web-secret',
  MAIL_FROM: 'Starlings <hello@starlings.example>',
  OPS_ALERT_EMAIL: 'ops@example.net',
  SIGNUP_ORIGIN: 'https://site.example',
  OPS_ORIGIN: 'https://ops.starlings.example',
};

/**
 * What a workspace's `AUTH` binding is: the real entrypoint with the props
 * the account owner set in wrangler.jsonc. RPC copies arguments and answers;
 * so does this.
 */
function bindingFor(props: unknown) {
  const service = new AuthService({ props } as unknown as ExecutionContext, authEnv);
  return {
    begin: async (input: unknown) => structuredClone(await service.begin(structuredClone(input))),
    redeem: async (input: unknown) => structuredClone(await service.redeem(structuredClone(input))),
  };
}

const google = { GOOGLE_WEB_CLIENT_ID: 'test-web', GOOGLE_CONNECTOR_CLIENT_ID: 'test-connector', GOOGLE_CONNECTOR_CLIENT_SECRET: 'test-secret' };
function workspaceEnv(origin: string, extra: Record<string, unknown> = {}): Env {
  return {
    ...env, ...google, AUTH_ORIGIN: auth, AUTH: bindingFor({ origin }), WEB_ORIGIN: origin, PUBLIC_API_ORIGIN: origin,
    WORKSPACE_ORIGIN_ALIASES: '', WORKSPACE_NAME: 'HQ', ...extra,
  } as unknown as Env;
}
/** hq: its binding's props name hq. */
const hqEnv = workspaceEnv(hq);
/** A second workspace, with its own binding. */
const firmEnv = workspaceEnv(firm, { WORKSPACE_NAME: 'Firm Two' });
const owner = { sub: 'central-person', email: 'central-person@example.com', name: 'Person' };
const identity: CentralAuthResult = { ...owner, kind: 'login', hd: 'example.com' };
const cookieHeader = (response: Response) => response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
const ticketOf = (response: Response) => new URL(response.headers.get('location')!).searchParams.get('ticket')!;
/** The screen's button, as a browser posts it. */
const continueRequest = (ticket: string, origin: string | null = auth) => new Request(`${auth}${CENTRAL_AUTH_START_PATH}`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) },
  body: new URLSearchParams({ ticket }),
});
/** A valid begin input, as a workspace sends it. */
const beginInput = {
  v: 1, kind: 'login', returnPath: '/', browserHash: 'b'.repeat(43), ownerSub: null, product: null, loginHint: null,
  workspaceName: null, markPath: null, hostedDomain: null,
} as const;

/** A finished attempt, ready to redeem on the workspace. */
async function attempt(kind: BrowserAuthKind = 'login', options: { result?: CentralAuthResult; origin?: string; env?: Env } = {}) {
  const origin = options.origin ?? hq;
  const workspace = options.env ?? hqEnv;
  const started = await beginCentralAuth(new Request(`${origin}/start`), workspace, kind, {
    returnTo: '/work',
    ...(kind === 'login' ? {} : { owner }),
    ...(kind === 'google-grant' ? { product: 'gmail' as const } : {}),
  });
  const ticket = ticketOf(started);
  expect(await claimAttempt(authEnv, ticket)).not.toBeNull();
  const code = await finishAttempt(authEnv, ticket, options.result ?? (kind === 'login' ? identity : { kind: 'cancelled' }));
  const complete = new URL(CENTRAL_AUTH_COMPLETE_PATHS[kind], origin);
  complete.searchParams.set('ticket', ticket);
  complete.searchParams.set('code', code!);
  return { started, ticket, request: new Request(complete, { headers: { cookie: cookieHeader(started) } }) };
}

describe('central sign-in: the workspace starts on the auth host', () => {
  it('sends sign-in, Calendar and connector consent through auth.starlings.example with only a ticket in the URL', async () => {
    const request = new Request(`${hq}/api/auth/google/start?return_to=/calendar`);
    const responses = [
      await startGoogleWebAuth(request, hqEnv),
      await startWebCalendarConnect(request, hqEnv, owner),
      await startGoogleGrant(hqEnv, owner, { product: 'gmail', return_to: '/settings' }, request),
    ];
    for (const response of responses) {
      const location = new URL(response.headers.get('location')!);
      expect(location.origin + location.pathname).toBe(`${auth}${CENTRAL_AUTH_START_PATH}`);
      expect([...location.searchParams.keys()]).toEqual(['ticket']);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const cookies = response.headers.getSetCookie().join('\n');
      expect(cookies).toMatch(/^__Host-meet_auth_bridge_/u);
      expect(cookies).not.toContain('Domain=');
      expect(cookies).toContain('Path=/; HttpOnly; Secure; SameSite=Lax');
      expect(cookies).not.toContain('meet_session');
    }
  });

  it('keeps every origin but WEB_ORIGIN on the direct flow, and a workspace without AUTH_ORIGIN', async () => {
    const withAlias = workspaceEnv(hq, { WORKSPACE_ORIGIN_ALIASES: 'https://hq.example.com' });
    expect(usesCentralAuth(new Request(`${hq}/`), withAlias)).toBe(true);
    expect(usesCentralAuth(new Request('https://hq.example.com/'), withAlias)).toBe(false);
    const alias = await startGoogleWebAuth(new Request('https://hq.example.com/api/auth/google/start'), withAlias);
    expect(new URL(alias.headers.get('location')!).origin).toBe('https://accounts.google.com');
    const plain = { ...hqEnv, AUTH_ORIGIN: undefined, AUTH: undefined } as unknown as Env;
    expect(usesCentralAuth(new Request(`${hq}/`), plain)).toBe(false);
    const direct = await startGoogleWebAuth(new Request(`${hq}/api/auth/google/start`), plain);
    expect(new URL(direct.headers.get('location')!).origin).toBe('https://accounts.google.com');
  });

  it('fails closed without the binding', async () => {
    const unbound = { ...hqEnv, AUTH: undefined } as unknown as Env;
    await expect(startGoogleWebAuth(new Request(`${hq}/api/auth/google/start`), unbound)).rejects.toThrow('not configured');
  });
});

describe('central sign-in: the screen on the auth host (meet#879)', () => {
  it('shows the workspace and one button on GET, and goes to Google only on the POST', async () => {
    const started = await startGoogleWebAuth(new Request(`${hq}/api/auth/google/start?return_to=/work`), hqEnv);
    const ticket = ticketOf(started);
    const screen = await handleAuthFetch(new Request(started.headers.get('location')!), authEnv);
    expect(screen.status).toBe(200);
    expect(screen.headers.get('location')).toBeNull();
    expect(screen.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(screen.headers.get('cache-control')).toBe('no-store');
    expect(screen.headers.get('x-frame-options')).toBe('DENY');
    // no-referrer made Chrome send `Origin: null` on the button's POST (2026-10-04).
    expect(screen.headers.get('referrer-policy')).toBe('same-origin');
    expect(screen.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(screen.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(screen.headers.getSetCookie()).toEqual([]);
    const html = await screen.text();
    expect(html).toContain('<h1>Sign in to HQ</h1>');
    // No eyebrow (meet#1027); the address sits small under the name (meet#1032).
    expect(html).not.toContain('class="brand"');
    expect(html).toContain('<p class="host">hq.starlings.example</p>');
    expect(html).toContain('<span class="g" aria-hidden="true">');
    expect(html).toContain(`<form method="post" action="${CENTRAL_AUTH_START_PATH}">`);
    expect(html).toContain(`name="ticket" value="${ticket}"`);
    expect(html.match(/<button/gu)).toHaveLength(2);
    expect(html).toContain('>Continue with Google</button>');
    // The email link posts to the workspace, which decides and mails (email-sign-in.ts).
    expect(html).toContain(`<form class="email" method="post" action="${hq}${EMAIL_LINK_REQUEST_PATH}">`);
    expect(html).toContain('>Email me a sign-in link</button>');
    expect(screen.headers.get('content-security-policy')).toContain(`form-action 'self' https://accounts.google.com ${hq}`);
    expect(html).not.toContain('accounts.google.com');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('—');

    // A GET changes nothing: a second one shows the same screen.
    expect((await handleAuthFetch(new Request(started.headers.get('location')!), authEnv)).status).toBe(200);
    // The POST needs this host's own Origin.
    expect((await handleAuthFetch(continueRequest(ticket, null), authEnv)).status).toBe(403);
    expect((await handleAuthFetch(continueRequest(ticket, 'https://evil.example'), authEnv)).status).toBe(403);
    expect((await handleAuthFetch(continueRequest(ticket, hq), authEnv)).status).toBe(403);

    const toGoogle = await handleAuthFetch(continueRequest(ticket), authEnv);
    expect(toGoogle.status).toBe(303);
    const googleURL = new URL(toGoogle.headers.get('location')!);
    expect(googleURL.origin).toBe('https://accounts.google.com');
    expect(googleURL.searchParams.get('redirect_uri')).toBe(`${auth}/api/auth/google/callback`);
    expect(googleURL.searchParams.get('client_id')).toBe('test-web');
    expect(googleURL.searchParams.get('code_challenge_method')).toBe('S256');
    expect(googleURL.searchParams.get('hd')).toBe('example.com');
    expect(toGoogle.headers.getSetCookie().join('')).toMatch(/^__Host-starlings_auth_oauth_/u);
    expect(toGoogle.headers.getSetCookie().join('')).not.toContain('meet_session');
    // A ticket starts Google once, and the screen is gone after it.
    expect((await handleAuthFetch(continueRequest(ticket), authEnv)).status).toBe(400);
    expect((await handleAuthFetch(new Request(started.headers.get('location')!), authEnv)).status).toBe(400);
  });

  it('draws the mark from the workspace origin, escapes the name, and draws a plain heading without them', () => {
    const html = signInScreenHTML({ ticket: 't'.repeat(32), workspaceOrigin: hq, workspaceName: '<b>"HQ"</b>', markPath: '/workspace-mark?v=abc' });
    // One colour, the outline in the ink (MZ, 2026-10-05).
    expect(html).toContain(`mask:url('${hq}/workspace-mark?v=abc') center/contain no-repeat`);
    expect(html).toContain('<h1>Sign in to &lt;b&gt;&quot;HQ&quot;&lt;/b&gt;</h1>');
    expect(html).not.toContain('<b>');
    const bare = signInScreenHTML({ ticket: 't'.repeat(32), workspaceOrigin: hq, workspaceName: null, markPath: null });
    expect(bare).toContain('<h1>Sign in</h1>');
    expect(bare).not.toContain('<img');
    expect(bare).toContain('>Continue with Google</button>');
  });

  it('sends consent to Google at once: the member already chose Connect', async () => {
    const started = await startWebCalendarConnect(new Request(`${hq}/api/calendar/connect/start`), hqEnv, owner);
    const toGoogle = await handleAuthFetch(new Request(started.headers.get('location')!), authEnv);
    expect(toGoogle.status).toBe(303);
    expect(new URL(toGoogle.headers.get('location')!).searchParams.get('redirect_uri')).toBe(`${auth}/api/auth/calendar/callback`);
  });

  it('refuses a forged mark path at begin', async () => {
    const service = bindingFor({ origin: hq });
    for (const markPath of ['//evil.example/x.png', 'https://evil.example/x.png', '/\\evil.example', '/a b']) {
      expect(await service.begin({ ...beginInput, markPath })).toEqual({ ok: false, reason: 'invalid_request' });
    }
    expect((await service.begin({ ...beginInput, markPath: '/workspace-mark?v=abc' })).ok).toBe(true);
  });
});

describe('central sign-in: the origin comes from the binding (meet#847)', () => {
  it('reads the origin only from props, and only an origin this Worker serves', () => {
    for (const props of [undefined, null, {}, { origin: '' }, { origin: 42 }, { origin: hq, extra: true }, 'https://hq.starlings.example']) {
      expect(caller(props, authEnv)).toBeNull();
    }
    for (const origin of [auth, 'https://www.starlings.example', 'https://xn--bcher-kva.starlings.example', 'https://HQ.starlings.example',
      'http://hq.starlings.example', 'https://hq.starlings.example:8443', 'https://hq.starlings.example/', 'https://a.b.starlings.example',
      'https://hq.starlings.example.evil.example', 'https://evil.example', 'https://legacy.org.example']) {
      expect(caller({ origin }, authEnv)).toBeNull();
    }
    for (const origin of [hq, firm, 'https://envisioning.starlings.example', 'https://meet.example.com']) {
      expect(caller({ origin }, authEnv)?.origin).toBe(origin);
    }
    expect(isWorkspaceHostOrigin(auth)).toBe(false);
  });

  it('refuses a begin from a binding without the fixed origin', async () => {
    for (const props of [undefined, {}, { origin: 'https://evil.example' }]) {
      expect(await bindingFor(props).begin(beginInput)).toEqual({ ok: false, reason: 'origin_refused' });
    }
    expect(await beginAttempt(authEnv, null, beginInput)).toEqual({ ok: false, reason: 'origin_refused' });
    const unfixed = workspaceEnv(hq, { AUTH: bindingFor({}) });
    await expect(startGoogleWebAuth(new Request(`${hq}/api/auth/google/start`), unfixed)).rejects.toThrow('does not serve');
  });

  it('refuses a caller that names an origin of its own, and binds the attempt to the props origin', async () => {
    const service = bindingFor({ origin: hq });
    expect(await service.begin({ ...beginInput, workspaceOrigin: firm })).toEqual({ ok: false, reason: 'invalid_request' });
    const begun = await service.begin(beginInput);
    expect(begun.ok).toBe(true);
    const row = await authDB.prepare('SELECT workspace_origin FROM sign_in_attempts WHERE ticket = ?1')
      .bind((begun as { ticket: string }).ticket).first<{ workspace_origin: string }>();
    expect(row!.workspace_origin).toBe(hq);
    expect(await service.redeem({ v: 1, kind: 'login', workspaceOrigin: hq, ticket: 't'.repeat(32), code: 'c'.repeat(43), browserHash: 'b'.repeat(43), ownerSub: null }))
      .toEqual({ ok: false, reason: 'invalid_request' });
    expect(await redeemAttempt(authEnv, null, { v: 1, kind: 'login', ticket: 't'.repeat(32), code: 'c'.repeat(43), browserHash: 'b'.repeat(43), ownerSub: null }))
      .toEqual({ ok: false, reason: 'invalid_request' });
    // Return paths and versions are still checked.
    expect(await service.begin({ ...beginInput, returnPath: '//evil.example' })).toEqual({ ok: false, reason: 'invalid_request' });
    expect(await service.begin({ ...beginInput, kind: 'calendar' })).toEqual({ ok: false, reason: 'invalid_request' });
    expect(await service.begin({ ...beginInput, v: 2 })).toEqual({ ok: false, reason: 'invalid_request' });
  });

  it('refuses a code issued to hq when another workspace redeems it, with the same browser and the same ticket', async () => {
    const a = await attempt('login');
    // The browser is carried to firm-two with hq's code and cookie; firm-two's binding names firm-two.
    const onFirm = new Request(a.request.url.replace(hq, firm), a.request);
    await expect(redeemCentralAuth(onFirm, firmEnv, 'login')).rejects.toThrow('already used');
    // A firm Worker calling the auth Worker straight, with every secret, gets nothing either.
    const query = new URL(a.request.url).searchParams;
    const browserHash = await sha256(decodeURIComponent(a.request.headers.get('cookie')!.split('=')[1]!));
    const stolen = { v: 1, kind: 'login', ticket: query.get('ticket'), code: query.get('code'), browserHash, ownerSub: null };
    expect(await bindingFor({ origin: firm }).redeem(stolen)).toEqual({ ok: false, reason: 'expired_or_used' });
    // Nothing was spent: hq still redeems.
    const redeemed = await redeemCentralAuth(a.request, hqEnv, 'login');
    expect(redeemed.result.kind).toBe('login');
  });
});

describe('central sign-in: the workspace redeems over the binding', () => {
  it('redeems exactly once under concurrency; the identity is sealed at rest and never in a URL', async () => {
    const a = await attempt();
    const row = await authDB.prepare('SELECT * FROM sign_in_attempts WHERE ticket = ?1').bind(a.ticket).first<Record<string, string>>();
    expect(row!.result_ciphertext).not.toContain(owner.email);
    expect(JSON.stringify(row)).not.toContain(owner.email);
    expect(a.request.url).not.toContain(owner.email);
    const outcomes = await Promise.allSettled([redeemCentralAuth(a.request, hqEnv, 'login'), redeemCentralAuth(a.request, hqEnv, 'login')]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    await expect(redeemCentralAuth(a.request, hqEnv, 'login')).rejects.toThrow('already used');
  });

  it('refuses another browser, purpose, code or owner without spending the code', async () => {
    const a = await attempt('calendar');
    await expect(redeemCentralAuth(new Request(a.request.url), hqEnv, 'calendar', owner.sub)).rejects.toThrow('browser that started it');
    await expect(redeemCentralAuth(a.request, hqEnv, 'login')).rejects.toThrow('already used');
    await expect(redeemCentralAuth(a.request, hqEnv, 'calendar', 'someone-else')).rejects.toThrow('already used');
    const wrongCode = new URL(a.request.url);
    wrongCode.searchParams.set('code', 'x'.repeat(43));
    await expect(redeemCentralAuth(new Request(wrongCode, a.request), hqEnv, 'calendar', owner.sub)).rejects.toThrow('already used');
    const redeemed = await redeemCentralAuth(a.request, hqEnv, 'calendar', owner.sub);
    expect(redeemed.result.kind).toBe('cancelled');
    expect(redeemed.redirect().headers.get('location')).toBe(`${hq}/work`);
  });

  it('gives a finished attempt sixty seconds, then refuses it', async () => {
    const a = await attempt();
    const row = await authDB.prepare('SELECT expires_at FROM sign_in_attempts WHERE ticket = ?1').bind(a.ticket).first<{ expires_at: number }>();
    expect(row!.expires_at - Date.now()).toBeLessThanOrEqual(REDEEM_MS);
    await authDB.prepare('UPDATE sign_in_attempts SET expires_at = 0 WHERE ticket = ?1').bind(a.ticket).run();
    await expect(redeemCentralAuth(a.request, hqEnv, 'login')).rejects.toThrow('expired');
  });

  it('checks a consent against the workspace client and the auth callback', async () => {
    const consent = { kind: 'consent', code: 'google-code', verifier: 'verifier', nonce: 'nonce', redirectUri: `${auth}/api/auth/calendar/callback`, clientId: 'test-web' } as const;
    expect(centralConsent(consent, hqEnv, 'calendar', 'test-web').redirectURI).toBe(`${auth}/api/auth/calendar/callback`);
    expect(() => centralConsent(consent, hqEnv, 'google-grant', 'test-connector')).toThrow('did not match');
    expect(() => centralConsent({ ...consent, clientId: 'other' }, hqEnv, 'calendar', 'test-web')).toThrow('did not match');
    expect(() => centralConsent({ kind: 'cancelled' }, hqEnv, 'calendar', 'test-web')).toThrow('did not match');
  });
});

describe('central sign-in: the auth host', () => {
  it('needs its own state cookie and the right purpose, and turns a refusal into a cancellation with no session', async () => {
    const start = await beginCentralAuth(new Request(`${hq}/start`), hqEnv, 'calendar', { returnTo: '/', owner });
    const toGoogle = await handleAuthFetch(new Request(start.headers.get('location')!), authEnv);
    const state = new URL(toGoogle.headers.get('location')!).searchParams.get('state')!;
    const callback = `${auth}/api/auth/calendar/callback?state=${state}&error=access_denied`;
    const withCookie = new Request(callback, { headers: { cookie: cookieHeader(toGoogle) } });
    expect(await (await handleAuthFetch(new Request(callback), authEnv)).text()).toContain('incomplete');
    const wrongPurpose = new Request(callback.replace('/api/auth/calendar/callback', '/api/auth/google/callback'), withCookie);
    expect(await (await handleAuthFetch(wrongPurpose, authEnv)).text()).toContain('purpose');
    const done = await handleAuthFetch(withCookie, authEnv);
    expect(done.status).toBe(302);
    expect(done.headers.getSetCookie().join('')).not.toContain('meet_session');
    const back = new URL(done.headers.get('location')!);
    expect(back.origin + back.pathname).toBe(`${hq}/api/calendar/connect/complete`);
    expect([...back.searchParams.keys()].sort()).toEqual(['code', 'ticket']);
    const redeemed = await redeemCentralAuth(new Request(back, { headers: { cookie: cookieHeader(start) } }), hqEnv, 'calendar', owner.sub);
    expect(redeemed.result.kind).toBe('cancelled');
    expect((await handleAuthFetch(withCookie, authEnv)).status).toBe(400);
  });

  it('answers only the start path and its three callbacks on its own host', async () => {
    for (const path of ['/', '/room/rosa', '/api/auth/me', '/api/auth/central/complete', '/api/calendar/connect/start', '/workspace', '/api/auth/native/exchange']) {
      expect((await handleAuthFetch(new Request(`${auth}${path}`), authEnv)).status).toBe(404);
    }
    expect((await handleAuthFetch(new Request(`${auth}/api/auth/google/callback`, { method: 'POST' }), authEnv)).status).toBe(404);
    expect((await handleAuthFetch(new Request(`${auth}${CENTRAL_AUTH_START_PATH}`, { method: 'PUT' }), authEnv)).status).toBe(404);
    expect((await handleAuthFetch(new Request(`${hq}${CENTRAL_AUTH_START_PATH}?ticket=${'t'.repeat(32)}`), authEnv)).status).toBe(404);
  });
});

describe('central sign-in: the workspace decides who signs in', () => {
  it('sets a host-only session on the workspace that redeemed', async () => {
    for (const [origin, workspace] of [[hq, hqEnv], [firm, firmEnv]] as const) {
      const a = await attempt('login', { origin, env: workspace });
      const ctx = createExecutionContext();
      const response = await completeCentralWebAuth(a.request, workspace, ctx);
      await waitOnExecutionContext(ctx);
      expect(response.headers.get('location')).toBe(`${origin}/work`);
      const cookies = response.headers.getSetCookie();
      expect(cookies[0]).toMatch(/^meet_session=/u);
      expect(cookies.join('\n')).not.toContain('Domain=');
      expect(cookies.join('\n')).toContain(`__Host-meet_auth_bridge_${a.ticket}=; Max-Age=0`);
    }
  });

  it.each(['agent', 'revoked', 'outside-domain'])('gives no session to %s', async (caseName) => {
    const person = { ...identity, sub: `central-${caseName}`, email: `central-${caseName}@example.com` } as Extract<CentralAuthResult, { kind: 'login' }>;
    if (caseName === 'outside-domain') {
      person.email = 'person@example.net';
      person.hd = 'example.com';
    } else {
      await env.USAGE.prepare(`INSERT INTO people (sub, email, name, kind, role, revoked_at, first_seen_at, last_seen_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0)`)
        .bind(person.sub, person.email, person.name, caseName === 'agent' ? 'agent' : 'human',
          'member', caseName === 'revoked' ? Date.now() : null).run();
    }
    const a = await attempt('login', { result: person });
    await expect(completeCentralWebAuth(a.request, hqEnv, createExecutionContext()))
      .rejects.toThrow({ 'outside-domain': 'Only a verified Google account on this workspace', agent: 'cannot sign in', revoked: 'can no longer sign in' }[caseName]);
  });

  it('keeps return paths on the workspace', () => {
    for (const path of ['//evil.example', '/\\evil.example', '/\n/evil.example', 'https://evil.example']) expect(safeReturnPath(path)).toBe('/');
    expect(safeReturnPath('/work?q=hello')).toBe('/work?q=hello');
  });
});

describe('native sign-in through the workspace web sign-in (meet#726)', () => {
  /** A PKCE pair as the app makes it. */
  async function pkce() {
    const verifier = randomToken(32);
    return { verifier, challenge: await sha256(verifier), state: randomToken(16) };
  }
  const startURL = (origin: string, challenge: string, state: string, callback?: string) =>
    `${origin}/api/auth/native/start?code_challenge=${challenge}&state=${state}${callback === undefined ? '' : `&callback=${encodeURIComponent(callback)}`}`;
  const redeem = async (code: string, verifier: string, workspace: Env = hqEnv) => {
    const ctx = createExecutionContext();
    try {
      return await redeemNativeSignIn(new Request(`${hq}/api/auth/native/redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, code_verifier: verifier, device_id: crypto.randomUUID(), device_name: 'Test Mac' }),
      }), workspace, ctx);
    } finally {
      await waitOnExecutionContext(ctx);
    }
  };
  const callbackOf = (response: Response) => {
    const location = response.headers.get('location')!;
    const callback = [NATIVE_SIGN_IN_CALLBACK, LEGACY_NATIVE_SIGN_IN_CALLBACK, ANDROID_NATIVE_SIGN_IN_CALLBACK].find((prefix) => location.startsWith(`${prefix}?`));
    expect(callback).toBeDefined();
    return new URL(location.replace(callback!, 'https://app.invalid/cb'));
  };
  type Login = Extract<CentralAuthResult, { kind: 'login' }>;

  /** Start, the auth host, the workspace's completion, then finish: the app's callback. */
  async function signIn(person: Login = identity as Login, callback?: string) {
    const { verifier, challenge, state } = await pkce();
    const started = await startNativeSignIn(new Request(startURL(hq, challenge, state, callback)), hqEnv);
    const ticket = ticketOf(started);
    expect(await claimAttempt(authEnv, ticket)).not.toBeNull();
    const code = await finishAttempt(authEnv, ticket, person);
    const complete = new URL(CENTRAL_AUTH_COMPLETE_PATHS.login, hq);
    complete.searchParams.set('ticket', ticket);
    complete.searchParams.set('code', code!);
    const ctx = createExecutionContext();
    const completed = await completeCentralWebAuth(new Request(complete, { headers: { cookie: cookieHeader(started) } }), hqEnv, ctx);
    await waitOnExecutionContext(ctx);
    const browser = [cookieHeader(started), cookieHeader(completed)].join('; ');
    const finished = await finishNativeSignIn(new Request(completed.headers.get('location')!, { headers: { cookie: browser } }), hqEnv);
    return { started, completed, finished, verifier, state };
  }

  it('starts the ordinary web sign-in through the auth host, with the challenge in a host-only cookie', async () => {
    const { challenge, state } = await pkce();
    const started = await startNativeSignIn(new Request(startURL(hq, challenge, state)), hqEnv);
    const location = new URL(started.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(`${auth}${CENTRAL_AUTH_START_PATH}`);
    expect([...location.searchParams.keys()]).toEqual(['ticket']);
    expect(started.headers.get('cache-control')).toBe('no-store');
    const native = started.headers.getSetCookie().find((value) => value.startsWith('__Host-meet_native='))!;
    expect(native).toContain('Path=/; HttpOnly; Secure; SameSite=Lax');
    expect(native).not.toContain('Domain=');
    // A workspace without central sign-in starts the direct Google flow the same way.
    const plain = { ...hqEnv, AUTH_ORIGIN: undefined, AUTH: undefined } as unknown as Env;
    const direct = await startNativeSignIn(new Request(startURL(hq, challenge, state)), plain);
    expect(new URL(direct.headers.get('location')!).origin).toBe('https://accounts.google.com');
    expect(direct.headers.getSetCookie().join('\n')).toContain('__Host-meet_native=');
  });

  it('refuses a start without a well-formed challenge and state', async () => {
    const { challenge, state } = await pkce();
    for (const url of [`${hq}/api/auth/native/start`, startURL(hq, 'short', state), startURL(hq, challenge, 'x'), startURL(hq, `${challenge}.x`, state)]) {
      await expect(startNativeSignIn(new Request(url), hqEnv)).rejects.toThrow('incomplete');
    }
  });

  it('refuses a start that names a callback outside the allowlist (meet#735)', async () => {
    const { challenge, state } = await pkce();
    for (const callback of ['', 'com.evil.app:/auth/callback', 'https://evil.example/cb', `${NATIVE_SIGN_IN_CALLBACK}x`, 'com.starlingshq.app:/auth/other']) {
      await expect(startNativeSignIn(new Request(startURL(hq, challenge, state, callback)), hqEnv)).rejects.toThrow('incomplete');
    }
  });

  it('returns to the callback the start named, and to the legacy one when it named none (meet#735)', async () => {
    const legacy = await signIn();
    expect(legacy.finished.headers.get('location')!.startsWith(`${LEGACY_NATIVE_SIGN_IN_CALLBACK}?`)).toBe(true);
    const named = await signIn(identity as Login, NATIVE_SIGN_IN_CALLBACK);
    expect(named.finished.headers.get('location')!.startsWith(`${NATIVE_SIGN_IN_CALLBACK}?`)).toBe(true);
    const code = callbackOf(named.finished).searchParams.get('code')!;
    expect((await redeem(code, named.verifier)).status).toBe(200);
    const old = await signIn(identity as Login, LEGACY_NATIVE_SIGN_IN_CALLBACK);
    expect(old.finished.headers.get('location')!.startsWith(`${LEGACY_NATIVE_SIGN_IN_CALLBACK}?`)).toBe(true);
  });

  it('signs the Android app in through its own callback, as an android device a shipped client still decodes', async () => {
    const android = await signIn(identity as Login, ANDROID_NATIVE_SIGN_IN_CALLBACK);
    expect(android.finished.headers.get('location')!.startsWith(`${ANDROID_NATIVE_SIGN_IN_CALLBACK}?`)).toBe(true);
    const code = callbackOf(android.finished).searchParams.get('code')!;
    const deviceID = crypto.randomUUID();
    const ctx = createExecutionContext();
    const response = await redeemNativeSignIn(new Request(`${hq}/api/auth/native/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-meet-client': 'android/0.0.1 (1)' },
      body: JSON.stringify({ code, code_verifier: android.verifier, client: 'android', device_id: deviceID, device_name: 'Nothing A065' }),
    }), hqEnv, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const row = await hqEnv.USAGE.prepare('SELECT client, platform FROM owner_devices WHERE device_id = ?1').bind(deviceID).first<{ client: string; platform: string }>();
    expect(row).toEqual({ client: 'android', platform: 'android' });
    const listed = (await listOwnerDevices(hqEnv, (identity as Login).sub, deviceID)).find((device) => device.device_id === deviceID)!;
    // `client` keeps to the two values every shipped Mac and iOS build decodes.
    expect(listed).toMatchObject({ client: 'ios', platform: 'android', label: 'Nothing A065', current: true });
  });

  it('returns to the https callback on its own host only (meet#905)', async () => {
    const own = nativeSignInHttpsCallback(hq)!;
    expect(own).toBe(`${hq}${NATIVE_SIGN_IN_HTTPS_PATH}`);
    const https = await signIn(identity as Login, own);
    const location = new URL(https.finished.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(own);
    expect(location.searchParams.get('state')).toBe(https.state);
    expect((await redeem(location.searchParams.get('code')!, https.verifier)).status).toBe(200);
    const { challenge, state } = await pkce();
    for (const callback of ['https://other.starlings.example/auth/native/callback', 'https://hq.starlings.example.evil.example/auth/native/callback', `${hq}/auth/native/other`, `http://hq.starlings.example${NATIVE_SIGN_IN_HTTPS_PATH}`]) {
      await expect(startNativeSignIn(new Request(startURL(hq, challenge, state, callback)), hqEnv)).rejects.toThrow('incomplete');
    }
    // A host the app's associated domains do not cover has no https callback.
    expect(nativeSignInHttpsCallback('https://meet.example.com')).toBeNull();
  });

  it('serves the app association and a plain callback page (meet#905)', async () => {
    expect(NATIVE_SIGN_IN_HTTPS_PATH).toBe('/auth/native/callback');
    const association = await exports.default.fetch(new Request('http://local/.well-known/apple-app-site-association'));
    expect(association.status).toBe(200);
    expect(association.headers.get('content-type')).toBe('application/json');
    expect(await association.json()).toEqual({ webcredentials: { apps: [nativeAppId(env.NATIVE_APPLE_TEAM_ID)] } });
    const page = await exports.default.fetch(new Request(`http://local${NATIVE_SIGN_IN_HTTPS_PATH}?code=x&state=y`));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Return to the Starlings app.');
    expect(page.headers.get('cache-control')).toBe('no-store');
  });

  it('reads a start cookie set before the callback was kept as the legacy callback, and refuses an unknown index', async () => {
    const { challenge, state } = await pkce();
    const started = await startNativeSignIn(new Request(startURL(hq, challenge, state, NATIVE_SIGN_IN_CALLBACK)), hqEnv);
    const value = decodeURIComponent(started.headers.getSetCookie().find((cookie) => cookie.startsWith('__Host-meet_native='))!.split(';')[0]!.slice('__Host-meet_native='.length));
    const [c, s, prior] = value.split('.');
    const before = await finishNativeSignIn(new Request(`${hq}${NATIVE_SIGN_IN_FINISH_PATH}`, { headers: { cookie: `__Host-meet_native=${encodeURIComponent(`${c}.${s}.${prior}`)}` } }), hqEnv);
    expect(before.headers.get('location')!.startsWith(`${LEGACY_NATIVE_SIGN_IN_CALLBACK}?`)).toBe(true);
    await expect(finishNativeSignIn(new Request(`${hq}${NATIVE_SIGN_IN_FINISH_PATH}`, { headers: { cookie: `__Host-meet_native=${encodeURIComponent(`${c}.${s}.${prior}.7`)}` } }), hqEnv)).rejects.toThrow('window that started it');
  });

  it('returns to finish, sends the app a single-use code bound to the verifier, and redeems it once', async () => {
    const { completed, finished, verifier, state } = await signIn();
    expect(completed.headers.get('location')).toBe(`${hq}${NATIVE_SIGN_IN_FINISH_PATH}`);
    expect(finished.status).toBe(303);
    expect(finished.headers.get('location')!.startsWith(`${LEGACY_NATIVE_SIGN_IN_CALLBACK}?`)).toBe(true);
    expect(finished.headers.get('cache-control')).toBe('no-store');
    expect(finished.headers.getSetCookie().join('\n')).toContain('__Host-meet_native=; Max-Age=0');
    const callback = callbackOf(finished);
    expect([...callback.searchParams.keys()].sort()).toEqual(['code', 'state']);
    expect(callback.searchParams.get('state')).toBe(state);
    const code = callback.searchParams.get('code')!;
    // Only the hash is stored.
    expect(await env.USAGE.prepare('SELECT 1 FROM native_sign_in_codes WHERE code_hash = ?1').bind(await sha256(code)).first()).not.toBeNull();
    expect(await env.USAGE.prepare('SELECT 1 FROM native_sign_in_codes WHERE code_hash = ?1').bind(code).first()).toBeNull();

    const response = await redeem(code, verifier);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.json() as { access_token: string; refresh_token: string; owner: { email: string } };
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(body.owner.email).toBe(owner.email);
    // Single use.
    await expect(redeem(code, verifier)).rejects.toThrow('expired or was already used');
  });

  it('spends the code on a wrong verifier', async () => {
    const { finished, verifier } = await signIn();
    const code = callbackOf(finished).searchParams.get('code')!;
    await expect(redeem(code, randomToken(32))).rejects.toThrow('expired or was already used');
    await expect(redeem(code, verifier)).rejects.toThrow('expired or was already used');
  });

  it('refuses an expired code', async () => {
    const { finished, verifier } = await signIn();
    const code = callbackOf(finished).searchParams.get('code')!;
    await env.USAGE.prepare('UPDATE native_sign_in_codes SET expires_at = ?2 WHERE code_hash = ?1').bind(await sha256(code), Date.now() - 1).run();
    await expect(redeem(code, verifier)).rejects.toThrow('expired or was already used');
  });

  it('issues no code for a session that was already in the browser at the start', async () => {
    const ctx = createExecutionContext();
    const session = await signOwnerSession(owner, hqEnv, { lastClient: 'web', ctx });
    await waitOnExecutionContext(ctx);
    const { challenge, state } = await pkce();
    const sessionCookie = `meet_session=${encodeURIComponent(session)}`;
    const started = await startNativeSignIn(new Request(startURL(hq, challenge, state), { headers: { cookie: sessionCookie } }), hqEnv);
    const native = started.headers.getSetCookie().find((value) => value.startsWith('__Host-meet_native='))!.split(';')[0];
    const before = await env.USAGE.prepare('SELECT COUNT(*) AS n FROM native_sign_in_codes').first<{ n: number }>();
    const finished = await finishNativeSignIn(new Request(`${hq}${NATIVE_SIGN_IN_FINISH_PATH}`, { headers: { cookie: `${native}; ${sessionCookie}` } }), hqEnv);
    const callback = callbackOf(finished);
    expect(callback.searchParams.get('error')).toBe('cancelled');
    expect(callback.searchParams.get('code')).toBeNull();
    expect(callback.searchParams.get('state')).toBe(state);
    const after = await env.USAGE.prepare('SELECT COUNT(*) AS n FROM native_sign_in_codes').first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });

  it('refuses a finish with no start cookie, and tells the app about a sign-in with no session', async () => {
    await expect(finishNativeSignIn(new Request(`${hq}${NATIVE_SIGN_IN_FINISH_PATH}`), hqEnv)).rejects.toThrow('window that started it');
    const { challenge, state } = await pkce();
    const started = await startNativeSignIn(new Request(startURL(hq, challenge, state)), hqEnv);
    const finished = await finishNativeSignIn(new Request(`${hq}${NATIVE_SIGN_IN_FINISH_PATH}`, { headers: { cookie: cookieHeader(started) } }), hqEnv);
    expect(callbackOf(finished).searchParams.get('error')).toBe('cancelled');
  });

  it('reads the people rules again at redemption', async () => {
    const person = { ...identity, sub: 'native-later-revoked', email: 'native-later-revoked@example.com' } as Login;
    const { finished, verifier } = await signIn(person);
    const code = callbackOf(finished).searchParams.get('code')!;
    await env.USAGE.prepare('UPDATE people SET revoked_at = ?2 WHERE sub = ?1').bind(person.sub, Date.now()).run();
    await env.USAGE.prepare(`INSERT OR IGNORE INTO people (sub, email, name, kind, role, revoked_at, first_seen_at, last_seen_at)
      VALUES (?1, ?2, ?3, 'human', 'member', ?4, 0, 0)`)
      .bind(person.sub, person.email, person.name, Date.now()).run();
    await expect(redeem(code, verifier)).rejects.toThrow('can no longer sign in');
  });
});
