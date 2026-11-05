import { sharedSecret } from './shared-secrets';
import { signInDomain, verifyMemberIdentity } from './workspace-identity';
import { roomOfMember } from './member-rooms';
import { workspaceOAuthOrigins, restoreWorkspaceOAuthOrigins, workspacePublicOrigin } from './workspace-origins';
import { coreApiOrigin, usesCoreFor } from './work-store';
import type { JWTPayload } from 'jose';
import { accountKey, googleAccountTitle, googleCalendarKey } from '@starlings/contracts/calendar-keys';
import {
  hasRealMeetingTitle,
  UPCOMING_CONFIG,
  normalizeUpcomingPreferences,
  upcomingRequestHours,
  type UpcomingPreferences,
} from '@starlings/contracts/upcoming';
import { DEFAULT_MEETING_TITLE } from '@starlings/contracts';
import type {
  CalendarAccount,
  CalendarAttendeeStatus,
  CalendarAttendeeSummary,
  CalendarBusyInterval,
  CalendarEventSummary,
  CalendarFreeBusyPerson,
  CalendarMeetingPlatform,
  CalendarSemanticRole,
  CalendarStatus,
  GoogleCalendarListEntry,
  StarlingsMintedBookingProjection,
} from '@starlings/contracts/calendar';
export type {
  CalendarAccount,
  CalendarAttendeeStatus,
  CalendarAttendeeSummary,
  CalendarBusyInterval,
  CalendarEventSummary,
  CalendarFreeBusyPerson,
  CalendarMeetingPlatform,
  CalendarSemanticRole,
  CalendarStatus,
  GoogleCalendarListEntry,
  StarlingsMintedBookingProjection,
};
import { AuthError, ControlError } from './errors';
import {
  parsePublicRoomPath,
  roomPermalink,
  calendarEventSubjectSchema,
  type CalendarAndroidClient,
  type CalendarEventSubject,
  type OwnerSession,
} from './contracts';
import {
  beginGoogleOAuth,
  exchangeGoogleAuthorizationCode,
  googleAuthorizationURL,
  nativeGoogleClientFor,
  nativeGoogleClientIDs,
  unsealGoogleOAuthState,
  verifyGoogleIdentity,
  refreshGoogleAccessToken,
  revokeGoogleToken,
  type GoogleIdentity,
  type OAuthStateSeal,
} from './google-oauth';
import { awaitBounded } from './core-gate';
import { changeBookingInteraction, corePatFetch, crmSyncEnabled, fetchCrmCalendarContacts } from './crm';
import { bookingForEvent, cancelBookingRow, moveBooking } from './booking-store';
import { withdrawBookingNda } from './booking-nda';
import { noteBookingCancelledOnSubject } from './booking-subject';
import { cookie, expiredCookie, readCookie, redirectWithCookies, safeReturnPath } from './http-cookies';
import { openSecret, randomToken, sealSecret } from './crypto';
import { CALENDAR_OAUTH_SCOPES } from './google-scopes';
import { beginCentralAuth, centralConsent, redeemCentralAuth, usesCentralAuth } from './central-auth';

const oauthCookie = 'meet_calendar_oauth';
const meetAppProperty = 'envisioning';
const defaultSelectedCalendars = ['primary'];
const calendarInvitationLookbackMilliseconds = 31 * 24 * 60 * 60 * 1000;
const calendarInvitationLookaheadMilliseconds = 366 * 24 * 60 * 60 * 1000;

/**
 * The Google client that issued a refresh token; a refresh must use the same
 * one. `calendar` is Starlings' calendar-only client (GOOGLE_CALENDAR_CLIENT_ID,
 * its own Google project and scope review, docs/CENTRAL_AUTH.md), used for a
 * central consent when it is set.
 */
type CalendarTokenClient = 'native' | 'web' | 'calendar';

function isCalendarTokenClient(value: unknown): value is CalendarTokenClient {
  return value === 'native' || value === 'web' || value === 'calendar';
}

/** The client a central Calendar consent uses: the calendar client when set, else the web client. */
async function centralCalendarClient(env: Env): Promise<{ client: 'web' | 'calendar'; id: string; secret: string | undefined }> {
  const calendarID = env.GOOGLE_CALENDAR_CLIENT_ID?.trim();
  if (calendarID && !calendarID.startsWith('replace-with-')) {
    return { client: 'calendar', id: calendarID, secret: await sharedSecret(env, 'GOOGLE_CALENDAR_CLIENT_SECRET') };
  }
  return { client: 'web', id: env.GOOGLE_WEB_CLIENT_ID, secret: await sharedSecret(env, 'GOOGLE_WEB_CLIENT_SECRET') };
}

interface CalendarTokenRecord {
  v: 1;
  iv: string;
  ciphertext: string;
  connectedAt: number;
  email: string;
  client: CalendarTokenClient;
  /**
   * For a `native` record, the Google client ID that issued the refresh
   * token: the Meet or the Starlings app's. Records written
   * before it have none, and were issued by `GOOGLE_NATIVE_CLIENT_ID`.
   */
  clientID?: string;
}

/** The native client a calendar code came from, by its redirect scheme; a 400 for any other. */
function nativeCalendarClient(env: Env, redirectURI: string): string {
  ensureConfigured(env.GOOGLE_NATIVE_CLIENT_ID, 'GOOGLE_NATIVE_CLIENT_ID');
  const clientID = nativeGoogleClientFor(env, redirectURI);
  if (!clientID) throw new CalendarError('Calendar was connected from an app this workspace does not know.', 400, 'calendar_failed');
  return clientID;
}

/**
 * The client a `native` refresh token refreshes with: the one that issued
 * it. A record with no client ID is from before and the Meet
 * client. One naming a client no longer configured refuses (fail closed).
 */
export function nativeRefreshClient(env: Env, record: Pick<CalendarTokenRecord, 'clientID'>): string {
  ensureConfigured(env.GOOGLE_NATIVE_CLIENT_ID, 'GOOGLE_NATIVE_CLIENT_ID');
  if (record.clientID === undefined) return env.GOOGLE_NATIVE_CLIENT_ID;
  if (nativeGoogleClientIDs(env).includes(record.clientID)) return record.clientID;
  throw new CalendarError('Google Calendar was connected from an app this workspace no longer knows. Reconnect Calendar in Settings.', 409, 'calendar_not_connected');
}

interface CalendarOAuthState extends OAuthStateSeal {
  ownerSub: string;
}

/**
 * The title of this workspace's shared company calendar
 * (`GLOBAL_INTEREST_CALENDAR_TITLE`), or null when it has none. Envisioning
 * names "Envisioning Internal"; no other workspace inherits it.
 */
export function globalInterestCalendarTitle(env: Pick<Env, 'GLOBAL_INTEREST_CALENDAR_TITLE'>): string | null {
  return env.GLOBAL_INTEREST_CALENDAR_TITLE?.trim() || null;
}

export function calendarRoleForSummary(summary: string, globalInterestTitle: string | null | undefined): CalendarSemanticRole {
  return globalInterestTitle && summary.trim().toLowerCase() === globalInterestTitle.toLowerCase()
    ? 'global_interest'
    : 'ordinary';
}

/** The owner's stored calendar choices, as the Worker keeps them; the wire is `CalendarPreferencesResponse`. */
export interface CalendarPreferences {
  selectedCalendarIds: string[];
  /** Subscribed feeds the owner opted out of Home's shared Upcoming feed. New feeds are included by default. */
  upcomingExcludedSubscriptionIds: string[];
  /**
   * Calendars the owner has switched off in the app, by a key that means the
   * same thing on every device: `g:<google id>` for Google, `ek:<account>/<title>`
   * for EventKit, `account:<account>` for a whole local account. EventKit's own
   * identifiers are per-device UUIDs, so they could not be shared.
   */
  hiddenCalendarKeys: string[];
  /**
   * Calendars and whole accounts the owner has taken out of the app, in the
   * same key space as `hiddenCalendarKeys`. Hidden is a checkbox in the
   * sidebar; disabled is stronger — the app does not list the calendar, does
   * not fetch it, and does not offer it as somewhere to write. It is how a
   * device account nobody wants to see stops arriving at all.
   */
  disabledCalendarKeys: string[];
  /** Individual events that remain visible but cannot drive Next or alerts. */
  demotedEventKeys: string[];
  /** EventKit is explicitly opt-in; absence in an older record means false. */
  includesLocalCalendars: boolean;
  /**
   * The project or lead an event is about, keyed like `demotedEventKeys`.
   * What a room started from that event is filed under, on either device.
   */
  eventSubjects: Record<string, CalendarEventSubject>;
  /** One owner-wide display policy shared by Mac, iOS, and web. */
  upcoming: UpcomingPreferences;
}

interface StoredCalendarAccount {
  id: string;
  email: string;
  connectedAt: number;
  client: CalendarTokenClient;
}

/** The id of the owner's own account, in calendar refs and in the API. */
export const PRIMARY_ACCOUNT_ID = 'primary-account';

/**
 * Two accounts can both call a calendar `primary`, so a calendar id is only
 * unique together with the account it came from. The owner's own calendars keep
 * their bare Google ids — stored preferences and default-calendar choices are
 * full of them — and only the additional accounts carry a prefix.
 */
export function encodeCalendarRef(accountId: string | null, calendarId: string): string {
  return accountId && accountId !== PRIMARY_ACCOUNT_ID ? `acct:${accountId}:${calendarId}` : calendarId;
}

export function decodeCalendarRef(id: string): { accountId: string | null; calendarId: string } {
  if (!id.startsWith('acct:')) return { accountId: null, calendarId: id };
  const rest = id.slice('acct:'.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) return { accountId: null, calendarId: id };
  return { accountId: rest.slice(0, separator), calendarId: rest.slice(separator + 1) };
}

export interface CalendarEventInput {
  title: string;
  start: string;
  end: string;
  joinUrl?: string;
  roomSlug?: string;
  calendarId?: string;
  attendees: string[];
  description?: string;
  location?: string;
  /** IANA timezone stamped on Google start/end for host display. */
  timeZone?: string;
  /** `start`/`end` are days; Google stores `date`, not `dateTime`. */
  allDay?: boolean;
  /** Minutes to get there; 0 or null writes nothing. */
  travelTimeMinutes?: number | null;
  /** The guest a room booking is for: their join card opens with these filled in. */
  guestName?: string;
  guestEmail?: string;
  /** Where the guest cancels or moves a booking made on the booking page. */
  manageUrl?: string;
  /**
   * False keeps Core from mailing the guests its own link: a booking-page
   * booking's confirmation is the Google invite. Core still files the
   * interaction. Default true.
   */
  notifyGuests?: boolean;
  /**
   * False: the caller files the booking with Core itself. The booking page
   * does (`fileBookingInteraction`). Default true.
   */
  coreSync?: boolean;
}

export interface CalendarEventPatchInput {
  calendarId: string;
  eventId: string;
  title?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  attendees?: string[];
  description?: string;
  location?: string;
  timeZone?: string;
  joinUrl?: string;
  roomSlug?: string;
  /** A number sets it, 0 or null clears it; absent leaves it alone. */
  travelTimeMinutes?: number | null;
}

type CrmAttendeeMatch = string | {
  name: string;
  crmUrl?: string;
};

/**
 * The upcoming feed may look back to retain an in-progress event for the Mac
 * host, but consumers should never render ended or placeholder calendar rows.
 */
/**
 * Google returns a deleted occurrence of a recurring series as a stub with
 * `status: 'cancelled'`. Every list reader drops it, so Upcoming and the grid
 * agree on what was deleted.
 */
function isCancelledEvent(item: unknown): boolean {
  return isRecord(item) && item.status === 'cancelled';
}

export function isDisplayableUpcomingEvent(
  event: Pick<CalendarEventSummary, 'title' | 'end'>,
  now = Date.now(),
): boolean {
  // The placeholder list is the clients' — one definition of "not a meeting",
  // in @starlings/contracts/upcoming, rather than four that can drift apart.
  if (!hasRealMeetingTitle(event.title)) return false;
  const end = Date.parse(event.end);
  return Number.isFinite(end) && end > now;
}

/**
 * Read only explicit travel metadata. Google has no first-class travel field,
 * so integrations store this as an extended property. Apple-exported
 * iCalendar data uses `X-APPLE-TRAVEL-DURATION`; accepting it here also makes
 * that value survive when a provider exposes it as an extended property.
 *
 * This deliberately does not infer a route from `location`, and never turns a
 * missing value into an estimate.
 */
export function travelTimeMinutesFromMetadata(event: unknown): number | null {
  if (!isRecord(event) || !isRecord(event.extendedProperties)) return null;
  const sections = [event.extendedProperties.private, event.extendedProperties.shared]
    .filter(isRecord);
  for (const properties of sections) {
    for (const [rawKey, rawValue] of Object.entries(properties)) {
      const key = rawKey.toLowerCase().replace(/[-_]/gu, '');
      if (key === 'xappletravelduration') {
        const duration = parseTravelDuration(rawValue);
        if (duration !== null) return duration;
      } else if (key === 'meettraveltimeminutes' || key === 'traveltimeminutes') {
        const minutes = parseTravelMinutes(rawValue);
        if (minutes !== null) return minutes;
      }
    }
  }
  return null;
}

function parseTravelMinutes(value: unknown): number | null {
  const minutes = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/u.test(value.trim())
      ? Number(value.trim())
      : NaN;
  return Number.isInteger(minutes) && minutes > 0 && minutes <= 24 * 60 ? minutes : null;
}

function parseTravelDuration(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/iu.exec(value.trim());
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const totalSeconds = (((days * 24) + hours) * 60 + minutes) * 60 + seconds;
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return null;
  return parseTravelMinutes(Math.ceil(totalSeconds / 60));
}

export class CalendarError extends ControlError {}

export async function getCalendarStatus(env: Env, owner: OwnerSession): Promise<CalendarStatus> {
  const record = await loadTokenRecord(env, owner.sub);
  if (!record) return { connected: false };
  return { connected: true, email: record.email };
}

export async function exchangeNativeCalendarCode(
  env: Env,
  owner: OwnerSession,
  input: { code: string; codeVerifier: string; redirectURI: string; nonce: string },
): Promise<CalendarStatus> {
  const clientID = nativeCalendarClient(env, input.redirectURI);
  const tokens = await exchangeGoogleCalendarCode(env, {
    ...input,
    clientID,
  });
  await assertIdentityMatchesOwner(env, tokens.idToken, clientID, input.nonce, owner);
  if (!tokens.refreshToken) {
    throw new CalendarError(
      'Google did not return a refresh token. Disconnect Calendar in Google Account permissions and connect again.',
      400,
      'calendar_failed',
    );
  }
  await storeRefreshToken(env, owner, tokens.refreshToken, 'native', clientID);
  await ensureDefaultPreferences(env, owner.sub);
  const calendars = await calendarsJustConnected(env, owner.sub, {
    id: PRIMARY_ACCOUNT_ID,
    email: owner.email,
    connectedAt: Date.now(),
    primary: true,
    connected: true,
  }, tokens.accessToken);
  return { connected: true, email: owner.email, ...(calendars ? { calendars } : {}) };
}

/**
 * The calendar list for an account whose access token is already in hand, so
 * nothing here depends on KV having caught up with the token just written.
 * Best effort: the connect is done either way, and the client can list again.
 */
async function calendarsJustConnected(
  env: Env,
  ownerSub: string,
  account: CalendarAccount,
  accessToken: string,
): Promise<GoogleCalendarListEntry[] | undefined> {
  try {
    const prefs = await loadPreferences(env, ownerSub);
    return await fetchCalendarList(accessToken, account, new Set(prefs.selectedCalendarIds));
  } catch (error) {
    console.warn('Calendar list after connect failed', { account: account.id, reason: describeFailure(error) });
    return undefined;
  }
}

/** Status and code only — never a token, never a body. */
function describeFailure(error: unknown): string {
  if (error instanceof ControlError) return `${error.status} ${error.code}`;
  return error instanceof Error ? error.name : 'unknown';
}

export async function startWebCalendarConnect(request: Request, env: Env, owner: OwnerSession): Promise<Response> {
  ensureConfigured(env.GOOGLE_WEB_CLIENT_ID, 'GOOGLE_WEB_CLIENT_ID');
  const url = new URL(request.url);
  const returnTo = safeReturnPath(url.searchParams.get('return_to'));
  if (usesCentralAuth(request, env)) return beginCentralAuth(request, env, 'calendar', { returnTo, owner });
  const origins = workspaceOAuthOrigins(request, env);
  const oauth = await beginGoogleOAuth({
    signingSecret: env.SESSION_SIGNING_SECRET,
    audience: 'calendar-oauth-state',
    returnTo,
    extraClaims: { ownerSub: owner.sub, ...origins },
  });
  const google = googleAuthorizationURL({
    clientID: env.GOOGLE_WEB_CLIENT_ID,
    redirectURI: `${origins.callbackOrigin}/api/calendar/connect/callback`,
    scope: `openid email profile ${CALENDAR_OAUTH_SCOPES}`,
    state: oauth.state,
    nonce: oauth.nonce,
    challenge: oauth.challenge,
    hostedDomain: signInDomain(env),
    extraParams: {
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
    },
  });
  return redirectWithCookies(google, [cookie(oauthCookie, oauth.sealedState, 600)]);
}

export async function completeWebCalendarConnect(request: Request, env: Env, owner: OwnerSession): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const sealedState = readCookie(request, oauthCookie);
  if (!code || !returnedState || !sealedState) throw new CalendarError('The Google Calendar response is incomplete.', 400, 'oauth_failed');

  const state = await unsealGoogleOAuthState<CalendarOAuthState>({
    sealedState,
    returnedState,
    signingSecret: env.SESSION_SIGNING_SECRET,
    audience: 'calendar-oauth-state',
  });
  if (state.ownerSub !== owner.sub) throw new CalendarError('Calendar connect must use the signed-in owner.', 403, 'calendar_wrong_account');

  const origins = restoreWorkspaceOAuthOrigins(request, env, state);
  await applyWebCalendarConsent(env, owner, {
    code,
    verifier: state.verifier,
    nonce: state.nonce,
    redirectURI: `${origins.callbackOrigin}/api/calendar/connect/callback`,
  }, { client: 'web', id: env.GOOGLE_WEB_CLIENT_ID, secret: await sharedSecret(env, 'GOOGLE_WEB_CLIENT_SECRET') });
  return redirectWithCookies(`${origins.webOrigin}${state.returnTo}`, [expiredCookie(oauthCookie)]);
}

/**
 * The end of a central Calendar consent (docs/CENTRAL_AUTH.md). The auth
 * Worker kept the Google code sealed; this workspace redeems it over the
 * `AUTH` binding and exchanges it itself, so the refresh token never leaves
 * this workspace.
 */
export async function completeCentralCalendarConnect(request: Request, env: Env, owner: OwnerSession): Promise<Response> {
  const redeemed = await redeemCentralAuth(request, env, 'calendar', owner.sub);
  if (redeemed.result.kind !== 'cancelled') {
    const client = await centralCalendarClient(env);
    await applyWebCalendarConsent(env, owner, centralConsent(redeemed.result, env, 'calendar', client.id), client);
  }
  return redeemed.redirect();
}

/**
 * The client an Android connect asks Google to issue its code for
 * (`requestOfflineAccess(serverClientId)`, docs/agents/areas/android.md,
 * "Calendar"): the central consent's client, which holds the secret that
 * redeems the code. Its Google project also holds the Android OAuth client
 * (package and signing SHA-1) that lets the app ask. Without a secret
 * nothing can redeem the code, so this refuses.
 */
async function androidCalendarServerClient(env: Env): Promise<{ client: 'web' | 'calendar'; id: string; secret: string }> {
  ensureConfigured(env.GOOGLE_WEB_CLIENT_ID, 'GOOGLE_WEB_CLIENT_ID');
  const client = await centralCalendarClient(env);
  if (!client.secret) throw new CalendarError('Calendar cannot be connected from Android on this workspace.', 503, 'calendar_failed');
  return { ...client, secret: client.secret };
}

export async function androidCalendarClient(env: Env): Promise<CalendarAndroidClient> {
  return { server_client_id: (await androidCalendarServerClient(env)).id };
}

/** The owner's own calendar, from an Android `serverAuthCode`: the web consent's rules, without PKCE or a redirect. */
export async function exchangeAndroidCalendarCode(env: Env, owner: OwnerSession, serverAuthCode: string): Promise<CalendarStatus> {
  const client = await androidCalendarServerClient(env);
  await applyWebCalendarConsent(env, owner, { code: serverAuthCode, nonce: null, redirectURI: '' }, client);
  return { connected: true, email: owner.email };
}

async function applyWebCalendarConsent(
  env: Env,
  owner: OwnerSession,
  consent: { code: string; verifier?: string; nonce: string | null; redirectURI: string },
  client: { client: 'web' | 'calendar'; id: string; secret: string | undefined },
): Promise<void> {
  const tokens = await exchangeGoogleCalendarCode(env, {
    code: consent.code,
    ...(consent.verifier ? { codeVerifier: consent.verifier } : {}),
    redirectURI: consent.redirectURI,
    clientID: client.id,
    ...(client.secret ? { clientSecret: client.secret } : {}),
  });
  await assertIdentityMatchesOwner(env, tokens.idToken, client.id, consent.nonce, owner);
  if (!tokens.refreshToken) {
    throw new CalendarError(
      'Google did not return a refresh token. Disconnect Calendar in Google Account permissions and connect again.',
      400,
      'calendar_failed',
    );
  }
  await storeRefreshToken(env, owner, tokens.refreshToken, client.client);
  await ensureDefaultPreferences(env, owner.sub);
}

export async function disconnectCalendar(env: Env, owner: OwnerSession): Promise<void> {
  await revokeStoredToken(env, tokenKey(owner.sub));
  // Disconnecting Calendar means all of it. Leaving the extra accounts behind
  // would keep reading somebody's personal calendar after they asked the app to
  // stop reading their work one.
  for (const account of await loadAdditionalAccounts(env, owner.sub)) {
    await revokeStoredToken(env, accountTokenKey(owner.sub, account.id));
    await env.CALENDAR_TOKENS.delete(accountTokenKey(owner.sub, account.id));
  }
  await env.CALENDAR_TOKENS.delete(accountsKey(owner.sub));
  await env.CALENDAR_TOKENS.delete(tokenKey(owner.sub));
  await env.CALENDAR_TOKENS.delete(prefsKey(owner.sub));
}

/**
 * One access token per account, per request. Several calendars share an account
 * and every fetch would otherwise mint its own token for the same one.
 */
type TokenFor = (accountId: string | null, renew?: boolean) => Promise<string>;

function tokenPool(env: Env, owner: OwnerSession): TokenFor {
  const pool = new Map<string, Promise<string>>();
  return (accountId, renew = false) => {
    const key = accountId ?? PRIMARY_ACCOUNT_ID;
    // `renew` is for a token Google just refused: handing the same stale one
    // back to the retry would repeat the refusal.
    if (renew) pool.delete(key);
    const existing = pool.get(key);
    if (existing) return existing;
    const minted = accessTokenFor(env, owner, accountId);
    pool.set(key, minted);
    return minted;
  };
}

/** Every account whose calendars should be read, the owner's own first. */
export async function listCalendarAccounts(env: Env, owner: OwnerSession): Promise<CalendarAccount[]> {
  const accounts: CalendarAccount[] = [];
  const primary = await loadTokenRecord(env, owner.sub);
  if (primary) {
    accounts.push({
      id: PRIMARY_ACCOUNT_ID,
      email: primary.email,
      connectedAt: primary.connectedAt,
      primary: true,
      connected: true,
    });
  }
  for (const stored of await loadAdditionalAccounts(env, owner.sub)) {
    const connected = (await readTokenRecord(env, accountTokenKey(owner.sub, stored.id))) !== null;
    accounts.push({ id: stored.id, email: stored.email, connectedAt: stored.connectedAt, primary: false, connected });
  }
  return accounts;
}

/**
 * Attach another Google account for its calendars.
 *
 * The identity is still proved — this app started the flow, the nonce matches,
 * the address is verified — but the Envisioning domain rule does not apply here,
 * because a personal Gmail is exactly what this is for. What does not happen is
 * anything to do with who the user is: the owner session is untouched, and the
 * account is filed as one more calendar source under the owner already signed in.
 */
export async function connectAdditionalCalendarAccount(
  env: Env,
  owner: OwnerSession,
  input: { code: string; codeVerifier: string; redirectURI: string; nonce: string },
): Promise<{ account: CalendarAccount; calendars?: GoogleCalendarListEntry[] }> {
  const clientID = nativeCalendarClient(env, input.redirectURI);
  const tokens = await exchangeGoogleCalendarCode(env, { ...input, clientID });
  const identity = await verifyGoogleIdentity(tokens.idToken, {
    audience: clientID,
    nonce: input.nonce,
    failureMessage: 'That Google account could not be verified.',
  });
  return attachCalendarAccount(env, owner, tokens, identity, { client: 'native', id: clientID });
}

/** One more calendar account, from an Android `serverAuthCode` (`exchangeAndroidCalendarCode`'s client). */
export async function connectAdditionalAndroidCalendarAccount(
  env: Env,
  owner: OwnerSession,
  serverAuthCode: string,
): Promise<{ account: CalendarAccount; calendars?: GoogleCalendarListEntry[] }> {
  const client = await androidCalendarServerClient(env);
  const tokens = await exchangeGoogleCalendarCode(env, {
    code: serverAuthCode,
    redirectURI: '',
    clientID: client.id,
    clientSecret: client.secret,
  });
  const identity = await verifyGoogleIdentity(tokens.idToken, {
    audience: client.id,
    nonce: null,
    failureMessage: 'That Google account could not be verified.',
  });
  return attachCalendarAccount(env, owner, tokens, identity, { client: client.client });
}

/**
 * File a verified account as one more calendar source. A `native` token
 * keeps the client ID that issued it; a web or calendar client token
 * refreshes with that client's configured ID.
 */
async function attachCalendarAccount(
  env: Env,
  owner: OwnerSession,
  tokens: { accessToken: string; refreshToken?: string },
  identity: GoogleIdentity,
  issuer: { client: CalendarTokenClient; id?: string },
): Promise<{ account: CalendarAccount; calendars?: GoogleCalendarListEntry[] }> {
  if (!tokens.refreshToken) {
    throw new CalendarError(
      'Google did not return a refresh token. Remove this app in that account’s Google permissions and try again.',
      400,
      'calendar_failed',
    );
  }

  const email = identity.email.toLowerCase();
  const existing = await loadAdditionalAccounts(env, owner.sub);
  const primary = await loadTokenRecord(env, owner.sub);
  if (primary && primary.email.toLowerCase() === email) {
    throw new CalendarError('That is already your connected calendar account.', 409, 'invalid_request');
  }
  // Authorising an account that is already attached is how it gets
  // reconnected once its refresh token has died. The id is kept: calendar refs
  // and stored preferences are full of it, and a new one would orphan them.
  const known = existing.find((account) => account.email.toLowerCase() === email);
  if (!known && existing.length >= 5) {
    throw new CalendarError('You can connect at most five extra Google accounts.', 400, 'invalid_request');
  }

  const account: StoredCalendarAccount = known
    ? { ...known, connectedAt: Date.now(), client: issuer.client }
    : { id: randomToken(12), email, connectedAt: Date.now(), client: issuer.client };
  await writeTokenRecord(env, accountTokenKey(owner.sub, account.id), tokens.refreshToken, email, issuer.client, issuer.id);
  const accounts = known
    ? existing.map((entry) => (entry.id === known.id ? account : entry))
    : [...existing, account];
  await env.CALENDAR_TOKENS.put(accountsKey(owner.sub), JSON.stringify(accounts));
  const summary: CalendarAccount = {
    id: account.id,
    email: account.email,
    connectedAt: account.connectedAt,
    primary: false,
    connected: true,
  };
  const calendars = await calendarsJustConnected(env, owner.sub, summary, tokens.accessToken);
  return { account: summary, ...(calendars ? { calendars } : {}) };
}

export async function removeCalendarAccount(env: Env, owner: OwnerSession, id: string): Promise<void> {
  if (id === PRIMARY_ACCOUNT_ID) {
    throw new CalendarError('Disconnect Google Calendar in Settings to remove your own account.', 400, 'invalid_request');
  }
  const existing = await loadAdditionalAccounts(env, owner.sub);
  const remaining = existing.filter((account) => account.id !== id);
  if (remaining.length === existing.length) {
    throw new CalendarError('That account is already gone.', 404, 'invalid_request');
  }
  await revokeStoredToken(env, accountTokenKey(owner.sub, id));
  await env.CALENDAR_TOKENS.delete(accountTokenKey(owner.sub, id));
  await env.CALENDAR_TOKENS.put(accountsKey(owner.sub), JSON.stringify(remaining));
}

async function loadAdditionalAccounts(env: Env, ownerSub: string): Promise<StoredCalendarAccount[]> {
  const raw = await env.CALENDAR_TOKENS.get(accountsKey(ownerSub));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is StoredCalendarAccount =>
      isRecord(entry)
      && typeof entry.id === 'string'
      && typeof entry.email === 'string'
      && isCalendarTokenClient(entry.client));
  } catch {
    return [];
  }
}

export async function listGoogleCalendars(env: Env, owner: OwnerSession): Promise<GoogleCalendarListEntry[]> {
  const prefs = await loadPreferences(env, owner.sub);
  const selected = new Set(prefs.selectedCalendarIds);
  const accounts = await listCalendarAccounts(env, owner);
  if (accounts.length === 0) {
    throw new CalendarError('Connect Google Calendar in Settings first.', 409, 'calendar_not_connected');
  }

  const perAccount = await Promise.all(accounts.map(async (account) => {
    // An account whose token is gone has nothing to list; Settings shows it as
    // needing a reconnect instead. Asking would only fail again.
    if (!account.connected) return [] as GoogleCalendarListEntry[];
    // One unreachable extra account should cost its own calendars, not the
    // whole list — but the owner's own account failing is worth saying.
    try {
      return await listCalendarsForAccount(env, owner, account, selected);
    } catch (error) {
      if (account.primary) throw error;
      console.warn('Calendar list failed for an extra account', { account: account.id, reason: describeFailure(error) });
      return [] as GoogleCalendarListEntry[];
    }
  }));
  return perAccount.flat();
}

async function listCalendarsForAccount(
  env: Env,
  owner: OwnerSession,
  account: CalendarAccount,
  selected: Set<string>,
): Promise<GoogleCalendarListEntry[]> {
  const accessToken = await accessTokenFor(env, owner, account.id);
  return fetchCalendarList(accessToken, account, selected);
}

async function fetchCalendarList(
  accessToken: string,
  account: CalendarAccount,
  selected: Set<string>,
): Promise<GoogleCalendarListEntry[]> {
  const response = await googleFetch(accessToken,
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&maxResults=250',
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    throw new CalendarError('Google Calendar could not list calendars. Reconnect Calendar to grant calendar list access.', calendarStatus(response.status), 'calendar_failed');
  }
  const body = await response.json<unknown>();
  if (!isRecord(body) || !Array.isArray(body.items)) return [];
  return body.items.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== 'string') return [];
    const summary = typeof item.summary === 'string' ? item.summary : item.id;
    const isPrimaryCalendar = item.primary === true;
    const rawId = isPrimaryCalendar ? 'primary' : item.id;
    const id = encodeCalendarRef(account.primary ? null : account.id, rawId);
    const accessRole = typeof item.accessRole === 'string' ? item.accessRole : '';
    const backgroundColor = typeof item.backgroundColor === 'string' ? item.backgroundColor : undefined;
    return [{
      id,
      summary,
      primary: isPrimaryCalendar && account.primary,
      selected: selected.has(id) || (account.primary && selected.has(item.id)),
      writable: accessRole === 'owner' || accessRole === 'writer',
      accountId: account.id,
      accountEmail: account.email,
      ...(backgroundColor ? { backgroundColor } : {}),
    }];
  });
}

export async function getCalendarPreferences(env: Env, owner: OwnerSession): Promise<CalendarPreferences> {
  return loadPreferences(env, owner.sub);
}

/// A partial update — an unsent field keeps whatever is already stored, so the
/// Settings calendar picker and the sidebar checkboxes cannot overwrite each
/// other by omission.
export async function setCalendarPreferences(
  env: Env,
  owner: OwnerSession,
  update: {
    selectedCalendarIds?: string[] | undefined;
    upcomingExcludedSubscriptionIds?: string[] | undefined;
    hiddenCalendarKeys?: string[] | undefined;
    disabledCalendarKeys?: string[] | undefined;
    demotedEventKeys?: string[] | undefined;
    includesLocalCalendars?: boolean | undefined;
    eventSubjects?: Record<string, CalendarEventSubject> | undefined;
    upcoming?: UpcomingPreferences | undefined;
  },
): Promise<CalendarPreferences> {
  const current = await loadPreferences(env, owner.sub);
  const prefs: CalendarPreferences = { ...current };

  if (update.selectedCalendarIds !== undefined) {
    const unique = [...new Set(update.selectedCalendarIds.map((value) => value.trim()).filter(Boolean))];
    if (unique.length === 0) throw new CalendarError('Select at least one calendar.', 400, 'invalid_request');
    prefs.selectedCalendarIds = unique;
  }
  if (update.upcomingExcludedSubscriptionIds !== undefined) {
    prefs.upcomingExcludedSubscriptionIds = [...new Set(
      update.upcomingExcludedSubscriptionIds.map((value) => value.trim()).filter(Boolean),
    )];
  }
  if (update.hiddenCalendarKeys !== undefined) {
    prefs.hiddenCalendarKeys = [...new Set(update.hiddenCalendarKeys.map((value) => value.trim()).filter(Boolean))];
  }
  if (update.disabledCalendarKeys !== undefined) {
    prefs.disabledCalendarKeys = [...new Set(update.disabledCalendarKeys.map((value) => value.trim()).filter(Boolean))];
  }
  if (update.demotedEventKeys !== undefined) {
    prefs.demotedEventKeys = [...new Set(update.demotedEventKeys.map((value) => value.trim()).filter(Boolean))];
  }
  if (update.includesLocalCalendars !== undefined) {
    prefs.includesLocalCalendars = update.includesLocalCalendars;
  }
  if (update.eventSubjects !== undefined) {
    prefs.eventSubjects = eventSubjectMap(update.eventSubjects);
  }
  if (update.upcoming !== undefined) {
    prefs.upcoming = normalizeUpcomingPreferences(update.upcoming);
  }

  await env.CALENDAR_TOKENS.put(prefsKey(owner.sub), JSON.stringify(prefs));
  return prefs;
}

/**
 * Only well-formed entries survive: a key with no subject, or a subject with
 * no id, is dropped rather than stored as something a client has to guard
 * against. Titles are Core's at the time of choosing; a rename shows up the
 * next time the event is opened and re-filed, not by magic.
 */
function eventSubjectMap(value: unknown): Record<string, CalendarEventSubject> {
  if (!isRecord(value)) return {};
  const map: Record<string, CalendarEventSubject> = {};
  for (const [rawKey, entry] of Object.entries(value)) {
    const key = rawKey.trim();
    if (!key || !isRecord(entry)) continue;
    const { kind, id, title } = entry;
    const parsedKind = calendarEventSubjectSchema.shape.kind.safeParse(kind);
    if (!parsedKind.success || typeof id !== 'string' || !id.trim()) continue;
    map[key] = {
      kind: parsedKind.data,
      id: id.trim(),
      title: typeof title === 'string' && title.trim() ? title.trim() : '',
    };
  }
  return map;
}

export async function createCalendarEvent(
  env: Env,
  owner: OwnerSession,
  input: CalendarEventInput,
): Promise<CalendarEventSummary> {
  // Which account the chosen calendar belongs to decides which token writes it.
  const requestedCalendarId = input.calendarId?.trim() || 'primary';
  const ref = decodeCalendarRef(requestedCalendarId);
  const accessToken = await accessTokenFor(env, owner, ref.accountId);
  const calendarId = ref.calendarId;
  let joinUrl = input.joinUrl?.trim() || '';
  // A Meet booking is a window on a room; an all-day event has no window.
  let roomSlug = input.allDay ? '' : input.roomSlug?.trim() || '';
  if (roomSlug) {
    const minted = await attachMeetBooking(env, owner, {
      title: input.title,
      start: input.start,
      end: input.end,
      roomSlug,
      ...(joinUrl ? { joinUrl } : {}),
      ...(input.guestName ? { guestName: input.guestName } : {}),
      ...(input.guestEmail ? { guestEmail: input.guestEmail } : {}),
      ...(input.manageUrl ? { manageUrl: input.manageUrl } : {}),
    });
    joinUrl = minted.joinUrl;
  }
  const descriptionParts = [
    input.description?.trim() || (joinUrl ? DEFAULT_MEETING_TITLE : ''),
    joinUrl ? `Join: ${joinUrl}` : '',
  ].filter(Boolean);

  const body: Record<string, unknown> = {
    summary: input.title,
    ...googleEventTimes(input, 'insert'),
    attendees: input.attendees.map((email) => ({ email })),
  };
  if (descriptionParts.length > 0) body.description = descriptionParts.join('\n\n');
  Object.assign(body, locationPatch(input.location, joinUrl));
  const travel = input.travelTimeMinutes ?? 0;
  if (roomSlug || joinUrl || travel > 0) {
    body.extendedProperties = {
      private: {
        meetApp: meetAppProperty,
        ...(roomSlug ? { meetRoomSlug: roomSlug } : {}),
        ...(joinUrl ? { meetJoinUrl: joinUrl } : {}),
        // The key `travelTimeMinutesFromMetadata` reads back, as a string:
        // Google's extended properties are strings.
        ...(travel > 0 ? { meetTravelTimeMinutes: String(travel) } : {}),
      },
    };
  }

  const sendUpdates = input.attendees.length > 0 ? 'all' : 'none';
  const encodedId = encodeURIComponent(calendarId);
  const response = await googleFetch(accessToken,
    `https://www.googleapis.com/calendar/v3/calendars/${encodedId}/events?sendUpdates=${sendUpdates}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new CalendarError('Google Calendar could not create the event.', calendarStatus(response.status), 'calendar_failed');
  }
  const event = await response.json<unknown>();
  const attendeeNames = await loadCrmAttendeeMatches(env, [event], owner);
  const calendars = await listGoogleCalendars(env, owner);
  const calendarSummary = calendars.find((calendar) => calendar.id === requestedCalendarId)?.summary
    ?? (calendarId === 'primary' ? 'Primary' : calendarId);
  const summary = summarizeEvent(event, {
    joinUrl,
    roomSlug,
    // The id the caller asked for, so the answer lands back on the calendar
    // they picked rather than on a same-named one in another account.
    calendarId: requestedCalendarId,
    calendarSummary,
    webOrigin: env.WEB_ORIGIN,
    publicOrigin: workspacePublicOrigin(env),
    globalInterestTitle: globalInterestCalendarTitle(env),
    attendeeNames,
  });
  if (roomSlug && input.coreSync !== false) await syncHostBookings(env, owner, roomSlug, summary, input.notifyGuests ?? true);
  return summary;
}

/**
 * One Meet token per attendee, minted and mailed by Core (,
 *). Called after the Google write on any event that
 * carries the owner's room. Core reconciles: a repeat call mints only new
 * guests, cancels dropped ones, re-sends when the window moved, and skips
 * members. Never fatal — the event stands with its generic link in the
 * description if Core is down; the failure is logged, not surfaced.
 */
async function syncHostBookings(
  env: Env,
  owner: OwnerSession,
  roomSlug: string,
  event: CalendarEventSummary,
  notify: boolean,
): Promise<void> {
  if (!crmSyncEnabled(env)) return;
  const ownerEmail = owner.email.toLowerCase();
  const guests = event.attendees
    .filter((attendee) => attendee.email && attendee.email !== ownerEmail)
    .map((attendee) => ({ name: attendee.name || attendee.email, email: attendee.email }));
  try {
    const response = await corePatFetch(env, owner.email, '/api/agent/bookings', {
      method: 'POST',
      body: {
        host_username: roomSlug,
        title: event.title || DEFAULT_MEETING_TITLE,
        start_time: event.start,
        end_time: event.end,
        external_event_id: event.id,
        guests,
        notify,
      },
    });
    if (!response.ok) {
      console.warn(`Core bookings sync failed (${response.status}) for event ${event.id}.`);
    }
  } catch (error) {
    console.warn(`Core bookings sync failed for event ${event.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The event is gone: Core cancels every row it holds for it and tells each guest. */
async function cancelHostBookings(env: Env, owner: OwnerSession, eventId: string, notify: boolean): Promise<void> {
  if (!crmSyncEnabled(env)) return;
  const roomSlug = await roomOfMember(env, owner.email);
  if (!roomSlug) return;
  try {
    const response = await corePatFetch(env, owner.email, '/api/agent/bookings', {
      method: 'DELETE',
      searchParams: { host_username: roomSlug, external_event_id: eventId, notify: notify ? 'true' : 'false' },
    });
    if (!response.ok) {
      console.warn(`Core bookings cancel failed (${response.status}) for event ${eventId}.`);
    }
  } catch (error) {
    console.warn(`Core bookings cancel failed for event ${eventId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function listUpcomingCalendarEvents(
  env: Env,
  owner: OwnerSession,
  hours?: number,
): Promise<CalendarEventSummary[]> {
  const tokenFor = tokenPool(env, owner);
  const prefs = await loadPreferences(env, owner.sub);
  const calendars = await listGoogleCalendars(env, owner);
  const calendarNames = new Map(calendars.map((calendar) => [calendar.id, calendar.summary]));
  const now = new Date();
  // Google's timeMin is exclusive on event *end* time, so `now` drops anything
  // already finished today. Look back far enough that any local "today" is covered;
  // the Mac client buckets by Calendar.current day for the Today column / idle list.
  const timeMin = new Date(now.getTime() - 36 * 3_600_000);
  const requestedHours = Math.max(hours ?? 0, upcomingRequestHours(prefs.upcoming));
  const timeMax = new Date(now.getTime() + Math.max(1, Math.min(requestedHours, 24 * 100)) * 3_600_000);
  const selectedIDs = new Set(prefs.selectedCalendarIds.length > 0 ? prefs.selectedCalendarIds : defaultSelectedCalendars);
  const disabled = new Set(prefs.disabledCalendarKeys);
  const selected = calendars
    .filter((calendar) =>
      selectedIDs.has(calendar.id)
      && !disabled.has(googleCalendarKey(calendar.id))
      && !disabled.has(accountKey(calendar.accountEmail))
      && !disabled.has(accountKey(googleAccountTitle(null, false))))
    .map((calendar) => calendar.id);

  const batches = await Promise.all(selected.map(async (calendarId) => {
    const params = new URLSearchParams({
      singleEvents: 'true',
      showHiddenInvitations: 'true',
      orderBy: 'startTime',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults: '250',
    });
    const ref = decodeCalendarRef(calendarId);
    const accessToken = await tokenFor(ref.accountId);
    const encodedId = encodeURIComponent(ref.calendarId);
    const response = await googleFetch(accessToken,
      `https://www.googleapis.com/calendar/v3/calendars/${encodedId}/events?${params}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok) return [] as Array<{ item: unknown; calendarId: string }>;
    const body = await response.json<unknown>();
    if (!isRecord(body) || !Array.isArray(body.items)) return [];
    return body.items.map((item) => ({ item, calendarId }));
  }));
  const rawEvents = batches.flat();
  const attendeeNames = await loadCrmAttendeeMatches(env, rawEvents.map(({ item }) => item), owner);

  return rawEvents
    .flatMap(({ item, calendarId }) => {
      try {
        if (isCancelledEvent(item)) return [];
        return [applyEventPreferences(summarizeListedEvent(item, {
          calendarId,
          calendarSummary: calendarNames.get(calendarId) ?? calendarId,
          webOrigin: env.WEB_ORIGIN,
          publicOrigin: workspacePublicOrigin(env),
          globalInterestTitle: globalInterestCalendarTitle(env),
          attendeeNames,
        }), prefs)];
      } catch {
        return [];
      }
    })
    .filter((event) => isDisplayableUpcomingEvent(event))
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start))
    .slice(0, UPCOMING_CONFIG.maxAgendaEvents);
}

/** Week/month grid: every event on the listed calendars, including blocks. */
/**
 * One calendar's events, as Google lists them. A calendar deleted or unshared
 * since the list was read has none, which is not a failure. Any other refusal,
 * or a body that is not a list, is a failed refresh and says so:
 * before this it read as an empty calendar. The log names only the status and
 * the account role, never a token, a calendar or an event.
 */
async function readCalendarEvents(
  tokenFor: TokenFor,
  calendar: GoogleCalendarListEntry,
  params: URLSearchParams,
): Promise<Array<{ item: unknown; calendar: GoogleCalendarListEntry }>> {
  const ref = decodeCalendarRef(calendar.id);
  const encodedId = encodeURIComponent(ref.calendarId);
  const items: Array<{ item: unknown; calendar: GoogleCalendarListEntry }> = [];
  // Google pages a list at `maxResults`; a long window on a busy calendar
  // runs past one page. Before 2026-10-07 only the first page was read, so
  // an invitation weeks ahead never reached INBOX.
  let pageToken: string | undefined;
  for (let page = 0; page < CALENDAR_EVENT_PAGES; page += 1) {
    const query = new URLSearchParams(params);
    if (pageToken) query.set('pageToken', pageToken);
    const body = await readCalendarEventsPage(tokenFor, ref, encodedId, query);
    if (!body) return items;
    items.push(...body.items.map((item) => ({ item, calendar })));
    pageToken = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : undefined;
    if (!pageToken) return items;
  }
  console.warn('Calendar events read stopped at the page ceiling', { pages: CALENDAR_EVENT_PAGES });
  return items;
}

/** Past this many pages a read keeps what it has and logs it. */
const CALENDAR_EVENT_PAGES = 10;

/** One page of one calendar's events; null when the calendar is gone. */
async function readCalendarEventsPage(
  tokenFor: TokenFor,
  ref: { accountId: string | null; calendarId: string },
  encodedId: string,
  params: URLSearchParams,
): Promise<{ items: unknown[]; nextPageToken?: unknown } | null> {
  const read = async (renew: boolean) => {
    const accessToken = await tokenFor(ref.accountId, renew);
    return googleFetch(accessToken,
      `https://www.googleapis.com/calendar/v3/calendars/${encodedId}/events?${params}`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
  };
  let response = await read(false);
  // A cached access token can be revoked or rotated before its stated expiry.
  // That is not the owner's consent going away, so mint a new one and ask
  // again before anything reaches the client as an auth failure.
  if (response.status === 401) response = await read(true);
  if (response.status === 404 || response.status === 410) return null;
  const account = ref.accountId && ref.accountId !== PRIMARY_ACCOUNT_ID ? 'additional' : 'primary';
  if (!response.ok) {
    const reason = await googleErrorReason(response);
    console.warn('Calendar events read failed', { status: response.status, reason, account });
    // Google answers a per-user rate limit as 403. calendarStatus makes every
    // 403 a 401, which a client reads as an expired sign-in: say "busy" instead.
    const busy = response.status === 429
      || (response.status === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/u.test(reason));
    throw new CalendarError(
      busy
        ? 'Google Calendar is busy. Try again in a moment.'
        : 'Google Calendar could not list events. Try again, or reconnect Calendar in Settings.',
      busy ? 429 : calendarStatus(response.status),
      'calendar_failed',
    );
  }
  const body = await response.json<unknown>().catch(() => null);
  if (!isRecord(body) || !Array.isArray(body.items)) {
    console.warn('Calendar events read returned an unreadable body', { status: response.status, account });
    throw new CalendarError('Google Calendar returned events Starlings couldn’t read.', 502, 'calendar_failed');
  }
  return { items: body.items, nextPageToken: body.nextPageToken };
}

export async function listCalendarEventsInRange(
  env: Env,
  owner: OwnerSession,
  timeMin: string,
  timeMax: string,
): Promise<CalendarEventSummary[]> {
  const tokenFor = tokenPool(env, owner);
  const prefs = await loadPreferences(env, owner.sub);
  const calendars = await listGoogleCalendars(env, owner);
  const batches = await Promise.all(calendars.map(async (calendar) => {
    const params = new URLSearchParams({
      singleEvents: 'true',
      showHiddenInvitations: 'true',
      orderBy: 'startTime',
      timeMin,
      timeMax,
      maxResults: '250',
    });
    return readCalendarEvents(tokenFor, calendar, params);
  }));
  const rawEvents = batches.flat();
  const attendeeNames = await loadCrmAttendeeMatches(env, rawEvents.map(({ item }) => item), owner);

  return rawEvents
    .flatMap(({ item, calendar }) => {
      try {
        if (isCancelledEvent(item)) return [];
        return [applyEventPreferences(summarizeListedEvent(item, {
          calendarId: calendar.id,
          calendarSummary: calendar.summary,
          webOrigin: env.WEB_ORIGIN,
          publicOrigin: workspacePublicOrigin(env),
          globalInterestTitle: globalInterestCalendarTitle(env),
          attendeeNames,
        }), prefs)];
      } catch {
        return [];
      }
    })
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start));
}

/**
 * Invitations are account state, not a preference or a device-local cache.
 * Read them from every connected Google calendar so accepting one on the Mac
 * removes the same row from iOS after its next refresh.
 */
export async function listCalendarInvitations(
  env: Env,
  owner: OwnerSession,
): Promise<CalendarEventSummary[]> {
  return (await readCalendarInvitations(env, owner)).map((row) => row.event);
}

/**
 * The invitations with Google's `updated` stamp, epoch milliseconds (0 when
 * Google sent none): INBOX orders by it, so a new or changed invitation is
 * news, where the Calendar list orders by start.
 */
export async function readCalendarInvitations(
  env: Env,
  owner: OwnerSession,
): Promise<Array<{ event: CalendarEventSummary; updatedMs: number }>> {
  const tokenFor = tokenPool(env, owner);
  const preferences = await loadPreferences(env, owner.sub);
  const calendars = await listGoogleCalendars(env, owner);
  const now = Date.now();
  const timeMin = new Date(now - calendarInvitationLookbackMilliseconds).toISOString();
  const timeMax = new Date(now + calendarInvitationLookaheadMilliseconds).toISOString();

  const batches = await Promise.all(calendars.map(async (calendar) => {
    const params = new URLSearchParams({
      singleEvents: 'true',
      showHiddenInvitations: 'true',
      orderBy: 'startTime',
      timeMin,
      timeMax,
      maxResults: '250',
    });
    return readCalendarEvents(tokenFor, calendar, params);
  }));

  const seen = new Set<string>();
  return batches.flat()
    .flatMap(({ item, calendar }) => {
      if (!isPendingCalendarInvitation(item) || !isRecord(item) || typeof item.id !== 'string') return [];
      // Google can expose one invitation through more than one selected
      // calendar. The event belongs to the connected account, so keep one
      // row per account/event and let the first calendar provide the RSVP
      // target.
      const accountID = decodeCalendarRef(calendar.id).accountId ?? PRIMARY_ACCOUNT_ID;
      const key = `${accountID}:${item.id}`;
      if (!seen.add(key)) return [];
      try {
        const event = applyEventPreferences(summarizeListedEvent(item, {
          calendarId: calendar.id,
          calendarSummary: calendar.summary,
          webOrigin: env.WEB_ORIGIN,
          publicOrigin: workspacePublicOrigin(env),
          globalInterestTitle: globalInterestCalendarTitle(env),
        }), preferences);
        const updatedMs = typeof item.updated === 'string' ? Date.parse(item.updated) : Number.NaN;
        return [{ event, updatedMs: Number.isNaN(updatedMs) ? 0 : updatedMs }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => Date.parse(left.event.start) - Date.parse(right.event.start));
}

/**
 * Google's `start`/`end`: `date` for an all-day event, `dateTime` (with the
 * host's zone) otherwise. One shape for create and patch, so a patch that
 * turns a timed event all-day writes `date` and clears the other field —
 * Google keeps whichever of the two it last saw unless told otherwise.
 */
export function googleEventTimes(
  input: { start: string; end: string; allDay?: boolean | undefined; timeZone?: string | undefined },
  /** A patch clears the field it is not using; an insert has nothing to clear. */
  mode: 'insert' | 'patch' = 'patch',
): {
  start: Record<string, unknown>;
  end: Record<string, unknown>;
} {
  const clear = (field: 'date' | 'dateTime') => (mode === 'patch' ? { [field]: null } : {});
  if (input.allDay) {
    return { start: { date: input.start, ...clear('dateTime') }, end: { date: input.end, ...clear('dateTime') } };
  }
  const zone = input.timeZone ? { timeZone: input.timeZone } : {};
  return {
    start: { dateTime: input.start, ...clear('date'), ...zone },
    end: { dateTime: input.end, ...clear('date'), ...zone },
  };
}

export async function patchCalendarEvent(
  env: Env,
  owner: OwnerSession,
  input: CalendarEventPatchInput,
): Promise<CalendarEventSummary> {
  const ref = decodeCalendarRef(input.calendarId);
  const accessToken = await accessTokenFor(env, owner, ref.accountId);
  let joinUrl = input.joinUrl?.trim();
  let roomSlug = input.allDay ? undefined : input.roomSlug?.trim();
  if (roomSlug && input.start && input.end) {
    const minted = await attachMeetBooking(env, owner, {
      title: input.title ?? DEFAULT_MEETING_TITLE,
      start: input.start,
      end: input.end,
      roomSlug,
      ...(joinUrl ? { joinUrl } : {}),
    });
    joinUrl = minted.joinUrl;
  }
  const body: Record<string, unknown> = {};
  if (input.title !== undefined) body.summary = input.title;
  if (input.start !== undefined && input.end !== undefined) {
    Object.assign(body, googleEventTimes({ start: input.start, end: input.end, ...(input.allDay !== undefined ? { allDay: input.allDay } : {}), ...(input.timeZone ? { timeZone: input.timeZone } : {}) }));
  }
  // Google returns the whole attendee list on a PATCH that touches `attendees`,
  // so replacing it with bare `{ email }` rows silently resets everyone's RSVP
  // to needsAction and re-invites them. Merge onto the stored rows instead and
  // only send the list when the membership actually changed.
  let attendeesChanged = false;
  if (input.attendees !== undefined) {
    const merged = await mergeAttendees(accessToken, ref.calendarId, input.eventId, input.attendees);
    attendeesChanged = merged.changed;
    if (merged.changed) body.attendees = merged.attendees;
  }
  if (input.description !== undefined) body.description = input.description;
  // A cleared location on an event that already carries our room needs the
  // stored link to fall back on; the patch alone does not say it.
  const fallbackJoinUrl = joinUrl === undefined && input.location !== undefined && !input.location.trim()
    ? await storedJoinUrl(accessToken, ref.calendarId, input.eventId)
    : joinUrl;
  Object.assign(body, locationPatch(input.location, fallbackJoinUrl));
  if (joinUrl !== undefined || roomSlug !== undefined || input.travelTimeMinutes !== undefined) {
    // A PATCH on `extendedProperties.private` merges keys; `null` deletes one.
    // So a travel change touches its key alone and leaves the room keys as
    // they are, and the other way round.
    const travel = input.travelTimeMinutes;
    body.extendedProperties = {
      private: {
        ...(joinUrl !== undefined || roomSlug !== undefined ? { meetApp: meetAppProperty } : {}),
        ...(roomSlug ? { meetRoomSlug: roomSlug } : {}),
        ...(joinUrl ? { meetJoinUrl: joinUrl } : {}),
        ...(travel !== undefined ? { meetTravelTimeMinutes: travel && travel > 0 ? String(travel) : null } : {}),
      },
    };
  }

  const rescheduled = input.start !== undefined && input.end !== undefined;
  const sendUpdates = guestNotification({ attendeesChanged, rescheduled });
  const encodedCal = encodeURIComponent(ref.calendarId);
  const encodedEvent = encodeURIComponent(input.eventId);
  const response = await googleFetch(accessToken,
    `https://www.googleapis.com/calendar/v3/calendars/${encodedCal}/events/${encodedEvent}?sendUpdates=${sendUpdates}`,
    {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw new CalendarError('Google Calendar could not update the event.', calendarStatus(response.status), 'calendar_failed');
  }
  const event = await response.json<unknown>();
  const calendars = await listGoogleCalendars(env, owner);
  const calendarSummary = calendars.find((calendar) => calendar.id === input.calendarId)?.summary
    ?? input.calendarId;
  const attendeeNames = await loadCrmAttendeeMatches(env, [event], owner);
  const summary = summarizeListedEvent(event, {
    calendarId: input.calendarId,
    calendarSummary,
    webOrigin: env.WEB_ORIGIN,
    publicOrigin: workspacePublicOrigin(env),
    globalInterestTitle: globalInterestCalendarTitle(env),
    attendeeNames,
  });
  // A guest's booking from the booking page follows its event. Google tells
  // the guest about the move; Core only keeps its row in step and mails
  // nobody, since the guest never had Core's link.
  const booked = await bookingForEvent(env, owner.sub, input.eventId);
  if (booked && !summary.allDay) {
    const start = Date.parse(summary.start);
    const end = Date.parse(summary.end);
    const moved = booked.starts_at !== start || booked.ends_at !== end;
    await moveBooking(env, booked, start, end);
    if (moved && booked.join_token && !booked.core_token) {
      await changeBookingInteraction(env, owner, booked.join_token, { action: 'moved', start_time: summary.start, end_time: summary.end });
    }
  }
  // Any event on the owner's room: the one being patched onto it now, or one
  // already on it whose guests or window just changed. A booking Meet's page
  // took has no host-issued row in Core, unless it predates the
  // booking-interaction route (`core_token`).
  const bookingRoom = roomSlug || summary.roomSlug;
  if (bookingRoom && (!booked || booked.core_token)) await syncHostBookings(env, owner, bookingRoom, summary, !booked);
  return summary;
}

/**
 * Merge a desired guest list onto the rows Google already stores, keeping
 * `responseStatus`, `displayName`, `optional` and `organizer` for everyone who
 * stays on the invite. Reports `changed: false` when membership is identical so
 * the caller can skip both the write and the notification.
 */
/**
 * Whether Google should email the guests about this change. The invite list
 * changing is one reason; the meeting moving is the other. A reschedule
 * notifies whether or not the caller sent the guest list — a drag in the
 * grid sends none, on purpose, so it cannot rewrite RSVPs — because Google
 * only writes to the guests the event actually has: with none, `all` costs
 * nothing, and with some, `none` would leave them at the wrong hour.
 */
export function guestNotification(change: { attendeesChanged: boolean; rescheduled: boolean }): 'all' | 'none' {
  return change.attendeesChanged || change.rescheduled ? 'all' : 'none';
}

/**
 * What Google stores as the event's location. A typed room or address wins;
 * with none, the join link takes the slot so Google Calendar and Apple
 * Calendar show a Join button (neither lets a third party without a
 * conference add-on write `conferenceData`). An empty location with no link
 * clears the field; an undefined one leaves it alone.
 */
function locationPatch(location: string | undefined, joinUrl: string | undefined): Record<string, string> {
  if (location?.trim()) return { location };
  if (joinUrl) return { location: joinUrl };
  return location === undefined ? {} : { location: '' };
}

/** The room link an event already carries, or '' when Google will not say. */
async function storedJoinUrl(accessToken: string, calendarId: string, eventId: string): Promise<string> {
  const encodedCal = encodeURIComponent(calendarId);
  const encodedEvent = encodeURIComponent(eventId);
  const response = await googleFetch(accessToken,
    `https://www.googleapis.com/calendar/v3/calendars/${encodedCal}/events/${encodedEvent}?fields=extendedProperties`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) return '';
  const event: unknown = await response.json();
  const privateProps = isRecord(event) && isRecord(event.extendedProperties) && isRecord(event.extendedProperties.private)
    ? event.extendedProperties.private
    : {};
  return typeof privateProps.meetJoinUrl === 'string' ? privateProps.meetJoinUrl : '';
}

async function mergeAttendees(
  accessToken: string,
  calendarId: string,
  eventId: string,
  desired: string[],
): Promise<{ attendees: Record<string, unknown>[]; changed: boolean }> {
  const wanted = new Map<string, string>();
  for (const raw of desired) {
    const email = raw.trim().toLowerCase();
    if (email) wanted.set(email, raw.trim());
  }

  const encodedCal = encodeURIComponent(calendarId);
  const encodedEvent = encodeURIComponent(eventId);
  const response = await googleFetch(accessToken,
    `https://www.googleapis.com/calendar/v3/calendars/${encodedCal}/events/${encodedEvent}?fields=attendees`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    // Without the stored rows there is no safe merge, and writing the bare list
    // would clear RSVPs. Say so: a save that quietly kept the old guest list
    // while reporting success is worse than one that fails and can be retried.
    throw new CalendarError(
      `Google did not return the event's guest list (${response.status}), so the guests were not changed. Try again.`,
      502,
      'calendar_failed',
    );
  }
  const body = await response.json<unknown>();
  const existing = isRecord(body) && Array.isArray(body.attendees) ? body.attendees : [];

  const stored = new Map<string, Record<string, unknown>>();
  for (const raw of existing) {
    if (!isRecord(raw)) continue;
    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
    if (email) stored.set(email, raw);
  }

  const merged: Record<string, unknown>[] = [];
  for (const [email, original] of wanted) {
    const prior = stored.get(email);
    merged.push(prior ? { ...prior } : { email: original });
  }
  // Rows Google keeps without an address (rooms, name-only guests) have no key
  // to match on, so carry them across untouched rather than dropping them.
  for (const raw of existing) {
    if (!isRecord(raw)) continue;
    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
    if (!email) merged.push({ ...raw });
  }

  const before = [...stored.keys()].sort().join(',');
  const after = [...wanted.keys()].sort().join(',');
  return { attendees: merged, changed: before !== after };
}

/**
 * Move an event to another Google calendar.
 *
 * Google has a dedicated `move` verb for this. Patching `organizer` or
 * recreating the event would lose the id, and with it the guests' copies and
 * their replies.
 */
export async function moveCalendarEvent(
  env: Env,
  owner: OwnerSession,
  input: { calendarId: string; eventId: string; destinationId: string },
): Promise<CalendarEventSummary> {
  const ref = decodeCalendarRef(input.calendarId);
  const destination = decodeCalendarRef(input.destinationId);
  // Google moves an event between calendars the same account can see. Across
  // accounts there is no move to make, and saying so beats a 404 from Google.
  if (ref.accountId !== destination.accountId) {
    throw new CalendarError(
      'Moving an event between two Google accounts is not something Google can do. Copy it instead.',
      400,
      'invalid_request',
    );
  }
  const calendars = await listGoogleCalendars(env, owner);
  const sourceCalendar = calendars.find((calendar) => calendar.id === input.calendarId);
  const destinationCalendar = calendars.find((calendar) => calendar.id === input.destinationId);
  if (!sourceCalendar || !destinationCalendar) {
    throw new CalendarError(
      'Choose two calendars that are still connected to this account.',
      404,
      'invalid_request',
    );
  }
  const sharedTitle = globalInterestCalendarTitle(env);
  if (calendarRoleForSummary(sourceCalendar.summary, sharedTitle) === 'global_interest') {
    throw new CalendarError(
      `${sourceCalendar.summary} is shared. Duplicate this event for a personal copy instead of moving it out.`,
      400,
      'invalid_request',
    );
  }
  if (calendarRoleForSummary(destinationCalendar.summary, sharedTitle) === 'global_interest') {
    throw new CalendarError(
      `${destinationCalendar.summary} is shared. Create or duplicate an event there instead of moving an existing event into it.`,
      400,
      'invalid_request',
    );
  }
  const accessToken = await accessTokenFor(env, owner, ref.accountId);
  const params = new URLSearchParams({ destination: destination.calendarId, sendUpdates: 'all' });
  const encodedCal = encodeURIComponent(ref.calendarId);
  const encodedEvent = encodeURIComponent(input.eventId);
  const response = await googleFetch(accessToken,
    `https://www.googleapis.com/calendar/v3/calendars/${encodedCal}/events/${encodedEvent}/move?${params}`,
    { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    throw new CalendarError(
      'Google Calendar could not move the event.',
      calendarStatus(response.status),
      'calendar_failed',
    );
  }
  const event = await response.json<unknown>();
  const attendeeNames = await loadCrmAttendeeMatches(env, [event], owner);
  const calendarSummary = destinationCalendar?.summary
    ?? input.destinationId;
  return summarizeListedEvent(event, {
    calendarId: input.destinationId,
    calendarSummary,
    webOrigin: env.WEB_ORIGIN,
    publicOrigin: workspacePublicOrigin(env),
    globalInterestTitle: globalInterestCalendarTitle(env),
    attendeeNames,
  });
}

/** Google caps a freeBusy query; asking about a crowd is not the use case. */
export const FREE_BUSY_MAX_PEOPLE = 20;

/**
 * When colleagues are busy, for picking a meeting time.
 *
 * Returns only opaque intervals — never titles, guests, or locations. Free/busy
 * is the one calendar read that crosses between people, so it stays the
 * narrowest thing that answers "can they make it".
 */
export async function fetchCalendarFreeBusy(
  env: Env,
  owner: OwnerSession,
  input: { timeMin: string; timeMax: string; emails: string[] },
): Promise<CalendarFreeBusyPerson[]> {
  const emails = [...new Set(input.emails.map((email) => email.trim().toLowerCase()))]
    .filter(Boolean)
    .slice(0, FREE_BUSY_MAX_PEOPLE);
  if (emails.length === 0) return [];

  const request = (accessToken: string) => googleFetch(accessToken, 'https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      items: emails.map((id) => ({ id })),
    }),
  });
  let response = await request(await accessTokenFor(env, owner));
  if (response.status === 401) {
    // The access token was revoked or rotated under us (a cached one outlives
    // a revocation). googleFetch has dropped it, so this mints a fresh one: a
    // stale cache entry must not read as "your Calendar access expired".
    response = await request(await accessTokenFor(env, owner));
  }
  if (!response.ok) {
    const reason = await googleErrorReason(response);
    console.warn('Calendar free/busy read failed', { status: response.status, reason });
    throw freeBusyRequestFailure(response.status, reason);
  }

  const body = await response.json<unknown>();
  const calendars = isRecord(body) && isRecord(body.calendars) ? body.calendars : {};
  return emails.map((email) => {
    const entry = calendars[email];
    if (!isRecord(entry)) {
      return { email, busy: [], error: 'unavailable' };
    }
    const errors = Array.isArray(entry.errors) ? entry.errors : [];
    const reason = freeBusyPersonReason(errors.length > 0
      ? errors
        .map((raw) => (isRecord(raw) && typeof raw.reason === 'string' ? raw.reason : ''))
        .find(Boolean) ?? 'unknown'
      : '');
    const busy = (Array.isArray(entry.busy) ? entry.busy : []).flatMap((raw) => {
      if (!isRecord(raw) || typeof raw.start !== 'string' || typeof raw.end !== 'string') return [];
      return [{ start: raw.start, end: raw.end }];
    });
    return { email, busy, error: reason };
  });
}

/**
 * The owner's own busy time on their primary Google calendar, for the slots
 * a guest may book (docs/CORE_FOLD_PLAN.md §Phase 3d). An answer Google
 * marks with an error is a failure, not a free calendar: offering a slot
 * that is already taken is worse than offering none.
 */
export async function ownBusyIntervals(
  env: Env,
  owner: OwnerSession,
  timeMin: string,
  timeMax: string,
): Promise<Array<{ start: number; end: number }>> {
  const [mine] = await fetchCalendarFreeBusy(env, owner, { timeMin, timeMax, emails: [owner.email] });
  if (!mine || mine.error) {
    throw new CalendarError('Google Calendar could not check availability. Try again in a moment.', 502, 'calendar_failed');
  }
  return mine.busy.map((interval) => ({ start: Date.parse(interval.start), end: Date.parse(interval.end) }));
}

/**
 * What a per-person free/busy answer means, in the words the clients show
 *. Google answers `notFound` for a calendar the caller may not see
 * at all: another Workspace domain that does not share free/busy, an address
 * with no calendar, or a person who has restricted sharing. Meet cannot tell
 * those apart, and all of them read "their calendar isn't shared with you",
 * which is a state, not an error.
 *
 * Clients only test the string for empty, so older builds keep working.
 */
export type FreeBusyPersonReason = '' | 'not_shared' | 'temporarily_unavailable' | 'unavailable';

export function freeBusyPersonReason(googleReason: string): FreeBusyPersonReason {
  if (!googleReason) return '';
  if (googleReason === 'notFound') return 'not_shared';
  if (googleReason === 'internalError' || googleReason === 'backendError') return 'temporarily_unavailable';
  // groupNotFound, groupTooBig, tooManyCalendarsRequested, and anything new.
  return 'unavailable';
}

/** Google's first error `reason` from a failed response, or '' (never throws). */
async function googleErrorReason(response: Response): Promise<string> {
  const body = await response.json<unknown>().catch(() => null);
  if (!isRecord(body) || !isRecord(body.error)) return '';
  const errors = Array.isArray(body.error.errors) ? body.error.errors : [];
  const reason = errors
    .map((raw) => (isRecord(raw) && typeof raw.reason === 'string' ? raw.reason : ''))
    .find(Boolean);
  if (reason) return reason;
  return typeof body.error.status === 'string' ? body.error.status : '';
}

/**
 * Every way the whole free/busy request can fail, each with its own code and
 * sentence. 401/403 from Google used to become a bare 401 `calendar_failed`,
 * which the web calendar read as "sign in again" (calendarStatus). Only a
 * refused Meet session is that; a Google refusal is never reported as one.
 */
export function freeBusyRequestFailure(status: number, reason: string): CalendarError {
  if (status === 401) {
    return new CalendarError('Google Calendar access expired. Reconnect Calendar in Settings.', 401, 'calendar_expired');
  }
  if (status === 403) {
    if (/rateLimitExceeded|userRateLimitExceeded|quotaExceeded|dailyLimitExceeded|RESOURCE_EXHAUSTED/u.test(reason)) {
      return new CalendarError('Google Calendar is busy. Try again in a moment.', 429, 'rate_limited');
    }
    // The stored grant predates the availability scope, or Workspace admin
    // turned the Calendar API off for this app: reconnecting is the only fix.
    return new CalendarError(
      'Google Calendar did not allow the availability check. Reconnect Calendar in Settings.',
      403,
      'calendar_expired',
    );
  }
  if (status === 429) return new CalendarError('Google Calendar is busy. Try again in a moment.', 429, 'rate_limited');
  if (status === 400) {
    return new CalendarError('Google Calendar rejected that time range.', 400, 'invalid_request');
  }
  return new CalendarError('Google Calendar could not check availability. Try again in a moment.', 502, 'calendar_failed');
}

export type CalendarRsvpResponse = 'accepted' | 'declined' | 'tentative';

/**
 * Answer an invitation as the connected account.
 *
 * Google has no "respond" verb: you PATCH the event with the whole attendee
 * list and your own row's `responseStatus` changed. That makes the read of the
 * stored rows mandatory — writing a synthesised list would clear everyone
 * else's replies, which is the bug this file already had once.
 */
export async function respondToCalendarEvent(
  env: Env,
  owner: OwnerSession,
  input: { calendarId: string; eventId: string; response: CalendarRsvpResponse },
): Promise<CalendarEventSummary> {
  const ref = decodeCalendarRef(input.calendarId);
  const accessToken = await accessTokenFor(env, owner, ref.accountId);
  const encodedCal = encodeURIComponent(ref.calendarId);
  const encodedEvent = encodeURIComponent(input.eventId);

  const current = await googleFetch(accessToken,
    `https://www.googleapis.com/calendar/v3/calendars/${encodedCal}/events/${encodedEvent}?fields=attendees`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!current.ok) {
    throw new CalendarError('Google Calendar could not load this invitation.', calendarStatus(current.status), 'calendar_failed');
  }
  const body = await current.json<unknown>();
  const existing = isRecord(body) && Array.isArray(body.attendees) ? body.attendees : [];
  const rows = existing.filter(isRecord);
  if (!rows.some((row) => row.self === true)) {
    throw new CalendarError('You are not on this event’s guest list.', 409, 'calendar_not_invited');
  }

  const attendees = rows.map((row) => (
    row.self === true ? { ...row, responseStatus: input.response } : { ...row }
  ));

  // The organiser should learn that you declined, so this one does notify.
  const response = await googleFetch(accessToken,
    `https://www.googleapis.com/calendar/v3/calendars/${encodedCal}/events/${encodedEvent}?sendUpdates=all`,
    {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ attendees }),
    },
  );
  if (!response.ok) {
    throw new CalendarError('Google Calendar could not save your reply.', calendarStatus(response.status), 'calendar_failed');
  }
  const event = await response.json<unknown>();
  const calendars = await listGoogleCalendars(env, owner);
  const calendarSummary = calendars.find((calendar) => calendar.id === input.calendarId)?.summary
    ?? input.calendarId;
  const attendeeNames = await loadCrmAttendeeMatches(env, [event], owner);
  return summarizeListedEvent(event, {
    calendarId: input.calendarId,
    calendarSummary,
    webOrigin: env.WEB_ORIGIN,
    publicOrigin: workspacePublicOrigin(env),
    globalInterestTitle: globalInterestCalendarTitle(env),
    attendeeNames,
  });
}

export async function deleteCalendarEvent(
  env: Env,
  owner: OwnerSession,
  // `notifyGuests: false`: Google tells the guests, so Core does not mail them too.
  input: { calendarId: string; eventId: string; notifyGuests?: boolean },
): Promise<void> {
  const ref = decodeCalendarRef(input.calendarId);
  const accessToken = await accessTokenFor(env, owner, ref.accountId);
  const encodedCal = encodeURIComponent(ref.calendarId);
  const encodedEvent = encodeURIComponent(input.eventId);
  const response = await googleFetch(accessToken,
    `https://www.googleapis.com/calendar/v3/calendars/${encodedCal}/events/${encodedEvent}?sendUpdates=all`,
    {
      method: 'DELETE',
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  // 410 is Google's answer for an event that is already deleted, so a second
  // delete is a no-op. 404 means the id never matched: that is a bug on the
  // caller's side and must not read as success.
  if (response.status === 404) {
    throw new CalendarError('Google Calendar could not find the event.', 404, 'calendar_event_not_found');
  }
  if (!response.ok && response.status !== 410) {
    throw new CalendarError('Google Calendar could not delete the event.', calendarStatus(response.status), 'calendar_failed');
  }
  // A guest's booking from the booking page goes with its event: the row is
  // cancelled and the join card stops answering. Google told the guest.
  const booked = await bookingForEvent(env, owner.sub, input.eventId);
  if (booked) {
    await cancelBookingRow(env, booked.id);
    if (booked.join_url) await forgetMeetBooking(env, booked.room, booked.join_url);
    if (booked.nda_request_id) await withdrawBookingNda(env, owner, booked.nda_request_id);
    await noteBookingCancelledOnSubject(env, owner, booked);
    if (booked.join_token && !booked.core_token) {
      await changeBookingInteraction(env, owner, booked.join_token, { action: 'cancelled' });
      return;
    }
  }
  await cancelHostBookings(env, owner, input.eventId, booked ? false : input.notifyGuests ?? true);
}

/**
 * Access tokens already minted, per isolate, so Home's reads do not each
 * cost a round trip to Google's token endpoint. Upcoming, invitations and
 * the calendar list used to refresh the same account's token two to four
 * times for one Home load. Memory only: an access token is never written
 * anywhere. Keyed by the stored record's IV as well as its key, so a
 * reconnect (a new sealed refresh token) never reuses the old account's
 * token, and a disconnect is still seen, because the record is read first.
 */
const cachedAccessTokens = new Map<string, { token: string; expiresAt: number }>();
/** Handed back this long before Google's own expiry, so a slow request does not carry a dead token. */
const ACCESS_TOKEN_MARGIN_MS = 5 * 60_000;
const ACCESS_TOKEN_CACHE_LIMIT = 500;

/**
 * A Google Calendar call with a token from `accessTokenFor`. A 401 means
 * Google no longer takes that token — revoked, or expired early — so it
 * leaves the cache and the next request mints a fresh one.
 */
async function googleFetch(accessToken: string, input: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401) {
    for (const [key, cached] of cachedAccessTokens) {
      if (cached.token === accessToken) cachedAccessTokens.delete(key);
    }
  }
  return response;
}

async function accessTokenFor(
  env: Env,
  owner: OwnerSession,
  accountId: string | null = null,
): Promise<string> {
  const additional = Boolean(accountId) && accountId !== PRIMARY_ACCOUNT_ID;
  const key = additional ? accountTokenKey(owner.sub, accountId as string) : tokenKey(owner.sub);
  const record = await readTokenRecord(env, key);
  if (!record) throw new CalendarError('Connect Google Calendar in Settings first.', 409, 'calendar_not_connected');
  const cacheKey = `${key}:${record.iv}`;
  const cached = cachedAccessTokens.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  cachedAccessTokens.delete(cacheKey);
  const refreshToken = await decryptRefreshToken(env, record);
  let clientID: string;
  let clientSecret: string | undefined;
  if (record.client === 'calendar') {
    ensureConfigured(env.GOOGLE_CALENDAR_CLIENT_ID, 'GOOGLE_CALENDAR_CLIENT_ID');
    clientID = env.GOOGLE_CALENDAR_CLIENT_ID!;
    clientSecret = await sharedSecret(env, 'GOOGLE_CALENDAR_CLIENT_SECRET');
  } else if (record.client === 'web') {
    ensureConfigured(env.GOOGLE_WEB_CLIENT_ID, 'GOOGLE_WEB_CLIENT_ID');
    clientID = env.GOOGLE_WEB_CLIENT_ID;
    clientSecret = await sharedSecret(env, 'GOOGLE_WEB_CLIENT_SECRET');
  } else {
    clientID = nativeRefreshClient(env, record);
  }
  const result = await refreshGoogleAccessToken({ refreshToken, clientID, clientSecret });
  if (!result.ok) {
    console.warn('Google Calendar token refresh failed', {
      status: result.status,
      reason: result.error,
      account: additional ? 'additional' : 'primary',
    });
    // Only a dead refresh token — revoked, or expired the way an external
    // account's does under a Google app still in testing — is a reason to
    // forget it. A 5xx or a rate limit is Google's afternoon, not the owner's
    // consent, and dropping the token on those forced a reconnect for nothing.
    // And it is *this* account's record that goes: this used to delete the
    // owner's own token whenever an extra account failed, which took the whole
    // calendar down every time the personal Gmail's token lapsed.
    if (result.error === 'invalid_grant') {
      await env.CALENDAR_TOKENS.delete(key);
      throw new CalendarError(
        additional
          ? 'Google Calendar access for that account expired. Reconnect it in Settings.'
          : 'Google Calendar access expired. Reconnect Calendar in Settings.',
        401,
        'calendar_expired',
      );
    }
    throw new CalendarError('Google Calendar did not answer. Try again in a moment.', calendarStatus(result.status), 'calendar_failed');
  }
  // A rotated refresh token belongs under the record it came from. Writing it
  // to the owner's own key regardless of account would have swapped the work
  // calendar's token for the personal one's.
  if (result.refreshToken) {
    await writeTokenRecord(env, key, result.refreshToken, record.email, record.client);
  } else if (result.expiresInSeconds !== null) {
    // Not after a rotation: the record's IV just changed, so this entry
    // would never be read again.
    if (cachedAccessTokens.size >= ACCESS_TOKEN_CACHE_LIMIT) cachedAccessTokens.clear();
    cachedAccessTokens.set(cacheKey, {
      token: result.accessToken,
      expiresAt: Date.now() + result.expiresInSeconds * 1_000 - ACCESS_TOKEN_MARGIN_MS,
    });
  }
  return result.accessToken;
}

async function exchangeGoogleCalendarCode(
  env: Env,
  options: {
    code: string;
    codeVerifier?: string;
    redirectURI: string;
    clientID: string;
    clientSecret?: string;
    nonce?: string;
  },
): Promise<{ idToken: string; accessToken: string; refreshToken?: string }> {
  const result = await exchangeGoogleAuthorizationCode(options);
  if (!result.ok) {
    console.error('Google Calendar token exchange rejected', { reason: result.reason });
    throw new AuthError('Google rejected the Calendar authorization code.', 401, 'oauth_failed');
  }
  const body = result.body;
  if (typeof body.id_token !== 'string' || typeof body.access_token !== 'string') {
    throw new AuthError('Google did not return Calendar tokens.', 401, 'oauth_failed');
  }
  return {
    idToken: body.id_token,
    accessToken: body.access_token,
    ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
  };
}

async function assertIdentityMatchesOwner(
  env: Pick<Env, 'IDENTITY_DOMAINS'>,
  idToken: string,
  audience: string,
  nonce: string | null,
  owner: OwnerSession,
): Promise<void> {
  const identity = await verifyMemberIdentity(env, idToken, {
    audience,
    nonce,
    failureMessage: 'Only a verified Google account on this workspace can connect Calendar.',
  });
  if (identity.sub !== owner.sub || identity.email.toLowerCase() !== owner.email.toLowerCase()) {
    throw new CalendarError('Calendar must be connected with the same Google account used to host.', 403, 'calendar_wrong_account');
  }
}

async function storeRefreshToken(
  env: Env,
  owner: OwnerSession,
  refreshToken: string,
  client: CalendarTokenClient,
  clientID?: string,
): Promise<void> {
  await writeTokenRecord(env, tokenKey(owner.sub), refreshToken, owner.email, client, clientID);
}

/** Exported for the token tests, which need a sealed record without Google. */
export async function writeTokenRecord(
  env: Env,
  key: string,
  refreshToken: string,
  email: string,
  client: CalendarTokenClient,
  clientID?: string,
): Promise<void> {
  const sealed = await sealSecret(tokenKeyMaterial(env), refreshToken);
  const record: CalendarTokenRecord = {
    v: 1,
    iv: sealed.iv,
    ciphertext: sealed.ciphertext,
    connectedAt: Date.now(),
    email,
    client,
    ...(clientID ? { clientID } : {}),
  };
  await env.CALENDAR_TOKENS.put(key, JSON.stringify(record));
}

async function loadTokenRecord(env: Env, ownerSub: string): Promise<CalendarTokenRecord | null> {
  return readTokenRecord(env, tokenKey(ownerSub));
}

async function readTokenRecord(env: Env, key: string): Promise<CalendarTokenRecord | null> {
  const raw = await env.CALENDAR_TOKENS.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isRecord(parsed)
      || parsed.v !== 1
      || typeof parsed.iv !== 'string'
      || typeof parsed.ciphertext !== 'string'
      || typeof parsed.connectedAt !== 'number'
      || typeof parsed.email !== 'string'
      || !isCalendarTokenClient(parsed.client)
      || (parsed.clientID !== undefined && typeof parsed.clientID !== 'string')
    ) {
      return null;
    }
    return parsed as unknown as CalendarTokenRecord;
  } catch {
    return null;
  }
}

async function decryptRefreshToken(env: Env, record: CalendarTokenRecord): Promise<string> {
  return openSecret(tokenKeyMaterial(env), record);
}

function tokenKeyMaterial(env: Env): string {
  ensureConfigured(env.GOOGLE_TOKEN_ENCRYPTION_KEY, 'GOOGLE_TOKEN_ENCRYPTION_KEY');
  return env.GOOGLE_TOKEN_ENCRYPTION_KEY;
}

function summarizeEvent(
  event: unknown,
  context: {
    joinUrl: string;
    roomSlug: string;
    calendarId: string;
    calendarSummary: string;
    webOrigin?: string;
    /** This workspace's public origin; its room links count as rooms too. */
    publicOrigin?: string;
    /** This workspace's shared company calendar, if it has one. */
    globalInterestTitle?: string | null;
    attendeeNames?: ReadonlyMap<string, CrmAttendeeMatch>;
  },
): CalendarEventSummary {
  if (!isRecord(event) || typeof event.id !== 'string') {
    throw new CalendarError('Google Calendar returned an incomplete event.', 502, 'calendar_failed');
  }
  const htmlLink = typeof event.htmlLink === 'string' ? event.htmlLink : '';
  const title = typeof event.summary === 'string' ? event.summary : '(No title)';
  const start = eventDate(event.start);
  const end = eventDate(event.end);
  const allDay = isAllDayValue(event.start);
  const isMeetEvent = context.roomSlug.length > 0 && context.joinUrl.length > 0;
  const conference = detectConference(event, {
    envisioningJoinUrl: context.joinUrl,
    ...(context.webOrigin ? { webOrigin: context.webOrigin } : {}),
    ...(context.publicOrigin ? { publicOrigin: context.publicOrigin } : {}),
  });
  return {
    id: `${context.calendarId}:${event.id}`,
    calendarId: context.calendarId,
    calendarSummary: context.calendarSummary,
    htmlLink,
    title,
    start,
    end,
    joinUrl: context.joinUrl,
    roomSlug: context.roomSlug,
    isMeetEvent,
    attendees: extractAttendees(event, context.attendeeNames),
    organizerSelf: isOrganizerSelf(event),
    platform: conference.platform,
    conferenceUrl: conference.url,
    allDay,
    recurringEventId: typeof event.recurringEventId === 'string' ? event.recurringEventId : '',
    recurring: typeof event.recurringEventId === 'string' && event.recurringEventId.length > 0,
    description: typeof event.description === 'string' ? event.description : '',
    location: placeOf(event, context.joinUrl, conference.url),
    ...startTimeZoneOf(event),
    travelTimeMinutes: travelTimeMinutesFromMetadata(event),
    demoted: false,
    calendarRole: calendarRoleForSummary(context.calendarSummary, context.globalInterestTitle),
    subject: null,
  };
}

function applyEventPreferences(
  event: CalendarEventSummary,
  preferences: CalendarPreferences,
): CalendarEventSummary {
  const key = `event:g:${event.id}`;
  return {
    ...event,
    demoted: preferences.demotedEventKeys.includes(key),
    subject: preferences.eventSubjects[key] ?? null,
  };
}

function summarizeListedEvent(
  event: unknown,
  context: {
    calendarId: string;
    calendarSummary: string;
    webOrigin: string;
    publicOrigin?: string;
    globalInterestTitle?: string | null;
    attendeeNames?: ReadonlyMap<string, CrmAttendeeMatch>;
  },
): CalendarEventSummary {
  if (!isRecord(event) || typeof event.id !== 'string') {
    throw new CalendarError('Incomplete calendar event.', 502, 'calendar_failed');
  }
  const privateProps = isRecord(event.extendedProperties) && isRecord(event.extendedProperties.private)
    ? event.extendedProperties.private
    : {};
  // The room an event carries counts only when its link is on this
  // workspace's own origin: hq reads calendars Envisioning also writes, and
  // their room props are Envisioning's rooms, not hq's.
  const stored = typeof privateProps.meetJoinUrl === 'string' ? privateProps.meetJoinUrl : '';
  const own = isOnOrigin(stored, [context.webOrigin, context.publicOrigin]);
  let joinUrl = own ? stored : '';
  let roomSlug = own && typeof privateProps.meetRoomSlug === 'string' ? privateProps.meetRoomSlug : '';
  if (!joinUrl) {
    joinUrl = extractMeetJoinUrl([
      typeof event.location === 'string' ? event.location : '',
      typeof event.description === 'string' ? event.description : '',
      typeof event.hangoutLink === 'string' ? event.hangoutLink : '',
    ].join('\n'), [context.webOrigin, context.publicOrigin]);
  }
  if (!roomSlug && joinUrl) {
    roomSlug = roomSlugFromJoinUrl(joinUrl) ?? '';
  }
  return summarizeEvent(event, {
    joinUrl,
    roomSlug,
    calendarId: context.calendarId,
    calendarSummary: context.calendarSummary,
    webOrigin: context.webOrigin,
    ...(context.publicOrigin ? { publicOrigin: context.publicOrigin } : {}),
    ...(context.globalInterestTitle ? { globalInterestTitle: context.globalInterestTitle } : {}),
    ...(context.attendeeNames ? { attendeeNames: context.attendeeNames } : {}),
  });
}

/** The IANA zone Google stored on a timed event's start, as `{ startTimeZone }`; nothing when it has none. */
export function startTimeZoneOf(event: Record<string, unknown>): { startTimeZone?: string } {
  const start = event.start;
  const zone = isRecord(start) && typeof start.timeZone === 'string' ? start.timeZone.trim() : '';
  return zone ? { startTimeZone: zone } : {};
}

/**
 * The location as a place. Google's location slot doubles as the join link's
 * home (see `locationPatch`), and a link is not somewhere to get to, so the
 * summary keeps the two apart: `location` is the room or address, `joinUrl`
 * and `conferenceUrl` carry the call.
 */
function placeOf(event: Record<string, unknown>, joinUrl: string, conferenceUrl: string): string {
  const location = typeof event.location === 'string' ? event.location.trim() : '';
  if (!location) return '';
  if (location === joinUrl.trim() || location === conferenceUrl.trim()) return '';
  return location;
}

/** True when `url` is on one of `origins`. */
function isOnOrigin(url: string, origins: ReadonlyArray<string | undefined>): boolean {
  let origin: string;
  try { origin = new URL(url).origin; } catch { return false; }
  return origins.some((candidate) => {
    try { return Boolean(candidate) && new URL(candidate as string).origin === origin; } catch { return false; }
  });
}

/** A room link on one of this workspace's own origins; never another workspace's. */
function extractMeetJoinUrl(text: string, ownOrigins: ReadonlyArray<string | undefined>): string {
  const origins = new Set(ownOrigins.filter((origin): origin is string => Boolean(origin)).map((origin) => origin.replace(/\/$/u, '')));
  const roomPathPatterns = [
    '/room/[a-z0-9-]{2,40}(?:/[A-Za-z0-9_-]{8,128})?',
  ];
  for (const origin of origins) {
    const escaped = origin.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    for (const pathPattern of roomPathPatterns) {
      const match = text.match(new RegExp(`${escaped}${pathPattern}`, 'iu'));
      if (!match?.[0]) continue;
      try {
        if (parsePublicRoomPath(new URL(match[0]).pathname)) return match[0];
      } catch {
        // A malformed pasted URL is not a Meet join link.
      }
    }
  }
  return '';
}

function roomSlugFromJoinUrl(joinUrl: string): string | null {
  try {
    return parsePublicRoomPath(new URL(joinUrl).pathname)?.slug ?? null;
  } catch {
    return null;
  }
}

interface MeetMintedBookingRecord {
  v: 1;
  slug: string;
  title: string;
  /** Null for a link sent by hand with no calendar event behind it. */
  starts_at: string | null;
  ends_at: string | null;
  status: 'scheduled';
  owner_sub: string;
  /** The holder's own identity, when the host named them at mint. */
  guest_name?: string;
  guest_email?: string;
  /** A booking-page booking's cancel and reschedule page (booking-public.ts). */
  manage_url?: string;
}

function bookingProjectionKey(token: string): string {
  return `calendar:booking:${token}`;
}

function tokenFromJoinUrl(joinUrl: string, slug: string): string | null {
  try {
    const parsed = parsePublicRoomPath(new URL(joinUrl).pathname);
    const token = parsed?.bookingToken;
    if (parsed?.slug === slug && token && /^[A-Za-z0-9_-]{8,128}$/u.test(token)) {
      return token;
    }
  } catch {
    return null;
  }
  return null;
}

/** Mint (or reuse) a Meet booking token so Mac-created events get a titled guest card. */
export async function attachMeetBooking(
  env: Env,
  owner: OwnerSession,
  input: {
    title: string;
    start?: string;
    end?: string;
    roomSlug: string;
    joinUrl?: string;
    guestName?: string;
    guestEmail?: string;
    manageUrl?: string;
  },
): Promise<{ token: string; joinUrl: string }> {
  const mapped = await roomOfMember(env, owner.email);
  if (!mapped || mapped !== input.roomSlug) {
    throw new CalendarError('That room is not yours to schedule.', 403, 'not_room_owner');
  }
  const reused = input.joinUrl ? tokenFromJoinUrl(input.joinUrl, input.roomSlug) : null;
  const token = reused ?? randomToken(16);
  const joinUrl = roomPermalink(workspacePublicOrigin(env), input.roomSlug, token);
  // A host's edit re-mints the same token without the guest; the card keeps
  // the guest's name, address and manage link the booking gave it.
  const earlier = reused ? await mintedGuest(env, token) : {};
  const guestName = input.guestName ?? earlier.guest_name;
  const guestEmail = input.guestEmail ?? earlier.guest_email;
  const manageUrl = input.manageUrl ?? earlier.manage_url;
  const record: MeetMintedBookingRecord = {
    v: 1,
    slug: input.roomSlug,
    title: input.title,
    starts_at: input.start ?? null,
    ends_at: input.end ?? null,
    status: 'scheduled',
    owner_sub: owner.sub,
    ...(guestName ? { guest_name: guestName } : {}),
    ...(guestEmail ? { guest_email: guestEmail } : {}),
    ...(manageUrl ? { manage_url: manageUrl } : {}),
  };
  await env.CALENDAR_TOKENS.put(bookingProjectionKey(token), JSON.stringify(record));
  return { token, joinUrl };
}

async function mintedGuest(env: Env, token: string): Promise<{ guest_name?: string; guest_email?: string; manage_url?: string }> {
  const raw = await env.CALENDAR_TOKENS.get(bookingProjectionKey(token));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);
    const guest_name = text(parsed.guest_name);
    const guest_email = text(parsed.guest_email);
    const manage_url = text(parsed.manage_url);
    return {
      ...(guest_name ? { guest_name } : {}),
      ...(guest_email ? { guest_email } : {}),
      ...(manage_url ? { manage_url } : {}),
    };
  } catch {
    return {};
  }
}

/** The token in a room link Meet minted, or null when the link is not this room's. */
export function joinTokenFromUrl(joinUrl: string, slug: string): string | null {
  return tokenFromJoinUrl(joinUrl, slug);
}

export async function loadMeetMintedBooking(
  env: Env,
  slug: string,
  token: string,
): Promise<StarlingsMintedBookingProjection | null> {
  const raw = await env.CALENDAR_TOKENS.get(bookingProjectionKey(token));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.v !== 1) return null;
    if (parsed.slug !== slug || parsed.status !== 'scheduled') return null;
    if (typeof parsed.title !== 'string' || !parsed.title.trim()) return null;
    return {
      title: parsed.title,
      subject: null,
      starts_at: typeof parsed.starts_at === 'string' ? parsed.starts_at : null,
      ends_at: typeof parsed.ends_at === 'string' ? parsed.ends_at : null,
      status: 'scheduled',
      // One page does both: it shows the booking with Cancel and the times to move it to.
      reschedule_url: typeof parsed.manage_url === 'string' ? parsed.manage_url : null,
      cancel_url: typeof parsed.manage_url === 'string' ? parsed.manage_url : null,
      guest_name: typeof parsed.guest_name === 'string' && parsed.guest_name.trim() ? parsed.guest_name : null,
      guest_email: typeof parsed.guest_email === 'string' && parsed.guest_email.trim() ? parsed.guest_email : null,
    };
  } catch {
    return null;
  }
}

/** Close the join card of a cancelled booking: its token stops answering. */
export async function forgetMeetBooking(env: Env, slug: string, joinUrl: string): Promise<void> {
  const token = tokenFromJoinUrl(joinUrl, slug);
  if (token) await env.CALENDAR_TOKENS.delete(bookingProjectionKey(token));
}

export async function meetMintedBookingSlug(env: Env, token: string): Promise<string | null> {
  const raw = await env.CALENDAR_TOKENS.get(bookingProjectionKey(token));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.slug !== 'string') return null;
    return parsed.slug;
  } catch {
    return null;
  }
}

async function ensureDefaultPreferences(env: Env, ownerSub: string): Promise<void> {
  const existing = await env.CALENDAR_TOKENS.get(prefsKey(ownerSub));
  if (existing) return;
  await env.CALENDAR_TOKENS.put(
    prefsKey(ownerSub),
    JSON.stringify({
      selectedCalendarIds: defaultSelectedCalendars,
      upcomingExcludedSubscriptionIds: [],
      hiddenCalendarKeys: [],
      disabledCalendarKeys: [],
      demotedEventKeys: [],
      includesLocalCalendars: false,
      eventSubjects: {},
      upcoming: normalizeUpcomingPreferences(undefined),
    } satisfies CalendarPreferences),
  );
}

function defaultPreferences(): CalendarPreferences {
  return {
    selectedCalendarIds: [...defaultSelectedCalendars],
    upcomingExcludedSubscriptionIds: [],
    hiddenCalendarKeys: [],
    disabledCalendarKeys: [],
    demotedEventKeys: [],
    includesLocalCalendars: false,
    eventSubjects: {},
    upcoming: normalizeUpcomingPreferences(undefined),
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

async function loadPreferences(env: Env, ownerSub: string): Promise<CalendarPreferences> {
  const raw = await env.CALENDAR_TOKENS.get(prefsKey(ownerSub));
  if (!raw) return defaultPreferences();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return defaultPreferences();
    // Blobs written before hidden keys existed have only the selection, so an
    // absent field reads as "nothing hidden" rather than as a broken record.
    const selectedCalendarIds = stringList(parsed.selectedCalendarIds);
    return {
      selectedCalendarIds: selectedCalendarIds.length > 0
        ? selectedCalendarIds
        : [...defaultSelectedCalendars],
      // Older preference records have no subscription exclusions, which
      // means every shared feed appears in Upcoming unless the owner opts out.
      upcomingExcludedSubscriptionIds: stringList(parsed.upcomingExcludedSubscriptionIds),
      hiddenCalendarKeys: stringList(parsed.hiddenCalendarKeys),
      disabledCalendarKeys: stringList(parsed.disabledCalendarKeys),
      demotedEventKeys: stringList(parsed.demotedEventKeys),
      includesLocalCalendars: parsed.includesLocalCalendars === true,
      // Absent in every blob written before subjects existed: nothing filed.
      eventSubjects: eventSubjectMap(parsed.eventSubjects),
      // Absent in every blob written before Upcoming was user-configurable:
      // use the bundled product defaults.
      upcoming: normalizeUpcomingPreferences(parsed.upcoming),
    };
  } catch {
    return defaultPreferences();
  }
}

function eventDate(value: unknown): string {
  if (!isRecord(value)) return '';
  if (typeof value.dateTime === 'string') return value.dateTime;
  if (typeof value.date === 'string') return value.date;
  return '';
}

export function isAllDayValue(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.date === 'string' && typeof value.dateTime !== 'string';
}

/**
 * Core owns the canonical person names. Calendar remains usable when that
 * optional lookup is unavailable, so this deliberately falls back to an empty
 * map instead of making a calendar read depend on CRM uptime.
 */
/** How long an events read waits for Core's attendee names before it answers without them. */
export const CRM_ATTENDEE_LOOKUP_MS = 3_000;

async function loadCrmAttendeeMatches(
  env: Env,
  events: readonly unknown[],
  owner: OwnerSession,
): Promise<ReadonlyMap<string, CrmAttendeeMatch>> {
  if (usesCoreFor(env, 'subjects') && !crmSyncEnabled(env)) return new Map();
  const emails = [...new Set(events.flatMap(attendeeEmailsInEvent))];
  if (emails.length === 0) return new Map();
  try {
    // Names are decoration. A slow or busy store must not hold the events
    // past the client's timeout, which turned a wake refresh into "Google
    // events didn't refresh": past the bound, the events go
    // without CRM names.
    const lookup = await awaitBounded(fetchCrmCalendarContacts(env, emails, owner), CRM_ATTENDEE_LOOKUP_MS);
    if (!lookup) {
      console.warn('Calendar attendee lookup timed out', { ms: CRM_ATTENDEE_LOOKUP_MS });
      return new Map();
    }
    const contacts = lookup.value;
    const names = new Map<string, CrmAttendeeMatch>();
    const coreOrigin = usesCoreFor(env, 'subjects') ? coreApiOrigin(env) : null;
    for (const contact of contacts) {
      const email = typeof contact.email === 'string' ? contact.email.trim().toLowerCase() : '';
      const name = typeof contact.name === 'string' ? contact.name.trim() : '';
      const id = typeof contact.id === 'string' ? contact.id.trim() : '';
      if (email && id) {
        names.set(email, {
          name: name || email,
          ...(coreOrigin ? { crmUrl: `${coreOrigin}/contacts/${encodeURIComponent(id)}` } : {}),
        });
      }
    }
    return names;
  } catch {
    return new Map();
  }
}

function attendeeEmailsInEvent(event: unknown): string[] {
  if (!isRecord(event) || !Array.isArray(event.attendees)) return [];
  return event.attendees.flatMap((raw) => {
    if (!isRecord(raw) || raw.resource === true) return [];
    const email = firstEmailIn(typeof raw.email === 'string' ? raw.email : '')
      || firstEmailIn(typeof raw.displayName === 'string' ? raw.displayName : '');
    return email ? [email] : [];
  });
}

/** Prefer displayName, else email. Skip rooms/resources. Include RSVP status. */
export function extractAttendees(
  event: unknown,
  attendeeNames: ReadonlyMap<string, CrmAttendeeMatch> = new Map(),
): CalendarAttendeeSummary[] {
  if (!isRecord(event) || !Array.isArray(event.attendees)) return [];
  const people: CalendarAttendeeSummary[] = [];
  const seen = new Set<string>();
  for (const raw of event.attendees) {
    if (!isRecord(raw) || raw.resource === true) continue;
    const display = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
    const rawEmail = typeof raw.email === 'string' ? raw.email.trim() : '';
    // Google usually sends `email`, but CalDAV / pasted guests sometimes only
    // embed the address in displayName (`Name <user@domain>` / bare addr).
    const email = firstEmailIn(rawEmail) || firstEmailIn(display);
    // The workspace's contacts are the canonical CRM source. Prefer them when Google gave us only an
    // address (or a stale address-shaped display name), while preserving the
    // Google name for people that are not in CRM.
    const match = attendeeNames.get(email);
    const crmName = typeof match === 'string' ? match : match?.name;
    const name = crmName || display || rawEmail || email;
    if (!name) continue;
    const key = (email || name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({
      name,
      email,
      ...(match ? { inCrm: true } : {}),
      ...(typeof match === 'object' && match.crmUrl ? { crmUrl: match.crmUrl } : {}),
      status: normalizeAttendeeStatus(raw.responseStatus),
      optional: raw.optional === true,
      self: raw.self === true,
    });
  }
  return people;
}

/** First usable address in plain, mailto:, or `Name <addr>` text. */
export function firstEmailIn(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const angle = trimmed.match(/<([^<>@\s]+@[^<>@\s]+)>/u);
  if (angle?.[1]) return normalizeEmailCandidate(angle[1]);
  const mailto = trimmed.match(/^mailto:([^\s]+)$/iu);
  if (mailto?.[1]) return normalizeEmailCandidate(mailto[1]);
  if (/^[^\s<>@]+@[^\s<>@]+$/u.test(trimmed)) return normalizeEmailCandidate(trimmed);
  const token = trimmed.match(/[^\s<>",;]+@[^\s<>",;]+/u);
  return token?.[0] ? normalizeEmailCandidate(token[0]) : '';
}

function normalizeEmailCandidate(value: string): string {
  const normalized = value.trim().replace(/^mailto:/iu, '').replace(/^<|>$/gu, '').toLowerCase();
  if (!normalized.includes('@') || normalized.startsWith('@') || normalized.endsWith('@')) {
    return '';
  }
  return normalized;
}

function normalizeAttendeeStatus(value: unknown): CalendarAttendeeStatus {
  switch (value) {
    case 'accepted':
    case 'declined':
    case 'tentative':
    case 'needsAction':
      return value;
    default:
      return 'unknown';
  }
}

function isOrganizerSelf(event: unknown): boolean {
  if (!isRecord(event)) return false;
  if (isRecord(event.organizer) && event.organizer.self === true) return true;
  if (!Array.isArray(event.attendees)) return false;
  return event.attendees.some(
    (raw) => isRecord(raw) && raw.self === true && raw.organizer === true,
  );
}

/** True only for an incoming invitation that still needs this account's reply. */
export function isPendingCalendarInvitation(event: unknown): boolean {
  if (!isRecord(event) || event.status === 'cancelled' || isOrganizerSelf(event)) return false;
  if (!Array.isArray(event.attendees)) return false;
  return event.attendees.some(
    (raw) => isRecord(raw) && raw.self === true && raw.responseStatus === 'needsAction',
  );
}

export function detectConference(
  event: unknown,
  context: { envisioningJoinUrl: string; webOrigin?: string; publicOrigin?: string },
): { platform: CalendarMeetingPlatform; url: string } {
  if (context.envisioningJoinUrl) {
    return { platform: 'starlings', url: context.envisioningJoinUrl };
  }

  if (!isRecord(event)) return { platform: 'none', url: '' };

  const haystack = [
    typeof event.hangoutLink === 'string' ? event.hangoutLink : '',
    typeof event.description === 'string' ? event.description : '',
    ...conferenceEntryPointUris(event),
  ].join('\n');
  // A provider link may be stored as the location. Search that field only for
  // known conference hosts; the generic URL fallback below must not turn a
  // Google Maps address into a meeting.
  const platformHaystack = [
    haystack,
    typeof event.location === 'string' ? event.location : '',
  ].join('\n');

  const google = firstMatch(platformHaystack, [
    /https?:\/\/meet\.google\.com\/[a-z0-9-]+/iu,
    /https?:\/\/[a-z0-9.-]*hangouts\.google\.com\/[^\s<>"']+/iu,
  ]);
  if (google) return { platform: 'google_meet', url: google };

  const zoom = firstMatch(platformHaystack, [
    /https?:\/\/[\w.-]*zoom\.us\/[^\s<>"']+/iu,
    /https?:\/\/[\w.-]*zoom\.com\/[^\s<>"']+/iu,
  ]);
  if (zoom) return { platform: 'zoom', url: zoom };

  const teams = firstMatch(platformHaystack, [
    /https?:\/\/teams\.microsoft\.com\/[^\s<>"']+/iu,
    /https?:\/\/teams\.live\.com\/[^\s<>"']+/iu,
  ]);
  if (teams) return { platform: 'teams', url: teams };

  const webex = firstMatch(platformHaystack, [
    /https?:\/\/[\w.-]*webex\.com\/[^\s<>"']+/iu,
  ]);
  if (webex) return { platform: 'webex', url: webex };

  // Some calendar providers retain only their generated location label when
  // the actual join URL is missing. Keep the platform identity for display —
  // callers still require a non-empty URL before offering an open action.
  const providerLabel = typeof event.location === 'string'
    ? event.location.trim()
    : '';
  if (/^(?:microsoft\s+teams|teams)(?:\s+meeting)?$/iu.test(providerLabel)) {
    return { platform: 'teams', url: '' };
  }
  if (/^google\s+meet(?:\s+meeting)?$/iu.test(providerLabel)) {
    return { platform: 'google_meet', url: '' };
  }
  if (/^zoom(?:\s+meeting)?$/iu.test(providerLabel)) {
    return { platform: 'zoom', url: '' };
  }
  if (/^webex(?:\s+meeting)?$/iu.test(providerLabel)) {
    return { platform: 'webex', url: '' };
  }

  if (context.webOrigin) {
    const envisioning = extractMeetJoinUrl(haystack, [context.webOrigin, context.publicOrigin]);
    if (envisioning) return { platform: 'starlings', url: envisioning };
  }

  // An arbitrary URL in a description may be a ticket, itinerary, or source
  // document. Only Google's structured conference entry points are enough to
  // call an unrecognised host a meeting link.
  const genericConferenceLink = firstMatch(
    conferenceEntryPointUris(event).join('\n'),
    [/https?:\/\/[^\s<>"']+/iu],
  );
  if (genericConferenceLink) return { platform: 'other', url: genericConferenceLink };

  return { platform: 'none', url: '' };
}

function conferenceEntryPointUris(event: unknown): string[] {
  if (!isRecord(event) || !isRecord(event.conferenceData) || !Array.isArray(event.conferenceData.entryPoints)) {
    return [];
  }
  return event.conferenceData.entryPoints.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.uri !== 'string') return [];
    return [entry.uri];
  });
}

function firstMatch(text: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[0]) return match[0].replace(/[),.;]+$/u, '');
  }
  return '';
}

function tokenKey(ownerSub: string): string {
  return `calendar:refresh:${ownerSub}`;
}

function accountTokenKey(ownerSub: string, accountId: string): string {
  return `calendar:refresh:${ownerSub}:${accountId}`;
}

function accountsKey(ownerSub: string): string {
  return `calendar:accounts:${ownerSub}`;
}

/** Best-effort revoke at Google; the local copy goes either way. */
async function revokeStoredToken(env: Env, key: string): Promise<void> {
  const record = await readTokenRecord(env, key);
  if (!record) return;
  try {
    await revokeGoogleToken(await decryptRefreshToken(env, record));
  } catch {
    // A record that no longer opens has nothing left to revoke.
  }
}

/** True when this owner has a stored Calendar refresh token. Used by the usage ledger. */
export async function isCalendarConnected(env: Env, ownerSub: string): Promise<boolean> {
  return (await env.CALENDAR_TOKENS.get(tokenKey(ownerSub))) !== null;
}

function prefsKey(ownerSub: string): string {
  return `calendar:prefs:${ownerSub}`;
}

function calendarStatus(status: number): number {
  if (status === 401 || status === 403) return 401;
  if (status === 429) return 429;
  return 502;
}

function ensureConfigured(value: string | undefined, name: string): void {
  if (!value || value.startsWith('replace-with-')) throw new AuthError(`${name} is not configured.`, 503, 'not_configured');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
