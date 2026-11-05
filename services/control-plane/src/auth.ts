import { optionalSecret } from './shared-secrets';
import { isDomainAdmitted, isMemberHostedDomain, isRootAdminEmail, mappedRoomFor, signInDomain, verifyMemberIdentity } from './workspace-identity';
import { workspaceOAuthOrigins, restoreWorkspaceOAuthOrigins } from './workspace-origins';
import { SignJWT, type JWTPayload } from 'jose';
import { ACCEPTED_SESSION_ISSUERS, SESSION_ISSUER, signSessionJwt, verifySessionJwt } from './session-keys';
import { AuthError, ControlError } from './errors';
import { PEOPLE_ROLES, requireCapability, roleAllows } from './capabilities';
import { beginCentralAuth, redeemCentralAuth, usesCentralAuth } from './central-auth';
import {
  beginGoogleOAuth,
  exchangeGoogleAuthorizationCode,
  googleAuthorizationURL,
  nativeGoogleClientFor,
  unsealGoogleOAuthState,
  type OAuthStateSeal,
} from './google-oauth';
import { cookie, expiredCookie, readCookie, redirectWithCookies, safeReturnPath } from './http-cookies';
import {
  type ArtifactPrincipal,
  type OwnerDeviceSummary,
  type OwnerSession,
} from './contracts';
import { seedAvatarFromGoogle } from './avatars';
import { recordOwnerSignIn, type OwnerClient } from './usage';
import { acceptOpenInvitation, isWorkspaceMember, mayJoin } from './invitations';

export type { OwnerClient };

export { AuthError } from './errors';

const sessionCookie = 'meet_session';
const oauthCookie = 'meet_oauth';
const OAUTH_STATE_AUDIENCE = 'oauth-state';

export async function startGoogleWebAuth(request: Request, env: Env): Promise<Response> {
  ensureConfigured(env.GOOGLE_WEB_CLIENT_ID, 'GOOGLE_WEB_CLIENT_ID');
  const url = new URL(request.url);
  const returnTo = safeReturnPath(url.searchParams.get('return_to'));
  if (usesCentralAuth(request, env)) return beginCentralAuth(request, env, 'login', { returnTo });
  const origins = workspaceOAuthOrigins(request, env);
  const oauth = await beginGoogleOAuth({
    signingSecret: env.SESSION_SIGNING_SECRET,
    audience: OAUTH_STATE_AUDIENCE,
    returnTo,
    extraClaims: origins,
  });
  const google = googleAuthorizationURL({
    clientID: env.GOOGLE_WEB_CLIENT_ID,
    redirectURI: `${origins.callbackOrigin}/api/auth/google/callback`,
    scope: 'openid email profile',
    state: oauth.state,
    nonce: oauth.nonce,
    challenge: oauth.challenge,
    hostedDomain: signInDomain(env),
    extraParams: { prompt: 'select_account' },
  });
  return redirectWithCookies(google, [cookie(oauthCookie, oauth.sealedState, 600)]);
}

/**
 * Local Vite only. Google's production Web client rejects loopback redirect
 * URIs (127.0.0.1 and localhost) even when they are listed — policy error,
 * same 400. Mint the same cookie Google would have set. 404 in production.
 */
export async function mintDevWebSession(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (String(env.ENVIRONMENT) !== 'development') throw new AuthError('Not found.', 404, 'room_not_found');
  const returnTo = safeReturnPath(new URL(request.url).searchParams.get('return_to'));
  const owner = { sub: 'dev:rosa@example.com', email: 'rosa@example.com', name: 'Rosa' };
  const session = await signOwnerSession(owner, env, { lastClient: 'web', ctx });
  // Loopback is http — a Secure cookie is dropped and the 302 to /admin is a no-op.
  return redirectWithCookies(returnTo, [cookie(sessionCookie, session, 28_800, false)]);
}

/** HttpOnly cookie for the Vite SPA. Not Secure: local is http, and Secure is dropped. */
export function devSessionCookie(token: string): string {
  return cookie(sessionCookie, token, 28_800, false);
}

export async function completeGoogleWebAuth(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const sealedState = readCookie(request, oauthCookie);
  // Cancel on Google's page (`error=access_denied`) is not a failure: back to
  // where sign-in started, signed out and quiet, as the central flow and the
  // Mac and iPhone treat it. The state still has to be ours.
  const cancelled = !code && Boolean(url.searchParams.get('error'));
  if ((!code && !cancelled) || !returnedState || !sealedState) throw new AuthError('The Google sign-in response is incomplete.', 400, 'oauth_failed');

  const state = await unsealGoogleOAuthState<OAuthStateSeal>({
    sealedState,
    returnedState,
    signingSecret: env.SESSION_SIGNING_SECRET,
    audience: OAUTH_STATE_AUDIENCE,
  });
  const origins = restoreWorkspaceOAuthOrigins(request, env, state);
  if (cancelled || !code) {
    return redirectWithCookies(`${origins.webOrigin}${state.returnTo}`, [expiredCookie(oauthCookie)]);
  }
  const identity = await exchangeGoogleCode(env, {
    code,
    codeVerifier: state.verifier,
    redirectURI: `${origins.callbackOrigin}/api/auth/google/callback`,
    clientID: env.GOOGLE_WEB_CLIENT_ID,
    ...await optionalSecret(env, 'GOOGLE_WEB_CLIENT_SECRET'),
    nonce: state.nonce,
  });
  const session = await signOwnerSession(identity, env, { lastClient: 'web', ctx });
  return redirectWithCookies(`${origins.webOrigin}${state.returnTo}`, [
    cookie(sessionCookie, session, 28_800),
    expiredCookie(oauthCookie),
  ]);
}

/**
 * The end of a central sign-in (docs/CENTRAL_AUTH.md). The auth Worker
 * proved a Google identity; this workspace decides who may sign in, and only
 * this workspace sets its host-only session cookie.
 *
 * The rules are the direct flow's (`verifyMemberIdentity`) plus a fresh
 * read of `people`: an agent, a revoked person (except a root admin) or a
 * role without `ownProfile` gets no session.
 */
export async function completeCentralWebAuth(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const redeemed = await redeemCentralAuth(request, env, 'login');
  const result = redeemed.result;
  if (result.kind === 'cancelled') return redeemed.redirect();
  if (result.kind !== 'login') {
    throw new AuthError('Only a verified Google account on this workspace can host meetings.', 403, 'oauth_failed');
  }
  const email = result.email.toLowerCase();
  // A domain address needs Google to vouch for the domain (`hd`); any other
  // address needs an invitation, open or accepted. On an invite
  // workspace the domain admits only a root admin.
  const onDomain = isMemberHostedDomain(env, result.hd) && isDomainAdmitted(env, email);
  if (!onDomain && (isDomainAdmitted(env, email) || !(await mayJoin(env, email)))) {
    throw new AuthError('Only a verified Google account on this workspace can host meetings.', 403, 'oauth_failed');
  }
  // A person is their verified address within a workspace (email-sign-in.ts):
  // a row that already holds it, made by an email link, keeps its sub.
  const existing = await env.USAGE.prepare('SELECT sub FROM people WHERE lower(email) = ?1').bind(email).first<{ sub: string }>();
  const owner: OwnerSession = {
    sub: existing?.sub ?? result.sub,
    email,
    name: result.name,
    ...(result.picture ? { picture: result.picture } : {}),
  };
  await refuseBlockedPerson(env, owner);
  await admitWithInvitation(env, owner, onDomain);
  const session = await signOwnerSession(owner, env, { lastClient: 'web', ctx });
  return redeemed.redirect([cookie(sessionCookie, session, 28_800)]);
}

/**
 * The people rules a sign-in that did not come through `exchangeGoogleCode`
 * applies itself: the direct flow's revocation rule, then every
 * row that shares the sub or the address. An agent, a revoked row and a role
 * without `ownProfile` get no session. Central web sign-in and native
 * sign-in redemption (native-sign-in.ts) both run it.
 */
export async function refuseBlockedPerson(env: Env, owner: Pick<OwnerSession, 'sub' | 'email'>): Promise<void> {
  await refuseRevokedSignIn(env, owner);
  const rows = await env.USAGE.prepare('SELECT kind, role, revoked_at FROM people WHERE sub = ?1 OR lower(email) = ?2')
    .bind(owner.sub, owner.email.toLowerCase())
    .all<{ kind: string | null; role: string | null; revoked_at: number | null }>();
  for (const row of rows.results) {
    if (row.kind === 'agent') throw new AuthError('This account cannot sign in to this workspace.', 403, 'oauth_failed');
    if (row.revoked_at != null && !isRootAdminEmail(env, owner.email)) throw revokedSignIn();
    const role = PEOPLE_ROLES.find((candidate) => candidate === row.role) ?? 'member';
    if (!roleAllows(role, 'ownProfile')) throw new AuthError('This is not available to your account.', 403, 'capability_denied');
  }
}

/**
 * Spend an open invitation before the session is signed: the
 * `people` row with the invited role and the person's room, in one write.
 * An address on the sign-in domains signs in without one. Any other address
 * needs this to spend an invitation, or an invitation it accepted before;
 * otherwise it is refused here, after the identity was proven.
 */
export async function admitWithInvitation(env: Env, owner: Pick<OwnerSession, 'sub' | 'email' | 'name'>, onDomain: boolean): Promise<void> {
  const accepted = await acceptOpenInvitation(env, owner);
  if (accepted || onDomain) return;
  if (!(await isWorkspaceMember(env, owner.email))) {
    throw new AuthError('Only a verified Google account on this workspace can host meetings.', 403, 'oauth_failed');
  }
}

/** The web session cookie's name, for native sign-in's finish step. */
export const OWNER_SESSION_COOKIE = sessionCookie;

/**
 * How long a native client can go untouched and still come back signed in.
 *
 * The access token stays short (8h) because it is the thing every request
 * carries; this is the thing that survives a weekend. Renewal re-checks the
 * domain and the revocation column, so a departed member's tokens stop working
 * at the next renewal rather than at the end of a 60-day window.
 */
const REFRESH_TOKEN_LIFETIME = '60d';

/** Refresh tokens are a different audience, so one can never be spent as the other. */
const REFRESH_AUDIENCE = 'meet-owner-refresh';

/** Milliseconds in the refresh window; device rows older than this are pruned. */
const REFRESH_TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * How long the token a device just retired still buys a pair.
 *
 * Rotation commits before the response leaves. A response that never arrives
 * (timeout, dropped connection, app suspended, phone locked before the
 * Keychain write) leaves the device holding a token the row already refuses,
 * and its next renewal signed it out for a network blip. Inside this window
 * the retired token is honoured once more and rotation moves on; outside it,
 * the token is a replay. One hour covers a client that retries on its next
 * request or its next return to the foreground, and keeps a stolen token's
 * extra life to that same hour.
 */
export const REFRESH_GRACE_MS = 60 * 60 * 1000;

/** The installation a refresh token belongs to. */
export interface OwnerDevice {
  id: string;
  client: OwnerClient;
  /** What the device calls itself; absent from a build before the field. */
  label?: string | undefined;
}

/**
 * Mint a refresh token for one device.
 *
 * The token is the unit of rotation, and the device row is what makes rotation
 * real: two tokens minted in the same second are otherwise byte-identical, and
 * the server has to record *which* token is current for *which* device to be
 * able to refuse the others. Per device, not per person — a person's Mac and
 * phone renew independently, and a sign-in on one never spends the other's.
 */
export async function signOwnerRefreshToken(owner: OwnerSession, env: Env, device: OwnerDevice): Promise<string> {
  const jti = crypto.randomUUID();
  const token = await signSessionJwt(new SignJWT({
    email: owner.email,
    name: owner.name,
    ...(owner.picture ? { picture: owner.picture } : {}),
    device: device.id,
    client: device.client,
  })
    .setIssuer(SESSION_ISSUER)
    .setAudience(REFRESH_AUDIENCE)
    .setSubject(owner.sub)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(REFRESH_TOKEN_LIFETIME), env);
  await rememberDeviceToken(env, owner, device, jti);
  return token;
}

/**
 * The shape every refresh token had before `owner_devices`: no device claim,
 * tracked in `people.refresh_jti`. Kept only so the conversion path can be
 * tested; nothing in production mints one.
 */
export async function signLegacyOwnerRefreshToken(owner: OwnerSession, env: Env): Promise<string> {
  const jti = crypto.randomUUID();
  const token = await signSessionJwt(new SignJWT({ email: owner.email, name: owner.name })
    .setIssuer(SESSION_ISSUER)
    .setAudience(REFRESH_AUDIENCE)
    .setSubject(owner.sub)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(REFRESH_TOKEN_LIFETIME), env);
  await env.USAGE.prepare(
    `INSERT INTO people (sub, email, name, first_seen_at, last_seen_at, refresh_jti)
     VALUES (?1, ?2, ?3, ?4, ?4, ?5)
     ON CONFLICT(sub) DO UPDATE SET refresh_jti = excluded.refresh_jti`,
  ).bind(owner.sub, owner.email, owner.name, Date.now(), jti).run();
  return token;
}

/**
 * Record which token is current for this device, and forget devices that have
 * gone a whole refresh window without renewing — their tokens are expired
 * anyway, and the row would otherwise outlive them forever. Never logs the
 * token or the jti.
 */
async function rememberDeviceToken(env: Env, owner: OwnerSession, device: OwnerDevice, jti: string): Promise<void> {
  const now = Date.now();
  await env.USAGE.batch([
    // The jti being replaced becomes the one the grace window honours. A
    // fresh sign-in on a known device retires whatever was current the same
    // way: that token was this device's, and a response can be lost there too.
    // The label is kept when the renewal names none: a build before the
    // field must not blank what a newer build wrote.
    env.USAGE.prepare(
      `INSERT INTO owner_devices (device_id, sub, client, refresh_jti, issued_at, renewed_at, previous_refresh_jti, rotated_at, label)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5, NULL, NULL, ?6)
       ON CONFLICT(device_id) DO UPDATE SET
         sub = excluded.sub,
         client = excluded.client,
         previous_refresh_jti = CASE WHEN owner_devices.sub = excluded.sub THEN owner_devices.refresh_jti ELSE NULL END,
         rotated_at = CASE WHEN owner_devices.sub = excluded.sub THEN excluded.renewed_at ELSE NULL END,
         refresh_jti = excluded.refresh_jti,
         renewed_at = excluded.renewed_at,
         label = COALESCE(excluded.label, owner_devices.label)`,
    ).bind(device.id, owner.sub, device.client, jti, now, device.label ?? null),
    env.USAGE.prepare('DELETE FROM owner_devices WHERE sub = ?1 AND renewed_at < ?2')
      .bind(owner.sub, now - REFRESH_TOKEN_LIFETIME_MS),
  ]);
}

/**
 * Spend a refresh token for a fresh pair.
 *
 * Three things are re-proven here, because a token minted months ago proves
 * only that somebody signed in months ago:
 *
 * 1. The signature and audience — an access token cannot be spent as a refresh.
 * 2. The address is still a member here: on a workspace identity domain, or
 *    holding an accepted invitation (`isWorkspaceMember`), so
 *    invariant 3 holds on renewal and not only at sign-in.
 * 3. The person is not revoked (`people.revoked_at`), which is how somebody who
 *    left is cut off before their 60 days are up. A root admin is exempt:
 *    that column must never be what locks the account that would fix it.
 *
 * The refresh token rotates on every use, and only the newest one *for this
 * device* is accepted (`owner_devices.refresh_jti`) — plus, for
 * `REFRESH_GRACE_MS` after a rotation, the one it retired
 * (`previous_refresh_jti`), so a rotation whose response never reached the
 * device is not a sign-out. A stolen token therefore stops working within an
 * hour of its device renewing, and a replay of an older token is refused
 * rather than silently honoured. Other devices of the same owner are not
 * consulted and not disturbed: that was the bug where a Mac sign-in every
 * morning signed the phone out.
 *
 * A token from before per-device rotation carries no device claim. It is
 * checked against `people.refresh_jti` the way it always was, and the pair it
 * buys is device-scoped from then on.
 */
export async function redeemOwnerRefreshToken(
  token: string,
  env: Env,
  options: {
    lastClient: OwnerClient;
    deviceID?: string | undefined;
    deviceLabel?: string | undefined;
    ctx: ExecutionContext;
  },
): Promise<{ token: string; refreshToken: string; owner: OwnerSession; deviceID: string }> {
  let payload: JWTPayload;
  try {
    ({ payload } = await verifySessionJwt(token, env, {
      issuer: ACCEPTED_SESSION_ISSUERS,
      audience: REFRESH_AUDIENCE,
    }));
  } catch {
    throw new AuthError('Sign in again to continue.', 401, 'session_expired');
  }

  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const name = typeof payload.name === 'string' ? payload.name : '';
  if (!sub || !name || !(await isWorkspaceMember(env, email))) {
    throw new AuthError('Only a verified Google account on this workspace can host meetings.', 403, 'oauth_failed');
  }
  const person = await personForRenewal(env, sub);
  // A root admin renews whatever the row says. `revoked_at` is one column and
  // one statement away from locking somebody out permanently, and the account
  // that would have to *undo* that is the one account that must never be
  // locked out by it. See ROOT_ADMIN_EMAILS (rootAdminEmails in workspace-identity.ts).
  if (person.revoked && !isRootAdminEmail(env, email)) throw revokedSignIn();
  const jti = typeof payload.jti === 'string' ? payload.jti : '';
  const claimedDevice = typeof payload.device === 'string' ? payload.device : null;
  let device: OwnerDevice;
  if (claimedDevice) {
    // A token that is not this device's current one is either a replay or a
    // token from before the device last renewed. Either way it is spent. A row
    // that names another person is a token that was never this device's.
    const row = await deviceForRenewal(env, claimedDevice);
    const current = row != null && row.sub === sub && row.refreshJti === jti;
    const withinGrace = row != null && row.sub === sub && !current
      && row.previousRefreshJti === jti
      && row.rotatedAt != null && Date.now() - row.rotatedAt < REFRESH_GRACE_MS;
    if (!current && !withinGrace) {
      throw new AuthError('Sign in again to continue.', 401, 'session_expired');
    }
    device = { id: claimedDevice, client: options.lastClient, label: options.deviceLabel };
  } else {
    if (person.refreshJti && person.refreshJti !== jti) {
      throw new AuthError('Sign in again to continue.', 401, 'session_expired');
    }
    device = { id: options.deviceID ?? crypto.randomUUID(), client: options.lastClient, label: options.deviceLabel };
    // Spend the person-wide slot for good. Nothing mints into it any more, so
    // a value no jti can equal is what makes the token just spent — and any
    // other pre-migration token this person still holds — a refused replay
    // rather than a second conversion.
    await retireLegacyRefreshSlot(env, sub);
  }

  const owner: OwnerSession = {
    sub,
    email,
    name,
    ...(typeof payload.picture === 'string' ? { picture: payload.picture } : {}),
  };
  return {
    token: await signOwnerSession(owner, env, { ...options, device: device.id }),
    refreshToken: await signOwnerRefreshToken(owner, env, device),
    owner,
    deviceID: device.id,
  };
}

function revokedSignIn(): AuthError {
  return new AuthError('This account can no longer sign in to Starlings.', 403, 'oauth_failed');
}

/**
 * The renewal rule, applied to a fresh Google sign-in. Web and native both
 * reach it through `exchangeGoogleCode`, so a revoked person cannot come back
 * through Google and mint a cookie or a device row. A root admin is exempt,
 * as on renewal. A person with no row yet is a first sign-in, not a revoked one.
 */
export async function refuseRevokedSignIn(env: Env, owner: Pick<OwnerSession, 'sub' | 'email'>): Promise<void> {
  if (isRootAdminEmail(env, owner.email)) return;
  const person = await personForRenewal(env, owner.sub);
  if (person.revoked) throw revokedSignIn();
}

async function retireLegacyRefreshSlot(env: Env, sub: string): Promise<void> {
  await env.USAGE.prepare('UPDATE people SET refresh_jti = ?2 WHERE sub = ?1').bind(sub, 'converted').run();
}

/** Same rule as `personForRenewal`: an unreadable row refuses, never grants. */
async function deviceForRenewal(
  env: Env,
  deviceID: string,
): Promise<{ sub: string; refreshJti: string; previousRefreshJti: string | null; rotatedAt: number | null } | null> {
  try {
    const row = await env.USAGE.prepare(
      'SELECT sub, refresh_jti, previous_refresh_jti, rotated_at FROM owner_devices WHERE device_id = ?1',
    )
      .bind(deviceID)
      .first<{ sub: string; refresh_jti: string; previous_refresh_jti: string | null; rotated_at: number | null }>();
    return row
      ? {
        sub: row.sub,
        refreshJti: row.refresh_jti,
        previousRefreshJti: row.previous_refresh_jti,
        rotatedAt: row.rotated_at,
      }
      : null;
  } catch (error) {
    console.error('Device renewal check failed', { reason: error instanceof Error ? error.message : 'unknown' });
    throw new AuthError('Sign in again to continue.', 401, 'session_expired');
  }
}

/** Unreachable D1 must not hand out sessions: fail closed. */
async function personForRenewal(
  env: Env,
  sub: string,
): Promise<{ revoked: boolean; refreshJti: string | null }> {
  try {
    const row = await env.USAGE.prepare('SELECT revoked_at, refresh_jti FROM people WHERE sub = ?1')
      .bind(sub)
      .first<{ revoked_at: number | null; refresh_jti: string | null }>();
    return { revoked: row?.revoked_at != null, refreshJti: row?.refresh_jti ?? null };
  } catch (error) {
    console.error('Renewal check failed', { reason: error instanceof Error ? error.message : 'unknown' });
    throw new AuthError('Sign in again to continue.', 401, 'session_expired');
  }
}

export async function exchangeNativeGoogleCode(
  env: Env,
  input: { code: string; codeVerifier: string; redirectURI: string; nonce: string },
  options: {
    lastClient: OwnerClient;
    deviceID?: string | undefined;
    deviceLabel?: string | undefined;
    ctx: ExecutionContext;
  },
): Promise<{ token: string; refreshToken: string; owner: OwnerSession; deviceID: string }> {
  ensureConfigured(env.GOOGLE_NATIVE_CLIENT_ID, 'GOOGLE_NATIVE_CLIENT_ID');
  // The Meet and the Starlings apps have one Google client each; the
  // redirect scheme says which issued this code.
  const clientID = nativeGoogleClientFor(env, input.redirectURI);
  if (!clientID) throw new AuthError('The sign-in came from an app this workspace does not know.', 400, 'oauth_failed');
  const owner = await exchangeGoogleCode(env, {
    ...input,
    clientID,
  });
  return issueNativeSession(owner, env, options);
}

/**
 * The native pair for a person the caller has already verified: an 8h access
 * token and a 60-day refresh token for one device. The Google exchange above
 * and native sign-in redemption (native-sign-in.ts) both end here.
 */
export async function issueNativeSession(
  owner: OwnerSession,
  env: Env,
  options: {
    lastClient: OwnerClient;
    deviceID?: string | undefined;
    deviceLabel?: string | undefined;
    ctx: ExecutionContext;
  },
): Promise<{ token: string; refreshToken: string; owner: OwnerSession; deviceID: string }> {
  // Native only. The browser keeps its 8h cookie: a laptop left open on a
  // shared desk is a different risk from a phone behind Face ID, and the web
  // client has never asked to stay signed in for a month.
  //
  // A client that names no device (a build before per-device rotation) gets
  // one minted here; the token carries it, so the client need never know.
  const device: OwnerDevice = {
    id: options.deviceID ?? crypto.randomUUID(),
    client: options.lastClient,
    label: options.deviceLabel,
  };
  return {
    token: await signOwnerSession(owner, env, { ...options, device: device.id }),
    refreshToken: await signOwnerRefreshToken(owner, env, device),
    owner,
    deviceID: device.id,
  };
}

/** Store optional client version metadata only after a successful native auth exchange. */
export async function recordOwnerDeviceVersion(
  env: Env,
  deviceID: string,
  version: { platform: string; appVersion: string },
  now = Date.now(),
): Promise<void> {
  try {
    await env.USAGE.prepare(
      'UPDATE owner_devices SET platform = ?2, app_version = ?3, version_seen_at = ?4 WHERE device_id = ?1',
    ).bind(deviceID, version.platform, version.appVersion, now).run();
  } catch (error) {
    // Version reporting is advisory and must not turn a valid sign-in or
    // refresh into an outage when D1 is unavailable.
    console.warn('Device version update failed', error instanceof Error ? error.message : 'unknown');
  }
}

/**
 * The session token alone — no sign-in record, no avatar seed. What the
 * session route wraps, and what the MCP layer mints for two minutes at a time
 * to hand an existing `/api/*` route the caller it already knows how to
 * check (docs/MCP.md decision 3). The token never leaves the Worker there.
 */
export async function signOwnerSessionToken(
  owner: OwnerSession,
  env: Env,
  lifetime: string,
  device?: string,
  via?: string,
  /** The roster `sub` of the agent this borrowed token acts as (docs/ACCESS.md slice 2). */
  agent?: string,
): Promise<string> {
  // The device claim is what lets a signed-out device's access token die
  // before its 8h: `getOwnerSession` checks the row is still there. Web and
  // MCP sessions carry none and are checked the way they always were.
  // `via` names the MCP client a borrowed token acts for. Only the Worker
  // signs it, so a message can say "via claude.ai" without trusting a body.
  return signSessionJwt(new SignJWT({
    email: owner.email,
    name: owner.name,
    picture: owner.picture,
    role: 'owner',
    ...(device ? { device } : {}),
    ...(via ? { via } : {}),
    ...(agent ? { agent } : {}),
  })
    .setIssuer(SESSION_ISSUER)
    .setAudience('meet-owner')
    .setSubject(owner.sub)
    .setIssuedAt()
    .setExpirationTime(lifetime), env);
}

export async function signOwnerSession(
  owner: OwnerSession,
  env: Env,
  options: { lastClient: OwnerClient; device?: string | undefined; ctx?: ExecutionContext },
): Promise<string> {
  const token = await signOwnerSessionToken(owner, env, '8h', options.device);
  // Seeding runs *after* the upsert, never beside it: the seed writes to the
  // person's row, and a row that does not exist yet takes the update silently.
  const persist = recordOwnerSignIn(env, owner, options.lastClient)
    .then(() => seedAvatarFromGoogle(env, owner));
  if (options.ctx) options.ctx.waitUntil(persist);
  else await persist;
  return token;
}

// There is deliberately no guard here that means "is signed in". A session
// that the signature and the domain accept proves who somebody *was* when they
// signed in; it says nothing about whether they are still a member
// (`people.revoked_at`) or what their role reaches (`people.role`). Both are
// read, cached for a minute, by `requireCapability` in capabilities.ts, and
// every route goes through it naming the capability it protects —
// docs/ENROLLMENT.md step 2. `getOwnerSession` below is the *input* to that
// guard, not a guard: the route-gates test fails any route that calls it, or
// `requireOwner`, without a capability. `requireEnvisioningMember` is gone and
// deliberately not kept as an alias, so a new route cannot reach for it by habit.

/**
 * The guard on Admin *writes*: a member who may change something org-wide.
 *
 * Reading the account's numbers and changing the org-wide roster or roles are
 * not the same act, and until this existed they took the same guard —
 * `requireEnvisioningMember`, which admits every address on the domain. That
 * was correct while Admin only read.
 *
 * Two ways to qualify, and the second is the point:
 *
 * 1. `people.role = 'admin'`.
 * 2. An address in `OWNER_ROOM_MAP`.
 *
 * Without (2) the surface that grants the role is locked whenever the role
 * column is empty — a fresh local D1, a restored database, the deploy that
 * introduced the column. Room owners are already the people who operate Meet,
 * and they are named in configuration rather than in the database being
 * restored, so they are the one bootstrap that cannot lock itself out.
 *
 * D1 being unreachable does **not** fall back to (2) silently for everyone: a
 * query failure leaves only the room-map test standing, which is the narrow
 * answer, not the wide one.
 *
 * A room in the `rooms` table is not (2): every member gets one,
 * so it says nothing about admin. A new workspace has an empty map, and its
 * admins are `people.role` (the admin invitation) and its root admins.
 */
export async function requireOrgAdmin(request: Request, env: Env): Promise<OwnerSession> {
  // Any signed-in member first: a root admin or a bootstrap room owner can
  // hold the `member` role, and isOrgAdmin is what decides.
  const owner = await requireCapability(request, env, 'roster');
  if (await isOrgAdmin(env, owner)) return owner;
  throw new AuthError('Ask a workspace admin to make this change.', 403, 'not_org_admin');
}

/** True for a root admin, a bootstrap room owner, or a `people.role = 'admin'` row. */
export async function isOrgAdmin(env: Env, owner: Pick<OwnerSession, 'sub' | 'email'>): Promise<boolean> {
  // First, and without touching anything that can fail or be edited. See
  // ROOT_ADMIN_EMAILS (rootAdminEmails in workspace-identity.ts).
  if (isRootAdminEmail(env, owner.email)) return true;
  if (isBootstrapAdminEmail(env, owner.email)) return true;
  try {
    const row = await env.USAGE.prepare('SELECT role FROM people WHERE sub = ?1')
      .bind(owner.sub)
      .first<{ role: string | null }>();
    return row?.role === 'admin';
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'admin.role.query.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return false;
  }
}

/**
 * A room owner is an admin whatever the database says.
 *
 * An unparseable `OWNER_ROOM_MAP` must not promote everybody, so a throw here
 * is `false` rather than a 500 — the role column still answers for anyone who
 * has one.
 */
export function isBootstrapAdminEmail(env: Env, email: string): boolean {
  if (isRootAdminEmail(env, email)) return true;
  try {
    return mappedRoomFor(env, email) !== null;
  } catch {
    return false;
  }
}

/**
 * A signed-in caller. `agentSub` is set only on a token the MCP layer minted
 * for an agent: every route still runs as `owner`, and the subject access
 * view (subject-access.ts) intersects the agent's grants with theirs.
 */
export type SessionPrincipal = OwnerSession & { agentSub?: string };

export async function getOwnerSession(request: Request, env: Env): Promise<SessionPrincipal | null> {
  const verified = await verifiedOwnerSession(request, env);
  if (!verified) return null;
  // A native token names its device. A device that has been signed out —
  // from Settings, from Admin, or by hand — has no row, and its access token
  // is refused here rather than living out its 8h. The client sees 401,
  // tries to renew, is refused there too, and signs itself out.
  if (verified.device && !(await deviceIsSignedIn(env, verified.device))) return null;
  return verified.owner;
}

/**
 * The browser's own web session, for native sign-in's finish step
 * (native-sign-in.ts): the `meet_session` cookie only, never a bearer token,
 * a native device token, an MCP token or an agent's. It proves a person just
 * signed in in this browser; it opens no route.
 */
export async function browserWebSession(request: Request, env: Env): Promise<OwnerSession | null> {
  if (bearerToken(request)) return null;
  const verified = await verifiedOwnerSession(request, env);
  if (!verified || verified.device || verified.via || verified.owner.agentSub) return null;
  const { agentSub: _agent, ...owner } = verified.owner;
  return owner;
}

/** The device claim of the request's session, if it is a native one. */
export async function requestDeviceID(request: Request, env: Env): Promise<string | null> {
  return (await verifiedOwnerSession(request, env))?.device ?? null;
}

/** The MCP client the request's session was minted for, if any. */
export async function requestVia(request: Request, env: Env): Promise<string | null> {
  return (await verifiedOwnerSession(request, env))?.via ?? null;
}

async function verifiedOwnerSession(
  request: Request,
  env: Env,
): Promise<{ owner: SessionPrincipal; device: string | null; via: string | null } | null> {
  const token = bearerToken(request) ?? readCookie(request, sessionCookie);
  if (!token) return null;
  try {
    const verified = await verifySessionJwt(token, env, {
      issuer: ACCEPTED_SESSION_ISSUERS,
      audience: 'meet-owner',
    });
    const payload = verified.payload;
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string' || typeof payload.name !== 'string') return null;
    // Membership is the capability gate's to decide (capabilities.ts): an
    // address on the sign-in domains, or one with an accepted invitation
    //. Every route reads the session through it.
    return {
      owner: {
        sub: payload.sub,
        email: payload.email,
        name: payload.name,
        ...(typeof payload.picture === 'string' ? { picture: payload.picture } : {}),
        ...(typeof payload.agent === 'string' && payload.agent ? { agentSub: payload.agent } : {}),
      },
      device: typeof payload.device === 'string' ? payload.device : null,
      via: typeof payload.via === 'string' ? payload.via : null,
    };
  } catch {
    return null;
  }
}

/**
 * How long a device's row is trusted before it is read again, per isolate.
 * Every native request would otherwise be a D1 read; a revoke bites within
 * this window on the isolates that have seen the device, and at once on the
 * one that took the revoke. Only presence is cached: absence is checked every
 * time, so a device signing in again is not refused for a minute.
 */
export const DEVICE_CHECK_TTL_MS = 60 * 1000;
const seenDevices = new Map<string, number>();

/**
 * Whether a device still has a row. Fails closed, but not into a sign-out: an
 * unreachable D1 answers 503, which the clients treat as transient, rather
 * than 401, which they treat as "renew" — and renewal reads the same
 * database, so a 401 here would turn a blip into every native device signing
 * out at once.
 */
async function deviceIsSignedIn(env: Env, deviceID: string): Promise<boolean> {
  const seen = seenDevices.get(deviceID);
  if (seen != null && Date.now() - seen < DEVICE_CHECK_TTL_MS) return true;
  let row: { device_id: string } | null;
  try {
    row = await env.USAGE.prepare('SELECT device_id FROM owner_devices WHERE device_id = ?1')
      .bind(deviceID)
      .first<{ device_id: string }>();
  } catch (error) {
    console.error('Device session check failed', { reason: error instanceof Error ? error.message : 'unknown' });
    throw new ControlError('Starlings couldn’t check your session. Try again.', 503, 'internal_error');
  }
  if (!row) {
    seenDevices.delete(deviceID);
    return false;
  }
  seenDevices.set(deviceID, Date.now());
  return true;
}

/** Test seam: forget what this isolate has trusted. */
export function resetDeviceCheckCache(): void {
  seenDevices.clear();
}

/** A row dropped by somebody else's DELETE — person-wide revocation — is forgotten here too. */
export function forgetDevice(deviceID: string): void {
  seenDevices.delete(deviceID);
}

/** The person's signed-in native installs, newest renewal first. */
export async function listOwnerDevices(env: Env, sub: string, currentDeviceID: string | null): Promise<OwnerDeviceSummary[]> {
  const { results } = await env.USAGE.prepare(
    `SELECT device_id, client, label, platform, app_version, version_seen_at, issued_at, renewed_at FROM owner_devices
     WHERE sub = ?1 ORDER BY renewed_at DESC`,
  ).bind(sub).all<{
    device_id: string;
    client: string;
    label: string | null;
    platform: 'macos' | 'ios' | 'watchos' | 'android' | null;
    app_version: string | null;
    version_seen_at: number | null;
    issued_at: number;
    renewed_at: number;
  }>();
  return results.map((row) => ({
    device_id: row.device_id,
    // Shipped Mac and iOS builds decode `client` as a closed enum of two:
    // an Android phone reads as the other phone, and `platform` names it.
    client: row.client === 'ios' || row.client === 'android' ? 'ios' : 'mac',
    label: row.label,
    platform: row.platform,
    app_version: row.app_version,
    version_seen_at: row.version_seen_at,
    issued_at: row.issued_at,
    renewed_at: row.renewed_at,
    current: row.device_id === currentDeviceID,
  }));
}

/**
 * Sign one of a person's devices out. Scoped to `sub`: a device id that is
 * somebody else's is not this person's to drop, and answers false the way a
 * missing one does. True when a row went.
 */
export async function dropOwnerDevice(env: Env, sub: string, deviceID: string): Promise<boolean> {
  const dropped = await env.USAGE.prepare('DELETE FROM owner_devices WHERE device_id = ?1 AND sub = ?2')
    .bind(deviceID, sub)
    .run();
  seenDevices.delete(deviceID);
  return (dropped.meta?.changes ?? 0) > 0;
}

export async function signArtifactPrincipal(principal: ArtifactPrincipal, env: Env): Promise<string> {
  return signSessionJwt(new SignJWT({
    room_slug: principal.roomSlug,
    meeting_id: principal.meetingId,
    identity: principal.identity,
    role: principal.role,
    email: principal.email,
  })
    .setIssuer(SESSION_ISSUER)
    .setAudience('meet-artifact')
    .setSubject(principal.identity)
    .setIssuedAt()
    .setExpirationTime('12h'), env);
}

export async function getArtifactPrincipal(request: Request, env: Env): Promise<ArtifactPrincipal | null> {
  const token = bearerToken(request);
  if (!token) return null;
  try {
    const { payload } = await verifySessionJwt(token, env, {
      issuer: ACCEPTED_SESSION_ISSUERS,
      audience: 'meet-artifact',
    });
    if (
      typeof payload.room_slug !== 'string' || typeof payload.meeting_id !== 'string'
      || typeof payload.identity !== 'string' || typeof payload.email !== 'string'
      || (payload.role !== 'owner' && payload.role !== 'guest')
    ) return null;
    return {
      roomSlug: payload.room_slug,
      meetingId: payload.meeting_id,
      identity: payload.identity,
      role: payload.role,
      email: payload.email,
    };
  } catch {
    return null;
  }
}

export function logoutResponse(env: Env, request?: Request): Response {
  return redirectWithCookies(request ? workspaceOAuthOrigins(request, env).webOrigin : env.WEB_ORIGIN, [expiredCookie(sessionCookie)]);
}

export function isBearerRequest(request: Request): boolean {
  return bearerToken(request) !== null;
}

export function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  return authorization.slice(7).trim() || null;
}

async function exchangeGoogleCode(
  env: Env,
  options: {
    code: string;
    codeVerifier: string;
    redirectURI: string;
    clientID: string;
    clientSecret?: string;
    nonce: string;
  },
): Promise<OwnerSession> {
  const result = await exchangeGoogleAuthorizationCode(options);
  if (!result.ok) {
    console.error('Google token exchange rejected', { clientID: options.clientID, redirectURI: options.redirectURI, reason: result.reason });
    throw new AuthError('Google rejected the authorization code.', 401, 'oauth_failed');
  }
  if (typeof result.body.id_token !== 'string') throw new AuthError('Google did not return an identity token.', 401, 'oauth_failed');
  const identity = await verifyMemberIdentity(env, result.body.id_token, {
    audience: options.clientID,
    nonce: options.nonce,
    failureMessage: 'Only a verified Google account on this workspace can host meetings.',
  });
  if (typeof identity.name !== 'string') {
    throw new AuthError('Only a verified Google account on this workspace can host meetings.', 403, 'oauth_failed');
  }
  const owner: OwnerSession = {
    sub: identity.sub,
    email: identity.email.toLowerCase(),
    name: identity.name,
    ...(typeof identity.picture === 'string' ? { picture: identity.picture } : {}),
  };
  // Before any session is signed: signing writes the `people` and
  // `owner_devices` rows, and a revoked person must not get either.
  await refuseRevokedSignIn(env, owner);
  // On an invite workspace the domain admits nobody but a root admin; every
  // other domain address needs an invitation.
  const admitted = isDomainAdmitted(env, owner.email);
  if (!admitted && !(await mayJoin(env, owner.email))) {
    throw new AuthError('Only a verified Google account on this workspace can host meetings.', 403, 'oauth_failed');
  }
  // The direct flow admits domain addresses only; an open invitation still
  // gives one its invited role and its room.
  await admitWithInvitation(env, owner, admitted);
  return owner;
}

function ensureConfigured(value: string, name: string): void {
  if (!value || value.startsWith('replace-with-')) throw new AuthError(`${name} is not configured.`, 503, 'not_configured');
}
