// Google OAuth toolbox, same PKCE dance Docs and Meet run. Kept as its own module so
// the staff sign-in flow in auth.ts stays about sessions, not about Google.
import { KEEP_ISSUER } from '../../../../packages/contracts/src/deployment-values';
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { AuthError } from './errors';
import { constantTimeEqual, randomToken, sha256, signingKey } from './crypto';

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

/**
 * JWT `iss`. A stable logical identifier, deliberately not tied to whatever
 * host the Worker happens to be served from — changing it invalidates every
 * live session and guest link, so it must survive a move off workers.dev.
 */
export const ISSUER = KEEP_ISSUER;

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
}

/** Mint state/nonce/PKCE material and seal it into a short-lived state JWT. */
export async function beginGoogleOAuth(options: {
  signingSecret: string;
  audience: string;
  returnTo: string;
}): Promise<{ state: string; nonce: string; challenge: string; sealedState: string }> {
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken(48);
  const challenge = await sha256(verifier);
  const sealedState = await new SignJWT({ state, nonce, verifier, returnTo: options.returnTo })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
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
    issuer: ISSUER,
    audience: options.audience,
  });
  const state = verified.payload as T;
  if (!(await constantTimeEqual(options.returnedState, state.state))) {
    throw new AuthError('OAuth state did not match.', 400, 'oauth_failed');
  }
  return state;
}

export type GoogleTokenResult = { ok: true; body: Record<string, unknown> } | { ok: false };

export async function exchangeGoogleAuthorizationCode(options: {
  code: string;
  codeVerifier: string;
  redirectURI: string;
  clientID: string;
  clientSecret?: string;
}): Promise<GoogleTokenResult> {
  const form = new URLSearchParams({
    code: options.code,
    client_id: options.clientID,
    redirect_uri: options.redirectURI,
    grant_type: 'authorization_code',
    code_verifier: options.codeVerifier,
  });
  if (options.clientSecret) form.set('client_secret', options.clientSecret);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (!response.ok) return { ok: false };
  const body = await response.json<unknown>();
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false };
  return { ok: true, body: body as Record<string, unknown> };
}

/**
 * Verify a Google ID token and require a verified identity in one of the
 * deployment's admitted domains, with the expected nonce. The `hd` check is
 * what makes this a company app: without it any Google account with a
 * company-looking address would pass. Both `hd` and the address domain must
 * be admitted. An empty `domains` admits nobody.
 */
export async function verifyWorkspaceIdentity(
  idToken: string,
  options: { audience: string; nonce: string; domains: readonly string[]; failureMessage: string },
): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(idToken, googleKeys, {
    issuer: [GOOGLE_ISSUER, 'accounts.google.com'],
    audience: options.audience,
  });
  const identity = payload as GoogleIdentity;
  if (
    typeof identity.sub !== 'string' ||
    typeof identity.email !== 'string' ||
    identity.email_verified !== true ||
    typeof identity.hd !== 'string' ||
    !options.domains.includes(identity.hd.toLowerCase()) ||
    !options.domains.includes(identity.email.slice(identity.email.lastIndexOf('@') + 1).toLowerCase()) ||
    typeof identity.nonce !== 'string' ||
    !(await constantTimeEqual(identity.nonce, options.nonce))
  ) {
    throw new AuthError(options.failureMessage, 403, 'oauth_failed');
  }
  return identity;
}

export function googleAuthorizationURL(options: {
  clientID: string;
  redirectURI: string;
  scope: string;
  state: string;
  nonce: string;
  challenge: string;
  /** Google's `hd` hint: one domain narrows the account chooser, several or none send `*`. The ID token check is the gate. */
  domains: readonly string[];
  extraParams?: Record<string, string>;
}): string {
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
    hd: options.domains.length === 1 ? options.domains[0]! : '*',
    ...options.extraParams,
  }).toString();
  return google.toString();
}
