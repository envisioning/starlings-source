import { inboundMessageId, threadStub, appendInboundMessage } from './threads';
import { guestLinkURL, guestSub, mintGuestLink } from './guests';
import { sendMail } from './mail';
import { sha256 } from './crypto';
import { ControlError } from './errors';
import type { SupportIntakeSubmission } from '@starlings/contracts/support-intake';

const INTAKE_PARENT = 'organization:intake';
const INTAKE_TITLE = 'Contact';

/** Stable, private thread per sender, shared by the website and contact email. */
export async function supportThreadId(email: string): Promise<string> {
  return `gst_${(await sha256(`support-intake:${email.trim().toLowerCase()}`)).slice(0, 32)}`;
}

/** The form's first message; a retry with the same request_id is idempotent. */
export async function submitPublicSupport(
  env: Env,
  submission: SupportIntakeSubmission,
): Promise<{ ok: true }> {
  const { mailed } = await submitIntakeMessage(env, {
    name: submission.name,
    email: submission.email,
    message: submission.message,
    idempotencyKey: `site:${submission.request_id}`,
    mail: (name, link) => ({
      subject: 'Continue your message to Starlings',
      text: `Hi ${name},\n\nWe received your message. Open this private link to continue the conversation:\n\n${link}\n\nIf you did not send this message, you can ignore this email.`,
    }),
  });
  if (!mailed) throw new ControlError('We received your message but could not send its private link. Please retry.', 503);
  return { ok: true };
}

/**
 * One visitor message into their private intake thread, then the mail with
 * a private link that lets them continue it. Shared by `/support` and the
 * public forms that file a thread (docs/FORMS.md). `mailed` is false when the
 * link did not go out: the message is stored, and the guest grant is not
 * changed, so an older link keeps working.
 */
export async function submitIntakeMessage(
  env: Env,
  input: {
    name: string;
    email: string;
    message: string;
    idempotencyKey: string;
    /** The door, in the thread title: "Contact", "Website". */
    label?: string;
    mail: (name: string, link: string) => { subject: string; text: string; from?: string };
  },
): Promise<{ threadId: string; mailed: boolean }> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.replace(/\s+/gu, ' ').trim();
  const threadId = await supportThreadId(email);
  await ensureIntakeThread(env, threadId, name, input.label);
  await appendSupportMessage(env, { threadId, email, name, message: input.message, idempotencyKey: input.idempotencyKey });

  // The link proves control of the address and scopes the guest to this one
  // thread. A generic subject grant would let every intake contact read every
  // other contact's conversation.
  const link = await mintGuestLink();
  const mail = input.mail(name, guestLinkURL(env, link.token));
  const sent = await sendMail(env, { to: email, subject: mail.subject, text: mail.text, ...(mail.from ? { from: mail.from } : {}) }).catch(() => false);
  if (!sent) return { threadId, mailed: false };
  await grantSupportThread(env, email, threadId, link.hash);
  return { threadId, mailed: true };
}

/** An email sent to contact@ reaches the same private sender thread and Inbox. */
export async function recordInboundSupportEmail(
  env: Env,
  input: { email: string; name: string; message: string; messageId: string },
): Promise<{ threadId: string; messageId: string; duplicate: boolean }> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.replace(/\s+/gu, ' ').trim() || email.split('@')[0]!;
  const threadId = await supportThreadId(email);
  await ensureIntakeThread(env, threadId, name);
  return appendSupportMessage(env, {
    threadId,
    email,
    name,
    message: input.message,
    idempotencyKey: `email:${input.messageId}`,
  });
}

/**
 * The private intake thread on `organization:intake`, made on first use; a
 * later call refreshes its title. `label` names the door ("Contact", "App").
 */
export async function ensureIntakeThread(env: Env, threadId: string, name: string, label: string = INTAKE_TITLE): Promise<void> {
  const title = `${label} · ${name} · guests`;
  await threadStub(env, threadId).ensureThread({
    id: threadId,
    kind: 'guest',
    parentId: INTAKE_PARENT,
    audience: 'everyone',
    members: [],
  });
  await env.USAGE.prepare(
    `INSERT INTO threads (id, kind, parent_id, created_at, title, audience)
     VALUES (?1, 'guest', ?2, ?3, ?4, 'everyone')
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, removed_at = NULL, removed_by = NULL`,
  ).bind(threadId, INTAKE_PARENT, Date.now(), title).run();
}

async function appendSupportMessage(
  env: Env,
  input: { threadId: string; email: string; name: string; message: string; idempotencyKey: string },
): Promise<{ threadId: string; messageId: string; duplicate: boolean }> {
  const result = await appendInboundMessage(env, {
    threadId: input.threadId,
    messageId: await inboundMessageId(input.threadId, input.idempotencyKey),
    sender: { sub: guestSub(input.email), email: input.email, name: input.name },
    origin: { kind: 'guest', ref: guestSub(input.email) },
    text: input.message,
    type: 'text',
    refs: [],
  });
  return { threadId: input.threadId, messageId: result.messageId, duplicate: result.duplicate };
}

async function grantSupportThread(env: Env, email: string, threadId: string, linkHash: string): Promise<void> {
  const current = await env.USAGE.prepare(
    `SELECT id FROM subject_grants
      WHERE kind = 'organization' AND subject_id = 'intake'
        AND principal_kind = 'guest' AND principal_id = ?1 AND revoked_at IS NULL`,
  ).bind(email).first<{ id: string }>();
  const now = Date.now();
  if (current) {
    await env.USAGE.prepare(
      `UPDATE subject_grants
          SET role = 'write', granted_by = 'public-support', granted_at = ?2,
              link_hash = ?3, thread_id = ?4
        WHERE id = ?1`,
    ).bind(current.id, now, linkHash, threadId).run();
    return;
  }
  await env.USAGE.prepare(
    `INSERT INTO subject_grants
      (id, kind, subject_id, principal_kind, principal_id, role, granted_by, granted_at, link_hash, thread_id)
     VALUES (?1, 'organization', 'intake', 'guest', ?2, 'write', 'public-support', ?3, ?4, ?5)`,
  ).bind(`sgr_${crypto.randomUUID()}`, email, now, linkHash, threadId).run();
}
