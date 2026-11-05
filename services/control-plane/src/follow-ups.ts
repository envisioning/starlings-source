/**
 * After the call. The notes engine drafts a follow-up for the
 * people outside the workspace and proposes the call's tasks; the host reviews
 * both in one INBOX row and approves. Approve accepts the ticked tasks,
 * declines the rest, and answers the mail draft, which the host's own mail app
 * opens. Starlings sends nothing (docs/PRIVACY.md).
 *
 * The draft lives beside the transcript in the meeting's room; D1 keeps only
 * `meeting_follow_ups`, the pointer INBOX reads (migration 0107).
 */
import {
  INBOX_FOLLOW_UP_LIMIT,
  type InboxFollowUpItem,
} from '@starlings/contracts/inbox';
import type { MeetingFollowUpApprove, MeetingFollowUpApproveResponse } from '@starlings/contracts';
import type { RoleSession } from './capabilities';
import { roomStub } from './do-jurisdiction';
import { outsideRecipients } from './deliveries';
import { updateCrmTask } from './crm';
import { ControlError } from './errors';

const lower = (email: string) => email.trim().toLowerCase();

interface PointerRow {
  meeting_id: string;
  room_slug: string;
  subject_kind: string;
  subject_id: string;
  subject_title: string;
  created_at: number;
  expires_at: number;
}

/** The host's open follow-ups, newest first. Only the host: nobody else's mail. */
export async function followUpInboxItems(env: Env, owner: RoleSession): Promise<InboxFollowUpItem[]> {
  const rows = (await env.USAGE.prepare(
    `SELECT meeting_id, room_slug, subject_kind, subject_id, subject_title, created_at, expires_at
       FROM meeting_follow_ups
      WHERE host_email = ?1 AND state = 'open' AND expires_at > ?2
      ORDER BY created_at DESC LIMIT ?3`,
  ).bind(lower(owner.email), Date.now(), INBOX_FOLLOW_UP_LIMIT).all<PointerRow>()).results ?? [];
  const items: InboxFollowUpItem[] = [];
  for (const row of rows) {
    const view = await (await roomStub(env, row.room_slug)).followUpView(row.meeting_id);
    const followUp = view?.followUp;
    // Answered somewhere the pointer did not hear about: settle it here.
    if (!view || !followUp || followUp.approvedAt || followUp.dismissedAt) {
      await settle(env, row.meeting_id, followUp?.approvedAt ? 'approved' : 'dismissed');
      continue;
    }
    const recipients = outsideRecipients(env, { participants: view.participants });
    if (recipients.length === 0) continue;
    items.push({
      source: 'followup',
      key: `followup:${row.meeting_id}`,
      at: followUp.writtenAt || row.created_at,
      meeting: { room_slug: row.room_slug, id: row.meeting_id, title: view.title },
      subject: { kind: row.subject_kind as InboxFollowUpItem['subject']['kind'], id: row.subject_id, title: row.subject_title },
      recipients,
      draft: followUp.draft,
      revision: followUp.revision,
      tasks: view.tasks,
      expires_at: row.expires_at,
    });
  }
  return items;
}

async function settle(env: Env, meetingId: string, state: 'approved' | 'dismissed'): Promise<void> {
  await env.USAGE.prepare("UPDATE meeting_follow_ups SET state = ?2 WHERE meeting_id = ?1 AND state = 'open'")
    .bind(meetingId, state).run();
}

/**
 * The host approves one revision of the draft. Only this meeting's own
 * proposed tasks move; an id from anywhere else is refused before anything
 * is written. A task Core will not move is reported, and the approval stands.
 */
export async function approveFollowUp(
  env: Env,
  roomSlug: string,
  meetingId: string,
  input: MeetingFollowUpApprove,
  actor: string,
): Promise<MeetingFollowUpApproveResponse> {
  const room = await roomStub(env, roomSlug);
  const view = await room.followUpView(meetingId);
  if (!view?.followUp) throw new ControlError('This meeting has no follow-up.', 404, 'meeting_not_found');
  const own = new Set(view.tasks.map((task) => task.id));
  const named = [...input.accept_task_ids, ...input.decline_task_ids];
  if (named.some((id) => !own.has(id)) || new Set(named).size !== named.length) {
    throw new ControlError('Only this call’s proposed tasks, each once.', 400, 'invalid_request');
  }
  await room.approveFollowUp(meetingId, input.revision);
  await settle(env, meetingId, 'approved');
  const failed: string[] = [];
  const decide = async (id: string, status: 'pending' | 'declined') => {
    try {
      await updateCrmTask(env, id, { status, actor_email: actor });
    } catch {
      failed.push(id);
    }
  };
  for (const id of input.accept_task_ids) await decide(id, 'pending');
  for (const id of input.decline_task_ids) await decide(id, 'declined');
  return {
    ok: true,
    mail: { to: outsideRecipients(env, { participants: view.participants }).map((person) => person.email), subject: input.subject, body: input.body },
    failed_task_ids: failed,
  };
}

/** The host does not want it. The tasks stay where they are, in INBOX. */
export async function dismissFollowUp(env: Env, roomSlug: string, meetingId: string): Promise<void> {
  await (await roomStub(env, roomSlug)).dismissFollowUp(meetingId);
  await settle(env, meetingId, 'dismissed');
}
