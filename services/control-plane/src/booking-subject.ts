// A booking lands on the booker's subject, on a workspace whose
// work model is its own D1. The booker is matched by address: the contact
// with that email, else the organization whose website is on the address's
// domain (never a personal mail domain). The booking's Google event is filed
// under that subject the way a member files a calendar event
// (`eventSubjects`, keyed `event:g:<google_event_id>`), and the subject's
// channel gets one quiet line. A booker with no subject stays in INBOX until
// the member files it. On a workspace whose CRM is Core, Core files the
// booking's interaction instead (`fileBookingInteraction`), so nothing here
// runs there.

import { PERSONAL_MAIL_DOMAINS } from '@starlings/contracts/signup';
import type { CalendarEventSubject } from '@starlings/contracts/calendar';
import { getCalendarPreferences, setCalendarPreferences } from './calendar';
import type { OwnerSession } from './contracts';
import { workModelEnabled } from './crm';
import { postSubjectEvent } from './threads';
import { usesCore } from './work-store';

interface BookingOnSubject {
  id: string;
  google_event_id: string | null;
  guest_name: string;
  guest_email: string;
  starts_at: number;
}

function eventKey(googleEventId: string): string {
  return `event:g:${googleEventId}`;
}

function filesHere(env: Env): boolean {
  return !usesCore(env) && workModelEnabled(env);
}

/** The organization the booker belongs to, by contact address, then by website domain. */
async function bookerSubject(env: Env, email: string): Promise<CalendarEventSubject | null> {
  const address = email.trim().toLowerCase();
  const contact = await env.USAGE.prepare(
    `SELECT o.id, o.name FROM contacts c JOIN organizations o ON o.id = c.organization_id
      WHERE lower(c.email) = ?1 LIMIT 1`,
  ).bind(address).first<{ id: string; name: string }>();
  if (contact) return { kind: 'organization', id: contact.id, title: contact.name };
  const domain = address.split('@')[1] ?? '';
  if (!domain || PERSONAL_MAIL_DOMAINS.has(domain)) return null;
  const { results } = await env.USAGE.prepare(
    `SELECT id, name, url FROM organizations WHERE url IS NOT NULL AND lower(url) LIKE ?1 LIMIT 20`,
  ).bind(`%${domain}%`).all<{ id: string; name: string; url: string }>();
  const match = (results ?? []).find((row) => {
    try {
      const host = new URL(row.url.includes('://') ? row.url : `https://${row.url}`).hostname.toLowerCase();
      return host === domain || host.endsWith(`.${domain}`);
    } catch {
      return false;
    }
  });
  return match ? { kind: 'organization', id: match.id, title: match.name } : null;
}

function when(startsAt: number, zone: string | null): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    timeZone: zone ?? 'UTC', timeZoneName: 'short',
  }).format(new Date(startsAt));
}

/**
 * File a confirmed booking on the booker's subject. `moved` says the guest
 * moved an earlier booking. Best effort: the booking stands either way.
 */
export async function fileBookingOnSubject(
  env: Env,
  host: OwnerSession,
  booking: BookingOnSubject,
  zone: string | null,
  moved: boolean,
): Promise<void> {
  if (!filesHere(env) || !booking.google_event_id) return;
  try {
    const subject = await bookerSubject(env, booking.guest_email);
    if (!subject) return;
    const prefs = await getCalendarPreferences(env, host);
    await setCalendarPreferences(env, host, {
      eventSubjects: { ...prefs.eventSubjects, [eventKey(booking.google_event_id)]: subject },
    });
    const verb = moved ? 'moved their booking to' : 'booked';
    await postSubjectEvent(env, subject, `${booking.guest_name} ${verb} ${when(booking.starts_at, zone)}`, [], {
      dedupeKey: `booking:${booking.id}`,
    });
  } catch (error) {
    console.warn(`booking.subject.failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Say on the booker's subject that the booking is cancelled, when it was filed there. */
export async function noteBookingCancelledOnSubject(
  env: Env,
  host: OwnerSession,
  booking: BookingOnSubject,
): Promise<void> {
  if (!filesHere(env) || !booking.google_event_id) return;
  try {
    const zone = (await env.USAGE.prepare('SELECT timezone FROM people WHERE sub = ?1')
      .bind(host.sub).first<{ timezone: string | null }>())?.timezone ?? null;
    const subject = (await getCalendarPreferences(env, host)).eventSubjects[eventKey(booking.google_event_id)];
    if (!subject || subject.kind !== 'organization') return;
    await postSubjectEvent(env, subject, `${booking.guest_name} cancelled their booking for ${when(booking.starts_at, zone)}`, [], {
      dedupeKey: `booking:${booking.id}:cancelled`,
    });
  } catch (error) {
    console.warn(`booking.subject.failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
