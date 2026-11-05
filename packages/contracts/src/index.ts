import { meetingActionItemSchema, meetingDecisionCandidateSchema, meetingFollowUpDraftSchema, MEETING_FOLLOW_UP_SUBJECT_MAX, MEETING_FOLLOW_UP_BODY_MAX } from './meeting-notes';
export * from './meeting-notes';
export * from './meeting-agent';
// The single wire contract for Envisioning Meet. Zod schemas validate requests
// and define responses; the wire registry generates the native Swift models.
// Add a shape once, then register it for native clients rather than copying it.
import { TASK_STATUSES } from '@starlings/subject-spec/schema';
import { z } from 'zod';
import { MEETING_KINDS } from './meeting-kinds';
import { roomSlugSchema } from './room-slug';
import { CAPTION_DATA_TOPIC } from './data-topics';
import { CRM_RESPONSIBLE_PARTIES } from './task-values';
import { WORK_STAGES } from './work-items';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  ATTACHMENT_NAME_MAX_CHARS,
  FEEDBACK_MESSAGE_MAX_CHARS,
  FEEDBACK_REPORT_MAX_CHARS,
  MESSAGE_MENTION_MAX,
  MESSAGE_PAGE_MAX,
  MESSAGE_REACTION_EMOJI_MAX_CHARS,
  MESSAGE_TEXT_MAX_CHARS,
  THREAD_MESSAGE_REF_MAX,
  QUALITY_DURATION_MAX_MS,
  QUALITY_RECONNECT_MAX,
  TRANSCRIPT_BATCH_MAX_SEGMENTS,
} from './limits';
import { calendarEventSubjectSchema, upcomingPreferencesSchema } from './calendar';
import { signalsOutreachStatusSchema } from './commercial';
import { acceptingKindAliases, crmIssueStateSchema, crmSubjectDetailSchema, crmSubjectKindSchema } from './crm';
import { crmDecisionSchema } from './goals-decisions';
import { adminPersonRoleValueSchema } from './admin';
import { REACTION_EMOJI } from './reactions';
import { isIdentityEmail, ORG_WWW_ORIGIN, SYSTEM_SENDER_EMAIL } from './deployment';
import { DOCS_SOURCE_SYSTEMS, type DocsSourceSystem } from './docs-values';
import { MCP_CHANGES_PAGE_SIZE } from './mcp';
import { makeAgentAvatarIdentity } from './agent-avatar-values';
import {
  GUEST_OPERATIONAL_ERROR_CLASSES,
  GUEST_OPERATIONAL_ERROR_CODES,
  GUEST_OPERATIONAL_ERROR_OPERATIONS,
  OPERATIONAL_ERROR_CLASSES,
  OPERATIONAL_ERROR_CODES,
  OPERATIONAL_ERROR_OPERATIONS,
  OPERATIONAL_ERROR_PLATFORMS,
  OPERATIONAL_ERROR_SOURCES,
  OPERATIONAL_SERVER_CODES,
} from './operational-error-values';
import { subjectKindsWith } from './subject-kinds';
import { WORK_GROUPS } from './work-groups';
export * from './work-groups';
import { GOOGLE_GRANT_PRODUCTS, type GoogleGrantProduct } from './google-grant-products';
import { NATIVE_SIGN_IN_CALLBACKS, NATIVE_SIGN_IN_HTTPS_PATH } from './native-app';
import { WORKSPACE_HOST_SUFFIX } from './workspace-slug';

export * from './calendar-values';
export * from './docs-values';
export * from './email-values';
export * from './identity-values';
export * from './agent-avatar-values';
export * from './built-in-agent';
export * from './work-hours';
export * from './native-app';
export { isIdentityEmail, parseIdentityDomains } from './deployment';
export * from './paths';
export * from './limits';
export * from './reactions';
export * from './hands';
export * from './work-items';
export * from './work-actions';
export * from './subject-kinds';
export * from './meeting-kinds';
export * from './data-topics';
export * from './task-values';
export * from './work-ranker';
export * from './quick-notes';
export * from './subject-state';
export * from './favorites';
export * from './goals-decisions';
export * from './decision-asks';
export * from './attention';
export * from './home-layout';
export * from './search';
export * from './inbox';
export * from './support-requests';
export * from './support-line';
export * from './support-intake';
export * from './commercial';
export * from './extension-events';
export * from './admin';

export { roomSlugSchema } from './room-slug';

/**
 * GET /api/rooms/:slug — the first request every guest and member makes
 *. The owner's display name only, never their email. `you` is
 * the viewer's own identity, sent to a signed-in member and nobody else.
 * `internal` marks the members-only room, which has no waiting room.
 */
export const publicRoomResponseSchema = z.object({
  slug: z.string(),
  kind: z.literal('permanent'),
  internal: z.boolean().optional(),
  owner_name: z.string().nullable(),
  you: z.object({ name: z.string(), email: z.string() }).optional(),
});
export type PublicRoomResponse = z.infer<typeof publicRoomResponseSchema>;

/** The common successful acknowledgement returned by write-only Worker routes. */
export const okResponseSchema = z.object({ ok: z.literal(true) });
export type OkResponse = z.infer<typeof okResponseSchema>;

/** A JSON value forwarded from a registry-driven upstream API. */
export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;

/**
 * GET /api/health. Public deployment identity only; no account data. `build`
 * is the commit the Worker was built from (`unknown` outside a build), and
 * `migration` is the newest D1 migration applied, or null when D1 does not
 * answer ( step 1).
 */
export const healthResponseSchema = z.object({
  ok: z.literal(true),
  environment: z.string(),
  build: z.string(),
  migration: z.string().nullable(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** POST /api/diagnostics -> 201. The diagnostic payload itself stays private. */
export const diagnosticRecordedResponseSchema = z.object({ id: z.string() });
export type DiagnosticRecordedResponse = z.infer<typeof diagnosticRecordedResponseSchema>;

/** POST /api/admin/backfill. */
export const ledgerBackfillResponseSchema = z.object({
  rooms: z.number().int().nonnegative(),
  meetings: z.number().int().nonnegative(),
  degraded: z.array(z.string()),
});
export type LedgerBackfillResponse = z.infer<typeof ledgerBackfillResponseSchema>;

/** POST /api/admin/retitle-meetings. */
export const retitleMeetingsResponseSchema = z.object({
  rooms: z.number().int().nonnegative(),
  considered: z.number().int().nonnegative(),
  retitled: z.array(z.object({
    room_slug: z.string(),
    meeting_id: z.string(),
    from: z.string().nullable(),
    to: z.string(),
  })),
  degraded: z.array(z.string()),
});
export type RetitleMeetingsResponse = z.infer<typeof retitleMeetingsResponseSchema>;

/** POST /api/admin/regenerate-notes. */
export const regenerateNotesResponseSchema = z.object({
  room_slug: z.string(),
  meeting_id: z.string(),
  title: z.string(),
  engine: z.enum(['claude', 'workers-ai', 'fallback']),
  synced: z.boolean(),
});
export type RegenerateNotesResponse = z.infer<typeof regenerateNotesResponseSchema>;

/** POST /api/admin/discard-short-meetings. */
export const discardShortMeetingsResponseSchema = z.object({
  rooms: z.number().int().nonnegative(),
  discarded: z.array(z.object({
    room_slug: z.string(),
    meeting_id: z.string(),
    ms: z.number().int().nonnegative(),
    transcript_archived: z.boolean(),
  })),
  degraded: z.array(z.string()),
});
export type DiscardShortMeetingsResponse = z.infer<typeof discardShortMeetingsResponseSchema>;

/**
 * POST /api/admin/erase-meeting (docs/DATA_REQUESTS.md): erase one
 * ended meeting from every copy Starlings can reach. `request_id` is the data
 * request's id, `dr-<YYYYMMDD>-<n>`, so the receipt and the audit name it.
 */
export const eraseMeetingRequestSchema = z.strictObject({
  room_slug: roomSlugSchema,
  meeting_id: z.string().uuid(),
  request_id: z.string().regex(/^dr-\d{8}-\d{1,4}$/u),
});
export type EraseMeetingRequest = z.infer<typeof eraseMeetingRequestSchema>;

/**
 * One copy and what happened to it. `erased`: gone now. `none`: there was
 * nothing. `kept`: left on purpose, with how many rows (a member's tasks
 * and decisions). `not_reachable`: Starlings cannot erase it (Core). `failed`:
 * try again; a retry finishes it.
 */
export const erasureStepSchema = z.object({
  store: z.enum(['room', 'ledger', 'subject_records', 'docs', 'core', 'tasks', 'decisions', 'backups']),
  result: z.enum(['erased', 'none', 'kept', 'not_reachable', 'failed']),
  count: z.number().int().nonnegative().optional(),
});
export const eraseMeetingResponseSchema = z.object({
  request_id: z.string(),
  room_slug: z.string(),
  meeting_id: z.string(),
  erased_at: z.number().int(),
  /** The backups still hold the room until this time: 30 days after the erasure. */
  backups_end_at: z.number().int(),
  steps: z.array(erasureStepSchema),
});
export type EraseMeetingResponse = z.infer<typeof eraseMeetingResponseSchema>;

/** DELETE /api/connectors/{slack,github}/.../items. */
export const connectorReverseResponseSchema = z.object({ removed: z.number().int().nonnegative() });
export type ConnectorReverseResponse = z.infer<typeof connectorReverseResponseSchema>;

/** GET /api/auth/me. `is_admin`: the viewer may open Admin (`requireOrgAdmin`). */
export const ownerAuthResponseSchema = z.object({
  owner: z.object({
    sub: z.string(),
    email: z.string(),
    name: z.string(),
    picture: z.string().optional(),
  }),
  is_admin: z.boolean(),
});
export type OwnerAuthResponse = z.infer<typeof ownerAuthResponseSchema>;

/** POST /api/agents/cancel. */
export const agentCancelResponseSchema = z.object({
  ok: z.literal(true),
  told: z.boolean(),
  delivery: z.enum(['accepted', 'failed', 'no_runtime']),
});
export type AgentCancelResponse = z.infer<typeof agentCancelResponseSchema>;

/** POST /api/owner/heartbeat. */
export const ownerHeartbeatResponseSchema = z.object({
  ok: z.literal(true),
  renew_after_ms: z.number().int().nonnegative(),
});
export type OwnerHeartbeatResponse = z.infer<typeof ownerHeartbeatResponseSchema>;

/** A connector sync request accepted for asynchronous processing. */
export const syncQueuedResponseSchema = z.object({ queued: z.number().int().nonnegative() });
export type SyncQueuedResponse = z.infer<typeof syncQueuedResponseSchema>;

/** POST /api/granola/backfill. */
export const granolaBackfillResponseSchema = z.object({ from: z.string() });
export type GranolaBackfillResponse = z.infer<typeof granolaBackfillResponseSchema>;

export function ownerRoomMap(raw: string): Record<string, string> {
  return parseRoomMap(raw, 'OWNER_ROOM_MAP');
}

/** The public rooms. Deliberately not the internal one — see `internalRoomSlugs`. */
export function permanentRoomSlugs(rawMap: string): Set<string> {
  return new Set(Object.values(ownerRoomMap(rawMap)));
}

/**
 * The internal room: a permanent room whose audience is Envisioning rather than
 * the public, so the weekly Status call has a door that is not a person's.
 * See `docs/adr/0001-internal-room.md`.
 *
 * Same `{ "<host email>": "<slug>" }` shape as `OWNER_ROOM_MAP`, with `*` as
 * the key when every verified member may host the room. It answers the same
 * question — who hosts this room. It is a **separate**
 * variable rather than more entries in that one for two reasons, and both are
 * load-bearing:
 *
 * 1. An address is one key there, and the host of the internal room is
 *    normally the owner of their own room too. One map cannot hold both.
 * 2. `OWNER_ROOM_MAP` is read as "the public room list" in a dozen places —
 *    booking, presence, the ledger, the admin bootstrap.
 *    Widening it would quietly widen all of them. Every widening here is
 *    therefore a call site somebody chose.
 *
 * Absent or blank is the honest default: no internal room, and every seam
 * below behaves exactly as it did before this existed.
 */
export function internalRoomMap(raw: string | null | undefined): Record<string, string> {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return {};
  return parseRoomMap(value, 'INTERNAL_ROOM_MAP');
}

export function internalRoomSlugs(raw: string | null | undefined): Set<string> {
  return new Set(Object.values(internalRoomMap(raw)));
}

function parseRoomMap(raw: string, variable: string): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${variable} is invalid JSON.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${variable} must be an object.`);
  }
  const out: Record<string, string> = {};
  for (const [email, slug] of Object.entries(value as Record<string, unknown>)) {
    if (typeof slug !== 'string') continue;
    const parsed = roomSlugSchema.safeParse(slug);
    if (parsed.success) out[email.toLowerCase()] = parsed.data;
  }
  return out;
}

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

/**
 * Which of an owner's devices a host connection is coming from.
 *
 * LiveKit evicts a duplicate identity, so an owner signed in on two devices
 * needs two identities for one account. The suffix rides in the local part
 * (`mz+mac-<install>@example.com`) precisely so it stays an Envisioning address:
 * caption trust is a domain test on every client that has already shipped, and
 * a scheme that broke it would silence captions everywhere.
 *
 * Authorization never reads this. Every owner gate keys on the Google `sub`,
 * so the device a request comes from cannot grant or withhold anything.
 */
/**
 * Closed, and only ever sent by a client (host start and claim), so adding a
 * member breaks no shipped decoder. `android` is the Android app.
 */
export const hostDeviceSchema = z.enum(['mac', 'iphone', 'ipad', 'android']);
export type HostDevice = z.infer<typeof hostDeviceSchema>;

/**
 * Optional body on the two host-start routes. Absent `device` means an unnamed
 * device. `room` is read by `/api/owner/host-session` only: it names a room the
 * owner may host other than their own — in practice the internal room. The
 * per-slug `/rooms/<slug>/start` route already carries the slug in its path.
 */
export const hostSessionStartSchema = z.object({
  device: hostDeviceSchema.optional(),
  room: roomSlugSchema.optional(),
});

/**
 * The LiveKit identity for one owner installation. `device` distinguishes
 * platforms, while `installID` distinguishes two installs on the same
 * platform. A client that names no device keeps the bare account address —
 * that is what every build before per-device identity sends, and it must stay
 * a legal host.
 */
export function deviceScopedOwnerIdentity(
  email: string,
  device?: HostDevice | null,
  installID?: string | null,
): string {
  if (!device) return email;
  const at = email.lastIndexOf('@');
  if (at <= 0) return email;
  // `device` distinguishes platforms; the signed session's install id
  // distinguishes two Macs (or two phones) on the same account. Native
  // install ids are random UUIDs, and sanitizing keeps the suffix an email
  // local part even for legacy/custom device ids.
  const install = installID?.replace(/[^A-Za-z0-9_-]/gu, '').slice(0, 64);
  return `${email.slice(0, at)}+${device}${install ? `-${install}` : ''}${email.slice(at)}`;
}

/** An owner identity from `deviceScopedOwnerIdentity` for an iPhone or iPad. */
export function isMobileOwnerIdentity(identity: string): boolean {
  return /\+(?:iphone|ipad)(?:-|@)/u.test(identity.toLowerCase());
}

/**
 * The addresses one member answers to: the same local part on every identity
 * domain of the workspace (`domains`, the Worker's `IDENTITY_DOMAINS`).
 * `rosa@example.com` and `rosa@example.org` are one human with two Google
 * accounts, and anything a person is entitled to — a room, admin by
 * bootstrap, a booking page — must not depend on which of the two they signed
 * in with today. A non-identity address is only itself.
 */
export function identityAddresses(domains: readonly string[], email: string): string[] {
  const normalized = email.trim().toLowerCase();
  if (!isIdentityEmail(domains, normalized)) return [normalized];
  const local = normalized.slice(0, normalized.lastIndexOf('@'));
  return domains.map((domain) => `${local}@${domain}`);
}

/** True when two addresses name the same member (see above). */
export function isSameIdentityPerson(domains: readonly string[], a: string, b: string): boolean {
  const normalized = b.trim().toLowerCase();
  return identityAddresses(domains, a).includes(normalized);
}

/**
 * The permanent room an address hosts, whichever identity domain the map
 * happens to key it on. This is the one lookup every caller must use; indexing
 * the map by the literal sign-in address splits a person in two.
 */
export function ownerRoomSlugFor(rawMap: string, email: string, domains: readonly string[]): string | null {
  const map = ownerRoomMap(rawMap);
  for (const address of identityAddresses(domains, email)) {
    const slug = map[address];
    if (slug) return slug;
  }
  return null;
}

/** True for a hosted-domain (`hd`) claim naming one of `domains`. */
export function isIdentityHostedDomain(domains: readonly string[], value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return domains.some((domain) => normalized === domain);
}

/**
 * Which surface a guest is arriving on, so the host can read the room before
 * admitting: `app` names the client build, `device` its form factor. Coarse on
 * purpose — this is a lobby affordance ("they're on a phone, in the browser"),
 * not telemetry, so it carries no user agent, model, or OS version.
 *
 * Self-reported by the client, like the display name: a guest could lie about
 * it, and nothing is authorized on the strength of it.
 */
export const guestClientSchema = z.object({
  app: z.enum(['web', 'mac', 'ios', 'android']),
  device: z.enum(['desktop', 'mobile', 'tablet']),
});
export type GuestClientInput = z.infer<typeof guestClientSchema>;
/** Absent whenever a client predates the field, so every reader must handle null. */
export type GuestClient = GuestClientInput;

/**
 * What the Worker stamps into a LiveKit participant's metadata at mint.
 * Read-only after that (`canUpdateOwnMetadata` is off), so every client can
 * read it from any participant and show the host which surface each person
 * is on — the same `GuestClient` the lobby already shows before admission,
 * carried into the room. Mirrored by `Sources/MeetingParticipantClient.swift`.
 *
 * `owner` is informational only: authorization reads the signed identity.
 */
export const participantMetadataSchema = z.object({
  owner: z.boolean(),
  /** Null when the client predates the field, or a host build that names no device. */
  client: guestClientSchema.nullable().optional(),
  /** The human who sent this participant, when a booking or host supplied one. */
  on_behalf_of: emailSchema.nullable().optional(),
  /** Self-declared notetaker status; visible to everyone in the room. */
  recording: z.boolean().optional(),
  /**
   * Let in by an event registration link, not by the host (docs/SESSIONS.md
   * §7). The host's People list says "Registered".
   */
  registered: z.boolean().optional(),
});
export type ParticipantMetadata = z.infer<typeof participantMetadataSchema>;

/**
 * The room-side `GuestClient` for a host connection. A host names a
 * `HostDevice` (for its LiveKit identity), not a `GuestClient`; this is the
 * one mapping between the two vocabularies.
 */
export function hostDeviceClient(device?: HostDevice | null): GuestClient | null {
  switch (device) {
    case 'mac': return { app: 'mac', device: 'desktop' };
    case 'iphone': return { app: 'ios', device: 'mobile' };
    case 'ipad': return { app: 'ios', device: 'tablet' };
    case 'android': return { app: 'android', device: 'mobile' };
    default: return null;
  }
}

/**
 * A Cloudflare Turnstile response token.
 *
 * Optional on every schema that carries it: no widget is configured until the
 * sitekey and secret exist, and native clients never solve one at all. The
 * Worker requires a token from browser `fetch()` (Fetch Metadata present) and
 * skips native URLSession — see `turnstile.ts`.
 */
export const turnstileTokenSchema = z.string().trim().min(1).max(2048);

export const joinRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  // Every guest identifies with a real email; it is used for the meeting log,
  // not for post-meeting mail. A declared notetaker has no human inbox, so
  // its email is omitted and the room stores an empty address.
  email: emailSchema.optional(),
  /** Optional CRM booking token — lobby context only; does not create a room. */
  booking_token: z.string().trim().min(1).max(128).optional(),
  /** Clears matching pre-knock lurker row when the guest knocks. */
  presence_id: z.string().uuid().optional(),
  /** Surface the guest is knocking from; optional so older clients still knock. */
  client: guestClientSchema.optional(),
  /** A notetaker declares that it will record; this is a display/consent signal, never authority. */
  recording: z.boolean().optional(),
  turnstile_token: turnstileTokenSchema.optional(),
}).superRefine((input, context) => {
  if (!input.recording && !input.email) {
    context.addIssue({ code: 'custom', path: ['email'], message: 'Email is required for a guest.' });
  }
});

/**
 * Pre-knock lurker heartbeat from the browser join page. Geo (city/country) is
 * stamped by the Worker from Cloudflare `request.cf` — never trusted from the client.
 */
export const guestPresenceStageSchema = z.enum(['visit', 'naming', 'preview']);
export const guestPresenceSchema = z.object({
  presence_id: z.string().uuid(),
  stage: guestPresenceStageSchema,
  /** Display name once the guest has typed or submitted one — never email. */
  name: z.string().trim().min(1).max(80).optional(),
  /**
   * CRM booking token from /room/<slug>/<token>. Same bound as the knock's
   * `booking_token` so a visitor arriving on a booking link is recognizable
   * before they knock — and so the token is retained for CRM correlation.
   */
  booking_token: z.string().trim().min(1).max(128).optional(),
  /** Surface the visitor is on, so the host sees it before they even knock. */
  client: guestClientSchema.optional(),
});
export type GuestPresenceStage = z.infer<typeof guestPresenceStageSchema>;
export type GuestPresenceInput = z.infer<typeof guestPresenceSchema>;

/**
 * A bug report filed from the meeting UI.
 *
 * Everything here is copied verbatim into a GitHub issue, so treat every field
 * as readable by anyone with access to the tracker. `message` is what the person
 * typed; `report` is the browser-generated debug dump, which
 * `web/src/meeting-debug-report.ts` already builds without tokens, emails, or
 * caption text. Nothing on this schema may carry a credential — if that dump
 * ever grows one, this route leaks it into a issue body.
 */
export const feedbackSchema = z.object({
  message: z.string().trim().min(1).max(FEEDBACK_MESSAGE_MAX_CHARS),
  /** Which room the reporter was in, when they filed from inside a meeting. */
  room_slug: roomSlugSchema.optional(),
  report: z.string().trim().max(FEEDBACK_REPORT_MAX_CHARS).optional(),
  turnstile_token: turnstileTokenSchema.optional(),
});
export type FeedbackInput = z.infer<typeof feedbackSchema>;

/**
 * POST /api/diagnostics — one MetricKit payload from a signed-in device
 *: a crash, a hang, or a daily metric report. The payload is
 * Apple's JSON as delivered; it holds call stacks and device facts, never
 * meeting content. Kept 30 days, read on Admin.
 */
export const DIAGNOSTIC_PAYLOAD_MAX_CHARS = 64 * 1024;
export const diagnosticReportSchema = z.object({
  platform: z.enum(['macos', 'ios', 'watchos']),
  app_version: z.string().trim().min(1).max(40),
  kind: z.enum(['crash', 'hang', 'metric']),
  payload_json: z.string().min(2).max(DIAGNOSTIC_PAYLOAD_MAX_CHARS),
});
export type DiagnosticReport = z.infer<typeof diagnosticReportSchema>;

/** One stored report without its payload, as `GET /api/admin/diagnostics` lists it. */
export const diagnosticRowSchema = z.object({
  id: z.string(),
  ts: z.number().int(),
  email: z.string(),
  platform: z.string(),
  app_version: z.string(),
  kind: z.string(),
  bytes: z.number().int(),
});
export const diagnosticsListResponseSchema = z.object({ reports: z.array(diagnosticRowSchema) });
export type DiagnosticsListResponse = z.infer<typeof diagnosticsListResponseSchema>;

/**
 * Deliberately opaque — no issue number or URL. The tracker is private, so a
 * link would only 404 for the guest who filed, and the number is a free read on
 * how much we ship.
 */
export type FeedbackResponse = Acknowledgement;

export const decisionSchema = z.object({
  admit: z.boolean(),
  /** Optional owner attribution for a notetaker that was not linked to a booking attendee. */
  on_behalf_of: emailSchema.nullable().optional(),
});

/**
 * `GET /api/rooms/:slug/lobby/socket?request_id=&token=`: a guest's lobby
 * socket names its receipt; an owner's carries the session instead.
 */
export const lobbySocketQuerySchema = z.object({
  request_id: z.string().uuid(),
  token: z.string().min(1).max(4096),
});

/**
 * POST /api/rooms/:slug/join-requests/:id/exchange: the one-time lobby token
 * the receipt carried, for the connection it was admitted to.
 */
export const lobbyExchangeSchema = z.object({
  lobby_token: z.string().min(1).max(4096),
});

/**
 * Renew a native session. Sent when the 8h access token is spent, so an owner
 * is not asked to sign in with Google every morning.
 *
 * The refresh token is a bearer credential and is stored in the Keychain, never
 * in defaults, and never logged (invariant 10).
 */
/**
 * A stable, random id for one installation of a native client. Refresh tokens
 * rotate per device, so two devices of the same owner never invalidate each
 * other. Generated on the device and kept in its Keychain; carries nothing
 * about the hardware.
 */
export const deviceIDSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

/**
 * What the device calls itself — `UIDevice.current.name`, the Mac's localized
 * host name. Shown in the device list so a person can tell which row is the
 * phone they no longer have. Sent at sign-in and at every renewal, so a row
 * from before the field gets its label at its next renewal.
 */
export const deviceLabelSchema = z.string().trim().min(1).max(60);

/** The two native surfaces. The browser is neither: it keeps a cookie, not a device row. */
export const nativeClientSchema = z.enum(['mac', 'ios', 'android']);
export type NativeClient = z.infer<typeof nativeClientSchema>;

/**
 * `{ ok: true }` — what every fire-and-forget control route answers. One
 * schema, one Swift type, so a client that only needs to know the call
 * landed decodes the same thing everywhere.
 */
export const acknowledgementSchema = z.object({
  ok: z.literal(true),
});
export type Acknowledgement = z.infer<typeof acknowledgementSchema>;

export const sessionRefreshSchema = z.object({
  refresh_token: z.string().min(16).max(4096),
  client: nativeClientSchema.optional(),
  /**
   * Only read when the token predates per-device rotation and so names no
   * device of its own. A renewed token carries its device in a claim.
   */
  device_id: deviceIDSchema.optional(),
  device_name: deviceLabelSchema.optional(),
});

/** One signed-in native install, as the device list shows it. */
export const ownerDeviceSummarySchema = z.object({
  device_id: z.string(),
  client: nativeClientSchema,
  /** What the device calls itself; null for a row that has not renewed since the field existed. */
  label: z.string().nullable(),
  /**
   * The platform and marketing/build version last reported at auth refresh.
   * An open set: `android` says what `client` cannot, because `client` keeps
   * to the values every shipped build decodes (an Android row reads `ios`).
   */
  platform: z.enum(['macos', 'ios', 'watchos', 'android']).nullable().optional(),
  app_version: z.string().nullable().optional(),
  version_seen_at: z.number().int().nullable().optional(),
  issued_at: z.number().int(),
  renewed_at: z.number().int(),
  /** The device this request came from. Signing it out is signing out. */
  current: z.boolean(),
});
export type OwnerDeviceSummary = z.infer<typeof ownerDeviceSummarySchema>;

/** GET /api/auth/devices and POST /api/auth/devices/revoke -> 200: the person's own devices. */
export const ownerDevicesResponseSchema = z.object({
  devices: z.array(ownerDeviceSummarySchema),
});
export type OwnerDevicesResponse = z.infer<typeof ownerDevicesResponseSchema>;

/**
 * Sign one device out. The row goes, so its refresh token is refused from
 * now on, and its access token is refused at its next request — see
 * `getOwnerSession`. Own devices at `/api/auth/devices/revoke`; anybody's at
 * `/api/admin/devices/revoke`, which is the one admin write that may target
 * yourself or a root admin: signing a phone out is not a lockout.
 */
export const deviceRevokeSchema = z.object({
  device_id: deviceIDSchema,
}).strict();

/** GET /api/admin/people/devices?email= and POST /api/admin/devices/revoke -> 200 */
export const adminPersonDevicesResponseSchema = z.object({
  email: z.string(),
  devices: z.array(ownerDeviceSummarySchema),
});
export type AdminPersonDevicesResponse = z.infer<typeof adminPersonDevicesResponseSchema>;

/** POST /api/auth/native/exchange and /api/auth/refresh -> 200 */
export const ownerSessionResponseSchema = z.object({
  access_token: z.string(),
  /** Native clients only; the browser keeps its 8h cookie. */
  refresh_token: z.string(),
  owner: z.object({
    sub: z.string(),
    email: z.string(),
    name: z.string(),
    picture: z.string().optional(),
  }),
});
export type OwnerSessionResponse = z.infer<typeof ownerSessionResponseSchema>;

export const nativeExchangeSchema = z.object({
  code: z.string().min(8).max(4096),
  code_verifier: z.string().min(43).max(128),
  redirect_uri: z.string().url().max(2048),
  nonce: z.string().min(16).max(256),
  /** Surface that minted the session; omitted by older clients, treated as mac. */
  client: nativeClientSchema.optional(),
  /** Omitted by older clients; the Worker then names the device itself. */
  device_id: deviceIDSchema.optional(),
  device_name: deviceLabelSchema.optional(),
});

/**
 * Native sign-in through the workspace's web sign-in (docs/CENTRAL_AUTH.md
 * §Signing in through the auth host). The app opens
 * `NATIVE_SIGN_IN_START_PATH` with its PKCE challenge and state, and the
 * workspace answers at the end with a single-use code on the callback it
 * named (`NATIVE_SIGN_IN_CALLBACKS`, ./native-app.ts), which the app redeems
 * with its verifier.
 */
export const NATIVE_SIGN_IN_START_PATH = '/api/auth/native/start';
export const NATIVE_SIGN_IN_FINISH_PATH = '/api/auth/native/finish';
/** The https callback for one workspace origin, or null when the app's associated domains do not cover its host. */
export function nativeSignInHttpsCallback(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith(`.${WORKSPACE_HOST_SUFFIX}`)) return null;
  return `${url.origin}${NATIVE_SIGN_IN_HTTPS_PATH}`;
}

/** S256 of a 32-byte verifier: 43 base64url characters (RFC 7636). */
const pkceChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const nativeSignInStartQuerySchema = z.object({
  code_challenge: pkceChallengeSchema,
  state: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u),
  /**
   * The app's callback, one of `NATIVE_SIGN_IN_CALLBACKS` exactly; any other
   * value refuses the start. Omitted by the apps released before the rename
   *, which get `LEGACY_NATIVE_SIGN_IN_CALLBACK`. Or the https
   * callback on this workspace's own host (`nativeSignInHttpsCallback`,
   *); the Worker refuses one for another host.
   */
  callback: z.union([
    z.enum(NATIVE_SIGN_IN_CALLBACKS),
    z.string().max(300).refine((value) => URL.canParse(value) && nativeSignInHttpsCallback(new URL(value).origin) === value),
  ]).optional(),
});
export const nativeSignInRedeemSchema = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{20,128}$/u),
  /** RFC 7636 unreserved characters, 43 to 128. */
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/u),
  client: nativeClientSchema.optional(),
  device_id: deviceIDSchema.optional(),
  device_name: deviceLabelSchema.optional(),
});

export const devSessionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** The Worker checks it against the workspace's identity domains. */
  email: emailSchema,
});

/**
 * Admin: take a person or an agent out of the global roster, or put them back.
 * Hiding is a view concern only — the `people` row, its history, and every
 * thread that resolves a sender through it are untouched. See
 * `migrations/0024_person_hidden.sql`.
 */
export const adminPersonVisibilitySchema = z.object({
  email: emailSchema,
  hidden: z.boolean(),
}).strict();

export const adminPersonVisibilityResponseSchema = z.object({
  email: z.string(),
  hidden: z.boolean(),
});
export type AdminPersonVisibilityResponse = z.infer<typeof adminPersonVisibilityResponseSchema>;

/**
 * Admin: make someone an admin, or take it back.
 *
 * Reads on `/admin` are open to every member; writes take this role. The two
 * refusals the server owns rather than the UI — you cannot change your own
 * role, and the last admin cannot be demoted — both answer
 * `role_change_refused`. See `migrations/0025_person_role.sql`.
 */
export const adminPersonRoleSchema = z.object({
  email: emailSchema,
  role: adminPersonRoleValueSchema,
}).strict();

export const adminPersonRoleResponseSchema = z.object({
  email: z.string(),
  role: adminPersonRoleValueSchema,
});
export type AdminPersonRoleResponse = z.infer<typeof adminPersonRoleResponseSchema>;

/**
 * Admin: stop somebody being able to renew a session, or let them back.
 *
 * Distinct from hiding, which is a view concern and changes no access at all.
 * This one is offboarding: `people.revoked_at` has been read on every renewal
 * since `0005_revocation.sql` and written by nothing, so cutting somebody off
 * meant a hand-written `wrangler d1 execute`. See `migrations/0005_revocation.sql`
 * and docs/ADMIN.md §5a.
 */
export const adminPersonAccessSchema = z.object({
  email: emailSchema,
  revoked: z.boolean(),
}).strict();

export const adminPersonAccessResponseSchema = z.object({
  email: z.string(),
  revoked: z.boolean(),
  /** Refresh tokens dropped by this call — one per device that was signed in. */
  devices_signed_out: z.number().int().nonnegative(),
});
export type AdminPersonAccessResponse = z.infer<typeof adminPersonAccessResponseSchema>;

export const transcriptLanguageSchema = z.enum(['en', 'pt', 'de', 'und']);
export type TranscriptLanguage = z.infer<typeof transcriptLanguageSchema>;

export const transcriptSegmentSchema = z.object({
  id: z.string().uuid(),
  meeting_id: z.string().uuid(),
  speaker_id: z.string().min(1).max(180),
  speaker_name: z.string().trim().min(1).max(80),
  language: transcriptLanguageSchema,
  starts_at_ms: z.number().int().nonnegative(),
  ends_at_ms: z.number().int().nonnegative(),
  text: z.string().trim().min(1).max(4000),
  is_final: z.boolean(),
}).refine((value) => value.ends_at_ms >= value.starts_at_ms, {
  message: 'Segment end must not precede its start.',
});

export const transcriptBatchSchema = z.object({
  segments: z.array(transcriptSegmentSchema).min(1).max(TRANSCRIPT_BATCH_MAX_SEGMENTS),
});


export const captionMessageSchema = z.object({
  version: z.literal(1),
  segment: transcriptSegmentSchema,
});


export const hostMessageSchema = z.object({
  version: z.literal(1),
  /**
   * `release_requested`: to the host, a device asked to take over.
   * `changed`: to everyone, the host is now `host_identity`.
   * `offered`: to `target_identity`, the host asks it to host.
   */
  type: z.enum(['release_requested', 'changed', 'offered']),
  /** Current host for a state update; the holder addressed by a release request. */
  host_identity: z.string().nullable(),
  /** The device that asked for the host, or the one offered it. */
  target_identity: z.string().nullable(),
  /** Who offers, for the prompt on the receiving device. */
  from_name: z.string().max(200).optional(),
});
export type HostMessage = z.infer<typeof hostMessageSchema>;


export const legacyChairMessageSchema = z.object({
  version: z.literal(1),
  type: z.enum(['release_requested', 'changed']),
  chair_identity: z.string().nullable(),
  target_identity: z.string().nullable(),
});
export type LegacyChairMessage = z.infer<typeof legacyChairMessageSchema>;

/**
 * Sent to a single participant the host acted on.
 *
 * Every one of these has an authoritative half at the SFU — a muted track, a
 * removed participant — and this is the humane half. Without it a share
 * vanishes while the browser keeps capturing, a mic goes dead with no
 * explanation, and a removal looks like a dropped connection worth retrying.
 */
export const moderationMessageSchema = z.object({
  version: z.literal(1),
  type: z.enum(['screenshare.stopped', 'audio.muted', 'participant.removed']),
  /** Display name of the owner who acted, for the notice. */
  by: z.string().trim().min(1).max(80),
});

export type ModerationMessage = z.infer<typeof moderationMessageSchema>;

/**
 * POST /api/rooms/{slug}/meetings/{id}/hand — a guest's own hand, up or down.
 *
 * No identity in the body, deliberately. Whose hand this is comes from the
 * caller's artifact principal, so a participant can only ever raise their own —
 * the same rule the quality report follows, and the reason this route can be
 * open to guests at all.
 */
export const handSchema = z.object({
  raised: z.boolean(),
});

export const handResponseSchema = z.object({
  ok: z.literal(true),
});

export type HandResponse = z.infer<typeof handResponseSchema>;

/** DELETE /api/rooms/{slug}/meetings/{id}/hands — the host clears the queue. */
export const lowerHandsResponseSchema = z.object({
  /** How many were actually up. Hands already down are not counted. */
  lowered: z.number().int().nonnegative(),
});

export type LowerHandsResponse = z.infer<typeof lowerHandsResponseSchema>;

/** Emoji reactions: topic and palette live in `./reactions`, zod-free. */
export const reactionEmojiSchema = z.enum(REACTION_EMOJI);

export const reactionMessageSchema = z.object({
  version: z.literal(1),
  emoji: reactionEmojiSchema,
});

export type ReactionMessage = z.infer<typeof reactionMessageSchema>;

/** POST /api/rooms/:slug/meetings/:id/screen-share/stop (owner only) */
export const screenShareStopSchema = z.object({
  /** LiveKit identity of the participant whose share should stop. */
  identity: z.string().trim().min(1).max(180),
});

export const screenShareStopResponseSchema = z.object({
  /** How many published tracks were muted — screen video, plus its audio. */
  stopped: z.number().int().nonnegative(),
});

export type ScreenShareStopResponse = z.infer<typeof screenShareStopResponseSchema>;

/**
 * POST /api/rooms/:slug/meetings/:id/participants/mute (owner only)
 *
 * Naming an identity mutes that one person. Omitting it mutes everyone in the
 * room except the owner, which is the noisy-room control — there is no unmute
 * counterpart on purpose: a host may take the floor back, but only the person
 * behind the microphone may open it again.
 */
export const participantMuteSchema = z.object({
  identity: z.string().trim().min(1).max(180).optional(),
});

export const participantMuteResponseSchema = z.object({
  /** How many people were actually publishing audio and got muted. */
  muted: z.number().int().nonnegative(),
});

export type ParticipantMuteResponse = z.infer<typeof participantMuteResponseSchema>;

/** POST /api/rooms/:slug/meetings/:id/participants/remove (owner only) */
export const participantRemoveSchema = z.object({
  /** LiveKit identity of the participant to disconnect. */
  identity: z.string().trim().min(1).max(180),
});

export const participantRemoveResponseSchema = z.object({
  /** Their admission is spent: re-entry means knocking again. */
  removed: z.literal(true),
});

export type ParticipantRemoveResponse = z.infer<typeof participantRemoveResponseSchema>;

export const connectionQualitySchema = z.enum(['unknown', 'lost', 'poor', 'good', 'excellent']);

const qualityDurationSchema = z.number().int().nonnegative().max(QUALITY_DURATION_MAX_MS);

/**
 * Per-participant call quality. Deliberately carries no IP, user agent, or
 * network identifier — only how long this client spent in each LiveKit
 * connection-quality state. `identity` and `role` come from the artifact
 * principal, never from the body, so a client cannot report for someone else.
 */
/** The surfaces a native or web client reports itself as: presence beats and quality reports. */
export const PEER_CLIENTS = ['mac', 'ios', 'web'] as const;
export type PeerClient = (typeof PEER_CLIENTS)[number];
export const peerClientSchema = z.enum(PEER_CLIENTS);

export const qualityReportSchema = z.object({
  client: peerClientSchema,
  connected_ms: qualityDurationSchema,
  excellent_ms: qualityDurationSchema,
  good_ms: qualityDurationSchema,
  poor_ms: qualityDurationSchema,
  lost_ms: qualityDurationSchema,
  reconnect_count: z.number().int().nonnegative().max(QUALITY_RECONNECT_MAX),
  worst_quality: connectionQualitySchema,
});

/**
 * Client-observed LiveKit receive bytes for one meeting client session and UTC
 * month. This is a Meet-side estimate, not a provider billing record.
 */
export const downstreamUsageReportSchema = z.object({
  reporter_id: z.string().uuid(),
  month_start: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  received_bytes: z.number().int().nonnegative().max(5_000_000_000_000),
});

export const calendarConnectExchangeSchema = z.object({
  code: z.string().min(8).max(4096),
  code_verifier: z.string().min(43).max(128),
  redirect_uri: z.string().url().max(2048),
  nonce: z.string().min(16).max(256),
});

/**
 * `POST /api/calendar/connect/android` and its `/accounts/` twin: the
 * one-time code Google's Android AuthorizationClient hands the app
 * (`requestOfflineAccess`), for the Worker's own client to redeem.
 */
export const calendarAndroidExchangeSchema = z.object({
  server_auth_code: z.string().min(8).max(4096),
});

/** `GET /api/calendar/connect/android`: the client the app asks Google to issue that code for. */
export const calendarAndroidClientSchema = z.object({
  server_client_id: z.string().min(1),
});
export type CalendarAndroidClient = z.infer<typeof calendarAndroidClientSchema>;

/** A calendar day, `YYYY-MM-DD` — what Google stores for an all-day event. */
export const calendarDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected a day as YYYY-MM-DD.');
const calendarEventTimeSchema = z.string().datetime({ offset: true }).or(calendarDaySchema);

/**
 * All-day rows carry days, timed rows carry instants, never mixed; an
 * all-day end is the exclusive next day, as Google stores it.
 */
function calendarTimesAgree(value: { all_day?: boolean | undefined; start?: string | undefined; end?: string | undefined }): boolean {
  if (value.start === undefined || value.end === undefined) return true;
  const isDay = (time: string) => calendarDaySchema.safeParse(time).success;
  if (value.all_day) return isDay(value.start) && isDay(value.end);
  return !isDay(value.start) && !isDay(value.end);
}

/** The title of a meeting created without one, and its invite's description line. */
export const DEFAULT_MEETING_TITLE = 'Starlings';

export const calendarEventCreateSchema = z.object({
  title: z.string().trim().min(1).max(200).default(DEFAULT_MEETING_TITLE),
  start: calendarEventTimeSchema,
  end: calendarEventTimeSchema,
  /** True writes `start`/`end` as days (`YYYY-MM-DD`, end exclusive). */
  all_day: z.boolean().optional(),
  join_url: z.string().url().max(2048).optional(),
  room_slug: roomSlugSchema.optional(),
  /** Google calendar id (`primary` or the list id). Defaults to primary. */
  calendar_id: z.string().trim().min(1).max(256).optional(),
  attendees: z.array(emailSchema).max(50).default([]),
  description: z.string().trim().max(4000).optional(),
  location: z.string().trim().max(1024).optional(),
  /** IANA timezone for Google Calendar display (e.g. Europe/Amsterdam). */
  time_zone: z.string().trim().min(1).max(64).optional(),
  /** Minutes to get there, set by the owner. 0 or null is off; Meet never estimates one. */
  travel_time_minutes: z.number().int().min(0).max(24 * 60).nullable().optional(),
}).refine((value) => Date.parse(value.end) > Date.parse(value.start), {
  message: 'Event end must be after start.',
}).refine(calendarTimesAgree, {
  message: 'An all-day event takes days as YYYY-MM-DD; a timed one takes instants.',
});

/**
 * An event proposed from a mail forwarded to `calendar@`, waiting
 * on Home for Add or Discard. Times follow the create schema: days for an
 * all-day row, instants with an offset otherwise. Nothing of the mail itself
 * survives past extraction except the lines here.
 */
export const pendingCalendarEventSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  start: calendarEventTimeSchema,
  end: calendarEventTimeSchema,
  all_day: z.boolean(),
  /** IANA zone the mail implied, when it did; the client shows local time either way. */
  time_zone: z.string().trim().min(1).max(64).nullable(),
  location: z.string().trim().max(1024).nullable(),
  notes: z.string().trim().max(4000).nullable(),
  /** People the mail names, kept in notes at Add time — never invited (open point 1). */
  attendees: z.array(z.string().trim().min(1).max(200)).max(50),
  /** The forwarded mail's subject line and sender, so the row says where it came from. */
  source_subject: z.string().trim().max(500).nullable(),
  source_from: z.string().trim().max(320).nullable(),
  /** 0–1 from the extractor; below `PENDING_CALENDAR_EVENT_MIN_CONFIDENCE` never lands. */
  confidence: z.number().min(0).max(1),
  created_at: z.number().int(),
  expires_at: z.number().int(),
});
export type PendingCalendarEvent = z.infer<typeof pendingCalendarEventSchema>;

/** `GET /api/calendar/pending`: the owner's rows, oldest first. */
export const pendingCalendarEventsResponseSchema = z.object({
  events: z.array(pendingCalendarEventSchema),
});
export type PendingCalendarEventsResponse = z.infer<typeof pendingCalendarEventsResponseSchema>;

/** Add writes the row to this calendar; absent is the owner's primary. */
export const pendingCalendarEventAddSchema = z.object({
  calendar_id: z.string().trim().min(1).max(256).optional(),
});

/**
 * Quick add: one sentence in, a draft out. The grammar runs on
 * the Worker for the web; when it reads no date, or two times, the sentence
 * — and only the sentence — goes to the notes engine, and `source` says so.
 */
export const calendarQuickAddSchema = z.object({
  sentence: z.string().trim().min(1).max(500),
  /** The moment of typing as local wall time, `YYYY-MM-DDTHH:MM`, in `time_zone`. */
  now: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u),
  time_zone: z.string().trim().min(1).max(64),
  default_duration_minutes: z.number().int().min(5).max(24 * 60).default(60),
  /** False keeps the notes engine out of it: the grammar's answer, whatever it read. */
  allow_model: z.boolean().default(true),
});
export const calendarQuickAddDraftSchema = z.object({
  title: z.string(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  all_day: z.boolean(),
  location: z.string().nullable(),
  invitees: z.array(z.string()),
  /** 0–1: how sure the reader is of the whole draft. */
  confidence: z.number(),
});
export type CalendarQuickAddDraft = z.infer<typeof calendarQuickAddDraftSchema>;

export const calendarQuickAddResponseSchema = z.object({
  draft: calendarQuickAddDraftSchema,
  /** Which reader produced the draft: the grammar, or the model behind it. */
  source: z.enum(['grammar', 'model']),
});
export type CalendarQuickAddResponse = z.infer<typeof calendarQuickAddResponseSchema>;

export const calendarUpcomingQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(2400).optional(),
});

const CALENDAR_RANGE_MAX_MS = 45 * 24 * 60 * 60 * 1000;

export const calendarEventsQuerySchema = z.object({
  time_min: z.string().datetime({ offset: true }),
  time_max: z.string().datetime({ offset: true }),
}).refine((value) => Date.parse(value.time_max) > Date.parse(value.time_min), {
  message: 'time_max must be after time_min.',
}).refine((value) => Date.parse(value.time_max) - Date.parse(value.time_min) <= CALENDAR_RANGE_MAX_MS, {
  message: 'Calendar range cannot exceed 45 days.',
});

const calendarEventRefSchema = z.object({
  calendar_id: z.string().trim().min(1).max(256),
  event_id: z.string().trim().min(1).max(1024),
});

/**
 * Event rows list with `id = "<calendar ref>:<Google event id>"` so the same
 * event from two accounts cannot collide. Google wants the bare id on every
 * write. The Mac and iOS strip the prefix in `CalendarWire.rawEventID`; this
 * is the same operation for the web and for the Worker, which accepts either
 * form so no client can send a 404 to Google by mistake.
 */
export const calendarEventPatchSchema = calendarEventRefSchema.extend({
  title: z.string().trim().min(1).max(200).optional(),
  start: calendarEventTimeSchema.optional(),
  end: calendarEventTimeSchema.optional(),
  /** Sent with `start`/`end`: true makes the event all-day, false makes it timed. */
  all_day: z.boolean().optional(),
  attendees: z.array(emailSchema).max(50).optional(),
  description: z.string().trim().max(4000).optional(),
  location: z.string().trim().max(1024).optional(),
  time_zone: z.string().trim().min(1).max(64).optional(),
  join_url: z.string().url().max(2048).optional(),
  room_slug: roomSlugSchema.optional(),
  /** Sent alone or with anything else: a number sets it, 0 or null clears it. */
  travel_time_minutes: z.number().int().min(0).max(24 * 60).nullable().optional(),
}).refine((value) => {
  const hasStart = value.start !== undefined;
  const hasEnd = value.end !== undefined;
  if (hasStart !== hasEnd) return false;
  if (hasStart && hasEnd) return Date.parse(value.end!) > Date.parse(value.start!);
  return true;
}, {
  message: 'Event start and end must be sent together, with end after start.',
}).refine(calendarTimesAgree, {
  message: 'An all-day event takes days as YYYY-MM-DD; a timed one takes instants.',
});

export const calendarEventDeleteSchema = calendarEventRefSchema;

export const calendarEventReplySchema = z.enum(['accepted', 'declined', 'tentative']);
export const calendarEventRespondSchema = calendarEventRefSchema.extend({
  response: calendarEventReplySchema,
});

export const calendarEventMoveSchema = calendarEventRefSchema.extend({
  destination_id: z.string().trim().min(1).max(256),
});

/** Availability is asked for a screenful at a time, never a quarter. */
const FREE_BUSY_RANGE_MAX_MS = 45 * 24 * 60 * 60 * 1000;

export const calendarFreeBusySchema = z.object({
  time_min: z.string().datetime({ offset: true }),
  time_max: z.string().datetime({ offset: true }),
  emails: z.array(emailSchema).min(1).max(20),
}).refine((value) => Date.parse(value.time_max) > Date.parse(value.time_min), {
  message: 'time_max must be after time_min.',
}).refine(
  (value) => Date.parse(value.time_max) - Date.parse(value.time_min) <= FREE_BUSY_RANGE_MAX_MS,
  { message: 'Availability range cannot exceed 45 days.' },
);

const WORK_ITEMS_RANGE_MAX_DAYS = 120;

/** Dated tasks and milestones drawn beside events. Plain dates, not instants. */
export const calendarWorkItemsQuerySchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'start must be YYYY-MM-DD'),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'end must be YYYY-MM-DD'),
  include_done: z.stringbool().optional().default(false),
}).refine((value) => value.end >= value.start, {
  message: 'end must not be before start.',
}).refine((value) => {
  const span = Date.parse(`${value.end}T00:00:00Z`) - Date.parse(`${value.start}T00:00:00Z`);
  return span <= WORK_ITEMS_RANGE_MAX_DAYS * 24 * 60 * 60 * 1000;
}, {
  message: `Work item range cannot exceed ${WORK_ITEMS_RANGE_MAX_DAYS} days.`,
});

/**
 * The owner's bookable blocks from Core, drawn as a layer. Same plain-date
 * bounds and the same cap as work items: both are "what is on my calendar
 * this range", and a client asks for them together.
 */
export const calendarAvailabilityQuerySchema = z.object({
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'start must be YYYY-MM-DD'),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'end must be YYYY-MM-DD'),
}).refine((value) => value.end >= value.start, {
  message: 'end must not be before start.',
}).refine((value) => {
  const span = Date.parse(`${value.end}T00:00:00Z`) - Date.parse(`${value.start}T00:00:00Z`);
  return span <= WORK_ITEMS_RANGE_MAX_DAYS * 24 * 60 * 60 * 1000;
}, {
  message: `Availability range cannot exceed ${WORK_ITEMS_RANGE_MAX_DAYS} days.`,
});

/**
 * Mint a per-person invite token. The window is optional: a link sent by hand
 * has no calendar event behind it and must not read as expired on the card.
 * `guest_name` / `guest_email` are the holder's own identity, returned by the
 * public projection so the join form is filled in (docs/ROOM_ENTRY.md).
 */
export const calendarBookingMintSchema = z.object({
  title: z.string().trim().min(1).max(200),
  start: z.string().datetime({ offset: true }).optional(),
  end: z.string().datetime({ offset: true }).optional(),
  room_slug: roomSlugSchema,
  join_url: z.string().url().max(2048).optional(),
  guest_name: z.string().trim().min(1).max(120).optional(),
  guest_email: z.string().trim().toLowerCase().email().max(254).optional(),
}).refine((value) => (value.start === undefined) === (value.end === undefined), {
  message: 'Send both start and end, or neither.',
}).refine((value) => !value.start || !value.end || Date.parse(value.end) > Date.parse(value.start), {
  message: 'Event end must be after start.',
});

/**
 * A partial update: send only the field you are changing. `hidden_calendar_keys`
 * is device-independent by construction — a Google calendar is keyed by its id,
 * an EventKit one by account and title, because EventKit's own identifiers are
 * local to a device and would not mean the same thing on the phone.
 */
export const calendarPreferencesSchema = z.object({
  selected_calendar_ids: z.array(z.string().trim().min(1).max(256)).min(1).max(50).optional(),
  /** Subscribed feeds omitted from Home's shared Upcoming feed; new feeds are included by default. */
  upcoming_excluded_subscription_ids: z.array(z.string().trim().min(1).max(256)).max(500).optional(),
  hidden_calendar_keys: z.array(z.string().trim().min(1).max(512)).max(500).optional(),
  /** Calendars and accounts kept out of the app entirely — see hidden_calendar_keys for the key grammar. */
  disabled_calendar_keys: z.array(z.string().trim().min(1).max(512)).max(500).optional(),
  /** Opaque event identities that remain visible but cannot drive Next or meeting alerts. */
  demoted_event_keys: z.array(z.string().trim().min(1).max(2048)).max(1000).optional(),
  /** Owner-wide EventKit master gate. Absent/false keeps local calendars opt-in. */
  includes_local_calendars: z.boolean().optional(),
  /**
   * The project or lead an event is about, by the same opaque event key the
   * demotion list uses. Owner-wide, so the Mac and the phone file a meeting
   * started from that event under the same subject. Sent whole, like the
   * other lists: the client reads, changes one entry, and writes back.
   */
  event_subjects: z.record(z.string().trim().min(1).max(2048), calendarEventSubjectSchema).optional(),
  /** Owner-wide Upcoming display policy; source selection remains separate. */
  upcoming: upcomingPreferencesSchema.optional(),
}).refine(
  (value) => value.selected_calendar_ids !== undefined
    || value.upcoming_excluded_subscription_ids !== undefined
    || value.hidden_calendar_keys !== undefined
    || value.disabled_calendar_keys !== undefined
    || value.demoted_event_keys !== undefined
    || value.includes_local_calendars !== undefined
    || value.event_subjects !== undefined
    || value.upcoming !== undefined,
  { message: 'Send at least one calendar preference field.' },
).refine(
  (value) => value.event_subjects === undefined || Object.keys(value.event_subjects).length <= 1000,
  { message: 'Too many event subjects.' },
);

export {
  type CalendarEventSubject,
  calendarEventSubjectSchema,
  type UpcomingPreferences,
  upcomingPreferencesSchema,
} from './calendar';

/** A published `.ics` feed the owner wants drawn beside their own calendars. */
export const calendarSubscriptionCreateSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  title: z.string().trim().max(120).optional(),
  color: z.string().trim().max(16).optional(),
});

export type JoinRequestInput = z.infer<typeof joinRequestSchema>;
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
export type CaptionMessage = z.infer<typeof captionMessageSchema>;
export type QualityReport = z.infer<typeof qualityReportSchema>;
export type DownstreamUsageReport = z.infer<typeof downstreamUsageReportSchema>;

/** Owner-only connection quality summary for a meeting. */
export const meetingQualitySchema = z.object({
  identity: z.string(),
  client: z.string(),
  role: z.enum(['owner', 'guest']),
  connectedMs: z.number().int(),
  excellentMs: z.number().int(),
  goodMs: z.number().int(),
  poorMs: z.number().int(),
  lostMs: z.number().int(),
  reconnectCount: z.number().int(),
  worstQuality: z.string(),
  updatedAt: z.number().int(),
});
export type MeetingQuality = z.infer<typeof meetingQualitySchema>;

export const meetingQualityResponseSchema = z.object({ participants: z.array(meetingQualitySchema) });
export type MeetingQualityResponse = z.infer<typeof meetingQualityResponseSchema>;

export type CalendarEventCreateInput = z.infer<typeof calendarEventCreateSchema>;
export type CalendarEventsQuery = z.infer<typeof calendarEventsQuerySchema>;
export type CalendarEventPatchInput = z.infer<typeof calendarEventPatchSchema>;
export type CalendarEventDeleteInput = z.infer<typeof calendarEventDeleteSchema>;
export type CalendarBookingMintInput = z.infer<typeof calendarBookingMintSchema>;

// ---------------------------------------------------------------------------
// Response shapes (wire format exactly as the Worker serializes it today —
// receipts/status are camelCase, connection details are snake_case).
// ---------------------------------------------------------------------------

export const lobbyStatusValueSchema = z.enum(['waiting', 'admitted', 'rejected', 'joined', 'expired', 'removed']);
export type LobbyStatusValue = z.infer<typeof lobbyStatusValueSchema>;

/** POST /api/rooms/:slug/join-requests → 201 */
export const joinRequestReceiptSchema = z.object({
  requestId: z.string(),
  lobbyToken: z.string(),
  status: lobbyStatusValueSchema,
  waitingCount: z.number().int().nonnegative(),
});
export type JoinRequestReceipt = z.infer<typeof joinRequestReceiptSchema>;

/** GET /api/rooms/:slug/join-requests/:id → 200 */
export const joinStatusResponseSchema = z.object({
  status: lobbyStatusValueSchema,
  waitingCount: z.number().int().nonnegative(),
  /** The meeting is an event session (docs/SESSIONS.md §8): join muted, and the artifact goes to the host only. */
  session: z.boolean().optional(),
});
export type JoinStatusResponse = z.infer<typeof joinStatusResponseSchema>;

/** POST /api/rooms/:slug/start and .../exchange → 200 */
export const connectionDetailsSchema = z.object({
  server_url: z.string(),
  participant_token: z.string(),
  /** Unix seconds when the LiveKit JWT expires. */
  participant_token_expires_at: z.number().int(),
  artifact_token: z.string(),
  meeting_id: z.string(),
  livekit_room: z.string(),
  /** Unix epoch milliseconds when the meeting opened on the control plane. */
  started_at: z.number().int(),
  /** Present on an owner host connection; lets a Mac arrive as a companion. */
  owner_identity: z.string().optional(),
  /** The device that holds the host: it admits guests and runs the transcript. */
  host_identity: z.string().nullable().optional(),
  is_host: z.boolean().optional(),
  /** Deprecated: 5.8.x Macs read these. Same values as `host_*`; removes them. */
  chair_identity: z.string().nullable().optional(),
  is_chair: z.boolean().optional(),
  /** The meeting is an event session (docs/SESSIONS.md §8): join muted, and the artifact goes to the host only. */
  session: z.boolean().optional(),
});
export type ConnectionDetails = z.infer<typeof connectionDetailsSchema>;

export const ownerRoomConfigurationSchema = z.object({
  slug: z.string(),
  ownerSub: z.string(),
  ownerEmail: z.string(),
  ownerName: z.string().nullable().optional(),
  kind: z.literal('permanent'),
  expiresAt: z.null(),
});
export type OwnerRoomConfiguration = z.infer<typeof ownerRoomConfigurationSchema>;

/** GET /api/owner/room -> 200 */
export const ownerRoomResponseSchema = z.object({
  room: ownerRoomConfigurationSchema,
});
export type OwnerRoomResponse = z.infer<typeof ownerRoomResponseSchema>;

/** The existing 30-second host lease, expressed explicitly for native hosts. */
export const hostLeaseGrantSchema = z.object({
  host_lease_expires_at: z.number().int(),
  renew_after_ms: z.number().int().nonnegative(),
});
export type HostLeaseGrant = z.infer<typeof hostLeaseGrantSchema>;

export const ownerHostRoomConfigurationSchema = z.object({
  slug: z.string(),
  kind: z.literal('permanent'),
  expiresAt: z.null(),
});
export type OwnerHostRoomConfiguration = z.infer<typeof ownerHostRoomConfigurationSchema>;

/**
 * POST /api/owner/host-session -> 200.
 *
 * This is a mapped-room bootstrap, not a room creation API. The Worker chooses
 * the permanent slug from OWNER_ROOM_MAP and returns the same owner connection
 * credentials as the long-standing macOS /rooms/:slug/start route. Repeating
 * it resumes the open meeting, renews its lease, and exchanges fresh owner
 * media credentials without minting another product room.
 */
export const ownerHostSessionResponseSchema = z.object({
  room: ownerHostRoomConfigurationSchema,
  connection: connectionDetailsSchema,
  lease: hostLeaseGrantSchema,
  captions: z.object({
    topic: z.literal(CAPTION_DATA_TOPIC),
    publisher_identity: z.string(),
  }),
});
export type OwnerHostSessionResponse = z.infer<typeof ownerHostSessionResponseSchema>;

/** POST /api/rooms/:slug/meetings/:id/heartbeat -> 200 */
export const hostHeartbeatResponseSchema = hostLeaseGrantSchema.extend({
  ok: z.literal(true),
});
export type HostHeartbeatResponse = z.infer<typeof hostHeartbeatResponseSchema>;

/** POST /api/rooms/:slug/meetings/:id/host/claim request. */
export const hostClaimRequestSchema = z.object({
  device: hostDeviceSchema,
  /** Take the host only when nobody holds it: a companion's automatic claim. */
  if_vacant: z.boolean().optional(),
});
export type HostClaimRequest = z.infer<typeof hostClaimRequestSchema>;

/**
 * POST /api/rooms/:slug/meetings/:id/host/{claim,release} -> 200. `host`:
 * the caller holds the host. `release_requested`: the current host was asked
 * to hand over. `released`: the caller no longer holds it.
 */
export const hostMutationResponseSchema = z.object({
  status: z.enum(['host', 'release_requested', 'released']),
  host_identity: z.string().nullable(),
  pending_identity: z.string().nullable(),
  host_lease_expires_at: z.number().int(),
});
export type HostMutationResponse = z.infer<typeof hostMutationResponseSchema>;

/**
 * POST /api/rooms/:slug/meetings/:id/host/offer: the host asks one device in
 * the call to host. Another device of the same member takes it at once; another
 * member is asked, and answers with their own signed session.
 */
export const hostOfferRequestSchema = z.object({ target_identity: z.string().min(1).max(200) });
export type HostOfferRequest = z.infer<typeof hostOfferRequestSchema>;

export const hostOfferResponseSchema = z.object({
  status: z.literal('offered'),
  target_identity: z.string(),
  /** How long the offer stands, from now, in milliseconds. */
  expires_in_ms: z.number().int(),
});
export type HostOfferResponse = z.infer<typeof hostOfferResponseSchema>;

/** POST /api/rooms/:slug/meetings/:id/host/offer/answer, from the member offered. */
export const hostOfferAnswerRequestSchema = z.object({ accept: z.boolean() });
export type HostOfferAnswerRequest = z.infer<typeof hostOfferAnswerRequestSchema>;

/**
 * `accepted`: start the room as its host (`POST /api/rooms/:slug/start`), then
 * claim the host. `declined`: the offer is gone.
 */
export const hostOfferAnswerResponseSchema = z.object({
  status: z.enum(['accepted', 'declined']),
  room_slug: z.string(),
  meeting_id: z.string(),
});
export type HostOfferAnswerResponse = z.infer<typeof hostOfferAnswerResponseSchema>;

/** Deprecated: the 5.8.x `/chair/{claim,release}` answer. removes it. */
export const legacyChairMutationResponseSchema = z.object({
  status: z.enum(['chair', 'release_requested', 'released']),
  chair_identity: z.string().nullable(),
  pending_identity: z.string().nullable(),
  host_lease_expires_at: z.number().int(),
});
export type LegacyChairMutationResponse = z.infer<typeof legacyChairMutationResponseSchema>;

/** Owner lobby snapshot lurker — ephemeral, TTL'd in the room DO. */
export const guestPresenceRowSchema = z.object({
  id: z.string(),
  stage: guestPresenceStageSchema,
  name: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  /** CRM booking token the visitor arrived on, when the link carried one. */
  bookingToken: z.string().nullable(),
  /** Null when the visitor's client predates the field. */
  client: guestClientSchema.nullable(),
  seenAt: z.number().int(),
  /** First heartbeat for this tab's visit — what "how long have they waited" measures from. */
  createdAt: z.number().int(),
});
export type GuestPresenceRow = z.infer<typeof guestPresenceRowSchema>;

export const lobbyRequestResponseSchema = z.object({
  id: z.string(),
  meetingId: z.string(),
  name: z.string(),
  email: z.string(),
  identity: z.string(),
  status: lobbyStatusValueSchema,
  createdAt: z.number().int(),
  bookingToken: z.string().nullable(),
  /** Null when the guest's client predates the field. */
  client: guestClientSchema.nullable(),
  /** The human who sent this participant, resolved from a booking or set by the owner. */
  on_behalf_of: emailSchema.nullable().optional(),
  /** Self-declared notetaker status, for visible consent before and after admission. */
  recording: z.boolean().optional(),
  /** Admitted by an event registration link, without a host click (docs/SESSIONS.md §7). */
  registered: z.boolean().optional(),
});
export type LobbyRequestResponse = z.infer<typeof lobbyRequestResponseSchema>;

/** POST /api/rooms/:slug/session/door → 200: registration links stop admitting for the rest of the session. */
export const sessionDoorResponseSchema = z.object({
  session_door_open: z.boolean(),
});
export type SessionDoorResponse = z.infer<typeof sessionDoorResponseSchema>;

/** Owner-controlled room policy. Only notetakers that declared recording are refused. */
export const roomSettingsSchema = z.object({
  refuse_recorders: z.boolean(),
});
export type RoomSettings = z.infer<typeof roomSettingsSchema>;

export const roomSettingsUpdateSchema = z.object({
  refuse_recorders: z.boolean(),
});

/** GET /api/rooms/:slug/lobby → 200 (owner only) */
export const lobbySnapshotResponseSchema = z.object({
  meeting: z.object({
    id: z.string(),
    livekitRoom: z.string(),
    startedAt: z.number().int(),
    hostLeaseExpiresAt: z.number().int(),
    hostIdentity: z.string().nullable().optional(),
    pendingHostIdentity: z.string().nullable().optional(),
    /** The device the host offered the host to, while the offer stands. */
    hostOfferIdentity: z.string().nullable().optional(),
    /** Deprecated: 5.8.x Macs read these. Same values as `*HostIdentity`; removes them. */
    chairIdentity: z.string().nullable().optional(),
    pendingChairIdentity: z.string().nullable().optional(),
    /**
     * Present in an event session: true while registration links let guests
     * in without a knock, false once the host closed that door.
     */
    session_door_open: z.boolean().optional(),
  }).nullable(),
  requests: z.array(lobbyRequestResponseSchema),
  lurkers: z.array(guestPresenceRowSchema),
  // Added after 4.4.3; older Workers omit it. Keep it optional on the wire so
  // updated clients can still read a lobby snapshot during a rolling deploy.
  room_settings: roomSettingsSchema.optional(),
});
export type LobbySnapshotResponse = z.infer<typeof lobbySnapshotResponseSchema>;

/** POST /api/rooms/:slug/join-requests/:id/decision -> 200 */
export const lobbyDecisionResponseSchema = z.object({
  request: lobbyRequestResponseSchema,
});
export type LobbyDecisionResponse = z.infer<typeof lobbyDecisionResponseSchema>;

/**
 * POST /api/rooms/:slug/guest-presence/:id/remove -> 200 (owner only)
 *
 * Drops a pre-knock lurker off the waiting page and blocks that tab's
 * presence id from re-announcing (or knocking) for a cooldown — the closest
 * thing to closing their connection when they have no live socket to push a
 * message down (see `GUEST_PRESENCE_TTL_MILLISECONDS` neighbor in the DO).
 */
export const guestPresenceRemoveResponseSchema = z.object({
  removed: z.literal(true),
});
export type GuestPresenceRemoveResponse = z.infer<typeof guestPresenceRemoveResponseSchema>;

/** POST /api/rooms/:slug/meetings/:id/transcript -> 200 */
export const transcriptAppendResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
});
export type TranscriptAppendResponse = z.infer<typeof transcriptAppendResponseSchema>;

/** Only finalized text; never raw audio or video or delivery metadata. */
export const artifactMaterialResponseSchema = z.object({
  roomSlug: z.string(),
  meetingId: z.string(),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  transcript: z.array(transcriptSegmentSchema),
});
export type ArtifactMaterialResponse = z.infer<typeof artifactMaterialResponseSchema>;

/**
 * POST /api/rooms/:slug/meetings/:id/end. On a personal room the body is
 * ignored: the room is the owner's and ending it drops everyone. On the
 * internal room the meeting record ends with the host — the transcript stops
 * with the host device — but the call goes on for whoever is still in it unless
 * `everyone` is set. Any member may set it.
 */
export const endMeetingSchema = z.object({
  everyone: z.boolean().optional(),
});
export const endMeetingResponseSchema = z.object({
  status: z.literal('ended'),
  already_ended: z.boolean(),
  /** Whether the SFU room was closed, dropping everyone still in it. */
  room_closed: z.boolean().optional(),
});
export type EndMeetingResponse = z.infer<typeof endMeetingResponseSchema>;

/** POST /api/rooms/:slug/meetings/:id/finalize -> 202 */
export const finalizeMeetingResponseSchema = z.object({
  status: z.literal('processing'),
  artifact: artifactMaterialResponseSchema,
});
export type FinalizeMeetingResponse = z.infer<typeof finalizeMeetingResponseSchema>;

/** Envisioning-only CRM filing for a live meeting. The kinds and their words are `meeting-kinds.ts`. */
export const meetingKindSchema = z.enum(MEETING_KINDS);
export type MeetingKind = z.infer<typeof meetingKindSchema>;

export const meetingCategorySchema = z.object({
  meeting_kind: meetingKindSchema,
  lead_id: z.string().uuid().nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  event_id: z.string().uuid().nullable().optional(),
  partner_organization_id: z.string().uuid().nullable().optional(),
  subject_title: z.string().trim().max(200).nullable().optional(),
}).superRefine((value, ctx) => {
  // One subject per kind, and only for the kind that takes it.
  const subjects = [
    ['lead', 'lead_id', value.lead_id],
    ['project', 'project_id', value.project_id],
    ['event', 'event_id', value.event_id],
    ['partner', 'partner_organization_id', value.partner_organization_id],
  ] as const;
  for (const [kind, field, id] of subjects) {
    if (value.meeting_kind === kind && !id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} is required for ${kind}.`, path: [field] });
    }
    if (value.meeting_kind !== kind && id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} only applies to ${kind}.`, path: [field] });
    }
  }
});
export type MeetingCategoryInput = z.infer<typeof meetingCategorySchema>;

/** GET/PUT /api/rooms/:slug/meetings/:id/category */
export const meetingCategoryResponseSchema = z.object({
  meeting_kind: meetingKindSchema,
  lead_id: z.string().nullable(),
  project_id: z.string().nullable(),
  /** Event is absent from a hosted meeting's answer: only an import files on an event today. A hosted meeting can file on a partner. */
  event_id: z.string().nullable().optional(),
  partner_organization_id: z.string().nullable().optional(),
  subject_title: z.string().nullable(),
  categorized_by: z.string().nullable(),
  categorized_at: z.number().int().nullable(),
});
export type MeetingCategoryResponse = z.infer<typeof meetingCategoryResponseSchema>;


export {
  type CardTrace,
  type CrmBoardResponse,
  type CrmContact,
  type CrmContactDetail,
  type CrmContactMember,
  type CrmContactResponse,
  type CrmContactsResponse,
  type CrmLicense,
  type CrmOffer,
  type CrmSubjectCommercialResponse,
  type CrmGithubLoginResponse,
  type CrmGithubRepo,
  type CrmGithubReposResponse,
  type CrmInteraction,
  type CrmInteractionRow,
  type CrmInteractionContact,
  type CrmInteractionsResponse,
  type CrmInteractionCreate,
  type CrmInteractionUpdate,
  type CrmInteractionResponse,
  type CrmInteractionDeleteResponse,
  type CrmInteractionManualType,
  CRM_INTERACTION_MANUAL_TYPES,
  type RecentFeedEntry,
  type RecentFeedResponse,
  type CrmIssue,
  type CrmIssueComment,
  type CrmIssueDetail,
  type CrmIssueDetailResponse,
  type CrmIssueEvent,
  type CrmIssueFacetsResponse,
  type CrmIssueLabel,
  type CrmIssueMilestone,
  type CrmIssueResponse,
  type CrmIssueState,
  type CrmIssueSubIssues,
  type CrmIssueUser,
  type CrmIssuesResponse,
  type CrmMyTask,
  type CrmMyWorkResponse,
  type CrmRecentlyClosedItem,
  type CrmRecentlyClosedKind,
  type CrmRecentlyClosedWorkResponse,
  type CrmReadFailure,
  type CrmReadFailureCause,
  type CrmUnownedSubject,
  type CrmUnownedWorkResponse,
  type CrmProjectRepoResponse,
  type CrmSubIssue,
  type CrmSubject,
  type CrmSubjectCountsResponse,
  type CrmSubjectDetail,
  type OrganizationRelationship,
  type CrmSubjectDetailResponse,
  type CrmSubjectKind,
  type CrmSubjectMutationResponse,
  type CrmRelatedRow,
  type CrmSubjectRelated,
  type CrmSubjectStatusCounts,
  type CrmSubjectsResponse,
  type CrmOrganizationFacets,
  type CrmContactFacets,
  type CrmContactOptionsResponse,
  CONTACT_LANGUAGES,
  type CrmTask,
  type CrmTaskDeleteResponse,
  type CrmOrganizationProjectTasksResponse,
  type CrmTaskResponse,
  type CrmTasksResponse,
  type CrmTeamMember,
  type CrmTeamResponse,
  type TaskCandidate,
  type TaskCandidatesResponse,
} from './crm';
export { acceptingKindAliases, crmSubjectKindSchema, readKindAlias } from './crm';

const crmOptionalUuidSchema = z.string().uuid().nullable().optional();
const crmNullableText = (max: number) => z.string().trim().max(max).nullable().optional();

/** A Core organization, kept small for the Work relationship picker. */
export const crmOrganizationOptionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
});
export type CrmOrganizationOption = z.infer<typeof crmOrganizationOptionSchema>;

/** Core organization search is typed and empty until the person enters a query. */
export const crmOrganizationsQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
});
export type CrmOrganizationsQuery = z.infer<typeof crmOrganizationsQuerySchema>;

export const crmOrganizationCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
});
export type CrmOrganizationCreate = z.infer<typeof crmOrganizationCreateSchema>;

/**
 * The organization columns a write may set, beyond its name. Each
 * is optional: only a field present changes, and null clears it. `url` is
 * Core's `website`.
 */
const crmOrganizationFieldsSchema = z.object({
  url: crmNullableText(2000),
  industry: crmNullableText(200),
  notes: crmNullableText(10000),
  legal_name: crmNullableText(300),
  address: crmNullableText(500),
  postcode: crmNullableText(40),
  city: crmNullableText(200),
  country: crmNullableText(100),
  vat_id: crmNullableText(100),
  tax_id: crmNullableText(100),
  size: crmNullableText(100),
  owner_id: crmOptionalUuidSchema,
  founded: crmNullableText(40),
  hq_location: crmNullableText(300),
  company_type: crmNullableText(100),
  linkedin_url: crmNullableText(2000),
  logo_url: crmNullableText(2000),
  logo_image_url: crmNullableText(2000),
  profile_image_url: crmNullableText(2000),
  entity: crmNullableText(200),
  domain: crmNullableText(300),
  is_agency: z.boolean().optional(),
  is_existing_client: z.boolean().optional(),
  is_partner: z.boolean().optional(),
});

/** `PATCH` on one organization: only what changes. A name is never blanked. */
export const crmOrganizationUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  ...crmOrganizationFieldsSchema.shape,
});
export type CrmOrganizationUpdate = z.infer<typeof crmOrganizationUpdateSchema>;

/**
 * `DELETE /api/crm/subjects/organization/:id`: refused with 409
 * while any record points at the organization, on Core and on D1.
 */
export const crmOrganizationDeleteResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
});
export type CrmOrganizationDeleteResponse = z.infer<typeof crmOrganizationDeleteResponseSchema>;

export const crmOrganizationsResponseSchema = z.object({
  organizations: z.array(crmOrganizationOptionSchema),
});
export type CrmOrganizationsResponse = z.infer<typeof crmOrganizationsResponseSchema>;

export const crmOrganizationResponseSchema = z.object({
  organization: crmOrganizationOptionSchema,
});
export type CrmOrganizationResponse = z.infer<typeof crmOrganizationResponseSchema>;

/**
 * A contact's addresses, the primary first. On D1 each address
 * belongs to one contact (`contact_emails`); Core keeps one, `email`.
 */
const crmContactEmailsSchema = z.array(z.string().trim().toLowerCase().email().max(254)).max(20);

/**
 * The contact columns a write may set beyond its name, title, organization and
 * addresses. Each is optional: only a field present changes, and
 * null clears it.
 */
const crmContactFieldsSchema = z.object({
  notes: crmNullableText(10000),
  linkedin_url: crmNullableText(2000),
  phone: crmNullableText(100),
  headline: crmNullableText(500),
  location: crmNullableText(300),
  connection_count: crmNullableText(40),
  country: crmNullableText(2),
  corporate_email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  profile_image_url: crmNullableText(2000),
  characteristics: z.record(z.string(), z.boolean()).nullable().optional(),
  preferred_language: z.string().trim().min(2).max(10).optional(),
  signals_outreach_status: crmNullableText(100),
  signals_notified_at: z.string().datetime({ offset: true }).nullable().optional(),
  birthday_month: z.number().int().min(1).max(12).nullable().optional(),
  birthday_day: z.number().int().min(1).max(31).nullable().optional(),
  birthday_year: z.number().int().min(1900).max(2100).nullable().optional(),
  futurist: z.boolean().optional(),
  corporate: z.boolean().optional(),
  academic: z.boolean().optional(),
  independent: z.boolean().optional(),
  government: z.boolean().optional(),
  ngo: z.boolean().optional(),
  media: z.boolean().optional(),
  intelligence: z.boolean().optional(),
});

/** `POST /api/crm/contacts`. Core calls the title `company_role`; the Worker renames it. */
export const crmContactCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  title: crmNullableText(200),
  organization_id: crmOptionalUuidSchema,
  emails: crmContactEmailsSchema.default([]),
  ...crmContactFieldsSchema.shape,
  /**
   * Where the contact came from (`contact_source_definitions`).
   * Absent is `crm_manual`. A member may name an active source an admin
   * marked selectable.
   */
  source_key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,79}$/u).optional(),
});
export type CrmContactCreate = z.infer<typeof crmContactCreateSchema>;

/** `PATCH /api/crm/contacts/:id`: only what changes. `emails` replaces the whole list. */
export const crmContactUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  title: crmNullableText(200),
  organization_id: crmOptionalUuidSchema,
  emails: crmContactEmailsSchema.optional(),
  ...crmContactFieldsSchema.shape,
});
export type CrmContactUpdate = z.infer<typeof crmContactUpdateSchema>;

/**
 * `DELETE /api/crm/contacts/:id`: refused with 409 while a call
 * or a task references the contact. Its leads and projects lose the link;
 * its addresses go with it.
 */
export const crmContactDeleteResponseSchema = z.object({
  id: z.string(),
  deleted: z.literal(true),
});
export type CrmContactDeleteResponse = z.infer<typeof crmContactDeleteResponseSchema>;

/** Core's lead pipeline, in its order. */
export const crmLeadStatusSchema = z.enum([
  'Conversations',
  'Opportunity Identified',
  'Proposal Out',
  'Active Negotiation',
  'Waiting on External Factor',
  'Closed Won',
  'Closed Lost',
]);
export type CrmLeadStatus = z.infer<typeof crmLeadStatusSchema>;
export const crmProjectStatusSchema = z.enum(['Active', 'Paused', 'Archived']);
export type CrmProjectStatus = z.infer<typeof crmProjectStatusSchema>;

/** Wire-compatible lead shape; the Worker requires organization_id on new creates. */
export const crmLeadCreateSchema = z.object({
  title: crmNullableText(100),
  organization_id: crmOptionalUuidSchema,
  contact_id: crmOptionalUuidSchema,
  status: crmLeadStatusSchema.optional(),
  start_date: z.string().trim().min(1).max(30),
  /** 10 000, as a contact's: Core's website form writes the whole request here. */
  notes: crmNullableText(10000),
  characteristics: z.record(z.string(), z.boolean()).nullable().optional(),
});

export const crmProjectCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: crmNullableText(2000),
  url: z.string().trim().url().nullable().optional(),
  specs: crmNullableText(2000),
  technical: crmNullableText(2000),
  research: crmNullableText(2000),
  design: crmNullableText(2000),
  contract: crmNullableText(5000),
  analytics: crmNullableText(5000),
  authentication: crmNullableText(5000),
  /** Optional: a project needs no organization. */
  organization_id: crmOptionalUuidSchema,
  lead_id: crmOptionalUuidSchema,
  license_id: crmOptionalUuidSchema,
  contact_ids: z.array(z.string().uuid()).default([]),
  evid: crmNullableText(100),
  start_date: z.string().trim().max(30).nullable().optional(),
  end_date: z.string().trim().max(30).nullable().optional(),
  status: crmProjectStatusSchema.optional(),
});

/** The client names the kind once; the Worker strips it before forwarding. */
export const crmLeadCreateRequestSchema = crmLeadCreateSchema.extend({ kind: z.literal('lead') });
export const crmProjectCreateRequestSchema = crmProjectCreateSchema.extend({ kind: z.literal('project') });
export const crmSubjectCreateSchema = z.discriminatedUnion('kind', [
  crmLeadCreateRequestSchema,
  crmProjectCreateRequestSchema,
]);

/**
 * The current Worker write rule, kept separate from the versioned wire shape.
 * A lead names its organization; a project may have none, on D1 and on Core
 * (MZ, 2026-10-07).
 */
export const crmSubjectCreateCommandSchema = crmSubjectCreateSchema.superRefine((input, ctx) => {
  if (input.kind === 'lead' && !input.organization_id) {
    ctx.addIssue({
      code: 'custom',
      path: ['organization_id'],
      message: 'Choose an organization before creating a lead.',
    });
  }
});

/**
 * Choose who is responsible for a project or lead, or null to clear
 * the choice. A person's address; the Worker refuses an agent's. Core and a D1
 * workspace stamp who chose and when from the signed actor.
 */
const responsibleChoiceSchema = z.string().trim().toLowerCase().email().max(254).nullable();

export const crmLeadUpdateSchema = crmLeadCreateSchema.partial().extend({ responsible_email: responsibleChoiceSchema.optional() });
/**
 * A PATCH names only what changes. `contact_ids` drops the create schema's
 * `.default([])`, which `.partial()` keeps: a title-only edit would otherwise
 * arrive with `contact_ids: []` and clear the project's contacts.
 */
export const crmProjectUpdateSchema = crmProjectCreateSchema
  .extend({ contact_ids: z.array(z.string().uuid()).optional() })
  .partial()
  .extend({
    responsible_email: responsibleChoiceSchema.optional(),
    /**
     * The workspace's own project, read back as `internal`. Core's column is
     * `projects.is_internal`; D1's is `projects.internal`. The Fields pane
     * writes it.
     */
    is_internal: z.boolean().optional(),
  });

/**
 * Win on a lead (ADR 0008): `POST /api/crm/subjects/lead/:id/win` starts a
 * project with the lead's organization, contact and title, moves the named
 * open tasks to it, then sets the lead to Closed Won. No title: the lead's.
 */
export const crmLeadWinSchema = z.object({
  title: crmNullableText(100),
  task_ids: z.array(z.string().uuid()).max(100).default([]),
});
export type CrmLeadWin = z.infer<typeof crmLeadWinSchema>;

/**
 * The project it started. `moved_task_ids` and `unmoved_task_ids` split the
 * tasks asked for; a task not open on the lead is unmoved. `lead_closed` is
 * false when the project exists but the lead's status change failed.
 */
export const crmLeadWinResponseSchema = z.object({
  project: crmSubjectDetailSchema,
  moved_task_ids: z.array(z.string()),
  unmoved_task_ids: z.array(z.string()),
  lead_closed: z.boolean(),
});
export type CrmLeadWinResponse = z.infer<typeof crmLeadWinResponseSchema>;

export const crmProjectRepoCreateSchema = z.object({
  project_id: z.string().uuid(),
  owner: z.string().trim().min(1).max(100),
  repo: z.string().trim().min(1).max(100),
  label: z.string().trim().max(100).nullable().optional(),
  milestone: z.string().trim().max(250).nullable().optional(),
  is_primary: z.boolean().optional(),
});

/** The client never sends `actor`: the Worker takes it from the session. */
export const crmIssueCreateSchema = z.object({
  project_id: z.string().uuid(),
  /** Promote this task rather than writing a fresh issue. */
  task_id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(250),
  body: z.string().max(20_000).optional(),
  /** An issue filed bare is one somebody opens GitHub to finish. */
  labels: z.array(z.string().trim().min(1).max(50)).max(10).optional(),
  assignees: z.array(z.string().trim().min(1).max(39)).max(10).optional(),
  milestone: z.number().int().positive().optional(),
});

export const crmIssueUpdateSchema = z.object({
  owner: z.string().trim().min(1).max(100),
  repo: z.string().trim().min(1).max(100),
  number: z.number().int().positive(),
  /**
   * The project whose channel should hear about a close or a reopen. Optional
   * because GitHub's issue does not know about ours, so only a client that was
   * already looking at a project can say — and a client that cannot simply
   * changes the issue without a line. The Worker checks the repository really
   * is linked to it before writing anything, rather than believing the body.
   */
  project_id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(250).optional(),
  body: z.string().max(20_000).optional(),
  state: crmIssueStateSchema.optional(),
  /** Only meaningful alongside `state: 'closed'`. */
  state_reason: z.enum(['completed', 'not_planned']).optional(),
  /**
   * Each of these is the whole set the issue should end up with, not an
   * addition — GitHub replaces on PATCH, and pretending otherwise would make
   * "take this label off" impossible to say.
   */
  labels: z.array(z.string().trim().min(1).max(50)).max(30).optional(),
  assignees: z.array(z.string().trim().min(1).max(39)).max(10).optional(),
  /** A milestone number, or null to take it off. */
  milestone: z.number().int().positive().nullable().optional(),
  comment: z.string().trim().min(1).max(20_000).optional(),
});

/** Parsed bodies, so the routes that report a write can name what they got. */
export type CrmIssueCreateInput = z.infer<typeof crmIssueCreateSchema>;
export type CrmIssueUpdateInput = z.infer<typeof crmIssueUpdateSchema>;

/** Your own username, and only your own. */
export const crmGithubLoginSchema = z.object({
  github_login: z.string().trim().max(39).nullable(),
});

/**
 * How a list may be narrowed and ordered. GitHub's own vocabulary, so the
 * Worker can forward it without translating, and a reader who knows GitHub
 * already knows what these do.
 */
export const CRM_ISSUE_SORTS = ['created', 'updated', 'comments'] as const;
export type CrmIssueSort = (typeof CRM_ISSUE_SORTS)[number];

export const crmIssueSortSchema = z.enum(CRM_ISSUE_SORTS);

// The CRM reads' query strings, as the Worker reads them after coercion. A
// uuid where Core wants one; `q` empty when absent; a bool is a stringbool.
const uuidQuery = z.string().uuid();

/**
 * `GET /api/crm/contacts`: by name, address, title or
 * organization name, on one organization, or by id. `ids` is
 * comma-separated: a picker naming the contacts a subject already carries.
 */
export const crmContactsQuerySchema = z.object({
  q: z.string().trim().max(200).default(''),
  organization_id: uuidQuery.optional(),
  ids: z.string().trim().max(4000).optional(),
  /**
   * Addresses, comma-separated: the contacts any of them belongs to, by any
   * of the contact's addresses (: who on a call is a contact).
   * At most 25 are read.
   */
  emails: z.string().trim().max(4000).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /**
   * The Contacts group's filters, as Core's contact list has
   * them. Country is the contact's ISO 3166 alpha-2 code. Partner and
   * existing client are the organization's flags, and narrow when `true`.
   */
  country: z.string().trim().length(2).optional(),
  partner: z.stringbool().optional().default(false),
  existing_client: z.stringbool().optional().default(false),
  signals_outreach_status: signalsOutreachStatusSchema.optional(),
  preferred_language: z.string().trim().min(2).max(10).optional(),
  /** `true` adds `facets` to the answer: the list asks once, a picker never. */
  facets: z.stringbool().optional().default(false),
});
export type CrmContactsQuery = z.infer<typeof crmContactsQuerySchema>;

/** The contact filters of `GET /api/crm/contacts`, as the Worker passes them to a store. */
export type CrmContactFilter = Partial<Pick<CrmContactsQuery, 'country' | 'partner' | 'existing_client' | 'signals_outreach_status' | 'preferred_language'>>;

/** `GET /api/crm/subjects?kind=&q=&status=&today=` (docs/WORK.md). */
export const crmSubjectsQuerySchema = z.object({
  kind: crmSubjectKindSchema,
  q: z.string().trim().max(200).default(''),
  status: z.string().trim().min(1).max(100).optional(),
  /**
   * Events only: the reader's day, so "open" is decided where they are
   * (docs/EVENTS.md). Anything that is not a day is ignored, not refused.
   */
  today: calendarDaySchema.optional().catch(undefined),
  /**
   * Organizations only: Core's organization list filters. Partner
   * is on unless the client says `false`, so a client that sends nothing
   * still lists the partners. Agency and existing client narrow when `true`.
   * Industry and country match one value exactly.
   */
  partner: z.stringbool().optional().default(true),
  agency: z.stringbool().optional().default(false),
  existing_client: z.stringbool().optional().default(false),
  industry: z.string().trim().min(1).max(200).optional(),
  country: z.string().trim().min(1).max(200).optional(),
  /** Leads only: where the lead came from. `signals` is a prospect for the Signals product. */
  source: z.string().trim().min(1).max(100).optional(),
});
export type CrmSubjectsQuery = z.infer<typeof crmSubjectsQuerySchema>;

/** The organization filters of `GET /api/crm/subjects`, as the Worker passes them to a store. */
export type CrmOrganizationFilter = Partial<Pick<CrmSubjectsQuery, 'partner' | 'agency' | 'existing_client' | 'industry' | 'country'>>;

/** `GET /api/crm/subject-counts?kind=&q=`: partners have no status, so the kind is the two that do. */
export const crmSubjectCountsQuerySchema = z.object({
  kind: z.enum(['lead', 'project']),
  q: z.string().trim().max(200).default(''),
});

/** `GET /api/crm/github-repos?q=`. */
export const crmGithubReposQuerySchema = z.object({
  q: z.string().trim().max(200).default(''),
});

/** `GET /api/crm/project-repos?project_id=` and `GET /api/crm/pulls?project_id=`. */
export const crmProjectQuerySchema = z.object({
  project_id: uuidQuery,
});

/** `GET /api/crm/issue-facets?owner=&repo=`: a repository by its GitHub address. */
export const crmRepoQuerySchema = z.object({
  owner: z.string().trim().min(1).max(100),
  repo: z.string().trim().min(1).max(100),
});

/** `GET /api/crm/issue?owner=&repo=&number=`: one issue. */
export const crmIssueRefQuerySchema = crmRepoQuerySchema.extend({
  number: z.coerce.number().int().positive(),
});

/** `GET /api/crm/interactions`: exactly one subject, newest first. */
export const crmInteractionsQuerySchema = z.object({
  project_id: uuidQuery.optional(),
  lead_id: uuidQuery.optional(),
  organization_id: uuidQuery.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).refine((value) => [value.project_id, value.lead_id, value.organization_id].filter(Boolean).length === 1, {
  message: 'Provide exactly one of project_id, lead_id or organization_id.',
});

/**
 * `GET /api/crm/tasks`: exactly one of the five places a task can be
 * (and a partner's own work). `organization_id` is a
 * partner's CRM organization.
 */
export const crmTasksQuerySchema = z.object({
  project_id: uuidQuery.optional(),
  lead_id: uuidQuery.optional(),
  event_id: uuidQuery.optional(),
  organization_id: uuidQuery.optional(),
  meeting_id: uuidQuery.optional(),
  /** A Signals account's open tasks. */
  signals_account_id: uuidQuery.optional(),
}).refine((value) => [value.project_id, value.lead_id, value.event_id, value.organization_id, value.meeting_id, value.signals_account_id].filter(Boolean).length === 1, {
  message: 'Provide exactly one of project_id, lead_id, event_id, organization_id, meeting_id or signals_account_id.',
});

/** `GET /api/crm/my-work?assignee_email=`: one colleague's open work. */
export const crmMyWorkQuerySchema = z.object({
  assignee_email: emailSchema,
});

/** `GET /api/crm/goals?project_id=&include_closed=`. */
export const crmGoalsQuerySchema = z.object({
  project_id: uuidQuery,
  include_closed: z.stringbool().optional().default(false),
});

/** `GET /api/crm/decisions?subject_kind=&subject_id=`. */
export const crmDecisionsQuerySchema = z.object({
  subject_kind: crmSubjectKindSchema,
  subject_id: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** `GET /api/crm/sales-inbox`: the untriaged touches, dismissed ones on request. */
export const salesInboxQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  include_dismissed: z.stringbool().optional().default(false),
});

/** What `GET /api/crm/issues` takes, as the Worker reads the query string. */
export const crmIssueQuerySchema = z.object({
  project_id: z.string(),
  state: z.enum(['open', 'closed', 'all']).optional(),
  labels: z.string().optional(),
  assignee: z.string().optional(),
  milestone: z.string().optional(),
  creator: z.string().optional(),
  sort: crmIssueSortSchema.optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  limit: z.number().int().optional(),
  page: z.number().int().optional(),
});
export type CrmIssueQuery = z.infer<typeof crmIssueQuerySchema>;


/**
 * POST /api/core/token — a Core personal access token for the signed-in
 * owner, so the client can read Core's registry directly (`/api/agent/*` on
 * `the Core host`) instead of through the Worker's hand-built
 * projections. The Worker only brokers: it proves the owner to Core with the
 * shared HMAC secret and hands the token straight back, never storing it.
 * See docs/CORE_REGISTRY.md.
 */
export const coreTokenRequestSchema = z.object({
  /** Shown in Core's token list as `Meet — <device_name>`; one token per name. */
  device_name: z.string().trim().max(60).optional(),
});
export type CoreTokenRequest = z.infer<typeof coreTokenRequestSchema>;

/**
 * A CMS write through `/api/cms/<entity>` (POST) or `/api/cms/<entity>/<id>`
 * (PATCH): a flat object of column values. Core's registry-derived schema
 * decides which keys and types are valid; this only bounds the shape and size
 * before the Worker forwards it. Nested objects and arrays are not CMS columns.
 */
export const cmsWriteBodySchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    // A string list is an `emails` field, such as an event's `host_emails`.
    z.union([z.string().max(200_000), z.number(), z.boolean(), z.null(), z.array(z.string().max(320)).max(50)]),
  )
  .refine((value) => Object.keys(value).length > 0, { message: 'A CMS write needs at least one field.' })
  .refine((value) => Object.keys(value).length <= 64, { message: 'Too many fields.' });
export type CmsWriteBody = z.infer<typeof cmsWriteBodySchema>;

/**
 * An event's cover image, through `POST /api/cms/events/<id>/image` → Core
 * `/api/agent/cms/events/:id/image` (docs/EVENTS_AGENT.md §Images). Either a
 * look id and one line of scene, never a prompt: Core composes the prompt
 * from the styleguide and the look's text, and owns the list of looks, so
 * this bounds the shape and lets Core refuse an unknown look. Or
 * `from_event_id`: Core copies that event's `image_url`, with no model call.
 */
export const cmsEventImageRequestSchema = z.union([
  z.object({
    look: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/u),
    scene: z.string().trim().min(3).max(300),
  }).strict(),
  z.object({ from_event_id: z.string().uuid() }).strict(),
]);
export type CmsEventImageRequest = z.infer<typeof cmsEventImageRequestSchema>;

/** Hub-owned technology style; request_id identifies one paid generation. */
export const cmsTechnologyImageRequestSchema = z.object({ request_id: z.string().uuid() }).strict();
export type CmsTechnologyImageRequest = z.infer<typeof cmsTechnologyImageRequestSchema>;

export const coreTokenResponseSchema = z.object({
  token: z.string(),
  scopes: z.array(z.string()),
  /** ISO 8601. */
  expires_at: z.string(),
  email: z.string(),
});
export type CoreTokenResponse = z.infer<typeof coreTokenResponseSchema>;

/**
 * Retired with `POST /api/docs/token`: the apps reach Docs through
 * `/api/docs-service` on the owner session. The shape stays registered so
 * the wire stays compatible with builds that still name it.
 */
export const docsTokenRequestSchema = z.object({
  device_name: z.string().trim().max(60).optional(),
});
export type DocsTokenRequest = z.infer<typeof docsTokenRequestSchema>;

/** `POST /api/keep/token`: same arrangement as Docs, against Keep. */
export const keepTokenRequestSchema = z.object({
  /** Shown in Keep's device list; one live token per name. */
  device_name: z.string().trim().max(60).optional(),
});
export type KeepTokenRequest = z.infer<typeof keepTokenRequestSchema>;

export const keepTokenResponseSchema = z.object({
  token: z.string(),
  expires_at: z.string(),
  email: z.string(),
  /**
   * The Keep the token is for: this workspace's own. The device
   * talks to this origin, not to a host compiled into the app. Optional on
   * the wire: a Worker from before does not send it.
   */
  origin: z.string().optional(),
});
export type KeepTokenResponse = z.infer<typeof keepTokenResponseSchema>;

/**
 * The Docs wire shapes the Worker passes through to the browser, snake case
 * as Docs sends them (`envisioning/docs` `packages/contracts`). The Worker
 * proxies rather than the browser calling Docs itself: Docs answers no CORS
 * preflight for Meet's origin, and a Docs token in a tab is a token in a
 * tab. The native apps hold their own token and use `DocsKit` instead.
 * Match the server; never invent a field. See docs/DOCS.md.
 */
/**
 * A category: what a document *is*. Data a workspace owns, not code
 * (envisioning/docs migration 0008): a new install has none, and its people
 * add, rename, reorder and delete them, in Docs and here. `id` is a slug
 * fixed at creation; a rename changes `label` only, so `?category=<id>` and
 * `view=category:<id>` survive it. Deleting one leaves its documents
 * uncategorized. Labels come from Docs (`GET /api/categories`, or the
 * summary); no client keeps a list of its own.
 */
export type DocsCategory = string;
/** A category id's shape, as Docs fixes it: a list filter and a category route check it before Docs is asked. */
export const docsCategoryIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/u, 'A category id is a lower-case slug.');

/** One row of `GET /api/categories`, in rail order. `count` is the active documents the reader can see. */
export const docsCategoryRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  position: z.number().int(),
  count: z.number().int(),
});
export type DocsCategoryRow = z.infer<typeof docsCategoryRowSchema>;

/** `GET /api/docs/categories`, and the answer to a reorder. */
export const docsCategoriesResponseSchema = z.object({
  categories: z.array(docsCategoryRowSchema),
});
export type DocsCategoriesResponse = z.infer<typeof docsCategoriesResponseSchema>;

/** `POST /api/docs/categories`. Docs makes the id from the label; a clash is a 409. */
export const docsCategoryCreateSchema = z.object({
  label: z.string().trim().min(1).max(80),
  id: docsCategoryIdSchema.optional(),
});
export type DocsCategoryCreateInput = z.infer<typeof docsCategoryCreateSchema>;

/** `PATCH /api/docs/categories/:id`: rename or move. The id never changes. */
export const docsCategoryUpdateSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  position: z.number().int().min(0).max(10_000).optional(),
}).refine((value) => value.label !== undefined || value.position !== undefined, 'Nothing to change.');
export type DocsCategoryUpdateInput = z.infer<typeof docsCategoryUpdateSchema>;

/** `PUT /api/docs/categories/order`: every id, in the order the rail shows them. */
export const docsCategoryOrderSchema = z.object({
  ids: z.array(docsCategoryIdSchema).max(500),
});
export type DocsCategoryOrderInput = z.infer<typeof docsCategoryOrderSchema>;


/**
 * The FOLDERS rows of every Docs rail (docs/DOCS.md, "The rail"):
 * one per top-level folder in the summary, counts including subfolders.
 * `/work` and `/published` are left out because WORK and LIBRARY reach
 * them. An empty folder shows only when it can take a move. Mirrors
 * `DocsRailGroups.folders` in the Swift apps.
 */
export const DOCS_RAIL_FOLDERS_LEFT_OUT: readonly string[] = ['/work', '/published'];
export function docsRailFolders<F extends { path: string; count: number }>(
  folders: readonly F[],
  moveTargetPaths: readonly string[],
): F[] {
  const targets = new Set(moveTargetPaths);
  return folders.filter((folder) => !DOCS_RAIL_FOLDERS_LEFT_OUT.includes(folder.path) && (folder.count > 0 || targets.has(folder.path)));
}

/** What a document is *about* — a CRM subject — as opposed to where it lives. */
export const docsSubjectRefSchema = z.object({
  system: z.string(),
  kind: z.string(),
  subject_id: z.string(),
});
export type DocsSubject = z.infer<typeof docsSubjectRefSchema>;

export const docsSourceSystemSchema = z.enum(DOCS_SOURCE_SYSTEMS);
export const docsDocumentKindSchema = z.enum(['markdown', 'pdf']);
export const docsVisibilitySchema = z.enum(['internal', 'link', 'public']);
export const docsDocumentStatusSchema = z.enum(['active', 'archived', 'deleted']);

/**
 * A link save: a native document with `source_kind = 'link'`. The
 * body is the person's notes; this is what the page said about itself.
 * `has_image` means `GET /api/docs/:id/link-image` on Docs answers with the
 * copy Docs keeps. Mirrors `LinkSave` in envisioning/docs and `DocsLinkSave`
 * in DocsKit.
 */
export const DOCS_LINK_SOURCE_KIND = 'link';
/** Where Docs files a save when nobody names a folder. */
export const DOCS_LINK_FOLDER = '/work/links';
/**
 * A page as its reader's browser drew it (the bookmarklet's `/save`): the
 * Worker reads the article from this instead of fetching the URL, so a page
 * behind a sign-in or a subscription saves whole. The browser strips scripts
 * and styles first; this is what is left of a long page.
 */
export const DOCS_PAGE_HTML_MAX_CHARS = 2_000_000;
/** `POST /api/docs/documents` reads up to this: the page above, in UTF-8, plus the rest. */
export const DOCS_CREATE_BODY_MAX_BYTES = 4 * 1024 * 1024;
export const docsLinkSaveSchema = z.object({
  url: z.string(),
  canonical_url: z.string(),
  site_name: z.string().nullable(),
  description: z.string().nullable(),
  has_image: z.boolean(),
  /** Screenshots the person attached (slice 2). Absent from an older Docs. */
  image_count: z.number().int().optional(),
  /** The first of them: a card's cover when the page gave none. */
  first_image_id: z.string().nullable().optional(),
  fetch_status: z.enum(['ok', 'failed', 'skipped']),
  fetch_error: z.string().nullable(),
  fetched_at: z.string().nullable(),
});
export type DocsLinkSave = z.infer<typeof docsLinkSaveSchema>;

/** An http(s) URL a person or an agent asks Docs to save. Docs guards the fetch. */
export const docsLinkURLSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((value) => /^https?:\/\/[^\s]+$/iu.test(value), 'Only an http or https link can be saved.');

export const docsDocumentSummarySchema = z.object({
  id: z.string(),
  path: z.string(),
  slug: z.string(),
  title: z.string(),
  kind: docsDocumentKindSchema,
  folder_id: z.string().nullable(),
  visibility: docsVisibilitySchema,
  /**
   * Readable by its author only: a link save no subject files yet
   *. Filing it or sharing it makes it the workspace's. Optional
   * because a Docs deploy older than migration 0007 does not send it.
   */
  private: z.boolean().optional(),
  status: docsDocumentStatusSchema,
  source_system: docsSourceSystemSchema,
  source_kind: z.string().nullable(),
  source_url: z.string().nullable(),
  editable: z.boolean(),
  version: z.number().int(),
  byte_size: z.number().int(),
  content_hash: z.string(),
  tags: z.array(z.string()),
  /** A category id, or null. Any string: the list is the workspace's. */
  category: z.string().nullable(),
  /**
   * Staff-only whatever else is true of it: a meeting transcript. Not a
   * category since Docs made categories data. Absent from an older Docs,
   * which said so with `category: 'transcript'` alone.
   */
  transcript: z.boolean().optional().default(false),
  subjects: z.array(docsSubjectRefSchema),
  created_at: z.string(),
  updated_at: z.string(),
  /**
   * When the words are from: `frontmatter.date`, else `created_at`
   *. An import stamps `created_at` with the day it ran.
   * Absent from a Docs older than the field.
   */
  written_at: z.string().optional(),
  updated_by: z.string().nullable(),
  excerpt: z.string().optional(),
  /** Only on a link save. */
  link: docsLinkSaveSchema.optional(),
});
export type DocsDocumentSummary = z.infer<typeof docsDocumentSummarySchema>;

export const docsDocumentDetailSchema = docsDocumentSummarySchema.extend({
  body_md: z.string().nullable(),
  links: z.array(z.object({ target: z.string(), to_id: z.string().nullable(), to_path: z.string().nullable() })),
  backlinks: z.array(z.object({ id: z.string(), path: z.string(), title: z.string() })),
  open_annotations: z.number().int(),
  /** Images a person attached, oldest first ( slice 2). Bytes are on Docs. */
  images: z.array(z.object({
    id: z.string(),
    content_type: z.string(),
    byte_size: z.number().int(),
    caption: z.string().nullable(),
    created_by: z.string(),
    created_at: z.string(),
  })).optional(),
});
export type DocsDocumentDetail = z.infer<typeof docsDocumentDetailSchema>;

export const docsFolderSchema = z.object({
  id: z.string(),
  path: z.string(),
  slug: z.string(),
  title: z.string(),
  parent_id: z.string().nullable(),
  depth: z.number().int(),
  icon: z.string().nullable(),
  description: z.string().nullable(),
  source_key: z.string().nullable(),
  document_count: z.number().int().optional(),
});
export type DocsFolder = z.infer<typeof docsFolderSchema>;

export const docsSearchHitSchema = z.object({
  id: z.string(),
  path: z.string(),
  title: z.string(),
  kind: docsDocumentKindSchema,
  source_system: docsSourceSystemSchema,
  source_kind: z.string().nullable(),
  snippet: z.string(),
  updated_at: z.string(),
});
export type DocsSearchHit = z.infer<typeof docsSearchHitSchema>;

/** `GET /api/docs/summary` — one request for a rail: Views with counts. */
export const docsSummaryResponseSchema = z.object({
  /** Every category in rail order, an empty one too, labelled from the workspace's own rows. */
  categories: z.array(z.object({ category: z.string(), label: z.string(), count: z.number().int() })),
  by_source: z.array(z.object({ source: docsSourceSystemSchema, category: z.string(), label: z.string(), count: z.number().int() })).optional(),
  folders: z.array(z.object({ path: z.string(), title: z.string(), count: z.number().int() })),
  /** Active link saves. They carry no category, so no row above counts them. */
  links: z.number().int().optional(),
  /** Active documents nobody filed; absent from an older Docs. */
  unfiled: z.number().int().optional(),
  total: z.number().int(),
});
export type DocsSummaryResponse = z.infer<typeof docsSummaryResponseSchema>;

/** `GET /api/docs/tree` — every folder, flat, with `parent_id` and `depth`. */
export const docsTreeResponseSchema = z.object({
  folders: z.array(docsFolderSchema),
});
export type DocsTreeResponse = z.infer<typeof docsTreeResponseSchema>;

/**
 * `GET /api/docs/documents` — one list. Newest first with no filter (Recent);
 * `category`, `prefix` (a folder and everything under it), `folder` (that
 * folder only) and `subject` (`core:<kind>:<id>`) narrow it, one at a time
 * or together, as Docs' own list query does.
 */
export const docsListQuerySchema = z.object({
  category: docsCategoryIdSchema.optional(),
  /**
   * `native` is what Meet wrote; `core` the mirror of Core's published
   * writing; a comma list (`core,obsidian`) is any of them — a rail's LIBRARY
   * half in one request. Passed to Docs as is.
   */
  source: z.string().regex(/^(native|core|obsidian)(,(native|core|obsidian))*$/u).optional(),
  prefix: z.string().trim().min(1).max(400).optional(),
  folder: z.string().trim().min(1).max(400).optional(),
  subject: z.string().trim().regex(/^[a-z]+:[a-z]+:[^:]+$/u).optional(),
  /** `link`: link saves only. They have no category to filter on. */
  source_kind: z.literal(DOCS_LINK_SOURCE_KIND).optional(),
  /** Only documents with an open comment thread — INBOX's read. */
  open_annotations: z.stringbool().optional(),
  /**
   * Only documents nobody filed: native, not a link save, no
   * category, no subject, directly in `/` or `/work`.
   */
  unfiled: z.stringbool().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  /** Docs pages by offset and answers `total`, so a caller can read every page. */
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});
export type DocsListQuery = z.infer<typeof docsListQuerySchema>;

export const docsDocumentsResponseSchema = z.object({
  documents: z.array(docsDocumentSummarySchema),
  total: z.number().int(),
});
export type DocsDocumentsResponse = z.infer<typeof docsDocumentsResponseSchema>;

/** `GET /api/docs/search?q=` — full text, Docs' FTS5. */
export const docsSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(400),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const docsSearchResponseSchema = z.object({
  hits: z.array(docsSearchHitSchema),
});
export type DocsSearchResponse = z.infer<typeof docsSearchResponseSchema>;

/** `GET /api/docs/documents/:id` — the body, links and backlinks. */
export const docsDocumentResponseSchema = z.object({
  document: docsDocumentDetailSchema,
});
export type DocsDocumentResponse = z.infer<typeof docsDocumentResponseSchema>;

/**
 * One subject on the wire, as Docs takes it (`PUT /api/docs/:id/subjects`, `subjects` on create).
 * Docs' own subject table holds these kinds and no other: an event is not one,
 * so no client offers Documents on an event (`subject-panes`).
 */
export const DOCS_SUBJECT_KINDS = ['organization', 'contact', 'offer', 'lead', 'project'] as const;
export type DocsSubjectKind = (typeof DOCS_SUBJECT_KINDS)[number];
export const docsSubjectSchema = z.object({
  system: z.string().trim().min(1).max(40).default('core'),
  kind: z.enum(DOCS_SUBJECT_KINDS),
  subject_id: z.string().trim().min(1).max(80),
});

/** `POST /api/docs/documents` — a new document, from a Quick Note, the Docs page or a subject in Work. */
/**
 * The frontmatter contract for a curated document (docs/DOCS.md §Knowledge
 * model). Docs stores any keys; these are the ones every reader relies on:
 * `date` is when it was written, `status` says whether it still governs.
 */
export const DOCS_STATUSES = ['current', 'dated', 'superseded', 'draft'] as const;
export type DocsFrontmatterStatus = (typeof DOCS_STATUSES)[number];
export const docsFrontmatterSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'date is YYYY-MM-DD').optional(),
  status: z.enum(DOCS_STATUSES).optional(),
  owner: z.string().trim().min(1).max(80).optional(),
  reviewed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'reviewed is YYYY-MM-DD').optional(),
  supersedes: z.string().trim().min(1).max(300).optional(),
  superseded_by: z.string().trim().min(1).max(300).optional(),
  source: z.string().trim().min(1).max(500).optional(),
}).catchall(z.unknown());
export type DocsFrontmatter = z.infer<typeof docsFrontmatterSchema>;

export const docsTagsSchema = z.array(z.string().trim().min(1).max(80)).max(64);
/**
 * With `url` it is a link save: Docs reads the page, the title
 * defaults to the page's, the folder to `DOCS_LINK_FOLDER`, and `body_md` is
 * the person's notes. Without `url`, `title` is required.
 */
export const docsCreateDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  url: docsLinkURLSchema.optional(),
  /** With `url` only: the page as the person's browser drew it (`DOCS_PAGE_HTML_MAX_CHARS`). */
  page_html: z.string().max(DOCS_PAGE_HTML_MAX_CHARS).optional(),
  body_md: z.string().max(200_000).default(''),
  /** Defaults to `/work`, where Meet files what it writes. */
  folder_path: z.string().trim().min(1).max(200).optional(),
  /** One of the workspace's category ids. Docs refuses one it does not have (400); that is the check. */
  category: z.string().optional(),
  subjects: z.array(docsSubjectSchema).max(32).optional(),
  frontmatter: docsFrontmatterSchema.optional(),
  tags: docsTagsSchema.optional(),
  visibility: docsVisibilitySchema.optional(),
  message: z.string().trim().max(200).optional(),
}).superRefine((value, context) => {
  if (!value.url && !value.title) context.addIssue({ code: 'custom', path: ['title'], message: 'A new document needs a title.' });
  if (value.page_html !== undefined && !value.url) context.addIssue({ code: 'custom', path: ['page_html'], message: 'A page needs its url.' });
  if (value.url && value.category) context.addIssue({ code: 'custom', path: ['category'], message: 'A link save has no category.' });
  if (value.url && value.visibility && value.visibility !== 'internal') {
    context.addIssue({ code: 'custom', path: ['visibility'], message: 'A link save is internal.' });
  }
});

/** `PUT /api/docs/documents/:id/subjects` — replace-all, small lists (docs/DOCS.md decision 5). */
export const docsSetSubjectsSchema = z.object({
  subjects: z.array(docsSubjectSchema).max(32),
});
export type DocsSetSubjectsInput = z.infer<typeof docsSetSubjectsSchema>;

/** `POST /api/docs/documents/:id/move` — into another folder; the subject link is untouched. */
export const docsMoveDocumentSchema = z.object({
  folder_path: z.string().trim().min(1).max(400),
});
export type DocsMoveDocumentInput = z.infer<typeof docsMoveDocumentSchema>;

/**
 * Comments on a document are Docs **annotations**: a passage
 * anchor (the quote re-anchors after edits; `orphaned` when it is gone),
 * a thread with replies, open or resolved. Members only through Meet.
 */
export const docsTextAnchorSchema = z.object({
  type: z.literal('text'),
  quote: z.string().min(1).max(2000),
  prefix: z.string().max(200).optional(),
  suffix: z.string().max(200).optional(),
});
export type DocsTextAnchor = z.infer<typeof docsTextAnchorSchema>;

export const docsPdfAnchorSchema = z.object({
  type: z.literal('pdf'),
  page: z.number().int(),
  rects: z.array(z.array(z.number())),
  quote: z.string().optional(),
});
export const docsAnnotationAnchorSchema = z.union([docsTextAnchorSchema, docsPdfAnchorSchema]);

export const docsAnnotationSchema = z.object({
  id: z.string(),
  document_id: z.string(),
  document_version: z.number().int(),
  thread_id: z.string(),
  parent_id: z.string().nullable(),
  author: z.string(),
  author_name: z.string().nullable(),
  author_kind: z.enum(['staff', 'guest', 'agent']),
  body_md: z.string(),
  anchor: docsAnnotationAnchorSchema.nullable(),
  status: z.enum(['open', 'resolved']),
  resolved_by: z.string().nullable(),
  resolved_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  /** True when the anchor quote no longer appears in the current body. */
  orphaned: z.boolean().optional(),
});
export type DocsAnnotation = z.infer<typeof docsAnnotationSchema>;

/** `POST /api/docs/documents/:id/annotations` — a new thread on a passage, or a reply. */
export const docsAnnotationCreateSchema = z.object({
  body_md: z.string().trim().min(1).max(16_000),
  anchor: docsTextAnchorSchema.optional(),
  parent_id: z.string().uuid().optional(),
});
export type DocsAnnotationCreateInput = z.infer<typeof docsAnnotationCreateSchema>;

/** `PATCH /api/docs/annotations/:id` — edit the body, or resolve / reopen. */
export const docsAnnotationUpdateSchema = z.object({
  body_md: z.string().trim().min(1).max(16_000).optional(),
  status: z.enum(['open', 'resolved']).optional(),
});
export type DocsAnnotationUpdateInput = z.infer<typeof docsAnnotationUpdateSchema>;

export const docsAnnotationsResponseSchema = z.object({
  annotations: z.array(docsAnnotationSchema),
});
export type DocsAnnotationsResponse = z.infer<typeof docsAnnotationsResponseSchema>;

export const docsAnnotationResponseSchema = z.object({
  annotation: docsAnnotationSchema,
});
export type DocsAnnotationResponse = z.infer<typeof docsAnnotationResponseSchema>;

/**
 * Where a document lives as a shareable address: the Docs SPA, the same
 * link the Mac's Copy link puts on the pasteboard (`DocsClient.productionURL`
 * in core-kit — keep the two in step).
 */
import { DOCS_PUBLIC_ORIGIN } from './deployment-values.ts';

export { DOCS_PUBLIC_ORIGIN };
export function docsDocumentURL(path: string): string {
  return `${DOCS_PUBLIC_ORIGIN}/doc${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Where a document shared by link is read outside the company: the
 * email-gated reader on the organisation's site. The Docs repo owns this address
 * (`wwwShareURL` in its `packages/contracts`); change it there first.
 */
export function docsShareURL(documentId: string): string {
  return `${ORG_WWW_ORIGIN}/private/docs/${encodeURIComponent(documentId)}`;
}
export type DocsCreateDocumentInput = z.infer<typeof docsCreateDocumentSchema>;

export const docsCreateDocumentResponseSchema = z.object({
  document: docsDocumentDetailSchema,
});
export type DocsCreateDocumentResponse = z.infer<typeof docsCreateDocumentResponseSchema>;

/**
 * `PATCH /api/docs/documents/:id`. `if_content_hash` is the hash the client
 * read; Docs answers `hash_mismatch` (409) when the body moved underneath it,
 * and the client shows both rather than overwriting. `category: null` clears
 * it; absent leaves it. `status: 'archived'` is how a document is archived.
 */
export const docsUpdateDocumentSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body_md: z.string().max(200_000).optional(),
  /** A category id, as on create; Docs refuses one it does not have. */
  category: z.string().nullable().optional(),
  status: z.enum(['active', 'archived']).optional(),
  /** Replaces the whole frontmatter; Docs re-applies the subjects projection itself. */
  frontmatter: docsFrontmatterSchema.optional(),
  /** Replaces the tag list. */
  tags: docsTagsSchema.optional(),
  visibility: docsVisibilitySchema.optional(),
  message: z.string().trim().max(200).optional(),
  if_content_hash: z.string().length(64).optional(),
});
export type DocsUpdateDocumentInput = z.infer<typeof docsUpdateDocumentSchema>;

// ---- sharing and signing -------------------------------
// The staff actions Docs web had, served to Meet's /docs through the Worker.
// Each shape follows one in envisioning/docs `packages/contracts` (GrantSummary,
// SignatureRequestDetail, the access log's row). A field Docs adds later is
// dropped here, not refused; a status this build never saw reads as itself.

/** Who a share link lets in, and what they may do. `signer` links come from a signature request. */
export const docsGrantRoleSchema = z.enum(['viewer', 'commenter', 'signer']);
export type DocsGrantRole = z.infer<typeof docsGrantRoleSchema>;

/** One share link (Docs' `GrantSummary`). `url` is the link on the Docs host. */
export const docsGrantSchema = z.object({
  id: z.string(),
  document_id: z.string().nullable().optional(),
  folder_id: z.string().nullable().optional(),
  url: z.string(),
  /** Null: anyone holding the link. */
  email: z.string().nullable(),
  role: z.string(),
  label: z.string().nullable().optional(),
  require_verification: z.boolean().optional(),
  created_by: z.string().optional(),
  created_at: z.string(),
  expires_at: z.string().nullable().optional(),
  revoked_at: z.string().nullable().optional(),
  last_used_at: z.string().nullable().optional(),
  use_count: z.number().int().default(0),
});
export type DocsGrant = z.infer<typeof docsGrantSchema>;

/** `GET /api/docs/documents/:id/grants`. */
export const docsGrantsResponseSchema = z.object({
  grants: z.array(docsGrantSchema),
});
export type DocsGrantsResponse = z.infer<typeof docsGrantsResponseSchema>;

/** `POST /api/docs/documents/:id/grants`. No email: anyone with the link, asked for an email at the door. */
export const docsGrantCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320).optional(),
  role: docsGrantRoleSchema.default('viewer'),
  label: z.string().trim().max(200).optional(),
  expires_in_days: z.number().int().min(1).max(3650).optional(),
  /** Share the folder the document is in, not the document alone. */
  folder: z.boolean().optional(),
});
export type DocsGrantCreateInput = z.infer<typeof docsGrantCreateSchema>;

/** `POST /api/docs/documents/:id/grants` answers the new link. */
export const docsGrantResponseSchema = z.object({
  grant: docsGrantSchema,
});
export type DocsGrantResponse = z.infer<typeof docsGrantResponseSchema>;

/**
 * One row of a document's access log: a view, a download, a comment, a
 * signature. The visitor's IP stays on Docs; Meet does not carry it.
 */
export const docsAccessEventSchema = z.object({
  id: z.string(),
  actor: z.string().nullable(),
  actor_kind: z.string(),
  kind: z.string(),
  referrer: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  created_at: z.string(),
});
export type DocsAccessEvent = z.infer<typeof docsAccessEventSchema>;

/** `GET /api/docs/documents/:id/access-events`, newest first. */
export const docsAccessEventsResponseSchema = z.object({
  events: z.array(docsAccessEventSchema),
});
export type DocsAccessEventsResponse = z.infer<typeof docsAccessEventsResponseSchema>;

/** One person on a signature request. `url` is their own signing link. */
export const docsSignaturePartySchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable().optional(),
  /** `signer`, `approver` or `cc`. */
  role: z.string(),
  sequence: z.number().int().default(0),
  /** `pending`, `viewed`, `signed` or `declined`. */
  status: z.string(),
  signed_at: z.string().nullable().optional(),
  url: z.string().optional(),
});
export type DocsSignatureParty = z.infer<typeof docsSignaturePartySchema>;

/** A signature request (Docs' `SignatureRequestDetail`), without the sealed signature records. */
export const docsSignatureRequestSchema = z.object({
  id: z.string(),
  document_id: z.string(),
  document_version: z.number().int().optional(),
  content_hash: z.string().optional(),
  requested_by: z.string().optional(),
  subject: z.string().nullable(),
  message: z.string().nullable().optional(),
  ordered: z.boolean(),
  /** `pending`, `completed`, `declined`, `cancelled` or `expired`. */
  status: z.string(),
  created_at: z.string(),
  expires_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  parties: z.array(docsSignaturePartySchema),
  /**
   * The audit certificate on this workspace's Docs app (`/certificate/<id>`).
   * Meet's Worker adds it; Docs does not send it. Null when this workspace
   * has no Docs origin.
   */
  certificate_url: z.string().nullable().optional(),
});
export type DocsSignatureRequest = z.infer<typeof docsSignatureRequestSchema>;

/** `GET /api/docs/documents/:id/signature-requests`, newest first. */
export const docsSignatureRequestsResponseSchema = z.object({
  requests: z.array(docsSignatureRequestSchema),
});
export type DocsSignatureRequestsResponse = z.infer<typeof docsSignatureRequestsResponseSchema>;

/**
 * `POST /api/docs/documents/:id/signature-requests`. Docs mails each signer
 * their own link; with `ordered`, each after the one before has signed, by
 * `sequence`.
 */
export const docsSignatureRequestCreateSchema = z.object({
  subject: z.string().trim().max(300).optional(),
  message: z.string().trim().max(4000).optional(),
  ordered: z.boolean().default(false),
  expires_in_days: z.number().int().min(1).max(365).optional(),
  parties: z.array(z.object({
    email: z.string().trim().toLowerCase().email().max(320),
    name: z.string().trim().max(200).optional(),
    role: z.enum(['signer', 'approver', 'cc']).optional(),
    sequence: z.number().int().min(0).max(50).optional(),
  })).min(1).max(25),
});
export type DocsSignatureRequestCreateInput = z.infer<typeof docsSignatureRequestCreateSchema>;

/** `POST /api/docs/documents/:id/signature-requests` answers the new request. */
export const docsSignatureRequestResponseSchema = z.object({
  request: docsSignatureRequestSchema,
});
export type DocsSignatureRequestResponse = z.infer<typeof docsSignatureRequestResponseSchema>;

/**
 * `GET /api/docs/health`: the Core surfaces Docs' hourly sync is not
 * keeping up with (`core:work`, …). Empty when every surface is healthy, and
 * on a workspace with no Core, which has no surface to report.
 */
export const docsHealthResponseSchema = z.object({
  ok: z.boolean(),
  unhealthy: z.array(z.string()),
});
export type DocsHealthResponse = z.infer<typeof docsHealthResponseSchema>;

/**
 * What Docs' `meet-exchange` answers the Worker when it mints the Worker's
 * own token for a member (docs.ts). No client receives it since;
 * it stays registered on the wire for compatibility.
 */
export const docsTokenResponseSchema = z.object({
  token: z.string(),
  scopes: z.array(z.string()),
  expires_at: z.string(),
  email: z.string(),
  /** The Docs the token is for: this workspace's own. */
  origin: z.string().optional(),
});
export type DocsTokenResponse = z.infer<typeof docsTokenResponseSchema>;

/**
 * GET /api/crm/sales-inbox — one row per untriaged CRM-originated touch that
 * has no Meet subject yet: a contact-form submission that never created a
 * lead, a support case, a pricing request, or a Future Readiness Assessment
 * submission. Read only, member-gated like the rest of the CRM family.
 *
 * The Worker fans this out through Core's `GET /api/agent/untriaged-touches`
 * using the same owner-broker PAT `/api/core/token`
 * mints (`exchangeCoreToken`), because that route is scoped `untriaged:read`
 * and not one of the HMAC-signed `meet-*` projections. See docs/WORK.md
 * "Channels on the work itself" and.
 */
export const UNTRIAGED_TOUCH_SOURCES = ['contact', 'support_case', 'pricing_request', 'readiness_assessment'] as const;
export type UntriagedTouchSource = (typeof UNTRIAGED_TOUCH_SOURCES)[number];

export const untriagedTouchSourceSchema = z.enum(UNTRIAGED_TOUCH_SOURCES);

export const untriagedTouchOrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type UntriagedTouchOrganization = z.infer<typeof untriagedTouchOrganizationSchema>;

export const untriagedTouchContactSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
});
export type UntriagedTouchContact = z.infer<typeof untriagedTouchContactSchema>;

/**
 * What "Start a lead" hands to the New Lead flow. `crmLeadCreateSchema`
 * already carries `organization_id`/`contact_id`, which the client passes
 * straight through onto the created lead — see `inboxDraftFromTouch` in
 * `crm-work.ts`. `organization_name` / `contact_name` / `contact_email` are
 * folded into the lead's notes text too, purely so a person reading the
 * sheet sees who this is, not because the ids have nowhere else to go.
 */
export const untriagedTouchPrefillSchema = z.object({
  title: z.string(),
  notes: z.string(),
  organization_id: z.string().nullable(),
  organization_name: z.string().nullable(),
  contact_id: z.string().nullable(),
  contact_name: z.string().nullable(),
  contact_email: z.string().nullable(),
});
export type UntriagedTouchPrefill = z.infer<typeof untriagedTouchPrefillSchema>;

export const untriagedTouchSourceRecordSchema = z.object({
  type: z.enum(['leads', 'contacts', 'support_cases', 'readiness_assessments']),
  id: z.string(),
});
export type UntriagedTouchSourceRecord = z.infer<typeof untriagedTouchSourceRecordSchema>;

export const untriagedTouchSchema = z.object({
  id: z.string(),
  source: untriagedTouchSourceSchema,
  occurred_at: z.string(),
  organization: untriagedTouchOrganizationSchema.nullable(),
  contact: untriagedTouchContactSchema,
  preview: z.string(),
  dismissed: z.boolean(),
  dismissed_at: z.string().nullable(),
  prefill: untriagedTouchPrefillSchema,
  existing_lead_id: z.string().nullable(),
  existing_offer_id: z.string().nullable(),
  source_record: untriagedTouchSourceRecordSchema,
});
export type UntriagedTouch = z.infer<typeof untriagedTouchSchema>;

export const untriagedTouchesResponseSchema = z.object({
  data: z.array(untriagedTouchSchema),
  total: z.number().int(),
});
export type UntriagedTouchesResponse = z.infer<typeof untriagedTouchesResponseSchema>;

export const untriagedTouchDismissResponseSchema = z.object({
  ok: z.literal(true),
  dismissed: z.boolean(),
});
export type UntriagedTouchDismissResponse = z.infer<typeof untriagedTouchDismissResponseSchema>;

/**
 * `review` and `blocked` are the two columns the board has that Core's task
 * table did not (docs/BOARD.md). Accepted here so a drag says "Core refused"
 * rather than "Meet refused" until Core takes them.
 */
/** The spec's task statuses (ADR 0005), so Starlings' board and the open standard name the same states. */
export const crmTaskStatusSchema = z.enum(TASK_STATUSES);
export type CrmTaskStatus = z.infer<typeof crmTaskStatusSchema>;
/** Work still owed: the board's open columns, Unowned, My work. */
export const OPEN_TASK_STATUSES = ['pending', 'in_progress', 'review', 'blocked'] as const satisfies readonly CrmTaskStatus[];
/** Work that ended: the board's done and dropped columns, Recently closed. */
export const FINISHED_TASK_STATUSES = ['completed', 'cancelled'] as const satisfies readonly CrmTaskStatus[];
export const crmResponsiblePartySchema = z.enum(CRM_RESPONSIBLE_PARTIES);
export type CrmResponsibleParty = z.infer<typeof crmResponsiblePartySchema>;

export const crmTaskCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(5000).nullable().optional(),
  status: crmTaskStatusSchema.optional(),
  responsible_party: crmResponsiblePartySchema.optional(),
  /**
   * A member id from `/api/crm/team`. Null is nobody, which is a real choice.
   * Absent is the creator.
   */
  assigned_to: z.string().uuid().nullable().optional(),
  /** Undated work never reaches the calendar — `meet-work-items` selects on it. */
  due_date: z.string().datetime({ offset: true }).nullable().optional(),
  project_id: z.string().uuid().nullable().optional(),
  lead_id: z.string().uuid().nullable().optional(),
  event_id: z.string().uuid().nullable().optional(),
  /** A partner: its CRM organization. Core refuses an organization that is not flagged `is_partner`. */
  organization_id: z.string().uuid().nullable().optional(),
  /** A Signals account. Core files the task on the account and echoes its organization. */
  signals_account_id: z.string().uuid().nullable().optional(),
  /**
   * Where the task came from. `suggestion` is one the meeting proposed and the
   * owner accepted; that — and only that — is reported into the subject's
   * channel, because it is the meeting producing work, not somebody typing a
   * list. Absent means typed.
   */
  source: z.enum(['typed', 'suggestion']).optional(),
  /**
   * The meeting. With a project, lead or event: where a suggestion came
   * from, so the channel line can point at it. Alone: the subject — a status
   * or internal meeting's own task, filed on the meeting.
   */
  meeting_id: z.string().uuid().optional(),
  /** A goal on the same project. Core refuses one from another project. */
  goal_id: z.string().uuid().nullable().optional(),
}).superRefine((value, ctx) => {
  const subjects = [value.project_id, value.lead_id, value.event_id, value.organization_id, value.signals_account_id].filter(Boolean).length;
  if (subjects > 1 || (subjects === 0 && !value.meeting_id)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide exactly one of project_id, lead_id, event_id, organization_id or signals_account_id, or a meeting_id to file on the meeting.',
    });
  }
});

/**
 * POST /api/rooms/:slug/meetings/:id/task-candidates
 *
 * A chunk of live transcript in, proposed commitments out. Owner-only, and
 * stateless on purpose: the Worker keeps nothing, and the host still verifies
 * every quote against its own window before a row appears
 * (`docs/TASK_SUGGESTIONS.md`).
 */
export const taskCandidateRequestSchema = z.object({
  excerpt: z.string().trim().min(1).max(20_000),
  /** Titles already open or already proposed, so the model stops restating them. */
  known_titles: z.array(z.string().trim().max(200)).max(50).optional(),
});
export type TaskCandidateRequest = z.infer<typeof taskCandidateRequestSchema>;

/** The five places a task can be: exactly one carries an id. `organization_id` is a partner. */
export const TASK_SUBJECT_KEYS = ['project_id', 'lead_id', 'event_id', 'organization_id', 'meeting_id'] as const;
export type TaskSubjectKey = (typeof TASK_SUBJECT_KEYS)[number];
const taskSubjectFields = {
  project_id: z.string().uuid().nullable().optional(),
  lead_id: z.string().uuid().nullable().optional(),
  event_id: z.string().uuid().nullable().optional(),
  organization_id: z.string().uuid().nullable().optional(),
  meeting_id: z.string().uuid().nullable().optional(),
};
/** One of the five places, as `moved_from` names it: one key set, the rest absent. */
export const taskSubjectRefSchema = z.object(taskSubjectFields);
export type TaskSubjectRef = z.infer<typeof taskSubjectRefSchema>;
/** Which of the five are set on `value`. */
export function taskSubjectKeys(value: Partial<Record<TaskSubjectKey, string | null | undefined>>): TaskSubjectKey[] {
  return TASK_SUBJECT_KEYS.filter((key) => typeof value[key] === 'string' && value[key]);
}

export const crmTaskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  status: crmTaskStatusSchema.optional(),
  responsible_party: crmResponsiblePartySchema.optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  due_date: z.string().datetime({ offset: true }).nullable().optional(),
  /**
   * Move to…: exactly one of the five with an id puts the task
   * on that subject and off the others. None named leaves it where it is.
   */
  ...taskSubjectFields,
  /** Where it was, so the Worker can drop that list from its cache at once. */
  moved_from: taskSubjectRefSchema.optional(),
  goal_id: z.string().uuid().nullable().optional(),
}).refine((value) => taskSubjectKeys(value).length <= 1, {
  message: 'A task moves to one subject: project_id, lead_id, event_id, organization_id or meeting_id.',
});

/** Lobby WebSocket pushes (also mirrored by the 2s status poll). */
export const lobbyWaitingMessageSchema = z.object({
  type: z.literal('lobby.waiting'),
  waiting_count: z.number().int().nonnegative(),
});
export type LobbyWaitingMessage = z.infer<typeof lobbyWaitingMessageSchema>;

export const lobbyStatusMessageSchema = z.object({
  type: z.literal('lobby.status'),
  request_id: z.string(),
  status: lobbyStatusValueSchema,
});
export type LobbyStatusMessage = z.infer<typeof lobbyStatusMessageSchema>;

/**
 * Stable machine-readable causes on every error response. Clients branch on
 * these; `error` prose stays free to be reworded. The wire registry
 * generates `ControlErrorCodeValue` for Swift from this list.
 */
export const CONTROL_ERROR_CODES = [
  'owner_auth_required',
  /** A native session could not be renewed: sign in again. */
  'session_expired',
  'lobby_credentials_invalid',
  'meeting_ended',
  'meeting_inactive',
  'request_already_decided',
  'rate_limited',
  'not_configured',
  'core_account_missing',
  'room_not_found',
  'not_room_owner',
  'different_owner',
  'room_not_started',
  'capacity_reached',
  'host_not_active',
  'link_expired',
  'calendar_not_connected',
  'calendar_expired',
  'calendar_wrong_account',
  'calendar_not_invited',
  'calendar_event_not_found',
  'calendar_failed',
  'request_not_found',
  'meeting_not_found',
  'participant_not_found',
  /** No `people` row for that address — Admin was looking at a stale roster. */
  'person_not_found',
  /** No `owner_devices` row with that id: signed out already, or never this person's. */
  'device_not_found',
  /** A verified member, but not one who may change something org-wide. */
  'not_org_admin',
  /** A valid session whose `people.role` does not hold this capability (docs/ENROLLMENT.md). */
  'capability_denied',
  /** No subject by that kind and id that this caller can see. A restricted subject without a grant answers this too, so its existence never leaks (docs/ACCESS.md). */
  'subject_not_found',
  /** The caller sees the subject but its grant does not reach this write: a `read` grant writing, or a non-`manage` caller changing access. */
  'subject_access_denied',
  /** Changing your own role, or demoting the last admin. Neither is allowed. */
  'role_change_refused',
  /** Revoking yourself, or the last admin. Neither is allowed. */
  'access_change_refused',
  'guest_not_admitted',
  /** Admitted once, then removed by the host — knocking again is the only way back. */
  'guest_removed',
  'lobby_credentials_missing',
  'artifact_denied',
  'oauth_failed',
  'untrusted_origin',
  /** The person can be seen but not reached right now — unavailable. */
  'peer_unavailable',
  'turnstile_failed',
  /** A room owner refuses notetaker joins; bots may read this stable reason. */
  'recorders_refused',
  /** A declared notetaker must be attributed to a team member before admission. */
  'notetaker_sender_required',
  /**
   * A message can no longer be changed: withdrawn already, or past the edit
   * window. Distinct from a 404 on purpose — "gone" and "too late" lead the
   * person to different next actions, and a composer that says the wrong one
   * makes them retry something that will never work.
   */
  'message_not_editable',
  /** A message parent is missing, belongs to another conversation, or cannot be replied to. */
  'message_not_replyable',
  /** The question is withdrawn, still streaming, or was not authored as a question. */
  'question_not_open',
  /** A submitted option is not part of the question or violates its selection mode. */
  'invalid_question_answer',
  /** A new shared-chat question needs one eligible human recipient. */
  'invalid_question_recipient',
  /** A Keep release request that is not waiting or not live for this act: approved, ended, used or withdrawn. */
  'release_request_closed',
  /**
   * A Docs write carried the hash the client read, and the body moved in
   * between. Docs' own code, passed through so the editor can show both
   * bodies instead of overwriting one (docs/DOCS.md).
   */
  'hash_mismatch',
  /**
   * Core answered with a body its contract refuses. The message
   * names the field path; the Worker logs the paths, never the values.
   */
  'upstream_shape',
  /** The plan's project limit is reached: Free holds one project. Clients show the upgrade prompt. */
  'plan_project_limit',
  /** A write on a project the plan has made read-only: every project but the kept one on Free. */
  'plan_project_frozen',
  /** The plan cannot apply to this workspace: a project limit on a workspace whose projects live in Core. */
  'plan_not_supported',
  /** The one writable project on Free was already picked, and the pick is final. */
  'plan_kept_project_final',
  /**
   * A write to a table group that is moving from Core to D1. The
   * group is frozen for the copy; reads still answer. Try again in a few minutes.
   */
  'records_moving',
  /** A contact write names an address that is another contact's: one person outside, one record. */
  'contact_email_taken',
  /** More than one contact holds the address Core looked up. A person decides; nothing is created. */
  'ambiguous_contact',
  /**
   * The route is retired, and this app still calls it. The
   * message says what to update; the apps show their update action, never
   * Retry. A route answers this until the update floor passes the last app
   * that calls it (fixtures/app-routes.json).
   */
  'client_update_required',
  /** The workspace was shut down by its owner and answers nothing. */
  'workspace_closed',
  'invalid_request',
  'internal_error',
] as const;

export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];
export const controlErrorCodeSchema = z.enum(CONTROL_ERROR_CODES);

/** Bounded dimensions used by the privacy-safe operational error stream (#414). */
export * from './operational-error-values';

const operationalErrorFields = {
  event_id: z.string().uuid(),
  source: z.enum(OPERATIONAL_ERROR_SOURCES),
  platform: z.enum(OPERATIONAL_ERROR_PLATFORMS),
  /** App version/build, or the Worker commit SHA; deliberately not free prose. */
  release: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+() _-]{0,39}$/u),
  code: z.enum(OPERATIONAL_ERROR_CODES),
  operation: z.enum(OPERATIONAL_ERROR_OPERATIONS),
  error_class: z.enum(OPERATIONAL_ERROR_CLASSES),
  http_status: z.number().int().min(100).max(599).optional(),
  server_code: z.enum(OPERATIONAL_SERVER_CODES).optional(),
  request_id: z.string().uuid().optional(),
  retry_count: z.number().int().min(0).max(10),
};

/** Strictly allowlisted event accepted from a signed-in owner client. */
export const operationalErrorEventSchema = z.object(operationalErrorFields).strict();
export type OperationalErrorEvent = z.infer<typeof operationalErrorEventSchema>;
export const operationalErrorBatchSchema = z.object({
  events: z.array(operationalErrorEventSchema).min(1).max(10),
}).strict();
export type OperationalErrorBatch = z.infer<typeof operationalErrorBatchSchema>;

/** Guests get a narrower anonymous contract: only join-flow errors and no server codes. */
export const guestOperationalErrorEventSchema = z.object({
  event_id: z.string().uuid(),
  source: z.literal('web'),
  platform: z.literal('web'),
  release: operationalErrorFields.release,
  code: z.enum(GUEST_OPERATIONAL_ERROR_CODES),
  operation: z.enum(GUEST_OPERATIONAL_ERROR_OPERATIONS),
  error_class: z.enum(GUEST_OPERATIONAL_ERROR_CLASSES),
  http_status: operationalErrorFields.http_status,
  request_id: operationalErrorFields.request_id,
  retry_count: operationalErrorFields.retry_count,
}).strict();
export type GuestOperationalErrorEvent = z.infer<typeof guestOperationalErrorEventSchema>;
export const guestOperationalErrorBatchSchema = z.object({
  events: z.array(guestOperationalErrorEventSchema).min(1).max(3),
}).strict();
export type GuestOperationalErrorBatch = z.infer<typeof guestOperationalErrorBatchSchema>;
export const operationalErrorIngestResponseSchema = z.object({ accepted: z.number().int().min(0) });
export type OperationalErrorIngestResponse = z.infer<typeof operationalErrorIngestResponseSchema>;

/** Days an `operational_error_daily` row is kept. No read reaches further back. */
export const OPERATIONAL_ERROR_RETENTION_DAYS = 30;
/** The windows the admin error overview reads, in UTC days ending today. */
export const OPERATIONAL_ERROR_WINDOW_DAYS = { day: 1, week: 7, month: 30 } as const;
export const OPERATIONAL_ERROR_WINDOWS = ['day', 'week', 'month'] as const;
export type OperationalErrorWindow = (typeof OPERATIONAL_ERROR_WINDOWS)[number];
/** `unknown` when the previous equal window is older than the retention. */
export const OPERATIONAL_ERROR_TRENDS = ['new', 'up', 'down', 'flat', 'unknown'] as const;
export const OPERATIONAL_ERROR_OVERVIEW_MAX_GROUPS = 50;
export const OPERATIONAL_ERROR_OVERVIEW_REQUEST_IDS = 3;

/** `GET /api/admin/operational-errors` and `starlings://operational-errors/{window}`. */
export const operationalErrorOverviewQuerySchema = z.object({
  window: z.enum(OPERATIONAL_ERROR_WINDOWS).default('week'),
  release: operationalErrorFields.release.optional(),
  platform: z.enum(OPERATIONAL_ERROR_PLATFORMS).optional(),
  code: z.enum(OPERATIONAL_ERROR_CODES).optional(),
  limit: z.coerce.number().int().min(1).max(OPERATIONAL_ERROR_OVERVIEW_MAX_GROUPS).default(25),
}).strict();
export type OperationalErrorOverviewQuery = z.infer<typeof operationalErrorOverviewQuerySchema>;

const utcDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);

/**
 * One fingerprint across the window. Only the stored dimensions, counts,
 * times and sampled request ids: no message, stack, path, person, room,
 * calendar or meeting field exists to leak.
 */
export const operationalErrorGroupSchema = z.object({
  code: z.enum(OPERATIONAL_ERROR_CODES),
  source: z.enum(OPERATIONAL_ERROR_SOURCES),
  platform: z.enum(OPERATIONAL_ERROR_PLATFORMS),
  release: operationalErrorFields.release,
  operation: z.enum(OPERATIONAL_ERROR_OPERATIONS),
  error_class: z.enum(OPERATIONAL_ERROR_CLASSES),
  http_status: z.number().int().min(100).max(599).nullable(),
  server_code: z.enum(OPERATIONAL_SERVER_CODES).nullable(),
  /** A Worker 5xx's route pattern (`POST /api/threads/:id/messages`); ids read `:id`. */
  route: z.string().max(100).nullable(),
  count: z.number().int().min(1),
  /** The same fingerprint in the previous equal window; null when that window is past the retention. */
  previous_count: z.number().int().min(0).nullable(),
  trend: z.enum(OPERATIONAL_ERROR_TRENDS),
  first_at: z.string().datetime({ offset: true }),
  last_at: z.string().datetime({ offset: true }),
  request_ids: z.array(z.string().uuid()).max(OPERATIONAL_ERROR_OVERVIEW_REQUEST_IDS),
}).strict();
export type OperationalErrorGroup = z.infer<typeof operationalErrorGroupSchema>;

export const operationalErrorOverviewSchema = z.object({
  window: z.enum(OPERATIONAL_ERROR_WINDOWS),
  days: z.number().int().min(1).max(OPERATIONAL_ERROR_RETENTION_DAYS),
  from_day: utcDaySchema,
  to_day: utcDaySchema,
  /** The equal window before this one; null when it is older than the retention. */
  previous: z.object({ from_day: utcDaySchema, to_day: utcDaySchema }).strict().nullable(),
  retention_days: z.number().int(),
  filters: z.object({
    release: z.string().nullable(),
    platform: z.enum(OPERATIONAL_ERROR_PLATFORMS).nullable(),
    code: z.enum(OPERATIONAL_ERROR_CODES).nullable(),
  }).strict(),
  total: z.object({
    count: z.number().int().min(0),
    groups: z.number().int().min(0),
    previous_count: z.number().int().min(0).nullable(),
  }).strict(),
  /** Ranked by count, then the latest occurrence. */
  groups: z.array(operationalErrorGroupSchema).max(OPERATIONAL_ERROR_OVERVIEW_MAX_GROUPS),
  /** True when more groups matched than `limit` returned. */
  truncated: z.boolean(),
  generated_at: z.string().datetime({ offset: true }),
}).strict();
export type OperationalErrorOverview = z.infer<typeof operationalErrorOverviewSchema>;

/** Body of every non-2xx response from the control plane. */
export const controlErrorBodySchema = z.object({
  error: z.string(),
  /** Stable cause, present on every coded response. */
  code: controlErrorCodeSchema.optional(),
  /** Sent on 5xx and on a provider failure (`calendar_failed`), so a person can quote it in a support report. */
  request_id: z.string().optional(),
  /**
   * On a refused form body (400 `invalid_request`): the body key the refusal
   * is about, so a form draws `error` beside that field (`formRefusal`).
   */
  field: z.string().optional(),
});
export type ControlErrorBody = z.infer<typeof controlErrorBodySchema>;

export const ownerSessionSchema = z.object({
  sub: z.string(),
  email: z.string(),
  name: z.string(),
  picture: z.string().optional(),
});
export type OwnerSession = z.infer<typeof ownerSessionSchema>;

export const artifactPrincipalSchema = z.object({
  roomSlug: z.string(),
  meetingId: z.string(),
  identity: z.string(),
  role: z.enum(['owner', 'guest']),
  email: z.string(),
});
export type ArtifactPrincipal = z.infer<typeof artifactPrincipalSchema>;

export const artifactJobSchema = z.object({
  roomSlug: z.string(),
  meetingId: z.string(),
  /**
   * Absent means `artifact`, the job every meeting queues when it ends.
   * `regenerate` writes a finalized meeting's notes again.
   */
  kind: z.enum(['artifact', 'crm', 'deliver', 'regenerate']).optional(),
});
export type ArtifactJob = z.infer<typeof artifactJobSchema>;

/** One Granola note to read and write into Core. See docs/GRANOLA_BRIDGE.md. */
export const granolaNoteJobSchema = z.object({
  kind: z.literal('granola'),
  noteId: z.string(),
});
export type GranolaNoteJob = z.infer<typeof granolaNoteJobSchema>;

/**
 * One page of a Granola historical import. Each page enqueues its notes and
 * then the next page, so two years of history is a chain of small retryable
 * messages rather than one request that has to survive to the end.
 */
export const granolaPageJobSchema = z.object({
  kind: z.literal('granola-page'),
  cursor: z.string().optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
});
export type GranolaPageJob = z.infer<typeof granolaPageJobSchema>;

/**
 * Ask for one note's suggested filing again, without touching Core. For a
 * backlog imported while the model was unavailable (no AI credits, an
 * outage): `POST /api/granola/suggest` enqueues one per unfiled note that
 * has no answer yet.
 */
export const granolaSuggestJobSchema = z.object({
  kind: z.literal('granola-suggest'),
  noteId: z.string(),
});
export type GranolaSuggestJob = z.infer<typeof granolaSuggestJobSchema>;

/**
 * A lead the unfiled meetings suggest but Core does not hold.
 * One per company, never one per meeting: three conversations with the same
 * company are one proposal covering three meetings, or the queue grows three
 * leads named after three meetings.
 */
export const granolaProposalSchema = z.object({
  /** The guest email domain the cluster is grouped by — its identity. */
  domain: z.string(),
  /** What the lead would be called: Core's organization name, else the domain's. */
  name: z.string(),
  /** Core's organization, when the contacts already name one. */
  organization_id: z.string().nullable(),
  meetings: z.array(z.object({
    note_id: z.string(),
    title: z.string().nullable(),
    started_at: z.string(),
    meeting_kind: meetingKindSchema,
  })),
  /**
   * A subject Core already holds whose name or organization matches. Present
   * means this is not a new lead at all — the option list the model saw was
   * too narrow, and the meetings belong on this instead.
   */
  existing: z.object({ kind: acceptingKindAliases(z.enum(['lead', 'project', 'organization'])), id: z.string(), title: z.string() }).nullable(),
});
export type GranolaProposal = z.infer<typeof granolaProposalSchema>;

/** GET /api/granola/proposals */
export const granolaProposalsResponseSchema = z.object({
  proposals: z.array(granolaProposalSchema),
});
export type GranolaProposalsResponse = z.infer<typeof granolaProposalsResponseSchema>;

/** POST /api/granola/suggest */
export const granolaSuggestResponseSchema = z.object({
  queued: z.number().int(),
});
export type GranolaSuggestResponse = z.infer<typeof granolaSuggestResponseSchema>;

/**
 * One Granola note as the import list draws it: what Granola knows about it,
 * and — when Core already holds it — where it landed and how it was filed.
 * `imported` is null until the bridge has written the note.
 */
export const meetingAttendeeSchema = z.object({ name: z.string(), email: z.string().nullable() });
export type MeetingAttendee = z.infer<typeof meetingAttendeeSchema>;

export const granolaFilingSuggestionSchema = z.object({
  meeting_kind: meetingKindSchema,
  /** 0–1: how sure the reader is of the kind. */
  probability: z.number(),
  /** The subject, when the kind takes one and a listed subject matched. */
  lead_id: z.string().nullable(),
  project_id: z.string().nullable(),
  event_id: z.string().nullable(),
  partner_organization_id: z.string().nullable(),
  subject_title: z.string().nullable(),
  subject_probability: z.number().nullable(),
  /**
   * The organization Core drew from the guests, when it has one. A `lead`
   * answer with no listed subject and an organization is a lead that does
   * not exist yet: the control offers to create it there.
   */
  organization_id: z.string().nullable(),
});
export type GranolaFilingSuggestion = z.infer<typeof granolaFilingSuggestionSchema>;

/** What a Granola note became in Core, once imported. */
export const granolaImportedRecordSchema = z.object({
  interaction_id: z.string(),
  meeting_kind: meetingKindSchema,
  lead_id: z.string().nullable(),
  project_id: z.string().nullable(),
  partner_organization_id: z.string().nullable().optional(),
  subject_title: z.string().nullable(),
  has_transcript: z.boolean(),
  suggestion: granolaFilingSuggestionSchema.nullable(),
});
export type GranolaImportedRecord = z.infer<typeof granolaImportedRecordSchema>;

export const granolaNoteRowSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  started_at: z.string(),
  created_at: z.string(),
  owner_email: z.string().nullable(),
  attendees: z.array(meetingAttendeeSchema),
  web_url: z.string().nullable(),
  imported: granolaImportedRecordSchema.nullable(),
});
export type GranolaNoteRow = z.infer<typeof granolaNoteRowSchema>;

/** One suggested filing, as the list draws it. See docs/GRANOLA_BRIDGE.md. */
/**
 * GET /api/connectors — every outside source that writes into Meet, and
 * where each stands. One shape per connector so the page draws them alike;
 * fields a connector has no notion of are zero or null.
 */
export const CONNECTOR_IDS = ['granola', 'github', 'slack', 'beeper'] as const;
export type ConnectorId = (typeof CONNECTOR_IDS)[number];
export const connectorIdSchema = z.enum(CONNECTOR_IDS);

export const connectorStatusSchema = z.object({
  id: connectorIdSchema,
  configured: z.boolean(),
  imported: z.number().int(),
  unfiled: z.number().int(),
  suggested: z.number().int(),
  accepted: z.number().int(),
  corrected: z.number().int(),
  suggesting: z.boolean(),
  last_webhook_at: z.number().int().nullable(),
  last_import_at: z.number().int().nullable(),
  last_sync_at: z.number().int().nullable().optional(),
  enabled: z.boolean().optional(),
  stale: z.boolean().optional(),
  /**
   * A history import walking, and how far. `done` counts the notes the index
   * has re-read since the run began; `total` is every note the index knows.
   * Absent when no run is in flight — a run is over when nothing has been
   * read for a few minutes, since the queue announces no ending.
   */
  run: z.object({
    started_at: z.number().int(),
    done: z.number().int(),
    total: z.number().int(),
    last_note_at: z.number().int().nullable(),
  }).nullable().optional(),
});
export type ConnectorStatus = z.infer<typeof connectorStatusSchema>;
export const connectorsResponseSchema = z.object({
  connectors: z.array(connectorStatusSchema),
});

/**
 * The Google connector grant (docs/CONNECTORS.md): one per member,
 * on its own Google Cloud project, holding the read scopes the member gave.
 * Google revokes a grant whole, so a member holds one grant and Disconnect
 * removes every product in it. Calendar is a separate grant on another project.
 */
export { GOOGLE_GRANT_PRODUCTS, type GoogleGrantProduct };
export const googleGrantProductSchema = z.enum(GOOGLE_GRANT_PRODUCTS);

export const googleGrantSchema = z.object({
  /** The Google account that granted: always the member's own address. */
  email: z.string(),
  /** The products whose scope Google reports as granted. A member may untick one on Google's screen. */
  products: z.array(googleGrantProductSchema),
  granted_at: z.number().int(),
});
export type GoogleGrant = z.infer<typeof googleGrantSchema>;

/** GET /api/connectors/google */
export const googleGrantResponseSchema = z.object({
  /** False until the connector's OAuth client is set on this deployment. */
  configured: z.boolean(),
  grant: googleGrantSchema.nullable(),
});
export type GoogleGrantResponse = z.infer<typeof googleGrantResponseSchema>;

/** GET /api/connectors/google/connect/start?product=&return_to= */
export const googleGrantStartQuerySchema = z.object({
  product: googleGrantProductSchema,
  return_to: z.string().max(512).optional(),
});
export type GoogleGrantStartQuery = z.infer<typeof googleGrantStartQuerySchema>;
export type ConnectorsResponse = z.infer<typeof connectorsResponseSchema>;

/**
 * The GitHub connector. One row per repository the Meet GitHub App
 * installation can see, beside where a person mapped it and how far the sync
 * has read it. The mapping is Meet's `import_mappings` row; a project mapping
 * is also written through to Core's project link so the issues path, which
 * still reads through Core, agrees.
 */
export const IMPORT_ITEM_STATES = ['unmapped', 'skipped', 'queued', 'importing', 'synced', 'failed'] as const;
export type ImportItemState = (typeof IMPORT_ITEM_STATES)[number];
export const importItemStateSchema = z.enum(IMPORT_ITEM_STATES);

export const githubConnectorMappingSchema = z.object({
  subject_kind: z.enum(['project', 'lead']).nullable(),
  subject_id: z.string().nullable(),
  subject_title: z.string().nullable(),
  decided_by: z.string().nullable(),
  decided_at: z.number().int().nullable(),
});

export const githubConnectorRowSchema = z.object({
  id: z.string(),
  owner: z.string(),
  repo: z.string(),
  description: z.string().nullable(),
  private: z.boolean(),
  archived: z.boolean(),
  pushed_at: z.string().nullable(),
  open_issues: z.number().int(),
  mapping: githubConnectorMappingSchema.nullable(),
  state: importItemStateSchema,
  pulls: z.number().int(),
  cursor: z.string().nullable(),
  last_synced_at: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type GithubConnectorRow = z.infer<typeof githubConnectorRowSchema>;

export const githubConnectorResponseSchema = z.object({
  /** This workspace can reach the Starlings App's token broker (its `GITHUB` binding). */
  configured: z.boolean(),
  /** An installation is connected for this workspace. False: no rows, and the page offers Connect GitHub. */
  connected: z.boolean(),
  /** The GitHub account the installation is on. */
  account: z.string().nullable(),
  enabled: z.boolean(),
  rows: z.array(githubConnectorRowSchema),
});
export type GithubConnectorResponse = z.infer<typeof githubConnectorResponseSchema>;

/** PUT /api/connectors/github/:owner/:repo — map, or skip. */
export const githubMappingSchema = z.object({
  subject_kind: z.enum(['project', 'lead']).nullable(),
  subject_id: z.string().uuid().nullable(),
  subject_title: z.string().trim().max(200).nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.subject_kind && !value.subject_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'subject_id is required with a kind.', path: ['subject_id'] });
  }
  if (!value.subject_kind && value.subject_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'subject_kind is required with an id.', path: ['subject_kind'] });
  }
});
export type GithubMappingInput = z.infer<typeof githubMappingSchema>;

export const githubMappingResponseSchema = z.object({
  row: githubConnectorRowSchema,
});
export type GithubMappingResponse = z.infer<typeof githubMappingResponseSchema>;

/**
 * A pull request on a mapped repository, as the Work surface lists it beside
 * issues. Not a `WorkItem`: it has no stage, and `WorkStage` is not widened
 * for it (docs/BOARD.md). The second list under a project, not a column.
 */
export const PULL_STATES = ['open', 'draft', 'merged', 'closed'] as const;
export type PullState = (typeof PULL_STATES)[number];
export const pullStateSchema = z.enum(PULL_STATES);
export const PULL_REVIEW_STATES = ['none', 'requested', 'changes_requested', 'approved'] as const;
export type PullReviewState = (typeof PULL_REVIEW_STATES)[number];
export const pullReviewStateSchema = z.enum(PULL_REVIEW_STATES);
export const PULL_CHECK_STATES = ['none', 'pending', 'success', 'failure'] as const;
export type PullCheckState = (typeof PULL_CHECK_STATES)[number];
export const pullCheckStateSchema = z.enum(PULL_CHECK_STATES);

export const pullItemSchema = z.object({
  id: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: pullStateSchema,
  review: pullReviewStateSchema,
  checks: pullCheckStateSchema,
  author_login: z.string().nullable(),
  /** Issue numbers the pull closes, from its body. */
  closes: z.array(z.number().int()),
  head_ref: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
  merged_at: z.string().nullable(),
  closed_at: z.string().nullable(),
});
export type PullItem = z.infer<typeof pullItemSchema>;

/** GET /api/crm/pulls?project_id= */
export const pullsResponseSchema = z.object({
  pulls: z.array(pullItemSchema),
  /** False when the project has no repository mapped; the list is then empty and not an error. */
  mapped: z.boolean(),
});
export type PullsResponse = z.infer<typeof pullsResponseSchema>;

/**
 * One page of one repository's pass, read by the sync. Each page enqueues the
 * next, as the Granola page job does, and the cursor is the newest
 * `updated_at` the last full pass ended on.
 *
 * A pass has two phases. `pulls` reads pull requests into `github_pulls` and
 * chains into `issues`, which reads issues so the channel gets its lines even
 * when the webhook edge is down. Each phase keeps its own cursor.
 */
export const githubRepoJobSchema = z.object({
  kind: z.literal('github-repo'),
  owner: z.string(),
  repo: z.string(),
  /** Absent means `pulls`, so a job enqueued before this field existed still runs. */
  phase: z.enum(['pulls', 'issues']).optional(),
  page: z.number().int().optional(),
  since: z.string().nullable().optional(),
  newest: z.string().nullable().optional(),
});
export type GithubRepoJob = z.infer<typeof githubRepoJobSchema>;

/**
 * The Slack import (docs/SLACK_IMPORT.md). One row per channel the
 * token's user is in, beside the decision — which subject channel its
 * history lands in, or skip — and how far the sync has read it.
 */
export const SLACK_SUBJECT_KINDS = ['project', 'lead', 'organization', 'team'] as const;
export type SlackSubjectKind = (typeof SLACK_SUBJECT_KINDS)[number];
export const slackSubjectKindSchema = acceptingKindAliases(z.enum(SLACK_SUBJECT_KINDS));
// subject-kinds.ts decides which subjects take a channel; a test pins this list to it.
export const SLACK_MAPPABLE_SUBJECT_KINDS = subjectKindsWith('slack');

export const slackConnectorMappingSchema = z.object({
  subject_kind: slackSubjectKindSchema.nullable(),
  subject_id: z.string().nullable(),
  subject_title: z.string().nullable(),
  decided_by: z.string().nullable(),
  decided_at: z.number().int().nullable(),
});

export const slackConnectorRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string().nullable(),
  private: z.boolean(),
  shared: z.boolean(),
  archived: z.boolean(),
  members: z.number().int(),
  created: z.number().int(),
  mapping: slackConnectorMappingSchema.nullable(),
  state: importItemStateSchema,
  messages: z.number().int(),
  cursor: z.string().nullable(),
  last_synced_at: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type SlackConnectorRow = z.infer<typeof slackConnectorRowSchema>;

export const slackConnectorResponseSchema = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  team: z.string().nullable(),
  rows: z.array(slackConnectorRowSchema),
});
export type SlackConnectorResponse = z.infer<typeof slackConnectorResponseSchema>;

/** PUT /api/connectors/slack/:channel — map, or skip. `team` takes no id. */
export const slackMappingSchema = z.object({
  subject_kind: slackSubjectKindSchema.nullable(),
  subject_id: z.string().uuid().nullable(),
  subject_title: z.string().trim().max(200).nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.subject_kind && value.subject_kind !== 'team' && !value.subject_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'subject_id is required with a kind.', path: ['subject_id'] });
  }
  if ((!value.subject_kind || value.subject_kind === 'team') && value.subject_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'subject_id takes a project, a lead or an organization.', path: ['subject_kind'] });
  }
});
export type SlackMappingInput = z.infer<typeof slackMappingSchema>;

export const slackMappingResponseSchema = z.object({
  row: slackConnectorRowSchema,
});
export type SlackMappingResponse = z.infer<typeof slackMappingResponseSchema>;

/**
 * One page of one channel's history, read by the sync. Slack pages newest
 * first; each page enqueues the next, and the cursor is the newest `ts` the
 * last full pass ended on, so the next pass reads only what is newer.
 */
export const slackChannelJobSchema = z.object({
  kind: z.literal('slack-channel'),
  channelId: z.string(),
  page: z.string().nullable().optional(),
  oldest: z.string().nullable().optional(),
  newest: z.string().nullable().optional(),
  written: z.number().int().optional(),
});
export type SlackChannelJob = z.infer<typeof slackChannelJobSchema>;

/**
 * POST /api/rooms/:slug/meetings/ambient — a meeting the owner's Mac captured
 * outside any room (docs/AMBIENT_CAPTURE.md), created already over. The
 * transcript follows through the ordinary segment upload and finalize.
 */
export const ambientAttendeeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).nullable().optional(),
});
export const ambientMeetingSchema = z.object({
  started_at: z.string().datetime({ offset: true }),
  ended_at: z.string().datetime({ offset: true }),
  title: z.string().trim().max(200).nullable().optional(),
  /** Names, with an address when the calendar knew one — what links a contact. */
  attendees: z.array(ambientAttendeeSchema).max(200).optional(),
});
export const ambientMeetingResponseSchema = z.object({
  meeting_id: z.string(),
});
export type AmbientMeetingResponse = z.infer<typeof ambientMeetingResponseSchema>;

/**
 * GET /api/rooms/:slug/meetings?capture=ambient — the meetings the owner's
 * Mac captured outside any room, newest first, as the Meetings list draws
 * them: what was captured, where the transcript went, and how the meeting
 * is filed. Filing goes through the meeting's category route.
 */
export const ambientMeetingRowSchema = z.object({
  id: z.string(),
  room_slug: z.string(),
  title: z.string().nullable(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  attendees: z.array(meetingAttendeeSchema),
  summary_line: z.string().nullable(),
  meeting_kind: meetingKindSchema,
  lead_id: z.string().nullable(),
  project_id: z.string().nullable(),
  subject_title: z.string().nullable(),
  has_transcript: z.boolean(),
  transcript_document_path: z.string().nullable(),
});
export type AmbientMeetingRow = z.infer<typeof ambientMeetingRowSchema>;
export const ambientMeetingsResponseSchema = z.object({
  meetings: z.array(ambientMeetingRowSchema),
});
export type AmbientMeetingsResponse = z.infer<typeof ambientMeetingsResponseSchema>;

/** Owner-only finalized meetings since a shared MCP change cursor. */
export const meetingChangesQuerySchema = z.object({
  since: z.string().trim().min(1).max(512),
  limit: z.coerce.number().int().min(1).max(MCP_CHANGES_PAGE_SIZE).optional(),
});
export const meetingChangeSourceRowSchema = z.object({
  meeting_id: z.string(),
  room_slug: z.string(),
  host_email: z.string().email(),
  title: z.string().nullable(),
  changed_at: z.number().int(),
});
export const meetingChangesResponseSchema = z.object({
  meetings: z.array(meetingChangeSourceRowSchema),
  has_more: z.boolean(),
});
export type MeetingChangesResponse = z.infer<typeof meetingChangesResponseSchema>;

/** POST /api/rooms/:slug/meetings/:id/decision-candidates/:index. */
export const meetingDecisionCandidateMutationResponseSchema = z.object({
  candidate: meetingDecisionCandidateSchema,
  decision: crmDecisionSchema.optional(),
});
export type MeetingDecisionCandidateMutationResponse = z.infer<typeof meetingDecisionCandidateMutationResponseSchema>;

/**
 * `POST /api/rooms/:slug/meetings/:id/follow-up`: the host approves. The
 * ticked proposed tasks are accepted and the rest declined; the answer is
 * the mail draft, which the client opens in the host's own mail app.
 * Starlings sends nothing. An edited body is allowed, up to the same cap.
 */
export const meetingFollowUpApproveSchema = z.object({
  revision: z.number().int().min(1),
  subject: z.string().trim().min(1).max(MEETING_FOLLOW_UP_SUBJECT_MAX),
  body: z.string().trim().min(1).max(4_000),
  accept_task_ids: z.array(z.string().min(1).max(64)).max(60),
  decline_task_ids: z.array(z.string().min(1).max(64)).max(60),
}).strict();
export type MeetingFollowUpApprove = z.infer<typeof meetingFollowUpApproveSchema>;

export const meetingFollowUpApproveResponseSchema = z.object({
  ok: z.literal(true),
  mail: z.object({ to: z.array(z.string()), subject: z.string(), body: z.string() }),
  /** Tasks Core would not move, by id; the approval stands. */
  failed_task_ids: z.array(z.string()),
});
export type MeetingFollowUpApproveResponse = z.infer<typeof meetingFollowUpApproveResponseSchema>;

/** POST /api/rooms/:slug/meetings/:id/decision-candidates/:index */
export const meetingDecisionCandidateAnswerSchema = z.object({
  accept: z.boolean(),
}).strict();

export const meetingDeliveryDestinationSchema = z.enum(['docs', 'core', 'proposals', 'followup']);
export type MeetingDeliveryDestination = z.infer<typeof meetingDeliveryDestinationSchema>;

export const meetingDeliverySchema = z.object({
  meeting_id: z.string(),
  room_slug: z.string(),
  destination: meetingDeliveryDestinationSchema,
  status: z.enum(['pending', 'failed', 'delivered']),
  requested_revision: z.number().int(),
  delivered_revision: z.number().int(),
  attempts: z.number().int(),
  last_error: z.string().nullable(),
  requested_at: z.number().int(),
  delivered_at: z.number().int().nullable(),
  updated_at: z.number().int(),
});
export type MeetingDelivery = z.infer<typeof meetingDeliverySchema>;

export const transcriptViewResponseSchema = z.object({
  artifact: artifactMaterialResponseSchema,
  category: z.object({ meeting_kind: meetingKindSchema, subject_title: z.string().nullable() }),
  deliveries: z.array(meetingDeliverySchema),
  /** False for the meeting owner; true when a member reads a filed meeting. */
  read_only: z.boolean().optional(),
  /** True when the notes were made from an older revision of the transcript. */
  notes_stale: z.boolean(),
  action_items: z.array(meetingActionItemSchema),
  /** Absent from a Worker that predates. */
  decision_candidates: z.array(meetingDecisionCandidateSchema).optional(),
  /**
   * Who was in the meeting, by name, for the owner. Absent for a
   * member reading a filed meeting, whose header names the people who spoke.
   */
  attendees: z.array(z.string()).optional(),
});
export type TranscriptViewResponse = z.infer<typeof transcriptViewResponseSchema>;

/** GET /api/rooms/:slug/meetings/:id/transcript?structured=true (MCP projection). */
export const meetingTranscriptQuerySchema = z.object({
  structured: z.stringbool().optional(),
}).strict();
export type MeetingTranscriptQuery = z.infer<typeof meetingTranscriptQuerySchema>;

/** Structured MCP view of a finalized meeting; deliberately contains no room or media locator. */
export const mcpMeetingArtifactResponseSchema = z.object({
  summary: z.string().nullable(),
  action_items: z.array(z.object({
    text: z.string(),
    owner_hint: z.string().nullable(),
    task_id: z.string().optional(),
    door: z.string().optional(),
  }).strict()),
  decisions: z.array(z.object({
    text: z.string(),
    decision_id: z.string().optional(),
    door: z.string().optional(),
  }).strict()),
  open_questions: z.array(z.string()),
  attendees: z.array(z.object({
    name: z.string(),
    email: z.string().email().optional(),
    kind: z.enum(['human', 'agent', 'guest']),
  }).strict()),
  subject: z.object({ door: z.string() }).strict().nullable(),
  started_at: z.number().int(),
  ended_at: z.number().int(),
  transcript: z.object({ segments: z.array(transcriptSegmentSchema) }).strict(),
}).strict();
export type McpMeetingArtifactResponse = z.infer<typeof mcpMeetingArtifactResponseSchema>;


/**
 * One commitment the notes engine wrote down: the same judgment
 * that wrote the note's Action items, as data. Filed on the subject as a
 * `proposed` task once the meeting is filed; `task_id` is Core's id then.
 * Never an owner or a date the model invented: `who` is a name as spoken,
 * `by_when` a phrase, and both go into the task's notes, not its fields.
 */
/**
 * One destination's copy of one meeting. `pending` is owed and
 * not yet tried, or tried and not failed since; `failed` is owed with an
 * error on the last try; `delivered` is caught up. Never carries text.
 */
/** GET /api/admin/deliveries — everything still owed, oldest first. */
export const deliveriesResponseSchema = z.object({
  due: z.array(meetingDeliverySchema),
});
export type DeliveriesResponse = z.infer<typeof deliveriesResponseSchema>;

/** POST /api/admin/deliveries/replay — every due row sent again. */
export const deliveriesReplayResponseSchema = z.object({
  requeued: z.number().int(),
});
export type DeliveriesReplayResponse = z.infer<typeof deliveriesReplayResponseSchema>;

/** PATCH /api/rooms/:slug/meetings/:id/transcript — one speaker, renamed on every line. */
export const transcriptRenameSchema = z.object({
  speaker_id: z.string().trim().min(1).max(200),
  speaker_name: z.string().trim().min(1).max(120),
});
export const transcriptRenameResponseSchema = z.object({
  renamed: z.number().int(),
});
export type TranscriptRenameResponse = z.infer<typeof transcriptRenameResponseSchema>;

/** DELETE /api/rooms/:slug/meetings/:id/transcript — lines struck from the record. */
export const transcriptDeleteSchema = z.object({
  segment_ids: z.array(z.string().uuid()).min(1).max(2_000),
});
export const transcriptDeleteResponseSchema = z.object({
  removed: z.number().int(),
});
export type TranscriptDeleteResponse = z.infer<typeof transcriptDeleteResponseSchema>;

/** POST /api/admin/regenerate-notes — one meeting's notes again, with the engine configured now. */
export const regenerateNotesSchema = z.object({
  room_slug: z.string().trim().min(1).max(40),
  meeting_id: z.string().uuid(),
});

/**
 * POST /api/admin/regenerate-fallback-notes — every meeting since `since_ms`
 * whose notes a model other than Claude wrote, queued to be written again
 *. Meetings from before the model was recorded are not known,
 * so they are not included.
 */
export const regenerateFallbackNotesSchema = z.object({
  since_ms: z.number().int().nonnegative(),
});
export const regenerateFallbackNotesResponseSchema = z.object({
  rooms: z.number().int(),
  queued: z.number().int(),
});
export type RegenerateFallbackNotesResponse = z.infer<typeof regenerateFallbackNotesResponseSchema>;

/**
 * POST /api/admin/replay-jobs — dead-lettered queue messages, sent again.
 * Each entry is a message body as the dead queue holds it (`ControlPlaneJob`),
 * so an operator pastes what the dashboard shows and nothing is retyped.
 */
export const replayJobsSchema = z.union([z.object({
  jobs: z.array(z.union([
    z.object({
      kind: z.literal('granola'),
      noteId: z.string().trim().min(1).max(128),
    }),
    z.object({
      kind: z.literal('github-repo'),
      owner: z.string().trim().min(1).max(100),
      repo: z.string().trim().min(1).max(100),
      page: z.number().int().min(1).max(10000).optional(),
      since: z.string().trim().max(64).nullable().optional(),
      newest: z.string().trim().max(64).nullable().optional(),
    }),
    z.object({
      kind: z.literal('granola-page'),
      cursor: z.string().trim().min(1).max(512).optional(),
      createdAfter: z.string().trim().min(1).max(64).optional(),
      createdBefore: z.string().trim().min(1).max(64).optional(),
    }),
    z.object({
      kind: z.literal('granola-suggest'),
      noteId: z.string().trim().min(1).max(128),
    }),
    z.object({
      roomSlug: z.string().trim().min(1).max(40),
      meetingId: z.string().uuid(),
      kind: z.enum(['artifact', 'crm', 'deliver']).optional(),
    }),
  ])).min(1).max(100),
}), z.object({
  /** Every job the dead-letter consumer kept in D1, oldest first. */
  dead: z.literal(true),
})]);
export const replayJobsResponseSchema = z.object({
  queued: z.number().int(),
});
export type ReplayJobsResponse = z.infer<typeof replayJobsResponseSchema>;

/** GET /api/admin/dead-jobs — the jobs the dead-letter consumer kept, as a count. */
export const deadJobsResponseSchema = z.object({
  count: z.number().int(),
  oldest_at: z.number().int().nullable(),
});
export type DeadJobsResponse = z.infer<typeof deadJobsResponseSchema>;

/** One failure kind the Worker counted in the last seven UTC days. */
export const opsFailureRowSchema = z.object({
  kind: z.string(),
  count_today: z.number().int(),
  count_7d: z.number().int(),
  last_at: z.number().int(),
  /** An id, a route pattern or a short reason; never personal data. */
  last_detail: z.string().nullable(),
  /** Whether an alert mail has gone out since the last failure of this kind. */
  mailed: z.boolean(),
});
export type OpsFailureRow = z.infer<typeof opsFailureRowSchema>;

/** GET /api/admin/ops-failures — what the Worker counted about itself. */
export const opsFailuresResponseSchema = z.object({
  failures: z.array(opsFailureRowSchema),
  /** When Core's last signed call was accepted; null before the first one is on record. */
  core_last_accepted_at: z.number().int().nullable(),
  /** The Mac version the update feed offers and when it went out; null when the feed cannot be read. */
  release: z.object({ version: z.string(), published_at: z.number().int() }).nullable(),
});
export type OpsFailuresResponse = z.infer<typeof opsFailuresResponseSchema>;

/**
 * One meeting owed notes that the sweep gave up on: its artifact
 * job was re-enqueued three times and the summary still does not exist.
 */
export const notesOwedRowSchema = z.object({
  room_slug: z.string(),
  meeting_id: z.string(),
  owed_at: z.number().int(),
  attempts: z.number().int(),
});
export type NotesOwedRow = z.infer<typeof notesOwedRowSchema>;

/** GET /api/admin/notes-owed — the stuck meetings, oldest first. */
export const notesOwedResponseSchema = z.object({
  stuck: z.array(notesOwedRowSchema),
});
export type NotesOwedResponse = z.infer<typeof notesOwedResponseSchema>;

/** POST /api/admin/notes-owed/retry — `attempts` back to 0; the next sweep enqueues the job. */
export const notesOwedRetrySchema = z.object({
  room_slug: z.string().trim().min(1).max(40),
  meeting_id: z.string().uuid(),
});
export const notesOwedRetryResponseSchema = z.object({
  reset: z.boolean(),
});
export type NotesOwedRetryResponse = z.infer<typeof notesOwedRetryResponseSchema>;

/**
 * One day of one model's calls for one purpose. Anthropic rows
 * carry its token counts; Workers AI rows carry an estimate of characters / 4.
 */
export const modelUsageRowSchema = z.object({
  day: z.string(),
  provider: z.string(),
  model: z.string(),
  purpose: z.string(),
  calls: z.number().int(),
  input_tokens: z.number().int(),
  output_tokens: z.number().int(),
});
export type ModelUsageRow = z.infer<typeof modelUsageRowSchema>;

/** GET /api/admin/model-usage?days= — newest day first. */
export const modelUsageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});
export const modelUsageResponseSchema = z.object({
  rows: z.array(modelUsageRowSchema),
});
export type ModelUsageResponse = z.infer<typeof modelUsageResponseSchema>;

/**
 * Which kind of Durable Object a backup reads and a restore writes into
 *. `quick-notes` is one owner's inbox, keyed by the owner's `sub`
 *.
 */
export const restoreObjectKindSchema = z.enum(['room', 'thread', 'quick-notes']);
export type RestoreObjectKind = z.infer<typeof restoreObjectKindSchema>;

/**
 * POST /api/admin/restore-object — replace one room's, thread's or owner's
 * Quick Notes tables with that day's snapshot from the backup bucket. Writes
 * after the snapshot are lost.
 */
export const restoreObjectSchema = z.object({
  kind: restoreObjectKindSchema,
  id: z.string().trim().regex(/^[A-Za-z0-9:_.-]{1,128}$/u),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
});
export const restoreObjectResponseSchema = z.object({
  kind: restoreObjectKindSchema,
  id: z.string(),
  date: z.string(),
  /** Rows written per table. */
  tables: z.record(z.string(), z.number().int()),
});
export type RestoreObjectResponse = z.infer<typeof restoreObjectResponseSchema>;

/**
 * Moving rooms and Quick Notes into the EU jurisdiction (,
 * docs/ROOM_JURISDICTION_PLAN.md). `legacy` is an object that has not moved.
 */
export const objectMoveNamespaceSchema = z.enum(['rooms', 'quick_notes']);
export const objectMoveStateSchema = z.enum(['legacy', 'moving', 'moved', 'rolled_back']);
export type ObjectMoveState = z.infer<typeof objectMoveStateSchema>;

/**
 * POST /api/admin/object-moves — move one object to the EU, copy one back,
 * or delete the old copy of one that moved 14 days ago or more. With no
 * `name`, `move` and `purge` run on every object of the kind; a room moves
 * only by name.
 */
export const objectMoveRequestSchema = z.object({
  action: z.enum(['move', 'rollback', 'purge']),
  namespace: objectMoveNamespaceSchema,
  name: z.string().trim().regex(/^[A-Za-z0-9:_.-]{1,128}$/u).optional(),
});
export type ObjectMoveRequest = z.infer<typeof objectMoveRequestSchema>;

export const objectMoveResultSchema = z.object({
  namespace: objectMoveNamespaceSchema,
  name: z.string(),
  outcome: z.enum(['moved', 'rolled_back', 'purged', 'skipped', 'failed']),
  /** Rows copied, bookkeeping tables left out. */
  rows: z.number().int().optional(),
  reason: z.string().optional(),
});
export type ObjectMoveResult = z.infer<typeof objectMoveResultSchema>;
export const objectMoveResponseSchema = z.object({ results: z.array(objectMoveResultSchema) });
export type ObjectMoveResponse = z.infer<typeof objectMoveResponseSchema>;

/**
 * POST /api/admin/work-groups — one step of a table group's move from Core to
 * D1 (docs/CORE_FOLD_PLAN.md §The group move). `freeze` and
 * `unfreeze` set the group's write freeze. `copy` writes Core's rows into D1
 * in foreign-key order, from `resume` when a run stopped at its page budget.
 * `verify` compares row counts and a SHA-256 per table, Core against D1.
 * `diff` lists what D1 has that Core does not, for a rollback.
 * `repoint_merges` (group `subjects`) sends every D1 merge since the copy to
 * Core again, for the tables that stay in Core. It is safe to repeat.
 */
const workGroupTableNameSchema = z.string().trim().regex(/^[a-z_]{1,64}$/u);
export const workGroupMoveRequestSchema = z.object({
  action: z.enum(['freeze', 'unfreeze', 'copy', 'verify', 'diff', 'repoint_merges']),
  group: z.enum(WORK_GROUPS),
  /** `verify` and `diff`: one table of the group; absent is every table. */
  table: workGroupTableNameSchema.optional(),
  /** `copy`: where the run before stopped. */
  resume: z.object({ table: workGroupTableNameSchema, offset: z.number().int().min(0) }).optional(),
});
export type WorkGroupMoveRequest = z.infer<typeof workGroupMoveRequestSchema>;

export const workGroupTableReportSchema = z.object({
  table: z.string(),
  core_rows: z.number().int(),
  d1_rows: z.number().int(),
  /** SHA-256 of the table's rows on the copied columns, row and column order ignored. */
  core_sha256: z.string(),
  d1_sha256: z.string(),
  match: z.boolean(),
  /** Core rows that map to a D1 key another Core row has (a duplicate junction row). The copy keeps the last. */
  collapsed: z.number().int(),
  /**
   * `tasks` only: D1 tasks whose assignee is no person on the
   * workspace. The seed gives each Core member a person id; a task
   * held by someone it missed draws with no holder. It does not change `match`.
   */
  unknown_assignees: z.number().int().optional(),
});
export type WorkGroupTableReport = z.infer<typeof workGroupTableReportSchema>;

const workGroupCellSchema = z.union([z.string(), z.number(), z.null()]);
export const workGroupDiffSchema = z.object({
  table: z.string(),
  /** D1 rows that Core does not have, or has with other values, in D1's columns. */
  added_or_changed: z.array(z.record(z.string(), workGroupCellSchema)),
  /** Keys Core has and D1 does not: rows deleted on D1. A key is its columns joined by `|`. */
  removed: z.array(z.string()),
});
export type WorkGroupDiff = z.infer<typeof workGroupDiffSchema>;

export const workGroupMoveResponseSchema = z.object({
  group: z.enum(WORK_GROUPS),
  action: z.enum(['freeze', 'unfreeze', 'copy', 'verify', 'diff', 'repoint_merges']),
  frozen: z.boolean(),
  store: z.enum(['core', 'd1']),
  /** `copy`: rows written per table in this run. */
  copied: z.record(z.string(), z.number().int()).optional(),
  /** `copy`: where to resume, or null when every table is copied. */
  next: z.object({ table: z.string(), offset: z.number().int() }).nullable().optional(),
  /** `verify`: one report per table. */
  tables: z.array(workGroupTableReportSchema).optional(),
  /** `verify`: true when every table matches. */
  ok: z.boolean().optional(),
  /** `diff`: one entry per table. */
  diff: z.array(workGroupDiffSchema).optional(),
  /** `repoint_merges`: the merges sent, the Core rows moved, and each merge Core refused. */
  repoint: z.object({
    merges: z.number().int(),
    moved: z.number().int(),
    failed: z.array(z.object({ entity: z.string(), into_id: z.string(), code: z.string(), error: z.string() })),
  }).optional(),
});
export type WorkGroupMoveResponse = z.infer<typeof workGroupMoveResponseSchema>;

/** GET /api/admin/work-groups — every group's store, freeze and last verify. */
export const workGroupStatusSchema = z.object({
  groups: z.array(z.object({
    group: z.enum(WORK_GROUPS),
    store: z.enum(['core', 'd1']),
    frozen: z.boolean(),
    frozen_at: z.string().nullable(),
    copied_at: z.string().nullable(),
    verified_at: z.string().nullable(),
    verified_ok: z.boolean().nullable(),
  })),
});
export type WorkGroupStatus = z.infer<typeof workGroupStatusSchema>;

/**
 * One page of a Core table for the group move: Core's
 * `GET /api/public/meet-fold-export?table=&offset=&limit=` (HMAC, read-only,
 * ordered by the table's primary key). Rows are Core's columns as PostgREST
 * sends them; the Worker maps them to D1's (work-group-moves.ts).
 */
export const coreFoldExportPageSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  has_more: z.boolean(),
});
export type CoreFoldExportPage = z.infer<typeof coreFoldExportPageSchema>;

/** GET /api/admin/object-moves — where every room and inbox of this workspace is. */
export const objectMoveStatusSchema = z.object({
  jurisdiction: z.enum(['eu', 'us', 'legacy']),
  objects: z.array(z.object({
    namespace: objectMoveNamespaceSchema,
    name: z.string(),
    state: objectMoveStateSchema,
    rows_copied: z.number().int().nullable(),
    moved_at: z.number().int().nullable(),
    purged_at: z.number().int().nullable(),
  })),
});
export type ObjectMoveStatus = z.infer<typeof objectMoveStatusSchema>;

/**
 * Channels without a subject. A subject's channel outlives its
 * subject; an admin hides one whose subject Core no longer has, and can put
 * it back. Hiding does not touch the messages.
 */
export const channelSubjectKindSchema = crmSubjectKindSchema;
export type ChannelSubjectKind = z.infer<typeof channelSubjectKindSchema>;

/** POST /api/admin/channels/remove and /restore. */
export const channelRemovalSchema = z.object({
  thread_id: z.string().trim().regex(/^[A-Za-z0-9:_.-]{1,128}$/u),
});
export type ChannelRemovalInput = z.infer<typeof channelRemovalSchema>;

/** A subject channel whose subject Core answered "not found" for, by id. */
export const orphanChannelSchema = z.object({
  thread_id: z.string(),
  kind: channelSubjectKindSchema,
  title: z.string().nullable(),
  created_at: z.number().int(),
  last_message_at: z.number().int().nullable(),
  /** Messages and event lines in the channel; null when its store could not be read. */
  message_count: z.number().int().nullable(),
});
export type OrphanChannel = z.infer<typeof orphanChannelSchema>;

/** A channel an admin removed, newest removal first. */
export const removedChannelSchema = z.object({
  thread_id: z.string(),
  kind: channelSubjectKindSchema,
  title: z.string().nullable(),
  removed_at: z.number().int(),
  removed_by: z.string().nullable(),
});
export type RemovedChannel = z.infer<typeof removedChannelSchema>;

/**
 * GET /api/admin/channels/orphans. Each subject is asked for by id, a bounded
 * number per call. `not_checked` is what the bound left for a later call;
 * `check_failed` is what Core could not answer (an error, a timeout, a 5xx):
 * those are not orphans, and they are not known to be fine either.
 */
export const orphanChannelsResponseSchema = z.object({
  orphans: z.array(orphanChannelSchema),
  removed: z.array(removedChannelSchema),
  checked: z.number().int(),
  not_checked: z.number().int(),
  check_failed: z.number().int(),
});
export type OrphanChannelsResponse = z.infer<typeof orphanChannelsResponseSchema>;

/** GET /api/admin/channels/orphans: `offset` skips the channels an earlier call already checked. */
export const orphanChannelsQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const channelRemoveResponseSchema = z.object({
  thread_id: z.string(),
  removed_at: z.number().int(),
});
export type ChannelRemoveResponse = z.infer<typeof channelRemoveResponseSchema>;

export const channelRestoreResponseSchema = z.object({
  thread_id: z.string(),
  restored: z.boolean(),
});
export type ChannelRestoreResponse = z.infer<typeof channelRestoreResponseSchema>;

/**
 * One object of the daily backup, as one queue message: export the
 * object, write it to R2 under `day`. A failed job is retried by the queue; a
 * day is done when every expected object is in the bucket.
 */
export const backupObjectJobSchema = z.object({
  kind: z.literal('backup-object'),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  object: restoreObjectKindSchema,
  id: z.string().min(1).max(128),
});
export type BackupObjectJob = z.infer<typeof backupObjectJobSchema>;

/** GET /api/granola/notes?cursor= — one page of Granola's history, newest first. */
export const granolaNotesResponseSchema = z.object({
  notes: z.array(granolaNoteRowSchema),
  cursor: z.string().nullable(),
  imported_count: z.number().int(),
  indexed_at: z.number().int().nullable(),
});
export type GranolaNotesResponse = z.infer<typeof granolaNotesResponseSchema>;

/** POST /api/granola/refresh — read what Granola has that the index does not. */
export const granolaRefreshResponseSchema = z.object({
  added: z.number().int(),
  pages: z.number().int(),
});
export type GranolaRefreshResponse = z.infer<typeof granolaRefreshResponseSchema>;

/**
 * GET /api/granola/ledger — Core's side only, for the list's import poll:
 * which notes are here and how each is filed, without reading Granola again.
 * One Core read, cached a minute, where the poll used to walk every page.
 */
export const granolaLedgerResponseSchema = z.object({
  imported: z.record(z.string(), granolaImportedRecordSchema),
  imported_count: z.number().int(),
});
export type GranolaLedgerResponse = z.infer<typeof granolaLedgerResponseSchema>;

/** POST /api/granola/import */
export const granolaImportSchema = z.object({
  note_ids: z.array(z.string().trim().min(1).max(128)).min(1).max(200),
});
export const granolaImportResponseSchema = z.object({
  queued: z.number().int(),
});
export type GranolaImportResponse = z.infer<typeof granolaImportResponseSchema>;

/** PUT /api/granola/notes/:id/category — the same body as a Meet meeting's. */
export type GranolaCategoryResponse = MeetingCategoryResponse;

/**
 * Everything the one queue carries. Meet's own artifact work is keyed by room
 * and meeting; the Granola bridge is keyed by note and has neither — hence a
 * union rather than more optional fields on `ArtifactJob`.
 */
/** Everything the control plane's queue carries. The artifact job has no `kind` of its own, so it is the fallback. */
export const controlPlaneJobSchema = z.union([
  granolaNoteJobSchema,
  granolaPageJobSchema,
  granolaSuggestJobSchema,
  githubRepoJobSchema,
  slackChannelJobSchema,
  backupObjectJobSchema,
  artifactJobSchema,
]);
export type ControlPlaneJob = z.infer<typeof controlPlaneJobSchema>;

/**
 * Team presence. Ordered strongest signal first — a peer is reported at the
 * best status any of their devices can prove, and the client renders the
 * strongest one it is given rather than re-deriving anything.
 *
 * `in_meeting` and `available` are proved by the room Durable Object (an open
 * meeting, or a host lease inside the last 30s). `active` is a client
 * heartbeat. `offline` is the absence of all three.
 */
export const PEER_STATUSES = ['dnd', 'in_meeting', 'busy', 'available', 'active', 'offline'] as const;
export type PeerStatus = (typeof PEER_STATUSES)[number];
export const peerStatusSchema = z.enum(PEER_STATUSES);

/**
 * Which device a member is checked in from. A person is routinely two of these
 * at once — a Mac on the desk and a phone in the pocket — so presence carries
 * a set, not the single "last client" that a roster row used to guess from.
 */
/**
 * What a roster may say about an agent, in an agent's own words.
 *
 * Deliberately **not** `PeerStatus`. A person's presence is evidence about a
 * person — a device checked in, a calendar block, a room they are standing in.
 * An agent has none of those, and reusing the same ladder would put a green
 * dot meaning "at their desk" on a process nobody has started. Same roster,
 * different proof, so different words.
 *
 * - `working` — a runtime **accepted** a hand-off and has not answered yet.
 *   The only claim here anything has actually checked.
 * - `ready` — the roster gives it an endpoint, so a message reaches a runtime.
 *   It does not promise the runtime is up; that needs a probe.
 * - `not_connected` — no endpoint. Nothing is listening **yet**, and the
 *   message still waits in the thread, so this is not "away": an agent in this
 *   state is fully addressable and its conversation is real.
 */
export const AGENT_STATES = ['working', 'ready', 'not_connected'] as const;
export type AgentState = (typeof AGENT_STATES)[number];
export const agentStateSchema = z.enum(AGENT_STATES);

/**
 * What a person says about themselves, as opposed to what their devices can
 * prove. `PEER_STATUSES` is an evidence ladder — every rung is a fact about a
 * machine — and no rung of it can express "I am right here and I do not want
 * to be talked to", which is the one thing a roster most needs to carry.
 *
 * A second axis rather than more statuses: intent and evidence answer
 * different questions and go stale for different reasons, and collapsing them
 * would mean a self-set word outranking a room that is provably running.
 * Clients draw intent when it is set and evidence otherwise; the server keeps
 * reporting the strongest provable status either way.
 *
 * `focused` is the whole reason intent exists: a ring still lands, it just
 * lands quietly. It always carries `intent_until` and ends on its own.
 * `available` is the person answering "where are you" over a calendar block.
 *
 * Unavailable is deliberately *not* one of these. It already exists as
 * `dnd_until`, it is already enforced rather than merely drawn (`ringPeer`
 * refuses on it), and folding it in would mean teaching that check to read two
 * columns for no gain.
 */
export const PEER_INTENTS = ['available', 'focused'] as const;
export const peerIntentValueSchema = z.enum(PEER_INTENTS);
export type PeerIntent = (typeof PEER_INTENTS)[number];

/**
 * Human or agent. Nothing produces an agent row yet; the field exists now
 * because clients must render what they are told rather than assume every peer
 * is a Google account, and adding it after the first agent exists would mean
 * changing every client at once. See docs/WORK_SURFACE.md.
 */
export const PEER_KINDS = ['human', 'agent'] as const;
export type PeerKind = (typeof PEER_KINDS)[number];
export const peerKindSchema = z.enum(PEER_KINDS);

export const agentManifestSkillSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});
export type AgentManifestSkill = z.infer<typeof agentManifestSkillSchema>;

export const agentManifestToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  requires_approval: z.boolean().optional(),
});
export type AgentManifestTool = z.infer<typeof agentManifestToolSchema>;

export const agentManifestConnectionSchema = z.object({
  name: z.string(),
  /** `mcp`, `http`, `webhook`… whatever the runtime calls it. */
  protocol: z.string().optional(),
});
export type AgentManifestConnection = z.infer<typeof agentManifestConnectionSchema>;

export const agentManifestScheduleSchema = z.object({
  cron: z.string(),
  description: z.string().optional(),
});
export type AgentManifestSchedule = z.infer<typeof agentManifestScheduleSchema>;

/** A secret the agent needs, by name only, and whether it is present. Never the value. */
export const agentManifestKeySchema = z.object({
  name: z.string(),
  set: z.boolean(),
});
export type AgentManifestKey = z.infer<typeof agentManifestKeySchema>;

export const agentManifestDocSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  source: z.string().optional(),
  view_url: z.string().optional(),
  edit_url: z.string().optional(),
  required: z.boolean().optional(),
});
export type AgentManifestDoc = z.infer<typeof agentManifestDocSchema>;

/**
 * What an agent's runtime reports about itself. Rendered, never authored:
 * Meet caches what the runtime says the way it caches presence, and
 * `parseAgentManifest` clamps every field before it is stored. Treat it as
 * data from a sandbox. See docs/AGENTS_SURFACE.md §The manifest.
 */
export const agentManifestSchema = z.object({
  description: z.string(),
  model: z.string().optional(),
  skills: z.array(agentManifestSkillSchema).optional(),
  tools: z.array(agentManifestToolSchema).optional(),
  connections: z.array(agentManifestConnectionSchema).optional(),
  schedules: z.array(agentManifestScheduleSchema).optional(),
  keys: z.array(agentManifestKeySchema).optional(),
  docs: z.array(agentManifestDocSchema).optional(),
  home_url: z.string().optional(),
  readme_url: z.string().optional(),
  repo_url: z.string().optional(),
  version: z.string().optional(),
  built_at: z.number().int().optional(),
});
export type AgentManifest = z.infer<typeof agentManifestSchema>;

/** What an agent has done, from Meet's own hand-off ledger. */
export const agentActivitySchema = z.object({
  jobs_total: z.number().int(),
  jobs_30d: z.number().int(),
  resets_30d: z.number().int(),
  last_replied_at: z.number().int().nullable(),
  typical_reply_ms: z.number().int().nullable(),
});
export type AgentActivity = z.infer<typeof agentActivitySchema>;

/** Seeded character details shared by every renderer; null for people. */
export const agentAvatarIdentitySchema = z.object({
  seed: z.string().min(1).max(254),
  color: z.string().regex(/^#[\da-f]{6}$/iu),
  shape: z.string().trim().min(1).max(32),
  body_path: z.string().min(1).max(12_000),
  eyes_path: z.string().min(1).max(12_000),
});
export type AgentAvatarIdentityWire = z.infer<typeof agentAvatarIdentitySchema>;

/** When a person normally works, in their own zone. `days` is a bit set (`WORK_DAY_BITS`). */
export const peerWorkingHoursSchema = z.object({
  start_minute: z.number().int(),
  end_minute: z.number().int(),
  days: z.number().int(),
});
export type PeerWorkingHours = z.infer<typeof peerWorkingHoursSchema>;

/** A marketing version as a device reports it on its heartbeat: `5.8.1`. */
export const peerClientVersionSchema = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/u);

/**
 * The app version each device in `clients` last reported. A device that has
 * not reported one since the column existed has no key.
 */
export const peerClientVersionsSchema = z.object({
  mac: z.string().optional(),
  ios: z.string().optional(),
  web: z.string().optional(),
});
export type PeerClientVersions = z.infer<typeof peerClientVersionsSchema>;

export const peerSchema = z.object({
  email: z.string(),
  /** Opaque durable people principal used as the shared favorite reference. */
  favorite_ref: z.string().min(1).optional(),
  name: z.string().nullable(),
  kind: peerKindSchema,
  /** The room this person hosts, or null when they have none mapped. */
  room_slug: z.string().nullable(),
  /** The room they are in right now, theirs or somebody else's. */
  in_room_slug: z.string().nullable(),
  status: peerStatusSchema,
  /** An agent's own state, and null for a person. */
  agent_state: agentStateSchema.nullable(),
  /** When the evidence behind `status` was recorded. Null when offline. */
  since: z.number().int().nullable(),
  /** The last beat from any device, always present. */
  last_seen_at: z.number().int(),
  /** Which client last checked in. */
  last_client: z.string().nullable(),
  /** Every device checked in inside the active window. */
  clients: z.array(peerClientSchema),
  /** The app version per device in `clients`. Absent from a Worker that predates it. */
  client_versions: peerClientVersionsSchema.optional(),
  busy_until: z.number().int().nullable(),
  dnd_until: z.number().int().nullable(),
  intent: peerIntentValueSchema.nullable(),
  intent_until: z.number().int().nullable(),
  /** Self-set "appear offline". True only on the reader's own row. */
  invisible: z.boolean(),
  avatar_updated_at: z.number().int().nullable(),
  /** Meet-generated identity for agents; human profile photos keep their own path. */
  agent_avatar: agentAvatarIdentitySchema.nullable().optional(),
  participants: z.number().int(),
  is_self: z.boolean(),
  /** IANA zone, or null for somebody whose clients predate this. */
  timezone: z.string().nullable(),
  working_hours: peerWorkingHoursSchema.nullable(),
  title: z.string().nullable(),
  pronouns: z.string().nullable(),
  manifest: agentManifestSchema.nullable(),
  activity: agentActivitySchema.nullable(),
});
export type Peer = z.infer<typeof peerSchema>;

/**
 * Minutes from local midnight, plus which days. Minutes rather than a clock
 * string so a client compares two integers instead of parsing; local rather
 * than UTC so the pattern survives the person travelling, which is the whole
 * reason it is stored apart from `timezone`.
 */
/**
 * Somebody asked for you while you were not looking. Delivered on the roster
 * poll rather than pushed — there is no APNs registration and deliberately no
 * sound, so this reaches a client that is running and foregrounded, and
 * nothing else. Never treat it as a guarantee that a person was reached.
 */
export const RING_KINDS = ['wave', 'call', 'agent_start'] as const;
export type RingKind = (typeof RING_KINDS)[number];
export const ringKindSchema = z.enum(RING_KINDS);

/**
 * `agent_start` is the member's own Claude asking them to open their own room
 * (docs/MCP.md §start_meeting): the `caller` is the paired client,
 * the `room_slug` is the member's own. It rides `rings` because it is the
 * same gesture a call is — an ask with a 45-second life that opens no
 * microphone on its own. A build that has not heard of it reads it as a
 * wave, which is the harmless one.
 */
export const incomingRingSchema = z.object({
  kind: ringKindSchema,
  caller_email: z.string(),
  caller_name: z.string().nullable(),
  /** The room to open: the caller's on a call, the reader's own on `agent_start`; null on a wave. */
  room_slug: z.string().nullable(),
  created_at: z.number().int(),
  expires_at: z.number().int(),
});
export type IncomingRing = z.infer<typeof incomingRingSchema>;

/**
 * Envisioning-only. Presence is never exposed to guests or unauthenticated
 * callers — see docs/PRIVACY.md.
 */
export const peersResponseSchema = z.object({
  generated_at: z.number().int(),
  peers: z.array(peerSchema),
  /** The one ring aimed at the reader that is still live, or null. */
  incoming_ring: incomingRingSchema.nullable(),
});
export type PeersResponse = z.infer<typeof peersResponseSchema>;

/**
 * What changed after a picture was uploaded or removed. The bytes are never in
 * a JSON body — this is the new cache key, which is the only thing a client
 * needs in order to redraw itself and everyone else's copy of it.
 *
 * `PUT /api/profile/avatar`, `DELETE /api/profile/avatar` -> 200
 */
/**
 * `GET /api/avatar?email=&v=`: one colleague's picture. `v` is their
 * `avatar_updated_at`; it changes nothing about which bytes come back, it
 * only tells the caller it may keep them.
 */
export const avatarQuerySchema = z.object({
  email: emailSchema,
  v: z.string().trim().max(32).optional(),
});

export const avatarResponseSchema = z.object({
  email: z.string(),
  avatar_updated_at: z.number().int().nullable(),
});
export type AvatarResponse = z.infer<typeof avatarResponseSchema>;

/**
 * The image formats a profile picture may be. Sniffed from the bytes, never
 * trusted from `content-type`: this is the one route that stores something a
 * person sent and hands it back to their colleagues, so what is stored has to
 * be what the header claims. HEIC is deliberately absent — clients re-encode
 * when they downscale, and nothing but Apple platforms could draw it.
 */
/**
 * A picture attached to a GitHub issue.
 *
 * GitHub has no public API for attaching a file to an issue, so Meet keeps the
 * bytes and the issue body carries a markdown image link at this URL. The
 * address is readable without a session — github.com renders an issue body for
 * whoever is looking at it — which is why the id is 128 bits of random and why
 * PRIVACY.md says what that means.
 */
export const issueImageResponseSchema = z.object({
  id: z.string(),
  /** Where the picture is served from, for the issue body. */
  url: z.string(),
});
export type IssueImageResponse = z.infer<typeof issueImageResponseSchema>;

/**
 * A screenshot is a fraction of this. Deliberately below the thread attachment
 * ceiling: an issue picture is evidence, not a video.
 */
export const ISSUE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export const AVATAR_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number];

/**
 * A zone the device reported, checked against the runtime's own list rather
 * than a regex. A shape test would accept 'Europe/Atlantis', and a zone that
 * parses but does not exist fails later, on a client, while formatting
 * somebody's local time.
 */
export const timezoneSchema = z.string().trim().min(1).max(64).refine((zone) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, 'Unknown time zone.');

export const peerHeartbeatSchema = z.object({
  client: z.enum(PEER_CLIENTS).optional(),
  /**
   * Whatever zone this device is set to. Reported on every beat rather than
   * asked for once: the answer changes when somebody travels, and the device
   * already knows. It never overwrites a zone the person set themselves —
   * see `timezone_source` in migration 0010.
   */
  timezone: timezoneSchema.optional(),
  /**
   * This client's marketing version. The browser sends it here; the native
   * clients already send it in the `x-meet-client` header, which the Worker
   * reads when this is absent.
   */
  version: peerClientVersionSchema.optional(),
});

const workMinuteSchema = z.number().int().min(0).max(1439);

/**
 * The parts of a person's row they own. Every field optional and separately
 * clearable: a client that only edits a title must not blank a zone it never
 * showed, which is what a whole-object PUT would do.
 */
export const peerProfileSchema = z.object({
  title: z.string().trim().max(80).nullable().optional(),
  pronouns: z.string().trim().max(40).nullable().optional(),
  /** Setting this pins it: check-ins stop moving the zone afterwards. */
  timezone: timezoneSchema.nullable().optional(),
  /**
   * Both ends and the days, or null to say nothing. Refused as a partial —
   * a start with no end is a window with no close, and every surface reading
   * it would have to invent the missing half.
   */
  working_hours: z.object({
    start_minute: workMinuteSchema,
    end_minute: workMinuteSchema,
    days: z.number().int().min(0).max(127),
  }).nullable().optional(),
});
export type PeerProfileInput = z.infer<typeof peerProfileSchema>;

export const peerRingSchema = z.object({
  peer_email: emailSchema,
});

export const peerCallSchema = z.object({
  peer_email: emailSchema,
});

export const peerDoNotDisturbSchema = z.object({
  /** Absolute expiry, or null to clear. An unavailable with no end is one nobody clears. */
  until: z.number().int().nonnegative().nullable(),
});

/** POST /api/peers/dnd -> 200: what the row now says. Null when it was cleared or already past. */
export const peerDoNotDisturbResponseSchema = z.object({
  dnd_until: z.number().int().nullable(),
});
export type PeerDoNotDisturbResponse = z.infer<typeof peerDoNotDisturbResponseSchema>;

export const peerAppearOfflineSchema = z.object({
  /** Sticky: true until the same person sends false. */
  invisible: z.boolean(),
});

/** POST /api/peers/appear-offline -> 200 */
export const peerAppearOfflineResponseSchema = z.object({
  invisible: z.boolean(),
});
export type PeerAppearOfflineResponse = z.infer<typeof peerAppearOfflineResponseSchema>;

export const peerIntentSchema = z.object({
  /** Null clears it, and the roster falls back to what the devices prove. */
  intent: peerIntentValueSchema.nullable(),
  /**
   * Absolute expiry. Required with `focused` and refused with anything else:
   * a focus with no end is one nobody turns off, and a timeboxed `available`
   * is a question with no honest answer.
   */
  until: z.number().int().nonnegative().nullable().optional(),
}).refine(
  (body) => (body.intent === 'focused') === (typeof body.until === 'number'),
  { message: 'focused needs an until, and nothing else takes one' },
);

/** POST /api/peers/intent -> 200: what the row now says. `intent_until` is set only with `focused`. */
export const peerIntentResponseSchema = z.object({
  intent: peerIntentValueSchema.nullable(),
  intent_until: z.number().int().nullable(),
});
export type PeerIntentResponse = z.infer<typeof peerIntentResponseSchema>;

/**
 * Threads. A DM has no parent; a thread on a subject or a meeting carries
 * one. The parent is polymorphic from the first schema on purpose — messages
 * are meant to be rows on the work graph, not a channel list, and that is
 * the one shape that cannot be retrofitted cheaply. `event` is a CMS event's
 * channel, on its CMS id (docs/EVENTS.md). `guest` is a subject's guest
 * thread, shared by members and the guests granted on it; its parent is
 * `<kind>:<id>` (docs/ACCESS.md slice 4). The subject's own channel stays
 * members only.
 * See docs/WORK_SURFACE.md.
 */
export const THREAD_KINDS = ['dm', 'project', 'lead', 'organization', 'team', 'meeting', 'event', 'guest'] as const;
export const threadKindSchema = acceptingKindAliases(z.enum(THREAD_KINDS));
export type ThreadKind = (typeof THREAD_KINDS)[number];

/**
 * Who a thread is addressed to, and therefore who may read it.
 *
 * `members` is a DM: the membership row *is* the authorization. `everyone` is a
 * channel: any Envisioning member may read and write it, and the membership row
 * degrades to read state, written the first time somebody opens it. Writing
 * every member into every project instead would mean rewriting them whenever
 * somebody joins the company. See docs/CHANNELS.md.
 */
export const THREAD_AUDIENCES = ['members', 'everyone'] as const;
export type ThreadAudience = (typeof THREAD_AUDIENCES)[number];
export const threadAudienceSchema = z.enum(THREAD_AUDIENCES);

/** Channels — the kinds no one person owns. */
export const CHANNEL_THREAD_KINDS: readonly ThreadKind[] = ['project', 'lead', 'organization', 'event', 'team'];

/**
 * The one company-wide channel, and the only one that hangs off no CRM subject.
 * A fixed id because there is exactly one of it: deriving or minting one would
 * allow a second.
 */
export const TEAM_THREAD_ID = 'team';
export const TEAM_THREAD_TITLE = 'Everyone';

/**
 * `text` is somebody typing. `event` is the work graph reporting itself — a
 * meeting logged against this project, a task closed, an issue opened. Both are
 * messages in one ordered transcript, because a channel where the automatic
 * half lives somewhere else is two channels.
 */
export const THREAD_MESSAGE_TYPES = ['text', 'event'] as const;
export type ThreadMessageType = (typeof THREAD_MESSAGE_TYPES)[number];
export const threadMessageTypeSchema = z.enum(THREAD_MESSAGE_TYPES);

/**
 * What an event line is about, so a client can open the thing rather than
 * parse the prose. Kinds are the work-graph rows a channel reports on; ids
 * are the owning system's — a Meet meeting id, a Core task id, a GitHub
 * issue reference.
 */
export const THREAD_MESSAGE_REF_KINDS = [
  'meeting',
  'task',
  'issue',
  // GitHub, beyond issues. Ids are GitHub's own, qualified by the
  // repository so a chip can open github.com without a lookup:
  // `owner/repo#N` (pull), `owner/repo@sha` (commit), `owner/repo!runId`
  // (run), `owner/repo@tag` (release).
  'pull',
  'commit',
  'run',
  'release',
  // A decision recorded on the subject, and the goal a line is about (#262). Ids are Core's.
  'decision',
  'goal',
] as const;
export type ThreadMessageRefKind = (typeof THREAD_MESSAGE_REF_KINDS)[number];
export const threadMessageRefKindSchema = z.enum(THREAD_MESSAGE_REF_KINDS);

export const threadMessageRefSchema = z.object({
  kind: threadMessageRefKindSchema,
  id: z.string(),
});
export type ThreadMessageRef = z.infer<typeof threadMessageRefSchema>;

/**
 * The github.com page a GitHub ref names, or null for a ref that is not one
 * (a meeting, a task) or one whose id does not parse. Shared by the web and
 * mirrored in Swift (`ThreadMessageRef.githubURL`), so the three clients
 * open the same page for the same chip.
 */
export function githubURLForRef(ref: ThreadMessageRef): string | null {
  const [slug, rest] = splitRef(ref.id, ref.kind);
  if (!slug || !rest) return null;
  const [owner, repo] = slug.split('/');
  if (!owner || !repo) return null;
  switch (ref.kind) {
    case 'issue': return `https://github.com/${owner}/${repo}/issues/${rest}`;
    case 'pull': return `https://github.com/${owner}/${repo}/pull/${rest}`;
    case 'commit': return `https://github.com/${owner}/${repo}/commit/${rest}`;
    case 'run': return `https://github.com/${owner}/${repo}/actions/runs/${rest}`;
    case 'release': return `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(rest)}`;
    default: return null;
  }
}

function splitRef(id: string, kind: ThreadMessageRefKind): [string | null, string | null] {
  const separator = kind === 'issue' || kind === 'pull' ? '#' : kind === 'run' ? '!' : kind === 'commit' || kind === 'release' ? '@' : null;
  if (!separator) return [null, null];
  const at = id.lastIndexOf(separator);
  if (at <= 0) return [null, null];
  return [id.slice(0, at), id.slice(at + 1)];
}

/**
 * The sender every event line carries. Not a member: an event is the work
 * graph reporting itself, and attributing it to whoever happened to trigger
 * it would make their own channel read as if they had typed there.
 */
export const THREAD_EVENT_SENDER = {
  sub: 'system:meet',
  email: SYSTEM_SENDER_EMAIL,
  name: 'Starlings',
} as const;

/**
 * How many people one private conversation may hold, counting yourself.
 *
 * A ceiling rather than a policy: past this many people the thing being asked
 * for is the company channel, which already exists and is one tap away. It
 * also bounds the id derivation and the roster a client draws in a title.
 */
export const threadMessageAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  content_type: z.string(),
  bytes: z.number().int().nonnegative(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
});
export type ThreadMessageAttachment = z.infer<typeof threadMessageAttachmentSchema>;

export const threadMessageReactionSchema = z.object({
  emoji: z.string(),
  count: z.number().int().nonnegative(),
  is_mine: z.boolean(),
  /** First names of who reacted, for the tooltip. */
  reactors: z.array(z.string()),
});
export type ThreadMessageReaction = z.infer<typeof threadMessageReactionSchema>;

export const THREAD_QUESTION_MAX_OPTIONS = 8;
export const threadQuestionModeSchema = z.enum(['single', 'multiple']);
export const threadQuestionOptionSchema = z.object({
  id: z.string().trim().min(1).max(48).regex(/^[a-z0-9][a-z0-9_-]*$/u),
  label: z.string().trim().min(1).max(120),
});
/**
 * What a hand-off asks for (docs/OWNERSHIP.md decision 12): what
 * done looks like, and what comes back. The person who accepts the card at
 * Review reads it in the same thread. Both are required on a Hand off.
 */
export const threadHandoffSchema = z.object({
  done_when: z.string().trim().min(1).max(1_000),
  deliverable: z.string().trim().min(1).max(500),
});
export type ThreadHandoff = z.infer<typeof threadHandoffSchema>;

export const threadQuestionSchema = z.object({
  mode: threadQuestionModeSchema,
  options: z.array(threadQuestionOptionSchema).min(2).max(THREAD_QUESTION_MAX_OPTIONS),
}).superRefine((question, ctx) => {
  const ids = question.options.map((option) => option.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Question option ids must be unique.' });
  }
});
export type ThreadQuestion = z.infer<typeof threadQuestionSchema>;

export const threadQuestionAnswerSchema = z.object({
  question_message_id: z.string(),
  // Empty arrays are the withdrawn-answer tombstone; the write request still
  // requires one or more options below.
  option_ids: z.array(z.string()).max(THREAD_QUESTION_MAX_OPTIONS),
  /** Snapshotted labels keep the answer readable if it is loaded without its question. */
  option_labels: z.array(z.string().trim().min(1).max(120)).max(THREAD_QUESTION_MAX_OPTIONS),
}).superRefine((answer, ctx) => {
  if (new Set(answer.option_ids).size !== answer.option_ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['option_ids'], message: 'Question answers cannot repeat an option.' });
  }
  if (answer.option_ids.length !== answer.option_labels.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['option_labels'], message: 'Each selected option needs one label.' });
  }
});
export type ThreadQuestionAnswer = z.infer<typeof threadQuestionAnswerSchema>;

/**
 * An agent's request for one Keep item, for one task (ADR 0007 decisions 5
 * and 10 to 12;). The agent names the item, never a
 * value, and sends the public half of a P-256 key it made for this one
 * request. A member of the item's vault approves on Mac or iPhone: that
 * device unlocks Keep, seals the item to `session_public_key` and posts the
 * release to Keep with `request_id` as its id. Meet stores the request and
 * the card's state, never the item and never a key that opens it.
 */
export const RELEASE_REQUEST_MIN_SECONDS = 60;
export const RELEASE_REQUEST_MAX_SECONDS = 24 * 60 * 60;
/** ADR 0007 decision 11. The approver may choose longer, up to the maximum. */
export const RELEASE_REQUEST_DEFAULT_SECONDS = 15 * 60;
export const threadReleaseRequestSchema = z.object({
  /** A lowercase UUID the agent chose. Keep's release id, so the agent knows what to fetch. */
  request_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
  /** The vault: its Keep id or its name. */
  vault: z.string().trim().min(1).max(120),
  /** The item: its Keep id or its name. Never a value. */
  item: z.string().trim().min(1).max(200),
  task: z.string().trim().min(1).max(500),
  reason: z.string().trim().min(1).max(1000),
  /** How long the agent asks for. The approver decides. */
  expires_in_seconds: z.number().int().min(RELEASE_REQUEST_MIN_SECONDS).max(RELEASE_REQUEST_MAX_SECONDS).optional(),
  /** Raw P-256 public key (65-byte uncompressed point), base64url. */
  session_public_key: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/u),
});
export type ThreadReleaseRequest = z.infer<typeof threadReleaseRequestSchema>;

export const THREAD_RELEASE_STATUSES = ['approved', 'used', 'ended'] as const;
export const threadReleaseStatusSchema = z.enum(THREAD_RELEASE_STATUSES);
/** What the card shows after a member acted. No state means the request waits. */
export const threadReleaseStateSchema = z.object({
  status: threadReleaseStatusSchema,
  approver_email: z.string(),
  approver_name: z.string().nullable(),
  approved_at: z.number().int(),
  /** When Keep refuses the fetch. Past it the card reads as expired. */
  expires_at: z.number().int(),
  /** The Keep vault the approver resolved, so End now can name it. */
  vault_id: z.string(),
  item_name: z.string(),
  used_at: z.number().int().optional(),
  ended_at: z.number().int().optional(),
  ended_by_email: z.string().optional(),
});
export type ThreadReleaseState = z.infer<typeof threadReleaseStateSchema>;

/**
 * `POST /api/threads/:id/releases/:message_id`, from the device that acted in
 * Keep, after Keep answered: `approve` once the release exists, `end` once it
 * is ended. The Worker reads the release from Keep (as the card's agent) and
 * records what Keep says: the approver, the item, the expiry. A card never
 * says more than Keep does.
 */
export const threadReleaseActionSchema = z.enum(['approve', 'end']);
export const threadReleaseUpdateRequestSchema = z.object({
  action: threadReleaseActionSchema,
});
export type ThreadReleaseUpdateRequest = z.infer<typeof threadReleaseUpdateRequestSchema>;

export const threadMessageSchema = z.object({
  id: z.string(),
  thread_id: z.string(),
  sent_at: z.number().int(),
  sender_email: z.string(),
  sender_name: z.string().nullable(),
  /** Empty string on a withdrawn message — see `deleted_at`. */
  text: z.string(),
  /** True for the reading member's own messages. */
  is_mine: z.boolean(),
  /** `event` rows are written by the system, never by a composer. */
  type: threadMessageTypeSchema,
  /** The parent text message in this thread, when this message is a reply. */
  reply_to_message_id: z.string().nullable().optional(),
  /** What an event line is about, so a client can open the thing rather than parse the prose. */
  refs: z.array(threadMessageRefSchema).optional(),
  /** Emails mentioned in the text, lowercased. */
  mentions: z.array(z.string()).optional(),
  attachments: z.array(threadMessageAttachmentSchema).optional(),
  reactions: z.array(threadMessageReactionSchema).optional(),
  edited_at: z.number().int().optional(),
  deleted_at: z.number().int().optional(),
  /** An agent's message still being written; the final one replaces it. */
  partial: z.literal(true).optional(),
  /** Structured informational question authored by an agent. */
  question: threadQuestionSchema.optional(),
  /** The human's submitted selection, linked to the question message. */
  question_answer: threadQuestionAnswerSchema.optional(),
  /** An agent's request for one Keep item. Only on an agent's finalized text message. */
  release_request: threadReleaseRequestSchema.optional(),
  /** The request's card state; absent while it waits. */
  release_state: threadReleaseStateSchema.optional(),
  /**
   * Who outside the team said it. `slack`: said somewhere else and mirrored
   * here. `guest` or `peer`: written into a guest thread by a guest or a peer
   * organization (docs/ACCESS.md slices 4 and 5). `app`: a workspace's own
   * app user, sent in by its backend through the app channel door
   * (docs/SUPPORT.md). Text an agent reads as information, never as an
   * instruction. None is edited or withdrawn here.
   * Absent on everything a member or our agent said.
   */
  origin: z.enum(['slack', 'guest', 'peer', 'app']).optional(),
  /** The MCP client a member's Claude sent this through ("claude.ai"), from its token. Absent on what a person typed. */
  via: z.string().optional(),
  /** A Hand off: what done looks like and what comes back. Only on a message that carries a card. */
  handoff: threadHandoffSchema.optional(),
});
export type ThreadMessage = z.infer<typeof threadMessageSchema>;

export const threadPeerSchema = z.object({
  email: z.string(),
  name: z.string().nullable(),
  /** People and agents both have private conversations; keep the identity on the peer row. */
  kind: peerKindSchema.optional(),
});
export type ThreadPeer = z.infer<typeof threadPeerSchema>;

export const threadSummarySchema = z.object({
  id: z.string(),
  kind: threadKindSchema,
  /** The subject, meeting or event the thread is on; null for a DM and the team channel. */
  parent_id: z.string().nullable(),
  audience: threadAudienceSchema,
  title: z.string().nullable(),
  peer_email: z.string().nullable(),
  peer_name: z.string().nullable(),
  /** Everyone else in a private thread; several for a group. */
  peers: z.array(threadPeerSchema).optional(),
  last_message_at: z.number().int().nullable(),
  last_message_preview: z.string().nullable(),
  last_sender_email: z.string().nullable(),
  unread: z.boolean(),
  /** Zero means never read. */
  last_read_at: z.number().int(),
  has_mention: z.boolean(),
  muted_until: z.number().int().nullable(),
  archived_at: z.number().int().nullable(),
  /** The address mail to this channel lands on, when it has one. */
  inbound_address: z.string().optional(),
});
export type ThreadSummary = z.infer<typeof threadSummarySchema>;

/** `GET /api/threads` */
export const threadsResponseSchema = z.object({
  threads: z.array(threadSummarySchema),
});
export type ThreadsResponse = z.infer<typeof threadsResponseSchema>;

/** `POST /api/threads`: the thread named, opened or found. */
export const threadResponseSchema = z.object({
  thread: threadSummarySchema,
});
export type ThreadResponse = z.infer<typeof threadResponseSchema>;

/** `GET /api/threads/:id/messages` */
export const threadMessagesResponseSchema = z.object({
  thread: threadSummarySchema,
  messages: z.array(threadMessageSchema),
  /** Pass as `before` for the page above; null at the top. */
  older_cursor: z.string().nullable(),
});
export type ThreadMessagesResponse = z.infer<typeof threadMessagesResponseSchema>;

/**
 * `GET /api/card-lines?kind=&id=`: what was said about one task
 * or issue, across every thread that named it, oldest first. The hand-off,
 * the agent's steps, questions and answers, and the event lines. A line in a
 * thread the reader cannot open is left out.
 */
export const cardLinesQuerySchema = z.object({
  kind: z.enum(['task', 'issue']),
  id: z.string().trim().min(1).max(200),
});
export type CardLinesQuery = z.infer<typeof cardLinesQuerySchema>;

export const cardLinesResponseSchema = z.object({
  lines: z.array(threadMessageSchema),
});
export type CardLinesResponse = z.infer<typeof cardLinesResponseSchema>;

/** Compact changes returned by `GET /api/threads/:id/messages?since=`. */
export const threadMessageChangeSchema = z.object({
  id: z.string(),
  changed_at: z.number().int(),
  change: z.enum(['created', 'updated', 'deleted']),
  summary: z.string(),
  actor: z.object({ name: z.string().nullable(), email: z.string().email() }),
});
export const threadMessagesSinceResponseSchema = z.object({
  thread_id: z.string(),
  changes: z.array(threadMessageChangeSchema),
  has_more: z.boolean(),
});
export type ThreadMessagesSinceResponse = z.infer<typeof threadMessagesSinceResponseSchema>;

/** `GET /api/threads/messages?since=` — the member-scoped cross-thread message feed. */
export const threadChangesQuerySchema = z.object({
  since: z.string().trim().min(1).max(512),
  limit: z.coerce.number().int().min(1).max(MCP_CHANGES_PAGE_SIZE).optional(),
});
export const threadChangeSourceRowSchema = threadMessageChangeSchema.extend({
  thread_id: z.string(),
});
export const threadChangesResponseSchema = z.object({
  changes: z.array(threadChangeSourceRowSchema),
  has_more: z.boolean(),
});
export type ThreadChangesResponse = z.infer<typeof threadChangesResponseSchema>;

/** `POST /api/threads/:id/messages` (201) */
export const sentMessageResponseSchema = z.object({
  message: threadMessageSchema,
});
export type SentMessageResponse = z.infer<typeof sentMessageResponseSchema>;

/** `POST /api/threads/:id/releases/:message_id`: the card as it now reads. */
export const threadReleaseUpdateResponseSchema = z.object({
  message: threadMessageSchema,
});
export type ThreadReleaseUpdateResponse = z.infer<typeof threadReleaseUpdateResponseSchema>;

/** `POST /api/threads/:id/questions/:message_id/answer` */
export const threadQuestionAnswerResponseSchema = z.object({
  message: threadMessageSchema,
  /** False when another valid answer arrived first; `message` is the winner. */
  accepted: z.boolean(),
});
export type ThreadQuestionAnswerResponse = z.infer<typeof threadQuestionAnswerResponseSchema>;

/** `POST /api/threads/:id/read` */
export const threadReadResponseSchema = z.object({
  ok: z.literal(true),
  read_at: z.number().int(),
});
export type ThreadReadResponse = z.infer<typeof threadReadResponseSchema>;

/** `POST /api/threads/:id/archive` */
export const threadArchiveResponseSchema = z.object({
  ok: z.literal(true),
  archived_at: z.number().int().nullable(),
});
export type ThreadArchiveResponse = z.infer<typeof threadArchiveResponseSchema>;

/** `POST /api/threads/:id/mute` */
export const threadMuteResponseSchema = z.object({
  ok: z.literal(true),
  muted_until: z.number().int().nullable(),
});
export type ThreadMuteResponse = z.infer<typeof threadMuteResponseSchema>;

/** `PATCH /api/threads/:id/messages/:mid` */
export const messageEditResponseSchema = z.object({
  message_id: z.string(),
  text: z.string(),
  edited_at: z.number().int(),
});
export type MessageEditResponse = z.infer<typeof messageEditResponseSchema>;

/** `DELETE /api/threads/:id/messages/:mid` */
export const messageWithdrawResponseSchema = z.object({
  message_id: z.string(),
  deleted_at: z.number().int(),
});
export type MessageWithdrawResponse = z.infer<typeof messageWithdrawResponseSchema>;

/**
 * Where to put the bytes. A path rather than a URL: the client resolves it
 * against the origin it is already talking to, so a Mac on the local stack
 * and a phone on production upload to the right place without a second
 * origin, and a server-rendered origin is one more place for a deployment to
 * disagree with itself. `POST /api/threads/:id/attachments` -> 201
 */
export const attachmentStagedResponseSchema = z.object({
  attachment: threadMessageAttachmentSchema,
  upload_path: z.string(),
});
export type AttachmentStagedResponse = z.infer<typeof attachmentStagedResponseSchema>;

/** `PUT` on the staged path: the bytes landed. */
export const attachmentUploadedResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type AttachmentUploadedResponse = z.infer<typeof attachmentUploadedResponseSchema>;

/** `POST /api/threads/:id/messages/:mid/reactions` -> 200 */
export const messageReactionsResponseSchema = z.object({
  message_id: z.string(),
  reactions: z.array(threadMessageReactionSchema),
});
export type MessageReactionsResponse = z.infer<typeof messageReactionsResponseSchema>;

export const THREAD_GROUP_MAX_MEMBERS = 12;

/**
 * Open a conversation. A DM is addressed by naming a person; a channel is
 * addressed by naming what it is about. `project` and `lead` join this union
 * once the Worker can resolve a subject id against Core.
 */
export const threadCreateDirectSchema = z.object({ peer_email: emailSchema });
export const threadCreateGroupSchema = z.object({
  peer_emails: z.array(emailSchema).min(1).max(THREAD_GROUP_MAX_MEMBERS - 1),
});
export const threadCreateTeamSchema = z.object({ kind: z.literal('team') });
export const threadCreateSubjectSchema = z.object({
  // An organization's channel hangs off its organization id ( slice 4,
  // PARTNERS (HQ Docs)), an event's off its CMS id (docs/EVENTS.md): the
  // same door as a project's, resolved by Core.
  kind: crmSubjectKindSchema,
  /** A Core subject id. The Worker resolves it; the client never sends a title. */
  subject_id: z.string().uuid(),
});
export const threadCreateSchema = z.union([
  threadCreateDirectSchema,
  /**
   * A private conversation among several people.
   *
   * The same kind as a DM, deliberately, and not a channel: the membership row
   * already *is* the authorization, so a group needs no new concept, has no
   * name, and cannot sprawl the way a channel can — it is a conversation
   * between named people, and there is nothing to browse. See CHANNELS.md's
   * no-user-created-channels invariant, which this does not touch.
   *
   * The id is derived from the members, so naming the same people twice opens
   * the same conversation. Two addresses derive exactly the id `peer_email`
   * already derives, which is why this needs no migration.
   */
  threadCreateGroupSchema,
  threadCreateTeamSchema,
  threadCreateSubjectSchema,
]);
export type ThreadCreateInput = z.infer<typeof threadCreateSchema>;

/** A ref as a client sends one: the same shape, with the id bounded. */
export const threadMessageRefInputSchema = z.object({
  kind: threadMessageRefKindSchema,
  id: z.string().trim().min(1).max(200),
});

export const threadMessageSendSchema = z.object({
  /**
   * Empty only when something is attached. A message with no text and no file
   * is a keystroke, and refusing it here is cheaper than every surface
   * learning to draw a blank row.
   */
  text: z.string().trim().max(MESSAGE_TEXT_MAX_CHARS).default(''),
  /**
   * What this message is about, when it was composed from a task or an issue
   * rather than from an empty box. The client sends the id it was already
   * looking at; nothing here is resolved, because a ref is a pointer and a
   * pointer to something you cannot open is a dead chip, not a leak.
   */
  refs: z.array(threadMessageRefInputSchema).max(THREAD_MESSAGE_REF_MAX).optional(),
  /**
   * Who this names. Addresses rather than the '@handles' in the body: the text
   * is what a person wrote and may be edited, and delivery must not depend on
   * re-parsing prose. Non-members are dropped at the Worker rather than
   * refused — a stale mention is a typo, not a failed send.
   */
  mentions: z.array(emailSchema).max(MESSAGE_MENTION_MAX).optional(),
  /** Ids from a completed upload. The bytes are already in storage by now. */
  attachments: z.array(z.string().trim().min(8).max(64)).max(ATTACHMENT_MAX_PER_MESSAGE).optional(),
  /** A reply stays inside this conversation; the Worker validates its parent. */
  reply_to_message_id: z.string().nullable().optional(),
  /** A Hand off of the card in `refs` to the agent in this conversation. */
  handoff: threadHandoffSchema.optional(),
}).refine(
  (body) => body.text.length > 0 || (body.attachments?.length ?? 0) > 0,
  { message: 'A message needs text or an attachment.', path: ['text'] },
).refine(
  (body) => !body.handoff || (body.refs ?? []).some((ref) => ref.kind === 'task' || ref.kind === 'issue'),
  { message: 'A hand-off names the card it hands off.', path: ['handoff'] },
);

/** `POST /api/threads/:id/questions/:message_id/answer` */
export const threadQuestionAnswerRequestSchema = z.object({
  option_ids: z.array(z.string().trim().min(1).max(48)).min(1).max(THREAD_QUESTION_MAX_OPTIONS),
}).superRefine((answer, ctx) => {
  if (new Set(answer.option_ids).size !== answer.option_ids.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['option_ids'], message: 'Question answers cannot repeat an option.' });
  }
});
export type ThreadQuestionAnswerRequest = z.infer<typeof threadQuestionAnswerRequestSchema>;

/**
 * Free-form rather than the fixed palette in `reactions.ts`, and the
 * difference is the audience. That one animates across a live meeting where
 * guests are present and nothing is attributed, so it can only ever be one of
 * six pictures. This one is a pill on a row, in a thread only members can
 * read, with a name behind every count — the argument for a closed list never
 * applied here.
 *
 * The pattern is the guard: pictographic characters and the joiners that build
 * one glyph out of several. A short string of letters would otherwise turn a
 * reaction rail into a second composer with no attribution in the transcript.
 */
export const messageReactionSchema = z.object({
  emoji: z.string().trim().min(1).max(MESSAGE_REACTION_EMOJI_MAX_CHARS)
    .regex(/^[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f]+$/u, 'Reactions are emoji.'),
});

export const threadMessageEditSchema = z.object({
  text: z.string().trim().min(1).max(MESSAGE_TEXT_MAX_CHARS),
});

/**
 * Put a conversation away, or take it back out.
 *
 * Per-member, like a mute. There is no archive to browse: the roster is
 * already the index, so an archived DM is reopened by clicking the person —
 * exactly the way every DM was reached before they had list rows at all.
 */
export const threadArchiveSchema = z.object({
  archived: z.boolean(),
}).strict();
export type ThreadArchiveInput = z.infer<typeof threadArchiveSchema>;

export const threadMuteSchema = z.object({
  /** Absolute expiry, or null to unmute. Same shape as unavailable. */
  until: z.number().int().nonnegative().nullable(),
});
export type ThreadMuteInput = z.infer<typeof threadMuteSchema>;

/**
 * What may be attached. Deliberately a list and not a wildcard: an upload is
 * served back to colleagues from an origin that also serves the app, and the
 * set of types a browser will happily execute is not one to discover by
 * accident. Anything unlisted still travels — as `application/octet-stream`,
 * which downloads rather than renders.
 */
export const ATTACHMENT_INLINE_CONTENT_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic',
  'application/pdf',
  'text/plain', 'text/markdown', 'text/csv',
  'video/mp4', 'video/quicktime',
  'audio/mpeg', 'audio/mp4', 'audio/wav',
] as const;
export type AttachmentInlineContentType = (typeof ATTACHMENT_INLINE_CONTENT_TYPES)[number];

/**
 * Ask for somewhere to put one file. The client sends what it has and gets an
 * id back; the bytes go up separately and the id only becomes a visible part
 * of a conversation when a message carries it. An upload nobody sends is
 * therefore inert, which is what makes an abandoned composer cost nothing.
 */
export const attachmentCreateSchema = z.object({
  name: z.string().trim().min(1).max(ATTACHMENT_NAME_MAX_CHARS),
  content_type: z.string().trim().min(3).max(120),
  bytes: z.number().int().positive().max(ATTACHMENT_MAX_BYTES),
  width: z.number().int().positive().max(65_535).optional(),
  height: z.number().int().positive().max(65_535).optional(),
});
export type AttachmentCreateInput = z.infer<typeof attachmentCreateSchema>;

export const threadMessagesQuerySchema = z.object({
  before: z.string().trim().max(64).optional(),
  since: z.string().trim().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MESSAGE_PAGE_MAX).optional(),
});

export const threadReadSchema = z.object({
  at: z.number().int().nonnegative().optional(),
});
export type ThreadReadInput = z.infer<typeof threadReadSchema>;

/** POST /api/agents/cancel — a card taken out of an agent's hands on the board. */
export const agentCancelRefSchema = z.object({
  kind: z.enum(['task', 'issue']),
  id: z.string().trim().min(1).max(200),
});
export const agentCancelSchema = z.object({
  agent_email: z.string().trim().email(),
  ref: agentCancelRefSchema,
});
export type AgentCancelInput = z.infer<typeof agentCancelSchema>;

// ---------------------------------------------------------------------------
// Agents. See docs/AGENTS_SURFACE.md.

/**
 * The agents this deployment knows about, from `AGENT_ROSTER`.
 *
 * An env map rather than a table for the same reason `OWNER_ROOM_MAP` is one:
 * adding an agent is a deploy, not a migration, and the list is short enough
 * that it belongs in the config a human reads. The `people` rows are derived
 * from it — the map is the source of truth, so removing an agent removes it
 * from the roster without anybody writing SQL.
 */
export function agentRoster(
  raw: string | undefined,
  options: { allowInsecureEndpoints?: boolean } = {},
): AgentDefinition[] {
  if (!raw?.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('AGENT_ROSTER is invalid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AGENT_ROSTER must be an object.');
  }
  const out: AgentDefinition[] = [];
  for (const [email, entry] of Object.entries(value as Record<string, unknown>)) {
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) continue;
    // A bare string is the name and nothing else — an agent that can be
    // addressed and read, with nothing listening. Useful on its own: the
    // conversation is real before a runtime exists to answer in it.
    const detail = typeof entry === 'string'
      ? { name: entry, endpoint: undefined, resetEndpoint: undefined }
      : agentDetail(entry, options.allowInsecureEndpoints === true);
    if (!detail?.name.trim()) continue;
    const writes = typeof entry === 'string' ? [] : agentWrites(entry);
    out.push({
      email: parsed.data,
      name: detail.name.trim(),
      sub: agentSub(parsed.data),
      ...(detail.endpoint ? { endpoint: detail.endpoint } : {}),
      ...(detail.resetEndpoint ? { resetEndpoint: detail.resetEndpoint } : {}),
      avatar: makeAgentAvatarIdentity(parsed.data),
      ...(writes.length > 0 ? { writes } : {}),
    });
  }
  return out;
}

function agentDetail(
  entry: unknown,
  allowInsecure: boolean,
): { name: string; endpoint?: string; resetEndpoint?: string } | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const { name, endpoint, resetEndpoint } = entry as {
    name?: unknown;
    endpoint?: unknown;
    resetEndpoint?: unknown;
  };
  if (typeof name !== 'string') return null;
  // Only https, and only an absolute URL. A hook that could be talked into
  // http is one a network can read the company's messages out of.
  //
  // The exception is a development Worker talking to a runtime on the same
  // machine, where there is no network to read and no certificate to have.
  // Without it the only way to try an agent locally is a public tunnel, which
  // is a worse thing to reach for than `http://127.0.0.1` — and a rule that
  // cannot be satisfied in dev is a rule that gets worked around. The caller
  // decides: this function does not know what `ENVIRONMENT` is.
  if (typeof endpoint !== 'string' || !endpoint.trim()) return { name };
  const clean = validateAgentUrl(endpoint, allowInsecure);
  if (!clean) return { name };
  // `resetEndpoint` is optional and only meaningful with an `endpoint`: no
  // hand-off, nothing that could ever wedge. Same scheme, validated the same
  // way — an agent that opts in tells resetStuckAgents where its operator
  // door is, and one that does not just never gets watched.
  const cleanReset = typeof resetEndpoint === 'string' ? validateAgentUrl(resetEndpoint, allowInsecure) : undefined;
  return { name, endpoint: clean, ...(cleanReset ? { resetEndpoint: cleanReset } : {}) };
}

/**
 * The writes an agent may make on `/mcp`, as the person who addressed it.
 *
 * An agent reads and nothing else by default (docs/MCP.md §The agent
 * principal). A roster entry may name exceptions, each one tool and, for
 * `cms`, one entity: `{"tool": "cms", "entity": "events"}`, and may say
 * `"draftsOnly": true`: `{"tool": "cms", "entity": "reports", "draftsOnly":
 * true}`. A malformed entry
 * is dropped, never widened — a typo grants less, not more. Meet reads the
 * list from config and nowhere else, so every exception is one line in one
 * diff (docs/EVENTS_AGENT.md §Blocker 1).
 */
function agentWrites(entry: unknown): AgentWrite[] {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
  const { writes } = entry as { writes?: unknown };
  if (!Array.isArray(writes)) return [];
  return writes.flatMap((item) => {
    const parsed = agentWriteSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** True when an agent's roster entry names this write. `entity` is the call's `entity` argument, when it has one. */
export function agentMayWrite(agent: Pick<AgentDefinition, 'writes'>, tool: string, entity: unknown): boolean {
  return agentWriteRules(agent, tool, entity).length > 0;
}

/**
 * True when a rule that lets this write through says `draftsOnly`. One such
 * rule is enough: a narrower rule never loses to a wider one (MZ,
 * 2026-10-06). Meet then checks the write itself
 * (`draftOnlyRefusal` in `mcp.ts`).
 */
export function agentWriteIsDraftsOnly(agent: Pick<AgentDefinition, 'writes'>, tool: string, entity: unknown): boolean {
  return agentWriteRules(agent, tool, entity).some((rule) => rule.draftsOnly === true);
}

function agentWriteRules(agent: Pick<AgentDefinition, 'writes'>, tool: string, entity: unknown): AgentWrite[] {
  return (agent.writes ?? []).filter((rule) => rule.tool === tool && (rule.entity === undefined || rule.entity === entity));
}

/** An agent URL Starlings may call: absolute https, or http only where the caller allows it (a development Worker). */
export function validateAgentUrl(raw: string, allowInsecure: boolean): string | undefined {
  if (!raw.trim()) return undefined;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol === 'https:') return parsed.toString();
    if (allowInsecure && parsed.protocol === 'http:') return parsed.toString();
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * What an agent says it is and what it can do — the answer to the one question
 * every person opens an agent to ask. Served by the runtime at
 * `GET <endpoint>/manifest`, cached by Meet with a fetched-at, and drawn
 * read-only. Meet is never its writer: it renders what the runtime proves, the
 * same way it renders presence, and owns no canonical list of skills.
 *
 * Everything is optional but `description`. The payload is untrusted sandbox
 * output, so `parseAgentManifest` clamps every field and drops malformed skills
 * rather than failing — a bad manifest degrades to the name-and-state card,
 * never to a broken roster. See docs/AGENTS_SURFACE.md §The manifest.
 */
/**
 * Counted from `agent_handoffs`: one row per turn a runtime accepted. A
 * hand-off is the honest unit — messages live per conversation and nothing
 * indexes them across the team.
 */
export const AGENT_ACTIVITY_WINDOW_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

/** Bounds on the manifest, applied on the read side because the runtime is untrusted. */
export const AGENT_MANIFEST_DESCRIPTION_MAX_CHARS = 2000;
export const AGENT_MANIFEST_MODEL_MAX_CHARS = 120;
export const AGENT_MANIFEST_SKILLS_MAX = 30;
export const AGENT_MANIFEST_SKILL_NAME_MAX_CHARS = 120;
export const AGENT_MANIFEST_SKILL_DESCRIPTION_MAX_CHARS = 500;
export const AGENT_MANIFEST_TOOLS_MAX = 60;
export const AGENT_MANIFEST_CONNECTIONS_MAX = 30;
export const AGENT_MANIFEST_SCHEDULES_MAX = 30;
export const AGENT_MANIFEST_KEYS_MAX = 40;
export const AGENT_MANIFEST_DOCS_MAX = 30;
/** An env var name and nothing else — a value that slipped into `name` is dropped, not drawn. */
const AGENT_MANIFEST_KEY_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const AGENT_MANIFEST_URL_MAX_CHARS = 2000;

/** Trim, drop-if-empty, clamp to a max. The one string rule the manifest uses. */
function clampManifestString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** A link out, http(s) only. Anything else — a `javascript:` URL, junk — is dropped. */
function clampManifestUrl(value: unknown): string | undefined {
  const raw = clampManifestString(value, AGENT_MANIFEST_URL_MAX_CHARS);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return raw;
  } catch {
    // Not a URL. A manifest that names a broken link keeps the rest.
  }
  return undefined;
}

/**
 * Validate and clamp a manifest reported by a runtime, returning null when
 * there is nothing worth drawing.
 *
 * Defensive by construction: this is sandbox output, so a single bad skill is
 * dropped rather than allowed to fail the whole roster, and every string is
 * bounded before it can reach a client. `description` is the one required
 * field — a manifest with nothing to say is no manifest, and the card falls
 * back to the name and `agent_state`, which is today's row.
 *
 * Run on both sides on purpose: the Worker clamps before it caches, and every
 * reader clamps again before it draws, so a row corrupted or written by an
 * older build can never reach a client unbounded.
 */
export function parseAgentManifest(raw: unknown): AgentManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  const description = clampManifestString(source.description, AGENT_MANIFEST_DESCRIPTION_MAX_CHARS);
  if (!description) return null;

  const model = clampManifestString(source.model, AGENT_MANIFEST_MODEL_MAX_CHARS);
  const skills = clampManifestList<AgentManifestSkill>(source.skills, AGENT_MANIFEST_SKILLS_MAX, (entry) => {
    const name = clampManifestString(entry.name, AGENT_MANIFEST_SKILL_NAME_MAX_CHARS);
    if (!name) return null;
    const detail = clampManifestString(entry.description, AGENT_MANIFEST_SKILL_DESCRIPTION_MAX_CHARS);
    return detail ? { name, description: detail } : { name };
  });
  const tools = clampManifestList<AgentManifestTool>(source.tools, AGENT_MANIFEST_TOOLS_MAX, (entry) => {
    const name = clampManifestString(entry.name, AGENT_MANIFEST_SKILL_NAME_MAX_CHARS);
    if (!name) return null;
    const detail = clampManifestString(entry.description, AGENT_MANIFEST_SKILL_DESCRIPTION_MAX_CHARS);
    return {
      name,
      ...(detail ? { description: detail } : {}),
      ...(entry.requires_approval === true ? { requires_approval: true } : {}),
    };
  });
  const connections = clampManifestList<AgentManifestConnection>(source.connections, AGENT_MANIFEST_CONNECTIONS_MAX, (entry) => {
    const name = clampManifestString(entry.name, AGENT_MANIFEST_SKILL_NAME_MAX_CHARS);
    if (!name) return null;
    // A connection has a protocol, not a description. Same bound as a name.
    const protocol = clampManifestString(entry.protocol, AGENT_MANIFEST_SKILL_NAME_MAX_CHARS);
    return protocol ? { name, protocol } : { name };
  });
  const schedules = clampManifestList<AgentManifestSchedule>(source.schedules, AGENT_MANIFEST_SCHEDULES_MAX, (entry) => {
    const cron = clampManifestString(entry.cron, AGENT_MANIFEST_SKILL_NAME_MAX_CHARS);
    if (!cron) return null;
    const detail = clampManifestString(entry.description, AGENT_MANIFEST_SKILL_DESCRIPTION_MAX_CHARS);
    return detail ? { cron, description: detail } : { cron };
  });

  const keys = clampManifestList<AgentManifestKey>(source.keys, AGENT_MANIFEST_KEYS_MAX, (entry) => {
    const name = clampManifestString(entry.name, 64);
    if (!name || !AGENT_MANIFEST_KEY_NAME.test(name)) return null;
    return { name, set: entry.set === true };
  });

  const docs = clampManifestList<AgentManifestDoc>(source.docs, AGENT_MANIFEST_DOCS_MAX, (entry) => {
    const name = clampManifestString(entry.name, AGENT_MANIFEST_SKILL_NAME_MAX_CHARS);
    if (!name) return null;
    const title = clampManifestString(entry.title, AGENT_MANIFEST_SKILL_NAME_MAX_CHARS);
    const detail = clampManifestString(entry.description, AGENT_MANIFEST_SKILL_DESCRIPTION_MAX_CHARS);
    const docSource = clampManifestString(entry.source, AGENT_MANIFEST_SKILL_DESCRIPTION_MAX_CHARS);
    const view = clampManifestUrl(entry.view_url);
    const edit = clampManifestUrl(entry.edit_url);
    return {
      name,
      ...(title ? { title } : {}),
      ...(detail ? { description: detail } : {}),
      ...(docSource ? { source: docSource } : {}),
      ...(view ? { view_url: view } : {}),
      ...(edit ? { edit_url: edit } : {}),
      ...(entry.required === true ? { required: true } : {}),
    };
  });

  const home = clampManifestUrl(source.home_url);
  const readme = clampManifestUrl(source.readme_url);
  const repo = clampManifestUrl(source.repo_url);
  const version = clampManifestString(source.version, AGENT_MANIFEST_MODEL_MAX_CHARS);
  const builtAt = clampManifestTimestamp(source.built_at);
  return {
    description,
    ...(model ? { model } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(connections.length > 0 ? { connections } : {}),
    ...(schedules.length > 0 ? { schedules } : {}),
    ...(keys.length > 0 ? { keys } : {}),
    ...(docs.length > 0 ? { docs } : {}),
    ...(home ? { home_url: home } : {}),
    ...(readme ? { readme_url: readme } : {}),
    ...(repo ? { repo_url: repo } : {}),
    ...(version ? { version } : {}),
    ...(builtAt !== null ? { built_at: builtAt } : {}),
  };
}

/** An epoch-ms timestamp in a plausible range; anything else is dropped. */
function clampManifestTimestamp(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const at = Math.round(value);
  // After 2020, and not more than a day in the future — a runtime whose clock
  // says the build is from next year is not a fact a card should repeat.
  if (at < 1_577_836_800_000 || at > Date.now() + 86_400_000) return null;
  return at;
}

/**
 * The one list rule the manifest uses: a bounded array of objects, each
 * clamped by `parse`, which returns null for an entry a card cannot draw — a
 * nameless skill, a schedule with no cron. Dropped, not fatal.
 */
function clampManifestList<T>(
  raw: unknown,
  max: number,
  parse: (entry: Record<string, unknown>) => T | null,
): T[] {
  const list: T[] = [];
  if (!Array.isArray(raw)) return list;
  for (const entry of raw) {
    if (list.length >= max) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const parsed = parse(entry as Record<string, unknown>);
    if (parsed) list.push(parsed);
  }
  return list;
}

/**
 * One write an agent may make: a tool, and for `cms` one entity. Strict, so
 * an unknown key drops the rule. `draftsOnly: true` lets the agent create and
 * edit drafts of that entity and never publish one.
 */
export const agentWriteSchema = z.object({
  tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
  entity: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/u).optional(),
  draftsOnly: z.literal(true).optional(),
}).strict();
export type AgentWrite = z.infer<typeof agentWriteSchema>;

export const agentDefinitionSchema = z.object({
  email: z.string(),
  name: z.string(),
  sub: z.string(),
  avatar: agentAvatarIdentitySchema,
  /** Where hand-offs are delivered; absent for an agent Meet only lists. */
  endpoint: z.string().optional(),
  resetEndpoint: z.string().optional(),
  /** Writes allowed on `/mcp` beyond read; absent for every agent that only reads. */
  writes: z.array(agentWriteSchema).optional(),
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

/**
 * An agent's subject. Prefixed rather than hashed: unlike a thread id this
 * never travels in a URL, and a readable sub is what makes an agent's rows
 * obvious in the ledger. `dev:` and `system:` already use this shape.
 */
export function agentSub(email: string): string {
  return `agent:${email.toLowerCase()}`;
}

/**
 * The one door something outside Meet may write a message through.
 *
 * Two callers, one route. Core's GitHub webhook posts an `event` and names no
 * sender — an event is the work graph reporting itself, and attributing it to
 * anybody would make their own channel read as if they had typed there. An
 * agent posts `text` and names itself, which the Worker then resolves against
 * the roster: the caller never gets to choose a sender freely, and a human
 * address is refused outright.
 */
const internalChannelRefSchema = z.object({
  kind: z.enum(THREAD_MESSAGE_REF_KINDS),
  id: z.string().trim().min(1).max(200),
});

export const internalChannelEventSchema = z.object({
  /** Where it lands. Either this or `subject`, never both. */
  thread_id: z.string().trim().min(4).max(72).optional(),
  /**
   * The project, lead or partner whose channel this lands in, resolved by Meet
   * — so a runtime narrating work on a subject never has to know a channel id.
   * A partner is an organization Core flags `is_partner`; Core's events about
   * an organization with no lead (a support case) land there (,
   *). Events only: an answer goes back to the thread that asked.
   */
  subject: z.object({
    kind: acceptingKindAliases(z.enum(['project', 'lead', 'organization'])),
    id: z.string().uuid(),
  }).optional(),
  // Alongside `thread_id` this is not an address at all: it is which project a
  // `move` is about. See the refinement at the foot of this schema.
  text: z.string().trim().min(1).max(MESSAGE_TEXT_MAX_CHARS),
  type: z.enum(THREAD_MESSAGE_TYPES).default('event'),
  /**
   * An agent address. Required for `text`. Optional for `event`: with one,
   * the line is the agent narrating its own work ("Factory moved #142 to
   * Review"); without one it is the work graph reporting itself, from Meet.
   */
  sender: emailSchema.optional(),
  refs: z.array(internalChannelRefSchema).max(THREAD_MESSAGE_REF_MAX).optional(),
  /**
   * What makes a retry safe. A sandbox that times out mid-run will try again,
   * and a conversation that says everything twice is worse than one that says
   * nothing — so the message id is derived from this rather than minted.
   */
  idempotency_key: z.string().trim().min(8).max(128),
  /**
   * Move a card with this line. Meet performs the write, and the actor on it
   * is the **person** whose message `in_reply_to` names — the human who asked
   * for the work. An agent has no authority of its own; this is how it borrows
   * some, and why a leaked secret still cannot move a card without pointing at
   * a real message from a real colleague. See docs/BOARD.md. A move to
   * `done` or `dropped` is refused: an agent stops at `review`, and a person
   * accepts the card (docs/OWNERSHIP.md decision 13).
   */
  move: z.object({
    ref: internalChannelRefSchema.refine((ref) => ref.kind === 'task' || ref.kind === 'issue', {
      message: 'Only a task or an issue can be moved.',
    }),
    stage: z.enum(WORK_STAGES),
  }).optional(),
  /** The hand-off being answered: its thread, and the message id Meet sent. */
  in_reply_to: z.object({
    thread_id: z.string().trim().min(4).max(72),
    message_id: z.string().trim().min(4).max(72),
  }).optional(),
  /**
   * Streaming. True means "this is what I have so far": Meet writes the row
   * and, on the next post under the **same** `idempotency_key`, rewrites its
   * text in place rather than answering `duplicate`. The last post — the
   * whole text, `partial` false or absent — finalizes it, and only that one
   * clears *Working…*. A final row is never rewritten again, so a late
   * partial that lands after the final is a duplicate, not a regression. The
   * final post may also change `type` to `event` — a step the model narrated
   * before calling a tool is a trail line, not an answer. `text` only.
   */
  partial: z.boolean().optional(),
  /** A typed question card, authored only as a complete text message. */
  question: threadQuestionSchema.optional(),
  /** Required for new shared-chat questions; a two-member agent DM infers its human. */
  question_recipient_email: emailSchema.optional(),
  /** A request for one Keep item: a finalized agent text message, not a question. */
  release_request: threadReleaseRequestSchema.optional(),
}).superRefine((value, ctx) => {
  // Ordinarily `subject` *is* the address: name one or the other. A move is
  // the exception, and both may appear — the line goes to `thread_id`, which
  // is usually the DM the runtime was asked in, and `subject` says which
  // project the card belongs to so its channel hears about the move. Without
  // that a runtime answering in a DM would close an issue nobody's project
  // ever heard about, since GitHub's issue does not know about ours.
  const named = Boolean(value.thread_id) !== Boolean(value.subject);
  const bothForAMove = Boolean(value.thread_id) && Boolean(value.subject) && Boolean(value.move);
  if (!named && !bothForAMove) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['thread_id'], message: 'Name exactly one of thread_id or subject, or both alongside a move.' });
  }
  if (value.type === 'text' && !value.sender) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sender'], message: 'A text message must name its sender.' });
  }
  if (value.type === 'text' && value.subject) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['subject'], message: 'An answer goes to the thread that asked; only an event may be addressed to a subject.' });
  }
  if (value.move && !value.sender) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sender'], message: 'A move names the agent making it.' });
  }
  if (value.move && !value.in_reply_to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['in_reply_to'], message: 'A move names the message it answers, so the actor is a person.' });
  }
  if (value.partial && (value.type !== 'text' || !value.sender)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['partial'], message: 'Only an agent\u2019s text answer can stream.' });
  }
  if (value.partial && value.move) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['partial'], message: 'A move is made once, on the final message.' });
  }
  if (value.question_recipient_email && !value.question) {
    ctx.addIssue({ code: 'custom', path: ['question_recipient_email'], message: 'A recipient belongs to a question.' });
  }
  if (value.question && (value.type !== 'text' || value.partial || value.move)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['question'], message: 'An interactive question is a finalized agent text message.' });
  }
  if (value.release_request && (value.type !== 'text' || !value.sender || value.partial || value.move || value.question)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['release_request'], message: 'A release request is a finalized agent text message, not a question.' });
  }
});
export type InternalChannelEventInput = z.infer<typeof internalChannelEventSchema>;

export const internalChannelEventResponseSchema = z.object({
  ok: z.literal(true),
  message_id: z.string(),
  /** Where it landed — the channel Meet resolved when the caller named a subject. */
  thread_id: z.string(),
  /** True when this key had already been written; the message was not repeated, and no card was moved again. */
  duplicate: z.boolean(),
});
export type InternalChannelEventResponse = z.infer<typeof internalChannelEventResponseSchema>;

/**
 * `POST /api/internal/keep-release`: an agent fetches the release a member
 * approved on its card. Signed with the agent's own inbound key.
 * Meet checks that the card is the agent's own request, mints an agent token
 * at Keep for this one call and fetches. The agent never holds a Keep token.
 */
export const internalKeepReleaseFetchSchema = z.object({
  sender: emailSchema,
  thread_id: z.string().trim().min(4).max(72),
  /** The card: the message id channel-events answered. */
  message_id: z.string().trim().min(4).max(72),
});
export type InternalKeepReleaseFetchInput = z.infer<typeof internalKeepReleaseFetchSchema>;

const keepBase64url = z.string().regex(/^[A-Za-z0-9_-]+$/u);
/**
 * Keep's answer, passed through: the release, the item body sealed under a
 * one-time key (AAD `release:<release id>:<vault id>:<item id>`), and that key
 * wrapped to the agent's session key. Meet cannot open either.
 */
export const internalKeepReleaseFetchResponseSchema = z.object({
  release: z.object({
    id: z.string(),
    vault_id: z.string(),
    item_id: z.string(),
    item_name: z.string(),
    agent: z.object({ address: z.string(), name: z.string() }),
    approver: z.string(),
    task: z.string(),
    status: z.string(),
    expires_at: z.string(),
  }).passthrough(),
  session_public_key: keepBase64url,
  sealed: z.object({ iv: keepBase64url, ciphertext: keepBase64url }),
  wrapped_key: z.object({ ephemeral_public_key: keepBase64url, iv: keepBase64url, ciphertext: keepBase64url }),
});
export type InternalKeepReleaseFetchResponse = z.infer<typeof internalKeepReleaseFetchResponseSchema>;

/** The signed no-op beside the door above: Core's hourly canary. */
export const internalPingResponseSchema = z.object({
  ok: z.literal(true),
  pong: z.literal(true),
});
export type InternalPingResponse = z.infer<typeof internalPingResponseSchema>;

/**
 * Why a runtime is being called. `message` is somebody writing to it.
 * `cancel` is somebody taking a card out of its hands — a person dragged it
 * out of `doing` on the board — and the runtime stops the run and says
 * nothing: the event line was already written by the person's move
 * (docs/BOARD.md). `reaction` is a member acknowledging one of the agent's
 * messages; it carries state rather than becoming a new Meet message.
 */
export const AGENT_DELIVERY_KINDS = ['message', 'cancel', 'reaction', 'question_answer', 'release'] as const;
export type AgentDeliveryKind = (typeof AGENT_DELIVERY_KINDS)[number];
export const agentDeliveryKindSchema = z.enum(AGENT_DELIVERY_KINDS);

/**
 * What an agent's runtime is handed when somebody writes to it.
 *
 * Deliberately the message and nothing else: no session, no token, no CRM
 * row, and no history. An agent that wants the conversation reads it back
 * through the thread it was named in, with its own credential — handing a
 * runtime a transcript it did not ask for is how a sandbox ends up holding
 * more of the company than the job needed.
 *
 * `refs` is the one thing beyond the message: the card the message was sent
 * from, when it was sent from one. It is what lets a runtime know its ticket
 * without parsing `#123` out of prose, and what a cancel names.
 */
const agentDeliveryBaseSchema = z.object({
  agent_email: z.string(),
  thread_id: z.string(),
  thread_kind: threadKindSchema,
  message_id: z.string(),
  sender_email: z.string(),
  sender_name: z.string(),
});

export const agentMessageDeliverySchema = agentDeliveryBaseSchema.extend({
  kind: z.literal('message'),
  text: z.string(),
  sent_at: z.number().int(),
  refs: z.array(threadMessageRefSchema),
  /** On a Hand off: what done looks like and what comes back. */
  handoff: threadHandoffSchema.optional(),
});
export type AgentMessageDelivery = z.infer<typeof agentMessageDeliverySchema>;

/** A submitted answer to a question from this agent, routed to its same thread session. */
export const agentQuestionAnswerDeliverySchema = agentDeliveryBaseSchema.extend({
  kind: z.literal('question_answer'),
  question_message_id: z.string(),
  question_text: z.string(),
  option_ids: z.array(z.string()),
  option_labels: z.array(z.string()),
  sent_at: z.number().int(),
});
export type AgentQuestionAnswerDelivery = z.infer<typeof agentQuestionAnswerDeliverySchema>;

/**
 * A member acted on this agent's release request. `approved`: fetch
 * it now through `POST /api/internal/keep-release`. `ended`: it is gone. The
 * sender is the member who acted.
 */
export const agentReleaseDeliverySchema = agentDeliveryBaseSchema.extend({
  kind: z.literal('release'),
  request_id: z.string(),
  status: z.enum(['approved', 'ended']),
  expires_at: z.number().int(),
  sent_at: z.number().int(),
});
export type AgentReleaseDelivery = z.infer<typeof agentReleaseDeliverySchema>;

export const agentCancelDeliverySchema = agentDeliveryBaseSchema.extend({
  kind: z.literal('cancel'),
  text: z.string(),
  sent_at: z.number().int(),
  refs: z.array(threadMessageRefSchema),
});
export type AgentCancelDelivery = z.infer<typeof agentCancelDeliverySchema>;

/** A member's acknowledgement of a message from the agent. */
export const agentReactionDeliverySchema = agentDeliveryBaseSchema.extend({
  kind: z.literal('reaction'),
  emoji: z.string(),
  on: z.boolean(),
  reacted_at: z.number().int(),
});
export type AgentReactionDelivery = z.infer<typeof agentReactionDeliverySchema>;

export const agentDeliveryPayloadSchema = z.discriminatedUnion('kind', [
  agentMessageDeliverySchema,
  agentQuestionAnswerDeliverySchema,
  agentReleaseDeliverySchema,
  agentCancelDeliverySchema,
  agentReactionDeliverySchema,
]);
export type AgentDeliveryPayload = z.infer<typeof agentDeliveryPayloadSchema>;

/**
 * What a pasted link turns into on a card.
 *
 * `GET /api/link-preview?url=` for a signed-in member, and
 * `GET /api/rooms/{slug}/meetings/{id}/link-preview?url=` for a guest holding
 * a meeting's artifact token — one shape, because a link in meeting chat and a
 * link in a thread are the same thing to the person reading it.
 *
 * The Worker reads the page, never the device: a browser unfurling its own
 * links would tell every site anybody pastes the address of every participant
 * who was in the room at the time, guests included. Same rule as the GitHub
 * avatar proxy.
 *
 * Every text field is nullable because most of the web supplies none of them.
 * A card with only a domain is still worth drawing — it says where the link
 * goes, which is the question a bare URL does not answer.
 */
/** `GET /api/link-preview?url=` and `GET /api/rooms/:slug/meetings/:id/link-preview?url=`. */
export const linkPreviewQuerySchema = z.object({
  url: z.string().trim().min(1).max(2048),
});

/**
 * `GET /api/crm/avatar?url=&size=`: somebody's GitHub picture, fetched by the
 * Worker rather than by the device. `fetchGithubAvatar` decides which hosts
 * it will read; this only bounds the ask.
 */
export const crmAvatarQuerySchema = z.object({
  url: z.string().trim().min(1).max(2048),
  size: z.coerce.number().int().min(16).max(256).default(64),
});

export const linkPreviewSchema = z.object({
  /** The address actually read, after redirects. */
  url: z.string(),
  /** Hostname with any leading `www.` removed — what the card labels itself. */
  domain: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  site_name: z.string().nullable(),
  image_url: z.string().optional(),
  image_alt: z.string().nullable().optional(),
});
export type LinkPreview = z.infer<typeof linkPreviewSchema>;

export const linkPreviewResponseSchema = z.object({
  preview: linkPreviewSchema,
});
export type LinkPreviewResponse = z.infer<typeof linkPreviewResponseSchema>;
