// The Granola bridge: every Granola note becomes the same CRM interaction a
// hosted Meet session becomes, so one timeline holds both and Meet's surfaces
// need no second reader. See docs/GRANOLA_BRIDGE.md.
//
// Two directions, one mapper:
//
// - **Webhook** (`note.generated` / `note.edited`) is the ongoing path. Granola
//   sends the note id and nothing else, so the payload is never trusted for
//   content — it is a nudge to go and read the note with our own key.
// - **Backfill** walks `/notes` by created-at window through the identical
//   mapper, so the two years of history and tomorrow's meeting land as the same
//   shape. There is no second code path to keep in step.
//
// Invariants this file must keep:
//   - Never invent an email. An attendee without one stays name-only.
//   - Never fail a webhook delivery on a Core outage — enqueue, then retry.
//   - An Envisioning address is internal, not a lead: mapped `owner`, so Core
//     links an existing contact but never creates one for a colleague.

import { isMemberEmail } from './workspace-identity';
import { usesCore } from './work-store';
import { hmacSHA256Base64, base64Bytes, constantTimeEqualSync } from './crypto';
import {
  crmSyncEnabled,
  fetchCrmSubject,
  fetchCrmSubjects,
  fetchGranolaLedger,
  postMeetingLog,
  type CrmLedgerRow,
  type MeetingLogPayload,
} from './crm';
import {
  docsDocumentURL,
  docsEnabled,
  fileTranscriptDocument,
  purgeDocsDocument,
  transcriptDocumentBody,
  transcriptSubjects,
} from './docs';
import { cachedRead, purgeCoreCache } from './core-cache';
import { AuthError, ControlError } from './errors';
import {
  granolaSuggestEnabled,
  granolaSuggestionCounts,
  readGranolaSuggestions,
  recordGranolaFilingOutcome,
  suggestGranolaFiling,
  suggestedNoteIds,
} from './granola-suggest';
import { assertUnderRateLimit, readBoundedText } from './http';
import { isConsumerDomain, registrableDomain } from './identity';
import { connectorPulse, touchConnector } from './import-ledger';
import {
  meetingKindSchema,
  type ConnectorsResponse,
  type CrmSubject,
  type GranolaProposal,
  type GranolaProposalsResponse,
  type ConnectorStatus,
  type GranolaCategoryResponse,
  type GranolaFilingSuggestion,
  type GranolaLedgerResponse,
  type GranolaNoteRow,
  type GranolaSuggestResponse,
  type GranolaNotesResponse,
  type GranolaRefreshResponse,
  type MeetingKind,
} from './contracts';

const GRANOLA_API = 'https://public-api.granola.ai/v1';
/** Granola's own ceiling: 30 notes a page. */
const NOTE_PAGE = 30;
/** Transcript pages when a note is too large to inline. */
const TRANSCRIPT_PAGE = 100;
/** Core caps the body; keep the transcript inside the ~1 MiB batch class. */
const TRANSCRIPT_MAX_SEGMENTS = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Standard Webhooks' replay window. Wider than Meet's own internal skew
 * because a retried delivery can arrive minutes after the first attempt, and
 * refusing those would turn a transient Core outage into permanent data loss.
 */
const WEBHOOK_SKEW_SECONDS = 5 * 60;

export class GranolaError extends ControlError {}

/**
 * Off unless both halves exist. The key alone is useless — a note we can read
 * but cannot write anywhere — and CRM sync being off is a deliberate kill
 * switch that this bridge must honour rather than route around.
 */
export function granolaBridgeEnabled(env: Env): boolean {
  return Boolean(env.GRANOLA_API_KEY?.trim()) && crmSyncEnabled(env);
}

// ---------------------------------------------------------------- Granola API

async function granolaFetch(env: Env, path: string, query: Record<string, string | undefined> = {}) {
  const key = env.GRANOLA_API_KEY?.trim();
  if (!key) throw new GranolaError('GRANOLA_API_KEY is not configured.', 503, 'not_configured');
  const url = new URL(`${GRANOLA_API}${path}`);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') url.searchParams.set(name, value);
  }
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // 429 throws like any other failure so the queue backs off. Granola allows
  // 5/s sustained and the consumer is sequential, so this is a safety net
  // rather than the normal path.
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new GranolaError(`Granola returned ${response.status}.`, response.status === 429 ? 429 : 502);
  }
  return await response.json() as Record<string, unknown>;
}

/** One page of `/notes`, newest-first, within an optional created-at window. */
export async function listGranolaNotes(env: Env, options: {
  createdAfter?: string | undefined;
  createdBefore?: string | undefined;
  cursor?: string | undefined;
}): Promise<{ notes: Array<Record<string, unknown> & { id: string }>; cursor: string | null; added: number }> {
  const page = await granolaFetch(env, '/notes', {
    page_size: String(NOTE_PAGE),
    created_after: options.createdAfter,
    created_before: options.createdBefore,
    cursor: options.cursor,
  });
  const notes = Array.isArray(page?.notes) ? page.notes as Array<Record<string, unknown>> : [];
  const hasMore = page?.hasMore === true;
  const next = typeof page?.cursor === 'string' ? page.cursor : null;
  // One line per page, so a history that stops short can be read from the
  // log: how many, how far back this page reached, and whether Granola said
  // there was more.
  const oldest = notes.reduce<string | null>((floor, note) => {
    const created = typeof note.created_at === 'string' ? note.created_at : null;
    return created && (!floor || created < floor) ? created : floor;
  }, null);
  console.log(JSON.stringify({
    level: 'info',
    message: 'granola.notes.page',
    notes: notes.length,
    oldest,
    hasMore,
    cursor: Boolean(options.cursor),
    createdAfter: options.createdAfter ?? null,
  }));
  const typed = notes.filter((note): note is Record<string, unknown> & { id: string } => typeof note.id === 'string');
  const added = await indexGranolaNotes(env, typed);
  return { notes: typed, cursor: hasMore ? next : null, added };
}

// ------------------------------------------------------------------- index

/** What the index keeps of one note: the list row's Granola half, no content. */
function indexRowOf(env: Pick<Env, 'IDENTITY_DOMAINS'>, note: Record<string, unknown> & { id: string }): IndexRow {
  const owner = note.owner as Record<string, unknown> | undefined;
  const event = note.calendar_event as Record<string, unknown> | undefined;
  const createdAt = typeof note.created_at === 'string' ? note.created_at : new Date(0).toISOString();
  const startedAt = typeof event?.scheduled_start_time === 'string' ? event.scheduled_start_time : createdAt;
  const title = typeof note.title === 'string' && note.title.trim()
    ? note.title.trim()
    : (typeof event?.event_title === 'string' && event.event_title.trim() ? event.event_title.trim() : null);
  // A name to draw and a domain to group a company by. D1 never holds a
  // guest's address (PRIVACY.md §Where things are hosted).
  const attendees = mapParticipants(env, note, personEmail(owner?.email) ?? '')
    // Granola names a guest by their address when it has no name; that is
    // still the address, so it goes too.
    .map((person) => ({ name: person.name.includes('@') ? '' : person.name, domain: emailDomain(person.email) }));
  return {
    note_id: note.id,
    title,
    started_at: new Date(startedAt).toISOString(),
    created_at: new Date(createdAt).toISOString(),
    owner_email: personEmail(owner?.email),
    attendees,
    web_url: typeof note.web_url === 'string' && note.web_url.startsWith('https://') ? note.web_url : null,
  };
}

interface IndexRow {
  note_id: string;
  title: string | null;
  started_at: string;
  created_at: string;
  owner_email: string | null;
  attendees: IndexAttendee[];
  web_url: string | null;
  /** Filed as personal: nothing reads this note again. */
  personal_at?: number | null;
}

interface IndexAttendee {
  name: string;
  domain: string | null;
}

function emailDomain(email: string | null | undefined): string | null {
  const at = email?.lastIndexOf('@') ?? -1;
  return email && at > 0 ? email.slice(at + 1).trim().toLowerCase() || null : null;
}

/**
 * Every Granola read writes the index, so the list never has to read Granola
 * to draw what Meet has already seen. Best effort: a D1 hiccup costs one
 * refresh, never a read.
 */
async function indexGranolaNotes(env: Env, notes: Array<Record<string, unknown> & { id: string }>): Promise<number> {
  if (notes.length === 0) return 0;
  try {
    const known = await knownNoteIds(env, notes.map((note) => note.id));
    const now = Date.now();
    const statement = env.USAGE.prepare(
      `INSERT INTO granola_notes (note_id, title, started_at, created_at, owner_email, attendees, web_url, seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(note_id) DO UPDATE SET title = excluded.title, started_at = excluded.started_at,
         owner_email = COALESCE(excluded.owner_email, granola_notes.owner_email),
         -- Granola's list carries no attendees; only a note read does. A page
         -- must not blank what a note read filled.
         attendees = CASE WHEN excluded.attendees = '[]' THEN granola_notes.attendees ELSE excluded.attendees END,
         web_url = COALESCE(excluded.web_url, granola_notes.web_url), seen_at = excluded.seen_at`,
    );
    await env.USAGE.batch(notes.map((note) => {
      const row = indexRowOf(env, note);
      return statement.bind(row.note_id, row.title, row.started_at, row.created_at, row.owner_email, JSON.stringify(row.attendees), row.web_url, now);
    }));
    return notes.filter((note) => !known.has(note.id)).length;
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'granola.index.write.failed',
      notes: notes.length,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return 0;
  }
}

async function knownNoteIds(env: Env, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(', ');
  const { results } = await env.USAGE.prepare(`SELECT note_id FROM granola_notes WHERE note_id IN (${placeholders})`)
    .bind(...ids).all<{ note_id: string }>();
  return new Set(results.map((row) => row.note_id));
}

async function readGranolaIndex(env: Env): Promise<{ rows: IndexRow[]; indexedAt: number | null }> {
  const { results } = await env.USAGE.prepare(
    'SELECT note_id, title, started_at, created_at, owner_email, attendees, web_url, seen_at, personal_at FROM granola_notes ORDER BY started_at DESC',
  ).all<Omit<IndexRow, 'attendees'> & { attendees: string; seen_at: number }>();
  let indexedAt: number | null = null;
  const rows = results.map((row) => {
    indexedAt = Math.max(indexedAt ?? 0, row.seen_at);
    let attendees: IndexAttendee[] = [];
    try {
      // Rows written before 0055 carried an address; keep only its domain.
      attendees = (JSON.parse(row.attendees) as Array<IndexAttendee & { email?: string | null }>)
        .map((person) => ({ name: person.name, domain: person.domain ?? emailDomain(person.email) }));
    } catch {
      // A row with unreadable attendees still lists; who is a detail.
    }
    return { ...row, attendees };
  });
  return { rows, indexedAt };
}

/** Pages a refresh reads before stopping, when every page is new. */
const REFRESH_PAGE_CEILING = 40;

/**
 * Read Granola newest-first until a page holds nothing the index lacks.
 * On an empty index that is the whole history, once; afterwards it is one
 * page, and usually zero new notes.
 */
export async function refreshGranolaIndex(env: Env): Promise<GranolaRefreshResponse> {
  if (!granolaBridgeEnabled(env)) {
    throw new ControlError('The Granola bridge is not configured.', 503, 'not_configured');
  }
  let cursor: string | undefined;
  let pages = 0;
  let added = 0;
  do {
    const page = await listGranolaNotes(env, { cursor });
    pages += 1;
    added += page.added;
    // A page the index already knew in full is where the new notes end.
    cursor = page.added > 0 && page.cursor ? page.cursor : undefined;
  } while (cursor && pages < REFRESH_PAGE_CEILING);
  console.log(JSON.stringify({ level: 'info', message: 'granola.index.refreshed', pages, added }));
  return { added, pages };
}


/**
 * The whole transcript, following the cursor. Only reached when the note
 * itself answered `TRANSCRIPT_TOO_LARGE` — the common case is one request.
 */
async function fetchTranscriptPages(env: Env, noteId: string): Promise<Array<Record<string, unknown>>> {
  const segments: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  do {
    const page = await granolaFetch(env, `/notes/${noteId}/transcript`, {
      page_size: String(TRANSCRIPT_PAGE),
      cursor,
    });
    const items = Array.isArray(page?.transcript) ? page.transcript as Array<Record<string, unknown>> : [];
    segments.push(...items);
    cursor = page?.hasMore === true && typeof page.cursor === 'string' ? page.cursor : undefined;
  } while (cursor && segments.length < TRANSCRIPT_MAX_SEGMENTS);
  return segments;
}

// ------------------------------------------------------------------- mapping

/**
 * Granola timestamps a segment however the capture did: milliseconds from the
 * start on desktop, an ISO instant on mobile. Core wants offsets in
 * milliseconds either way, so an absolute time is rebased on the first segment
 * rather than dropped — a transcript with no clock is still a transcript.
 */
function offsetMs(value: unknown, origin: number | null): { ms: number; absolute: number | null; ok: boolean } {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Taken as milliseconds, which is what Core's own segments are and what
    // the field name says. Granola's reference does not state the unit, so if
    // it ever turns out to be seconds the symptom is loud — a 45-minute
    // meeting rendering 45 seconds of offsets — rather than a magnitude
    // heuristic quietly rescaling real millisecond values. Checked against the
    // first live note; see docs/GRANOLA_BRIDGE.md.
    return { ms: Math.max(0, Math.round(value)), absolute: null, ok: true };
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return { ms: origin === null ? 0 : Math.max(0, parsed - origin), absolute: parsed, ok: true };
    }
  }
  // Genuinely unparseable — distinct from a real, legitimately-zero offset,
  // so the monotonic fallback below can tell "no clock" from "started the
  // meeting" without asking every other segment first.
  return { ms: 0, absolute: null, ok: false };
}

function segmentSpeaker(item: Record<string, unknown>): string {
  const speaker = item.speaker as Record<string, unknown> | undefined;
  const candidates = [
    typeof speaker?.name === 'string' ? speaker.name : null,
    typeof speaker?.attribution === 'string' ? speaker.attribution : null,
    typeof speaker?.diarization_label === 'string' ? speaker.diarization_label : null,
    typeof speaker?.source === 'string' ? speaker.source : null,
    typeof item.speaker_name === 'string' ? item.speaker_name : null,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return 'Speaker';
}

function mapTranscript(items: Array<Record<string, unknown>>): MeetingLogPayload['transcript'] {
  // The first parsable absolute time is the origin every later one is measured
  // from, so ISO-stamped transcripts still produce offsets from zero.
  let origin: number | null = null;
  for (const item of items) {
    const { absolute } = offsetMs(item.start_timestamp ?? item.start ?? item.starts_at, null);
    if (absolute !== null) { origin = absolute; break; }
  }
  return items.slice(0, TRANSCRIPT_MAX_SEGMENTS).map((item) => {
    const start = offsetMs(item.start_timestamp ?? item.start ?? item.starts_at, origin);
    const end = offsetMs(item.end_timestamp ?? item.end ?? item.ends_at, origin);
    const speaker = segmentSpeaker(item);
    return {
      speaker_name: speaker,
      // Granola has no stable per-speaker id, so the label is the identity —
      // consistent within one transcript, which is all Core reads it for.
      speaker_id: `granola:${speaker.toLowerCase().replaceAll(/\s+/gu, '-')}`,
      starts_at_ms: start.ms,
      ends_at_ms: Math.max(start.ms, end.ms),
      // Whether this segment's own clock parsed — not whether it landed on
      // zero, which a genuinely first segment does honestly.
      hasClock: start.ok,
      text: typeof item.text === 'string' ? item.text : '',
      language: typeof item.language === 'string' ? item.language : 'en',
    };
  }).filter((segment) => segment.text.trim().length > 0)
    // A segment whose own clock never parsed still needs a monotonic offset,
    // or the Markdown Core renders stacks it at 00:00:00 with whichever real
    // neighbors also start at zero — judged per segment, not by whether the
    // whole transcript happens to have a clock.
    .map(({ hasClock, ...segment }, index) => (
      hasClock ? segment : { ...segment, starts_at_ms: index * 1000, ends_at_ms: index * 1000 }
    ));
}

function personEmail(value: unknown): string | null {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email.includes('@') ? email : null;
}

/**
 * Attendees plus calendar invitees, de-duplicated by address. Role is
 * internal-vs-external, not host-vs-guest: Core auto-creates a contact for a
 * `guest` and only links an existing one for an `owner`, and an Envisioning
 * colleague must never become a lead.
 */
function mapParticipants(env: Pick<Env, 'IDENTITY_DOMAINS'>, note: Record<string, unknown>, hostEmail: string): MeetingLogPayload['participants'] {
  const byEmail = new Map<string, { name: string; email: string | null }>();
  const anonymous: Array<{ name: string; email: string | null }> = [];

  const attendees = Array.isArray(note.attendees) ? note.attendees as Array<Record<string, unknown>> : [];
  const event = note.calendar_event as Record<string, unknown> | undefined;
  const invitees = Array.isArray(event?.invitees) ? event.invitees as Array<Record<string, unknown>> : [];

  for (const person of [...attendees, ...invitees]) {
    const email = personEmail(person.email);
    const name = typeof person.name === 'string' && person.name.trim() ? person.name.trim() : (email ?? '');
    if (!email) {
      if (name) anonymous.push({ name, email: null });
      continue;
    }
    // First mention wins: `attendees` carries display names, `invitees` often
    // only an address, and overwriting would lose the name.
    if (!byEmail.has(email)) byEmail.set(email, { name: name || email, email });
  }

  const people = [...byEmail.values(), ...anonymous];
  return people.map((person, index) => ({
    identity: `granola:${person.email ?? `guest-${index}`}`,
    name: person.name,
    email: person.email,
    role: (person.email && (person.email === hostEmail || isMemberEmail(env, person.email)))
      ? 'owner' as const
      : 'guest' as const,
    booking_token: null,
  }));
}

/** One Granola note in the exact shape a finished Meet session sends. */
export function buildGranolaLogPayload(
  env: Pick<Env, 'IDENTITY_DOMAINS'>,
  note: Record<string, unknown>,
  transcript: Array<Record<string, unknown>>,
): MeetingLogPayload {
  const owner = note.owner as Record<string, unknown> | undefined;
  const event = note.calendar_event as Record<string, unknown> | undefined;
  const hostEmail = personEmail(owner?.email) ?? personEmail(event?.organiser) ?? '';
  if (!hostEmail) throw new GranolaError('Granola note has no owner address.', 422, 'invalid_request');

  const createdAt = typeof note.created_at === 'string' ? note.created_at : new Date().toISOString();
  const startedAt = typeof event?.scheduled_start_time === 'string' ? event.scheduled_start_time : createdAt;
  const endedAt = typeof event?.scheduled_end_time === 'string' ? event.scheduled_end_time : null;
  const title = typeof note.title === 'string' && note.title.trim()
    ? note.title.trim()
    : (typeof event?.event_title === 'string' ? event.event_title.trim() : null);

  const summary = typeof note.summary_markdown === 'string' && note.summary_markdown.trim()
    ? note.summary_markdown
    : (typeof note.summary_text === 'string' ? note.summary_text : null);

  const webURL = typeof note.web_url === 'string' && note.web_url.startsWith('https://')
    ? note.web_url
    : null;

  return {
    // A note only reaches the API once it has a summary, so there is no
    // half-written state to model: every Granola row arrives finished.
    phase: 'ended',
    source: 'granola',
    meeting_id: String(note.id),
    room_slug: null,
    host_email: hostEmail,
    started_at: new Date(startedAt).toISOString(),
    ended_at: endedAt ? new Date(endedAt).toISOString() : null,
    title,
    summary_markdown: summary,
    transcript: mapTranscript(transcript),
    participants: mapParticipants(env, note, hostEmail),
    booking_token: null,
    permalink: webURL,
    // Filing is a human act. Everything lands in the "needs filing" queue and
    // the existing category routes move it — inferring a lead from an email
    // domain is exactly the silent wrong link MEETING_LOG.md forbids.
    meeting_kind: 'uncategorized',
    lead_id: null,
    project_id: null,
    categorized_by: null,
    transcript_document_id: null,
    transcript_url: null,
  };
}

// -------------------------------------------------------------------- ingest

/**
 * Read one note and write it to Core. Throws on any failure so the queue
 * retries — a note that 404s (deleted, or never summarized) is not a failure
 * and returns `false`.
 */
/** One note read with its whole transcript, in the shape Core takes. Null when Granola no longer has it. */
async function readGranolaNote(env: Env, noteId: string): Promise<MeetingLogPayload | null> {
  const note = await granolaFetch(env, `/notes/${noteId}`, { include: 'transcript' });
  if (!note) return null;
  if (typeof note.id === 'string') await indexGranolaNotes(env, [note as Record<string, unknown> & { id: string }]);
  let transcript = Array.isArray(note.transcript) ? note.transcript as Array<Record<string, unknown>> : [];
  // The note answers `TRANSCRIPT_TOO_LARGE` instead of inlining a long one.
  const oversized = !Array.isArray(note.transcript)
    && typeof note.transcript === 'string'
    && note.transcript === 'TRANSCRIPT_TOO_LARGE';
  if (oversized) transcript = await fetchTranscriptPages(env, noteId);
  return buildGranolaLogPayload(env, note, transcript);
}

export async function ingestGranolaNote(
  env: Env,
  noteId: string,
  filing?: GranolaFiling,
): Promise<boolean> {
  if (filing?.meetingKind === 'personal') return filePersonalNote(env, noteId, filing);
  // A personal note is its owner's: no webhook, backfill or import sends it
  // to Core, Docs or a model again. Answered as done so the queue drops it.
  if (await isPersonalNote(env, noteId)) {
    console.log(JSON.stringify({ level: 'info', message: 'granola.note.personal_skipped', noteId }));
    return true;
  }
  const payload = await readGranolaNote(env, noteId);
  if (!payload) return false;

  // What Core already holds for this note: the filing a person set, and the
  // Docs document to replace rather than duplicate. Absent on a first import.
  const [previous] = await fetchGranolaLedger(env, noteId);
  const kind: MeetingKind | null = filing?.meetingKind
    ?? (previous?.meeting_kind ? meetingKindSchema.catch('uncategorized').parse(previous.meeting_kind) : null);
  const leadId = filing ? filing.leadId : (previous?.lead_id ?? null);
  const projectId = filing ? filing.projectId : (previous?.project_id ?? null);
  const eventId = filing ? filing.eventId : (previous?.event_id ?? null);
  const partnerId = filing ? filing.partnerOrganizationId : (kind === 'partner' ? previous?.organization_id ?? null : null);

  // The full transcript goes to Docs first, as a Meet meeting's does, so
  // Core's row can point at it. Best effort: a Docs outage must not hold the
  // import, and the next read files it then.
  if (payload.transcript.length > 0 && docsEnabled(env)) {
    try {
      const people = payload.participants.map((p) => p.name.trim() || p.email || '').filter(Boolean).join(', ');
      const filed = await fileTranscriptDocument(env, payload.host_email, {
        title: `${payload.title?.trim() || 'Granola meeting'} — transcript`,
        body_md: transcriptDocumentBody({
          head: `Meeting captured in Granola on ${payload.started_at.slice(0, 10)}.`,
          people,
          transcript: payload.transcript,
        }),
        existingId: previous?.transcript_document_id ?? null,
        subjects: transcriptSubjects(kind, leadId, projectId, eventId, partnerId),
        message: 'from Granola',
        occurredAt: payload.started_at,
      });
      payload.transcript_document_id = filed.id;
      payload.transcript_url = docsDocumentURL(env, filed.path);
    } catch (error) {
      console.warn(JSON.stringify({
        level: 'warn',
        message: 'granola.transcript.unfiled',
        noteId,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  }

  // Filing is a human act. A plain read sends no kind, and Core keeps whatever
  // a person set; only the category route sends one.
  if (filing) {
    payload.meeting_kind = filing.meetingKind;
    payload.lead_id = filing.leadId;
    payload.project_id = filing.projectId;
    payload.event_id = filing.eventId;
    payload.partner_organization_id = filing.partnerOrganizationId;
    payload.categorized_by = filing.categorizedBy;
  } else {
    delete payload.meeting_kind;
  }

  await postMeetingLog(env, payload);
  await purgeCoreCache(['granola/ledger']);
  console.log(JSON.stringify({
    level: 'info',
    message: 'granola.note.synced',
    noteId,
    participantCount: payload.participants.length,
    transcriptSegmentCount: payload.transcript.length,
    hasSummary: Boolean(payload.summary_markdown),
    filed: Boolean(filing),
  }));
  await touchConnector(env, 'granola', 'import');

  // A suggestion for the queue, once Core has the row and has drawn the
  // organization edge from the contacts. Never on a filing, and never a
  // reason for the import to fail — the module catches its own errors.
  if (!filing && granolaSuggestEnabled(env)) {
    const [written] = await fetchGranolaLedger(env, noteId);
    await suggestGranolaFiling(env, {
      meeting_id: payload.meeting_id,
      title: payload.title,
      started_at: payload.started_at,
      participants: payload.participants.map((person) => ({ name: person.name, email: person.email })),
      summary_markdown: payload.summary_markdown,
      transcript_text: payload.transcript.map((segment) => `${segment.speaker_name}: ${segment.text}`).join('\n'),
    }, written ?? previous);
  }
  await markNoteIngested(env, noteId);
  return true;
}

async function isPersonalNote(env: Env, noteId: string): Promise<boolean> {
  const row = await env.USAGE.prepare('SELECT personal_at FROM granola_notes WHERE note_id = ?1')
    .bind(noteId).first<{ personal_at: number | null }>();
  return Boolean(row?.personal_at);
}

/**
 * Filing as personal takes the meeting back out of the company: the mark
 * first, so a delivery racing this never re-imports it; then the transcript
 * leaves Docs for good (purged, not hidden — Docs cannot hide a document from
 * staff); then Core is told the kind with no content at all, which makes its
 * row owner-only and clears what it held. Granola keeps the note.
 */
async function filePersonalNote(env: Env, noteId: string, filing: GranolaFiling): Promise<boolean> {
  const note = await granolaFetch(env, `/notes/${noteId}`);
  if (!note) return false;
  if (typeof note.id === 'string') await indexGranolaNotes(env, [note as Record<string, unknown> & { id: string }]);
  await env.USAGE.prepare('UPDATE granola_notes SET personal_at = ?1, personal_by = ?2 WHERE note_id = ?3')
    .bind(Date.now(), filing.categorizedBy, noteId).run();
  await env.USAGE.prepare('DELETE FROM granola_suggestions WHERE note_id = ?1').bind(noteId).run();

  const [previous] = await fetchGranolaLedger(env, noteId);
  if (previous?.transcript_document_id && docsEnabled(env)) {
    await purgeDocsDocument(env, filing.categorizedBy, previous.transcript_document_id);
  }
  if (previous) {
    const payload = buildGranolaLogPayload(env, note, []);
    payload.summary_markdown = null;
    payload.transcript = [];
    payload.participants = [];
    payload.transcript_document_id = null;
    payload.transcript_url = null;
    payload.meeting_kind = 'personal';
    payload.lead_id = null;
    payload.project_id = null;
    payload.event_id = null;
    payload.partner_organization_id = null;
    payload.categorized_by = filing.categorizedBy;
    await postMeetingLog(env, payload);
    await purgeCoreCache(['granola/ledger']);
  }
  console.log(JSON.stringify({ level: 'info', message: 'granola.note.personal', noteId, hadTranscript: Boolean(previous?.transcript_document_id) }));
  return true;
}

/** Stamped only when Core has taken the note — the unit a run's progress counts. */
async function markNoteIngested(env: Env, noteId: string): Promise<void> {
  try {
    await env.USAGE.prepare('UPDATE granola_notes SET ingested_at = ?1 WHERE note_id = ?2')
      .bind(Date.now(), noteId).run();
  } catch {
    // A missed stamp is a progress bar one short, never a failed import.
  }
}

/**
 * A suggestion on its own, for a note Core already holds: the `granola-suggest`
 * job. Reads the note, never writes Core. Idempotent through the module's
 * own "already answered" check.
 */
export async function suggestGranolaNote(env: Env, noteId: string): Promise<boolean> {
  if (!granolaSuggestEnabled(env)) return false;
  // Core already holds the note body and the start of the transcript for an
  // imported row; that is all the model reads. No Granola call.
  const [row] = await fetchGranolaLedger(env, noteId);
  if (!row || (row.meeting_kind && row.meeting_kind !== 'uncategorized')) return false;
  if (await isPersonalNote(env, noteId)) return false;
  await suggestGranolaFiling(env, {
    meeting_id: noteId,
    title: row.title,
    started_at: row.occurred_at ?? row.created_at ?? new Date(0).toISOString(),
    participants: row.contacts.map((contact) => ({ name: contact.name ?? contact.email ?? 'unknown', email: contact.email })),
    summary_markdown: row.summary_markdown,
    transcript_text: row.transcript_preview ?? '',
  }, row);
  return true;
}

/**
 * Queue a suggestion for every imported, unfiled note that has none — the
 * backlog that imported while the model was unavailable. Owner action.
 */
export async function queueGranolaSuggestions(env: Env): Promise<GranolaSuggestResponse> {
  if (!granolaBridgeEnabled(env)) {
    throw new ControlError('The Granola bridge is not configured.', 503, 'not_configured');
  }
  if (!granolaSuggestEnabled(env)) return { queued: 0 };
  const [ledger, answered] = await Promise.all([cachedLedger(env), suggestedNoteIds(env)]);
  const wanted = ledger.filter((row) => row.granola_note_id
    && (!row.meeting_kind || row.meeting_kind === 'uncategorized')
    && !answered.has(row.granola_note_id));
  for (const row of wanted) {
    await env.IMPORT_JOBS.send({ kind: 'granola-suggest', noteId: row.granola_note_id! });
  }
  console.log(JSON.stringify({ level: 'info', message: 'granola.suggest.queued', notes: wanted.length }));
  return { queued: wanted.length };
}

/**
 * The whole ledger, a minute old at most. Every Granola page, the import
 * poll, the Connectors card and the suggest button read this; the queue
 * purges it after each write so the writer's own re-read is fresh.
 */
function cachedLedger(env: Env): Promise<CrmLedgerRow[]> {
  return cachedRead('granola/ledger', () => fetchGranolaLedger(env));
}

// ---------------------------------------------------------- import list (web)

export interface GranolaFiling {
  meetingKind: MeetingKind;
  leadId: string | null;
  projectId: string | null;
  eventId: string | null;
  partnerOrganizationId: string | null;
  categorizedBy: string;
}

/** The list row for one note, from Granola's fields and Core's ledger. */
function noteRow(
  note: IndexRow,
  ledger: CrmLedgerRow | undefined,
  suggestion: GranolaFilingSuggestion | undefined,
): GranolaNoteRow {
  const kind = ledger ? meetingKindSchema.catch('uncategorized').parse(ledger.meeting_kind ?? 'uncategorized') : 'uncategorized';
  // Granola's list names nobody; once imported, Core's contacts are the
  // better answer anyway — linked people, not calendar strings.
  const attendees = note.attendees.length
    ? note.attendees.map((person) => ({ name: person.name || person.domain || '', email: null }))
    : (ledger?.contacts ?? []).map((contact) => ({ name: contact.name ?? contact.email ?? '', email: contact.email }));
  return {
    id: note.note_id,
    title: note.title,
    started_at: note.started_at,
    created_at: note.created_at,
    owner_email: note.owner_email,
    attendees,
    web_url: note.web_url,
    imported: ledger
      ? {
        interaction_id: ledger.id,
        meeting_kind: kind,
        lead_id: ledger.lead_id,
        project_id: ledger.project_id,
        subject_title: ledger.subject_title,
        has_transcript: Boolean(ledger.transcript_document_id),
        // Drawn only while the row waits; a filed row has its answer.
        suggestion: kind === 'uncategorized' ? suggestion ?? null : null,
      }
      : null,
  };
}

/**
 * The whole list with Core's answer beside each note: not here yet, here, or
 * here and filed. Served from the index, newest first; Granola is read only
 * when the index is empty (the first open), and otherwise by `refresh`.
 */
export async function granolaNotesPage(env: Env): Promise<GranolaNotesResponse> {
  if (!granolaBridgeEnabled(env)) {
    throw new ControlError('The Granola bridge is not configured.', 503, 'not_configured');
  }
  let index = await readGranolaIndex(env);
  if (index.rows.length === 0) {
    await refreshGranolaIndex(env);
    index = await readGranolaIndex(env);
  }
  const [ledger, suggestions] = await Promise.all([cachedLedger(env), readGranolaSuggestions(env)]);
  const byNote = new Map(ledger.filter((row) => row.granola_note_id).map((row) => [row.granola_note_id!, row]));
  return {
    // A personal note is not the company's: it leaves the list with the mark.
    notes: index.rows
      .filter((row) => !row.personal_at)
      .map((row) => noteRow(row, byNote.get(row.note_id), suggestions.get(row.note_id))),
    cursor: null,
    imported_count: byNote.size,
    indexed_at: index.indexedAt,
  };
}

/** Core's side alone, for the poll: no Granola read. */
export async function granolaLedgerView(env: Env): Promise<GranolaLedgerResponse> {
  if (!granolaBridgeEnabled(env)) {
    throw new ControlError('The Granola bridge is not configured.', 503, 'not_configured');
  }
  const [ledger, suggestions] = await Promise.all([cachedLedger(env), readGranolaSuggestions(env)]);
  const imported: GranolaLedgerResponse['imported'] = {};
  for (const row of ledger) {
    if (!row.granola_note_id) continue;
    const view = noteRow({
      note_id: row.granola_note_id,
      title: row.title,
      started_at: row.occurred_at ?? row.created_at ?? new Date(0).toISOString(),
      created_at: row.created_at ?? new Date(0).toISOString(),
      owner_email: null,
      attendees: [],
      web_url: row.url,
    }, row, suggestions.get(row.granola_note_id)).imported;
    if (view) imported[row.granola_note_id] = view;
  }
  return { imported, imported_count: Object.keys(imported).length };
}

/** Queue the chosen notes through the one mapper. Idempotent: Core upserts on the note id. */
export async function importGranolaNotes(env: Env, noteIds: string[]): Promise<number> {
  if (!granolaBridgeEnabled(env)) {
    throw new ControlError('The Granola bridge is not configured.', 503, 'not_configured');
  }
  const unique = [...new Set(noteIds)];
  for (const noteId of unique) {
    await env.IMPORT_JOBS.send({ kind: 'granola', noteId });
  }
  console.log(JSON.stringify({ level: 'info', message: 'granola.import.queued', notes: unique.length }));
  return unique.length;
}

/**
 * File an imported note: re-read it and write Core with the kind and subject,
 * synchronously, so the list can draw the answer. The transcript document's
 * subject moves with it.
 */
export async function fileGranolaNote(
  env: Env,
  noteId: string,
  filing: GranolaFiling,
): Promise<GranolaCategoryResponse> {
  const written = await ingestGranolaNote(env, noteId, filing);
  if (!written) throw new ControlError('Granola no longer has that note.', 404, 'room_not_found');
  // The person's answer beside the model's, whichever way it went.
  await recordGranolaFilingOutcome(env, noteId, filing);
  const subject = filing.meetingKind === 'lead' && filing.leadId
    ? await fetchCrmSubject(env, 'lead', filing.leadId)
    : filing.meetingKind === 'project' && filing.projectId
      ? await fetchCrmSubject(env, 'project', filing.projectId)
      : filing.meetingKind === 'event' && filing.eventId
        ? await fetchCrmSubject(env, 'event', filing.eventId)
        : filing.meetingKind === 'partner' && filing.partnerOrganizationId
          ? await fetchCrmSubject(env, 'organization', filing.partnerOrganizationId)
          : null;
  return {
    meeting_kind: filing.meetingKind,
    lead_id: filing.leadId,
    project_id: filing.projectId,
    event_id: filing.eventId,
    partner_organization_id: filing.partnerOrganizationId,
    subject_title: subject?.title ?? null,
    categorized_by: filing.categorizedBy,
    categorized_at: Date.now(),
  };
}

// ------------------------------------------------------------------- webhook

/**
 * Standard Webhooks verification (`webhooks.fyi`): the signature covers
 * `<id>.<timestamp>.<raw body>` with the secret's decoded bytes, and the
 * header may carry several space-separated versioned signatures because a
 * secret being rotated is signed with both. One match is a match.
 */
async function assertWebhookSignature(request: Request, secret: string, rawBody: string): Promise<void> {
  const id = request.headers.get('webhook-id') ?? '';
  const timestamp = request.headers.get('webhook-timestamp') ?? '';
  const header = request.headers.get('webhook-signature') ?? '';
  const sentAt = Number(timestamp);
  if (!id || !timestamp || !header || !Number.isFinite(sentAt)) {
    throw new AuthError('Delivery is not signed.', 403, 'owner_auth_required');
  }
  if (Math.abs(Date.now() / 1000 - sentAt) > WEBHOOK_SKEW_SECONDS) {
    throw new AuthError('Signature has expired.', 403, 'owner_auth_required');
  }

  // `whsec_` prefixes a base64 key; without the prefix the secret's own bytes
  // are the key. Both shapes are in the wild, so both are accepted.
  const material = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64Bytes(material);
  } catch {
    keyBytes = new TextEncoder().encode(material);
  }

  const expected = await hmacSHA256Base64(keyBytes, `${id}.${timestamp}.${rawBody}`);
  const offered = header.split(' ')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.includes(',') ? part.slice(part.indexOf(',') + 1) : part));
  // Base64 digests are fixed width, so the length check inside never leaks.
  if (!offered.some((candidate) => constantTimeEqualSync(expected, candidate))) {
    throw new AuthError('Signature does not match.', 403, 'owner_auth_required');
  }
}

export interface GranolaWebhookResponse {
  ok: true;
  queued: boolean;
}

/**
 * The inbound door for Granola, held to the same four locks as
 * `/api/internal/channel-events`: absent secret means the route does not
 * exist, a session token is refused outright, a burst guard, then the
 * signature.
 *
 * The work is enqueued rather than done here. Granola gives a delivery 15
 * seconds and reading a note, its transcript, and writing Core can exceed
 * that — and a timeout would burn one of the four days of retries for work
 * that had actually already started.
 */
export async function handleGranolaWebhook(
  request: Request,
  env: Env,
): Promise<GranolaWebhookResponse> {
  const secret = env.GRANOLA_WEBHOOK_SECRET?.trim();
  if (!secret) throw new ControlError('Not found.', 404, 'room_not_found');
  if (request.headers.get('authorization')) {
    throw new AuthError('This route does not take a session.', 403, 'owner_auth_required');
  }
  await assertUnderRateLimit(env.AGENT_LIMIT, request, 'granola-webhook');

  const rawBody = await readBoundedText(request);
  await assertWebhookSignature(request, secret, rawBody);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody === '' ? '{}' : rawBody) as Record<string, unknown>;
  } catch {
    throw new ControlError('Request body must be valid JSON.', 400, 'invalid_request');
  }

  const type = typeof parsed.type === 'string' ? parsed.type : '';
  const data = parsed.data as Record<string, unknown> | undefined;
  const noteId = typeof data?.note_id === 'string'
    ? data.note_id
    : (typeof parsed.note_id === 'string' ? parsed.note_id : '');

  // `note.access_granted` is somebody sharing a note with us. It is a real
  // event and deliberately ignored: importing a colleague's meeting because
  // they shared it would put their words on our timeline without their asking.
  const wanted = type === 'note.generated' || type === 'note.edited';
  if (!wanted || !noteId || !granolaBridgeEnabled(env)) {
    console.log(JSON.stringify({ level: 'info', message: 'granola.webhook.ignored', type }));
    return { ok: true, queued: false };
  }

  await env.IMPORT_JOBS.send({ kind: 'granola', noteId });
  await touchConnector(env, 'granola', 'webhook');
  console.log(JSON.stringify({ level: 'info', message: 'granola.webhook.queued', type }));
  return { ok: true, queued: true };
}

// ------------------------------------------------------------- proposed leads

/**
 * A company has to have come back. One conversation is not a relationship,
 * and proposing a lead for every single meeting is the "one lead per meeting"
 * outcome this was built to avoid — 96 of them, the first time it ran.
 */
const PROPOSAL_MIN_MEETINGS = 2;

/** "acme-corp.com.br" -> "Acme Corp". Dumb on purpose: the person edits it. */
function nameFromDomain(domain: string): string {
  const stem = domain.split('.')[0] ?? domain;
  return stem
    .split(/[-_]/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ') || domain;
}

/** The guest domain a meeting is with, if exactly one company was in the room. */
function guestDomain(env: Pick<Env, 'IDENTITY_DOMAINS'>, attendees: IndexAttendee[]): string | null {
  const domains = new Map<string, number>();
  for (const person of attendees) {
    const host = person.domain?.trim().toLowerCase();
    if (!host) continue;
    if (isMemberEmail(env, `someone@${host}`)) continue;
    const domain = registrableDomain(host);
    if (!domain || isConsumerDomain(domain)) continue;
    domains.set(domain, (domains.get(domain) ?? 0) + 1);
  }
  if (domains.size === 0) return null;
  return [...domains.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, '');
}

/**
 * The leads the unfiled meetings suggest but Core does not hold.
 *
 * Grouped by the guest email domain, because that is what a company is here:
 * one proposal per company covering every meeting with it, rather than one
 * lead per meeting named after that meeting. Nothing is written — the person
 * confirms a name they can edit, and the existing filing route does the work.
 */
export async function granolaProposals(env: Env): Promise<GranolaProposalsResponse> {
  if (!granolaBridgeEnabled(env)) {
    throw new ControlError('The Granola bridge is not configured.', 503, 'not_configured');
  }
  const [index, ledger, suggestions] = await Promise.all([
    readGranolaIndex(env),
    cachedLedger(env),
    readGranolaSuggestions(env),
  ]);
  const filed = new Map(ledger.filter((row) => row.granola_note_id).map((row) => [row.granola_note_id!, row]));

  // Only the rows the model is sure about but could not place: a confident
  // lead or project answer with no subject named.
  const clusters = new Map<string, { domain: string; organizationId: string | null; meetings: GranolaProposal['meetings'] }>();
  for (const row of index.rows) {
    if (row.personal_at) continue;
    const crm = filed.get(row.note_id);
    if (!crm || (crm.meeting_kind && crm.meeting_kind !== 'uncategorized')) continue;
    const suggestion = suggestions.get(row.note_id);
    if (!suggestion) continue;
    if (suggestion.meeting_kind !== 'lead' && suggestion.meeting_kind !== 'project') continue;
    if (suggestion.lead_id || suggestion.project_id) continue;
    const domain = guestDomain(env, row.attendees);
    if (!domain) continue;
    const cluster = clusters.get(domain) ?? { domain, organizationId: null, meetings: [] };
    cluster.organizationId = cluster.organizationId ?? suggestion.organization_id ?? crm.organization_id ?? null;
    cluster.meetings.push({
      note_id: row.note_id,
      title: row.title,
      started_at: row.started_at,
      meeting_kind: suggestion.meeting_kind,
    });
    clusters.set(domain, cluster);
  }
  if (clusters.size === 0) return { proposals: [] };

  // Does Core already hold something this belongs on? Then it is not a new
  // lead — it is an option the model was never shown.
  const [leads, projects, partners] = await Promise.all([
    fetchCrmSubjects(env, 'lead', '').catch(() => ({ subjects: [] as CrmSubject[] })),
    fetchCrmSubjects(env, 'project', '').catch(() => ({ subjects: [] as CrmSubject[] })),
    fetchCrmSubjects(env, 'organization', '').catch(() => ({ subjects: [] as CrmSubject[] })),
  ]);
  const byName = new Map<string, { kind: 'lead' | 'project' | 'organization'; id: string; title: string }>();
  // Partners first: a project or lead of the same name is the likelier home and overwrites it.
  for (const subject of partners.subjects) byName.set(normalizedName(subject.title), { kind: 'organization', id: subject.id, title: subject.title });
  for (const subject of projects.subjects) byName.set(normalizedName(subject.title), { kind: 'project', id: subject.id, title: subject.title });
  for (const subject of leads.subjects) byName.set(normalizedName(subject.title), { kind: 'lead', id: subject.id, title: subject.title });

  const proposals = [...clusters.values()]
    .filter((cluster) => cluster.meetings.length >= PROPOSAL_MIN_MEETINGS)
    .map((cluster) => {
      const name = nameFromDomain(cluster.domain);
      const key = normalizedName(name);
      const existing = byName.get(key)
        ?? [...byName.entries()].find(([subjectName]) => subjectName.includes(key) && key.length >= 4)?.[1]
        ?? null;
      return {
        domain: cluster.domain,
        name,
        organization_id: cluster.organizationId,
        meetings: cluster.meetings.sort((a, b) => b.started_at.localeCompare(a.started_at)),
        existing,
      };
    })
    // Core refuses a lead with no organization, and creating organizations is
    // not this feature's job: a cluster Core cannot place stays in the queue.
    .filter((proposal) => proposal.existing !== null || proposal.organization_id !== null)
    .sort((a, b) => b.meetings.length - a.meetings.length);
  return { proposals };
}

// ------------------------------------------------------------------ backfill

/**
 * One page of history: enqueue every note on it, then enqueue the next page.
 *
 * Self-continuing rather than a single long walk, so two years fit inside a
 * Worker's limits, a failed page retries alone, and the whole import can be
 * watched (and stopped) as queue depth rather than as one opaque request.
 */
export async function processGranolaPage(env: Env, job: {
  cursor?: string | undefined;
  createdAfter?: string | undefined;
  createdBefore?: string | undefined;
}): Promise<number> {
  const page = await listGranolaNotes(env, {
    createdAfter: job.createdAfter,
    createdBefore: job.createdBefore,
    cursor: job.cursor,
  });
  for (const note of page.notes) {
    await env.IMPORT_JOBS.send({ kind: 'granola', noteId: note.id });
  }
  if (page.cursor) {
    await env.IMPORT_JOBS.send({
      kind: 'granola-page',
      cursor: page.cursor,
      createdAfter: job.createdAfter,
      createdBefore: job.createdBefore,
    });
  }
  console.log(JSON.stringify({
    level: 'info',
    message: 'granola.backfill.page',
    notes: page.notes.length,
    more: Boolean(page.cursor),
  }));
  return page.notes.length;
}

/** Kick off a bounded historical import. `months` counts back from now. */
export async function startGranolaBackfill(env: Env, months: number): Promise<{ from: string }> {
  if (!granolaBridgeEnabled(env)) {
    throw new ControlError('The Granola bridge is not configured.', 503, 'not_configured');
  }
  const from = new Date();
  from.setUTCMonth(from.getUTCMonth() - Math.max(1, Math.min(months, 120)));
  const createdAfter = from.toISOString();
  // The run's start, so the card can count how far it has walked: every note
  // the queue reads re-stamps `seen_at` on its index row, so "read since the
  // run began" is the progress, with no counter to keep.
  await touchConnector(env, 'granola', 'run');
  await env.IMPORT_JOBS.send({ kind: 'granola-page', createdAfter });
  console.log(JSON.stringify({ level: 'info', message: 'granola.backfill.started', createdAfter }));
  return { from: createdAfter };
}

// ---------------------------------------------------------------- connectors

/**
 * Where every outside source stands, for `/connectors`. Granola is the one
 * connector today; the shape is per connector so the next one (Slack) draws
 * the same card. An unconfigured bridge answers zeros, not an error — the
 * card says so.
 */
/** How long after the last note read a run still counts as walking. */
const RUN_IDLE_MS = 180_000;

/**
 * How far a history import has walked, from what the index already records:
 * a note stamps `ingested_at` once Core has taken it, so the notes stamped
 * since the run began are the ones done. Null when no run was started, or
 * when nothing has landed for a few minutes — the queue announces no ending,
 * so silence is the ending.
 */
async function granolaRun(env: Env, startedAt: number | undefined): Promise<ConnectorStatus['run']> {
  if (!startedAt) return null;
  try {
    const row = await env.USAGE.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN ingested_at >= ?1 THEN 1 ELSE 0 END) AS done,
              MAX(CASE WHEN ingested_at >= ?1 THEN ingested_at END) AS last_note_at
         FROM granola_notes`,
    ).bind(startedAt).first<{ total: number; done: number | null; last_note_at: number | null }>();
    if (!row) return null;
    const lastNoteAt = row.last_note_at ?? null;
    const quiet = Date.now() - (lastNoteAt ?? startedAt) > RUN_IDLE_MS;
    if (quiet) return null;
    return { started_at: startedAt, done: row.done ?? 0, total: row.total, last_note_at: lastNoteAt };
  } catch {
    // The card loses a progress bar, never its counts.
    return null;
  }
}

export async function connectorsStatus(env: Env): Promise<ConnectorsResponse> {
  if (!usesCore(env)) return { connectors: [] };
  const configured = granolaBridgeEnabled(env);
  const [ledger, suggestions, counts, pulse] = await Promise.all([
    configured ? cachedLedger(env).catch(() => [] as CrmLedgerRow[]) : Promise.resolve([] as CrmLedgerRow[]),
    readGranolaSuggestions(env),
    granolaSuggestionCounts(env),
    connectorPulse(env, 'granola'),
  ]);
  const unfiledRows = ledger.filter((row) => !row.meeting_kind || row.meeting_kind === 'uncategorized');
  return {
    connectors: [{
      id: 'granola',
      configured,
      imported: ledger.length,
      unfiled: unfiledRows.length,
      suggested: unfiledRows.filter((row) => row.granola_note_id && suggestions.has(row.granola_note_id)).length,
      accepted: counts.accepted,
      corrected: counts.corrected,
      suggesting: granolaSuggestEnabled(env),
      last_webhook_at: pulse.webhook ?? null,
      last_import_at: pulse.import ?? null,
      run: await granolaRun(env, pulse.run),
    }],
  };
}
