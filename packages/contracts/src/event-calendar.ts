/**
 * The calendar entry for one event registration (docs/SESSIONS.md §0 S3 and
 * S9, §6 The calendar invite). The one ICS generator: the Worker attaches its
 * output to the confirmation mail, and the event page builds the `.ics`
 * download and the Google and Outlook links from the same function after a
 * new sign-up. `UID` is the registration's stored `ics_uid`, so the mail's
 * invite and a downloaded file are the same calendar entry.
 *
 * Pure and without zod: the event page loads it.
 */

export interface SessionCalendarEvent {
  title: string;
  starts_at: string;
  ends_at: string;
}

export interface SessionInviteInput {
  uid: string;
  sequence: number;
  /** REQUEST and CANCEL go in a mail; PUBLISH is a file a person adds by hand. */
  method: 'REQUEST' | 'CANCEL' | 'PUBLISH';
  event: SessionCalendarEvent;
  /** The registrant's own room link: the location, the URL and the notes. */
  url: string;
  /** The sending address: Gmail and Outlook distrust an invite whose organizer is not the sender. A mail invite only. */
  organizer?: { name: string; email: string };
  /** The registrant. A mail invite only. */
  attendee?: { name: string; email: string };
  now?: Date;
}

/** `20261020T150000Z`: a UTC time as RFC 5545 writes it. */
export function icsTime(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}/u, '');
}

/** Escape a TEXT value (RFC 5545 §3.3.11). */
function icsText(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/;/gu, '\\;').replace(/,/gu, '\\,').replace(/\r?\n/gu, '\\n');
}

/** A parameter value: quoted, without the characters a quoted value may not hold. */
function icsParam(value: string): string {
  return `"${value.replace(/["\r\n]/gu, '')}"`;
}

/** Fold a content line at 75 octets (RFC 5545 §3.1), never inside a UTF-8 sequence. */
function fold(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = '';
  let size = 0;
  for (const char of line) {
    const bytes = encoder.encode(char).length;
    const limit = parts.length === 0 ? 75 : 74;
    if (size + bytes > limit) {
      parts.push(current);
      current = '';
      size = 0;
    }
    current += char;
    size += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

/** One VCALENDAR with one VEVENT, CRLF line ends. */
export function buildSessionInvite(input: SessionInviteInput): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Starlings//Event sign-up//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${input.method}`,
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `SEQUENCE:${input.sequence}`,
    `DTSTAMP:${icsTime((input.now ?? new Date()).toISOString())}`,
    `DTSTART:${icsTime(input.event.starts_at)}`,
    `DTEND:${icsTime(input.event.ends_at)}`,
    `SUMMARY:${icsText(input.event.title)}`,
    `LOCATION:${icsText(input.url)}`,
    `URL:${input.url}`,
    `DESCRIPTION:${icsText(input.url)}`,
    ...(input.organizer ? [`ORGANIZER;CN=${icsParam(input.organizer.name)}:mailto:${input.organizer.email}`] : []),
    ...(input.attendee
      ? [`ATTENDEE;CN=${icsParam(input.attendee.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${input.attendee.email}`]
      : []),
    `STATUS:${input.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(input.event.title)}`,
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

/** A Google Calendar link that opens a new entry with the title, the time, and the link as location and notes. */
export function googleCalendarURL(event: SessionCalendarEvent, url: string): string {
  const target = new URL('https://calendar.google.com/calendar/render');
  target.searchParams.set('action', 'TEMPLATE');
  target.searchParams.set('text', event.title);
  target.searchParams.set('dates', `${icsTime(event.starts_at)}/${icsTime(event.ends_at)}`);
  target.searchParams.set('location', url);
  target.searchParams.set('details', url);
  return target.toString();
}

/** An Outlook on the web link that opens a new entry with the same fields. */
export function outlookCalendarURL(event: SessionCalendarEvent, url: string): string {
  const target = new URL('https://outlook.live.com/calendar/0/deeplink/compose');
  target.searchParams.set('path', '/calendar/action/compose');
  target.searchParams.set('rru', 'addevent');
  target.searchParams.set('subject', event.title);
  target.searchParams.set('startdt', new Date(event.starts_at).toISOString());
  target.searchParams.set('enddt', new Date(event.ends_at).toISOString());
  target.searchParams.set('location', url);
  target.searchParams.set('body', url);
  return target.toString();
}
