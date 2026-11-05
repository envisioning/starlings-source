// Backend-only CRM sync: hosted Meet sessions become `interactions` rows in
// Envisioning Core. Invisible to hosts and guests — there is no UI, no PAT, and
// nothing here is on a guest-facing code path. See docs/MEETING_LOG.md.
//
// Invariants this file must keep:
//   - Never send audio or video references; finalized text only.
//   - Never invent an email. Guests without one stay name-only in metadata.
//   - Never fail the media or email path because Core is unreachable.

import { coreTokensForJoinTokens } from './booking-store';
import { projectLimitForCreate } from './workspace-plan';
import { z } from 'zod';
import {
  crmOrganizationOptionSchema,
  type CrmContactCreate,
  type CrmContactFilter,
  type CrmContactUpdate,
  type CrmLicense,
  type CrmOffer,
  type CrmOrganizationFilter,
  type CrmSubjectCommercialResponse,
  type CrmOrganizationOption,
  type CrmOrganizationUpdate,
} from '@starlings/contracts';
import {
  crmGithubRepoSchema,
  crmInteractionContactSchema,
  crmInteractionSchema,
  crmInteractionRowSchema,
  crmIssueDetailSchema,
  crmIssueLabelSchema,
  crmIssueMilestoneSchema,
  crmIssueSchema,
  crmIssueUserSchema,
  crmMyTaskSchema,
  crmContactFacetsSchema,
  crmOrganizationFacetsSchema,
  crmSubjectDetailSchema,
  crmSubjectSchema,
  crmTaskSchema,
  crmTeamMemberSchema,
  crmWorkItemSchema,
  crmContactProfileShape,
  type CrmContact,
  type CrmContactDetail,
  type CrmInteraction,
  type CrmContactFacets,
  type CrmContactOptionsResponse,
  CONTACT_LANGUAGES,
  type CrmOrganizationFacets,
  type CrmRelatedRow,
  type CrmWorkItem,
  type CrmIssueDetail,
  type CrmIssueFacetsResponse,
  type CrmInteractionRow,
  type CrmInteractionCreate,
  type CrmInteractionUpdate,
} from '@starlings/contracts/crm';
import type { CoreInteractionValues } from '@starlings/contracts/core-writes';
import {
  d1ChangeBookingInteraction,
  d1FileBookingInteraction,
  writeD1Interaction,
  type BookingInteraction,
  type BookingInteractionChange,
} from './core-interactions-d1';
import {
  favoriteRowSchema,
  type FavoriteRow,
  type FavoriteTarget,
} from '@starlings/contracts/favorites';
import { crmDecisionSchema, crmGoalSchema } from '@starlings/contracts/goals-decisions';
import { coreApiOrigin, usesCore, usesCoreFor, usesCoreForKind } from './work-store';
import { subjectAccessFor } from './subject-access';
import type { OwnerSession } from './contracts';
import { assertGroupWritable } from './work-freeze';
import { d1MergeRecords } from './record-merges';
import { coreCollectionGroup, WORK_GROUPS, type WorkGroup } from '@starlings/contracts/work-groups';
import { d1CommercialList, d1CommercialSummary } from './core-commercial-d1';
import { workspacePublicOrigin } from './workspace-origins';
import {
  d1GranolaLedger,
  d1InteractionRecord,
  d1Interactions,
  d1InteractionsSince,
  d1WriteMeetingLog,
  d1AddFavorite,
  d1AllGoals,
  d1CreateDecision,
  d1CreateGoal,
  d1CreateProjectRepo,
  d1Decisions,
  d1Favorites,
  d1GithubRepos,
  d1Goals,
  d1ProjectRepos,
  d1RecentDecisions,
  d1RemoveFavorite,
  d1UpdateGoal,
  d1AssertTaskFileable,
  d1CreateTask,
  d1LinkTaskToIssue,
  d1MyWork,
  d1PartnerTasks,
  d1Task,
  d1Tasks,
  d1TasksByStatus,
  d1Team,
  d1UpdateTask,
  d1DeleteTask,
  d1WorkItems,
  d1CreateOrganization,
  d1ContactDetail,
  d1CalendarContacts,
  d1ContactOrganization,
  d1Contacts,
  d1CreateContactRecord,
  d1UpdateContact,
  d1DeleteContact,
  d1ContactOptions,
  d1UpdateOrganization,
  d1DeleteOrganization,
  summaryPreview,
  d1CreateSubject,
  d1SearchOrganizations,
  d1Subject,
  d1SubjectCounts,
  d1SubjectDetail,
  d1Subjects,
  d1UpdateSubject,
} from './work-d1';
import { fieldsOf, recordWorkActivity } from './work-activity';
import {
  coreEntitySchema,
  coreRecordResponseSchema,
  coreRecordSchema,
  coreSearchHitSchema,
  type CoreFieldsWriteBody,
  type CoreMergeEntity,
  type CoreMergeResponse,
  type CoreRecordEntity,
  type CoreRegistryResponse,
  type CoreSearchQuery,
  type CoreSearchResponse,
} from '@starlings/contracts/core-fields';
import { githubAppAvailable, githubAppConnected } from './github-app';
import { createIssue, listProjectIssues, readIssue, readRepoFacets, updateIssue, type RepoLink } from './github-issues';
import { awaitBounded, forgetCoreMemo, memoCore, withCoreRetry } from './core-gate';
import { cachedRead, purgeCoreCache, purgeIssueCaches, type CoreCacheKey } from './core-cache';
import { env as workerEnv } from 'cloudflare:workers';
import { hmacSHA256Hex, openSecret, sealSecret, sha256, type SealedSecret } from './crypto';
import { docsDocumentURL } from './docs';
import { ControlError } from './errors';
import { parseUpstream, readRefusal, readUpstreamJson } from './upstream';
import {
  inboxBookingSchema,
  roomPermalink,
  untriagedTouchSchema,
  type CrmDecision,
  type CrmDecisionCreateInput,
  type CrmGoal,
  type CrmGoalCreateInput,
  type CrmGoalUpdateInput,
  type CrmGithubRepo,
  type CrmIssue,
  type CrmIssueQuery,
  type CrmMyTask,
  type CrmSubject,
  type CrmSubjectCountsResponse,
  type MeetingKind,
  type CrmSubjectDetail,
  type CrmSubjectKind,
  type CrmSubjectStatusCounts,
  type CrmTask,
  type CmsEventImageRequest,
  type CmsTechnologyImageRequest,
  type CommercialSummary,
  type CoreTokenResponse,
  jsonValueSchema,
  type JsonValue,
  type UntriagedTouchesResponse,
} from './contracts';
import type { MeetingLogMaterial } from './room-coordinator';
import { roomStub } from './do-jurisdiction';

const INGEST_PATH = '/api/public/meet-meeting-logs';
const OWNER_EXCHANGE_PATH = '/api/public/meet-owner-exchange';
/** Matches Core's clock-skew window; a stale signature is rejected upstream. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Core caps the body; keep the transcript inside the ~1 MiB batch class. */
const TRANSCRIPT_MAX_SEGMENTS = 2_000;
/**
 * How many projects or leads a browse asks for. Core caps this route at 50. A list this
 * long is a browse, not a search — past it the answer is to type, and the
 * clients say so rather than pretending the list is everything.
 */
const SUBJECT_PAGE = 50;
const COMMERCIAL_LOOKBACK_MONTHS = 12;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function unusableCommercialDashboard(): CrmSyncError {
  return new CrmSyncError('Core returned an unusable commercial dashboard.', 502);
}

export type MeetingLogPhase = 'started' | 'ended';

/**
 * Which system captured the meeting. Core keys idempotency and provenance on
 * this, so the two never collide: a Meet `meeting_id` is a UUID and a Granola
 * one is `not_…`, and neither can be mistaken for the other's row.
 * Absent means `meet_envisioning`, so every existing caller is unchanged.
 */
export type MeetingLogSource = 'meet_envisioning' | 'meet_ambient' | 'granola';

export interface MeetingLogPayload {
  phase: MeetingLogPhase;
  source?: MeetingLogSource;
  meeting_id: string;
  /** Null for a meeting that was never in a Meet room — see `granola.ts`. */
  room_slug: string | null;
  host_email: string;
  started_at: string;
  ended_at: string | null;
  title: string | null;
  summary_markdown: string | null;
  transcript: Array<{
    speaker_name: string;
    speaker_id: string;
    starts_at_ms: number;
    ends_at_ms: number;
    text: string;
    language: string;
  }>;
  participants: Array<{
    identity: string;
    name: string;
    email: string | null;
    role: 'owner' | 'guest';
    booking_token: string | null;
  }>;
  booking_token: string | null;
  /** Null when the source has no stable link to offer. */
  permalink: string | null;
  /** Absent means "leave the filing as it is" — only the Granola bridge omits it. */
  meeting_kind?: MeetingKind;
  lead_id: string | null;
  project_id: string | null;
  event_id?: string | null;
  partner_organization_id?: string | null;
  categorized_by: string | null;
  /** The Docs document holding the full transcript; null until filed. */
  transcript_document_id: string | null;
  transcript_url: string | null;
}

export class CrmSyncError extends ControlError {}

/**
 * The error for a Core answer that was not ok. A 429 that outlived the
 * retries reads as "busy", not as a status code to decode, and keeps the code
 * in brackets so Copy still carries it.
 */
export function coreFailure(what: string, response: Response): CrmSyncError {
  if (response.status === 429) {
    return new CrmSyncError(`Core is busy, try again in a moment. (${what} 429)`, 429, 'rate_limited');
  }
  return new CrmSyncError(`Core ${what} failed (${response.status}).`, response.status);
}

/**
 * `coreFailure` for a lead or project write. A Core 5xx there used to reach
 * the person as "Core subject create failed (500)." with nothing to act on or
 * paste into a Core ticket. This reads what Core said (its `error`, `message`
 * or `detail`, else the body text), keeps it in the message so Copy carries
 * it, and answers 502: the Worker is fine, Core is not.
 */
export async function coreWriteFailure(what: string, response: Response): Promise<CrmSyncError> {
  if (response.status < 500) return coreFailure(what, response);
  let detail = '';
  try {
    const text = (await response.text()).trim();
    try {
      const body: unknown = JSON.parse(text);
      if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        for (const key of ['error', 'message', 'detail']) {
          if (typeof record[key] === 'string' && record[key]) { detail = record[key]; break; }
        }
      }
    } catch {
      detail = text;
    }
  } catch {
    detail = '';
  }
  detail = detail.replace(/\s+/gu, ' ').trim().slice(0, 240);
  return new CrmSyncError(
    `Core couldn't finish the ${what} (${response.status})${detail ? `: ${detail}` : '. It sent no detail.'} Try again, or send this line to whoever runs Core.`,
    502,
  );
}

// ---------------------------------------------------------------------------
// Core's answers. Every body Core sends back runs through a zod
// schema before the Worker reads it or passes it on. The clients decode the
// same schemas, so a row that fails here would fail on the Mac and iPhone
// too, as a `keyNotFound` that looks like Meet's fault. `upstream.ts` reads
// each schema as the clients do: objects loose, so a field Core adds passes
// through, and enums open. A list or flag that the code already read as
// "absent means empty" stays optional.

/** Check a value Core sent. See `parseUpstream`: a mismatch is a logged 502 `upstream_shape`. */
export function parseCoreBody<S extends z.ZodType>(schema: S, body: unknown, route: string): z.output<S> {
  return parseUpstream(schema, body, { source: 'core', route, error: CrmSyncError });
}

/** Read a Core response as JSON and check it. A body that is not JSON fails at `(body)`. */
export function readCoreJson<S extends z.ZodType>(response: Response, schema: S, route: string): Promise<z.output<S>> {
  return readUpstreamJson(response, schema, { source: 'core', route, error: CrmSyncError });
}

/** A list Core may leave out; absent or null reads as empty, as it always has. */
const optionalList = <Row extends z.ZodType>(row: Row) => z.array(row).nullish();

const subjectRow = crmSubjectSchema.loose();
const subjectDetailRow = crmSubjectDetailSchema.loose();
const taskRow = crmTaskSchema.loose();
const repoRow = crmGithubRepoSchema.loose();
const issueRow = crmIssueSchema.loose();
const goalRow = crmGoalSchema.loose();
const decisionRow = crmDecisionSchema.loose();

/**
 * Where every Core request goes. A workspace that does not use Core throws
 * here, before any request, and there is no default origin, so Envisioning's
 * Core is never reached from another workspace (docs/WORKSPACE_STORE.md §Fail closed).
 */
function coreOrigin(env: Env): string {
  assertUsesCore(env);
  return coreApiOrigin(env);
}

export function assertUsesCore(env: Env): void {
  if (!usesCore(env)) throw new CrmSyncError('This workspace does not use Core.', 503, 'not_configured');
}

/** Off until the shared secret is configured, so dev and tests never call out. */
/**
 * Whether this workspace has a work model to read and write: a D1 workspace
 * always does (work-d1.ts); a Core workspace does when sync is on. Routes for
 * the parts that live in D1 gate on this, not on `crmSyncEnabled`.
 */
export function workModelEnabled(env: Env): boolean {
  return !usesCore(env) || crmSyncEnabled(env);
}

/**
 * Whether a project's GitHub issues can be read and written. On a Core
 * workspace that is `crmSyncEnabled`, as before. A D1 workspace reads its
 * repository links from D1 and has issues only through Meet's own GitHub
 * App: without the App there is no path to GitHub that avoids Core.
 */
export function githubIssuesEnabled(env: Env): boolean {
  return usesCore(env) ? crmSyncEnabled(env) : githubAppAvailable(env);
}

export function crmSyncEnabled(env: Env): boolean {
  if (!usesCore(env)) return false;
  if (String(env.CRM_SYNC_MODE ?? 'on') !== 'on') return false;
  return Boolean(env.INTERNAL_REQUEST_SECRET?.trim());
}

export function buildMeetingLogPayload(
  material: MeetingLogMaterial,
  phase: MeetingLogPhase,
  links: { publicOrigin: string; transcriptURL?: string | null },
): MeetingLogPayload {
  const transcriptURL = links.transcriptURL ?? null;
  const ambient = material.captureKind === 'ambient';
  return {
    phase,
    // A hosted meeting is Core's default; an ambient one says so, and Core
    // tags it `ambient` rather than `meet` — "we hosted this" stays true.
    ...(ambient ? { source: 'meet_ambient' as const } : {}),
    meeting_id: material.meetingId,
    room_slug: material.roomSlug,
    host_email: material.ownerEmail,
    started_at: new Date(material.startedAt).toISOString(),
    ended_at: material.endedAt ? new Date(material.endedAt).toISOString() : null,
    title: phase === 'ended' ? material.title : null,
    summary_markdown: phase === 'ended' ? material.summary : null,
    // The started phase carries no text at all — there is none yet, and the
    // row it opens is only a placeholder for the timeline.
    transcript: phase === 'ended'
      ? material.transcript.slice(0, TRANSCRIPT_MAX_SEGMENTS).map((segment) => ({
        speaker_name: segment.speaker_name,
        speaker_id: segment.speaker_id,
        starts_at_ms: segment.starts_at_ms,
        ends_at_ms: segment.ends_at_ms,
        text: segment.text,
        language: segment.language,
      }))
      : [],
    participants: material.participants.map((participant) => ({
      identity: participant.identity,
      name: participant.name,
      email: participant.email || null,
      role: participant.role,
      booking_token: participant.bookingToken,
    })),
    booking_token: material.bookingToken,
    // Always this workspace's public permalink — never workers.dev, localhost
    // or another workspace's host. An ambient meeting has no page to link.
    permalink: ambient ? null : roomPermalink(links.publicOrigin, material.roomSlug),
    meeting_kind: material.meetingKind,
    lead_id: material.leadId,
    project_id: material.projectId,
    partner_organization_id: material.partnerOrganizationId,
    categorized_by: material.categorizedBy,
    transcript_document_id: phase === 'ended' ? material.transcriptDocumentId : null,
    transcript_url: phase === 'ended' ? transcriptURL : null,
  };
}

/**
 * Sign and POST one meeting-log phase. Throws `CrmSyncError` on any non-2xx so
 * the queue consumer can retry; callers on the live meeting path must swallow.
 * On a D1 workspace the phase is the workspace's own interaction row
 * (work-d1.ts), written in place, and a D1 failure throws the same way.
 */
export async function postMeetingLog(env: Env, payload: MeetingLogPayload): Promise<void> {
  await assertGroupWritable(env, 'interactions');
  if (!usesCoreFor(env, 'interactions')) {
    await purgeCoreCache(await d1WriteMeetingLog(env, payload, await bookingTokensOf(env, payload)));
    return;
  }
  const secret = env.INTERNAL_REQUEST_SECRET?.trim();
  if (!secret) throw new CrmSyncError('INTERNAL_REQUEST_SECRET is not configured.', 503, 'not_configured');
  const body = JSON.stringify(await withCoreBookingTokens(env, payload));
  const timestamp = String(Date.now());
  const signature = await hmacSHA256Hex(secret, `${timestamp}.${body}`);

  const response = await fetch(`${coreOrigin(env)}${INGEST_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-internal-timestamp': timestamp,
      'x-internal-signature': signature,
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new CrmSyncError(`Core rejected the meeting log (${response.status}).`, response.status);
  }
}

/**
 * Every booking token in the call, with Core's token for each one D1 knows:
 * a booking Core took before the flip keeps Core's token on its copied
 * interaction.
 */
async function bookingTokensOf(env: Env, payload: MeetingLogPayload): Promise<string[]> {
  const tokens = [payload.booking_token, ...payload.participants.map((participant) => participant.booking_token)]
    .filter((token): token is string => typeof token === 'string' && token.length > 0);
  if (tokens.length === 0) return [];
  const core = await coreTokensForJoinTokens(env, tokens);
  return [...new Set([...tokens, ...core.values()])];
}

/**
 * A guest who booked on Meet's page joins with Meet's token. Core merges a
 * call into the booking's interaction by its own token, so the payload names
 * Core's token wherever D1 knows it (booking-store.ts). Any other token goes
 * as it is.
 */
async function withCoreBookingTokens(env: Env, payload: MeetingLogPayload): Promise<MeetingLogPayload> {
  const tokens = [payload.booking_token, ...payload.participants.map((participant) => participant.booking_token)]
    .filter((token): token is string => typeof token === 'string' && token.length > 0);
  if (tokens.length === 0) return payload;
  const core = await coreTokensForJoinTokens(env, tokens);
  if (core.size === 0) return payload;
  const swap = (token: string | null | undefined) => (token ? core.get(token) ?? token : token);
  return {
    ...payload,
    booking_token: swap(payload.booking_token) ?? null,
    participants: payload.participants.map((participant) => ({ ...participant, booking_token: swap(participant.booking_token) ?? null })),
  };
}

/**
 * Read the roster from the DO and push the live phase. Throws on failure.
 * The `ended` phase is the delivery ledger's (`deliveries.ts`),
 * which files the transcript document and retries per destination; this
 * is the row Core gets while the meeting is still on.
 */
export async function syncMeetingLog(
  env: Env,
  roomSlug: string,
  meetingId: string,
  phase: MeetingLogPhase,
): Promise<void> {
  const room = await roomStub(env, roomSlug);
  const material = await room.meetingLogMaterial(meetingId);
  const transcriptURL = material.transcriptDocumentPath ? docsDocumentURL(env, material.transcriptDocumentPath) : null;
  await postMeetingLog(env, buildMeetingLogPayload(material, phase, { publicOrigin: workspacePublicOrigin(env), transcriptURL }));
  console.log(JSON.stringify({
    level: 'info',
    message: 'crm.meeting-log.sent',
    meetingId,
    roomSlug,
    phase,
    participantCount: material.participants.length,
    transcriptSegmentCount: phase === 'ended' ? material.transcript.length : 0,
  }));
}

/**
 * Best-effort variant for the live meeting path (start). A CRM outage must
 * never delay or fail a host pressing Start; the ledger carries the same
 * row at the end regardless.
 */
export async function syncMeetingLogQuietly(
  env: Env,
  roomSlug: string,
  meetingId: string,
  phase: MeetingLogPhase,
): Promise<void> {
  if (!workModelEnabled(env)) return;
  try {
    await syncMeetingLog(env, roomSlug, meetingId, phase);
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'crm.meeting-log.failed',
      meetingId,
      roomSlug,
      phase,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/** Signed GET to Core's Meet subject typeahead. */
export async function fetchCrmSubjects(
  env: Env,
  kind: 'lead' | 'project' | 'organization' | 'event',
  query: string,
  status?: string,
  limit = SUBJECT_PAGE,
  /** Events only: the reader's `YYYY-MM-DD`, so "open" means open where they are (docs/EVENTS.md). */
  today?: string,
  /** Organizations only. Nothing set lists the partners. */
  organizations: CrmOrganizationFilter = {},
  /** Leads only, once they answer from D1: Core's own list has no source. */
  leadSource?: string,
): Promise<{
  subjects: CrmSubject[];
  hasMore: boolean;
  facets?: CrmOrganizationFacets;
}> {
  if (!usesCoreForKind(env, kind)) return d1Subjects(env, kind, query, status, limit, organizations, leadSource);
  const searchParams: Record<string, string> = { kind, limit: String(limit) };
  if (query.trim()) searchParams.q = query.trim();
  if (status?.trim()) searchParams.status = status.trim();
  if (today?.trim()) searchParams.today = today.trim();
  if (kind === 'organization') Object.assign(searchParams, coreOrganizationFilter(organizations));
  // A picker asks per keystroke and a screen asks twice; one read serves both.
  return memoCore(`subjects:${coreOrigin(env)}:${JSON.stringify(searchParams)}`, () => readCrmSubjects(env, searchParams));
}

/**
 * The organization filters as Core's `meet-crm-subjects` reads them (envisioning/core,
 *). Only what differs from the default goes, so a partners list asks
 * exactly what it asked before the filters existed.
 */
function coreOrganizationFilter(filter: CrmOrganizationFilter): Record<string, string> {
  const params: Record<string, string> = {};
  if (filter.partner === false) params.partner = 'false';
  if (filter.agency) params.agency = 'true';
  if (filter.existing_client) params.existing_client = 'true';
  if (filter.industry?.trim()) params.industry = filter.industry.trim();
  if (filter.country?.trim()) params.country = filter.country.trim();
  return params;
}

async function readCrmSubjects(env: Env, searchParams: Record<string, string>): Promise<{
  subjects: CrmSubject[];
  hasMore: boolean;
  facets?: CrmOrganizationFacets;
}> {
  const response = await signedCoreFetch(env, '/api/public/meet-crm-subjects', { method: 'GET', searchParams });
  if (!response.ok) {
    throw coreFailure('subject list', response);
  }
  const data = await readCoreJson(response, z.looseObject({
    subjects: optionalList(subjectRow),
    has_more: z.boolean().nullish(),
    // A Core without the filters sends none; the list still reads.
    facets: crmOrganizationFacetsSchema.nullish().catch(undefined),
  }), 'GET /api/public/meet-crm-subjects');
  return {
    subjects: data.subjects ?? [],
    hasMore: data.has_more === true,
    ...(data.facets ? { facets: data.facets } : {}),
  };
}

/**
 * One subject by id, for opening its channel.
 *
 * Core handles the exact lookup and returns the canonical subject title and
 * identity. The same endpoint also serves the browse list, but this path must
 * not fall back to that list: an archived subject may be outside the default
 * page and still needs to open reliably. See docs/CHANNELS.md.
 */
export function fetchCrmSubject(
  env: Env,
  kind: 'lead' | 'project' | 'organization' | 'event',
  id: string,
): Promise<CrmSubject | null> {
  if (!usesCoreForKind(env, kind)) return d1Subject(env, kind, id);
  // Not memoised: threads read it to follow a rename and to refuse a subject Core dropped.
  return readCrmSubject(env, kind, id);
}

async function readCrmSubject(
  env: Env,
  kind: 'lead' | 'project' | 'organization' | 'event',
  id: string,
): Promise<CrmSubject | null> {
  const response = await signedCoreFetch(env, '/api/public/meet-crm-subjects', {
    method: 'GET',
    searchParams: { kind, id },
  });
  if (!response.ok) {
    throw coreFailure('subject lookup', response);
  }
  const data = await readCoreJson(response, z.looseObject({
    subject: subjectRow.nullish(),
    subjects: optionalList(subjectRow),
  }), 'GET /api/public/meet-crm-subjects');
  if (data.subject?.id === id) return data.subject;
  return (data.subjects ?? []).find((subject) => subject.id === id) ?? null;
}

/**
 * Does Core have this subject? Asked by id, and strict about what "no" means
 *: a removal is built on the answer, and an error from Core must
 * never read as "the subject is gone".
 *
 * "Not found" is exactly one answer: HTTP 200, `ok: true`, and an empty
 * `subjects` list with no `subject` (what Core sends for an exact-id lookup
 * that matched nothing). Everything else throws a `CrmSyncError`: a 4xx, a
 * 5xx, a timeout (the fetch rejects), a body that is not that shape, a list
 * that holds other subjects (Core ignored the id and answered a browse). The
 * caller can refuse and say Core could not be reached; it can never conclude
 * absence from anything but Core's own "nothing with that id".
 */
export async function lookupCrmSubjectById(
  env: Env,
  kind: 'lead' | 'project' | 'organization' | 'event',
  id: string,
): Promise<{ found: true; subject: CrmSubject } | { found: false }> {
  if (!usesCoreForKind(env, kind)) {
    const subject = await d1Subject(env, kind, id);
    return subject ? { found: true, subject } : { found: false };
  }
  const response = await signedCoreFetch(env, '/api/public/meet-crm-subjects', {
    method: 'GET',
    searchParams: { kind, id },
  });
  if (response.status !== 200) throw coreFailure('subject lookup', response);
  const route = 'GET /api/public/meet-crm-subjects';
  const data = await readCoreJson(response, z.looseObject({
    ok: z.literal(true),
    subject: subjectRow.nullish(),
    subjects: z.array(subjectRow),
  }), route);
  if (data.subject?.id === id) return { found: true, subject: data.subject };
  const match = data.subjects.find((subject) => subject.id === id);
  if (match) return { found: true, subject: match };
  if (!data.subject && data.subjects.length === 0) return { found: false };
  throw new CrmSyncError('Core answered the subject lookup with a different subject.', 502, 'upstream_shape');
}

/** Load the editable projection of one lead or project. */
export function fetchCrmSubjectDetail(
  env: Env,
  kind: 'lead' | 'project' | 'organization' | 'event',
  id: string,
): Promise<CrmSubjectDetail> {
  if (!usesCoreForKind(env, kind)) return d1SubjectDetail(env, kind, id);
  return memoCore(`subject-detail:${coreOrigin(env)}:${kind}:${id}`, () => readCrmSubjectDetail(env, kind, id));
}

async function readCrmSubjectDetail(
  env: Env,
  kind: 'lead' | 'project' | 'organization' | 'event',
  id: string,
): Promise<CrmSubjectDetail> {
  const response = await signedCoreFetch(env, '/api/public/meet-crm-subjects', {
    method: 'GET',
    searchParams: { kind, id },
  });
  if (!response.ok) {
    throw coreFailure('subject detail', response);
  }
  // Core answers an id query two different ways. Partner and event return
  // `subject` alongside `subjects`; lead and project return the list alone.
  // Reading only `subject` therefore 502'd every lead and project — which is
  // to say Edit details… on the two kinds Meet can actually edit.
  // The list is browse rows; only the row asked for must carry the detail.
  const route = 'GET /api/public/meet-crm-subjects';
  const data = await readCoreJson(response, z.looseObject({
    subject: subjectDetailRow.nullish(),
    subjects: optionalList(subjectRow),
  }), route);
  if (data.subject) return data.subject;
  const listed = data.subjects?.find((row) => row.id === id);
  if (!listed) throw new CrmSyncError('Core returned no subject detail.', 502);
  return parseCoreBody(subjectDetailRow, listed, route);
}

/** Create a lead or project, with the verified Meet owner recorded by Core. */
export async function createCrmSubject(
  env: Env,
  input: Record<string, unknown>,
  actor: string,
): Promise<CrmSubjectDetail> {
  // The plan's project limit. Null on Starter and Pro, and on a
  // workspace with no stored plan.
  const projectLimit = input.kind === 'project' ? await projectLimitForCreate(env) : null;
  await assertGroupWritable(env, 'subjects');
  if (!usesCoreFor(env, 'subjects')) {
    // The board and search keep the open subjects in the minute cache on a
    // D1 workspace too, so a write purges them here as it does for Core.
    const subject = await d1CreateSubject(env, input, actor, projectLimit);
    await purgeRecordCaches(input.kind === 'lead' ? 'leads' : 'projects', null);
    const table = input.kind === 'lead' ? 'leads' : 'projects';
    const leadId = input.kind === 'project' && typeof input.lead_id === 'string' && input.lead_id ? input.lead_id : null;
    await recordWorkActivity(env,
      { actor, table, id: subject.id, action: 'insert', label: subject.title, fields: fieldsOf(input) },
      // A project started from a lead wins it (work-d1.ts).
      ...(leadId ? [{ actor, table: 'leads', id: leadId, action: 'update' as const, fields: ['status'] }] : []));
    return subject;
  }
  const response = await signedCoreFetch(env, '/api/public/meet-crm-subjects', {
    method: 'POST',
    body: JSON.stringify({ ...input, actor }),
  });
  if (!response.ok) {
    throw await coreWriteFailure('subject create', response);
  }
  const data = await readCoreJson(response, z.looseObject({ subject: subjectDetailRow.nullish() }), 'POST /api/public/meet-crm-subjects');
  if (!data.subject) throw new CrmSyncError('Core subject create returned no subject.', 502);
  await purgeRecordCaches(input.kind === 'lead' ? 'leads' : 'projects', null);
  return data.subject;
}

/** Update one subject. Core owns field validation and authorization. */
export async function updateCrmSubject(
  env: Env,
  kind: 'lead' | 'project',
  id: string,
  input: Record<string, unknown>,
  actor: string,
): Promise<CrmSubjectDetail> {
  await assertGroupWritable(env, 'subjects');
  if (!usesCoreFor(env, 'subjects')) {
    const subject = await d1UpdateSubject(env, kind, id, input, actor);
    await purgeRecordCaches(kind === 'lead' ? 'leads' : 'projects', null);
    await recordWorkActivity(env, { actor, table: kind === 'lead' ? 'leads' : 'projects', id, action: 'update', label: subject.title, fields: fieldsOf(input) });
    return subject;
  }
  const response = await signedCoreFetch(env, '/api/public/meet-crm-subjects', {
    method: 'PATCH',
    searchParams: { kind, id },
    body: JSON.stringify({ ...input, actor }),
  });
  if (!response.ok) {
    throw await coreWriteFailure('subject update', response);
  }
  const data = await readCoreJson(response, z.looseObject({ subject: subjectDetailRow.nullish() }), 'PATCH /api/public/meet-crm-subjects');
  if (!data.subject) throw new CrmSyncError('Core subject update returned no subject.', 502);
  // A rename or a status change moves the row on the board's subject list
  // and the number beside a status.
  await purgeRecordCaches(kind === 'lead' ? 'leads' : 'projects', null);
  return data.subject;
}

/**
 * The status badges for one kind, from Core's `counts=1` mode on the same
 * subjects route: every row that matches `query`, counted by status, in one
 * request. Cached for the plain (no query) read only — a search box is per
 * keystroke and per person, not a shared list. See docs/WORK.md.
 */
export async function fetchCrmSubjectCounts(
  env: Env,
  kind: 'lead' | 'project',
  query: string,
): Promise<CrmSubjectCountsResponse> {
  if (!usesCoreFor(env, 'subjects')) return d1SubjectCounts(env, kind, query);
  const needle = query.trim();
  const live = async (): Promise<CrmSubjectCountsResponse> => {
    const response = await signedCoreFetch(env, '/api/public/meet-crm-subjects', {
      method: 'GET',
      searchParams: needle ? { kind, counts: '1', q: needle } : { kind, counts: '1' },
    });
    if (!response.ok) {
      throw coreFailure('subject counts', response);
    }
    // Values stay `unknown`: `numbersOnly` drops a count that is not a number, as it always has.
    const data = await readCoreJson(response, z.looseObject({
      counts: z.record(z.string(), z.unknown()).nullish(),
      internal: z.record(z.string(), z.unknown()).nullish(),
    }), 'GET /api/public/meet-crm-subjects?counts=1');
    const counts = numbersOnly(data.counts);
    if (kind === 'lead') return { counts };
    const internal = numbersOnly(data.internal);
    const client: CrmSubjectStatusCounts = {};
    for (const [status, total] of Object.entries(counts)) {
      client[status] = Math.max(0, total - (internal[status] ?? 0));
    }
    return { counts, internal, client };
  };
  return needle ? live() : cachedRead(`subject-counts/${kind}`, live);
}

/** Core's bucket as numbers, dropping anything that is not one. */
function numbersOnly(bucket: Record<string, unknown> | null | undefined): CrmSubjectStatusCounts {
  const counts: CrmSubjectStatusCounts = {};
  for (const [status, value] of Object.entries(bucket ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) counts[status] = value;
  }
  return counts;
}

/** Core's task projection is the shared task wire contract. */
export type CrmTaskRow = CrmTask;

const interactionsBody = z.looseObject({ interactions: optionalList(crmInteractionRowSchema.loose()) });

/**
 * Read the compact interaction projection for one Work subject. Core remains
 * the source of truth; the Worker only exposes the fields the pane needs and
 * keeps the Core credential off every client.
 */
export async function fetchCrmInteractions(
  env: Env,
  subject: { projectId?: string | null; leadId?: string | null; organizationId?: string | null },
  limit = 50,
): Promise<CrmInteractionRow[]> {
  if (!usesCoreFor(env, 'interactions')) return d1Interactions(env, subject, limit);
  const response = await signedCoreFetch(env, '/api/public/meet-crm-interactions', {
    method: 'GET',
    searchParams: {
      project_id: subject.projectId ?? '',
      lead_id: subject.leadId ?? '',
      // A partner's history: everything filed under the organization.
      organization_id: subject.organizationId ?? '',
      limit: String(limit),
    },
  });
  if (!response.ok) {
    throw coreFailure('interaction list', response);
  }
  const data = await readCoreJson(response, interactionsBody, 'GET /api/public/meet-crm-interactions');
  return data.interactions ?? [];
}

/**
 * A `source=granola` row: the pane's row plus where it was filed.
 * The four filing fields read absent as null, so a Core that leaves one out
 * still lists the note as imported.
 */
export const crmLedgerRowSchema = crmInteractionRowSchema.extend({
  meeting_kind: z.string().nullable().default(null),
  granola_note_id: z.string().nullable().default(null),
  transcript_document_id: z.string().nullable().default(null),
  subject_title: z.string().nullable().default(null),
});
export type CrmLedgerRow = z.infer<typeof crmLedgerRowSchema>;

/**
 * Every interaction the Granola bridge has written, filed or not — the import
 * list's "already here" column. One read, up to a thousand rows: a ledger, not
 * a pane. `noteId` narrows it to one note, for the bridge to learn what it
 * wrote before (the Docs document to replace rather than duplicate).
 */
export async function fetchGranolaLedger(env: Env, noteId?: string): Promise<CrmLedgerRow[]> {
  // The bridge writes through the meeting log, so its rows are wherever the group is.
  if (!usesCoreFor(env, 'interactions')) return d1GranolaLedger(env, noteId);
  // A backfill has the queue writing Core as fast as it allows, and every
  // read in that window can meet a 429. Two pauses before giving up: the
  // list, the suggest button and the suggest job all read this, and none of
  // them is better off failing than waiting a few seconds.
  const response = await signedCoreFetch(env, '/api/public/meet-crm-interactions', {
    method: 'GET',
    searchParams: noteId
      ? { granola_note_id: noteId, limit: '1' }
      : { source: 'granola', limit: '1000' },
    pauseMs: LEDGER_RATE_LIMIT_PAUSE_MS,
  });
  if (!response.ok) {
    throw coreFailure('ledger read', response);
  }
  const data = await readCoreJson(response, z.looseObject({
    interactions: optionalList(crmLedgerRowSchema.loose()),
  }), 'GET /api/public/meet-crm-interactions?source=granola');
  return data.interactions ?? [];
}
const LEDGER_RATE_LIMIT_PAUSE_MS = 3_000;
const TASK_RATE_LIMIT_PAUSE_MS = 1_500;

async function coreTaskGet(env: Env, path: string, searchParams: Record<string, string>): Promise<Response> {
  return signedCoreFetch(env, path, { method: 'GET', searchParams, pauseMs: TASK_RATE_LIMIT_PAUSE_MS });
}

/**
 * Every task in one status, across every project and lead, newest first.
 * One read where the per-subject walk made eighty: a Worker invocation has a
 * subrequest budget, and INBOX's proposed-task walk over every open subject
 * spent it (2026-09-16, "Too many subrequests by single Worker invocation").
 */
export async function fetchCrmTasksByStatus(env: Env, status: string, limit = 100, offset = 0): Promise<CrmTaskRow[]> {
  if (!usesCoreFor(env, 'tasks')) return d1TasksByStatus(env, status, limit, offset);
  const response = await coreTaskGet(env, '/api/public/meet-crm-tasks', {
    status, limit: String(limit), ...(offset > 0 ? { offset: String(offset) } : {}),
  });
  if (!response.ok) {
    throw coreFailure('task list', response);
  }
  const data = await readCoreJson(response, z.looseObject({ tasks: optionalList(taskRow) }), 'GET /api/public/meet-crm-tasks?status=');
  return data.tasks ?? [];
}

/**
 * Interactions dated on or after `since`, across every project and lead,
 * newest first. The cross-subject twin of `fetchCrmTasksByStatus`, for the
 * same reason.
 */
export async function fetchCrmInteractionsSince(env: Env, since: Date, limit = 100): Promise<CrmInteractionRow[]> {
  if (!usesCoreFor(env, 'interactions')) return d1InteractionsSince(env, since, limit);
  const response = await signedCoreFetch(env, '/api/public/meet-crm-interactions', {
    method: 'GET',
    searchParams: { since: since.toISOString(), limit: String(limit) },
  });
  if (!response.ok) {
    throw coreFailure('interaction list', response);
  }
  const data = await readCoreJson(response, interactionsBody, 'GET /api/public/meet-crm-interactions?since=');
  return data.interactions ?? [];
}

// ── Interactions by hand ───────────────────────────────────────
// A call, meeting or note a member logs, edits or deletes on a subject's
// History. Core's agent route writes it while the `interactions` group is on
// Core; D1 after, through the one D1 interaction write (core-interactions-d1.ts),
// in Core's names: the summary is Core's description too, as Core's agent
// route stores it.

/** A member's fields in Core's interaction names. */
function manualInteractionValues(input: CrmInteractionUpdate): CoreInteractionValues {
  const values: CoreInteractionValues = {};
  if (input.type !== undefined) values.type = input.type;
  if (input.title !== undefined) values.title = input.title;
  if (input.occurred_at !== undefined) values.occurred_at = input.occurred_at;
  if (input.summary_markdown !== undefined) {
    values.summary_markdown = input.summary_markdown || null;
    values.description = input.summary_markdown || null;
  }
  if (input.url !== undefined) values.url = input.url;
  if (input.organization_id !== undefined) values.organization_id = input.organization_id;
  if (input.lead_id !== undefined) values.lead_id = input.lead_id;
  if (input.project_id !== undefined) values.project_id = input.project_id;
  return values;
}

const coreInteractionAnswer = z.looseObject({ data: z.lazy(() => coreAgentInteraction) });

/** Core's agent route body for a member's fields. */
function coreInteractionBody(input: CrmInteractionUpdate): Record<string, unknown> {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.type !== undefined ? { type: input.type } : {}),
    ...(input.occurred_at !== undefined ? { occurred_at: input.occurred_at, interactionDate: input.occurred_at } : {}),
    ...(input.summary_markdown !== undefined ? { description: input.summary_markdown || null } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.organization_id !== undefined ? { organization_id: input.organization_id } : {}),
    ...(input.lead_id !== undefined ? { lead_id: input.lead_id } : {}),
    ...(input.project_id !== undefined ? { project_id: input.project_id } : {}),
    ...(input.contact_ids !== undefined ? { contact_ids: input.contact_ids } : {}),
  };
}

/** The Histories a write changed: the subjects of the row before and after it. */
async function purgeInteractionHistories(...rows: ReadonlyArray<Record<string, unknown> | null | undefined>): Promise<void> {
  for (const row of rows) if (row) await purgeRecordCaches('interactions', null, row);
}

async function d1InteractionOrThrow(env: Env, id: string): Promise<CrmInteraction> {
  const row = await d1InteractionRecord(env, id);
  if (!row) throw new ControlError('No interaction with that id.', 404, 'request_not_found');
  return row;
}

/** One interaction as History draws it, from the group's store. Null when none has the id, or it is personal. */
export async function fetchCrmInteraction(env: Env, actorEmail: string, id: string): Promise<CrmInteraction | null> {
  if (!usesCoreFor(env, 'interactions')) return d1InteractionRecord(env, id);
  const response = await corePatFetch(env, actorEmail, `/api/agent/interactions/${encodeURIComponent(id)}`, { method: 'GET' });
  if (response.status === 404) return null;
  if (!response.ok) throw coreFailure('interaction read', response);
  return interactionFromCore((await readCoreJson(response, coreInteractionAnswer, 'GET /api/agent/interactions/:id')).data);
}

export async function createCrmInteraction(env: Env, actorEmail: string, input: CrmInteractionCreate): Promise<CrmInteraction> {
  await assertGroupWritable(env, 'interactions');
  if (!usesCoreFor(env, 'interactions')) {
    const values = manualInteractionValues(input);
    const written = await writeD1Interaction(env, actorEmail, {
      action: 'create', entity: 'interactions', values: { ...values, title: input.title, type: input.type }, contact_ids: input.contact_ids,
    });
    await purgeInteractionHistories(written?.after);
    return d1InteractionOrThrow(env, written!.id);
  }
  const response = await corePatFetch(env, actorEmail, '/api/agent/interactions', { method: 'POST', body: coreInteractionBody(input) });
  if (!response.ok) throw await coreWriteFailure('interaction create', response);
  const created = (await readCoreJson(response, coreInteractionAnswer, 'POST /api/agent/interactions')).data;
  await purgeInteractionHistories(created);
  return interactionFromCore(created);
}

export async function updateCrmInteraction(env: Env, actorEmail: string, id: string, input: CrmInteractionUpdate): Promise<CrmInteraction> {
  await assertGroupWritable(env, 'interactions');
  if (!usesCoreFor(env, 'interactions')) {
    const written = await writeD1Interaction(env, actorEmail, {
      action: 'update', entity: 'interactions', id, values: manualInteractionValues(input),
      ...(input.contact_ids !== undefined ? { contact_ids: input.contact_ids } : {}),
    });
    if (!written) throw new ControlError('No interaction with that id.', 404, 'request_not_found');
    await purgeInteractionHistories(written.before, written.after);
    return d1InteractionOrThrow(env, id);
  }
  const before = await fetchCrmInteraction(env, actorEmail, id);
  const response = await corePatFetch(env, actorEmail, `/api/agent/interactions/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: coreInteractionBody(input),
  });
  if (response.status === 404) throw new ControlError('No interaction with that id.', 404, 'request_not_found');
  if (!response.ok) throw await coreWriteFailure('interaction update', response);
  const updated = (await readCoreJson(response, coreInteractionAnswer, 'PATCH /api/agent/interactions/:id')).data;
  await purgeInteractionHistories(before, updated);
  return interactionFromCore(updated);
}

/** The interaction goes with its contact and subject links. Personal rows are not reached here. */
export async function deleteCrmInteraction(env: Env, actorEmail: string, id: string): Promise<{ id: string; deleted: true }> {
  await assertGroupWritable(env, 'interactions');
  if (!usesCoreFor(env, 'interactions')) {
    if (!(await d1InteractionRecord(env, id))) throw new ControlError('No interaction with that id.', 404, 'request_not_found');
    const written = await writeD1Interaction(env, actorEmail, { action: 'delete', entity: 'interactions', id });
    await purgeInteractionHistories(written?.before);
    return { id, deleted: true };
  }
  const before = await fetchCrmInteraction(env, actorEmail, id);
  const response = await corePatFetch(env, actorEmail, `/api/agent/interactions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (response.status === 404) throw new ControlError('No interaction with that id.', 404, 'request_not_found');
  if (!response.ok) throw await coreWriteFailure('interaction delete', response);
  await purgeInteractionHistories(before);
  return { id, deleted: true };
}

/**
 * One signed call to a Core `/api/public/meet-*` route. A 429 is retried
 * (`Retry-After`, else backoff from `pauseMs`) for reads and writes alike: Core
 * refused the request before acting on it, so a create cannot land twice.
 * Core has no idempotency key on these routes; a timeout or 5xx is never
 * retried here, because those *can* have been applied.
 */
export async function signedCoreFetch(
  env: Env,
  path: string,
  init: { method: string; body?: string; searchParams?: Record<string, string>; retries?: number; pauseMs?: number },
): Promise<Response> {
  return withCoreRetry(() => signedCoreFetchOnce(env, path, init), {
    ...(init.retries !== undefined ? { retries: init.retries } : {}),
    ...(init.pauseMs !== undefined ? { pauseMs: init.pauseMs } : {}),
  });
}

/**
 * Core still names the organization subject `partner` (ADR 0006). Every
 * request to Core crosses that boundary here: a `kind` or `subject_kind` of
 * `organization`, in the query or anywhere in a JSON body, goes as `partner`.
 * Answers come back through the contracts' kind schemas, which read
 * `partner` as `organization`.
 */
const CORE_KIND_KEYS = new Set(['kind', 'subject_kind']);

/**
 * The kind a derived id hashes. Thread and guest-thread ids were minted from
 * `partner:<id>` before ADR 0006; hashing `organization` as `partner` keeps
 * every existing id, so no conversation is orphaned by the rename.
 */
export function idKind(kind: string): string {
  return kind === 'organization' ? 'partner' : kind;
}

export function toCoreKinds<T>(value: T): T {
  if (Array.isArray(value)) return value.map(toCoreKinds) as T;
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [
    key,
    CORE_KIND_KEYS.has(key) && inner === 'organization' ? 'partner' : toCoreKinds(inner),
  ])) as T;
}

function toCoreBody(body: string | undefined): string | undefined {
  if (body === undefined || body === '') return body;
  try {
    return JSON.stringify(toCoreKinds(JSON.parse(body) as unknown));
  } catch {
    return body;
  }
}

async function signedCoreFetchOnce(
  env: Env,
  path: string,
  init: { method: string; body?: string; searchParams?: Record<string, string> },
): Promise<Response> {
  const secret = env.INTERNAL_REQUEST_SECRET?.trim();
  if (!secret) throw new CrmSyncError('INTERNAL_REQUEST_SECRET is not configured.', 503, 'not_configured');
  const coreBody = toCoreBody(init.body);
  const coreSearchParams = toCoreKinds(init.searchParams);
  const rawBody = coreBody ?? '';
  const timestamp = String(Date.now());
  const signature = await hmacSHA256Hex(secret, `${timestamp}.${rawBody}`);
  const url = new URL(`${coreOrigin(env)}${path}`);
  for (const [key, value] of Object.entries(coreSearchParams ?? {})) {
    if (value) url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-internal-timestamp': timestamp,
    'x-internal-signature': signature,
  };
  if (coreBody !== undefined) headers['content-type'] = 'application/json';
  return fetch(url, {
    method: init.method,
    headers,
    ...(coreBody !== undefined ? { body: coreBody } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * Who work can be assigned to. Core is the roster, not Meet: a colleague who
 * has never opened Meet is still assignable work, and the ids here are the ones
 * a task actually stores.
 */
export async function fetchCrmTeam(
  env: Env,
): Promise<Array<{ id: string; name: string; email: string | null }>> {
  if (!usesCore(env)) return d1Team(env);
  const response = await signedCoreFetch(env, '/api/public/meet-team', { method: 'GET' });
  if (!response.ok) {
    throw coreFailure('team list', response);
  }
  const data = await readCoreJson(response, z.looseObject({
    members: optionalList(crmTeamMemberSchema.loose()),
  }), 'GET /api/public/meet-team');
  return data.members ?? [];
}

/**
 * The team member id of `email`, for a new task's default assignee
 *, or null when the address is nobody on the team (an agent, a
 * guest) or the team list does not answer. Never throws: a task is still
 * made, unassigned, when the default cannot be found.
 */
export async function crmMemberIdForEmail(env: Env, email: string): Promise<string | null> {
  const wanted = email.trim().toLowerCase();
  try {
    const members = await fetchCrmTeam(env);
    return members.find((member) => member.email?.trim().toLowerCase() === wanted)?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve calendar invitees against the workspace's contacts, including contact
 * email aliases. This is deliberately separate from `fetchCrmTeam`: a
 * calendar guest can be an external CRM contact and need not have an
 * Envisioning account.
 */
export async function fetchCrmCalendarContacts(
  env: Env,
  emails: string[],
  owner?: OwnerSession,
): Promise<Array<{ id: string; name: string | null; email: string }>> {
  const uniqueEmails = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
  if (uniqueEmails.length === 0) return [];
  if (!usesCoreFor(env, 'subjects')) {
    if (!owner) return [];
    return d1CalendarContacts(env, uniqueEmails, await subjectAccessFor(env, owner));
  }
  const response = await signedCoreFetch(env, '/api/public/meet-calendar-contacts', {
    method: 'GET',
    searchParams: { emails: uniqueEmails.join(',') },
  });
  if (!response.ok) {
    throw coreFailure('calendar contact lookup', response);
  }
  const data = await readCoreJson(response, z.looseObject({
    contacts: optionalList(z.looseObject({ id: z.string(), name: z.string().nullable(), email: z.string() })),
  }), 'GET /api/public/meet-calendar-contacts');
  return data.contacts ?? [];
}

/** Repositories visible to the Core GitHub App, for the project link picker. */
export async function fetchCrmGithubRepos(
  env: Env,
  query: string,
): Promise<CrmGithubRepo[]> {
  if (!usesCore(env)) return d1GithubRepos(env, query);
  const response = await signedCoreFetch(env, '/api/public/meet-github-repos', {
    method: 'GET',
    searchParams: { q: query.trim() },
  });
  if (!response.ok) {
    throw coreFailure('repository search', response);
  }
  const data = await readCoreJson(response, z.looseObject({ repos: optionalList(repoRow) }), 'GET /api/public/meet-github-repos');
  return data.repos ?? [];
}

/** Links already attached to one project. */
export async function fetchCrmProjectRepos(
  env: Env,
  projectId: string,
): Promise<CrmGithubRepo[]> {
  if (!usesCoreFor(env, 'goals')) return d1ProjectRepos(env, projectId);
  const response = await signedCoreFetch(env, '/api/public/meet-project-repos', {
    method: 'GET',
    searchParams: { project_id: projectId },
  });
  if (!response.ok) {
    throw coreFailure('project repositories', response);
  }
  // Core's link route calls these `links`; the Worker contract calls them
  // `repos` because the client is interested in the repository projection.
  // Accept both while Core deployments converge so an existing link does not
  // look like an empty project in the picker.
  const data = await readCoreJson(response, z.looseObject({
    repos: optionalList(repoRow),
    links: optionalList(repoRow),
  }), 'GET /api/public/meet-project-repos');
  return data.repos ?? data.links ?? [];
}

/** Link a repository to a project; Core records the verified actor. */
export async function createCrmProjectRepo(
  env: Env,
  input: {
    project_id: string;
    owner: string;
    repo: string;
    label?: string | null | undefined;
    milestone?: string | null | undefined;
    is_primary?: boolean | undefined;
  },
  actor: string,
): Promise<CrmGithubRepo> {
  await assertGroupWritable(env, 'goals');
  if (!usesCoreFor(env, 'goals')) {
    const repo = await d1CreateProjectRepo(env, input, actor);
    await recordWorkActivity(env, {
      actor, table: 'project_github_repos', id: `${input.project_id}:${repo.owner}/${repo.repo}`, action: 'insert',
      label: `${repo.owner}/${repo.repo}`, fields: fieldsOf(input),
    });
    return repo;
  }
  // Core's route names the person `linked_by` and refuses a body without it.
  const response = await signedCoreFetch(env, '/api/public/meet-project-repos', {
    method: 'POST',
    body: JSON.stringify({ ...input, linked_by: actor }),
  });
  if (!response.ok) {
    throw coreFailure('repository link', response);
  }
  // The current Core route returns `link`; the Worker contract intentionally
  // names the returned projection `repo`. Keep the bridge tolerant of either
  // response while old and new Core deployments overlap.
  const data = await readCoreJson(response, z.looseObject({
    repo: repoRow.nullish(),
    link: repoRow.nullish(),
  }), 'POST /api/public/meet-project-repos');
  const repo = data.repo ?? data.link;
  if (!repo) throw new CrmSyncError('Core returned no linked repository.', 502);
  return repo;
}

/**
 * Which repositories a project's work happens in: Core's project links and
 * Meet's own connector mappings, union ( step 2 makes the second the
 * only one). A repository present only as a mapping has no scope label and
 * is primary only when Core named none.
 */
export async function projectRepoLinks(env: Env, projectId: string): Promise<RepoLink[]> {
  const links: RepoLink[] = [];
  try {
    for (const link of await fetchCrmProjectRepos(env, projectId)) {
      links.push({ owner: link.owner, repo: link.repo, label: link.label, is_primary: link.is_primary });
    }
  } catch {
    // Core down: Meet's own mappings still answer.
  }
  try {
    const { results } = await env.USAGE.prepare(
      `SELECT external_id FROM import_mappings WHERE source = 'github' AND subject_kind = 'project' AND subject_id = ?1`,
    ).bind(projectId).all<{ external_id: string }>();
    for (const row of results) {
      const [owner, repo] = row.external_id.split('/', 2);
      if (!owner || !repo) continue;
      if (links.some((link) => link.owner === owner && link.repo === repo)) continue;
      links.push({ owner, repo, label: null, is_primary: false });
    }
  } catch {
    // A deployment ahead of migration 0045 has Core's links alone.
  }
  if (links.length > 0 && !links.some((link) => link.is_primary)) links[0]!.is_primary = true;
  return links;
}

/**
 * Whether issues go through the Starlings GitHub App ( step 1) or
 * through Core's `meet-github-issues` route. The workspace decides: once it
 * connected GitHub through the broker, Starlings reads and writes GitHub
 * itself, and Core's route is the path a workspace without a connection
 * keeps until that route retires.
 */
async function issuesViaMeetApp(env: Env): Promise<boolean> {
  return githubAppConnected(env);
}

/**
 * A project's GitHub issues. Through Meet's App when it is configured, else
 * through Core, which owns the other App and calls api.github.com for us.
 */
export async function fetchCrmIssues(
  env: Env,
  query: CrmIssueQuery,
): Promise<{ issues: CrmIssue[]; linked: boolean; has_more: boolean }> {
  if (await issuesViaMeetApp(env)) {
    return listProjectIssues(env, await projectRepoLinks(env, query.project_id), {
      state: query.state,
      labels: query.labels,
      assignee: query.assignee,
      milestone: query.milestone,
      creator: query.creator,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      page: query.page,
    });
  }
  // Forwarded, not translated: these are GitHub's own filter names, and Core
  // hands them to GitHub. A parameter nobody set is a parameter nobody sends.
  const searchParams: Record<string, string> = { project_id: query.project_id };
  for (const key of ['state', 'labels', 'assignee', 'milestone', 'creator', 'sort', 'direction'] as const) {
    const value = query[key];
    if (value) searchParams[key] = value;
  }
  for (const key of ['limit', 'page'] as const) {
    const value = query[key];
    if (value !== undefined) searchParams[key] = String(value);
  }

  const response = await signedCoreFetch(env, '/api/public/meet-github-issues', {
    method: 'GET',
    searchParams,
  });
  if (!response.ok) {
    // 503 is Core saying nobody has told it how to reach GitHub. Passing the
    // status through keeps that apart from a project with no issues.
    throw coreFailure('issue list', response);
  }
  const data = await readCoreJson(response, z.looseObject({
    issues: optionalList(issueRow),
    linked: z.boolean().nullish(),
    has_more: z.boolean().nullish(),
  }), 'GET /api/public/meet-github-issues');
  return {
    issues: data.issues ?? [],
    linked: data.linked === true,
    has_more: data.has_more === true,
  };
}

/** One issue with its body and comments. */
export async function fetchCrmIssue(
  env: Env,
  owner: string,
  repo: string,
  number: number,
): Promise<CrmIssueDetail | null> {
  if (await issuesViaMeetApp(env)) return readIssue(env, owner, repo, number);
  const response = await signedCoreFetch(env, '/api/public/meet-github-issues', {
    method: 'GET',
    searchParams: { owner, repo, number: String(number) },
  });
  if (!response.ok) {
    throw coreFailure('issue read', response);
  }
  const data = await readCoreJson(response, z.looseObject({
    issue: crmIssueDetailSchema.loose().nullish(),
  }), 'GET /api/public/meet-github-issues?number=');
  return data.issue ?? null;
}

/**
 * The only host a GitHub avatar may come from. An open image proxy is worth
 * having on a short leash, and this is the one GitHub actually serves from.
 */
const AVATAR_HOST = 'avatars.githubusercontent.com';

/**
 * One avatar, fetched here rather than by the device.
 *
 * The point is not the bytes — those are public — but who asks for them. A
 * device loading avatars directly tells GitHub's CDN the owner's address and,
 * from the pattern of requests, roughly which issues they are reading. Every
 * other GitHub call in this app already goes device → Worker → Core → GitHub,
 * and PRIVACY.md says no device talks to GitHub; an image is not the thing to
 * make that sentence false for.
 *
 * Immutable in practice: GitHub mints a new URL when somebody changes their
 * picture, so this answers with a long cache and the edge keeps it.
 */
export async function fetchGithubAvatar(raw: string, size: number): Promise<Response> {
  let source: URL;
  try {
    source = new URL(raw);
  } catch {
    throw new CrmSyncError('Not an avatar URL.', 400);
  }
  if (source.protocol !== 'https:' || source.hostname !== AVATAR_HOST) {
    throw new CrmSyncError('Not an avatar URL.', 400);
  }
  // Rebuilt from parts rather than forwarded, so nothing a caller appended to
  // the query travels on to GitHub.
  const wanted = new URL(`https://${AVATAR_HOST}${source.pathname}`);
  wanted.searchParams.set('s', String(size));

  const response = await fetch(wanted, {
    headers: { accept: 'image/*', 'user-agent': 'starlings' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new CrmSyncError(`GitHub avatar failed (${response.status}).`, response.status);
  }
  const type = response.headers.get('content-type') ?? '';
  // A CDN that answered with something other than an image is a redirect
  // somewhere, and this route exists precisely so that nothing else is drawn.
  if (!type.startsWith('image/')) {
    throw new CrmSyncError('Not an image.', 502);
  }
  // A week and immutable, which is honest: GitHub mints a new URL when
  // somebody changes their picture. The clients' own URL caches do the real
  // work — the second time a face is drawn, nothing leaves the device.
  return new Response(response.body, {
    headers: {
      'content-type': type,
      'cache-control': 'public, max-age=604800, immutable',
    },
  });
}

/** What an issue in one repository could be set to, for the pickers. */
export async function fetchCrmIssueFacets(
  env: Env,
  owner: string,
  repo: string,
): Promise<CrmIssueFacetsResponse> {
  if (await issuesViaMeetApp(env)) return readRepoFacets(env, owner, repo);
  const response = await signedCoreFetch(env, '/api/public/meet-github-issues', {
    method: 'GET',
    searchParams: { owner, repo, facets: '1' },
  });
  if (!response.ok) {
    throw coreFailure('repository read', response);
  }
  const data = await readCoreJson(response, z.looseObject({
    labels: optionalList(crmIssueLabelSchema.loose()),
    milestones: optionalList(crmIssueMilestoneSchema.loose()),
    assignees: optionalList(crmIssueUserSchema.loose()),
  }), 'GET /api/public/meet-github-issues?facets=1');
  return {
    labels: data.labels ?? [],
    milestones: data.milestones ?? [],
    assignees: data.assignees ?? [],
  };
}

/**
 * File or change an issue. `actor` is added here from the verified session and
 * never taken from the request body: a client that could name its own author
 * could write into the record as somebody else.
 */
export async function writeCrmIssue(
  env: Env,
  method: 'POST' | 'PATCH',
  input: Record<string, unknown>,
  actor: string,
): Promise<CrmIssue | null> {
  if (await issuesViaMeetApp(env)) {
    const written = await writeIssueViaMeetApp(env, method, input, actor);
    if (typeof input.project_id === 'string') await purgeCoreCache([`issues/${input.project_id}`]);
    else if (method === 'PATCH') await purgeIssueCaches();
    return written;
  }
  const response = await signedCoreFetch(env, '/api/public/meet-github-issues', {
    method,
    body: JSON.stringify({ ...input, actor }),
  });
  if (!response.ok) {
    throw coreFailure('issue write', response);
  }
  const data = await readCoreJson(response, z.looseObject({
    issue: issueRow.nullish(),
  }), `${method} /api/public/meet-github-issues`);
  if (typeof input.project_id === 'string') await purgeCoreCache([`issues/${input.project_id}`]);
  else if (method === 'PATCH') await purgeIssueCaches();
  return data.issue ?? null;
}

/**
 * The write half of `writeCrmIssue` on Meet's App. The body was parsed by
 * `crmIssueCreateSchema` or `crmIssueUpdateSchema` at the route, so the
 * fields are read by name here rather than validated again. A create goes
 * to the project's primary repository; without one there is no answer to
 * "which repository", and guessing would file it somewhere nobody looks.
 */
async function writeIssueViaMeetApp(
  env: Env,
  method: 'POST' | 'PATCH',
  input: Record<string, unknown>,
  actor: string,
): Promise<CrmIssue> {
  if (method === 'POST') {
    const projectId = String(input.project_id ?? '');
    const links = await projectRepoLinks(env, projectId);
    const primary = links.find((link) => link.is_primary);
    if (!primary) throw new CrmSyncError('This project has no primary repository.', 409);
    // A task filed on GitHub keeps its issue. On D1 the link is
    // the workspace's own; a Core workspace's tasks live in Core.
    const taskId = typeof input.task_id === 'string' && !usesCoreFor(env, 'tasks') ? input.task_id : null;
    if (taskId) await assertGroupWritable(env, 'tasks');
    if (taskId) await d1AssertTaskFileable(env, taskId, projectId);
    const issue = await createIssue(env, primary, {
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : undefined,
      labels: Array.isArray(input.labels) ? input.labels as string[] : undefined,
      assignees: Array.isArray(input.assignees) ? input.assignees as string[] : undefined,
      milestone: typeof input.milestone === 'number' ? input.milestone : undefined,
    }, actor);
    if (taskId) {
      await d1LinkTaskToIssue(env, taskId, issue);
      await recordWorkActivity(env, { actor, table: 'tasks', id: taskId, action: 'update', fields: ['github_owner', 'github_repo', 'github_issue_number'] });
    }
    return issue;
  }
  return updateIssue(env, String(input.owner ?? ''), String(input.repo ?? ''), Number(input.number ?? 0), {
    title: typeof input.title === 'string' ? input.title : undefined,
    body: typeof input.body === 'string' ? input.body : undefined,
    state: input.state === 'open' || input.state === 'closed' ? input.state : undefined,
    state_reason: input.state_reason === 'completed' || input.state_reason === 'not_planned' ? input.state_reason : undefined,
    labels: Array.isArray(input.labels) ? input.labels as string[] : undefined,
    assignees: Array.isArray(input.assignees) ? input.assignees as string[] : undefined,
    milestone: input.milestone === null || typeof input.milestone === 'number' ? input.milestone : undefined,
    comment: typeof input.comment === 'string' ? input.comment : undefined,
  }, actor);
}

/**
 * Everything one person owes, across every subject. The address comes from the
 * verified session, so nobody can ask what somebody else is carrying.
 */
export function fetchCrmMyWork(
  env: Env,
  assigneeEmail: string,
): Promise<{ tasks: CrmMyTask[]; issues: CrmIssue[]; matched: boolean; github_login: string | null }> {
  if (!usesCoreFor(env, 'tasks')) return d1MyWork(env, assigneeEmail);
  // Home's inbox, Mine and the recently-closed list all read this at once.
  return memoCore(`my-work:${coreOrigin(env)}:${assigneeEmail}`, () => readCrmMyWork(env, assigneeEmail));
}

async function readCrmMyWork(
  env: Env,
  assigneeEmail: string,
): Promise<{ tasks: CrmMyTask[]; issues: CrmIssue[]; matched: boolean; github_login: string | null }> {
  const response = await signedCoreFetch(env, '/api/public/meet-my-work', {
    method: 'GET',
    searchParams: { assignee_email: assigneeEmail },
  });
  if (!response.ok) {
    throw coreFailure('my-work', response);
  }
  const data = await readCoreJson(response, z.looseObject({
    tasks: optionalList(crmMyTaskSchema.loose()),
    issues: optionalList(issueRow),
    matched: z.boolean().nullish(),
    github_login: z.string().nullish(),
  }), 'GET /api/public/meet-my-work');
  return {
    tasks: data.tasks ?? [],
    issues: data.issues ?? [],
    matched: data.matched === true,
    github_login: data.github_login ?? null,
  };
}

/**
 * Say who the signed-in member is on GitHub. The address comes from the
 * session, so this can only ever change your own record.
 */
export async function setCrmGithubLogin(
  env: Env,
  actor: string,
  login: string | null,
): Promise<string | null> {
  const response = await signedCoreFetch(env, '/api/public/meet-team', {
    method: 'PATCH',
    body: JSON.stringify({ actor, github_login: login }),
  });
  if (!response.ok) {
    throw coreFailure('username write', response);
  }
  const data = await readCoreJson(response, z.looseObject({ github_login: z.string().nullish() }), 'PATCH /api/public/meet-team');
  return data.github_login ?? null;
}

export async function fetchCrmTasks(
  env: Env,
  subject: { projectId?: string | null; leadId?: string | null; eventId?: string | null; organizationId?: string | null; meetingId?: string | null; signalsAccountId?: string | null; includeDone?: boolean; limit?: number },
): Promise<CrmTaskRow[]> {
  if (!usesCoreFor(env, 'tasks')) return d1Tasks(env, subject);
  const response = await coreTaskGet(env, '/api/public/meet-crm-tasks', {
    project_id: subject.projectId ?? '',
    lead_id: subject.leadId ?? '',
    event_id: subject.eventId ?? '',
    // A partner's own work: Core reads it by organization.
    organization_id: subject.organizationId ?? '',
    meeting_id: subject.meetingId ?? '',
    // A Signals account's tasks.
    signals_account_id: subject.signalsAccountId ?? '',
    // Core answers open work unless told otherwise; the board asks for the
    // recently finished too, so its last two columns are not always empty.
    include_done: subject.includeDone ? '1' : '',
    limit: subject.limit ? String(subject.limit) : '',
  });
  if (!response.ok) {
    throw coreFailure('task list', response);
  }
  const data = await readCoreJson(response, z.looseObject({ tasks: optionalList(taskRow) }), 'GET /api/public/meet-crm-tasks');
  return data.tasks ?? [];
}

/**
 * Every partner's own tasks in one Core read (`scope=partner`): tasks with an
 * organization and no project, lead, event or meeting. The board cannot read
 * one partner at a time (subrequest budget), so it asks once. Cached under
 * `tasks/partner/all`; `taskCacheKeys` purges it on a partner-task write.
 */
export async function fetchCrmPartnerTasks(
  env: Env,
  options: { includeDone?: boolean; limit?: number } = {},
): Promise<CrmTaskRow[]> {
  if (!usesCoreFor(env, 'tasks')) return d1PartnerTasks(env, options);
  return cachedRead('tasks/partner/all', async () => {
    const response = await coreTaskGet(env, '/api/public/meet-crm-tasks', {
      scope: 'partner',
      include_done: options.includeDone ? '1' : '',
      limit: options.limit ? String(options.limit) : '',
    });
    if (!response.ok) {
      throw coreFailure('partner task list', response);
    }
    const data = await readCoreJson(response, z.looseObject({ tasks: optionalList(taskRow) }), 'GET /api/public/meet-crm-tasks?scope=partner');
    return data.tasks ?? [];
  });
}

/**
 * Every partner subject, one cached read shared with the Granola suggester
 * (`subjects/all/partner`, same page size and shape).
 */
export async function fetchCachedPartnerSubjects(env: Env): Promise<CrmSubject[]> {
  if (!usesCoreFor(env, 'subjects')) return (await fetchCrmSubjects(env, 'organization', '', undefined, 100)).subjects;
  const page = await cachedRead('subjects/all/partner', () => fetchCrmSubjects(env, 'organization', '', undefined, 100), { ttlSeconds: 300 });
  return page.subjects;
}

/** Resolve one favorite through Core's authorized task-by-id read. */
export async function fetchCrmTask(env: Env, taskId: string): Promise<CrmTaskRow | null> {
  if (!usesCoreFor(env, 'tasks')) return d1Task(env, taskId);
  const response = await signedCoreFetch(env, `/api/public/meet-crm-tasks/${encodeURIComponent(taskId)}`, { method: 'GET' });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw coreFailure('task lookup', response);
  }
  const data = await readCoreJson(response, z.looseObject({ task: taskRow.nullish() }), 'GET /api/public/meet-crm-tasks/:id');
  return data.task?.id === taskId ? data.task : null;
}

/**
 * A dated task or milestone, for drawing beside events in the calendar.
 * `dueAt` is a timestamp for tasks and a plain date for milestones, which is
 * how the client decides between a timed row and an all-day one.
 */
export type { CrmWorkItem };

/**
 * Mark the caller's own work without hiding anyone else's.
 *
 * Filtering to "my tasks" server-side would answer half the question: you also
 * need to see what a colleague owes on Thursday to read your own week. So every
 * dated item comes back and each one says whether it is yours.
 */
export function markOwnWorkItems(items: CrmWorkItem[], ownerEmail: string | undefined): CrmWorkItem[] {
  const mine = ownerEmail?.trim().toLowerCase() ?? '';
  return items.map((item) => ({
    ...item,
    mine: mine.length > 0 && (item.assignee_email ?? '').trim().toLowerCase() === mine,
  }));
}

export async function fetchCrmWorkItems(
  env: Env,
  input: { start: string; end: string; includeDone?: boolean },
): Promise<CrmWorkItem[]> {
  if (!usesCoreFor(env, 'tasks')) return d1WorkItems(env, input);
  const response = await signedCoreFetch(env, '/api/public/meet-work-items', {
    method: 'GET',
    searchParams: {
      start: input.start,
      end: input.end,
      include_done: input.includeDone ? '1' : '0',
    },
  });
  if (!response.ok) {
    throw coreFailure('work items', response);
  }
  const data = await readCoreJson(response, z.looseObject({
    items: optionalList(crmWorkItemSchema.loose()),
  }), 'GET /api/public/meet-work-items');
  return data.items ?? [];
}

export async function createCrmTask(
  env: Env,
  input: {
    title: string;
    notes?: string | null;
    status?: string;
    responsible_party?: string;
    assigned_to?: string | null;
    due_date?: string | null;
    project_id?: string | null;
    lead_id?: string | null;
    event_id?: string | null;
    organization_id?: string | null;
    meeting_id?: string | null;
    signals_account_id?: string | null;
    goal_id?: string | null;
    /** Who is writing: Core records it as the row's `updated_by`. */
    actor_email?: string | null;
  },
): Promise<CrmTaskRow> {
  await assertGroupWritable(env, 'tasks');
  if (!usesCoreFor(env, 'tasks')) {
    // The board caches each subject's tasks for a minute on a D1 workspace too.
    const task = await d1CreateTask(env, input);
    await purgeCoreCache(taskCacheKeys(task));
    await recordWorkActivity(env, { actor: input.actor_email ?? null, table: 'tasks', id: task.id, action: 'insert', label: task.title, fields: fieldsOf(input) });
    return task;
  }
  const body = JSON.stringify(input);
  const response = await signedCoreFetch(env, '/api/public/meet-crm-tasks', {
    method: 'POST',
    body,
  });
  if (!response.ok) {
    throw coreFailure('task create', response);
  }
  const data = await readCoreJson(response, z.looseObject({ task: taskRow.nullish() }), 'POST /api/public/meet-crm-tasks');
  if (!data.task) throw new CrmSyncError('Core task create returned no task.', 502);
  await purgeCoreCache(taskCacheKeys(data.task));
  return data.task;
}

export async function updateCrmTask(
  env: Env,
  taskId: string,
  input: {
    title?: string;
    notes?: string | null;
    status?: string;
    responsible_party?: string;
    assigned_to?: string | null;
    due_date?: string | null;
    /** A move: one of the five with an id. */
    project_id?: string | null;
    lead_id?: string | null;
    event_id?: string | null;
    organization_id?: string | null;
    meeting_id?: string | null;
    goal_id?: string | null;
    /** Who is writing: Core records it as the row's `updated_by`. */
    actor_email?: string | null;
  },
): Promise<CrmTaskRow> {
  await assertGroupWritable(env, 'tasks');
  if (!usesCoreFor(env, 'tasks')) {
    const task = await d1UpdateTask(env, taskId, input);
    await purgeCoreCache(taskCacheKeys(task));
    await recordWorkActivity(env, { actor: input.actor_email ?? null, table: 'tasks', id: taskId, action: 'update', label: task.title, fields: fieldsOf(input) });
    return task;
  }
  const body = JSON.stringify(input);
  const response = await signedCoreFetch(env, `/api/public/meet-crm-tasks/${taskId}`, {
    method: 'PATCH',
    body,
  });
  if (!response.ok) {
    throw coreFailure('task update', response);
  }
  const data = await readCoreJson(response, z.looseObject({ task: taskRow.nullish() }), 'PATCH /api/public/meet-crm-tasks/:id');
  if (!data.task) throw new CrmSyncError('Core task update returned no task.', 502);
  await purgeCoreCache(taskCacheKeys(data.task));
  return data.task;
}

/**
 * Delete one task from the store that holds the `tasks` group.
 * Core's side is `DELETE /api/public/meet-crm-tasks/:id` (envisioning/core,
 * the same HMAC pair as the task writes).
 */
export async function deleteCrmTask(env: Env, taskId: string, actorEmail: string | null): Promise<{ id: string; deleted: true }> {
  await assertGroupWritable(env, 'tasks');
  if (!usesCoreFor(env, 'tasks')) {
    const task = await d1DeleteTask(env, taskId, actorEmail);
    await purgeCoreCache(taskCacheKeys(task));
    return { id: taskId, deleted: true };
  }
  const task = await fetchCrmTask(env, taskId);
  if (!task) throw new ControlError('Task not found.', 404, 'request_not_found');
  const response = await signedCoreFetch(env, `/api/public/meet-crm-tasks/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ actor_email: actorEmail }),
  });
  if (response.status === 404) throw new ControlError('Task not found.', 404, 'request_not_found');
  if (!response.ok) throw coreFailure('task delete', response);
  await purgeCoreCache(taskCacheKeys(task));
  return { id: taskId, deleted: true };
}

// ---------------------------------------------------------------------------
// Goals and decisions (#262): Core's `meet-crm-goals` and
// `meet-crm-decisions`, the same HMAC pair as tasks. Read live, no cache: a
// subject's list is short and read on open, not on every board draw.

export async function fetchCrmGoals(env: Env, projectId: string, includeClosed = false): Promise<CrmGoal[]> {
  if (!usesCoreFor(env, 'goals')) return d1Goals(env, projectId, includeClosed);
  const response = await signedCoreFetch(env, '/api/public/meet-crm-goals', {
    method: 'GET',
    searchParams: { project_id: projectId, include_closed: includeClosed ? '1' : '' },
  });
  if (!response.ok) {
    throw coreFailure('goal list', response);
  }
  const data = await readCoreJson(response, z.looseObject({ goals: optionalList(goalRow) }), 'GET /api/public/meet-crm-goals?project_id=');
  return data.goals ?? [];
}

/**
 * Every open goal on every project, newest change first, for search. One
 * read, cached a minute: search asks on every keystroke and the list is
 * short.
 */
export async function fetchAllCrmGoals(env: Env, limit = 200): Promise<CrmGoal[]> {
  // D1 is read live: the minute cache is for Core's round trip.
  if (!usesCoreFor(env, 'goals')) return d1AllGoals(env, limit);
  return cachedRead('goals/open', async () => {
    const response = await signedCoreFetch(env, '/api/public/meet-crm-goals', {
      method: 'GET',
      searchParams: { limit: String(limit) },
    });
    if (!response.ok) {
      throw coreFailure('goal list', response);
    }
    const data = await readCoreJson(response, z.looseObject({ goals: optionalList(goalRow) }), 'GET /api/public/meet-crm-goals');
    return data.goals ?? [];
  });
}

/** The latest decisions across every subject, for search. Same shape as the goals read. */
export async function fetchRecentCrmDecisions(env: Env, limit = 200): Promise<CrmDecision[]> {
  if (!usesCoreFor(env, 'goals')) return d1RecentDecisions(env, limit);
  return cachedRead('decisions/recent', async () => {
    const response = await signedCoreFetch(env, '/api/public/meet-crm-decisions', {
      method: 'GET',
      searchParams: { limit: String(limit) },
    });
    if (!response.ok) {
      throw coreFailure('decision list', response);
    }
    const data = await readCoreJson(response, z.looseObject({ decisions: optionalList(decisionRow) }), 'GET /api/public/meet-crm-decisions');
    return data.decisions ?? [];
  });
}

/** `actor_email` is the member acting; Core resolves it to its own user id, or null. */
export async function createCrmGoal(
  env: Env,
  input: CrmGoalCreateInput & { actor_email: string },
): Promise<CrmGoal> {
  await assertGroupWritable(env, 'goals');
  if (!usesCoreFor(env, 'goals')) {
    const goal = await d1CreateGoal(env, input);
    await recordWorkActivity(env, { actor: input.actor_email, table: 'goals', id: goal.id, action: 'insert', label: goal.title, fields: fieldsOf(input) });
    return goal;
  }
  const response = await signedCoreFetch(env, '/api/public/meet-crm-goals', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw coreFailure('goal create', response);
  }
  const data = await readCoreJson(response, z.looseObject({ goal: goalRow.nullish() }), 'POST /api/public/meet-crm-goals');
  if (!data.goal) throw new CrmSyncError('Core goal create returned no goal.', 502);
  await purgeCoreCache(['goals/open']);
  return data.goal;
}

export async function updateCrmGoal(
  env: Env,
  goalId: string,
  input: CrmGoalUpdateInput & { actor_email: string },
): Promise<CrmGoal> {
  await assertGroupWritable(env, 'goals');
  if (!usesCoreFor(env, 'goals')) {
    const goal = await d1UpdateGoal(env, goalId, input);
    await recordWorkActivity(env, { actor: input.actor_email, table: 'goals', id: goalId, action: 'update', label: goal.title, fields: fieldsOf(input) });
    return goal;
  }
  const response = await signedCoreFetch(env, `/api/public/meet-crm-goals/${goalId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw coreFailure('goal update', response);
  }
  const data = await readCoreJson(response, z.looseObject({ goal: goalRow.nullish() }), 'PATCH /api/public/meet-crm-goals/:id');
  if (!data.goal) throw new CrmSyncError('Core goal update returned no goal.', 502);
  await purgeCoreCache(['goals/open']);
  return data.goal;
}

export async function fetchCrmDecisions(env: Env, subject: { kind: CrmSubjectKind; id: string }, limit = 50): Promise<CrmDecision[]> {
  if (!usesCoreFor(env, 'goals')) return d1Decisions(env, subject, limit);
  const response = await signedCoreFetch(env, '/api/public/meet-crm-decisions', {
    method: 'GET',
    searchParams: { subject_kind: subject.kind, subject_id: subject.id, limit: String(limit) },
  });
  if (!response.ok) {
    throw coreFailure('decision list', response);
  }
  const data = await readCoreJson(response, z.looseObject({ decisions: optionalList(decisionRow) }), 'GET /api/public/meet-crm-decisions?subject_id=');
  return data.decisions ?? [];
}

export async function createCrmDecision(
  env: Env,
  input: CrmDecisionCreateInput & { actor_email: string },
): Promise<CrmDecision> {
  await assertGroupWritable(env, 'goals');
  if (!usesCoreFor(env, 'goals')) {
    const decision = await d1CreateDecision(env, input);
    await recordWorkActivity(env, { actor: input.actor_email, table: 'decisions', id: decision.id, action: 'insert', label: decision.body, fields: fieldsOf(input) });
    return decision;
  }
  const response = await signedCoreFetch(env, '/api/public/meet-crm-decisions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw coreFailure('decision create', response);
  }
  const data = await readCoreJson(response, z.looseObject({ decision: decisionRow.nullish() }), 'POST /api/public/meet-crm-decisions');
  if (!data.decision) throw new CrmSyncError('Core decision create returned no decision.', 502);
  await purgeCoreCache(['decisions/recent']);
  return data.decision;
}

/** The board's cached tasks page for whichever subject this task sits on. */
export function taskCacheKeys(task: Partial<Pick<CrmTaskRow, 'project_id' | 'lead_id' | 'event_id' | 'organization_id' | 'meeting_id' | 'signals_account_id'>>): CoreCacheKey[] {
  const keys: CoreCacheKey[] = [];
  if (task.project_id) keys.push(`tasks/project/${task.project_id}`);
  if (task.lead_id) keys.push(`tasks/lead/${task.lead_id}`);
  if (task.event_id) keys.push(`tasks/event/${task.event_id}`);
  // Only a partner's own task: Core echoes the organization on tasks that
  // hang off something else too, and those are cached under their subject.
  if (task.organization_id && !task.project_id && !task.lead_id && !task.event_id && !task.meeting_id && !task.signals_account_id) {
    keys.push(`tasks/organization/${task.organization_id}`, 'tasks/partner/all');
  }
  if (task.meeting_id) keys.push(`tasks/meeting/${task.meeting_id}`);
  if (task.signals_account_id) keys.push(`tasks/signals_account/${task.signals_account_id}`);
  return keys;
}

/**
 * Broker a Core personal access token for a signed-in owner.
 *
 * Core's `meet-owner-exchange` is the Meet-side sibling of its iOS exchange: it
 * trusts this Worker's HMAC signature as proof that the owner has already
 * passed Google sign-in on an identity domain, and mints the same
 * sales-assistant PAT it would mint for the Core iOS app — 90 days, one per
 * device name. The token passes straight through to the caller; nothing about
 * it is kept or logged here.
 *
 * Core answers 404 when the address has no Core account (it never creates
 * one), which surfaces as `core_account_missing` so the client can say "sign
 * in to Core on the web once". Any other refusal is Core's problem to explain,
 * so it comes back as a 502 with Core's status in the prose.
 */
export type CorePatPreset = 'sales-assistant' | 'cms-editor';

export async function exchangeCoreToken(
  env: Env,
  ownerEmail: string,
  deviceName: string | undefined,
  preset: CorePatPreset = 'sales-assistant',
): Promise<CoreTokenResponse> {
  const secret = env.INTERNAL_REQUEST_SECRET?.trim();
  if (!secret) throw new CrmSyncError('INTERNAL_REQUEST_SECRET is not configured.', 503, 'not_configured');
  const body = JSON.stringify({
    email: ownerEmail.trim().toLowerCase(),
    ...(deviceName?.trim() ? { device_name: deviceName.trim() } : {}),
    ...(preset !== 'sales-assistant' ? { preset } : {}),
  });
  const timestamp = String(Date.now());
  const signature = await hmacSHA256Hex(secret, `${timestamp}.${body}`);
  const response = await fetch(`${coreOrigin(env)}${OWNER_EXCHANGE_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-internal-timestamp': timestamp,
      'x-internal-signature': signature,
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // Core's own 404 carries `no_core_account` in a JSON body. A bare 404 is
  // Core without this route at all — an undeployed backend — and that is not
  // the owner's fault, so it must not read as "sign in to Core".
  const answer: unknown = await response.json().catch(() => null);
  if (response.status === 404 && readRefusal(answer).error === 'no_core_account') {
    throw new CrmSyncError('This address has no Core account yet. Sign in to Core on the web once, then try again.', 404, 'core_account_missing');
  }
  if (!response.ok || answer === null) {
    throw new CrmSyncError(`Core declined to issue a token (${response.status}).`, 502);
  }
  const data = parseCoreBody(z.looseObject({
    ok: z.literal(true),
    token: z.string().min(1),
    expires_at: z.string(),
    // A scope that is not a string is dropped, as before, rather than refused.
    scopes: z.array(z.unknown()).nullish(),
    email: z.string().nullish(),
  }), answer, 'POST ' + OWNER_EXCHANGE_PATH);
  return {
    token: data.token,
    scopes: (data.scopes ?? []).filter((scope): scope is string => typeof scope === 'string'),
    expires_at: data.expires_at,
    email: data.email ? data.email : ownerEmail.trim().toLowerCase(),
  };
}

/**
 * The device name the Worker mints its own broker token under, for the one
 * Core call that runs server-side rather than on the owner's device. Kept far
 * from any real device name (`Meet — <device_name>` from a Mac or iPhone) so
 * this route's per-request mint/revoke cycle never collides with, or shortens
 * the life of, a token an owner's own client is holding for `core-kit`.
 */
const SALES_INBOX_PAT_DEVICE_NAME = 'Sales inbox (Worker)';
/** Separate mint identity ensures the Worker receives the new favorites scopes. */
const FAVORITES_PAT_DEVICE_NAME = 'Favorites (Worker)';

/**
 * The Worker's second broker identity: a `cms-editor` token (cms:read +
 * cms:write, nothing else) for `/api/agent/cms/*`. Kept apart from the sales
 * inbox token on purpose — CMS writes are their own accident surface in Core
 * (CMS_AGENT_ACCESS_MODEL §2.3), so no device token and no sales token ever
 * carries `cms:write`.
 */
const CMS_PAT_DEVICE_NAME = 'CMS (Worker)';

const PRESET_BY_DEVICE_NAME: Record<string, CorePatPreset> = {
  [SALES_INBOX_PAT_DEVICE_NAME]: 'sales-assistant',
  [FAVORITES_PAT_DEVICE_NAME]: 'sales-assistant',
  [CMS_PAT_DEVICE_NAME]: 'cms-editor',
};

/**
 * `GET /api/agent/untriaged-touches` and its dismiss pair are scoped
 * `untriaged:read` / session, not the HMAC `INTERNAL_REQUEST_SECRET` pair
 * every other function in this file signs with (docs/CORE_REGISTRY.md,
 * decision 2: the `/api/agent/*` surface is PAT-authed, per-user). There is
 * no session cookie to carry server-side, so the Worker brokers a PAT for
 * itself the same way `/api/core/token` brokers one for a device.
 *
 * Minting on every call used to be worse than wasteful: Core's exchange
 * revokes the prior token of the same device name on every mint
 * (docs/CORE_REGISTRY.md, "The exchange"), so two overlapping calls for the
 * same actor were never independent — the second mint could revoke the first
 * token out from under an in-flight request, turning a read into a spurious
 * 401. `corePatCache`/`corePatMints` below cache the minted token per
 * (device name, actor) until just before it actually expires, and dedupe
 * concurrent mints for the same key onto one in-flight request, the same
 * shape as `tokenPool` in `calendar.ts`. That fixes every race within one
 * isolate. It is still isolate-local — a different isolate (or a cold start)
 * has its own empty cache and can mint independently — so `corePatFetch`
 * below also retries once on an actual 401 rather than assuming the cache is
 * the only source of truth.
 *
 * Confirmed in Core (`meet-owner-exchange`): the exchange revokes
 * every live token this user holds under the device name before it issues the
 * new one, so two isolates minting for the same actor and name do kill each
 * other's token. The token therefore also lives in `CORE_CACHE`, sealed with
 * the Google token key (`pat/<hash of device::actor>`, expiring with the
 * token), and every isolate reads it before it mints. A mint that two isolates
 * start in the same instant can still cross; the loser's 401 reads the key
 * again, and removes it only if it still holds the token that just died.
 */
const CORE_PAT_EXPIRY_SAFETY_MARGIN_MS = 10_000;

interface CachedCorePat {
  token: string;
  expiresAt: number;
}

/** Isolate-local, like `peers.ts`'s roster cache. Resolved tokens, keyed by `${deviceName}::${actor}`. */
let corePatCache = new Map<string, CachedCorePat>();
/** In-flight mints for the same key, so concurrent callers share one Core round trip instead of each minting their own. */
let corePatMints = new Map<string, Promise<CachedCorePat>>();

/** Tests only: forget every token here and in the shared store; `isolateOnly` plays a fresh isolate that finds the store as it was. */
export async function resetCorePatCache(options: { isolateOnly?: boolean } = {}): Promise<void> {
  corePatCache = new Map();
  corePatMints = new Map();
  if (options.isolateOnly) return;
  const kv = (workerEnv as unknown as Partial<Env>).CORE_CACHE;
  if (!kv) return;
  const { keys } = await kv.list({ prefix: CORE_PAT_KV_PREFIX });
  await Promise.all(keys.map((entry) => kv.delete(entry.name)));
}

function corePatCacheKey(actorEmail: string, deviceName: string): string {
  return `${deviceName}::${actorEmail.trim().toLowerCase()}`;
}

const CORE_PAT_KV_PREFIX = 'pat/';
/** A sealed token rests in the store a day at most, however long Core says it lives. */
const CORE_PAT_SHARED_TTL_SECONDS = 24 * 60 * 60;

/** The shared store's name for a token: a hash, so no address sits in a key. */
async function corePatKvName(key: string): Promise<string> {
  return CORE_PAT_KV_PREFIX + await sha256(key);
}

/** Domain-separated from the Google refresh tokens that share the key material. */
function corePatSealingKey(env: Env): string | null {
  return env.GOOGLE_TOKEN_ENCRYPTION_KEY ? `core-pat\n${env.GOOGLE_TOKEN_ENCRYPTION_KEY}` : null;
}

interface StoredCorePat extends SealedSecret {
  expiresAt: number;
}

/** The token another isolate minted, if the shared store has one that is still good. Any failure is a miss. */
async function readSharedCorePat(env: Env, key: string): Promise<CachedCorePat | null> {
  const sealingKey = corePatSealingKey(env);
  if (!env.CORE_CACHE || !sealingKey) return null;
  try {
    const record = await env.CORE_CACHE.get<StoredCorePat>(await corePatKvName(key), { type: 'json', cacheTtl: 30 });
    if (!record || typeof record.expiresAt !== 'number' || record.expiresAt - CORE_PAT_EXPIRY_SAFETY_MARGIN_MS <= Date.now()) return null;
    return { token: await openSecret(sealingKey, record), expiresAt: record.expiresAt };
  } catch {
    return null;
  }
}

async function writeSharedCorePat(env: Env, key: string, entry: CachedCorePat): Promise<void> {
  const sealingKey = corePatSealingKey(env);
  if (!env.CORE_CACHE || !sealingKey) return;
  try {
    const sealed = await sealSecret(sealingKey, entry.token);
    const record: StoredCorePat = { ...sealed, expiresAt: entry.expiresAt };
    const remainingSeconds = Math.floor((entry.expiresAt - CORE_PAT_EXPIRY_SAFETY_MARGIN_MS - Date.now()) / 1000);
    await env.CORE_CACHE.put(await corePatKvName(key), JSON.stringify(record), {
      expirationTtl: Math.min(remainingSeconds, CORE_PAT_SHARED_TTL_SECONDS),
    });
  } catch {
    // The token still works in this isolate; the next one will mint its own.
  }
}

/** The cached (or freshly minted, deduped) broker PAT for one actor/device. */
async function corePat(env: Env, actorEmail: string, deviceName: string): Promise<string> {
  // Before either cache: a sealed token from a shared store must not be usable
  // on a workspace that does not use Core ( audit).
  assertUsesCore(env);
  const key = corePatCacheKey(actorEmail, deviceName);
  const cached = corePatCache.get(key);
  if (cached && cached.expiresAt - CORE_PAT_EXPIRY_SAFETY_MARGIN_MS > Date.now()) {
    return cached.token;
  }
  const inFlight = corePatMints.get(key);
  if (inFlight) {
    // Another request's mint. That request can be cancelled and then this
    // promise never settles, so wait a bounded time, then mint here.
    const shared = await awaitBounded(inFlight);
    if (shared) return shared.value.token;
  }

  // Set into `corePatMints` before the first await below: with no mint in
  // flight, nothing yields the isolate between `.get` above and `.set` here, so
  // a concurrent call for the same key sees this promise and does not start a
  // mint of its own. Only a mint that outlived the bounded wait gets a second.
  const resolved = (async (): Promise<CachedCorePat> => {
    const shared = await readSharedCorePat(env, key);
    if (shared) return shared;
    const result = await exchangeCoreToken(env, actorEmail, deviceName, PRESET_BY_DEVICE_NAME[deviceName] ?? 'sales-assistant');
    const entry: CachedCorePat = { token: result.token, expiresAt: Date.parse(result.expires_at) };
    await writeSharedCorePat(env, key, entry);
    return entry;
  })()
    .then((entry) => {
      corePatCache.set(key, entry);
      return entry;
    })
    .finally(() => {
      if (corePatMints.get(key) === resolved) corePatMints.delete(key);
    });
  corePatMints.set(key, resolved);
  return (await resolved).token;
}

/**
 * Forget a token that turned out to be dead, so the next call mints a fresh
 * one — here, and in the shared store only if that still holds the token that
 * died: another isolate may already have replaced it with a live one.
 */
async function invalidateCorePat(env: Env, actorEmail: string, deviceName: string, deadToken: string): Promise<void> {
  const key = corePatCacheKey(actorEmail, deviceName);
  corePatCache.delete(key);
  const shared = await readSharedCorePat(env, key);
  if (shared?.token === deadToken && env.CORE_CACHE) {
    await env.CORE_CACHE.delete(await corePatKvName(key)).catch(() => undefined);
  }
}

/**
 * One authenticated call to a Core `/api/agent/*` route as the owner. The
 * PAT is minted once per owner and cached; a 401 mints fresh and retries
 * exactly once.
 */
export async function corePatFetch(
  env: Env,
  actorEmail: string,
  path: string,
  init: { method: string; searchParams?: Record<string, string>; body?: unknown; timeoutMs?: number },
  identity: 'sales' | 'cms' | 'favorites' = 'sales',
): Promise<Response> {
  const deviceName = identity === 'cms'
    ? CMS_PAT_DEVICE_NAME
    : identity === 'favorites' ? FAVORITES_PAT_DEVICE_NAME : SALES_INBOX_PAT_DEVICE_NAME;
  const url = new URL(`${coreOrigin(env)}${path}`);
  for (const [key, value] of Object.entries(toCoreKinds(init.searchParams) ?? {})) {
    if (value) url.searchParams.set(key, value);
  }
  const coreBody = toCoreKinds(init.body);
  const request = (token: string) => fetch(url, {
    method: init.method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(coreBody !== undefined ? { body: JSON.stringify(coreBody) } : {}),
    signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });

  const token = await corePat(env, actorEmail, deviceName);
  const response = await withCoreRetry(() => request(token));
  if (response.status !== 401) return response;

  // The cached token is dead — revoked from outside this cache's control (a
  // different isolate, a cold start), not something a second try can avoid by
  // waiting. Mint fresh and try exactly once more; a second 401 after that is
  // Core's to explain, not this cache's to keep retrying.
  await invalidateCorePat(env, actorEmail, deviceName, token);
  const freshToken = await corePat(env, actorEmail, deviceName);
  return withCoreRetry(() => request(freshToken));
}

/** Core's ranked organization directory, narrowed to the one relation Work needs. */
export function searchCrmOrganizations(
  env: Env,
  actorEmail: string,
  query: string,
): Promise<CrmOrganizationOption[]> {
  if (!usesCoreFor(env, 'subjects')) return d1SearchOrganizations(env, query);
  // Typeahead asks once per keystroke; a repeat inside ten seconds is free.
  return memoCore(`orgs:${coreOrigin(env)}:${actorEmail}:${query.trim().toLowerCase()}`, () => readCrmOrganizations(env, actorEmail, query));
}

async function readCrmOrganizations(
  env: Env,
  actorEmail: string,
  query: string,
): Promise<CrmOrganizationOption[]> {
  const response = await corePatFetch(env, actorEmail, '/api/agent/search', {
    method: 'GET',
    searchParams: { q: query.trim(), entity: 'organizations', limit: '20' },
  });
  if (!response.ok) {
    throw coreFailure('organization search', response);
  }
  const hit = crmOrganizationOptionSchema.extend({ entity: z.literal('organizations') }).loose();
  const data = await readCoreJson(response, z.looseObject({ data: optionalList(hit) }), 'GET /api/agent/search?entity=organizations');
  return data.data ?? [];
}

/** Create one minimally named organization in Core as the signed-in owner. */
export async function createCrmOrganization(
  env: Env,
  actorEmail: string,
  name: string,
): Promise<CrmOrganizationOption> {
  await assertGroupWritable(env, 'subjects');
  if (!usesCoreFor(env, 'subjects')) return d1CreateOrganization(env, actorEmail, name);
  const response = await corePatFetch(env, actorEmail, '/api/agent/organizations', {
    method: 'POST',
    body: { name: name.trim() },
  });
  if (!response.ok) {
    throw coreFailure('organization create', response);
  }
  const data = await readCoreJson(response, z.looseObject({ data: crmOrganizationOptionSchema }), 'POST /api/agent/organizations');
  forgetCoreMemo();
  return data.data;
}

/** The table group a Core record belongs to (`WORK_GROUP_TABLES`): an interaction is `interactions`, the rest `subjects`. */
export function coreRecordGroup(entity: CoreRecordEntity): WorkGroup {
  return entity === 'interactions' ? 'interactions' : 'subjects';
}

/**
 * An organization's fields, as the member: only what the input
 * names changes. On D1 through `d1UpdateOrganization`; on Core through
 * `PATCH /api/agent/organizations/:id`, where Core calls `url` `website`.
 * Core's `meet-crm-subjects` door reads partners only. Answers the detail.
 */
export async function updateCrmOrganization(
  env: Env,
  actorEmail: string,
  id: string,
  input: CrmOrganizationUpdate,
): Promise<CrmSubjectDetail> {
  await assertGroupWritable(env, 'subjects');
  if (!usesCoreFor(env, 'subjects')) {
    const subject = await d1UpdateOrganization(env, id, input);
    await purgeRecordCaches('organizations', null);
    await recordWorkActivity(env, { actor: actorEmail, table: 'organizations', id, action: 'update', label: subject.title, fields: fieldsOf(input) });
    return subject;
  }
  const { url, ...rest } = input;
  const body = Object.fromEntries(Object.entries({ ...rest, ...(url !== undefined ? { website: url } : {}) })
    .filter(([, value]) => value !== undefined));
  if (Object.keys(body).length > 0) {
    await coreRegistryFetch(env, actorEmail, `/api/agent/organizations/${encodeURIComponent(id)}`, { method: 'PATCH', body }, 'organization update');
    await purgeRecordCaches('organizations', null);
  }
  return fetchCrmSubjectDetail(env, 'organization', id);
}

/**
 * Delete an organization as the member, refused while any row points at it
 *. Core's guard on Core (`deleteCoreOrganization`); the same
 * guard over D1 once the `subjects` group answers from D1.
 */
export async function deleteCrmOrganization(env: Env, actorEmail: string, id: string): Promise<{ id: string; deleted: true }> {
  await assertGroupWritable(env, 'subjects');
  if (usesCoreFor(env, 'subjects')) {
    await deleteCoreOrganization(env, actorEmail, id);
    return { id, deleted: true };
  }
  const deleted = await d1DeleteOrganization(env, id);
  await purgeRecordCaches('organizations', null);
  await recordWorkActivity(env, { actor: actorEmail, table: 'organizations', id, action: 'delete' });
  return deleted;
}

// ── Contacts (docs/RELATIONSHIPS.md slice 2) ─────────────────────// ── Contacts (docs/RELATIONSHIPS.md slice 2) ─────────────────────
//
// On a `core` workspace a contact is Core's row, read and written as the
// member through `/api/agent/contacts` (the broker PAT, as organizations).
// Core calls the title `company_role`; the wire calls it `title`. Core keeps
// one address it writes (`email`) and shows more it was given elsewhere
// (`corporate_email`, aliases); the Worker writes the primary only, and
// refuses a new second address rather than drop it.

const coreText = z.string().nullish();
const coreContactRow = z.looseObject({
  id: z.string(),
  name: coreText,
  email: coreText,
  corporate_email: coreText,
  company_role: coreText,
  organization_id: coreText,
  organization: z.looseObject({ id: z.string(), name: coreText }).nullish(),
  email_aliases: z.array(z.string()).nullish(),
});
type CoreContactRow = z.infer<typeof coreContactRow>;

function contactFromCore(row: CoreContactRow): CrmContact {
  const emails = [...new Set([row.email, row.corporate_email, ...(row.email_aliases ?? [])]
    .map((email) => email?.trim().toLowerCase() ?? '')
    .filter(Boolean))];
  return {
    id: row.id,
    name: row.name?.trim() || null,
    title: row.company_role?.trim() || null,
    organization_id: row.organization_id ?? row.organization?.id ?? null,
    organization_name: row.organization?.name ?? null,
    email: emails[0] ?? null,
    emails,
  };
}

const CRM_INTERACTION_TYPES = new Set<string>(['note', 'email', 'call', 'meeting', 'web']);

/** A row of Core's agent interaction list, as the History pane's row. */
const coreAgentInteraction = z.looseObject({
  id: z.string(),
  title: coreText,
  type: coreText,
  description: coreText,
  occurred_at: coreText,
  created_at: coreText,
  organization_id: coreText,
  lead_id: coreText,
  project_id: coreText,
  url: coreText,
  contacts: z.array(crmInteractionContactSchema.loose()).nullish(),
});

function interactionFromCore(row: z.infer<typeof coreAgentInteraction>): CrmInteraction {
  const summary = row.description ?? null;
  return {
    id: row.id,
    title: row.title?.trim() || 'Untitled',
    type: CRM_INTERACTION_TYPES.has(row.type ?? '') ? row.type as CrmInteraction['type'] : 'note',
    occurred_at: row.occurred_at ?? row.created_at ?? null,
    created_at: row.created_at ?? null,
    summary_preview: summaryPreview(summary),
    summary_markdown: summary,
    transcript_preview: null,
    duration_minutes: null,
    project_id: row.project_id ?? null,
    lead_id: row.lead_id ?? null,
    organization_id: row.organization_id ?? null,
    source: null,
    channel: null,
    status: null,
    url: row.url ?? null,
    contacts: (row.contacts ?? []).map((contact) => ({ id: contact.id, name: contact.name, email: contact.email })),
  };
}

async function readCoreContactRow(env: Env, actorEmail: string, id: string): Promise<CoreContactRow> {
  const response = await corePatFetch(env, actorEmail, `/api/agent/contacts/${encodeURIComponent(id)}`, { method: 'GET' });
  if (response.status === 404) throw new ControlError('No contact with that id.', 404);
  if (!response.ok) throw coreFailure('contact read', response);
  return (await readCoreJson(response, z.looseObject({ data: coreContactRow }), 'GET /api/agent/contacts/:id')).data;
}

async function readCoreContact(env: Env, actorEmail: string, id: string): Promise<CrmContact> {
  return contactFromCore(await readCoreContactRow(env, actorEmail, id));
}

/**
 * The fields of `shape` that a Core row carries and that parse.
 * Core names these columns as the wire does. A field that is absent or does
 * not parse is left out, so one odd value does not refuse the whole read.
 */
export function profileFromCore(shape: z.ZodRawShape, row: Record<string, unknown>): Record<string, unknown> {
  const profile: Record<string, unknown> = {};
  for (const [field, schema] of Object.entries(shape)) {
    if (!(field in row)) continue;
    const parsed = (schema as z.ZodType).safeParse(row[field]);
    if (parsed.success && parsed.data !== undefined) profile[field] = parsed.data;
  }
  return profile;
}

/** The contact fields a write may set beyond name, title, organization and addresses, as Core's body names them. */
function coreContactProfileBody(input: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of Object.keys(crmContactProfileShape)) {
    if (field in input && input[field] !== undefined) body[field] = input[field];
  }
  return body;
}

/**
 * `GET /api/crm/contacts`: by name, address, title or organization name, on
 * one organization, or by id (a picker naming what a subject carries). The
 * Contacts group adds its filters and asks for the facets. In
 * name order.
 */
export async function fetchCrmContacts(
  env: Env,
  actorEmail: string,
  input: { q?: string; organizationId?: string | null; ids?: readonly string[]; emails?: readonly string[]; limit?: number; filter?: CrmContactFilter; facets?: boolean },
): Promise<{ contacts: CrmContact[]; hasMore: boolean; facets?: CrmContactFacets }> {
  if (!usesCoreFor(env, 'subjects')) return d1Contacts(env, input);
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
  if (input.emails) {
    // Core has no list by address: one search each, kept only where the
    // contact holds that exact address.
    const emails = input.emails.slice(0, 25);
    const found = await Promise.all(emails.map(async (email) => {
      const { contacts } = await fetchCrmContacts(env, actorEmail, { q: email, limit: 5 });
      return contacts.filter((contact) => contact.emails.includes(email));
    }));
    const seen = new Set<string>();
    const contacts = found.flat().filter((contact) => !seen.has(contact.id) && seen.add(contact.id));
    return { contacts, hasMore: false };
  }
  if (input.ids) {
    // Core has no list by id: one read each, the few a subject carries.
    const ids = input.ids.slice(0, 50);
    const found = await Promise.all(ids.map((id) => readCoreContact(env, actorEmail, id).catch((error: unknown) => {
      if (error instanceof ControlError && error.status === 404) return null;
      throw error;
    })));
    return { contacts: found.filter((contact): contact is CrmContact => contact !== null), hasMore: false };
  }
  const q = input.q?.trim() ?? '';
  const searchParams: Record<string, string> = {
    q,
    organization_id: input.organizationId ?? '',
    limit: String(limit + 1),
    ...coreContactFilter(input.filter ?? {}),
    ...(input.facets ? { facets: 'true' } : {}),
  };
  return memoCore(`contacts:${coreOrigin(env)}:${actorEmail}:${JSON.stringify(searchParams)}`, async () => {
    const response = await corePatFetch(env, actorEmail, '/api/agent/contacts', { method: 'GET', searchParams });
    if (!response.ok) throw coreFailure('contact list', response);
    const data = await readCoreJson(response, z.looseObject({
      data: optionalList(coreContactRow),
      // A Core without the filters sends none; the list still reads.
      facets: crmContactFacetsSchema.nullish().catch(undefined),
    }), 'GET /api/agent/contacts');
    const rows = data.data ?? [];
    return {
      contacts: rows.slice(0, limit).map(contactFromCore),
      hasMore: rows.length > limit,
      ...(input.facets && data.facets ? { facets: data.facets } : {}),
    };
  });
}

/** Core's offer row (`/api/agent/offers`); Core sends numerics as numbers or strings. */
const coreAmount = z.union([z.number(), z.string()]).nullish().transform((value) => {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
});
const coreOfferRow = z.looseObject({
  id: z.string(),
  title: coreText,
  status: coreText,
  total_amount: coreAmount,
  currency: coreText,
  valid_until: coreText,
  is_accepted: z.boolean().nullish(),
  created_at: coreText,
  lead_id: coreText,
  organization_id: coreText,
  has_unsent_changes: z.boolean().nullish(),
});
const coreLicenseRow = z.looseObject({
  id: z.string(),
  product: coreText,
  plan_type: coreText,
  seats: coreAmount,
  amount_eur: coreAmount,
  start_date: coreText,
  renewal_date: coreText,
  is_active: z.boolean().nullish(),
  offer_id: coreText,
  lead_id: coreText,
  organization_id: coreText,
  payment_type: coreText,
  billing_interval: coreText,
  notes: coreText,
});

function offerFromCore(row: z.output<typeof coreOfferRow>): CrmOffer {
  return {
    id: row.id,
    title: row.title ?? null,
    status: row.status ?? null,
    total_amount: row.total_amount,
    currency: row.currency ?? null,
    valid_until: row.valid_until ?? null,
    is_accepted: row.is_accepted ?? null,
    created_at: row.created_at ?? null,
    lead_id: row.lead_id ?? null,
    organization_id: row.organization_id ?? null,
    ...(typeof row.has_unsent_changes === 'boolean' ? { has_unsent_changes: row.has_unsent_changes } : {}),
  };
}

function licenseFromCore(row: z.output<typeof coreLicenseRow>): CrmLicense {
  return {
    id: row.id,
    product: row.product ?? null,
    plan_type: row.plan_type ?? null,
    seats: row.seats === null ? null : Math.round(row.seats),
    amount_eur: row.amount_eur,
    start_date: row.start_date ?? null,
    renewal_date: row.renewal_date ?? null,
    is_active: row.is_active ?? false,
    offer_id: row.offer_id ?? null,
    lead_id: row.lead_id ?? null,
    organization_id: row.organization_id ?? null,
    payment_type: row.payment_type ?? null,
    billing_interval: row.billing_interval ?? null,
    notes: row.notes ?? null,
  };
}

/**
 * `GET /api/crm/subjects/:kind/:id/commercial`: the offers and
 * licences on a lead or an organization, newest first, from Core's agent
 * lists by `lead_id` or `organization_id`. A list
 * whose work module is off is null and is not read. Only Core holds these
 * (WORK_MODEL.md §Commercial work modules), so the modules are never on
 * a D1 workspace. Once the `commercial` group moved, the lists read D1.
 */
export function fetchCrmSubjectCommercial(
  env: Env,
  actorEmail: string,
  kind: 'lead' | 'organization',
  id: string,
  on: { offers: boolean; licenses: boolean },
): Promise<CrmSubjectCommercialResponse> {
  return listCrmCommercial(env, actorEmail, { [kind === 'lead' ? 'lead_id' : 'organization_id']: id, limit: '100' }, on);
}

/**
 * Core's offers and licences, newest first, narrowed by `searchParams`
 * (`lead_id`, `organization_id`, `limit`): one subject's for the Overview,
 * or the workspace's latest for INBOX. A list not asked for is null.
 */
export async function listCrmCommercial(
  env: Env,
  actorEmail: string,
  searchParams: Record<string, string>,
  on: { offers: boolean; licenses: boolean },
): Promise<CrmSubjectCommercialResponse> {
  if (!usesCoreFor(env, 'commercial')) {
    const [offers, licenses] = await Promise.all([
      on.offers ? d1CommercialList(env, 'offers', searchParams) : null,
      on.licenses ? d1CommercialList(env, 'licenses', searchParams) : null,
    ]);
    return {
      offers: offers?.map((row) => offerFromCore(coreOfferRow.parse(row))) ?? null,
      licenses: licenses?.map((row) => licenseFromCore(coreLicenseRow.parse(row))) ?? null,
    };
  }
  const read = async <Row extends z.ZodType, Out>(path: string, row: Row, map: (row: z.output<Row>) => Out): Promise<Out[]> =>
    memoCore(`commercial:${coreOrigin(env)}:${actorEmail}:${path}:${JSON.stringify(searchParams)}`, async () => {
      const response = await corePatFetch(env, actorEmail, path, { method: 'GET', searchParams });
      if (!response.ok) throw coreFailure(path === '/api/agent/offers' ? 'offer list' : 'licence list', response);
      const data = await readCoreJson(response, z.looseObject({ data: optionalList(row) }), `GET ${path}`);
      return (data.data ?? []).map(map);
    });
  const newest = <T extends { created_at?: string | null; start_date?: string | null }>(rows: T[]): T[] =>
    rows.sort((a, b) => (b.created_at ?? b.start_date ?? '').localeCompare(a.created_at ?? a.start_date ?? ''));
  const [offers, licenses] = await Promise.all([
    on.offers ? read('/api/agent/offers', coreOfferRow, offerFromCore).then(newest) : Promise.resolve(null),
    on.licenses ? read('/api/agent/licenses', coreLicenseRow, licenseFromCore).then(newest) : Promise.resolve(null),
  ]);
  return { offers, licenses };
}

/**
 * The contact filters as Core's `/api/agent/contacts` reads them
 * (envisioning/core). Only a filter that is set goes, so a
 * picker asks exactly what it asked before the filters existed.
 */
function coreContactFilter(filter: CrmContactFilter): Record<string, string> {
  const params: Record<string, string> = {};
  if (filter.country?.trim()) params.country = filter.country.trim().toUpperCase();
  if (filter.partner) params.partner = 'true';
  if (filter.existing_client) params.existing_client = 'true';
  if (filter.signals_outreach_status) params.signals_outreach_status = filter.signals_outreach_status;
  if (filter.preferred_language?.trim()) params.preferred_language = filter.preferred_language.trim();
  return params;
}

/** The organization a contact is on, for the route's access check; 404 when there is no such contact. */
export async function crmContactOrganization(env: Env, actorEmail: string, id: string): Promise<string | null> {
  if (!usesCoreFor(env, 'subjects')) return d1ContactOrganization(env, id);
  return (await readCoreContact(env, actorEmail, id)).organization_id;
}

/**
 * `GET /api/crm/contacts/:id`: the contact page. On Core the calls come from
 * Core's `interaction_contacts` and the leads from `leads.contact_id`. Core's
 * agent API has no read of a contact's projects or of who hosted a call, so
 * those two lists are empty on a `core` workspace.
 */
export async function fetchCrmContactDetail(env: Env, actorEmail: string, id: string): Promise<CrmContactDetail> {
  if (!usesCoreFor(env, 'subjects')) return d1ContactDetail(env, id);
  const row = await readCoreContactRow(env, actorEmail, id);
  const contact = { ...contactFromCore(row), ...profileFromCore(crmContactProfileShape, row) };
  const [leads, interactions] = await Promise.all([
    (async (): Promise<CrmRelatedRow[]> => {
      const response = await corePatFetch(env, actorEmail, '/api/agent/leads', { method: 'GET', searchParams: { contact_id: id, limit: '50' } });
      if (!response.ok) throw coreFailure('contact leads', response);
      const data = await readCoreJson(response, z.looseObject({
        data: optionalList(z.looseObject({ id: z.string(), title: coreText, status: coreText })),
      }), 'GET /api/agent/leads?contact_id=');
      return (data.data ?? []).map((row) => ({ id: row.id, title: row.title ?? null, status: row.status ?? null }));
    })(),
    (async (): Promise<CrmInteraction[]> => {
      const response = await corePatFetch(env, actorEmail, '/api/agent/interactions', { method: 'GET', searchParams: { contact_id: id, limit: '20' } });
      if (!response.ok) throw coreFailure('contact calls', response);
      const data = await readCoreJson(response, z.looseObject({ data: optionalList(coreAgentInteraction) }), 'GET /api/agent/interactions?contact_id=');
      return (data.data ?? []).map(interactionFromCore);
    })(),
  ]);
  return { ...contact, projects: [], leads, interactions, met_by: [] };
}

/** `POST /api/crm/contacts`, as the member. */
export async function createCrmContact(
  env: Env,
  actorEmail: string,
  input: CrmContactCreate,
  options: { anySource?: boolean } = {},
): Promise<CrmContactDetail> {
  await assertGroupWritable(env, 'subjects');
  if (!usesCoreFor(env, 'subjects')) {
    const contact = await d1CreateContactRecord(env, input, options);
    await recordWorkActivity(env, { actor: actorEmail, table: 'contacts', id: contact.id, action: 'insert', label: contact.name, fields: fieldsOf(input) });
    return contact;
  }
  if (input.emails.length > 1) {
    throw new ControlError('Core keeps one address per contact. Add the others in Core.', 400, 'invalid_request');
  }
  const response = await corePatFetch(env, actorEmail, '/api/agent/contacts', {
    method: 'POST',
    body: {
      ...coreContactProfileBody(input),
      name: input.name.trim(),
      ...(input.emails[0] ? { email: input.emails[0] } : {}),
      ...(input.title?.trim() ? { company_role: input.title.trim() } : {}),
      ...(input.organization_id ? { organization_id: input.organization_id } : {}),
      ...(input.source_key ? { source_key: input.source_key } : {}),
    },
  });
  if (!response.ok) throw coreFailure('contact create', response);
  const created = await readCoreJson(response, z.looseObject({ data: z.looseObject({ id: z.string() }) }), 'POST /api/agent/contacts');
  forgetCoreMemo();
  return fetchCrmContactDetail(env, actorEmail, created.data.id);
}

/** `PATCH /api/crm/contacts/:id`, as the member: only what changes. */
export async function updateCrmContact(
  env: Env,
  actorEmail: string,
  id: string,
  input: CrmContactUpdate,
): Promise<CrmContactDetail> {
  await assertGroupWritable(env, 'subjects');
  if (!usesCoreFor(env, 'subjects')) {
    const contact = await d1UpdateContact(env, id, input);
    await recordWorkActivity(env, { actor: actorEmail, table: 'contacts', id, action: 'update', label: contact.name, fields: fieldsOf(input) });
    return contact;
  }
  const body: Record<string, unknown> = coreContactProfileBody(input);
  if (input.name?.trim()) body.name = input.name.trim();
  if ('title' in input) body.company_role = input.title?.trim() || null;
  if ('organization_id' in input) body.organization_id = input.organization_id ?? null;
  if (input.emails) {
    // Core writes `email`; the other addresses it shows were written in Core.
    const current = await readCoreContact(env, actorEmail, id);
    const added = input.emails.slice(1).filter((email) => !current.emails.includes(email.toLowerCase()));
    if (added.length > 0) {
      throw new ControlError('Core keeps one address per contact. Add the others in Core.', 400, 'invalid_request');
    }
    body.email = input.emails[0] ?? null;
  }
  if (Object.keys(body).length > 0) {
    const response = await corePatFetch(env, actorEmail, `/api/agent/contacts/${encodeURIComponent(id)}`, { method: 'PATCH', body });
    if (response.status === 404) throw new ControlError('No contact with that id.', 404);
    if (!response.ok) throw coreFailure('contact update', response);
    forgetCoreMemo();
  }
  return fetchCrmContactDetail(env, actorEmail, id);
}

/**
 * `GET /api/crm/contact-options`: the characteristic names and
 * languages the contact editor offers: `contact_characteristics_config` on
 * either store (on D1 since), and on D1 also the names contacts
 * carry. Core's languages come first on both.
 */
export async function fetchCrmContactOptions(env: Env, actorEmail: string): Promise<CrmContactOptionsResponse> {
  const languages = (stored: readonly string[]) => [...new Set([...CONTACT_LANGUAGES, ...stored])];
  if (!usesCoreFor(env, 'subjects')) {
    const found = await d1ContactOptions(env);
    return { characteristics: found.characteristics, languages: languages(found.languages) };
  }
  return memoCore(`contact-options:${coreOrigin(env)}`, async () => {
    const response = await corePatFetch(env, actorEmail, '/api/agent/meta/characteristics', { method: 'GET' });
    if (!response.ok) throw coreFailure('contact characteristics', response);
    const data = await readCoreJson(response, z.looseObject({
      data: z.looseObject({ contacts: optionalList(z.looseObject({ name: z.string() })) }).nullish(),
    }), 'GET /api/agent/meta/characteristics');
    const names = (data.data?.contacts ?? []).map((row) => row.name.trim()).filter(Boolean);
    return { characteristics: [...new Set(names)].sort(), languages: languages([]) };
  });
}

/**
 * `DELETE /api/crm/contacts/:id`, as the member: refused with 409
 * while a call or a task references the contact, on both stores. On Core,
 * `if_unreferenced=true` asks Core's guard; a Core
 * without it leaves the decision to its foreign keys.
 */
export async function deleteCrmContact(env: Env, actorEmail: string, id: string): Promise<{ id: string; deleted: true }> {
  await assertGroupWritable(env, 'subjects');
  if (!usesCoreFor(env, 'subjects')) {
    const deleted = await d1DeleteContact(env, id);
    await purgeRecordCaches('contacts', null);
    return deleted;
  }
  const response = await corePatFetch(env, actorEmail, `/api/agent/contacts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    searchParams: { if_unreferenced: 'true' },
  });
  if (response.status === 404) throw new ControlError('No contact with that id.', 404);
  if (response.status === 409) {
    const refused = await response.json<{ error?: unknown }>().catch(() => ({ error: undefined }));
    const message = typeof refused.error === 'string' && refused.error.trim() ? refused.error : 'Contact is in use. Move or merge those records first.';
    throw new ControlError(message, 409, 'invalid_request');
  }
  if (!response.ok) throw coreFailure('contact delete', response);
  forgetCoreMemo();
  await purgeRecordCaches('contacts', null);
  return { id, deleted: true };
}

/** The shared favorites rows Core stores for one owner. */
export async function listCoreFavorites(env: Env, actorEmail: string): Promise<FavoriteRow[]> {
  if (!usesCoreFor(env, 'goals')) return d1Favorites(env, actorEmail);
  const response = await corePatFetch(env, actorEmail, '/api/agent/favorites', { method: 'GET' }, 'favorites');
  if (!response.ok) throw coreFailure('favorites list', response);
  const data = await readCoreJson(response, z.object({ data: z.array(favoriteRowSchema) }).loose(), 'GET /api/agent/favorites');
  return data.data;
}

/** Idempotently add one member-owned favorite through Core's PAT API. */
export async function addCoreFavorite(
  env: Env,
  actorEmail: string,
  target: FavoriteTarget,
): Promise<FavoriteRow> {
  await assertGroupWritable(env, 'goals');
  if (!usesCoreFor(env, 'goals')) return d1AddFavorite(env, actorEmail, target);
  const response = await corePatFetch(env, actorEmail, '/api/agent/favorites', {
    method: 'POST',
    body: target,
  }, 'favorites');
  if (!response.ok) throw coreFailure('favorite write', response);
  const data = await readCoreJson(response, z.object({ data: favoriteRowSchema }).loose(), 'POST /api/agent/favorites');
  return data.data;
}

/** Idempotently remove one member-owned favorite through Core's PAT API. */
export async function removeCoreFavorite(
  env: Env,
  actorEmail: string,
  target: FavoriteTarget,
): Promise<void> {
  await assertGroupWritable(env, 'goals');
  if (!usesCoreFor(env, 'goals')) return d1RemoveFavorite(env, actorEmail, target);
  const response = await corePatFetch(env, actorEmail, '/api/agent/favorites', {
    method: 'DELETE',
    searchParams: { kind: target.kind, target_ref: target.target_ref },
  }, 'favorites');
  if (!response.ok) throw coreFailure('favorite removal', response);
  await readCoreJson(response, z.object({ data: z.object({ removed: z.literal(true) }) }).loose(), 'DELETE /api/agent/favorites');
}

// ── CMS: website content through Core's /api/agent/cms/*, as the member ─────

/** A CMS entity id as Core's registry spells it: a snake_case slug. */
const CMS_ENTITY = /^[a-z][a-z0-9_]{1,63}$/u;

export function isCmsEntityId(value: string): boolean {
  return CMS_ENTITY.test(value);
}

/**
 * Core answers a CMS validation failure with zod's `.format()` tree. Flatten
 * it to `field: message` lines so the Claude reading the error can fix the
 * body, instead of a 400 with no reason.
 */
function flattenCoreDetails(details: unknown, prefix = ''): string[] {
  if (!details || typeof details !== 'object') return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (key === '_errors') {
      if (Array.isArray(value) && value.length > 0) lines.push(`${prefix || 'body'}: ${value.join('; ')}`);
      continue;
    }
    lines.push(...flattenCoreDetails(value, prefix ? `${prefix}.${key}` : key));
  }
  return lines;
}

async function cmsFetch(
  env: Env,
  actorEmail: string,
  path: string,
  init: { method: string; searchParams?: Record<string, string>; body?: unknown; timeoutMs?: number },
): Promise<JsonValue> {
  const response = await corePatFetch(env, actorEmail, path, init, 'cms');
  // A CMS body is Core's registry row, forwarded whole to the caller; its
  // shape is per entity, so only the refusal is read here.
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const refusal = readRefusal(data);
    const imageUrl = data && typeof data === 'object' && 'image_url' in data && typeof data.image_url === 'string' ? data.image_url : null;
    const message = [refusal.error ?? `Core CMS call failed (${response.status}).`, ...flattenCoreDetails(refusal.details), ...(imageUrl ? [`Uploaded image: ${imageUrl}`] : [])].join(' — ');
    throw new CrmSyncError(message, response.status);
  }
  return jsonValueSchema.parse(data);
}

/** `GET /api/agent/cms/meta/registry`: entities, fields, capabilities, operations. */
export function fetchCmsRegistry(env: Env, actorEmail: string): Promise<JsonValue> {
  return cmsFetch(env, actorEmail, '/api/agent/cms/meta/registry', { method: 'GET' });
}

export function fetchCmsList(
  env: Env,
  actorEmail: string,
  entity: string,
  query: Record<string, string>,
): Promise<JsonValue> {
  return cmsFetch(env, actorEmail, `/api/agent/cms/${entity}`, { method: 'GET', searchParams: query });
}

export function fetchCmsRecord(env: Env, actorEmail: string, entity: string, id: string): Promise<JsonValue> {
  return cmsFetch(env, actorEmail, `/api/agent/cms/${entity}/${encodeURIComponent(id)}`, { method: 'GET' });
}

export function createCmsRecord(
  env: Env,
  actorEmail: string,
  entity: string,
  body: Record<string, unknown>,
): Promise<JsonValue> {
  return cmsFetch(env, actorEmail, `/api/agent/cms/${entity}`, { method: 'POST', body });
}

export function updateCmsRecord(
  env: Env,
  actorEmail: string,
  entity: string,
  id: string,
  body: Record<string, unknown>,
): Promise<JsonValue> {
  return cmsFetch(env, actorEmail, `/api/agent/cms/${entity}/${encodeURIComponent(id)}`, { method: 'PATCH', body });
}

/**
 * `DELETE /api/agent/cms/:entity/:id`. Core allows it only on research link
 * rows (capabilities.delete in its registry) and answers 404 for any other
 * entity, so content is never hard-deleted from here.
 */
export function deleteCmsRecord(env: Env, actorEmail: string, entity: string, id: string): Promise<JsonValue> {
  return cmsFetch(env, actorEmail, `/api/agent/cms/${entity}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Core's model call alone may run 120 s, then it uploads and writes the row.
 * Ten seconds, the default for every other Core call, would abandon a paid
 * image before it lands.
 */
const CMS_EVENT_IMAGE_TIMEOUT_MS = 170_000;

/** `POST /api/agent/cms/events/:id/image`: one image in a house look, or another event's image copied, written to `image_url`. */
export function generateCmsEventImage(
  env: Env,
  actorEmail: string,
  id: string,
  body: CmsEventImageRequest,
): Promise<JsonValue> {
  return cmsFetch(env, actorEmail, `/api/agent/cms/events/${encodeURIComponent(id)}/image`, {
    method: 'POST',
    body,
    timeoutMs: CMS_EVENT_IMAGE_TIMEOUT_MS,
  });
}

export function generateCmsTechnologyImage(env: Env, actorEmail: string, id: string, body: CmsTechnologyImageRequest): Promise<JsonValue> {
  return cmsFetch(env, actorEmail, `/api/agent/cms/technologies/${encodeURIComponent(id)}/image`, {
    method: 'POST', body, timeoutMs: CMS_EVENT_IMAGE_TIMEOUT_MS,
  });
}

// ── Core registry for the web: Fields and Core search, as the member ───────
//
// Mac and iOS read Core's CRM registry directly with a device PAT (core-kit,
// docs/CORE_REGISTRY.md decision 2). The browser holds no Core token, so the
// web asks the Worker, which answers with the member's broker PAT, the same
// arrangement as `/api/cms/*` and the sales inbox. The sales
// preset carries exactly the scopes a device PAT carries, so a member reads
// and writes on the web what their Mac lets them, no more. The web's Fields
// pane reaches the records behind Work's subjects (`CORE_FIELDS_ENTITIES`); a
// Claude's `cms` reaches the five `CORE_RECORD_ENTITIES`. Nothing else in Core
// is reachable through here.

async function coreRegistryFetch(
  env: Env,
  actorEmail: string,
  path: string,
  init: { method: string; searchParams?: Record<string, string>; body?: unknown },
  label: string,
): Promise<unknown> {
  const response = await corePatFetch(env, actorEmail, path, init);
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const refusal = readRefusal(data);
    const message = [refusal.error ?? `Core ${label} failed (${response.status}).`, ...flattenCoreDetails(refusal.details)].join(' — ');
    throw new CrmSyncError(message, response.status);
  }
  return data;
}

/**
 * `GET /api/agent/meta/registry`: CRM entities, fields and the member's
 * grant. Only the entities travel on (operations and navigation are for a
 * client that browses), and one entity Core describes in a shape this build
 * cannot read is left out rather than failing the rest.
 */
export async function fetchCoreRegistry(env: Env, actorEmail: string): Promise<CoreRegistryResponse> {
  const data = await coreRegistryFetch(env, actorEmail, '/api/agent/meta/registry', { method: 'GET' }, 'registry read');
  const parsed = parseCoreBody(z.looseObject({ data: z.looseObject({ entities: z.array(z.unknown()) }) }), data, 'GET /api/agent/meta/registry');
  const entities = parsed.data.entities.flatMap((entry) => {
    const entity = coreEntitySchema.safeParse(entry);
    return entity.success ? [entity.data] : [];
  });
  return { data: { entities } };
}

/** `GET /api/agent/<entity>/<id>`: the record behind a subject. */
export async function fetchCoreFieldsRecord(
  env: Env,
  actorEmail: string,
  entity: CoreRecordEntity,
  id: string,
): Promise<JsonValue> {
  const data = await coreRegistryFetch(env, actorEmail, `/api/agent/${entity}/${encodeURIComponent(id)}`, { method: 'GET' }, 'record read');
  return jsonValueSchema.parse(parseCoreBody(coreRecordResponseSchema, data, `GET /api/agent/${entity}/:id`));
}

/**
 * `PATCH /api/agent/<entity>/<id>`: the changed fields, as the member. The
 * subject lists this Worker caches read the same row, so they drop now
 * rather than show the old name for a minute.
 */
export async function updateCoreFieldsRecord(
  env: Env,
  actorEmail: string,
  entity: CoreRecordEntity,
  id: string,
  body: CoreFieldsWriteBody,
): Promise<JsonValue> {
  await assertGroupWritable(env, coreRecordGroup(entity));
  const data = await coreRegistryFetch(env, actorEmail, `/api/agent/${entity}/${encodeURIComponent(id)}`, { method: 'PATCH', body }, 'record write');
  const parsed = parseCoreBody(coreRecordResponseSchema, data, `PATCH /api/agent/${entity}/:id`);
  await purgeRecordCaches(entity, body, parsed.data);
  return jsonValueSchema.parse(parsed);
}

/**
 * What a Core record write can change in a list this Worker caches: a partner
 * is an organization, and an interaction on a project or lead is in that
 * subject's history. Purging more than needed is cheap; missing one shows the
 * writer their own edit undone for a minute. The one purge set for a subject,
 * whichever route created or changed it. An interaction purges the parents
 * in the body and in Core's answer, so an edit that names no parent still
 * drops its history; a move drops the new parent, and the old one lapses.
 */
export async function purgeRecordCaches(
  entity: CoreRecordEntity,
  body: CoreFieldsWriteBody | null,
  record?: Record<string, unknown>,
): Promise<void> {
  forgetCoreMemo();
  const keys = new Set<CoreCacheKey>();
  if (entity === 'organizations') keys.add('subjects/open').add('subjects/all/partner');
  if (entity === 'projects') keys.add('subjects/open').add('subjects/all/project').add('subject-counts/project');
  if (entity === 'leads') keys.add('subjects/open').add('subjects/all/lead').add('subject-counts/lead');
  if (entity === 'interactions') {
    for (const source of [body, record]) {
      if (typeof source?.project_id === 'string') keys.add(`interactions/project/${source.project_id}`);
      if (typeof source?.lead_id === 'string') keys.add(`interactions/lead/${source.lead_id}`);
    }
  }
  if (keys.size > 0) await purgeCoreCache([...keys]);
}

/**
 * `DELETE /api/agent/organizations/<id>?if_unreferenced=true`. Core refuses,
 * with the tables and counts in its message, while any row still points at the
 * organization: a foreign key set to `set null` would orphan those rows and
 * one set to `cascade` would delete them. The guard is always on here; the
 * unguarded delete stays in Core.
 */
export async function deleteCoreOrganization(env: Env, actorEmail: string, id: string): Promise<JsonValue> {
  await assertGroupWritable(env, 'subjects');
  const data = await coreRegistryFetch(env, actorEmail, `/api/agent/organizations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    searchParams: { if_unreferenced: 'true' },
  }, 'organization delete');
  await purgeRecordCaches('organizations', null);
  return jsonValueSchema.parse(parseCoreBody(z.looseObject({ data: coreRecordSchema }), data, 'DELETE /api/agent/organizations/:id'));
}

/**
 * A merge of duplicate records as the member. Asked for by mz 2026-10-01;
 * Core keeps it off its own MCP, and this is the one connector door to it
 * (docs/MCP.md §CRM records).
 *
 * While the `subjects` group answers from Core: `POST
 * /api/agent/entities/<entity>/merge`. Core keeps the oldest record,
 * repoints every link from the others, and deletes them, with an audit row.
 * Core does not merge leads. Once the group answers from D1, the
 * Worker does the same in one D1 batch (`record-merges.ts`).
 *
 * A merge repoints rows of every group, so it waits while any group is
 * frozen for its move.
 */
export async function mergeCoreRecords(env: Env, actorEmail: string, entity: CoreMergeEntity, ids: string[]): Promise<JsonValue> {
  for (const group of WORK_GROUPS) await assertGroupWritable(env, group);
  let answer: JsonValue;
  if (!usesCoreFor(env, 'subjects')) {
    const merged = await d1MergeRecords(env, actorEmail, entity, ids);
    answer = { data: { ...merged } };
    await recordWorkActivity(env,
      { actor: actorEmail, table: entity, id: merged.kept, action: 'update', label: `Merged ${merged.merged.length}`, fields: ['merged_from'] },
      ...merged.merged.map((id) => ({ actor: actorEmail, table: entity, id, action: 'delete' as const, fields: ['merged_into'] })));
  } else {
    if (entity === 'leads') {
      throw new ControlError('Core merges organizations and contacts only. Leads merge once the records move to this workspace.', 400, 'invalid_request');
    }
    const data = await coreRegistryFetch(env, actorEmail, `/api/agent/entities/${entity}/merge`, {
      method: 'POST',
      body: { ids },
    }, `${entity} merge`);
    // Core answers `survivorId` and `merged<Entity>Ids`; the answer adds the
    // D1 names, so every client reads one shape from either store.
    const merged = parseCoreBody(z.looseObject({
      data: z.looseObject({
        survivorId: z.string(),
        mergedOrganizationIds: z.array(z.string()).optional(),
        mergedContactIds: z.array(z.string()).optional(),
      }),
    }), data, `POST /api/agent/entities/${entity}/merge`).data;
    answer = jsonValueSchema.parse({
      data: {
        ...merged,
        entity,
        kept: merged.survivorId,
        merged: merged.mergedOrganizationIds ?? merged.mergedContactIds ?? [],
      },
    } satisfies CoreMergeResponse);
  }
  // A merged contact or organization can be the subtitle of any lead,
  // project or partner row; drop the lists rather than guess which.
  await purgeRecordCaches('organizations', null);
  await purgeRecordCaches('leads', null);
  await purgeRecordCaches('projects', null);
  return answer;
}

/** `GET /api/agent/<entity>`: a list as the member. `params` are Core's own filters (`q`, `limit`, `organization_id`, `type`, …). */
export async function listCoreRecords(
  env: Env,
  actorEmail: string,
  entity: CoreRecordEntity,
  params: Record<string, string>,
): Promise<JsonValue> {
  const data = await coreRegistryFetch(env, actorEmail, `/api/agent/${entity}`, { method: 'GET', searchParams: params }, `${entity} read`);
  return jsonValueSchema.parse(parseCoreBody(z.looseObject({ data: z.array(coreRecordSchema) }), data, `GET /api/agent/${entity}`));
}

/** `POST /api/agent/<entity>` with every field the caller names. Core's schema is the validator. */
export async function createCoreRecord(
  env: Env,
  actorEmail: string,
  entity: CoreRecordEntity,
  body: CoreFieldsWriteBody,
): Promise<JsonValue> {
  await assertGroupWritable(env, coreRecordGroup(entity));
  const data = await coreRegistryFetch(env, actorEmail, `/api/agent/${entity}`, { method: 'POST', body }, `${entity} create`);
  const parsed = parseCoreBody(coreRecordResponseSchema, data, `POST /api/agent/${entity}`);
  await purgeRecordCaches(entity, body, parsed.data);
  return jsonValueSchema.parse(parsed);
}

/**
 * `GET /api/agent/search`: Core records across its searchable entities. A
 * hit whose page is not a Core dashboard path is dropped, so a client can
 * link it on Core's origin without reading anything else into it.
 */
export async function searchCoreRecords(env: Env, actorEmail: string, query: CoreSearchQuery): Promise<CoreSearchResponse> {
  const data = await coreRegistryFetch(env, actorEmail, '/api/agent/search', {
    method: 'GET',
    searchParams: { q: query.q, limit: String(query.limit) },
  }, 'search');
  const parsed = parseCoreBody(z.looseObject({ data: z.array(z.unknown()).nullish() }), data, 'GET /api/agent/search');
  const hits = (parsed.data ?? []).flatMap((entry) => {
    const hit = coreSearchHitSchema.safeParse(entry);
    const page = hit.success ? /^\/dashboard\/([a-z_]+)\/[^/?#]+$/u.exec(hit.data.href) : null;
    if (!hit.success || !page) return [];
    // A record whose group answers from D1 is a stale copy in Core: drop it.
    // `/api/search` finds the live one.
    const group = coreCollectionGroup(page[1]!);
    return group && !usesCoreFor(env, group) ? [] : [hit.data];
  });
  return { data: hits };
}

/**
 * The sales inbox read (docs/WORK.md "Channels on the work itself";
 *): every CRM-originated touch with no Meet subject yet —
 * contact-form submissions that skipped `createLead`, support cases, pricing
 * requests, Future Readiness Assessment submissions — plus whichever of those
 * a person already dismissed, when asked for.
 *
 * Deliberately no per-source filtering here or in the route above it: the
 * issue leaves "should every contact-form submission land here" an open
 * product question and asks not to decide it by omission, so this defaults to
 * the widest reading — everything Core's feed returns, unfiltered.
 */
export async function fetchUntriagedTouches(
  env: Env,
  actorEmail: string,
  params: { limit?: number; offset?: number; includeDismissed?: boolean } = {},
): Promise<UntriagedTouchesResponse> {
  const response = await corePatFetch(env, actorEmail, '/api/agent/untriaged-touches', {
    method: 'GET',
    searchParams: {
      limit: params.limit ? String(params.limit) : '',
      offset: params.offset ? String(params.offset) : '',
      include_dismissed: params.includeDismissed ? 'true' : '',
    },
  });
  if (!response.ok) {
    throw coreFailure('untriaged-touches read', response);
  }
  const data = await readCoreJson(response, z.looseObject({
    data: optionalList(untriagedTouchSchema.loose()),
    total: z.number().int().nullish(),
  }), 'GET /api/agent/untriaged-touches');
  return {
    data: data.data ?? [],
    total: data.total ?? 0,
  };
}

/**
 * The CRM dashboard remains the source of truth for offer state. Meet
 * projects only its last-year sales view so Home never gains a second offer
 * definition or another direct Supabase client.
 */
export async function fetchCrmCommercialSummary(
  env: Env,
  actorEmail: string,
): Promise<CommercialSummary> {
  // Core's dashboard reads a frozen copy once the group moved.
  if (!usesCoreFor(env, 'commercial')) return d1CommercialSummary(env, COMMERCIAL_LOOKBACK_MONTHS);
  const response = await corePatFetch(env, actorEmail, '/api/agent/dashboard', { method: 'GET' });
  if (!response.ok) {
    throw new CrmSyncError('Core commercial dashboard read failed (' + response.status + ').', response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw unusableCommercialDashboard();
  }
  return normalizeCommercialSummary(body);
}

/**
 * Validate Core's broad dashboard response and keep only the narrow Home
 * projection. Required series must contain a complete 12-point window; an
 * optional licenses series that is absent or malformed is explicitly null.
 */
export function normalizeCommercialSummary(body: unknown): CommercialSummary {
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  const rawSeries = data?.growthHistograms;
  if (!Array.isArray(rawSeries)) throw unusableCommercialDashboard();

  const findSeries = (id: string): Record<string, unknown> | null => {
    const found = rawSeries.find((item) => isRecord(item) && item.id === id);
    return isRecord(found) ? found : null;
  };

  const pointRows = (id: string, required: boolean): CommercialSummary['points'] | null => {
    const series = findSeries(id);
    if (!series || !Array.isArray(series.points)) {
      if (required) throw unusableCommercialDashboard();
      return null;
    }
    const window = series.points.slice(-COMMERCIAL_LOOKBACK_MONTHS);
    if (window.length !== COMMERCIAL_LOOKBACK_MONTHS) {
      if (required) throw unusableCommercialDashboard();
      return null;
    }
    const points = window.map((point) => {
      if (!isRecord(point)
        || typeof point.key !== 'string'
        || point.key.trim() === ''
        || typeof point.label !== 'string'
        || point.label.trim() === ''
        || !isFiniteNonNegativeNumber(point.total)
        || !isFiniteNonNegativeNumber(point.positive)
        || !isFiniteNonNegativeNumber(point.negative)) {
        return null;
      }
      return {
        key: point.key,
        label: point.label,
        total: point.total,
        positive: point.positive,
        negative: point.negative,
      };
    });
    if (points.some((point) => point === null)) {
      if (required) throw unusableCommercialDashboard();
      return null;
    }
    return points as CommercialSummary['points'];
  };

  const salesSeries = findSeries('sales');
  const sales = pointRows('sales', true)!;
  const offers = pointRows('offers', true)!;
  const licenses = pointRows('licenses', false);
  const rawCurrencyCode = salesSeries?.currencyCode;
  if (typeof rawCurrencyCode !== 'string' || !/^[A-Za-z]{3}$/u.test(rawCurrencyCode.trim())) {
    throw unusableCommercialDashboard();
  }
  const currencyCode = rawCurrencyCode.trim().toUpperCase();

  return {
    lookback_months: COMMERCIAL_LOOKBACK_MONTHS,
    offers: offers.reduce((total, point) => total + point.total, 0),
    sales_amount: sales.reduce((total, point) => total + point.positive, 0),
    pipeline_amount: sales.reduce(
      (total, point) => total + Math.max(point.total - point.positive - point.negative, 0),
      0,
    ),
    new_licenses: licenses
      ? licenses.reduce((total, point) => total + point.total, 0)
      : null,
    currency_code: currencyCode,
    points: sales,
  };
}

/**
 * One of the host's bookings as Core's `GET /api/agent/bookings` lists it:
 * the inbox's booking card plus what the Worker reads to place it. `source`
 * and `status` stay open strings, because the inbox skips a status it does not
 * know rather than failing the whole list.
 */
export const coreHostBookingSchema = inboxBookingSchema.extend({
  source: z.string().optional(),
  status: z.string(),
  cancellation_token: z.string().nullable().optional(),
  /** Change stamps (Core migration 20260919_150000); null on a row that never changed. */
  cancelled_at: z.string().nullable().optional(),
  rescheduled_at: z.string().nullable().optional(),
  previous_start_time: z.string().nullable().optional(),
  previous_end_time: z.string().nullable().optional(),
});
export type CoreHostBooking = z.infer<typeof coreHostBookingSchema>;

/**
 * File the CRM interaction of a booking Meet's booking page took
 *. Core files it as a self-booking, keyed by the
 * booking's join token, so a call on that link merges into it. Never fatal:
 * the booking stands without it, and the failure is logged.
 */
export async function fileBookingInteraction(env: Env, host: { email: string }, booking: BookingInteraction): Promise<void> {
  if (!crmSyncEnabled(env)) return;
  try {
    // Once the group is on D1, the booking's interaction is a D1 row.
    if (!usesCoreFor(env, 'interactions')) {
      await d1FileBookingInteraction(env, host, booking);
      return;
    }
    const response = await corePatFetch(env, host.email, '/api/agent/booking-interactions', {
      method: 'POST',
      body: {
        token: booking.token,
        booking_id: booking.booking_id,
        title: booking.title,
        start_time: booking.start_time,
        end_time: booking.end_time,
        ...(booking.google_event_id ? { google_event_id: booking.google_event_id } : {}),
        guest: {
          name: booking.guest.name,
          email: booking.guest.email,
          title: booking.guest.title,
          organization: booking.guest.organization,
          ...(booking.guest.notes ? { notes: booking.guest.notes } : {}),
        },
        nda_required: booking.nda_required,
      },
    });
    if (!response.ok) console.warn(`Core booking interaction failed (${response.status}) for booking ${booking.booking_id}.`);
  } catch (error) {
    console.warn(`Core booking interaction failed for booking ${booking.booking_id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The booking behind `token` moved (a guest's move carries the new token) or was cancelled. Never fatal. */
export async function changeBookingInteraction(
  env: Env,
  host: { email: string },
  token: string,
  change: BookingInteractionChange,
): Promise<void> {
  if (!crmSyncEnabled(env)) return;
  try {
    if (!usesCoreFor(env, 'interactions')) {
      await d1ChangeBookingInteraction(env, host, token, change);
      return;
    }
    const response = await corePatFetch(env, host.email, `/api/agent/booking-interactions/${encodeURIComponent(token)}`, {
      method: 'PATCH',
      body: change,
    });
    if (!response.ok && response.status !== 404) console.warn(`Core booking interaction ${change.action} failed (${response.status}).`);
  } catch (error) {
    console.warn(`Core booking interaction ${change.action} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The host's bookings from `from` on, soonest first. `source` narrows to
 * what the guest booked themselves (`self`) or what the host issued from
 * Meet (`event`); `status` is confirmed unless asked for `all`.
 */
export async function fetchHostBookings(
  env: Env,
  actorEmail: string,
  params: { hostUsername: string; from?: Date; source?: 'self' | 'event'; status?: 'confirmed' | 'cancelled' | 'all'; limit?: number },
): Promise<CoreHostBooking[]> {
  const response = await corePatFetch(env, actorEmail, '/api/agent/bookings', {
    method: 'GET',
    searchParams: {
      host_username: params.hostUsername,
      from: params.from ? params.from.toISOString() : '',
      source: params.source ?? '',
      status: params.status ?? '',
      limit: params.limit ? String(params.limit) : '',
    },
  });
  if (!response.ok) {
    throw coreFailure('bookings read', response);
  }
  const data = await readCoreJson(response, z.looseObject({
    bookings: optionalList(coreHostBookingSchema.loose()),
  }), 'GET /api/agent/bookings');
  return data.bookings ?? [];
}

/** Dismiss (or, `dismissed: false`, undo dismissing) one untriaged touch. */
export async function setUntriagedTouchDismissed(
  env: Env,
  actorEmail: string,
  touchId: string,
  dismissed: boolean,
): Promise<boolean> {
  const response = await corePatFetch(
    env,
    actorEmail,
    `/api/agent/untriaged-touches/${encodeURIComponent(touchId)}/dismiss`,
    { method: dismissed ? 'POST' : 'DELETE' },
  );
  if (!response.ok) {
    throw coreFailure('untriaged-touch dismiss', response);
  }
  const data = await readCoreJson(response, z.looseObject({
    dismissed: z.boolean().nullish(),
  }), `${dismissed ? 'POST' : 'DELETE'} /api/agent/untriaged-touches/:id/dismiss`);
  return data.dismissed === true;
}
