// Three kinds of caller reach this Worker, and the difference between them is
// the whole security model:
//
//   staff  — a verified Google account on one of the deployment's identity
//            domains (`identityDomains` in identity.ts), cookie session.
//            Reads and writes everything. No per-folder ACL, by design.
//   guest  — someone holding a share token who has stated (and sometimes
//            proven) an email address. Scoped to one document or folder,
//            with a role of viewer / commenter / signer.
//   agent  — a personal access token belonging to a staff member, optionally
//            confined to a path prefix and always carrying explicit scopes.
//
// Staff sessions are cookies; guests and agents are bearer tokens. The guest
// JWT is deliberately modelled on Meet's `meet-artifact` audience: a narrow,
// short-lived credential minted from a capability the user already held.

import { jwtVerify, SignJWT } from 'jose';
import { type AgentSession, type AgentScope, type GrantRole, type GuestSession, type Principal, type StaffSession } from '@docs/contracts';
import { signingKey, sha256Hex } from './crypto';
import { AuthError } from './errors';
import {
  beginGoogleOAuth,
  exchangeGoogleAuthorizationCode,
  googleAuthorizationURL,
  ISSUER,
  unsealGoogleOAuthState,
  verifyIdentityToken,
  type OAuthStateSeal,
} from './google-oauth';
import { googleHostedDomain, isIdentityEmail, webSignIn } from './identity';
import { cookie, expiredCookie, readCookie, redirectWithCookies, safeReturnPath } from './http-cookies';

export const SESSION_COOKIE = 'docs_session';
const OAUTH_COOKIE = 'docs_oauth';
const OAUTH_STATE_AUDIENCE = 'oauth-state';
const STAFF_AUDIENCE = 'docs-staff';
const GUEST_AUDIENCE = 'docs-guest';

export const STAFF_SESSION_SECONDS = 12 * 60 * 60;
const GUEST_SESSION_SECONDS = 12 * 60 * 60;

/** Personal access tokens are recognizable on sight and greppable in logs. */
export const TOKEN_PREFIX = 'evd_';

// ---------------------------------------------------------------------------
// Staff — Google sign-in
// ---------------------------------------------------------------------------

export async function startGoogleWebAuth(request: Request, env: Env): Promise<Response> {
  ensureWebSignIn(env);
  ensureConfigured(env.GOOGLE_WEB_CLIENT_ID, 'GOOGLE_WEB_CLIENT_ID');
  const hostedDomain = googleHostedDomain(env);
  if (!hostedDomain) throw new AuthError('IDENTITY_DOMAINS is not configured.', 503, 'not_configured');
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
    hostedDomain,
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

  const identity = await verifyIdentityToken(result.body.id_token, env, {
    audience: env.GOOGLE_WEB_CLIENT_ID,
    nonce: state.nonce,
    failureMessage: 'Only verified Envisioning Google accounts can sign in to Docs.',
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

export async function getStaffSession(request: Request, env: Env): Promise<StaffSession | null> {
  const token = readCookie(request, SESSION_COOKIE) ?? bearerToken(request);
  return token ? verifyStaffToken(token, env) : null;
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
    if (!isIdentityEmail(env, payload.email)) return null;
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

/** Clear the staff session and go to `location`: the web origin, or the auth host's sign-out on a central deployment. */
export function logoutResponse(env: Env, location: string = env.WEB_ORIGIN): Response {
  return redirectWithCookies(location, [expiredCookie(SESSION_COOKIE)]);
}

// ---------------------------------------------------------------------------
// Guests — minted from a share grant
// ---------------------------------------------------------------------------

export async function signGuestSession(guest: GuestSession, env: Env): Promise<string> {
  return new SignJWT({
    grant_id: guest.grantId,
    email: guest.email,
    name: guest.name,
    role: guest.role,
    document_id: guest.documentId,
    folder_id: guest.folderId,
    verified: guest.verified,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(GUEST_AUDIENCE)
    .setSubject(guest.email)
    .setIssuedAt()
    .setExpirationTime(`${GUEST_SESSION_SECONDS}s`)
    .sign(signingKey(env.SESSION_SIGNING_SECRET));
}

export async function getGuestSession(request: Request, env: Env): Promise<GuestSession | null> {
  const token = bearerToken(request);
  return token ? verifyGuestToken(token, env) : null;
}

async function verifyGuestToken(token: string, env: Env): Promise<GuestSession | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey(env.SESSION_SIGNING_SECRET), {
      issuer: ISSUER,
      audience: GUEST_AUDIENCE,
    });
    if (
      typeof payload.grant_id !== 'string' ||
      typeof payload.email !== 'string' ||
      (payload.role !== 'viewer' && payload.role !== 'commenter' && payload.role !== 'signer')
    ) {
      return null;
    }
    return {
      grantId: payload.grant_id,
      email: payload.email,
      ...(typeof payload.name === 'string' ? { name: payload.name } : {}),
      role: payload.role as GrantRole,
      documentId: typeof payload.document_id === 'string' ? payload.document_id : null,
      folderId: typeof payload.folder_id === 'string' ? payload.folder_id : null,
      verified: payload.verified === true,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agents — personal access tokens
// ---------------------------------------------------------------------------

export async function getAgentSession(request: Request, env: Env): Promise<AgentSession | null> {
  const token = bearerToken(request);
  if (!token?.startsWith(TOKEN_PREFIX)) return null;

  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT id, owner, agent_name, scopes, path_prefix, expires_at, revoked_at
       FROM api_tokens WHERE token_hash = ?`,
  )
    .bind(hash)
    .first<{
      id: string;
      owner: string;
      agent_name: string | null;
      scopes: string;
      path_prefix: string | null;
      expires_at: string | null;
      revoked_at: string | null;
    }>();

  if (!row || row.revoked_at) return null;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;

  // Fire-and-forget: a failed last_used_at write must never fail the request.
  void env.DB.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), row.id)
    .run()
    .catch(() => {});

  let scopes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.scopes);
    if (Array.isArray(parsed)) scopes = parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    scopes = [];
  }

  return {
    tokenId: row.id,
    owner: row.owner,
    agentName: row.agent_name,
    scopes,
    pathPrefix: row.path_prefix,
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve whichever credential the request carries.
 *
 * An explicit bearer token always beats the ambient session cookie, and a
 * bearer that verifies as nothing fails outright rather than falling back to
 * the cookie. Two things depend on that:
 *
 *   - An agent running on a machine where someone is signed in must not be
 *     silently upgraded to full staff rights by a stale cookie.
 *   - Someone at Envisioning who is sent a signing link has to act *as the
 *     signer*. With the cookie winning, they would resolve as staff and the
 *     sign route would refuse them in their own browser.
 */
export async function resolvePrincipal(request: Request, env: Env): Promise<Principal | null> {
  const bearer = bearerToken(request);
  if (bearer) {
    if (bearer.startsWith(TOKEN_PREFIX)) {
      const agent = await getAgentSession(request, env);
      return agent ? { kind: 'agent', agent } : null;
    }
    const staff = await verifyStaffToken(bearer, env);
    if (staff) return { kind: 'staff', staff };
    const guest = await verifyGuestToken(bearer, env);
    return guest ? { kind: 'guest', guest } : null;
  }

  const cookie = readCookie(request, SESSION_COOKIE);
  if (!cookie) return null;
  const staff = await verifyStaffToken(cookie, env);
  return staff ? { kind: 'staff', staff } : null;
}

export function requirePrincipal(principal: Principal | null): Principal {
  if (!principal) throw new AuthError('Sign in to continue.', 401, 'unauthorized');
  return principal;
}

export function requireStaff(principal: Principal | null): StaffSession {
  const resolved = requirePrincipal(principal);
  if (resolved.kind !== 'staff') throw new AuthError('This action is for Envisioning accounts.', 403, 'forbidden');
  return resolved.staff;
}

/** Staff, or an agent holding the named scope. The everyday write guard. */
export function requireWriter(principal: Principal | null, scope: AgentScope): { actor: string; kind: 'human' | 'agent'; agentName: string | null } {
  const resolved = requirePrincipal(principal);
  if (resolved.kind === 'staff') {
    return { actor: resolved.staff.email, kind: 'human', agentName: null };
  }
  if (resolved.kind === 'agent') {
    assertScope(resolved.agent, scope);
    return { actor: resolved.agent.owner, kind: 'agent', agentName: resolved.agent.agentName };
  }
  throw new AuthError('This action is for Envisioning accounts.', 403, 'forbidden');
}

export function assertScope(agent: AgentSession, scope: AgentScope): void {
  if (!agent.scopes.includes(scope)) {
    throw new AuthError(`This token is missing the \`${scope}\` scope.`, 403, 'forbidden');
  }
}

/** A path-confined token may only touch documents under its prefix. */
export function assertPathAllowed(principal: Principal, path: string): void {
  if (principal.kind !== 'agent') return;
  const prefix = principal.agent.pathPrefix;
  if (!prefix) return;
  if (path === prefix || path.startsWith(`${prefix}/`)) return;
  throw new AuthError(`This token is confined to ${prefix}.`, 403, 'forbidden');
}

export function actorOf(principal: Principal): { actor: string; actorKind: 'staff' | 'guest' | 'agent' } {
  switch (principal.kind) {
    case 'staff':
      return { actor: principal.staff.email, actorKind: 'staff' };
    case 'guest':
      return { actor: principal.guest.email, actorKind: 'guest' };
    case 'agent':
      return { actor: principal.agent.owner, actorKind: 'agent' };
  }
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  return authorization.slice(7).trim() || null;
}

/**
 * A workspace deployment has no web sign-in (`WEB_SIGN_IN=off`): its people
 * arrive through their workspace's Meet Worker. Both Google routes refuse
 * before they read a cookie or mint anything.
 */
function ensureWebSignIn(env: Env): void {
  // The Google routes serve the `google` deployment only. A `central` one
  // signs in through the auth host and holds no Google client.
  if (webSignIn(env) !== 'google') {
    throw new AuthError('Web sign-in is not configured on this deployment.', 503, 'not_configured');
  }
}

function ensureConfigured(value: string, name: string): void {
  if (!value || value.startsWith('replace-with-')) {
    throw new AuthError(`${name} is not configured.`, 503, 'not_configured');
  }
}
