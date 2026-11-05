// A read index of quiet event lines; never human Talk, unread or task state.
import { MESSAGE_PREVIEW_MAX_CHARS } from '@starlings/contracts';
import type { CrmSubject, RecentFeedEntry } from './contracts';
import { threadStub } from './threads';
import { INBOX_RECENT_WINDOW_MS } from '@starlings/contracts/inbox-values';

const BACKFILL_THREADS = 5;
const EVENT_LIMIT = 100;

type ActivityRow = { thread_id: string; message_id: string; text: string; at: number };

export async function recordSubjectActivity(env: Env, row: ActivityRow): Promise<void> {
  try {
    await env.USAGE.prepare(`INSERT INTO subject_activity (thread_id, message_id, text, at)
      VALUES (?1, ?2, ?3, ?4) ON CONFLICT(thread_id, message_id) DO NOTHING`)
      .bind(row.thread_id, row.message_id, row.text.slice(0, MESSAGE_PREVIEW_MAX_CHARS), row.at).run();
  } catch {
    // An auxiliary index must never turn a successful event append into a failed write.
    console.warn(JSON.stringify({ level: 'warn', message: 'activity.index.failed' }));
  }
}

export async function readSubjectActivity(
  env: Env, subjects: CrmSubject[], partial: string[], limit: number, since = Date.now() - INBOX_RECENT_WINDOW_MS,
): Promise<RecentFeedEntry[]> {
  if (subjects.length === 0) return [];
  const bySubject = new Map(subjects.map((subject) => [`${subject.kind}:${subject.id}`, subject]));
  const keys = JSON.stringify([...bySubject.keys()]);
  // Scope before the ceiling, including the backfill: hidden/muted subjects
  // cannot take the places owed to visible subjects or leak in failure labels.
  const scope = `t.kind || ':' || t.parent_id IN (SELECT value FROM json_each(?1)) AND t.removed_at IS NULL`;
  const { results: pending } = await env.USAGE.prepare(`SELECT t.id, t.kind, t.parent_id
    FROM threads t LEFT JOIN subject_activity_index i ON i.thread_id = t.id
    WHERE ${scope} AND (i.thread_id IS NULL OR i.since > ?2)
    ORDER BY t.id`).bind(keys, since).all<{ id: string; kind: string; parent_id: string }>();
  const remaining = pending.slice(BACKFILL_THREADS);
  partial.push(...remaining.map((row) => bySubject.get(`${row.kind}:${row.parent_id}`)!.title));
  await Promise.all(pending.slice(0, BACKFILL_THREADS).map(async (row) => {
    try {
      const events = await threadStub(env, row.id).activityIndex(since, EVENT_LIMIT);
      await env.USAGE.batch([
        env.USAGE.prepare(`INSERT OR IGNORE INTO subject_activity (thread_id, message_id, text, at)
          SELECT ?1, json_extract(value, '$.id'), json_extract(value, '$.text'), json_extract(value, '$.sent_at')
          FROM json_each(?2)`).bind(row.id, JSON.stringify(events.map((event) => ({ ...event, text: event.text.slice(0, MESSAGE_PREVIEW_MAX_CHARS) })))),
        env.USAGE.prepare(`INSERT INTO subject_activity_index (thread_id, since) VALUES (?1, ?2)
          ON CONFLICT(thread_id) DO UPDATE SET since = MIN(since, excluded.since)`).bind(row.id, since),
      ]);
    } catch {
      partial.push(bySubject.get(`${row.kind}:${row.parent_id}`)!.title);
    }
  }));
  const { results } = await env.USAGE.prepare(`SELECT a.thread_id, a.message_id, a.text, a.at, t.kind, t.parent_id
    FROM subject_activity a JOIN threads t ON t.id = a.thread_id
    WHERE ${scope} AND a.at >= ?2
    ORDER BY a.at DESC, a.thread_id, a.message_id LIMIT ?3`)
    .bind(keys, since, limit).all<ActivityRow & { kind: string; parent_id: string }>();
  return results.map((row) => {
    const subject = bySubject.get(`${row.kind}:${row.parent_id}`)!;
    return {
      subject: { kind: subject.kind, id: subject.id, title: subject.title },
      // Additive to the existing feed: older clients can still decode a row.
      interaction: {
        id: `event:${row.thread_id}:${row.message_id}`, type: 'event', title: row.text,
        occurred_at: new Date(row.at).toISOString(), created_at: null,
        summary_preview: null, summary_markdown: null, transcript_preview: null,
        duration_minutes: null, project_id: subject.kind === 'project' ? subject.id : null,
        lead_id: subject.kind === 'lead' ? subject.id : null, organization_id: null,
        source: 'meet', channel: null, status: null, url: null, contacts: [],
      },
    };
  });
}
