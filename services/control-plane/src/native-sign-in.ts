// Native sign-in through the workspace's own web sign-in (,
// docs/CENTRAL_AUTH.md §Signing in through the auth host).
//
// The Mac or iOS app opens `/api/auth/native/start` in an authentication
// browser with its PKCE challenge and a state. The workspace keeps both in a
// host-only cookie and runs its ordinary web sign-in: through the auth host
// when it has central sign-in, the direct Google flow otherwise. The auth
// Worker does not know this is a native sign-in. At the end the browser comes
// back to `/api/auth/native/finish`, which needs a web session that the
// sign-in just set, and issues a single-use code to the app's callback. The
// callback is the one the start named, from an allowlist of two
// (`NATIVE_SIGN_IN_CALLBACKS`): the Starlings apps send theirs, and a start
// without one is an app released before the rename. The
// app redeems the code with its verifier at `/api/auth/native/redeem` and
// gets the same native pair `/api/auth/native/exchange` gives.
//
// The rules:
// - the code is stored only as a hash, lives 60 seconds, and one
//   `DELETE … RETURNING` spends it, whatever the verifier says;
// - the code redeems only with the verifier of the challenge the start
//   carried (S256);
// - finish refuses a session that was already in the browser when the start
//   ran: a page cannot send a signed-in browser through start and finish to
//   mint a code for a session the person did not just sign in with;
// - no token or identity is in a URL; the pair is only in the redeem body.
import {
  LEGACY_NATIVE_SIGN_IN_CALLBACK,
  NATIVE_SIGN_IN_CALLBACKS,
  NATIVE_SIGN_IN_FINISH_PATH,
  type NativeSignInCallback,
  nativeSignInHttpsCallback,
  nativeSignInRedeemSchema,
  nativeSignInStartQuerySchema,
  type OwnerSession,
  type OwnerSessionResponse,
} from './contracts';
import {
  AuthError,
  browserWebSession,
  issueNativeSession,
  OWNER_SESSION_COOKIE,
  recordOwnerDeviceVersion,
  refuseBlockedPerson,
  startGoogleWebAuth,
} from './auth';
import { parseMeetClientVersion } from './client-version';
import { constantTimeEqual, randomToken, sha256 } from './crypto';
import { json, readBoundedJSON } from './http';
import { cookie, expiredCookie, readCookie } from './http-cookies';
import { isWorkspaceMember } from './invitations';
import { REVIEW_SIGN_IN_PATH, reviewSignInOffered } from './review-sign-in';

const NATIVE_COOKIE = '__Host-meet_native';
const NATIVE_COOKIE_SECONDS = 600;
export const NATIVE_CODE_MS = 60_000;

/**
 * What the start cookie holds: the challenge, the state, the hash of the
 * session that was already there, and which callback the app named.
 */
interface NativeStart {
  challenge: string;
  state: string;
  priorSession: string;
  /** A scheme from the allowlist, or the https callback on this host. */
  callback: string;
}

/** The cookie's index for the https callback on this host: after every scheme. */
const HTTPS_CALLBACK_INDEX = String(NATIVE_SIGN_IN_CALLBACKS.length);

/**
 * The callback goes into the cookie as its index in the allowlist, so the
 * cookie never carries a URL. A cookie with no index was set before this
 * change and means the legacy callback. The https callback is always this
 * host's own, so its index is enough to rebuild it.
 */
function callbackIndex(callback: string): string {
  const scheme = NATIVE_SIGN_IN_CALLBACKS.indexOf(callback as NativeSignInCallback);
  return scheme >= 0 ? String(scheme) : HTTPS_CALLBACK_INDEX;
}

function callbackAt(index: string | undefined, origin: string): string | null {
  if (index === undefined) return LEGACY_NATIVE_SIGN_IN_CALLBACK;
  if (!/^[0-9]$/u.test(index)) return null;
  if (index === HTTPS_CALLBACK_INDEX) return nativeSignInHttpsCallback(origin);
  return NATIVE_SIGN_IN_CALLBACKS[Number(index)] ?? null;
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  headers.set('referrer-policy', 'no-referrer');
  return new Response(response.body, { status: response.status, headers });
}

/** The hash of the web session cookie the browser holds now, or `none`. */
async function sessionMark(request: Request): Promise<string> {
  const value = readCookie(request, OWNER_SESSION_COOKIE);
  return value ? sha256(value) : 'none';
}

function readStart(request: Request): NativeStart | null {
  const raw = readCookie(request, NATIVE_COOKIE);
  const [challenge, state, priorSession, index, extra] = raw?.split('.') ?? [];
  if (!challenge || !state || !priorSession || extra !== undefined) return null;
  const callback = callbackAt(index, new URL(request.url).origin);
  if (!callback) return null;
  const parsed = nativeSignInStartQuerySchema.safeParse({ code_challenge: challenge, state, callback });
  return parsed.success ? { challenge, state, priorSession, callback } : null;
}

/** `GET /api/auth/native/start`: keep the app's challenge and state, then the web sign-in. */
export async function startNativeSignIn(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const query = nativeSignInStartQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) throw new AuthError('The sign-in request is incomplete.', 400, 'oauth_failed');
  // An https callback names this host only: the code never goes to another workspace's page.
  const named = query.data.callback;
  if (named !== undefined && !(NATIVE_SIGN_IN_CALLBACKS as readonly string[]).includes(named) && named !== nativeSignInHttpsCallback(url.origin)) {
    throw new AuthError('The sign-in request is incomplete.', 400, 'oauth_failed');
  }
  const start: NativeStart = {
    challenge: query.data.code_challenge,
    state: query.data.state,
    priorSession: await sessionMark(request),
    callback: query.data.callback ?? LEGACY_NATIVE_SIGN_IN_CALLBACK,
  };
  // A workspace kept for App Review signs in with its one password instead (review-sign-in.ts).
  let response: Response;
  if (reviewSignInOffered(env)) {
    const review = new URL(REVIEW_SIGN_IN_PATH, url.origin);
    review.searchParams.set('return_to', NATIVE_SIGN_IN_FINISH_PATH);
    response = new Response(null, { status: 303, headers: { location: review.toString() } });
  } else {
    const web = new URL('/api/auth/google/start', url.origin);
    web.searchParams.set('return_to', NATIVE_SIGN_IN_FINISH_PATH);
    response = await startGoogleWebAuth(new Request(web, request), env);
  }
  const headers = new Headers(response.headers);
  headers.append('set-cookie', cookie(NATIVE_COOKIE, `${start.challenge}.${start.state}.${start.priorSession}.${callbackIndex(start.callback)}`, NATIVE_COOKIE_SECONDS));
  return noStore(new Response(response.body, { status: response.status, headers }));
}

function appCallback(callback: string, params: Record<string, string>): string {
  return `${callback}?${new URLSearchParams(params).toString()}`;
}

/**
 * `GET /api/auth/native/finish`: the web sign-in has set its session; issue
 * the app a single-use code bound to its challenge. A cancelled sign-in
 * reaches here with no new session and tells the app so.
 */
export async function finishNativeSignIn(request: Request, env: Env): Promise<Response> {
  const start = readStart(request);
  if (!start) throw new AuthError('Sign-in must finish in the window that started it.', 400, 'oauth_failed');
  const clear = expiredCookie(NATIVE_COOKIE);
  const owner = await browserWebSession(request, env);
  const fresh = owner && (await sessionMark(request)) !== start.priorSession;
  if (!owner || !fresh) {
    return redirect(appCallback(start.callback, { state: start.state, error: 'cancelled' }), clear);
  }
  const code = randomToken();
  await env.USAGE.prepare(
    `INSERT INTO native_sign_in_codes (code_hash, challenge, sub, email, name, picture, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(await sha256(code), start.challenge, owner.sub, owner.email, owner.name, owner.picture ?? null, Date.now() + NATIVE_CODE_MS).run();
  return redirect(appCallback(start.callback, { code, state: start.state }), clear);
}

function redirect(location: string, setCookie: string): Response {
  const headers = new Headers({ location });
  headers.append('set-cookie', setCookie);
  return noStore(new Response(null, { status: 303, headers }));
}

interface CodeRow {
  challenge: string;
  sub: string;
  email: string;
  name: string;
  picture: string | null;
}

/** `POST /api/auth/native/redeem`: spend the code once, check the verifier, issue the native pair. */
export async function redeemNativeSignIn(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = nativeSignInRedeemSchema.parse(await readBoundedJSON(request));
  const now = Date.now();
  // Expired rows go with any redemption; the table holds a minute at most.
  await env.USAGE.prepare('DELETE FROM native_sign_in_codes WHERE expires_at <= ?1').bind(now).run();
  const row = await env.USAGE.prepare(
    `DELETE FROM native_sign_in_codes WHERE code_hash = ?1 AND expires_at > ?2
     RETURNING challenge, sub, email, name, picture`,
  ).bind(await sha256(body.code), now).first<CodeRow>();
  const spent = new AuthError('This sign-in expired or was already used. Sign in again.', 400, 'oauth_failed');
  if (!row) throw spent;
  if (!(await constantTimeEqual(await sha256(body.code_verifier), row.challenge))) throw spent;
  const owner: OwnerSession = {
    sub: row.sub,
    email: row.email.toLowerCase(),
    name: row.name,
    ...(row.picture ? { picture: row.picture } : {}),
  };
  // The rules a web sign-in passed a minute ago, read again: the session
  // that lives 60 days is decided now.
  if (!(await isWorkspaceMember(env, owner.email))) throw new AuthError('Only an account on this workspace can sign in.', 403, 'oauth_failed');
  await refuseBlockedPerson(env, owner);
  const result = await issueNativeSession(owner, env, {
    lastClient: body.client ?? 'mac',
    deviceID: body.device_id,
    deviceLabel: body.device_name,
    ctx,
  });
  const version = parseMeetClientVersion(request.headers.get('x-meet-client'));
  if (version) {
    await recordOwnerDeviceVersion(env, result.deviceID, { platform: version.platform, appVersion: `${version.version} (${version.build})` });
  }
  return noStore(json({
    access_token: result.token,
    refresh_token: result.refreshToken,
    owner: result.owner,
  } satisfies OwnerSessionResponse));
}
