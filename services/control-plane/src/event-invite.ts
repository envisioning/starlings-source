/**
 * The calendar invite and the mails for an event sign-up (,
 * docs/SESSIONS.md §0 S3 and S5, §6 The calendar invite).
 *
 * The Meet Worker writes every invite and every mail on both stores; the
 * store keeps the records only. One invite per registrant, carrying that
 * registrant's own room link. `UID` is the stored `ics_uid` and `SEQUENCE` the
 * stored `ics_sequence`, so a re-send replaces the entry already in a
 * calendar instead of adding a second one.
 *
 * Mail copy is plain and short (docs/DESIGN.md copy law): no em dashes.
 */
import { sessionDescription, type SessionEventRecord } from '@starlings/contracts/event-signups';

// The one ICS generator lives in contracts, because the event page builds
// the same calendar entry after a new sign-up (SESSIONS.md S9).
export { buildSessionInvite, type SessionInviteInput } from '@starlings/contracts/event-calendar';

/** The content type mail clients read as an invite, not a file. */
export function inviteContentType(method: 'REQUEST' | 'CANCEL'): string {
  return `text/calendar; method=${method}; charset=utf-8`;
}

/** Base64 of UTF-8 text, for a mail attachment. */
export function base64Utf8(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The event's time in its own zone, 24-hour (AGENTS.md invariant 20):
 * "Tuesday 20 October 2026, 17:00 to 17:45 CEST". Without a zone, UTC.
 */
export function sessionTimeLine(event: Pick<SessionEventRecord, 'starts_at' | 'ends_at' | 'time_zone'>): string {
  const timeZone = event.time_zone ?? 'UTC';
  const day = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const zone = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'short' })
    .formatToParts(new Date(event.starts_at))
    .find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
  const start = new Date(event.starts_at);
  return `${day.format(start)}, ${clock.format(start)} to ${clock.format(new Date(event.ends_at))} ${zone}`;
}

/** The address inside a `Name <address>` sender. */
export function senderAddress(mailFrom: string): string {
  return /<([^>]+)>/u.exec(mailFrom)?.[1] ?? mailFrom.trim();
}

export function senderName(mailFrom: string): string {
  return /^([^<]+)</u.exec(mailFrom)?.[1]?.trim() || senderAddress(mailFrom);
}

function escapeHtml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

export interface SessionMail {
  subject: string;
  text: string;
  html: string;
}

/** A mail body as paragraphs; a paragraph that is a link renders as one. */
type Paragraph = string | { label: string; url: string };

function render(paragraphs: Paragraph[]): { text: string; html: string } {
  const text = paragraphs
    .map((paragraph) => (typeof paragraph === 'string' ? paragraph : `${paragraph.label}\n${paragraph.url}`))
    .join('\n\n');
  const html = paragraphs
    .map((paragraph) => (typeof paragraph === 'string'
      ? `<p>${escapeHtml(paragraph).replace(/\n/gu, '<br>')}</p>`
      : `<p><a href="${escapeHtml(paragraph.url)}">${escapeHtml(paragraph.label)}</a></p>`))
    .join('\n');
  return { text: `${text}\n`, html: `<!doctype html>\n<html><body>\n${html}\n</body></html>\n` };
}

function callToAction(event: Pick<SessionEventRecord, 'cta_url' | 'cta_label'>): Paragraph[] {
  if (!event.cta_url) return [];
  return [{ label: event.cta_label || event.cta_url, url: event.cta_url }];
}

/** The event's description, as one plain paragraph. Only the confirmation carries it. */
function description(event: Pick<SessionEventRecord, 'description'>): Paragraph[] {
  const text = sessionDescription(event.description);
  return text ? [text] : [];
}

/** Sent on sign-up, and again on a repeat sign-up: the time, the description, the link, the invite, the call to action. */
export function confirmationMail(event: SessionEventRecord, name: string, link: string): SessionMail {
  return {
    subject: `You’re signed up: ${event.title}`,
    ...render([
      `Hi ${name},`,
      `You’re signed up for ${event.title}.\n${sessionTimeLine(event)}`,
      ...description(event),
      { label: 'Join with your link', url: link },
      'This link is yours. The calendar invite is attached.',
      ...callToAction(event),
    ]),
  };
}

/** Sent once, an hour before the start: the link and the time. */
export function reminderMail(event: SessionEventRecord, name: string, link: string): SessionMail {
  return {
    subject: `Starting in an hour: ${event.title}`,
    ...render([
      `Hi ${name},`,
      `${event.title} starts in an hour.\n${sessionTimeLine(event)}`,
      { label: 'Join with your link', url: link },
    ]),
  };
}

/**
 * Sent when the host asks, to every registrant: the host's note, the call to
 * action, and a one-click unsubscribe link. No postal address
 * (decided by MZ, 2026-10-07).
 */
export function followUpMail(event: SessionEventRecord, name: string, note: string, unsubscribe: string): SessionMail {
  return {
    subject: `Thanks for signing up: ${event.title}`,
    ...render([
      `Hi ${name},`,
      note,
      ...callToAction(event),
      `You get this because you signed up for ${event.title}.`,
      { label: 'Unsubscribe from event follow-ups', url: unsubscribe },
    ]),
  };
}
