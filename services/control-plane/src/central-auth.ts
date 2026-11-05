// Central sign-in, the workspace side (docs/CENTRAL_AUTH.md).
//
// A workspace with AUTH_ORIGIN asks the `starlings-auth` Worker for an
// attempt over the `AUTH` service binding, sends the browser to the auth
// host, and later redeems the single-use code over the same binding. Nothing
// here shares a D1 with the auth Worker. The workspace alone sets its session
// and stores Google grants.
//
// The workspace never names its origin to the auth Worker. The binding's
// `props.origin` does (wrangler.jsonc), and the production check
// holds it to WEB_ORIGIN. So central sign-in serves WEB_ORIGIN only; an alias
// keeps the direct flow.
import {
  AUTH_HANDOFF_VERSION,
  CENTRAL_AUTH_CALLBACK_PATHS,
  CENTRAL_AUTH_SIGN_OUT_PATH,
  CENTRAL_AUTH_START_PATH,
  authBeginResultSchema,
  authRedeemResultSchema,
  centralAuthCompleteQuerySchema,
  type AuthBeginInput,
  type AuthRedeemInput,
  type BrowserAuthKind,
  type CentralAuthResult,
} from '@starlings/contracts/browser-auth';
import type { GoogleGrantProduct, OwnerSession } from './contracts';
import { randomToken, sha256 } from './crypto';
import { AuthError } from './errors';
import { assertUnderRateLimit } from './http';
import { cookie, expiredCookie, readCookie, redirectWithCookies, safeReturnPath } from './http-cookies';
import { signInDomain } from './workspace-identity';
import { workspaceAccent, workspaceMarkPath } from './workspace-profile';

/** The RPC surface of `AuthService` in src/auth-worker/index.ts. Results are decoded, never trusted. No argument names an origin. */
interface AuthBinding {
  begin(input: AuthBeginInput): Promise<unknown>;
  redeem(input: AuthRedeemInput): Promise<unknown>;
}

/** The browser half of the attempt: a host-only cookie per attempt, so two tabs do not collide. */
const bridgeCookie = (ticket: string) => `__Host-meet_auth_bridge_${ticket}`;
const ATTEMPT_COOKIE_SECONDS = 600;

export function authOrigin(env: Env): string | null {
  const value = (env as { AUTH_ORIGIN?: string }).AUTH_ORIGIN;
  return value ? value : null;
}

function authBinding(env: Env): AuthBinding {
  const binding = (env as { AUTH?: unknown }).AUTH;
  if (!binding) throw new AuthError('Central sign-in is not configured.', 503, 'not_configured');
  return binding as AuthBinding;
}

/**
 * True when this request starts Google through the auth host: AUTH_ORIGIN is
 * set and the request is on WEB_ORIGIN, the one origin the `AUTH` binding's
 * props name. Every other origin keeps the direct Google flow.
 */
export function usesCentralAuth(request: Request, env: Env): boolean {
  const auth = authOrigin(env);
  if (!auth) return false;
  const origin = new URL(request.url).origin;
  return origin === env.WEB_ORIGIN && origin !== auth;
}

/** The name on the auth host's sign-in screen, when it fits the screen's limit. */
function screenName(env: Env): string | null {
  const name = env.WORKSPACE_NAME?.trim();
  return name && name.length <= 60 ? name : null;
}

function noStore(response: Response): Response {
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}

/**
 * GET /api/auth/central/sign-out — after the member's own sign-out, end the
 * auth host's session too (docs/CENTRAL_AUTH.md "The auth session"), and
 * come back to this workspace's root. Without central sign-in on this
 * origin it goes straight to the root. Other workspaces and services keep
 * their own sessions until those expire.
 */
export function centralSignOutResponse(request: Request, env: Env): Response {
  const auth = authOrigin(env);
  if (!auth || !usesCentralAuth(request, env)) return authRedirect(new URL('/', request.url).toString());
  const target = new URL(CENTRAL_AUTH_SIGN_OUT_PATH, auth);
  target.searchParams.set('return_to', env.WEB_ORIGIN);
  return authRedirect(target.toString());
}

export function authRedirect(location: string, cookies: string[] = []): Response {
  return noStore(redirectWithCookies(location, cookies));
}

/**
 * Ask the auth Worker for a ten-minute attempt and send the browser there.
 * The browser secret stays in this host's cookie; the auth Worker stores
 * only its hash.
 */
export async function beginCentralAuth(
  request: Request,
  env: Env,
  kind: BrowserAuthKind,
  options: { returnTo: string; owner?: OwnerSession; product?: GoogleGrantProduct },
): Promise<Response> {
  const auth = authOrigin(env);
  if (!auth || !usesCentralAuth(request, env)) throw new AuthError('Unknown workspace.', 403, 'untrusted_origin');
  const binding = authBinding(env);
  await assertUnderRateLimit(env.JOIN_LIMIT, request, 'browser-auth-start');
  const browserSecret = randomToken();
  const answer = authBeginResultSchema.parse(await binding.begin({
    v: AUTH_HANDOFF_VERSION,
    kind,
    returnPath: safeReturnPath(options.returnTo),
    browserHash: await sha256(browserSecret),
    ownerSub: kind === 'login' ? null : options.owner?.sub ?? null,
    product: kind === 'google-grant' ? options.product ?? null : null,
    loginHint: kind === 'google-grant' ? options.owner?.email ?? null : null,
    workspaceName: kind === 'login' ? screenName(env) : null,
    markPath: kind === 'login' ? await workspaceMarkPath(env).catch(() => null) : null,
    accent: kind === 'login' ? await workspaceAccent(env).catch(() => null) : null,
    hostedDomain: signInDomain(env),
  }));
  if (!answer.ok) {
    throw answer.reason === 'origin_refused'
      ? new AuthError('The sign-in service does not serve this workspace address.', 403, 'untrusted_origin')
      : new AuthError('The sign-in request was refused.', 400, 'oauth_failed');
  }
  const start = new URL(CENTRAL_AUTH_START_PATH, auth);
  start.searchParams.set('ticket', answer.ticket);
  return authRedirect(start.toString(), [cookie(bridgeCookie(answer.ticket), browserSecret, ATTEMPT_COOKIE_SECONDS)]);
}

export interface RedeemedCentralAuth {
  result: CentralAuthResult;
  /** Back to the path the attempt started from, on this host, with the bridge cookie cleared. */
  redirect(cookies?: string[]): Response;
}

/**
 * Redeem the single-use code. The auth Worker deletes the attempt in the same
 * statement that checks purpose, this exact origin, the browser secret, the
 * code and the consent owner, so a second redemption, another workspace or
 * another browser gets nothing.
 */
export async function redeemCentralAuth(
  request: Request,
  env: Env,
  kind: BrowserAuthKind,
  ownerSub?: string,
): Promise<RedeemedCentralAuth> {
  const url = new URL(request.url);
  const query = centralAuthCompleteQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) throw new AuthError('The sign-in response is incomplete.', 400, 'oauth_failed');
  const { ticket, code } = query.data;
  const secret = readCookie(request, bridgeCookie(ticket));
  if (!secret || !usesCentralAuth(request, env)) {
    throw new AuthError('Sign-in must finish in the browser that started it.', 400, 'oauth_failed');
  }
  const answer = authRedeemResultSchema.parse(await authBinding(env).redeem({
    v: AUTH_HANDOFF_VERSION,
    kind,
    ticket,
    code,
    browserHash: await sha256(secret),
    ownerSub: ownerSub ?? null,
  }));
  if (!answer.ok) throw new AuthError('This sign-in response expired or was already used. Start again.', 400, 'oauth_failed');
  const back = `${url.origin}${safeReturnPath(answer.returnPath)}`;
  const clear = expiredCookie(bridgeCookie(ticket));
  return { result: answer.result, redirect: (cookies = []) => authRedirect(back, [...cookies, clear]) };
}

/**
 * The Google code a central consent carries, checked against this
 * workspace's own client and the auth host's callback before the exchange.
 */
export function centralConsent(
  result: CentralAuthResult,
  env: Env,
  kind: Exclude<BrowserAuthKind, 'login'>,
  clientId: string,
): { code: string; verifier: string; nonce: string; redirectURI: string } {
  const auth = authOrigin(env);
  if (result.kind !== 'consent' || !auth || result.redirectUri !== `${auth}${CENTRAL_AUTH_CALLBACK_PATHS[kind]}` || result.clientId !== clientId) {
    throw new AuthError('The Google consent did not match this workspace.', 400, 'oauth_failed');
  }
  return { code: result.code, verifier: result.verifier, nonce: result.nonce, redirectURI: result.redirectUri };
}
