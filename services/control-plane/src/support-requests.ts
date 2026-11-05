import { taskFieldFor, type InboxItem, type SubjectKind, type SupportRequest, type SupportRequestCreateResponse } from './contracts';
import type { OwnerSession } from './contracts';
import { createCrmTask } from './crm';
import { ControlError } from './errors';
import { guestThreadSubject, parseGuestParent } from './guests';
import { subjectAccessFor } from './subject-access';
import { threadStub } from './threads';

/**
 * Support requests (docs/SUPPORT.md): a member turns one line a guest or a
 * peer organization wrote in a subject's guest thread into a card, an
 * ordinary task on that subject. `support_requests` (migration 0094) keeps
 * the link from the card back to the line.
 */

const TITLE_CHARS = 120;
const NOTES_CHARS = 5000;

/** A line's first words as a card title: its first line, cut at a word. */
export function requestTitle(text: string): string {
  const line = text.trim().split('\n')[0]!.trim().replace(/\s+/gu, ' ');
  if (line.length <= TITLE_CHARS) return line || 'Support request';
  const cut = line.slice(0, TITLE_CHARS);
  const space = cut.lastIndexOf(' ');
  return `${(space > TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export async function createSupportRequest(
  env: Env,
  owner: OwnerSession,
  threadId: string,
  messageId: string,
  title: string | undefined,
): Promise<SupportRequestCreateResponse> {
  const subject = await guestThreadSubject(env, threadId);
  if (!subject) throw new ControlError('Conversation not found.', 404, 'room_not_found');
  (await subjectAccessFor(env, owner)).requireWrite(subject.kind, subject.id);

  const line = await threadStub(env, threadId).message(owner.sub, messageId);
  if (!line || line.withdrawn) throw new ControlError('That message is gone.', 404, 'request_not_found');
  if (line.origin !== 'guest' && line.origin !== 'peer' && line.origin !== 'app') {
    throw new ControlError('Only a line a guest, an organization or an app user wrote becomes a support request.', 400, 'invalid_request');
  }

  return fileSupportRequest(env, {
    threadId, messageId, subject, text: line.text,
    sender: line.senderName?.trim() || line.senderEmail,
    actorEmail: owner.email,
    ...(title ? { title } : {}),
  });
}

/**
 * The one way a support request is filed: a task on the subject from one
 * outside line, and the `support_requests` row that links them. A member's
 * Make a card and a workspace's new support conversation both
 * come here.
 */
export async function fileSupportRequest(env: Env, input: {
  threadId: string;
  messageId: string;
  subject: { kind: SubjectKind; id: string };
  text: string;
  sender: string;
  actorEmail: string;
  title?: string;
}): Promise<SupportRequestCreateResponse> {
  const notes = `From ${input.sender} in the guest thread:\n\n${input.text}`.slice(0, NOTES_CHARS);
  const task = await createCrmTask(env, {
    title: input.title ?? requestTitle(input.text),
    notes,
    [taskFieldFor(input.subject.kind)]: input.subject.id,
    actor_email: input.actorEmail,
  });
  const request: SupportRequest = { task_id: task.id, message_id: input.messageId, created_at: Date.now() };
  await env.USAGE.prepare(
    `INSERT INTO support_requests (task_id, thread_id, message_id, subject_kind, subject_id, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  ).bind(task.id, input.threadId, input.messageId, input.subject.kind, input.subject.id, input.actorEmail, request.created_at).run();
  return { task, request };
}

/** The cards made from one guest thread's lines, for a member who can see its subject. */
export async function readSupportRequests(env: Env, owner: OwnerSession, threadId: string): Promise<SupportRequest[]> {
  const subject = await guestThreadSubject(env, threadId);
  if (!subject) throw new ControlError('Conversation not found.', 404, 'room_not_found');
  (await subjectAccessFor(env, owner)).requireSee(subject.kind, subject.id);
  const { results } = await env.USAGE.prepare(
    'SELECT task_id, message_id, created_at FROM support_requests WHERE thread_id = ?1 ORDER BY created_at',
  ).bind(threadId).all<SupportRequest>();
  return results;
}

/**
 * INBOX rows for guest threads whose last line came from outside and that
 * nobody here answered, on subjects this member can see. The key carries the
 * line's time, so a dismissed row comes back when a newer line arrives.
 */
export async function guestInboxItems(env: Env, owner: OwnerSession, dismissed: Set<string>): Promise<InboxItem[]> {
  const { results } = await env.USAGE.prepare(
    `SELECT id, parent_id, title, last_message_at, last_message_preview, last_sender_email, last_origin
       FROM threads
      WHERE kind = 'guest' AND removed_at IS NULL AND last_origin IN ('guest', 'peer', 'app') AND last_message_at IS NOT NULL
      ORDER BY last_message_at DESC LIMIT 100`,
  ).all<{
    id: string; parent_id: string | null; title: string | null; last_message_at: number;
    last_message_preview: string | null; last_sender_email: string | null; last_origin: 'guest' | 'peer' | 'app';
  }>();
  const access = await subjectAccessFor(env, owner);
  const items: InboxItem[] = [];
  for (const row of results) {
    const subject = parseGuestParent(row.parent_id);
    if (!subject || !access.canSee(subject.kind, subject.id)) continue;
    const key = `guest:${row.id}:${row.last_message_at}`;
    if (dismissed.has(key)) continue;
    items.push({
      source: 'guest',
      key,
      at: row.last_message_at,
      thread_id: row.id,
      // The thread's title is the subject's, with " · guests" after it.
      subject: { kind: subject.kind, id: subject.id, title: (row.title ?? '').replace(/ · guests$/u, '') },
      sender_email: row.last_sender_email,
      preview: row.last_message_preview,
      origin: row.last_origin,
    });
  }
  return items;
}
