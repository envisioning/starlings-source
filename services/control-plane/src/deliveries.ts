// What each destination still owes a meeting (migration 0041).
//
// The room's Durable Object is the record; Docs and Core are copies of it.
// A copy is asked for by writing a ledger row *before* anything is sent —
// `requested_revision` is the room's revision at that moment — and it is
// confirmed by `delivered_revision` catching up. Everything between is
// retry: the queue's, the cron sweep's, or an operator's. A delivery reads
// the room fresh, so a late retry carries the newest text, and it confirms
// only the revision it read; a change that landed while it was out leaves
// the row due, and the next attempt carries that too. That is what makes a
// retry unable to overwrite a newer correction.
//
// `docs` is the full transcript as one document, owed whenever there is
// text or a document to retire. `core` is the meeting log, owed once the
// meeting is filed or was hosted. The name is the ledger's, not the host's:
// on a D1 workspace the meeting log is the workspace's own interaction row
// (`postMeetingLog` → work-d1.ts, docs/WORKSPACE_STORE.md slice 6), so it is
// owed and confirmed the same way, and a row marked delivered is in D1. `proposals` are the notes' action items
// as `proposed` tasks on the subject, owed while any is unfiled
// and the meeting has a lead or project to file under. Nothing here holds
// transcript text: the ledger has revisions, counts and one error message.

import { isMemberEmail } from './workspace-identity';
import { mcpMeetingArtifactResponseSchema, type McpMeetingArtifactResponse, type MeetingActionItem, type MeetingDelivery, type MeetingDeliveryDestination } from '@starlings/contracts';
import { createCrmTask, postMeetingLog, buildMeetingLogPayload, workModelEnabled } from './crm';
import { archiveDocsDocument, docsDocumentURL, docsEnabled, fileTranscript } from './docs';
import { workspacePublicOrigin } from './workspace-origins';
import type { MeetingLogMaterial, MeetingLogParticipant, RoomCoordinator } from './room-coordinator';
import { roomStub } from './do-jurisdiction';
import { ControlError } from './errors';

/**
 * A row the queue has not confirmed in this long is re-enqueued by the sweep.
 * Each failed attempt doubles the wait, up to `1 << SWEEP_BACKOFF_STEPS`
 * times this (about 21 hours): a destination that refuses one meeting for
 * weeks is asked once a day, not every ten minutes.
 */
export const DELIVERY_STALE_MS = 10 * 60 * 1_000;
const SWEEP_BACKOFF_STEPS = 7;
/** How many rows one sweep re-enqueues; the next sweep takes the rest. */
const SWEEP_BATCH = 50;
/** One delivery at a time per meeting; a holder that died lets go after this. */
const LEASE_MS = 90 * 1_000;

interface Row {
  meeting_id: string;
  room_slug: string;
  destination: MeetingDeliveryDestination;
  requested_revision: number;
  delivered_revision: number;
  attempts: number;
  last_error: string | null;
  requested_at: number;
  delivered_at: number | null;
  updated_at: number;
  leased_until: number | null;
}

/** The compact, structured MCP projection of a finalized room record. */
export function mcpMeetingArtifact(material: MeetingLogMaterial): McpMeetingArtifactResponse {
  if (material.endedAt === null) throw new Error('A live meeting has no finalized artifact.');
  const subjectDoor = material.meetingKind === 'project' && material.projectId
    ? `subject:project:${material.projectId}`
    : material.meetingKind === 'lead' && material.leadId
      ? `subject:lead:${material.leadId}`
      : material.meetingKind === 'partner' && material.partnerOrganizationId
        ? `subject:organization:${material.partnerOrganizationId}`
        : null;
  return mcpMeetingArtifactResponseSchema.parse({
    summary: material.summary,
    action_items: material.actionItems.map((item) => ({
      text: item.what,
      owner_hint: item.who,
      ...(item.task_id ? { task_id: item.task_id, door: `task:${item.task_id}` } : {}),
    })),
    decisions: material.decisionCandidates.filter((item) => !item.dismissed).map((item) => ({
      text: item.what,
      ...(item.decision_id ? { decision_id: item.decision_id } : {}),
      ...(item.decision_id && subjectDoor ? { door: subjectDoor } : {}),
    })),
    open_questions: material.openQuestions ?? openQuestions(material.summary),
    attendees: material.participants.map((participant) => ({
      name: participant.name,
      ...(participant.email ? { email: participant.email } : {}),
      kind: participant.kind,
    })),
    subject: subjectDoor ? { door: subjectDoor } : null,
    started_at: material.startedAt,
    ended_at: material.endedAt,
    transcript: { segments: material.transcript },
  });
}

function openQuestions(markdown: string | null): string[] {
  if (!markdown) return [];
  const lines = markdown.split('\n');
  const isOpenQuestionsHeading = (line: string) => {
    const heading = line.trim().replace(/^#{1,6}\s*/u, '').replace(/\s*#+$/u, '').trim()
      .normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
    return ['open questions', 'questoes em aberto', 'questoes abertas', 'offene fragen'].includes(heading);
  };
  const start = lines.findIndex(isOpenQuestionsHeading);
  if (start === -1) return [];
  const questions: string[] = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (/^#{1,6}\s/u.test(line)) break;
    const text = line.replace(/^(?:[-*+]|\d+[.)])\s+/u, '').trim();
    if (!text || /^(none|nenhum|nenhuma|keine)\.?$/iu.test(text)) continue;
    questions.push(text);
  }
  return questions;
}

/**
 * The people outside the workspace on a call: anyone not a member
 * by address, agents aside. A guest who gave no address is outside too, by
 * name; only those with an address can be written to.
 */
export function outsideAttendees(
  env: Pick<Env, 'IDENTITY_DOMAINS'>,
  participants: MeetingLogParticipant[],
): MeetingLogParticipant[] {
  return participants.filter((person) => person.kind !== 'agent' && !(person.email && isMemberEmail(env, person.email)));
}

/** Ambient captures reach Core only once a person files them (docs/AMBIENT_CAPTURE.md). */
export function heldForFiling(material: Pick<MeetingLogMaterial, 'captureKind' | 'meetingKind'>): boolean {
  return material.captureKind === 'ambient' && material.meetingKind === 'uncategorized';
}

/** Which destinations this meeting is owed to, as it stands now. */
export function destinationsOwed(env: Env, material: MeetingLogMaterial): MeetingDeliveryDestination[] {
  const owed: MeetingDeliveryDestination[] = [];
  if (docsEnabled(env) && (material.transcript.length > 0 || material.transcriptDocumentId)) owed.push('docs');
  if (workModelEnabled(env) && !heldForFiling(material)) owed.push('core');
  // Proposals ride behind the meeting log: a status meeting's rows point at
  // the meeting, which Core knows only once the log has landed.
  if (workModelEnabled(env) && !heldForFiling(material) && proposalSubject(material) && material.actionItems.some((item) => !item.task_id)) owed.push('proposals');
  // The follow-up waits for its host behind the proposals it lists.
  if (workModelEnabled(env) && followUpSubject(material) && followUpOpen(material) && outsideRecipients(env, material).length > 0) owed.push('followup');
  return owed;
}

/** A follow-up goes to a lead, project or partner: never a status or internal call, never an unfiled one. */
export function followUpSubject(material: Pick<MeetingLogMaterial, 'meetingKind' | 'leadId' | 'projectId' | 'partnerOrganizationId' | 'subjectTitle' | 'captureKind'>):
  { kind: 'lead' | 'project' | 'organization'; id: string; title: string } | null {
  if (heldForFiling(material as MeetingLogMaterial)) return null;
  const title = material.subjectTitle?.trim() || 'Untitled';
  if (material.meetingKind === 'lead' && material.leadId) return { kind: 'lead', id: material.leadId, title };
  if (material.meetingKind === 'project' && material.projectId) return { kind: 'project', id: material.projectId, title };
  if (material.meetingKind === 'partner' && material.partnerOrganizationId) return { kind: 'organization', id: material.partnerOrganizationId, title };
  return null;
}

function followUpOpen(material: Pick<MeetingLogMaterial, 'followUp'>): boolean {
  return Boolean(material.followUp && !material.followUp.approvedAt && !material.followUp.dismissedAt);
}

/** Outside attendees who joined with an address: who the follow-up is written to. */
export function outsideRecipients(env: Pick<Env, 'IDENTITY_DOMAINS'>, material: Pick<MeetingLogMaterial, 'participants'>): Array<{ name: string; email: string }> {
  const seen = new Set<string>();
  const out: Array<{ name: string; email: string }> = [];
  for (const person of outsideAttendees(env, material.participants)) {
    const email = person.email.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({ name: person.name.trim() || email, email });
  }
  return out;
}

/** A follow-up waits a week for its host, then leaves INBOX unanswered. */
export const FOLLOW_UP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The follow-up's INBOX pointer: one row per meeting, written once.
 * A later draft of the same meeting reuses it; the host's answer is on it.
 */
async function deliverFollowUp(env: Env, material: MeetingLogMaterial): Promise<void> {
  const subject = followUpSubject(material);
  if (!subject || !followUpOpen(material)) return;
  const now = Date.now();
  await env.USAGE.prepare(
    `INSERT INTO meeting_follow_ups (meeting_id, room_slug, host_email, subject_kind, subject_id, subject_title, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT (meeting_id) DO UPDATE SET subject_kind = excluded.subject_kind, subject_id = excluded.subject_id, subject_title = excluded.subject_title`,
  ).bind(material.meetingId, material.roomSlug, material.ownerEmail.trim().toLowerCase(), subject.kind, subject.id, subject.title.slice(0, 200), now, now + FOLLOW_UP_WINDOW_MS).run();
}

/**
 * Where a proposal is filed: the lead, project or partner the meeting is about, or —
 * for a status or internal meeting, which has neither — the meeting itself
 * (Core's `meeting_id` subject; anyone moves the task on from
 * there). An uncategorized meeting is nobody's yet and files nothing.
 */
export function proposalSubject(
  material: Pick<MeetingLogMaterial, 'meetingKind' | 'leadId' | 'projectId' | 'partnerOrganizationId' | 'meetingId'>,
): { lead_id: string } | { project_id: string } | { organization_id: string } | { meeting_id: string } | null {
  if (material.meetingKind === 'lead' && material.leadId) return { lead_id: material.leadId };
  if (material.meetingKind === 'project' && material.projectId) return { project_id: material.projectId };
  if (material.meetingKind === 'partner' && material.partnerOrganizationId) return { organization_id: material.partnerOrganizationId };
  if (material.meetingKind === 'status' || material.meetingKind === 'internal') return { meeting_id: material.meetingId };
  return null;
}

/**
 * Ask for delivery: the rows first, then the queue, then one inline try when
 * the queue would not take it. The rows are what survive; the rest is speed.
 */
export async function requestDelivery(
  env: Env,
  roomSlug: string,
  meetingId: string,
  options: { inline?: boolean } = {},
): Promise<MeetingDeliveryDestination[]> {
  const room = await roomStub(env, roomSlug);
  const material = await room.meetingLogMaterial(meetingId);
  const owed = destinationsOwed(env, material);
  if (owed.length === 0) return owed;
  await upsertRequested(env, roomSlug, meetingId, owed, material.revision);

  if (options.inline) {
    await deliverMeeting(env, roomSlug, meetingId);
    return owed;
  }
  try {
    await env.ARTIFACT_JOBS.send({ roomSlug, meetingId, kind: 'deliver' });
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'delivery.enqueue.failed',
      meetingId,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    // The rows are written: a failure here is one more retry, not a loss.
    try {
      await deliverMeeting(env, roomSlug, meetingId);
    } catch {
      // Logged inside; the sweep picks the rows up.
    }
  }
  return owed;
}

/** The rows: asked for at `revision`, or moved up to it when already there. */
async function upsertRequested(env: Env, roomSlug: string, meetingId: string, destinations: MeetingDeliveryDestination[], revision: number): Promise<void> {
  const now = Date.now();
  const statement = env.USAGE.prepare(`
    INSERT INTO meeting_deliveries
      (meeting_id, room_slug, destination, requested_revision, delivered_revision, attempts, last_error, requested_at, delivered_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, 0, 0, NULL, ?5, NULL, ?5)
    ON CONFLICT(meeting_id, destination) DO UPDATE SET
      requested_revision = MAX(requested_revision, excluded.requested_revision),
      requested_at = excluded.requested_at,
      updated_at = excluded.updated_at
  `);
  await env.USAGE.batch(destinations.map((destination) => statement.bind(meetingId, roomSlug, destination, revision, now)));
}

/**
 * Deliver every due row of one meeting, each destination on its own, and
 * throw at the end when any is still due — so a queue message retries and
 * a partial success is kept as such. Reads the room once per destination
 * after the last write, so what goes out is what is there now.
 */
export async function deliverMeeting(env: Env, roomSlug: string, meetingId: string): Promise<{ delivered: MeetingDeliveryDestination[]; failed: MeetingDeliveryDestination[]; busy: boolean }> {
  const room = await roomStub(env, roomSlug);
  // One at a time per meeting: two deliveries reading "no document yet"
  // together would file two. A holder that died lets go after the lease;
  // a meeting somebody else holds is left to them and to the sweep.
  const now = Date.now();
  const lease = await env.USAGE.prepare(
    `UPDATE meeting_deliveries SET leased_until = ?2
      WHERE meeting_id = ?1 AND requested_revision > delivered_revision
        AND NOT EXISTS (SELECT 1 FROM meeting_deliveries l WHERE l.meeting_id = ?1 AND l.leased_until > ?3)`,
  ).bind(meetingId, now + LEASE_MS, now).run();
  const due = await dueRows(env, meetingId);
  if ((lease.meta.changes ?? 0) === 0) {
    if (due.length > 0) console.log(JSON.stringify({ level: 'info', message: 'delivery.busy', meetingId }));
    return { delivered: [], failed: [], busy: due.length > 0 };
  }
  const delivered: MeetingDeliveryDestination[] = [];
  const failed: MeetingDeliveryDestination[] = [];
  const refused: MeetingDeliveryDestination[] = [];
  try {
    // Docs before Core: Core's row points at the document, and a Docs
    // delivery that changed the link makes Core due again — read afresh.
    // Proposals last: they need the meeting link Core's row already has.
    for (const destination of ['docs', 'core', 'proposals', 'followup'] as const) {
      const owed = (destination === 'docs' ? due : await dueRows(env, meetingId)).some((entry) => entry.destination === destination);
      if (!owed) continue;
      // Core and proposals stay owed while sync is off on a Core workspace,
      // and are never sent: the kill switch stops here. A D1 workspace
      // always has its work store, so nothing stops there.
      if (destination !== 'docs' && !workModelEnabled(env)) continue;
      const material = await room.meetingLogMaterial(meetingId);
      try {
        // What was read, plus the link this delivery itself wrote: that is
        // the revision the destination now holds. A change that landed
        // meanwhile is past it, keeps the row due, and the next attempt
        // carries it.
        const carried = destination === 'docs'
          ? (await deliverDocs(env, room, material)) ?? material.revision
          : destination === 'core'
            ? (await deliverCore(env, material), material.revision)
            : destination === 'proposals'
              ? (await deliverProposals(env, room, material), material.revision)
              : (await deliverFollowUp(env, material), material.revision);
        const after = await room.meetingLogMaterial(meetingId);
        await confirm(env, meetingId, destination, carried, after.revision);
        delivered.push(destination);
      } catch (error) {
        await fail(env, meetingId, destination, error);
        failed.push(destination);
        if (refusal(error)) refused.push(destination);
      }
    }
  } finally {
    await env.USAGE.prepare('UPDATE meeting_deliveries SET leased_until = NULL WHERE meeting_id = ?1').bind(meetingId).run();
  }
  console.log(JSON.stringify({
    level: failed.length > 0 ? 'warn' : 'info',
    message: failed.length > 0 ? 'delivery.partial' : 'delivery.done',
    meetingId,
    roomSlug,
    delivered,
    failed,
  }));
  // A refusal stays owed on its row, but the queue does not retry it: the
  // same body gets the same answer, and three retries and a dead job per
  // sweep mailed the alert address about one meeting for weeks.
  if (failed.length > refused.length) {
    throw new Error(`Delivery still owed to ${failed.join(', ')} for meeting ${meetingId}.`);
  }
  return { delivered, failed, busy: false };
}

/**
 * The transcript document: written whole, or archived when every line was
 * struck — a document that still shows deleted lines is worse
 * than none. The notes are not touched here; `notes_stale` on the view
 * says when they predate the transcript they came from.
 */
async function deliverDocs(env: Env, room: DurableObjectStub<RoomCoordinator>, material: MeetingLogMaterial): Promise<number | null> {
  if (material.transcript.length === 0) {
    if (!material.transcriptDocumentId) return null;
    await archiveDocsDocument(env, material.ownerEmail, material.transcriptDocumentId, 'Every line was deleted in Starlings');
    const revision = await room.clearTranscriptDocument(material.meetingId);
    // Core's row points at a document that is gone now.
    if (workModelEnabled(env) && !heldForFiling(material)) await upsertRequested(env, material.roomSlug, material.meetingId, ['core'], revision);
    return revision;
  }
  const filed = await fileTranscript(env, material);
  if (filed.id === material.transcriptDocumentId && filed.path === material.transcriptDocumentPath) return null;
  const revision = await room.setTranscriptDocument(material.meetingId, filed.id, filed.path);
  // A first filing, or a re-filing under a new id: Core has the wrong link.
  if (workModelEnabled(env) && !heldForFiling(material)) await upsertRequested(env, material.roomSlug, material.meetingId, ['core'], revision);
  return revision;
}

/**
 * Each unfiled action item as one `proposed` task on the subject,
 * the way Core-proposed offers arrive: Accept or Decline in Work.
 * The id goes back on the room's item at once, so a retry after a lost
 * answer proposes the rest, never this one again. The owner name, the
 * deadline as said, the quote and the meeting link go into the task's
 * notes; `responsible_party` is the side the speaker was on, and no
 * `assigned_to` or `due_date` — the person accepting sets those.
 */
async function deliverProposals(env: Env, room: DurableObjectStub<RoomCoordinator>, material: MeetingLogMaterial): Promise<void> {
  const subject = proposalSubject(material);
  if (!subject) return;
  // A row Core refuses stays owed; the sweep tries again.
  const link = meetingLink(env, material);
  for (const [index, item] of material.actionItems.entries()) {
    if (item.task_id) continue;
    const task = await createCrmTask(env, {
      title: item.what.slice(0, 200),
      status: 'proposed',
      responsible_party: sideOf(env, item, material.participants),
      notes: proposalNotes(item, material, link),
      ...subject,
    });
    await room.markActionItemFiled(material.meetingId, index, task.id);
  }
}

/** The transcript page on the web: where an accepted task points back to. */
function meetingLink(env: Env, material: MeetingLogMaterial): string {
  return `${env.WEB_ORIGIN}/meetings/${encodeURIComponent(material.roomSlug)}/${material.meetingId}`;
}

function proposalNotes(item: MeetingActionItem, material: MeetingLogMaterial, link: string): string {
  const said = item.quote ? `“${item.quote}”` : null;
  const at = item.at_ms !== null ? `at ${clock(item.at_ms)}` : null;
  return [
    item.who ? `Owner as said: ${item.who}` : 'Owner: not named',
    item.by_when ? `By: ${item.by_when}` : null,
    said || at ? [said, at].filter(Boolean).join(' ') : null,
    `Meeting: ${material.title?.trim() || 'Untitled'} — ${link}`,
  ].filter((line): line is string => line !== null).join('\n');
}

/**
 * Team when the named person is on the roster with a member address,
 * client when they are on it with another, unassigned when nobody was
 * named or the name matches nobody. A first name matches its roster entry.
 */
export function sideOf(
  env: Pick<Env, 'IDENTITY_DOMAINS'>,
  item: Pick<MeetingActionItem, 'who'>,
  participants: MeetingLogParticipant[],
): 'team' | 'client' | 'unassigned' {
  const who = item.who?.trim().toLowerCase();
  if (!who) return 'unassigned';
  const match = participants.find((person) => {
    const name = person.name.trim().toLowerCase();
    return name === who || name.split(/\s+/u)[0] === who || who.split(/\s+/u)[0] === name.split(/\s+/u)[0];
  });
  if (!match) return 'unassigned';
  return match.email && isMemberEmail(env, match.email) ? 'team' : 'client';
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

async function deliverCore(env: Env, material: MeetingLogMaterial): Promise<void> {
  const transcriptURL = material.transcriptDocumentPath ? docsDocumentURL(env, material.transcriptDocumentPath) : null;
  await postMeetingLog(env, buildMeetingLogPayload(material, 'ended', { publicOrigin: workspacePublicOrigin(env), transcriptURL }));
  console.log(JSON.stringify({
    level: 'info',
    message: 'crm.meeting-log.sent',
    meetingId: material.meetingId,
    roomSlug: material.roomSlug,
    phase: 'ended',
    participantCount: material.participants.length,
    transcriptSegmentCount: material.transcript.length,
    transcriptFiled: transcriptURL !== null,
  }));
}

async function confirm(env: Env, meetingId: string, destination: MeetingDeliveryDestination, revision: number, current: number): Promise<void> {
  const now = Date.now();
  await env.USAGE.prepare(
    `UPDATE meeting_deliveries
        SET delivered_revision = MAX(delivered_revision, ?3),
            requested_revision = MAX(requested_revision, ?4),
            attempts = attempts + 1, last_error = NULL, delivered_at = ?5, updated_at = ?5
      WHERE meeting_id = ?1 AND destination = ?2`,
  ).bind(meetingId, destination, revision, current, now).run();
}

/** A 4xx a retry cannot change. Busy, timeout and conflict can change. */
function refusal(error: unknown): boolean {
  return error instanceof ControlError && error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status);
}

async function fail(env: Env, meetingId: string, destination: MeetingDeliveryDestination, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : 'Unknown error').slice(0, 500);
  await env.USAGE.prepare(
    `UPDATE meeting_deliveries
        SET attempts = attempts + 1, last_error = ?3, updated_at = ?4
      WHERE meeting_id = ?1 AND destination = ?2`,
  ).bind(meetingId, destination, message, Date.now()).run();
  console.warn(JSON.stringify({ level: 'warn', message: `delivery.${destination}.failed`, meetingId, error: message }));
}

async function dueRows(env: Env, meetingId: string): Promise<Row[]> {
  const { results } = await env.USAGE.prepare(
    'SELECT * FROM meeting_deliveries WHERE meeting_id = ?1 AND requested_revision > delivered_revision',
  ).bind(meetingId).all<Row>();
  return results;
}

/** One meeting's rows, for the transcript view. */
export async function deliveriesOf(env: Env, meetingId: string): Promise<MeetingDelivery[]> {
  const { results } = await env.USAGE.prepare(
    'SELECT * FROM meeting_deliveries WHERE meeting_id = ?1 ORDER BY destination',
  ).bind(meetingId).all<Row>();
  return results.map(wire);
}

/** Everything still due, oldest first — the operator's list. */
export async function listDueDeliveries(env: Env, limit = 200): Promise<MeetingDelivery[]> {
  const { results } = await env.USAGE.prepare(
    'SELECT * FROM meeting_deliveries WHERE requested_revision > delivered_revision ORDER BY updated_at ASC LIMIT ?1',
  ).bind(limit).all<Row>();
  return results.map(wire);
}

/**
 * Rows the queue has gone quiet on — an enqueue that failed and the inline
 * try too, a message the dead queue swallowed, a Worker that died mid-way —
 * sent again. Counts and the oldest age are logged; never text.
 */
export async function sweepDeliveries(env: Env, now = Date.now(), staleMs = DELIVERY_STALE_MS): Promise<{ requeued: number; oldestMs: number | null }> {
  const { results } = await env.USAGE.prepare(
    `SELECT meeting_id, room_slug, MIN(updated_at) AS updated_at FROM meeting_deliveries
      WHERE requested_revision > delivered_revision AND updated_at < ?1 - ?3 * (1 << MIN(attempts, ?4))
      GROUP BY meeting_id, room_slug ORDER BY updated_at ASC LIMIT ?2`,
  ).bind(now, SWEEP_BATCH, staleMs, SWEEP_BACKOFF_STEPS).all<{ meeting_id: string; room_slug: string; updated_at: number }>();
  if (results.length === 0) return { requeued: 0, oldestMs: null };
  await env.ARTIFACT_JOBS.sendBatch(results.map((row) => ({ body: { roomSlug: row.room_slug, meetingId: row.meeting_id, kind: 'deliver' as const } })));
  // Touched, so the next sweep does not send the same rows before the queue had its turn.
  const touch = env.USAGE.prepare('UPDATE meeting_deliveries SET updated_at = ?2 WHERE meeting_id = ?1 AND requested_revision > delivered_revision');
  await env.USAGE.batch(results.map((row) => touch.bind(row.meeting_id, now)));
  const oldestMs = now - results[0]!.updated_at;
  console.log(JSON.stringify({ level: 'info', message: 'delivery.sweep', requeued: results.length, oldestMs }));
  return { requeued: results.length, oldestMs };
}

function wire(row: Row): MeetingDelivery {
  return {
    meeting_id: row.meeting_id,
    room_slug: row.room_slug,
    destination: row.destination,
    status: row.delivered_revision >= row.requested_revision ? 'delivered' : row.last_error ? 'failed' : 'pending',
    requested_revision: row.requested_revision,
    delivered_revision: row.delivered_revision,
    attempts: row.attempts,
    last_error: row.last_error,
    requested_at: row.requested_at,
    delivered_at: row.delivered_at,
    updated_at: row.updated_at,
  };
}
