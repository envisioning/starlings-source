import type { ArtifactJob } from './contracts';
import { deliverMeeting, outsideAttendees, requestDelivery } from './deliveries';
import { knownRoomSlugs } from './internal-rooms';
import { archiveDocsDocument, docsEnabled } from './docs';
import { backfillLedgerFromRooms, forgetMeetingRecord, recordMeetingRecord, recordUsageEvent } from './ledger';
import { MIN_MEETING_MILLISECONDS } from './contracts';
import { ControlError } from './errors';
import type { ArtifactMaterial } from './room-coordinator';
import { postSubjectEvent, subjectOfCategory } from './threads';
import { claudeNotes, parseActionItems } from './notes';
import { recordFailure } from './ops';
import { estimateTokens, recordModelUsage, workersAIText } from './model-usage';
import { markNotesDone } from './notes-owed';
import type { MeetingActionItem, MeetingDecisionCandidate, MeetingFollowUpDraft } from '@starlings/contracts';
import { roomStub } from './do-jurisdiction';
import { fallbackSummary } from './meeting-fallback';
import { dispatchMeetingAgent } from './meeting-agent-dispatch';
import { settleMeetingAgentCommit } from './meeting-agent-tools';

export async function processArtifactJob(job: ArtifactJob, env: Env): Promise<void> {
  // `crm` is the old name of the same job, still in flight or in the dead
  // queue from before the ledger: it asks for delivery the new
  // way and drains it.
  if (job.kind === 'regenerate') {
    await regenerateNotes(env, job.roomSlug, job.meetingId);
    return;
  }
  if (job.kind === 'deliver' || job.kind === 'crm') {
    if (job.kind === 'crm') await requestDelivery(env, job.roomSlug, job.meetingId, { inline: true });
    else await deliverMeeting(env, job.roomSlug, job.meetingId);
    return;
  }
  const room = await roomStub(env, job.roomSlug);
  let artifact = await room.artifactForProcessing(job.meetingId);
  // Under five minutes is not a meeting: no notes, no transcript document, no
  // ledger row, no CRM write. The room marks it discarded and that is all.
  if (artifact.summary === null && isTooShort(artifact)) {
    await room.discardMeeting(job.meetingId);
    await forgetMeetingRecord(env, job.meetingId);
    // Nothing is owed for a meeting that was not one.
    await markNotesDone(env, job.roomSlug, job.meetingId);
    console.info(JSON.stringify({ level: 'info', message: 'artifact.discarded.short', meetingId: job.meetingId, ms: (artifact.endedAt ?? 0) - artifact.startedAt }));
    return;
  }
  // Exactly one engine per meeting: a managed installation never falls through
  // to the legacy model. The normal queue owns retries of the same durable run.
  if (artifact.summary === null && await dispatchMeetingAgent(env, job.roomSlug, job.meetingId)) {
    artifact = await room.artifactForProcessing(job.meetingId);
  }
  for (const pending of await room.pendingMeetingAgentDeliveries()) {
    if (pending.meeting_id === job.meetingId) await settleMeetingAgentCommit(env, job.roomSlug, pending.run_id);
  }
  if (artifact.summary !== null) {
    // A run after the summary was written (a retry, or the owed-notes
    // sweep): the notes exist, so the row closes here.
    await markNotesDone(env, job.roomSlug, job.meetingId);
  } else {
    const generated = await summarize(artifact, env, await outsideNames(env, room, job.meetingId));
    await room.setSummary(job.meetingId, generated.title, generated.summary, generated.actionItems, generated.decisionCandidates, generated.model, generated.followUp);
    // The notes exist: the meeting is no longer owed them.
    await markNotesDone(env, job.roomSlug, job.meetingId);
    artifact = await room.artifactForProcessing(job.meetingId);
    // The meeting's trail in its subject's channel: notes exist now. Only on
    // the run that wrote them — a retried job must not say so twice. The
    // title alone crosses; never a line of the summary.
    const filedUnder = subjectOfCategory(await room.meetingCategory(job.meetingId));
    if (filedUnder) {
      await postSubjectEvent(
        env,
        filedUnder,
        `Notes filed: ${generated.title}`,
        [{ kind: 'meeting', id: job.meetingId }],
      );
    }
  }

  // The account ledger's copy of this meeting, written once everything that
  // could change it has happened: the summary exists or does not. Best-effort
  // and last-but-one — a ledger row is worth less than the artifact this job
  // just finalized, so it never throws and never stands between the artifact
  // and the CRM enqueue below.
  try {
    const record = await room.meetingLedgerRecord(job.meetingId);
    if (record) {
      await recordMeetingRecord(env, record);
      await recordUsageEvent(env, {
        kind: 'meeting_end',
        room_slug: job.roomSlug,
        meeting_id: job.meetingId,
        actor_kind: 'system',
      });
    }
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'ledger.meeting.completion.failed',
      meetingId: job.meetingId,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }

  // What the destinations are owed goes into the ledger before anything is
  // sent: the transcript document to the owner's own Docs, now,
  // whether or not the meeting is filed (nobody else can read it there,
  //); the meeting log to Core, unless this is an ambient capture
  // nobody has filed yet (docs/AMBIENT_CAPTURE.md) — the category route
  // asks again the moment it is. The rows outlive a queue, Core or Docs
  // outage; the sweep and the dead queue are the ways back.
  const owed = await requestDelivery(env, job.roomSlug, job.meetingId);
  if (!owed.includes('core')) {
    console.info(JSON.stringify({ level: 'info', message: 'artifact.core.not-owed', meetingId: job.meetingId }));
  }
}

/** Ended inside `MIN_MEETING_MILLISECONDS` of starting. An open meeting is never too short. */
export function isTooShort(artifact: Pick<ArtifactMaterial, 'startedAt' | 'endedAt'>): boolean {
  return artifact.endedAt !== null && artifact.endedAt - artifact.startedAt < MIN_MEETING_MILLISECONDS;
}

/** The names of a meeting's outside attendees, for the follow-up. Never an address: those stay here. */
async function outsideNames(env: Env, room: Awaited<ReturnType<typeof roomStub>>, meetingId: string): Promise<string[]> {
  try {
    const material = await room.meetingLogMaterial(meetingId);
    return [...new Set(outsideAttendees(env, material.participants).map((person) => person.name.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

export async function summarize(
  artifact: ArtifactMaterial,
  env: Pick<Env, 'AI' | 'SUMMARY_MODE' | 'SUMMARY_MODEL'> & Partial<Pick<Env, 'NOTES_MODEL' | 'ANTHROPIC_API_KEY' | 'USAGE'>>,
  outside: string[] = [],
): Promise<{ title: string; summary: string; actionItems: MeetingActionItem[]; decisionCandidates: MeetingDecisionCandidate[]; model: string | null; followUp: MeetingFollowUpDraft | null }> {
  if (String(env.SUMMARY_MODE) !== 'ai' || artifact.transcript.length === 0) return { ...fallbackSummary(artifact), actionItems: [], decisionCandidates: [], model: null, followUp: null };
  // Claude first when the key is set (docs/AMBIENT_CAPTURE.md §3); the small
  // model below is what wrote every note before, kept as the fallback.
  const written = await claudeNotes(env, {
    meetingId: artifact.meetingId,
    startedAt: artifact.startedAt,
    title: artifact.title,
    participants: [...new Set(artifact.transcript.map((segment) => segment.speaker_name.trim()).filter((name) => name && name !== 'Speaker'))],
    outsideAttendees: outside,
    transcript: artifact.transcript,
  });
  // Claude's action items come as data from the same call; the
  // small model's are read out of its Action items section.
  // Decisions come as data the same way; the small model's
  // Decisions section stays prose, so it proposes none.
  if (written) return { ...titledSummary(artifact, written.text), actionItems: written.actionItems, decisionCandidates: written.decisionCandidates, model: written.model, followUp: written.followUp };
  // The key is set and Claude wrote nothing: these notes come from the small
  // model, with no decisions. Said at error level so it is kept and counted,
  // not sampled away; `summary_model` finds the meeting again.
  if (env.ANTHROPIC_API_KEY?.trim()) {
    console.error(JSON.stringify({ level: 'error', message: 'notes.fallback.used', meetingId: artifact.meetingId, model: env.SUMMARY_MODEL }));
    // Counted as well, so a run of fallbacks mails a person.
    if (env.USAGE) await recordFailure({ USAGE: env.USAGE }, 'notes.fallback.used', artifact.meetingId);
  }
  const transcript = artifact.transcript
    .map((segment) => `${segment.speaker_name}: ${segment.text}`)
    .join('\n')
    .slice(0, 80_000);
  try {
    const system = 'Summarize this peer meeting accurately. Write in the predominant language (English, Portuguese, or German). Begin with one line `Title: <the meeting\'s subject in a few words, no markdown>`, then concise Markdown with sections: Summary, Decisions, Action items, Open questions. Never invent facts or owners.';
    const output = await env.AI.run(env.SUMMARY_MODEL, {
      messages: [
        {
          role: 'system',
          content: system,
        },
        { role: 'user', content: transcript },
      ],
      max_tokens: 1200,
      temperature: 0.2,
    });
    await recordModelUsage(env, {
      provider: 'workers-ai', model: String(env.SUMMARY_MODEL), purpose: 'notes-fallback',
      input: estimateTokens(system + transcript), output: estimateTokens(workersAIText(output)),
    });
    const response = typeof output.response === 'string' ? output.response.trim() : '';
    // The small model writes no follow-up: a draft the host cannot trust is worse than none.
    if (!response) return { ...fallbackSummary(artifact), actionItems: [], decisionCandidates: [], model: null, followUp: null };
    return { ...titledSummary(artifact, response), actionItems: parseActionItems(response), decisionCandidates: [], model: String(env.SUMMARY_MODEL), followUp: null };
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'artifact.summary.fallback',
      meetingId: artifact.meetingId,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return { ...fallbackSummary(artifact), actionItems: [], decisionCandidates: [], model: null, followUp: null };
  }
}

/** The section names the prompt asks for. A heading is not a title. */
const SECTION_NAMES = new Set(['summary', 'decisions', 'action items', 'open questions', 'resumo', 'decisões', 'zusammenfassung', 'entscheidungen']);

/**
 * The model's answer as a title and a body. The title a meeting already
 * carries wins; then the `Title:` line the prompt asks for, taken out of
 * the body; then the first line with its markdown stripped — unless that
 * line is one of the section names, which was the bug: every meeting was
 * "**Summary**". With nothing usable, the dated fallback.
 */
export function titledSummary(artifact: ArtifactMaterial, response: string): { title: string; summary: string } {
  const lines = response.split('\n');
  const firstIndex = lines.findIndex((line) => line.trim().length > 0);
  const first = firstIndex === -1 ? '' : lines[firstIndex]!.trim();
  const explicit = /^(?:#+\s*)?(?:\*\*|__)?\s*title\s*:\s*(?:\*\*|__)?\s*(.+?)\s*(?:\*\*|__)?\s*$/iu.exec(first);
  let body = response;
  let candidate = '';
  if (explicit) {
    candidate = plainTitle(explicit[1]!);
    body = [...lines.slice(0, firstIndex), ...lines.slice(firstIndex + 1)].join('\n').trim();
  } else {
    candidate = plainTitle(first);
  }
  const own = artifact.title?.trim() ?? '';
  const title = own
    || (!isSectionTitle(candidate) ? candidate : '')
    || fallbackSummary(artifact).title;
  return { title: title.slice(0, 160), summary: body || response };
}

/**
 * What a title is not. The small model answers in sentences when it has
 * nothing to title ("I can't fulfill that request", "You're right, this is
 * not a formal meeting summary…") and in generic phrases when it has little
 * ("Meeting Summary of Key Discussion Points"). A title is short, has no
 * sentence punctuation, does not address anyone, and says what the meeting
 * was about — not that it is a summary.
 */
const CHATTER = /^(?:i|i(?:'|’)?m|i(?:'|’)?ve|you|you(?:'|’)?re|we|we(?:'|’)?re|this|that|it|there|here|here(?:'|’)?s|sure|certainly|okay|ok|unfortunately|please|could you|as an ai|desculpe|não|você|isso|leider|sie|das)(?=\s)/iu;
const GENERIC = /\b(?:meeting summary|summary of|key discussion points|discussion points|meeting notes|conversation snippet|transcript)\b/iu;
const MAX_TITLE_WORDS = 10;

/** True for a title that must not stand: a section name, chatter, a generic phrase, or nothing. */
export function isSectionTitle(title: string | null | undefined): boolean {
  const plain = plainTitle(title ?? '');
  if (plain.length === 0 || plain.length > 120) return true;
  if (/^meeting notes — \d{4}-\d{2}-\d{2}$/iu.test(plain)) return false;
  if (SECTION_NAMES.has(plain.toLowerCase())) return true;
  if (plain.split(/\s+/u).length > MAX_TITLE_WORDS) return true;
  if (/[.!]$/u.test(plain) || /[.!?]\s+\S/u.test(plain)) return true;
  return CHATTER.test(plain) || GENERIC.test(plain);
}

/**
 * A title for a summary that has none — the one-off for meetings titled
 * "**Summary**" before. One short model call over the summary
 * itself (never the transcript); the dated fallback when it has nothing.
 */
export async function titleFromSummary(
  artifact: ArtifactMaterial,
  env: Pick<Env, 'AI' | 'SUMMARY_MODE' | 'SUMMARY_MODEL'> & Partial<Pick<Env, 'USAGE'>>,
): Promise<string> {
  const summary = artifact.summary?.trim() ?? '';
  if (String(env.SUMMARY_MODE) !== 'ai' || !summary) return fallbackSummary(artifact).title;
  try {
    const output = await env.AI.run(env.SUMMARY_MODEL, {
      messages: [
        {
          role: 'system',
          content: 'Give this meeting summary a title: one line, at most eight words, in the summary\'s own language, no markdown, no quotes, not a section name. Answer with the title only.',
        },
        { role: 'user', content: summary.slice(0, 12_000) },
      ],
      max_tokens: 40,
      temperature: 0.2,
    });
    await recordModelUsage(env, {
      provider: 'workers-ai', model: String(env.SUMMARY_MODEL), purpose: 'title',
      input: estimateTokens(summary.slice(0, 12_000)) + 50, output: estimateTokens(workersAIText(output)),
    });
    const response = typeof output.response === 'string' ? output.response.trim() : '';
    const candidate = plainTitle(response.split('\n').find((line) => line.trim())?.replace(/^title\s*:\s*/iu, '') ?? '');
    return !isSectionTitle(candidate) ? candidate.slice(0, 160) : fallbackSummary(artifact).title;
  } catch {
    return fallbackSummary(artifact).title;
  }
}

export interface RetitleReport {
  rooms: number;
  considered: number;
  retitled: Array<{ room_slug: string; meeting_id: string; from: string | null; to: string }>;
  degraded: string[];
}

/**
 * Every finalized meeting whose title is a section name gets a real one
 * from its summary, then Docs (the transcript document) and Core (the
 * interaction) hear about it through the ordinary meeting-log sync.
 * `POST /api/admin/retitle-meetings`; idempotent, since a retitled meeting
 * no longer matches.
 */
export async function retitleMeetings(env: Env): Promise<RetitleReport> {
  const report: RetitleReport = { rooms: 0, considered: 0, retitled: [], degraded: [] };
  for (const slug of [...(await knownRoomSlugs(env))].sort()) {
    const room = await roomStub(env, slug);
    let snapshot;
    try {
      snapshot = await room.adminSnapshot(slug);
    } catch (error) {
      console.warn(JSON.stringify({ level: 'warn', message: 'retitle.room.failed', slug, error: error instanceof Error ? error.message : 'Unknown error' }));
      report.degraded.push(slug);
      continue;
    }
    report.rooms += 1;
    for (const record of snapshot.meetings) {
      if (!record.summary_generated || !isSectionTitle(record.title)) continue;
      report.considered += 1;
      try {
        const artifact = await room.artifactForProcessing(record.meeting_id);
        if (!artifact.summary) continue;
        const title = await titleFromSummary({ ...artifact, title: null }, env);
        await room.setSummary(record.meeting_id, title, artifact.summary);
        report.retitled.push({ room_slug: slug, meeting_id: record.meeting_id, from: record.title, to: title });
        try {
          await requestDelivery(env, slug, record.meeting_id, { inline: true });
        } catch (error) {
          console.warn(JSON.stringify({ level: 'warn', message: 'retitle.sync.failed', meetingId: record.meeting_id, error: error instanceof Error ? error.message : 'Unknown error' }));
          report.degraded.push(`${slug}/${record.meeting_id}`);
        }
      } catch (error) {
        console.warn(JSON.stringify({ level: 'warn', message: 'retitle.meeting.failed', meetingId: record.meeting_id, error: error instanceof Error ? error.message : 'Unknown error' }));
        report.degraded.push(`${slug}/${record.meeting_id}`);
      }
    }
  }
  // Admin reads the ledger, not the rooms (docs/ADMIN.md): refresh it, or
  // the list keeps the old titles and the meetings the rooms have since
  // closed keep reading as live.
  await backfillLedgerFromRooms(env);
  return report;
}

export interface RegenerateReport {
  room_slug: string;
  meeting_id: string;
  title: string;
  engine: 'claude' | 'workers-ai' | 'fallback';
  synced: boolean;
}

/**
 * Write one finalized meeting's notes again with whatever engine is configured
 * now, then let Docs and Core hear about it through the ordinary sync. The
 * way to compare a note against Granola's on the same meeting ( claim
 * 2) without waiting for a new one. `POST /api/admin/regenerate-notes`.
 */
export async function regenerateNotes(env: Env, roomSlug: string, meetingId: string): Promise<RegenerateReport> {
  const room = await roomStub(env, roomSlug);
  const artifact = await room.artifactForProcessing(meetingId);
  if (artifact.transcript.length === 0) {
    throw new ControlError('That meeting has no transcript to write notes from.', 409, 'invalid_request');
  }
  // The title a meeting already carries wins in `titledSummary`; a regenerated
  // note should get the title its new engine gives it, unless the calendar
  // named the meeting — which `artifactForProcessing` reports as the title.
  const generated = await summarize(artifact, env, await outsideNames(env, room, meetingId));
  await room.setSummary(meetingId, generated.title, generated.summary, generated.actionItems, generated.decisionCandidates, generated.model, generated.followUp);
  const engine = env.ANTHROPIC_API_KEY?.trim() ? 'claude' : String(env.SUMMARY_MODE) === 'ai' ? 'workers-ai' : 'fallback';
  // The new notes are owed downstream; a destination that is down keeps
  // its row and the sweep carries it.
  let synced = false;
  try {
    await requestDelivery(env, roomSlug, meetingId, { inline: true });
    synced = true;
  } catch (error) {
    console.warn(JSON.stringify({ level: 'warn', message: 'regenerate.sync.failed', meetingId, error: error instanceof Error ? error.message : 'Unknown error' }));
  }
  await backfillLedgerFromRooms(env);
  return { room_slug: roomSlug, meeting_id: meetingId, title: generated.title, engine, synced };
}

/**
 * Every meeting since `since` whose notes the fallback wrote, queued to be
 * written again with the engine configured now. One job per
 * meeting, so a long list does not have to finish inside one request.
 */
export async function queueFallbackRegeneration(env: Env, since: number): Promise<{ rooms: number; queued: number }> {
  const slugs = [...(await knownRoomSlugs(env))];
  const jobs: ArtifactJob[] = [];
  for (const slug of slugs) {
    const room = await roomStub(env, slug);
    for (const meetingId of await room.meetingsWrittenByFallback(since)) {
      jobs.push({ kind: 'regenerate', roomSlug: slug, meetingId });
    }
  }
  // `sendBatch` takes at most 100 messages.
  for (let start = 0; start < jobs.length; start += 100) {
    await env.ARTIFACT_JOBS.sendBatch(jobs.slice(start, start + 100).map((body) => ({ body })));
  }
  return { rooms: slugs.length, queued: jobs.length };
}

export interface DiscardReport {
  rooms: number;
  discarded: Array<{ room_slug: string; meeting_id: string; ms: number; transcript_archived: boolean }>;
  degraded: string[];
}

/**
 * The one-off behind `MIN_MEETING_MILLISECONDS`: every ended meeting that
 * ran under five minutes and predates the rule is discarded the same way the
 * artifact job now does it — the room marks it, its ledger row goes, and a
 * transcript document it filed is archived in Docs. Core's started
 * interaction stays until Core learns a discarded phase (envisioning/core).
 * `POST /api/admin/discard-short-meetings`; idempotent.
 */
export async function discardShortMeetings(env: Env): Promise<DiscardReport> {
  const report: DiscardReport = { rooms: 0, discarded: [], degraded: [] };
  for (const slug of [...(await knownRoomSlugs(env))].sort()) {
    const room = await roomStub(env, slug);
    let snapshot;
    try {
      snapshot = await room.adminSnapshot(slug);
    } catch (error) {
      console.warn(JSON.stringify({ level: 'warn', message: 'discard.room.failed', slug, error: error instanceof Error ? error.message : 'Unknown error' }));
      report.degraded.push(slug);
      continue;
    }
    report.rooms += 1;
    for (const record of snapshot.meetings) {
      if (record.ended_at === null || !isTooShort({ startedAt: record.started_at, endedAt: record.ended_at })) continue;
      try {
        let transcriptArchived = false;
        if (docsEnabled(env)) {
          const material = await room.meetingLogMaterial(record.meeting_id);
          if (material.transcriptDocumentId) {
            await archiveDocsDocument(env, material.ownerEmail, material.transcriptDocumentId);
            transcriptArchived = true;
          }
        }
        await room.discardMeeting(record.meeting_id);
        await forgetMeetingRecord(env, record.meeting_id);
        report.discarded.push({ room_slug: slug, meeting_id: record.meeting_id, ms: record.ended_at - record.started_at, transcript_archived: transcriptArchived });
      } catch (error) {
        console.warn(JSON.stringify({ level: 'warn', message: 'discard.meeting.failed', meetingId: record.meeting_id, error: error instanceof Error ? error.message : 'Unknown error' }));
        report.degraded.push(`${slug}/${record.meeting_id}`);
      }
    }
  }
  // Admin reads the ledger, not the rooms: without this the list keeps the
  // old title (and a meeting the rooms have since closed reads as live).
  await backfillLedgerFromRooms(env);
  return report;
}

/** A line without its heading marks, emphasis, trailing punctuation or quotes. */
function plainTitle(line: string): string {
  return line
    .replace(/^#+\s*/u, '')
    .replace(/^[*_`"“]+|[*_`"”:]+$/gu, '')
    .replace(/\*\*|__/gu, '')
    .trim();
}

export { fallbackSummary } from './meeting-fallback';
