// The GitHub token broker (docs/GITHUB_CONNECTOR.md "One App, one broker").
//
// One Starlings GitHub App serves every workspace. Its private key can mint a
// token for every installation, so it lives here, in the auth Worker, and in
// no workspace Worker. A workspace reaches the broker over its `GITHUB`
// service binding, whose `props.origin` names it (wrangler.jsonc; the
// production check holds it to the workspace's WEB_ORIGIN). The broker mints
// a token only for the installation recorded for that origin.
//
// Connecting: the workspace begins an attempt bound to its origin and to the
// hash of a secret in its own host-only cookie, and sends the browser to the
// App's install page. GitHub returns to `setup` here with the installation;
// the broker sets its own cookie and asks GitHub for the person's
// authorization. The `callback` checks that the person can reach that
// installation (`GET /user/installations`), and sends the browser back to the
// workspace with a single-use code. The workspace redeems it over the
// binding with the browser secret; only then is the installation recorded.
//
// An `installation` webhook that deletes or suspends the installation drops
// the row.
import {
  GITHUB_APP_PATHS,
  GITHUB_CONNECT_COMPLETE_PATH,
  githubAppSecretSchema,
  githubBeginInputSchema,
  githubBindingPropsSchema,
  githubCallbackQuerySchema,
  githubCompleteInputSchema,
  githubPlainInputSchema,
  githubSetupQuerySchema,
  type GithubAppSecret,
  type GithubBeginResult,
  type GithubCompleteResult,
  type GithubConnection,
  type GithubDisconnectResult,
  type GithubStatusResult,
  type GithubTokenResult,
} from '@starlings/contracts/github-app';
import { constantTimeEqualSync, hmacSHA256Hex, randomToken, sha256 } from '../crypto';
import { githubAppJwt } from '../github-jwt';
import { expiredCookie, readCookie, redirectWithCookies } from '../http-cookies';
import { caller } from './attempts';
import type { AuthEnv } from './env';

export const GITHUB_ATTEMPT_MS = 10 * 60_000;
export const GITHUB_REDEEM_MS = 60_000;
const GITHUB_API = 'https://api.github.com';
const GITHUB_WEB = 'https://github.com';
const API_VERSION = '2022-11-28';
const USER_AGENT = 'starlings-auth';
/** A webhook body larger than this is not an installation event. */
const WEBHOOK_MAX_BYTES = 1_000_000;
/** `__Host-`: Secure, Path=/, no Domain. One per attempt, so tabs do not collide. */
const setupCookie = (ticket: string) => `__Host-starlings_github_${ticket}`;

// ---------------------------------------------------------------- the App

let parsedApp: { raw: string; app: GithubAppSecret | null } | null = null;

/** The App from the `GITHUB_APP` secret, or null when it is unset or does not parse. Never logs a value. */
export function githubApp(env: AuthEnv): GithubAppSecret | null {
  const raw = env.GITHUB_APP?.trim() ?? '';
  if (parsedApp?.raw === raw) return parsedApp.app;
  let app: GithubAppSecret | null = null;
  if (raw) {
    try {
      const parsed = githubAppSecretSchema.safeParse(JSON.parse(raw));
      app = parsed.success ? parsed.data : null;
    } catch {
      app = null;
    }
    if (!app) console.error(JSON.stringify({ level: 'error', message: 'github.app.unreadable' }));
  }
  parsedApp = { raw, app };
  return app;
}

/** The calling workspace's origin, from the binding's props alone. A service host (Docs, Keep) is refused. */
export function githubCaller(props: unknown, env: AuthEnv): string | null {
  if (!githubBindingPropsSchema.safeParse(props).success) return null;
  return caller(props, env)?.origin ?? null;
}

function githubHeaders(authorization: string): Record<string, string> {
  return {
    authorization,
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    'user-agent': USER_AGENT,
  };
}

// ------------------------------------------------------------- the tokens

/**
 * One token per installation per isolate, renewed five minutes before GitHub
 * expires it. Never written anywhere: minting is one call.
 */
const tokens = new Map<number, { token: string; expiresAt: number }>();

export function resetGithubBrokerCache(): void {
  tokens.clear();
  parsedApp = null;
}

interface InstallationRow {
  workspace_origin: string;
  installation_id: number;
  account: string;
  connected_at: number;
}

const connectionOf = (row: InstallationRow): GithubConnection => ({
  installation_id: row.installation_id,
  account: row.account,
  connected_at: row.connected_at,
});

async function installationOf(env: AuthEnv, origin: string): Promise<InstallationRow | null> {
  return env.AUTH_DB.prepare('SELECT * FROM github_installations WHERE workspace_origin = ?1').bind(origin).first<InstallationRow>();
}

async function dropInstallation(env: AuthEnv, installationId: number): Promise<number> {
  tokens.delete(installationId);
  const result = await env.AUTH_DB.prepare('DELETE FROM github_installations WHERE installation_id = ?1').bind(installationId).run();
  return result.meta.changes ?? 0;
}

/** RPC `token`: an installation token for the caller's own installation, and for nothing else. */
export async function githubToken(env: AuthEnv, origin: string | null, raw: unknown): Promise<GithubTokenResult> {
  if (!origin) return { ok: false, reason: 'origin_refused' };
  if (!githubPlainInputSchema.safeParse(raw).success) return { ok: false, reason: 'invalid_request' };
  const app = githubApp(env);
  if (!app) return { ok: false, reason: 'not_configured' };
  const row = await installationOf(env, origin);
  if (!row) return { ok: false, reason: 'not_connected' };
  const held = tokens.get(row.installation_id);
  if (held && held.expiresAt - Date.now() > 5 * 60_000) return { ok: true, token: held.token, expiresAt: held.expiresAt };
  const response = await fetch(`${GITHUB_API}/app/installations/${row.installation_id}/access_tokens`, {
    method: 'POST',
    headers: githubHeaders(`Bearer ${await githubAppJwt(app.id, app.pem)}`),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) {
    // GitHub no longer knows the installation: a missed uninstall webhook.
    await dropInstallation(env, row.installation_id);
    return { ok: false, reason: 'not_connected' };
  }
  if (!response.ok) {
    console.error(JSON.stringify({ level: 'error', message: 'github.token.refused', status: response.status }));
    return { ok: false, reason: 'github_failed' };
  }
  const body = await response.json().catch(() => null) as { token?: unknown; expires_at?: unknown } | null;
  if (typeof body?.token !== 'string' || !body.token) return { ok: false, reason: 'github_failed' };
  const parsedExpiry = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : Number.NaN;
  const expiresAt = Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + 55 * 60_000;
  tokens.set(row.installation_id, { token: body.token, expiresAt });
  return { ok: true, token: body.token, expiresAt };
}

/** RPC `status`: the caller's installation, or null. */
export async function githubStatus(env: AuthEnv, origin: string | null, raw: unknown): Promise<GithubStatusResult> {
  if (!origin) return { ok: false, reason: 'origin_refused' };
  if (!githubPlainInputSchema.safeParse(raw).success) return { ok: false, reason: 'invalid_request' };
  if (!githubApp(env)) return { ok: false, reason: 'not_configured' };
  const row = await installationOf(env, origin);
  return { ok: true, connection: row ? connectionOf(row) : null };
}

/** RPC `disconnect`: forget the caller's installation. The App stays installed on GitHub until its owner removes it. */
export async function githubDisconnect(env: AuthEnv, origin: string | null, raw: unknown): Promise<GithubDisconnectResult> {
  if (!origin) return { ok: false, reason: 'origin_refused' };
  if (!githubPlainInputSchema.safeParse(raw).success) return { ok: false, reason: 'invalid_request' };
  const row = await installationOf(env, origin);
  if (!row) return { ok: true, removed: false };
  await dropInstallation(env, row.installation_id);
  return { ok: true, removed: true };
}

// ------------------------------------------------------------ connecting

interface AttemptRow {
  ticket: string;
  workspace_origin: string;
  browser_hash: string;
  expires_at: number;
  installation_id: number | null;
  cookie_hash: string | null;
  account: string | null;
  redeem_hash: string | null;
}

/** RPC `begin`: a ten-minute attempt for the caller's origin, and the App's install page. */
export async function githubBegin(env: AuthEnv, origin: string | null, raw: unknown): Promise<GithubBeginResult> {
  if (!origin) return { ok: false, reason: 'origin_refused' };
  const parsed = githubBeginInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid_request' };
  const app = githubApp(env);
  if (!app) return { ok: false, reason: 'not_configured' };
  const ticket = randomToken(24);
  const now = Date.now();
  await env.AUTH_DB.batch([
    env.AUTH_DB.prepare('DELETE FROM github_attempts WHERE expires_at < ?1').bind(now),
    env.AUTH_DB.prepare('INSERT INTO github_attempts (ticket, workspace_origin, browser_hash, expires_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(ticket, origin, parsed.data.browserHash, now + GITHUB_ATTEMPT_MS),
  ]);
  const install = new URL(`${GITHUB_WEB}/apps/${app.slug}/installations/new`);
  install.searchParams.set('state', ticket);
  return { ok: true, ticket, installUrl: install.toString() };
}

/**
 * RPC `complete`: the workspace redeems the code with the browser secret.
 * The delete is the exchange: the origin, the browser, the code and the
 * expiry are all in its WHERE, so a mismatch consumes nothing and two
 * redemptions succeed once. An installation another workspace holds is
 * refused, never moved.
 */
export async function githubComplete(env: AuthEnv, origin: string | null, raw: unknown): Promise<GithubCompleteResult> {
  if (!origin) return { ok: false, reason: 'origin_refused' };
  const parsed = githubCompleteInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid_request' };
  const input = parsed.data;
  const row = await env.AUTH_DB.prepare(`DELETE FROM github_attempts
    WHERE ticket = ?1 AND workspace_origin = ?2 AND browser_hash = ?3 AND redeem_hash = ?4 AND expires_at > ?5
      AND installation_id IS NOT NULL AND account IS NOT NULL
    RETURNING installation_id, account`)
    .bind(input.ticket, origin, input.browserHash, await sha256(input.code), Date.now())
    .first<{ installation_id: number; account: string }>();
  if (!row) return { ok: false, reason: 'expired_or_used' };
  const holder = await env.AUTH_DB.prepare('SELECT workspace_origin FROM github_installations WHERE installation_id = ?1')
    .bind(row.installation_id).first<{ workspace_origin: string }>();
  if (holder && holder.workspace_origin !== origin) return { ok: false, reason: 'installation_taken' };
  const connectedAt = Date.now();
  try {
    await env.AUTH_DB.prepare(`INSERT INTO github_installations (workspace_origin, installation_id, account, connected_at)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT (workspace_origin) DO UPDATE SET installation_id = excluded.installation_id, account = excluded.account,
        connected_at = excluded.connected_at`)
      .bind(origin, row.installation_id, row.account, connectedAt).run();
  } catch {
    // Two workspaces raced for one installation; the UNIQUE index chose the other.
    return { ok: false, reason: 'installation_taken' };
  }
  return { ok: true, connection: { installation_id: row.installation_id, account: row.account, connected_at: connectedAt } };
}

function noStore(response: Response): Response {
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  response.headers.set('x-robots-tag', 'noindex');
  return response;
}

function text(message: string, status: number): Response {
  return noStore(new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
}

/** The workspace's GitHub page: where a cancelled or refused attempt goes back to. */
function workspacePage(origin: string): string {
  return new URL('/admin/connectors/github', origin).toString();
}

/**
 * GET setup: GitHub sends the browser here after the install, with the
 * attempt as `state`. The broker claims the attempt once, binds it to this
 * browser with its own cookie, and asks GitHub who the person is.
 */
async function setup(request: Request, env: AuthEnv, app: GithubAppSecret): Promise<Response> {
  const query = githubSetupQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return text('Start again from your workspace.', 400);
  const now = Date.now();
  const attempt = await env.AUTH_DB.prepare('SELECT * FROM github_attempts WHERE ticket = ?1 AND expires_at > ?2 AND cookie_hash IS NULL')
    .bind(query.data.state, now).first<AttemptRow>();
  if (!attempt) return text('This link has expired. Start again from your workspace.', 400);
  if (!query.data.installation_id) {
    // Cancelled on GitHub's page.
    await env.AUTH_DB.prepare('DELETE FROM github_attempts WHERE ticket = ?1').bind(attempt.ticket).run();
    return noStore(redirectWithCookies(workspacePage(attempt.workspace_origin), []));
  }
  const browser = randomToken();
  const claimed = await env.AUTH_DB.prepare(`UPDATE github_attempts SET cookie_hash = ?2, installation_id = ?3
    WHERE ticket = ?1 AND cookie_hash IS NULL AND expires_at > ?4`)
    .bind(attempt.ticket, await sha256(browser), Number(query.data.installation_id), now).run();
  if (claimed.meta.changes !== 1) return text('This link has expired. Start again from your workspace.', 400);
  const authorize = new URL(`${GITHUB_WEB}/login/oauth/authorize`);
  authorize.searchParams.set('client_id', app.client_id);
  authorize.searchParams.set('redirect_uri', new URL(GITHUB_APP_PATHS.callback, env.AUTH_ORIGIN).toString());
  authorize.searchParams.set('state', attempt.ticket);
  const cookie = `${setupCookie(attempt.ticket)}=${browser}; Max-Age=${GITHUB_ATTEMPT_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  return noStore(redirectWithCookies(authorize.toString(), [cookie]));
}

/** The person's own token, for one question: can they reach the installation? */
async function userToken(app: GithubAppSecret, code: string, redirectUri: string): Promise<string | null> {
  const response = await fetch(`${GITHUB_WEB}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ client_id: app.client_id, client_secret: app.client_secret, code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const body = await response.json().catch(() => null) as { access_token?: unknown } | null;
  return typeof body?.access_token === 'string' && body.access_token ? body.access_token : null;
}

/** The account of `installationId` when the person's token lists it among the installations they can reach. */
async function reachableInstallation(token: string, installationId: number): Promise<string | null> {
  for (let page = 1; page <= 10; page += 1) {
    const url = new URL(`${GITHUB_API}/user/installations`);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const response = await fetch(url, { headers: githubHeaders(`Bearer ${token}`), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null) as { installations?: Array<{ id?: unknown; account?: { login?: unknown } | null }> } | null;
    const installations = body?.installations ?? [];
    const found = installations.find((installation) => installation.id === installationId);
    if (found) return typeof found.account?.login === 'string' ? found.account.login : null;
    if (installations.length < 100) return null;
  }
  return null;
}

/** Best effort: the person's token answered its one question and is not kept. */
async function revokeUserToken(app: GithubAppSecret, token: string): Promise<void> {
  try {
    await fetch(`${GITHUB_API}/applications/${app.client_id}/token`, {
      method: 'DELETE',
      headers: { ...githubHeaders(`Basic ${btoa(`${app.client_id}:${app.client_secret}`)}`), 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // The token expires on its own.
  }
}

/**
 * GET callback: GitHub returns the person's authorization. The attempt must
 * be the one this browser set up (its cookie), and the person must reach
 * the installation. Then the browser goes back to the workspace with a
 * single-use code; nothing is recorded until the workspace redeems it.
 */
async function callback(request: Request, env: AuthEnv, app: GithubAppSecret): Promise<Response> {
  const query = githubCallbackQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return text('Start again from your workspace.', 400);
  const ticket = query.data.state;
  const attempt = await env.AUTH_DB.prepare(`SELECT * FROM github_attempts
    WHERE ticket = ?1 AND expires_at > ?2 AND cookie_hash IS NOT NULL AND redeem_hash IS NULL`)
    .bind(ticket, Date.now()).first<AttemptRow>();
  const browser = readCookie(request, setupCookie(ticket));
  const clear = [expiredCookie(setupCookie(ticket))];
  if (!attempt || !browser || !constantTimeEqualSync(await sha256(browser), attempt.cookie_hash ?? '')) {
    return text('This link has expired. Start again from your workspace.', 400);
  }
  if (query.data.error || !query.data.code) {
    await env.AUTH_DB.prepare('DELETE FROM github_attempts WHERE ticket = ?1').bind(ticket).run();
    return noStore(redirectWithCookies(workspacePage(attempt.workspace_origin), clear));
  }
  const token = await userToken(app, query.data.code, new URL(GITHUB_APP_PATHS.callback, env.AUTH_ORIGIN).toString());
  if (!token) return text('GitHub did not confirm your account. Start again from your workspace.', 502);
  const account = await reachableInstallation(token, attempt.installation_id ?? -1);
  await revokeUserToken(app, token);
  if (!account) {
    await env.AUTH_DB.prepare('DELETE FROM github_attempts WHERE ticket = ?1').bind(ticket).run();
    return text('Your GitHub account has no access to that installation.', 403);
  }
  const code = randomToken();
  const now = Date.now();
  const saved = await env.AUTH_DB.prepare(`UPDATE github_attempts SET account = ?2, redeem_hash = ?3, expires_at = ?4
    WHERE ticket = ?1 AND redeem_hash IS NULL AND expires_at > ?5`)
    .bind(ticket, account, await sha256(code), now + GITHUB_REDEEM_MS, now).run();
  if (saved.meta.changes !== 1) return text('This link has expired. Start again from your workspace.', 400);
  const complete = new URL(GITHUB_CONNECT_COMPLETE_PATH, attempt.workspace_origin);
  complete.searchParams.set('ticket', ticket);
  complete.searchParams.set('code', code);
  return noStore(redirectWithCookies(complete.toString(), clear));
}

/**
 * POST webhook: GitHub's installation events, signed with the App's webhook
 * secret. A deleted or suspended installation loses its workspace; every
 * other event is acknowledged and ignored.
 */
async function webhook(request: Request, env: AuthEnv, app: GithubAppSecret): Promise<Response> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > WEBHOOK_MAX_BYTES) return text('Too large.', 413);
  const body = await request.text();
  if (body.length > WEBHOOK_MAX_BYTES) return text('Too large.', 413);
  const signature = request.headers.get('x-hub-signature-256') ?? '';
  const expected = `sha256=${await hmacSHA256Hex(app.webhook_secret, body)}`;
  if (!constantTimeEqualSync(signature, expected)) return text('Bad signature.', 401);
  if (request.headers.get('x-github-event') !== 'installation') return noStore(new Response(null, { status: 204 }));
  type InstallationEvent = { action?: unknown; installation?: { id?: unknown } | null };
  let event: InstallationEvent | null;
  try { event = JSON.parse(body) as InstallationEvent | null; } catch { return text('Bad body.', 400); }
  const installationId = event?.installation?.id;
  if ((event?.action === 'deleted' || event?.action === 'suspend') && typeof installationId === 'number') {
    const dropped = await dropInstallation(env, installationId);
    console.log(JSON.stringify({ level: 'info', message: 'github.installation.dropped', action: event.action, installation: installationId, dropped }));
  }
  return noStore(new Response(null, { status: 204 }));
}

/** The broker's public half on the auth host, or null for a path it does not own. */
export async function handleGithubFetch(request: Request, env: AuthEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.origin !== env.AUTH_ORIGIN) return null;
  const route = request.method === 'GET' && url.pathname === GITHUB_APP_PATHS.setup ? setup
    : request.method === 'GET' && url.pathname === GITHUB_APP_PATHS.callback ? callback
      : request.method === 'POST' && url.pathname === GITHUB_APP_PATHS.webhook ? webhook
        : null;
  if (!route) return null;
  const app = githubApp(env);
  if (!app) return text('GitHub is not configured.', 503);
  try {
    return await route(request, env, app);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'github.request.failed', path: url.pathname, error: error instanceof Error ? error.name : 'unknown' }));
    return text('Connecting GitHub failed. Start again from your workspace.', 500);
  }
}
