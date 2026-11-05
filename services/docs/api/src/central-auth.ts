// Central sign-in, Docs' side (WEB_SIGN_IN = 'central'; envisioning/meet
// docs/CENTRAL_AUTH.md "Services").
//
// Docs signs in through the auth host as its workspace. It asks the auth
// Worker for an attempt over the `AUTH` service binding, sends the browser to
// the auth host, and redeems the single-use code over the same binding. The
// binding's props name this origin, the workspace and the service; no
// argument can. Then the workspace decides: `MemberService.check` over the
// `MEET` binding runs the workspace's own sign-in rules, so a person revoked
// there is refused here. Only then does Docs set its own host-only session.
//
// Every answer from either binding is parsed, never trusted. A missing
// binding answers 503; nothing falls back to the direct Google flow.
import {
  AUTH_HANDOFF_VERSION,
  CENTRAL_AUTH_SIGN_OUT_PATH,
  CENTRAL_AUTH_START_PATH,
  authBeginResultSchema,
  authRedeemResultSchema,
  memberCheckResultSchema,
  type AuthBeginInput,
  type AuthRedeemInput,
  type DocumentAccessedInput,
  type MemberCheckInput,
} from '@docs/contracts';
import { SESSION_COOKIE, STAFF_SESSION_SECONDS, signStaffSession } from './auth';
import { randomToken, sha256Hex } from './crypto';
import { AuthError } from './errors';
import { cookie, expiredCookie, readCookie, redirectWithCookies, safeReturnPath } from './http-cookies';
import { googleHostedDomain, isIdentityEmail, isIdentityHostedDomain } from './identity';

/** The RPC surface of the auth Worker's `AuthService`. Results are decoded, never trusted. */
interface AuthBinding {
  begin(input: AuthBeginInput): Promise<unknown>;
  redeem(input: AuthRedeemInput): Promise<unknown>;
}

/**
 * The RPC surface of the workspace Worker's `MemberService`. `documentAccessed`
 * is newer than `check`: an older Worker lacks it,
 * so a caller treats a throw as "not told" (src/access-notify.ts).
 */
export interface MemberBinding {
  check(input: MemberCheckInput): Promise<unknown>;
  documentAccessed(input: DocumentAccessedInput): Promise<unknown>;
}

/** The browser half of an attempt: a host-only cookie per attempt, so two tabs do not collide. */
const bridgeCookie = (ticket: string) => `__Host-docs_auth_bridge_${ticket}`;
const ATTEMPT_COOKIE_SECONDS = 600;
const OPAQUE = /^[A-Za-z0-9_-]{20,128}$/u;

function binding<T>(env: Env, name: 'AUTH' | 'MEET'): T {
  const value = env[name];
  if (!value) throw new AuthError('Central sign-in is not configured on this deployment.', 503, 'not_configured');
  return value as T;
}

function authOrigin(env: Env): string {
  const origin = env.AUTH_ORIGIN?.trim();
  if (!origin) throw new AuthError('AUTH_ORIGIN is not configured.', 503, 'not_configured');
  return origin;
}

function noStore(response: Response): Response {
  response.headers.set('cache-control', 'no-store');
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}

/** GET /api/auth/google/start on a central deployment: begin an attempt and send the browser to the auth host. */
export async function startCentralWebAuth(request: Request, env: Env): Promise<Response> {
  const returnPath = safeReturnPath(new URL(request.url).searchParams.get('return_to'));
  const secret = randomToken();
  const begun = authBeginResultSchema.safeParse(await binding<AuthBinding>(env, 'AUTH').begin({
    v: AUTH_HANDOFF_VERSION,
    kind: 'login',
    returnPath,
    browserHash: await sha256Hex(secret),
    ownerSub: null,
    product: null,
    loginHint: null,
    workspaceName: 'Docs',
    markPath: null,
    hostedDomain: googleHostedDomain(env),
  }));
  if (!begun.success || !begun.data.ok) {
    console.error(JSON.stringify({ level: 'error', message: 'docs.central_auth.begin_refused', reason: begun.success && !begun.data.ok ? begun.data.reason : 'unreadable' }));
    throw new AuthError('Sign-in is not available right now.', 503, 'not_configured');
  }
  const target = new URL(CENTRAL_AUTH_START_PATH, authOrigin(env));
  target.searchParams.set('ticket', begun.data.ticket);
  return noStore(redirectWithCookies(target.toString(), [cookie(bridgeCookie(begun.data.ticket), secret, ATTEMPT_COOKIE_SECONDS)]));
}

/**
 * GET /api/auth/central/complete?ticket=…&code=… — redeem the code, apply
 * this deployment's identity domains, ask the workspace, then set the staff
 * session. A cancellation on Google's screen returns without one.
 */
export async function completeCentralWebAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const ticket = url.searchParams.get('ticket') ?? '';
  const code = url.searchParams.get('code') ?? '';
  if (!OPAQUE.test(ticket) || !OPAQUE.test(code)) throw new AuthError('This sign-in link is not valid. Start again.', 400, 'oauth_failed');
  const secret = readCookie(request, bridgeCookie(ticket));
  if (!secret) throw new AuthError('This sign-in started in another browser. Start again.', 400, 'oauth_failed');
  const clearBridge = expiredCookie(bridgeCookie(ticket));

  const redeemed = authRedeemResultSchema.safeParse(await binding<AuthBinding>(env, 'AUTH').redeem({
    v: AUTH_HANDOFF_VERSION,
    kind: 'login',
    ticket,
    code,
    browserHash: await sha256Hex(secret),
    ownerSub: null,
  }));
  if (!redeemed.success || !redeemed.data.ok) throw new AuthError('This sign-in expired or was already used. Start again.', 400, 'oauth_failed');
  const back = `${env.WEB_ORIGIN}${safeReturnPath(redeemed.data.returnPath)}`;
  const result = redeemed.data.result;
  if (result.kind === 'cancelled') return noStore(redirectWithCookies(back, [clearBridge]));

  const email = result.email.toLowerCase();
  if (!isIdentityHostedDomain(env, result.hd) || !isIdentityEmail(env, email)) {
    throw new AuthError('Only verified accounts on this workspace can sign in to Docs.', 403, 'forbidden');
  }
  const member = memberCheckResultSchema.safeParse(await binding<MemberBinding>(env, 'MEET').check({
    v: AUTH_HANDOFF_VERSION,
    sub: result.sub,
    email,
    ...(result.hd ? { hd: result.hd } : {}),
  }));
  if (!member.success) throw new AuthError('Sign-in is not available right now.', 503, 'not_configured');
  if (!member.data.ok) throw new AuthError('This account cannot sign in to Docs.', 403, 'forbidden');

  const session = await signStaffSession({
    sub: result.sub,
    email,
    name: result.name,
    ...(result.picture ? { picture: result.picture } : {}),
  }, env);
  return noStore(redirectWithCookies(back, [cookie(SESSION_COOKIE, session, STAFF_SESSION_SECONDS), clearBridge]));
}

/** Where sign-out goes on a central deployment: the auth host ends its session and returns here. */
export function centralSignOutLocation(env: Env): string {
  const target = new URL(CENTRAL_AUTH_SIGN_OUT_PATH, authOrigin(env));
  target.searchParams.set('return_to', env.WEB_ORIGIN);
  return target.toString();
}
