/**
 * Sign-up and its mails (, docs/SESSIONS.md §0 S3 and S5).
 * The Meet Worker owns the token, the invite and every mail on both stores;
 * the store keeps the records, through the seam in `event-signups.ts`.
 *
 * Every mail goes to one registrant and names nobody else. Never log a token
 * or an address here: a failure logs the mail kind and Postmark's status.
 */
import { roomPermalink } from '@starlings/contracts/paths';
import { sessionClosedReason, type EventRegistrationJoin, type SessionEventRecord } from '@starlings/contracts/event-signups';
import { randomToken } from './crypto';
import { ControlError } from './errors';
import {
  base64Utf8,
  buildSessionInvite,
  confirmationMail,
  followUpMail,
  reminderMail,
  inviteContentType,
  senderAddress,
  senderName,
  type SessionMail,
} from './event-invite';
import {
  registerForSession,
  registrationsNeedingMail,
  sessionEventsStarting,
  stampSessionMail,
} from './event-signups';
import { workModelEnabled } from './crm';
import { refusedFollowUps, unsubscribeLink } from './event-mail-opt-outs';
import { sendMail } from './mail';
import { workspacePublicOrigin } from './workspace-origins';

/** The registrant's own room link, on the workspace's public link host (AGENTS.md invariant 13). */
export function personalRoomLink(env: Env, event: Pick<SessionEventRecord, 'room_slug'>, token: string): string {
  return roomPermalink(workspacePublicOrigin(env), event.room_slug, token);
}

/** A calendar id no other registration has, on the workspace's host. */
function newIcsUid(env: Env): string {
  return `${crypto.randomUUID()}@${new URL(workspacePublicOrigin(env)).host}`;
}

/** Send one session mail. True when Postmark took it; false when mail is off (dev, tests). */
export async function sendSessionMail(
  env: Env,
  kind: 'confirmation' | 'reminder' | 'follow_up',
  to: string,
  mail: SessionMail,
  invite?: { ics: string },
  headers?: Record<string, string>,
): Promise<boolean> {
  try {
    return await sendMail(env, {
      to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      ...(invite ? { attachments: [{ name: 'invite.ics', content: base64Utf8(invite.ics), contentType: inviteContentType('REQUEST') }] } : {}),
      ...(headers ? { headers } : {}),
    });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'event_signup.mail_failed', kind, reason: error instanceof Error ? error.message : 'unknown' }));
    throw new ControlError('Couldn’t send the email. Try again.', 502);
  }
}

/**
 * The register endpoint's work: mint a token, register through the seam
 * (idempotent by address), and send the confirmation with the calendar
 * invite. A repeat sign-up sends the confirmation again, with the first
 * token and the same calendar id.
 *
 * The answer is the link and the calendar id for a new registration only
 * (SESSIONS.md S9). A repeat address gets null: its link goes only to the
 * address, so typing another person's address never shows their link.
 */
export async function registerOnSignupPage(
  env: Env,
  event: SessionEventRecord,
  person: { name: string; email: string },
  now: Date = new Date(),
): Promise<EventRegistrationJoin | null> {
  if (sessionClosedReason(event, now) === 'started') throw new ControlError('Sign-up is closed.', 409);
  const result = await registerForSession(env, event, {
    name: person.name,
    email: person.email,
    // The booking-token minter (calendar.ts `attachMeetBooking`): the same
    // grammar, so `/room/<slug>/<token>` reads it.
    join_token: randomToken(16),
    ics_uid: newIcsUid(env),
  }, now);
  if (result.kind === 'refused') throw new ControlError('Sign-up is closed.', 409);

  const registration = result.registration;
  const link = personalRoomLink(env, event, registration.join_token);
  const email = person.email.trim().toLowerCase();
  const ics = buildSessionInvite({
    uid: registration.ics_uid,
    sequence: registration.ics_sequence,
    method: 'REQUEST',
    event,
    url: link,
    organizer: { name: senderName(env.MAIL_FROM), email: senderAddress(env.MAIL_FROM) },
    attendee: { name: registration.name || person.name, email },
    now,
  });
  const sent = await sendSessionMail(env, 'confirmation', email, confirmationMail(event, registration.name || person.name, link), { ics });
  if (sent) await stampSessionMail(env, registration.id, 'confirmation', now);
  return result.created ? { url: link, ics_uid: registration.ics_uid, ics_sequence: registration.ics_sequence } : null;
}

/** How far ahead the reminder looks: one hour before the start (SESSIONS.md §0 mail rules). */
const REMINDER_LEAD_MS = 60 * 60_000;

/**
 * The reminder sweep, from the Worker's scheduled handler (every five
 * minutes). Each registration on an event that starts within the next hour
 * gets one reminder: the stamp is taken first, so two ticks never send twice,
 * and a cancelled registration is not in the list. The sweep asks the seam,
 * never Core directly (fold rule F1).
 */
export async function sendDueReminders(env: Env, now: number = Date.now()): Promise<number> {
  if (!workModelEnabled(env)) return 0;
  const events = await sessionEventsStarting(env, new Date(now), new Date(now + REMINDER_LEAD_MS));
  let sent = 0;
  for (const event of events) {
    for (const registration of await registrationsNeedingMail(env, event.id, 'reminder')) {
      if (!(await stampSessionMail(env, registration.id, 'reminder', new Date(now)))) continue;
      const link = personalRoomLink(env, event, registration.join_token);
      try {
        if (await sendSessionMail(env, 'reminder', registration.email, reminderMail(event, registration.name, link))) sent += 1;
      } catch {
        // Logged in sendSessionMail without the address. The stamp stays:
        // a reminder late is worth less than a reminder twice.
      }
    }
  }
  return sent;
}

/**
 * The follow-up, sent when the host asks: to every registration that is not
 * cancelled and has not had it, whether the person came or not. The body is
 * the event's note and its call to action. Refused when the note is empty.
 */
export async function sendFollowUps(env: Env, event: SessionEventRecord, now: Date = new Date()): Promise<number> {
  const note = event.follow_up_note?.trim();
  if (!note) throw new ControlError('Write a follow-up note on the event first.', 409, 'invalid_request');
  let sent = 0;
  for (const registration of await registrationsNeedingMail(env, event.id, 'follow_up')) {
    // An address that unsubscribed gets no follow-up from this workspace.
    if (await refusedFollowUps(env, registration.email)) continue;
    if (!(await stampSessionMail(env, registration.id, 'follow_up', now))) continue;
    const link = await unsubscribeLink(env, registration.email, now.getTime());
    // RFC 8058: a mail client's own unsubscribe button POSTs the same link.
    const headers = { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
    if (await sendSessionMail(env, 'follow_up', registration.email, followUpMail(event, registration.name, note, link), undefined, headers)) sent += 1;
  }
  return sent;
}
