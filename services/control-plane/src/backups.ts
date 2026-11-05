// The daily text backup of every Durable Object (,
// docs/OPERATIONS.md §Backups and restore).
//
// Chat, reactions, meetings, transcript lines and Quick Notes live only in
// Durable Object storage. Once a day, after 03:00 UTC, the cron plans the
// day: one queue job per room, per thread and per owner's Quick Notes. Each
// job writes its object's tables as JSON into the `meet-backups` R2 bucket
// (EU jurisdiction, objects expire after 30 days). Text only: audio and video
// never go in it (AGENTS.md invariant 1).
//
// The queue retries a failed job. The cron then checks the bucket against
// the plan: an object still missing is sent again, and the day is marked done
// only when every planned object is in the bucket.

import type { BackupObjectJob, RestoreObjectKind } from './contracts';
import { ControlError } from './errors';
import { knownRoomSlugs } from './internal-rooms';
import { recordFailure } from './ops';
import { threadStub } from './threads';
import { roomStub, quickNotesStub } from './do-jurisdiction';

/** The UTC hour before which the daily backup does not start. */
export const BACKUP_HOUR_UTC = 3;
const BACKUP_JOB = 'backup';
const BACKUP_DONE_JOB = 'backup-done';
const BACKUP_LATE_JOB = 'backup-late';
/** An object still missing this long after the last send is sent again. */
export const BACKUP_RESEND_MS = 30 * 60_000;
/** After this many hours past the start, an object still missing is a failure that mails a person. */
export const BACKUP_LATE_HOURS = 6;
const SEND_BATCH = 100;

const KEY_FOLDER: Record<RestoreObjectKind, string> = {
  room: 'rooms',
  thread: 'threads',
  'quick-notes': 'quick-notes',
};

export function backupKey(date: string, kind: RestoreObjectKind, id: string): string {
  return `backups/${date}/${KEY_FOLDER[kind]}/${id}.json`;
}

/**
 * Claim today for `job`: true for the one caller that moved `last_day`
 * forward. The claim comes before the work, so a slow run is not started
 * again by the next tick.
 */
async function claimDay(env: Env, job: string, day: string, now: number): Promise<boolean> {
  const result = await env.USAGE.prepare(
    `INSERT INTO ops_runs (job, last_day, last_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (job) DO UPDATE SET last_day = excluded.last_day, last_at = excluded.last_at
     WHERE ops_runs.last_day < excluded.last_day`,
  ).bind(job, day, now).run();
  return (result.meta.changes ?? 0) > 0;
}

/** True for the one caller that moves today's `backup` send time forward. */
async function claimResend(env: Env, day: string, now: number): Promise<boolean> {
  const result = await env.USAGE.prepare(
    'UPDATE ops_runs SET last_at = ?2 WHERE job = ?1 AND last_day = ?3 AND last_at <= ?4',
  ).bind(BACKUP_JOB, now, day, now - BACKUP_RESEND_MS).run();
  return (result.meta.changes ?? 0) > 0;
}

async function isDone(env: Env, day: string): Promise<boolean> {
  const row = await env.USAGE.prepare('SELECT last_day FROM ops_runs WHERE job = ?1')
    .bind(BACKUP_DONE_JOB).first<{ last_day: string }>();
  return row?.last_day === day;
}

export interface BackupReport {
  /** This call planned the day. */
  ran: boolean;
  /** Jobs sent: the whole plan, or the objects a later call found missing. */
  queued: number;
  /** Objects still missing from the bucket when a later call looked. */
  missing: number;
  /** Every planned object is in the bucket. */
  done: boolean;
}

/**
 * Every object today's backup covers: rooms, threads, and one Quick Notes
 * inbox per person. With `createdBy`, only threads and people that existed by
 * then: the check after the plan must not ask for a thread started at noon,
 * which the 03:00 plan could not have covered.
 */
async function plannedObjects(env: Env, day: string, createdBy?: number): Promise<BackupObjectJob[]> {
  const jobs: BackupObjectJob[] = [...(await knownRoomSlugs(env))].sort()
    .map((id) => ({ kind: 'backup-object', day, object: 'room', id }));
  const limit = createdBy ?? Number.MAX_SAFE_INTEGER;
  const threads = await env.USAGE.prepare('SELECT id FROM threads WHERE created_at <= ?1 ORDER BY id').bind(limit).all<{ id: string }>();
  for (const { id } of threads.results) jobs.push({ kind: 'backup-object', day, object: 'thread', id });
  const people = await env.USAGE.prepare('SELECT sub FROM people WHERE first_seen_at <= ?1 ORDER BY sub').bind(limit).all<{ sub: string }>();
  for (const { sub } of people.results) jobs.push({ kind: 'backup-object', day, object: 'quick-notes', id: sub });
  return jobs;
}

async function send(env: Env, jobs: readonly BackupObjectJob[]): Promise<void> {
  for (let start = 0; start < jobs.length; start += SEND_BATCH) {
    await env.ARTIFACT_JOBS.sendBatch(jobs.slice(start, start + SEND_BATCH).map((body) => ({ body })));
  }
}

async function storedKeys(env: Env, day: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await env.BACKUPS.list(cursor ? { prefix: `backups/${day}/`, cursor } : { prefix: `backups/${day}/` });
    for (const object of page.objects) keys.add(object.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/**
 * Once a day after 03:00 UTC the first call plans the day and sends one job
 * per object. Every later call that day looks at the bucket: nothing missing
 * marks the day done; something missing and not sent for 30 minutes is sent
 * again; still missing six hours after the start counts one `backup` failure,
 * which mails a person. A job that fails every retry counts one too (ops.ts).
 */
export async function runDailyBackup(env: Env, now = Date.now()): Promise<BackupReport> {
  const report: BackupReport = { ran: false, queued: 0, missing: 0, done: false };
  if (!env.BACKUPS) return report;
  const at = new Date(now);
  if (at.getUTCHours() < BACKUP_HOUR_UTC) return report;
  const day = at.toISOString().slice(0, 10);

  if (await claimDay(env, BACKUP_JOB, day, now)) {
    const jobs = await plannedObjects(env, day);
    await send(env, jobs);
    report.ran = true;
    report.queued = jobs.length;
    console.log(JSON.stringify({ level: 'info', message: 'backup.planned', day, queued: jobs.length }));
    return report;
  }

  if (await isDone(env, day)) {
    report.done = true;
    return report;
  }
  const stored = await storedKeys(env, day);
  const planStart = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), BACKUP_HOUR_UTC);
  const missing = (await plannedObjects(env, day, planStart)).filter((job) => !stored.has(backupKey(day, job.object, job.id)));
  report.missing = missing.length;
  if (missing.length === 0) {
    await claimDay(env, BACKUP_DONE_JOB, day, now);
    report.done = true;
    console.log(JSON.stringify({ level: 'info', message: 'backup.done', day, objects: stored.size }));
    return report;
  }

  const lateAt = planStart + BACKUP_LATE_HOURS * 60 * 60_000;
  if (now >= lateAt) {
    if (await claimDay(env, BACKUP_LATE_JOB, day, now)) {
      await recordFailure(env, 'backup', `incomplete ${day}: ${missing.length} missing, first ${missing[0]!.object}:${missing[0]!.id}`, now);
    }
    return report;
  }
  if (await claimResend(env, day, now)) {
    await send(env, missing);
    report.queued = missing.length;
    console.log(JSON.stringify({ level: 'info', message: 'backup.resent', day, queued: missing.length }));
  }
  return report;
}

async function exportObject(env: Env, kind: RestoreObjectKind, id: string): Promise<unknown> {
  if (kind === 'room') return (await roomStub(env, id)).exportState();
  if (kind === 'thread') return threadStub(env, id).exportState();
  return (await quickNotesStub(env, id)).exportState();
}

/**
 * One queue job: export one object and write it to the bucket. Throws on a
 * failure so the queue retries it (a put of the same key twice is harmless).
 */
export async function processBackupJob(env: Env, job: BackupObjectJob): Promise<void> {
  if (!env.BACKUPS) throw new ControlError('The backup bucket is not configured.', 503, 'not_configured');
  const snapshot = await exportObject(env, job.object, job.id);
  await env.BACKUPS.put(backupKey(job.day, job.object, job.id), JSON.stringify(snapshot), {
    httpMetadata: { contentType: 'application/json' },
  });
}

/**
 * Restore one object from a day's snapshot. The object must still be one
 * Meet knows: a room in `knownRoomSlugs`, a thread in D1 `threads`, a person
 * in D1 `people` for their Quick Notes.
 */
export async function restoreObject(env: Env, kind: RestoreObjectKind, id: string, date: string): Promise<Record<string, number>> {
  if (!env.BACKUPS) throw new ControlError('The backup bucket is not configured.', 503, 'not_configured');
  if (kind === 'room' && !(await knownRoomSlugs(env)).has(id)) {
    throw new ControlError('No room with that slug.', 404, 'room_not_found');
  }
  if (kind === 'thread' && !await env.USAGE.prepare('SELECT id FROM threads WHERE id = ?1').bind(id).first()) {
    throw new ControlError('No thread with that id.', 404, 'request_not_found');
  }
  if (kind === 'quick-notes' && !await env.USAGE.prepare('SELECT sub FROM people WHERE sub = ?1').bind(id).first()) {
    throw new ControlError('No person with that id.', 404, 'request_not_found');
  }
  const object = await env.BACKUPS.get(backupKey(date, kind, id));
  if (!object) throw new ControlError('No snapshot for that object on that date.', 404, 'request_not_found');
  const snapshot = await object.json();
  if (kind === 'room') return (await roomStub(env, id)).importState(snapshot);
  if (kind === 'thread') return threadStub(env, id).importState(snapshot);
  return (await quickNotesStub(env, id)).importState(snapshot);
}
