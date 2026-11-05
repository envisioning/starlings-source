// Meetings owed notes (docs/OPERATIONS.md §Meetings owed notes).
//
// The delivery ledger (deliveries.ts) starts after the summary, at the last
// step of the artifact job. A job that dead-letters before that step left no
// record that the meeting was owed anything. This row is written at
// `/finalize`, before the enqueue, and closed by the job.

import type { NotesOwedRow } from './contracts';
import { recordFailure } from './ops';

/** A row still open this long after it was owed is re-enqueued. */
export const NOTES_OWED_RETRY_MS = 15 * 60_000;
/** Re-enqueues before the sweep gives up and counts a failure. */
export const NOTES_OWED_MAX_ATTEMPTS = 3;

/**
 * Record that a meeting is owed notes. Throws when D1 refuses: the caller is
 * `/finalize`, which must not enqueue a job that nothing records.
 */
export async function recordNotesOwed(env: Pick<Env, 'USAGE'>, roomSlug: string, meetingId: string, now = Date.now()): Promise<void> {
  await env.USAGE.prepare('INSERT OR IGNORE INTO notes_owed (room_slug, meeting_id, owed_at) VALUES (?1, ?2, ?3)')
    .bind(roomSlug, meetingId, now).run();
}

/**
 * The meeting has its notes, or was discarded as too short. Best-effort: a
 * lost write means the sweep enqueues the job once more, and the job finds
 * the summary and closes the row then.
 */
export async function markNotesDone(env: Pick<Env, 'USAGE'>, roomSlug: string, meetingId: string, now = Date.now()): Promise<void> {
  try {
    await env.USAGE.prepare('UPDATE notes_owed SET done_at = ?3 WHERE room_slug = ?1 AND meeting_id = ?2 AND done_at IS NULL')
      .bind(roomSlug, meetingId, now).run();
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      message: 'notes.owed.done.failed',
      meetingId,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/**
 * The five-minute sweep. A row still open is re-enqueued 15 minutes after it
 * was owed, then at 30 and 45 minutes: attempt `n` waits for `15 × n`
 * minutes, so a job that is still retrying is not sent twice. After three
 * attempts the sweep counts a `notes_owed` failure once and stops; Admin ›
 * Jobs lists the meeting and its Retry resets `attempts`.
 */
export async function sweepOwedNotes(env: Env, now = Date.now()): Promise<{ requeued: number; given_up: number }> {
  const { results } = await env.USAGE.prepare(
    `SELECT room_slug, meeting_id, owed_at, attempts FROM notes_owed
     WHERE done_at IS NULL AND attempts <= ?1 AND owed_at < ?2 - ?3 * (attempts + 1)
     ORDER BY owed_at LIMIT 100`,
  ).bind(NOTES_OWED_MAX_ATTEMPTS, now, NOTES_OWED_RETRY_MS).all<{ room_slug: string; meeting_id: string; owed_at: number; attempts: number }>();
  let requeued = 0;
  let givenUp = 0;
  for (const row of results) {
    if (row.attempts >= NOTES_OWED_MAX_ATTEMPTS) {
      await env.USAGE.prepare('UPDATE notes_owed SET attempts = ?3 WHERE room_slug = ?1 AND meeting_id = ?2')
        .bind(row.room_slug, row.meeting_id, row.attempts + 1).run();
      await recordFailure(env, 'notes_owed', row.meeting_id, now);
      givenUp += 1;
      continue;
    }
    await env.ARTIFACT_JOBS.send({ roomSlug: row.room_slug, meetingId: row.meeting_id });
    await env.USAGE.prepare('UPDATE notes_owed SET attempts = ?3 WHERE room_slug = ?1 AND meeting_id = ?2')
      .bind(row.room_slug, row.meeting_id, row.attempts + 1).run();
    requeued += 1;
  }
  return { requeued, given_up: givenUp };
}

/** The meetings the sweep gave up on, oldest first. */
export async function stuckOwedNotes(env: Env): Promise<NotesOwedRow[]> {
  const { results } = await env.USAGE.prepare(
    `SELECT room_slug, meeting_id, owed_at, attempts FROM notes_owed
     WHERE done_at IS NULL AND attempts > ?1 ORDER BY owed_at LIMIT 200`,
  ).bind(NOTES_OWED_MAX_ATTEMPTS).all<NotesOwedRow>();
  return results;
}

/** Retry: `attempts` back to 0, so the next sweep enqueues the job again. */
export async function resetOwedNotes(env: Env, roomSlug: string, meetingId: string): Promise<boolean> {
  const result = await env.USAGE.prepare(
    'UPDATE notes_owed SET attempts = 0 WHERE room_slug = ?1 AND meeting_id = ?2 AND done_at IS NULL',
  ).bind(roomSlug, meetingId).run();
  return (result.meta.changes ?? 0) > 0;
}
