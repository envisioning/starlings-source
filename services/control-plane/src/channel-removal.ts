// Remove a channel whose subject is gone, and put it back.
//
// A subject's channel outlives its subject: delete a lead in Core and its
// channel stays in everybody's list. An admin hides it here. Hiding is a
// timestamp on the `threads` row (`removed_at`, `removed_by`); the Durable
// Object's messages are never touched, and clearing the timestamp brings the
// channel back with its history. Every reader that must not show a removed
// channel filters on the column in `threads.ts`; docs/CHANNELS.md lists them.
//
// The one rule that matters here: "the subject is gone" means its store said
// so, by id, with a clean answer. An error, a timeout or a 5xx says nothing
// about the subject, so it refuses; and absence
// is never inferred from a list.

import { recordAdminAction } from './admin-audit';
import {
  type ChannelRemoveResponse,
  type ChannelRestoreResponse,
  type ChannelSubjectKind,
  type OrphanChannel,
  type OrphanChannelsResponse,
  type OwnerSession,
  type RemovedChannel,
} from './contracts';
import { crmSyncEnabled, lookupCrmSubjectById } from './crm';
import { d1Subject } from './work-d1';
import { usesCore, usesCoreForKind } from './work-store';
import { ControlError } from './errors';
import { threadStub } from './threads';

/** How many subjects one call asks Core about. Each is one subrequest, and Core's quota is shared. */
export const ORPHAN_CHECK_LIMIT = 60;
const CHECK_CONCURRENCY = 5;
const REMOVED_LIST_LIMIT = 20;

const SUBJECT_KINDS = ['project', 'lead', 'organization', 'event'] as const;

interface SubjectChannelRow {
  id: string;
  kind: ChannelSubjectKind;
  parent_id: string;
  title: string | null;
  created_at: number;
  last_message_at: number | null;
}

function isSubjectKind(kind: string): kind is ChannelSubjectKind {
  return (SUBJECT_KINDS as readonly string[]).includes(kind);
}

function requireWorkStore(env: Env): void {
  if (usesCore(env) && !crmSyncEnabled(env)) {
    throw new ControlError('Core isn’t connected, so no channel can be checked.', 503, 'not_configured');
  }
}

async function subjectExists(env: Env, kind: ChannelSubjectKind, id: string): Promise<boolean> {
  if (!usesCoreForKind(env, kind)) {
    // A merged id answers its survivor; the merged record itself is gone.
    const subject = await d1Subject(env, kind, id);
    return subject !== null && subject.merged_from === undefined;
  }
  return (await lookupCrmSubjectById(env, kind, id)).found;
}

/**
 * Subject channels whose store reports the subject as not found, plus the channels
 * already removed. Subjects are asked for by id, newest channel first,
 * `ORPHAN_CHECK_LIMIT` per call; `offset` continues where an earlier call
 * stopped. What the bound left is `not_checked`; what the store could not answer
 * is `check_failed`, and neither is listed as an orphan.
 */
export async function listOrphanChannels(env: Env, offset = 0): Promise<OrphanChannelsResponse> {
  requireWorkStore(env);
  const { results: all } = await env.USAGE.prepare(
    `SELECT id, kind, parent_id, title, created_at, last_message_at
       FROM threads
      WHERE kind IN ('project', 'lead', 'organization', 'event')
        AND parent_id IS NOT NULL AND removed_at IS NULL
      ORDER BY created_at DESC, id`,
  ).all<SubjectChannelRow>();

  const batch = all.slice(offset, offset + ORPHAN_CHECK_LIMIT);
  const gone: SubjectChannelRow[] = [];
  let failed = 0;
  for (let at = 0; at < batch.length; at += CHECK_CONCURRENCY) {
    const settled = await Promise.allSettled(batch.slice(at, at + CHECK_CONCURRENCY).map(async (row) => {
      return { row, found: await subjectExists(env, row.kind, row.parent_id) };
    }));
    for (const result of settled) {
      if (result.status === 'rejected') failed += 1;
      else if (!result.value.found) gone.push(result.value.row);
    }
  }
  if (failed > 0) {
    console.warn(JSON.stringify({ level: 'warn', message: 'admin.channels.orphans.check_failed', failed, checked: batch.length }));
  }

  const orphans: OrphanChannel[] = await Promise.all(gone.map(async (row) => ({
    thread_id: row.id,
    kind: row.kind,
    title: row.title,
    created_at: row.created_at,
    last_message_at: row.last_message_at,
    message_count: await threadStub(env, row.id).messageCount().catch(() => null),
  })));

  const { results: removedRows } = await env.USAGE.prepare(
    `SELECT id, kind, title, removed_at, removed_by
       FROM threads
      WHERE removed_at IS NOT NULL AND kind IN ('project', 'lead', 'organization', 'event')
      ORDER BY removed_at DESC
      LIMIT ?1`,
  ).bind(REMOVED_LIST_LIMIT).all<{ id: string; kind: ChannelSubjectKind; title: string | null; removed_at: number; removed_by: string | null }>();
  const removed: RemovedChannel[] = removedRows.map((row) => ({
    thread_id: row.id,
    kind: row.kind,
    title: row.title,
    removed_at: row.removed_at,
    removed_by: row.removed_by,
  }));

  return {
    orphans,
    removed,
    checked: batch.length - failed,
    not_checked: Math.max(0, all.length - offset - batch.length),
    check_failed: failed,
  };
}

interface ThreadStateRow {
  id: string;
  kind: string;
  parent_id: string | null;
  title: string | null;
  removed_at: number | null;
}

async function threadState(env: Env, threadId: string): Promise<ThreadStateRow> {
  const row = await env.USAGE.prepare(
    'SELECT id, kind, parent_id, title, removed_at FROM threads WHERE id = ?1',
  ).bind(threadId).first<ThreadStateRow>();
  if (!row) throw new ControlError('No channel with that id.', 404, 'request_not_found');
  return row;
}

/**
 * Hide a channel whose subject is gone from its store. Refused for anything
 * other than a subject channel, a subject that still exists, or a store that
 * cannot answer. A failed lookup writes nothing.
 */
export async function removeChannel(env: Env, actor: OwnerSession, threadId: string): Promise<ChannelRemoveResponse> {
  const row = await threadState(env, threadId);
  if (!isSubjectKind(row.kind) || !row.parent_id) {
    throw new ControlError('Only a channel on a project, lead, partner or event can be removed.', 400, 'invalid_request');
  }
  if (row.removed_at !== null) return { thread_id: row.id, removed_at: row.removed_at };
  requireWorkStore(env);

  let answer;
  try {
    answer = await subjectExists(env, row.kind, row.parent_id);
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'admin.channels.remove.store_unreachable',
      kind: row.kind,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    throw new ControlError('Couldn’t check this channel’s subject, so nothing was removed. Try again in a moment.', 502);
  }
  if (answer) {
    throw new ControlError('This channel’s subject still exists, so it can’t be removed.', 409, 'invalid_request');
  }

  const removedAt = Date.now();
  const result = await env.USAGE.prepare(
    `UPDATE threads SET removed_at = ?2, removed_by = ?3
      WHERE id = ?1 AND removed_at IS NULL AND kind IN ('project', 'lead', 'organization', 'event')`,
  ).bind(row.id, removedAt, actor.email).run();
  if ((result.meta?.changes ?? 0) === 0) {
    // Removed by another admin between the read and the write: same outcome.
    const now = await threadState(env, threadId);
    return { thread_id: now.id, removed_at: now.removed_at ?? removedAt };
  }
  await recordAdminAction(env, actor, 'job.remove-channel', row.id, `${row.kind}: ${row.title ?? 'untitled'}`);
  return { thread_id: row.id, removed_at: removedAt };
}

/** Bring a removed channel back, history and all. Restoring one that is not removed does nothing. */
export async function restoreChannel(env: Env, actor: OwnerSession, threadId: string): Promise<ChannelRestoreResponse> {
  const row = await threadState(env, threadId);
  if (row.removed_at === null) return { thread_id: row.id, restored: false };
  await env.USAGE.prepare(
    'UPDATE threads SET removed_at = NULL, removed_by = NULL WHERE id = ?1',
  ).bind(row.id).run();
  await recordAdminAction(env, actor, 'job.restore-channel', row.id, `${row.kind}: ${row.title ?? 'untitled'}`);
  return { thread_id: row.id, restored: true };
}
