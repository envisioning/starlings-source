import { signInDomain, verifyMemberIdentity } from './workspace-identity';
import { workspaceOAuthOrigins, restoreWorkspaceOAuthOrigins } from './workspace-origins';
// The Google connector grant (docs/CONNECTORS.md).
//
// A member gives Meet read access to their own Gmail or Drive here. The
// imports themselves read through `googleAccessToken`;
// nothing in this file reads a mailbox or a file.
//
// Why one grant and not one per product: Google revokes a grant whole. A
// revoke takes every scope the person gave the Google Cloud project, from
// every client in it. So Gmail and Drive are scopes on one grant, adding a
// product is incremental consent on the same grant, and Disconnect removes
// both. For the same reason the connector has its own Google Cloud project
// and OAuth client (GOOGLE_CONNECTOR_CLIENT_ID): on the sign-in project, a
// Gmail disconnect would also revoke Calendar.
//
// The consent screen is Internal. `gmail.readonly` and `drive.readonly` are
// restricted scopes, and only an Internal app avoids Google's security
// assessment. The hosted-domain filter and `verifyEnvisioningIdentity` keep
// the grant to the member's own Envisioning account.
import {
  GOOGLE_GRANT_PRODUCTS,
  type GoogleGrantProduct,
  type GoogleGrantResponse,
  type GoogleGrantStartQuery,
  type OwnerSession,
} from './contracts';
import { openSecret, sealSecret } from './crypto';
import { ControlError } from './errors';
import {
  beginGoogleOAuth,
  exchangeGoogleAuthorizationCode,
  googleAuthorizationURL,
  refreshGoogleAccessToken,
  revokeGoogleToken,
  unsealGoogleOAuthState,
  type OAuthStateSeal,
} from './google-oauth';
import { cookie, expiredCookie, readCookie, redirectWithCookies, safeReturnPath } from './http-cookies';
import { GOOGLE_GRANT_SCOPES } from './google-scopes';
import { beginCentralAuth, centralConsent, redeemCentralAuth, usesCentralAuth } from './central-auth';

export class GoogleGrantError extends ControlError {}

/** The read scope each product needs (google-scopes.ts). */
const PRODUCT_SCOPES = GOOGLE_GRANT_SCOPES;

const STATE_AUDIENCE = 'google-grant-state';
const OAUTH_COOKIE = 'meet_google_grant_oauth';

interface GrantState extends OAuthStateSeal {
  ownerSub: string;
  product: GoogleGrantProduct;
}

interface GrantRow {
  sub: string;
  email: string;
  iv: string;
  ciphertext: string;
  scopes: string;
  granted_at: number;
  used_at: number | null;
}

function usable(value: string | undefined): value is string {
  return Boolean(value?.trim()) && !value!.startsWith('replace-with-');
}

/** True when this deployment has the connector's OAuth client and a key to seal tokens with. */
export function googleGrantConfigured(env: Env): boolean {
  return usable(env.GOOGLE_CONNECTOR_CLIENT_ID)
    && usable(env.GOOGLE_CONNECTOR_CLIENT_SECRET)
    && usable(env.GOOGLE_TOKEN_ENCRYPTION_KEY);
}

function assertConfigured(env: Env): void {
  if (!googleGrantConfigured(env)) {
    throw new GoogleGrantError('The Google connector is not set up on this deployment.', 503, 'not_configured');
  }
}

function redirectURI(origin: string): string {
  return `${origin}/api/connectors/google/connect/callback`;
}

/** The products whose scope appears in Google's space-separated scope list. */
function productsOf(scopes: string): GoogleGrantProduct[] {
  const granted = new Set(scopes.split(/\s+/u).filter(Boolean));
  return GOOGLE_GRANT_PRODUCTS.filter((product) => granted.has(PRODUCT_SCOPES[product]));
}

async function readGrant(env: Env, sub: string): Promise<GrantRow | null> {
  return env.USAGE.prepare(
    'SELECT sub, email, iv, ciphertext, scopes, granted_at, used_at FROM google_grants WHERE sub = ?1',
  ).bind(sub).first<GrantRow>();
}

async function writeGrant(env: Env, sub: string, email: string, refreshToken: string, scopes: string): Promise<void> {
  const sealed = await sealSecret(env.GOOGLE_TOKEN_ENCRYPTION_KEY, refreshToken);
  await env.USAGE.prepare(
    `INSERT INTO google_grants (sub, email, iv, ciphertext, scopes, granted_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(sub) DO UPDATE SET
       email = excluded.email, iv = excluded.iv, ciphertext = excluded.ciphertext,
       scopes = excluded.scopes, granted_at = excluded.granted_at`,
  ).bind(sub, email, sealed.iv, sealed.ciphertext, scopes, Date.now()).run();
}

export async function googleGrantStatus(env: Env, owner: OwnerSession): Promise<GoogleGrantResponse> {
  const row = await readGrant(env, owner.sub);
  return {
    configured: googleGrantConfigured(env),
    grant: row ? { email: row.email, products: productsOf(row.scopes), granted_at: row.granted_at } : null,
  };
}

/**
 * Send the member to Google for one product's scope. `include_granted_scopes`
 * keeps the product they already gave, so adding Drive to Gmail is one more
 * consent on the same grant, never a second grant.
 */
export async function startGoogleGrant(env: Env, owner: OwnerSession, query: GoogleGrantStartQuery, request?: Request): Promise<Response> {
  assertConfigured(env);
  if (request && usesCentralAuth(request, env)) {
    return beginCentralAuth(request, env, 'google-grant', {
      returnTo: safeReturnPath(query.return_to ?? null),
      owner,
      product: query.product,
    });
  }
  const origins = request ? workspaceOAuthOrigins(request, env) : { webOrigin: env.WEB_ORIGIN, callbackOrigin: env.PUBLIC_API_ORIGIN };
  const oauth = await beginGoogleOAuth({
    signingSecret: env.SESSION_SIGNING_SECRET,
    audience: STATE_AUDIENCE,
    returnTo: safeReturnPath(query.return_to ?? null),
    extraClaims: { ownerSub: owner.sub, product: query.product, ...origins },
  });
  const google = googleAuthorizationURL({
    clientID: env.GOOGLE_CONNECTOR_CLIENT_ID,
    redirectURI: redirectURI(origins.callbackOrigin),
    scope: `openid email ${PRODUCT_SCOPES[query.product]}`,
    state: oauth.state,
    nonce: oauth.nonce,
    challenge: oauth.challenge,
    hostedDomain: signInDomain(env),
    extraParams: {
      access_type: 'offline',
      include_granted_scopes: 'true',
      // Without a fresh consent Google returns no refresh token for a grant it already holds.
      prompt: 'consent',
      login_hint: owner.email,
    },
  });
  return redirectWithCookies(google, [cookie(OAUTH_COOKIE, oauth.sealedState, 600)]);
}

export async function completeGoogleGrant(request: Request, env: Env, owner: OwnerSession): Promise<Response> {
  assertConfigured(env);
  const url = new URL(request.url);
  const returnedState = url.searchParams.get('state');
  const sealedState = readCookie(request, OAUTH_COOKIE);
  if (!returnedState || !sealedState) {
    throw new GoogleGrantError('The Google response is incomplete.', 400, 'oauth_failed');
  }
  const state = await unsealGoogleOAuthState<GrantState>({
    sealedState,
    returnedState,
    signingSecret: env.SESSION_SIGNING_SECRET,
    audience: STATE_AUDIENCE,
  });
  if (state.ownerSub !== owner.sub) {
    throw new GoogleGrantError('Connect Google with the account you are signed in with.', 403, 'oauth_failed');
  }
  const origins = restoreWorkspaceOAuthOrigins(request, env, state);
  const back = `${origins.webOrigin}${state.returnTo}`;

  // The member said no on Google's screen. Nothing to store; back where they were.
  const code = url.searchParams.get('code');
  if (!code) return redirectWithCookies(back, [expiredCookie(OAUTH_COOKIE)]);

  await applyGoogleGrantConsent(env, owner, {
    code,
    verifier: state.verifier,
    nonce: state.nonce,
    redirectURI: redirectURI(origins.callbackOrigin),
  });
  return redirectWithCookies(back, [expiredCookie(OAUTH_COOKIE)]);
}

/**
 * The end of a central connector consent (docs/CENTRAL_AUTH.md). This
 * workspace exchanges the Google code itself, so the refresh token never
 * leaves it.
 */
export async function completeCentralGoogleGrant(request: Request, env: Env, owner: OwnerSession): Promise<Response> {
  assertConfigured(env);
  const redeemed = await redeemCentralAuth(request, env, 'google-grant', owner.sub);
  if (redeemed.result.kind !== 'cancelled') {
    await applyGoogleGrantConsent(env, owner, centralConsent(redeemed.result, env, 'google-grant', env.GOOGLE_CONNECTOR_CLIENT_ID));
  }
  return redeemed.redirect();
}

async function applyGoogleGrantConsent(
  env: Env,
  owner: OwnerSession,
  consent: { code: string; verifier: string; nonce: string; redirectURI: string },
): Promise<void> {
  const result = await exchangeGoogleAuthorizationCode({
    code: consent.code,
    codeVerifier: consent.verifier,
    redirectURI: consent.redirectURI,
    clientID: env.GOOGLE_CONNECTOR_CLIENT_ID,
    clientSecret: env.GOOGLE_CONNECTOR_CLIENT_SECRET,
  });
  if (!result.ok) {
    console.error(JSON.stringify({ level: 'error', message: 'google.grant.exchange_rejected', reason: result.reason }));
    throw new GoogleGrantError('Google rejected the authorization code.', 401, 'oauth_failed');
  }
  const body = result.body;
  if (typeof body.id_token !== 'string' || typeof body.refresh_token !== 'string' || typeof body.scope !== 'string') {
    throw new GoogleGrantError(
      'Google did not return a lasting grant. Remove Meet in your Google Account permissions and connect again.',
      400,
      'oauth_failed',
    );
  }
  const identity = await verifyMemberIdentity(env, body.id_token, {
    audience: env.GOOGLE_CONNECTOR_CLIENT_ID,
    nonce: consent.nonce,
    failureMessage: 'Only your own Google account on this workspace can be connected.',
  });
  if (identity.sub !== owner.sub || identity.email.toLowerCase() !== owner.email.toLowerCase()) {
    // The token is for somebody else's account. It is not ours to keep.
    await revokeGoogleToken(body.refresh_token);
    throw new GoogleGrantError('Connect Google with the account you are signed in with.', 403, 'oauth_failed');
  }

  // Google's granular consent lets a member untick a scope. What is stored is
  // what Google reports, never what was asked for.
  await writeGrant(env, owner.sub, identity.email.toLowerCase(), body.refresh_token, body.scope);
  console.log(JSON.stringify({ level: 'info', message: 'google.grant.stored', products: productsOf(body.scope) }));
}

/** Revoke at Google and forget the token, in the same request. Every product goes. */
export async function disconnectGoogleGrant(env: Env, owner: OwnerSession): Promise<GoogleGrantResponse> {
  const row = await readGrant(env, owner.sub);
  if (row) {
    try {
      await revokeGoogleToken(await openSecret(env.GOOGLE_TOKEN_ENCRYPTION_KEY, row));
    } catch {
      // A token that no longer opens has nothing left to revoke.
    }
    await env.USAGE.prepare('DELETE FROM google_grants WHERE sub = ?1').bind(owner.sub).run();
  }
  return googleGrantStatus(env, owner);
}

/**
 * An access token for one member and one product, for the imports. Refuses
 * a product the member did not grant. A dead grant (`invalid_grant`: revoked
 * at Google, or the password changed) is forgotten, so the member sees
 * "not connected" rather than a failure that repeats every hour.
 */
export async function googleAccessToken(env: Env, sub: string, product: GoogleGrantProduct): Promise<string> {
  assertConfigured(env);
  const row = await readGrant(env, sub);
  if (!row || !productsOf(row.scopes).includes(product)) {
    throw new GoogleGrantError(`Connect ${product === 'gmail' ? 'Gmail' : 'Drive'} in Settings first.`, 409, 'invalid_request');
  }
  const result = await refreshGoogleAccessToken({
    refreshToken: await openSecret(env.GOOGLE_TOKEN_ENCRYPTION_KEY, row),
    clientID: env.GOOGLE_CONNECTOR_CLIENT_ID,
    clientSecret: env.GOOGLE_CONNECTOR_CLIENT_SECRET,
  });
  if (!result.ok) {
    console.warn(JSON.stringify({ level: 'warn', message: 'google.grant.refresh_failed', status: result.status, reason: result.error }));
    if (result.error === 'invalid_grant') {
      await env.USAGE.prepare('DELETE FROM google_grants WHERE sub = ?1').bind(sub).run();
      throw new GoogleGrantError('Google access expired. Connect again in Settings.', 401, 'oauth_failed');
    }
    throw new GoogleGrantError('Google did not answer. Try again in a moment.', 502, 'internal_error');
  }
  if (result.refreshToken) {
    // A rotated token replaces the stored one. The grant itself did not change.
    const sealed = await sealSecret(env.GOOGLE_TOKEN_ENCRYPTION_KEY, result.refreshToken);
    await env.USAGE.prepare('UPDATE google_grants SET iv = ?2, ciphertext = ?3 WHERE sub = ?1')
      .bind(sub, sealed.iv, sealed.ciphertext).run();
  }
  await env.USAGE.prepare('UPDATE google_grants SET used_at = ?2 WHERE sub = ?1').bind(sub, Date.now()).run();
  return result.accessToken;
}
