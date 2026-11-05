// Two ways to prove who is asking, both ending in the same `StaffSession`:
//
//   cookie  — a verified Google sign-in in the browser, in an admitted
//             domain (`identity.ts`). Off on a workspace deployment.
//   bearer  — an `evk_` device token, minted for the native Meet client
//             after the Meet Worker proved the same Google identity.
//
// No guests. An `evk_` token with scope `agent` names an agent, not a
// person (tokens.ts, ADR 0007); the router keeps it to `/api/agent/*`. A
// session proves *who is asking*. It does not open anything: opening a
// vault needs the member's private key, which only their client holds.

import { jwtVerify, SignJWT } from 'jose';
import type { StaffSession } from '@keep/contracts';
import { signingKey } from './crypto';
import { AuthError } from './errors';
import {
  beginGoogleOAuth,
  exchangeGoogleAuthorizationCode,
  googleAuthorizationURL,
  ISSUER,
  unsealGoogleOAuthState,
  verifyWorkspaceIdentity,
  type OAuthStateSeal,
} from './google-oauth';
import { identityDomains, isAdmittedEmail, webSignInEnabled } from './identity';
import { cookie, expiredCookie, readCookie, redirectWithCookies, safeReturnPath } from './http-cookies';
import { principalFromDeviceToken, type Principal } from './tokens';

export const SESSION_COOKIE = 'keep_session';
const OAUTH_COOKIE = 'keep_oauth';
const OAUTH_STATE_AUDIENCE = 'oauth-state';
const STAFF_AUDIENCE = 'keep-staff';

/** Shorter than Docs: a password manager's session should not outlive a workday. */
export const STAFF_SESSION_SECONDS = 8 * 60 * 60;

export async function startGoogleWebAuth(request: Request, env: Env): Promise<Response> {
  ensureWebSignIn(env);
  ensureConfigured(env.GOOGLE_WEB_CLIENT_ID, 'GOOGLE_WEB_CLIENT_ID');
  const url = new URL(request.url);
  const returnTo = safeReturnPath(url.searchParams.get('return_to'));
  const oauth = await beginGoogleOAuth({
    signingSecret: env.SESSION_SIGNING_SECRET,
    audience: OAUTH_STATE_AUDIENCE,
    returnTo,
  });
  const google = googleAuthorizationURL({
    clientID: env.GOOGLE_WEB_CLIENT_ID,
    redirectURI: `${env.PUBLIC_API_ORIGIN}/api/auth/google/callback`,
    scope: 'openid email profile',
    state: oauth.state,
    nonce: oauth.nonce,
    challenge: oauth.challenge,
    domains: identityDomains(env),
    extraParams: { prompt: 'select_account' },
  });
  return redirectWithCookies(google, [cookie(OAUTH_COOKIE, oauth.sealedState, 600)]);
}

export async function completeGoogleWebAuth(request: Request, env: Env): Promise<Response> {
  ensureWebSignIn(env);
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const sealedState = readCookie(request, OAUTH_COOKIE);
  if (!code || !returnedState || !sealedState) {
    throw new AuthError('The Google sign-in response is incomplete.', 400, 'oauth_failed');
  }

  const state = await unsealGoogleOAuthState<OAuthStateSeal>({
    sealedState,
    returnedState,
    signingSecret: env.SESSION_SIGNING_SECRET,
    audience: OAUTH_STATE_AUDIENCE,
  });

  const result = await exchangeGoogleAuthorizationCode({
    code,
    codeVerifier: state.verifier,
    redirectURI: `${env.PUBLIC_API_ORIGIN}/api/auth/google/callback`,
    clientID: env.GOOGLE_WEB_CLIENT_ID,
    clientSecret: env.GOOGLE_WEB_CLIENT_SECRET,
  });
  if (!result.ok) throw new AuthError('Google rejected the authorization code.', 401, 'oauth_failed');
  if (typeof result.body.id_token !== 'string') {
    throw new AuthError('Google did not return an identity token.', 401, 'oauth_failed');
  }

  const identity = await verifyWorkspaceIdentity(result.body.id_token, {
    audience: env.GOOGLE_WEB_CLIENT_ID,
    nonce: state.nonce,
    domains: identityDomains(env),
    failureMessage: 'Only verified company Google accounts can sign in to Keep.',
  });

  const staff: StaffSession = {
    sub: identity.sub,
    email: identity.email.toLowerCase(),
    name: typeof identity.name === 'string' ? identity.name : identity.email,
    ...(typeof identity.picture === 'string' ? { picture: identity.picture } : {}),
  };

  const session = await signStaffSession(staff, env);
  return redirectWithCookies(`${env.WEB_ORIGIN}${state.returnTo}`, [
    cookie(SESSION_COOKIE, session, STAFF_SESSION_SECONDS),
    expiredCookie(OAUTH_COOKIE),
  ]);
}

export async function signStaffSession(staff: StaffSession, env: Env): Promise<string> {
  return new SignJWT({ email: staff.email, name: staff.name, picture: staff.picture })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(STAFF_AUDIENCE)
    .setSubject(staff.sub)
    .setIssuedAt()
    .setExpirationTime(`${STAFF_SESSION_SECONDS}s`)
    .sign(signingKey(env.SESSION_SIGNING_SECRET));
}

/**
 * A bearer token wins over the cookie, and a bearer that verifies as nothing
 * fails outright rather than falling back — a device must never be silently
 * upgraded by a stale cookie in the same request.
 */
export async function getPrincipal(request: Request, env: Env): Promise<Principal | null> {
  const bearer = bearerToken(request);
  if (bearer) return principalFromDeviceToken(env, bearer);
  const token = readCookie(request, SESSION_COOKIE);
  const session = token ? await verifyStaffToken(token, env) : null;
  return session ? { kind: 'person', session } : null;
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  return authorization.slice(7).trim() || null;
}

async function verifyStaffToken(token: string, env: Env): Promise<StaffSession | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey(env.SESSION_SIGNING_SECRET), {
      issuer: ISSUER,
      audience: STAFF_AUDIENCE,
    });
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string' || typeof payload.name !== 'string') {
      return null;
    }
    // Belt and braces: the domain was checked at sign-in, but a session that
    // outlives someone leaving should not be the thing that decides.
    if (!isAdmittedEmail(env, payload.email)) return null;
    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      ...(typeof payload.picture === 'string' ? { picture: payload.picture } : {}),
    };
  } catch {
    return null;
  }
}

export function logoutResponse(env: Env): Response {
  return redirectWithCookies(env.WEB_ORIGIN, [expiredCookie(SESSION_COOKIE)]);
}

export function requireStaff(principal: Principal | null): StaffSession {
  if (!principal) throw new AuthError('Sign in to continue.', 401, 'unauthorized');
  if (principal.kind !== 'person') throw new AuthError('An agent token reaches only the agent routes.', 403, 'forbidden');
  return principal.session;
}

/** A deployment with web sign-in off mints no cookie: it answers 503 before it touches Google. */
function ensureWebSignIn(env: Env): void {
  if (!webSignInEnabled(env)) {
    throw new AuthError('Web sign-in is off on this deployment. Use the Meet app.', 503, 'not_configured');
  }
}

function ensureConfigured(value: string, name: string): void {
  if (!value || value.startsWith('replace-with-')) {
    throw new AuthError(`${name} is not configured.`, 503, 'not_configured');
  }
}
