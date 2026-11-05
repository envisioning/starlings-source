// Shared Google OAuth toolbox for the owner sign-in flow (auth.ts), the
// incremental Calendar consent flow (calendar.ts), and the connector grants
// (google-grants.ts). All three run the same PKCE dance against the same
// endpoints with the same identity requirements; only scopes, audiences,
// clients, and error copy differ. The starlings-auth Worker bundles this
// file too, so it imports nothing that reaches the contracts index;
// the workspace's domain rule, `verifyMemberIdentity`, lives in
// workspace-identity.ts.
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { AuthError } from './errors';
import { constantTimeEqual, randomToken, sha256, signingKey } from './crypto';
import { ACCEPTED_SESSION_ISSUERS, SESSION_ISSUER } from './session-keys';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export interface GoogleIdentity extends JWTPayload {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
  hd?: string;
  nonce?: string;
}

export interface OAuthStateSeal extends JWTPayload {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  webOrigin?: string;
  callbackOrigin?: string;
}

/** Mint state/nonce/PKCE material and seal it into a short-lived state JWT. */
export async function beginGoogleOAuth(options: {
  signingSecret: string;
  audience: string;
  returnTo: string;
  extraClaims?: Record<string, string>;
}): Promise<{ state: string; nonce: string; challenge: string; sealedState: string }> {
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  const challenge = await sha256(verifier);
  const sealedState = await new SignJWT({ state, nonce, verifier, returnTo: options.returnTo, ...options.extraClaims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(SESSION_ISSUER)
    .setAudience(options.audience)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey(options.signingSecret));
  return { state, nonce, challenge, sealedState };
}

/** Verify the sealed state JWT and the returned `state` echo. */
export async function unsealGoogleOAuthState<T extends OAuthStateSeal>(options: {
  sealedState: string;
  returnedState: string;
  signingSecret: string;
  audience: string;
}): Promise<T> {
  const verified = await jwtVerify(options.sealedState, signingKey(options.signingSecret), {
    issuer: ACCEPTED_SESSION_ISSUERS,
    audience: options.audience,
  });
  const state = verified.payload as T;
  if (!await constantTimeEqual(options.returnedState, state.state)) {
    throw new AuthError('OAuth state did not match.', 400, 'oauth_failed');
  }
  return state;
}

export type GoogleTokenResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Exchange an authorization code at Google's token endpoint. A PKCE flow
 * sends its verifier. An Android `serverAuthCode` has none and no redirect:
 * its `redirectURI` is the empty string, and the client secret proves the
 * caller instead.
 */
export async function exchangeGoogleAuthorizationCode(options: {
  code: string;
  codeVerifier?: string | undefined;
  redirectURI: string;
  clientID: string;
  clientSecret?: string | undefined;
}): Promise<GoogleTokenResult> {
  const form = new URLSearchParams({
    code: options.code,
    client_id: options.clientID,
    redirect_uri: options.redirectURI,
    grant_type: 'authorization_code',
  });
  if (options.codeVerifier) form.set('code_verifier', options.codeVerifier);
  if (options.clientSecret) form.set('client_secret', options.clientSecret);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!response.ok) {
    // Google's own words — `invalid_grant` (reused/expired code, wrong
    // verifier), `redirect_uri_mismatch`, `invalid_client` (missing or stale
    // secret) all arrive as the same 4xx here. Dropping the body left every
    // one of them looking identical from the outside; callers log `reason`.
    const detail = await response.text().catch(() => '');
    return { ok: false, reason: `${response.status} ${detail.slice(0, 500)}`.trim() };
  }
  const body = await response.json<unknown>();
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'token endpoint returned a non-object body' };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

/**
 * The same proof of a real, verified Google sign-in this app started — signature,
 * audience, nonce, verified address — without the Envisioning domain rule.
 *
 * Use this where the account is being attached as data (a calendar to read),
 * and in the central auth Worker (src/auth-worker/google.ts), which proves an
 * identity but issues no session. Host identity stays the workspace's: the
 * direct sign-in paths call `verifyMemberIdentity`, and a workspace
 * applies the same domain rule to a central result (`completeCentralWebAuth`)
 * before it sets a session.
 */
export async function verifyGoogleIdentity(idToken: string, options: {
  audience: string;
  /**
   * The nonce this app sent. `null` only for an ID token this Worker took
   * from Google's token endpoint itself, in this request, for a code its own
   * client secret redeemed (an Android `serverAuthCode`). Google's request
   * there carries no nonce, and the token never passed through a client
   * that could replay it.
   */
  nonce: string | null;
  failureMessage: string;
}): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(idToken, googleKeys, {
    issuer: [GOOGLE_ISSUER, 'accounts.google.com'],
    audience: options.audience,
  });
  const identity = payload as GoogleIdentity;
  if (
    typeof identity.sub !== 'string' || typeof identity.email !== 'string'
    || identity.email_verified !== true
    || (options.nonce !== null
      && (typeof identity.nonce !== 'string' || !await constantTimeEqual(identity.nonce, options.nonce)))
  ) {
    throw new AuthError(options.failureMessage, 403, 'oauth_failed');
  }
  return identity;
}

/** Build the accounts.google.com authorization URL. */
export function googleAuthorizationURL(options: {
  clientID: string;
  redirectURI: string;
  scope: string;
  state: string;
  nonce: string;
  challenge: string;
  /**
   * Which Google accounts the picker offers: the workspace's
   * `signInDomain(env)`, so a first sign-in is offered this workspace's
   * accounts and nothing else — `*` would still list every other Workspace
   * the browser knows about. The picker is a filter, not the gate:
   * verifyMemberIdentity (workspace-identity.ts) is what actually decides, and it still admits every
   * identity domain.
   *
   * Pass `null` only for attaching a calendar account: a personal address has
   * no hosted domain at all, so `hd` must be absent rather than set, which
   * would shut out exactly the accounts that flow is for.
   */
  hostedDomain: string | null;
  extraParams?: Record<string, string>;
}): string {
  const hostedDomain = options.hostedDomain;
  const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  google.search = new URLSearchParams({
    client_id: options.clientID,
    redirect_uri: options.redirectURI,
    response_type: 'code',
    scope: options.scope,
    state: options.state,
    nonce: options.nonce,
    code_challenge: options.challenge,
    code_challenge_method: 'S256',
    ...(hostedDomain ? { hd: hostedDomain } : {}),
    ...options.extraParams,
  }).toString();
  return google.toString();
}

export type GoogleRefreshResult =
  | { ok: true; accessToken: string; refreshToken: string | null; scope: string | null; expiresInSeconds: number | null }
  /** `error` is Google's code (`invalid_grant` is a dead token), never a token. */
  | { ok: false; status: number; error: string };

/** Mint an access token from a stored refresh token. The caller decides what a failure means. */
export async function refreshGoogleAccessToken(options: {
  refreshToken: string;
  clientID: string;
  clientSecret?: string | undefined;
}): Promise<GoogleRefreshResult> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    client_id: options.clientID,
  });
  if (options.clientSecret) form.set('client_secret', options.clientSecret);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  let body: unknown = null;
  try {
    body = await response.json<unknown>();
  } catch {
    body = null;
  }
  const record = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (!response.ok) {
    return { ok: false, status: response.status, error: typeof record.error === 'string' ? record.error : '' };
  }
  if (typeof record.access_token !== 'string') {
    return { ok: false, status: 502, error: 'no_access_token' };
  }
  return {
    ok: true,
    accessToken: record.access_token,
    // Google may rotate the refresh token. A new one replaces the stored one.
    refreshToken: typeof record.refresh_token === 'string' && record.refresh_token.length > 0 ? record.refresh_token : null,
    scope: typeof record.scope === 'string' ? record.scope : null,
    expiresInSeconds: typeof record.expires_in === 'number' && Number.isFinite(record.expires_in) ? record.expires_in : null,
  };
}

/**
 * Revoke at Google. Best effort: the local copy goes either way.
 *
 * Google revokes the whole grant, not one token's scopes: every scope the
 * person gave this Google Cloud project goes, from every client in it.
 */
export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // Nothing to do about a revoke that fails; the token still stops being ours.
  }
}

/**
 * The Google clients the Mac and iPhone apps sign in with: the Meet apps'
 * (`GOOGLE_NATIVE_CLIENT_ID`) and the Starlings apps'
 * (`GOOGLE_NATIVE_CLIENT_ID_STARLINGS`). An empty or placeholder
 * value is not a client.
 */
export function nativeGoogleClientIDs(env: Pick<Env, 'GOOGLE_NATIVE_CLIENT_ID' | 'GOOGLE_NATIVE_CLIENT_ID_STARLINGS'>): string[] {
  return [env.GOOGLE_NATIVE_CLIENT_ID, env.GOOGLE_NATIVE_CLIENT_ID_STARLINGS]
    .map((id) => id?.trim() ?? '')
    .filter((id) => id !== '' && !id.startsWith('replace-with-'));
}

const NATIVE_REDIRECT_PREFIX = 'com.googleusercontent.apps.';
const NATIVE_CLIENT_SUFFIX = '.apps.googleusercontent.com';

/**
 * The native client a code was issued to, read from the app's redirect URI.
 * An installed app's redirect is its client's reversed ID
 * (`com.googleusercontent.apps.<id>:/oauth/callback` for client
 * `<id>.apps.googleusercontent.com`), so the scheme names the client. The
 * client must be one of `nativeGoogleClientIDs` exactly; anything else is
 * null, and the caller refuses the request.
 */
export function nativeGoogleClientFor(
  env: Pick<Env, 'GOOGLE_NATIVE_CLIENT_ID' | 'GOOGLE_NATIVE_CLIENT_ID_STARLINGS'>,
  redirectURI: string,
): string | null {
  const colon = redirectURI.indexOf(':');
  if (colon <= 0) return null;
  const scheme = redirectURI.slice(0, colon).toLowerCase();
  if (!scheme.startsWith(NATIVE_REDIRECT_PREFIX)) return null;
  const prefix = scheme.slice(NATIVE_REDIRECT_PREFIX.length);
  if (!/^[a-z0-9-]+$/u.test(prefix)) return null;
  const candidate = `${prefix}${NATIVE_CLIENT_SUFFIX}`;
  return nativeGoogleClientIDs(env).find((id) => id.toLowerCase() === candidate) ?? null;
}
