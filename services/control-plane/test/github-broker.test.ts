// The GitHub token broker (docs/GITHUB_CONNECTOR.md "One App, one broker").
//
// The broker runs as its real `GithubService` entrypoint in the auth Worker,
// on the auth D1, with the `ctx.props` a workspace's `GITHUB` binding
// carries. The workspace side runs as a workspace Worker does, behind a fake
// binding that copies arguments and answers as RPC does. GitHub is a stub.
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GITHUB_APP_PATHS, GITHUB_BROKER_VERSION, GITHUB_CONNECT_COMPLETE_PATH } from '@starlings/contracts/github-app';
import type { AuthEnv } from '../src/auth-worker/env';
import { handleGithubFetch, resetGithubBrokerCache } from '../src/auth-worker/github';
import { GithubService } from '../src/auth-worker/index';
import { hmacSHA256Hex } from '../src/crypto';
import { completeGithubConnect, disconnectGithub, startGithubConnect } from '../src/github-connect';
import { githubConnection, githubRaw, resetGithubTokenCache } from '../src/github-app';
import { githubConnectorList } from '../src/github-connector';

const auth = 'https://auth.starlings.example';
const hq = 'https://hq.starlings.example';
const firm = 'https://firm-two.starlings.example';
const authDB = (env as unknown as { AUTH_DB: D1Database }).AUTH_DB;
const WEBHOOK_SECRET = 'webhook-secret-for-the-test-app-0123456789';
let authEnv: AuthEnv;

async function testPem(): Promise<string> {
  const keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey) as ArrayBuffer);
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
}

beforeAll(async () => {
  authEnv = {
    AUTH_DB: authDB,
    ENVIRONMENT: 'development',
    AUTH_ORIGIN: auth,
    RETURN_ORIGIN_ALIASES: '',
    GOOGLE_WEB_CLIENT_ID: 'test-web',
    GOOGLE_CONNECTOR_CLIENT_ID: '',
    AUTH_SIGNING_SECRET: 'auth-test-signing-secret-with-at-least-32-characters',
    GOOGLE_WEB_CLIENT_SECRET: 'test-web-secret',
    MAIL_FROM: 'Starlings <hello@starlings.example>',
    OPS_ALERT_EMAIL: 'ops@example.net',
    SIGNUP_ORIGIN: 'https://site.example',
    OPS_ORIGIN: 'https://ops.starlings.example',
    GITHUB_APP: JSON.stringify({
      id: 42, slug: 'starlings', client_id: 'Iv1.test', client_secret: 'client-secret', webhook_secret: WEBHOOK_SECRET, pem: await testPem(),
    }),
  };
});

/** What a workspace's GITHUB binding is: the real entrypoint with the props the account owner set. */
function bindingFor(props: unknown) {
  const service = new GithubService({ props } as unknown as ExecutionContext, authEnv);
  const call = (method: 'begin' | 'complete' | 'status' | 'token' | 'disconnect') =>
    async (input: unknown) => structuredClone(await service[method](structuredClone(input)));
  return { begin: call('begin'), complete: call('complete'), status: call('status'), token: call('token'), disconnect: call('disconnect') };
}
const workspaceEnv = (origin: string) => ({ ...env, WEB_ORIGIN: origin, PUBLIC_API_ORIGIN: origin, GITHUB: bindingFor({ origin }) }) as unknown as Env;
const plain = { v: GITHUB_BROKER_VERSION };

/**
 * GitHub, stubbed: the App's token endpoint, the OAuth code exchange, the
 * person's installations, the revoke, and one repository read. `reachable`
 * is what the person's token can see.
 */
function github(options: { reachable?: Array<{ id: number; login: string }>; tokenStatus?: number } = {}) {
  const minted: number[] = [];
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.host}${url.pathname}`);
    const minting = /^\/app\/installations\/(\d+)\/access_tokens$/u.exec(url.pathname);
    if (minting) {
      expect(request.headers.get('authorization')).toMatch(/^Bearer ey/u);
      minted.push(Number(minting[1]));
      if (options.tokenStatus) return new Response('{}', { status: options.tokenStatus });
      return Response.json({ token: `ghs_for_${minting[1]}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
    }
    if (url.host === 'github.com' && url.pathname === '/login/oauth/access_token') return Response.json({ access_token: 'ghu_person' });
    if (url.pathname === '/user/installations') {
      expect(request.headers.get('authorization')).toBe('Bearer ghu_person');
      return Response.json({ installations: (options.reachable ?? []).map(({ id, login }) => ({ id, account: { login } })) });
    }
    if (url.pathname === '/applications/Iv1.test/token' && request.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.pathname === '/repos/firm/app') return Response.json({ seen_with: request.headers.get('authorization') });
    return new Response('unexpected', { status: 500 });
  });
  return { minted, calls };
}

/** Record an installation for a workspace, as a finished connect does. */
async function connect(origin: string, installationId: number, account = 'acct') {
  await authDB.prepare('INSERT INTO github_installations (workspace_origin, installation_id, account, connected_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(origin, installationId, account, Date.now()).run();
}

const cookieHeader = (response: Response) => response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');

/** The browser's whole walk from Connect GitHub to the workspace's complete path. */
async function walk(workspace: Env, installationId: number) {
  const start = await startGithubConnect(new Request(`${workspace.WEB_ORIGIN}/api/connectors/github/connect/start`), workspace);
  const install = new URL(start.headers.get('location')!);
  const ticket = install.searchParams.get('state')!;
  const setup = await handleGithubFetch(new Request(`${auth}${GITHUB_APP_PATHS.setup}?installation_id=${installationId}&setup_action=install&state=${ticket}`), authEnv);
  const authorize = new URL(setup!.headers.get('location')!);
  const callback = await handleGithubFetch(new Request(`${auth}${GITHUB_APP_PATHS.callback}?code=person-code&state=${authorize.searchParams.get('state')}`, {
    headers: { cookie: cookieHeader(setup!) },
  }), authEnv);
  return { start, install, ticket, setup: setup!, authorize, callback: callback! };
}

beforeEach(async () => {
  resetGithubBrokerCache();
  resetGithubTokenCache();
  await authDB.batch([authDB.prepare('DELETE FROM github_installations'), authDB.prepare('DELETE FROM github_attempts')]);
});
afterEach(() => vi.unstubAllGlobals());

describe('the broker mints a token for the calling workspace only', () => {
  it('gives each workspace its own installation, and none to a workspace that has none', async () => {
    await connect(hq, 101);
    const { minted } = github();
    const answer = await bindingFor({ origin: hq }).token(plain);
    expect(answer).toMatchObject({ ok: true, token: 'ghs_for_101' });
    expect(await bindingFor({ origin: firm }).token(plain)).toEqual({ ok: false, reason: 'not_connected' });
    expect(minted).toEqual([101]);
  });

  it('cannot be asked for another installation: the input has no field for it', async () => {
    await connect(hq, 101);
    await connect(firm, 202);
    const { minted } = github();
    for (const input of [{ ...plain, installation_id: 101 }, { ...plain, origin: hq }, {}]) {
      expect(await bindingFor({ origin: firm }).token(input)).toEqual({ ok: false, reason: 'invalid_request' });
    }
    expect(await bindingFor({ origin: firm }).token(plain)).toMatchObject({ ok: true, token: 'ghs_for_202' });
    expect(minted).toEqual([202]);
  });

  it('refuses a binding without props, with extra props, or for a service host', async () => {
    await connect(hq, 101);
    github();
    for (const props of [undefined, {}, { origin: hq, installation: 101 }, { origin: 'https://docs-hq.starlings.example' }, { origin: auth }, { origin: 'https://evil.example.com' }]) {
      expect(await bindingFor(props).token(plain)).toEqual({ ok: false, reason: 'origin_refused' });
      expect(await bindingFor(props).status(plain)).toEqual({ ok: false, reason: 'origin_refused' });
    }
  });

  it('caches per installation, and drops a binding GitHub no longer knows', async () => {
    await connect(hq, 101);
    const first = github();
    await bindingFor({ origin: hq }).token(plain);
    await bindingFor({ origin: hq }).token(plain);
    expect(first.minted).toEqual([101]);
    resetGithubBrokerCache();
    github({ tokenStatus: 404 });
    expect(await bindingFor({ origin: hq }).token(plain)).toEqual({ ok: false, reason: 'not_connected' });
    expect(await bindingFor({ origin: hq }).status(plain)).toEqual({ ok: true, connection: null });
  });

  it('answers not_configured while the auth Worker holds no App', async () => {
    const service = new GithubService({ props: { origin: hq } } as unknown as ExecutionContext, (({ GITHUB_APP: _app, ...rest }) => rest)(authEnv));
    expect(await service.token(plain)).toEqual({ ok: false, reason: 'not_configured' });
    expect(await service.begin({ ...plain, browserHash: 'b'.repeat(43) })).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('the workspace reads GitHub with the token the broker minted for it', async () => {
    await connect(firm, 202);
    github();
    const response = await githubRaw(workspaceEnv(firm), '/repos/firm/app');
    expect(await response.json()).toEqual({ seen_with: 'Bearer ghs_for_202' });
    await expect(githubRaw(workspaceEnv(hq), '/repos/firm/app')).rejects.toThrow(/not connected/u);
  });
});

describe('connecting GitHub', () => {
  it('sends the browser to the install page, then GitHub authorization, then back to the workspace', async () => {
    const workspace = workspaceEnv(hq);
    github({ reachable: [{ id: 101, login: 'envisioning' }] });
    expect((await githubConnectorList(workspace)).connected).toBe(false);
    const { install, authorize, callback } = await walk(workspace, 101);
    expect(install.origin + install.pathname).toBe('https://github.com/apps/starlings/installations/new');
    expect(authorize.origin + authorize.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(authorize.searchParams.get('client_id')).toBe('Iv1.test');
    const complete = new URL(callback.headers.get('location')!);
    expect(complete.origin + complete.pathname).toBe(`${hq}${GITHUB_CONNECT_COMPLETE_PATH}`);
    // Nothing is bound until the workspace redeems the code.
    expect(await bindingFor({ origin: hq }).status(plain)).toEqual({ ok: true, connection: null });
  });

  it('records the installation for the workspace whose browser started it', async () => {
    const workspace = workspaceEnv(hq);
    github({ reachable: [{ id: 101, login: 'envisioning' }] });
    const { start, callback } = await walk(workspace, 101);
    const complete = new URL(callback.headers.get('location')!);
    const response = await completeGithubConnect(new Request(complete, { headers: { cookie: cookieHeader(start) } }), workspace);
    expect(response.headers.get('location')).toBe(`${hq}/admin/connectors/github`);
    expect(await githubConnection(workspace)).toMatchObject({ installation_id: 101, account: 'envisioning' });
    // A code redeems once.
    await expect(completeGithubConnect(new Request(complete, { headers: { cookie: cookieHeader(start) } }), workspace)).rejects.toThrow(/expired/u);
  });

  it('refuses another browser, another workspace, and a wrong code, and spends nothing', async () => {
    const workspace = workspaceEnv(hq);
    github({ reachable: [{ id: 101, login: 'envisioning' }] });
    const { start, callback, ticket } = await walk(workspace, 101);
    const complete = new URL(callback.headers.get('location')!);
    // Another browser: no cookie, or another secret under the same name.
    await expect(completeGithubConnect(new Request(complete), workspace)).rejects.toThrow(/expired/u);
    const forged = `__Host-meet_github_bridge_${ticket}=${'x'.repeat(43)}`;
    await expect(completeGithubConnect(new Request(complete, { headers: { cookie: forged } }), workspace)).rejects.toThrow(/expired/u);
    // Another workspace's binding, with this browser's secret.
    const firmComplete = new URL(complete.pathname + complete.search, firm);
    await expect(completeGithubConnect(new Request(firmComplete, { headers: { cookie: cookieHeader(start) } }), workspaceEnv(firm))).rejects.toThrow(/expired/u);
    // A wrong code.
    const wrong = new URL(complete);
    wrong.searchParams.set('code', 'y'.repeat(43));
    await expect(completeGithubConnect(new Request(wrong, { headers: { cookie: cookieHeader(start) } }), workspace)).rejects.toThrow(/expired/u);
    // None of that spent the attempt.
    await completeGithubConnect(new Request(complete, { headers: { cookie: cookieHeader(start) } }), workspace);
    expect(await githubConnection(workspace)).toMatchObject({ installation_id: 101 });
    expect(await bindingFor({ origin: firm }).status(plain)).toEqual({ ok: true, connection: null });
  });

  it('refuses a person who cannot reach the installation the setup named', async () => {
    const workspace = workspaceEnv(hq);
    // The setup URL carries any installation id a browser puts there; the person's own token decides.
    github({ reachable: [{ id: 999, login: 'theirs' }] });
    const { callback } = await walk(workspace, 101);
    expect(callback.status).toBe(403);
    expect(await bindingFor({ origin: hq }).status(plain)).toEqual({ ok: true, connection: null });
  });

  it('verifies the state: an unknown ticket, a second setup, and a callback without the setup cookie fail', async () => {
    const workspace = workspaceEnv(hq);
    github({ reachable: [{ id: 101, login: 'envisioning' }] });
    const unknown = await handleGithubFetch(new Request(`${auth}${GITHUB_APP_PATHS.setup}?installation_id=101&state=${'z'.repeat(32)}`), authEnv);
    expect(unknown!.status).toBe(400);
    const start = await startGithubConnect(new Request(`${hq}/api/connectors/github/connect/start`), workspace);
    const ticket = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const setup = await handleGithubFetch(new Request(`${auth}${GITHUB_APP_PATHS.setup}?installation_id=101&state=${ticket}`), authEnv);
    expect(setup!.status).toBe(302);
    // The setup step claims the ticket once: a second browser cannot.
    const again = await handleGithubFetch(new Request(`${auth}${GITHUB_APP_PATHS.setup}?installation_id=202&state=${ticket}`), authEnv);
    expect(again!.status).toBe(400);
    // The callback needs the cookie the setup set in this browser.
    const bare = await handleGithubFetch(new Request(`${auth}${GITHUB_APP_PATHS.callback}?code=c&state=${ticket}`), authEnv);
    expect(bare!.status).toBe(400);
    const wrongCookie = await handleGithubFetch(new Request(`${auth}${GITHUB_APP_PATHS.callback}?code=c&state=${ticket}`, {
      headers: { cookie: `__Host-starlings_github_${ticket}=${'q'.repeat(43)}` },
    }), authEnv);
    expect(wrongCookie!.status).toBe(400);
  });

  it('an expired attempt does not redeem', async () => {
    const workspace = workspaceEnv(hq);
    github({ reachable: [{ id: 101, login: 'envisioning' }] });
    const { start, callback, ticket } = await walk(workspace, 101);
    await authDB.prepare('UPDATE github_attempts SET expires_at = 1 WHERE ticket = ?1').bind(ticket).run();
    const complete = new URL(callback.headers.get('location')!);
    await expect(completeGithubConnect(new Request(complete, { headers: { cookie: cookieHeader(start) } }), workspace)).rejects.toThrow(/expired/u);
  });

  it('refuses an installation another workspace holds, and does not move it', async () => {
    await connect(firm, 101, 'envisioning');
    const workspace = workspaceEnv(hq);
    github({ reachable: [{ id: 101, login: 'envisioning' }] });
    const { start, callback } = await walk(workspace, 101);
    const complete = new URL(callback.headers.get('location')!);
    await expect(completeGithubConnect(new Request(complete, { headers: { cookie: cookieHeader(start) } }), workspace)).rejects.toThrow(/another workspace/u);
    expect(await bindingFor({ origin: firm }).status(plain)).toMatchObject({ ok: true, connection: { installation_id: 101 } });
    expect(await bindingFor({ origin: hq }).status(plain)).toEqual({ ok: true, connection: null });
  });

  it('disconnect forgets this workspace and no other', async () => {
    await connect(hq, 101);
    await connect(firm, 202);
    expect(await disconnectGithub(workspaceEnv(hq))).toEqual({ removed: 1 });
    expect(await bindingFor({ origin: hq }).status(plain)).toEqual({ ok: true, connection: null });
    expect(await bindingFor({ origin: firm }).status(plain)).toMatchObject({ ok: true, connection: { installation_id: 202 } });
  });
});

describe('installation webhooks', () => {
  async function deliver(body: unknown, event = 'installation', secret = WEBHOOK_SECRET) {
    const raw = JSON.stringify(body);
    return handleGithubFetch(new Request(`${auth}${GITHUB_APP_PATHS.webhook}`, {
      method: 'POST',
      headers: { 'x-github-event': event, 'x-hub-signature-256': `sha256=${await hmacSHA256Hex(secret, raw)}`, 'content-type': 'application/json' },
      body: raw,
    }), authEnv);
  }

  it('an uninstall or a suspension drops the binding; Admin then says not connected', async () => {
    await connect(hq, 101);
    await connect(firm, 202);
    expect((await deliver({ action: 'deleted', installation: { id: 101 } }))!.status).toBe(204);
    expect(await bindingFor({ origin: hq }).status(plain)).toEqual({ ok: true, connection: null });
    const list = await githubConnectorList(workspaceEnv(hq));
    expect(list).toMatchObject({ configured: true, connected: false, rows: [] });
    expect((await deliver({ action: 'suspend', installation: { id: 202 } }))!.status).toBe(204);
    expect(await bindingFor({ origin: firm }).status(plain)).toEqual({ ok: true, connection: null });
  });

  it('refuses a bad signature and ignores other events', async () => {
    await connect(hq, 101);
    expect((await deliver({ action: 'deleted', installation: { id: 101 } }, 'installation', 'not-the-secret'))!.status).toBe(401);
    expect((await deliver({ action: 'created', installation: { id: 101 } }))!.status).toBe(204);
    expect((await deliver({ action: 'deleted', installation: { id: 101 } }, 'installation_repositories'))!.status).toBe(204);
    expect(await bindingFor({ origin: hq }).status(plain)).toMatchObject({ ok: true, connection: { installation_id: 101 } });
  });

  it('owns only its own paths on the auth host', async () => {
    expect(await handleGithubFetch(new Request(`${auth}/api/auth/google/callback`), authEnv)).toBeNull();
    expect(await handleGithubFetch(new Request(`${hq}${GITHUB_APP_PATHS.setup}`), authEnv)).toBeNull();
    expect(await handleGithubFetch(new Request(`${auth}${GITHUB_APP_PATHS.webhook}`), authEnv)).toBeNull();
  });
});

