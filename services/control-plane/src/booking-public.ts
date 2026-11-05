// A guest books a time on a member's page, on a workspace whose booking does
// not come from Core (docs/CORE_FOLD_PLAN.md §Phase 3d). The page
// (`web/src/ScheduleScreen.tsx`) reads the same shapes Core answers, so it does
// not change when a workspace leaves Core.
//
// Who is bookable: a member whose `people` row has a room and whose booking
// is on; sign-in fills that room from D1 first, then
// OWNER_ROOM_MAP. When: the
// member's booking settings and profile hours (booking-settings.ts), minus
// their Google busy time and the bookings in D1. The confirmation is the
// Google invite: the event is created with the guest as attendee, and Google
// mails it with the join link.

import {
  BOOKING_WEEKDAYS,
  scheduleBookSchema,
  type ScheduleBookResponse,
  type ScheduleManagedBooking,
} from '@starlings/contracts/booking-settings';
import { bookingRooms, readBookingSettings } from './booking-settings';
import type { CalendarAvailabilityBlock } from '@starlings/contracts/calendar';
import {
  bookableSlots,
  isKnownTimeZone,
  mergeSlotsIntoBlocks,
  zonedDateKey,
  zonedDayStart,
  type BookableSlot,
  type BusyInterval,
} from './booking-slots';
import {
  CalendarError,
  createCalendarEvent,
  deleteCalendarEvent,
  forgetMeetBooking,
  joinTokenFromUrl,
  ownBusyIntervals,
} from './calendar';
import { changeBookingInteraction, fileBookingInteraction } from './crm';
import { cancelBookingRow } from './booking-store';
import { fileBookingOnSubject, noteBookingCancelledOnSubject } from './booking-subject';
import { bookingNdaDocument, bookingNdaStatus, sendBookingNda, withdrawBookingNda } from './booking-nda';
import { coreApiOrigin, usesCore } from './work-store';
import { randomToken } from './crypto';
import { ControlError } from './errors';
import { workspacePublicOrigin } from './workspace-origins';
import type { OwnerSession } from './contracts';
import { assertWebOrigin, readBoundedText } from './http';
import { assertHumanJsonBody } from './turnstile';
import { memberAddresses } from './workspace-identity';
import { signUpPageURL } from './work-events';

const DAY = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 62;

/**
 * How long a D1 row holds its window by itself. After that, the Google event
 * is the only thing that does: a guest who declines, or a host who deletes
 * the event, frees the time without Meet hearing of it. The grace covers the
 * gap between the row and the event showing in Google's free/busy, and a
 * `pending` row whose Worker died before it could clean up.
 */
const CLAIM_GRACE_MS = 10 * 60 * 1000;

/** Answer one `/api/schedule/:slug/:action` request from D1. */
export async function routeD1Schedule(
  request: Request,
  env: Env,
  slug: string,
  action: string,
): Promise<Response> {
  const host = await bookingHost(env, slug);
  if (host === 'not_signed_in') return jsonError('This person is not taking bookings right now. Try again later.', 503);
  if (!host) return jsonError('Not found.', 404);
  const settings = await readBookingSettings(host, env);
  if (!settings.active) return jsonError('Not found.', 404);

  try {
    return await answer(request, env, host, slug, settings, action);
  } catch (error) {
    // The host's Google connection is gone or failing. The guest sees a state,
    // not the host's "connect Calendar" error; the host sees it in Settings.
    if (error instanceof CalendarError) {
      return jsonError(`${host.name} is not taking bookings right now. Try again later.`, 503);
    }
    throw error;
  }
}

async function answer(
  request: Request,
  env: Env,
  host: Host,
  slug: string,
  settings: Settings,
  action: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (action === 'book') {
    if (request.method !== 'POST') return jsonError('Method not allowed.', 405);
    return book(request, env, host, slug, settings);
  }
  if (request.method !== 'GET') return jsonError('Method not allowed.', 405);

  switch (action) {
    case 'info':
      return Response.json({
        display_name: host.name,
        title: null,
        description: null,
        duration_minutes: settings.duration_minutes,
        timezone: settings.timezone ?? 'UTC',
        working_hours: coreWorkingHours(settings.weekly_hours),
        // The page offers "Meet under NDA" only where the workspace has one.
        nda: (await bookingNdaDocument(env)) !== null,
      }, { headers: NO_STORE });
    case 'events': {
      const start = url.searchParams.get('startDate') ?? '';
      const end = url.searchParams.get('endDate') ?? '';
      if (!isDate(start) || !isDate(end) || end < start) return Response.json({ events: [] }, { headers: NO_STORE });
      return Response.json({ events: listed(await hostEvents(env, host, start, end)) }, { headers: NO_STORE });
    }
    case 'availability': {
      const date = url.searchParams.get('date') ?? '';
      const zone = guestZone(url);
      if (!isDate(date)) return jsonError('Date parameter is required (YYYY-MM-DD).', 400);
      const from = zonedDayStart(date, zone);
      const { slots, events } = await openSlots(env, host, settings, { from, to: zonedDayStart(nextDate(date), zone) });
      return Response.json({ date, timezone: zone, slots, events: events.filter((event) => event.date === date) }, { headers: NO_STORE });
    }
    case 'availability-calendar': {
      const start = url.searchParams.get('startDate') ?? '';
      const end = url.searchParams.get('endDate') ?? '';
      const zone = guestZone(url);
      if (!isDate(start) || !isDate(end) || end < start) return jsonError('startDate and endDate are required (YYYY-MM-DD).', 400);
      if (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`) > MAX_RANGE_DAYS * DAY) {
        return jsonError('The range is too long.', 400);
      }
      const { slots, events } = await openSlots(env, host, settings, {
        from: zonedDayStart(start, zone),
        to: zonedDayStart(nextDate(end), zone),
      });
      const open = new Set(slots.map((slot) => zonedDateKey(Date.parse(slot.start), zone)));
      const dateAvailability: Record<string, boolean> = {};
      for (let day = start; day <= end; day = nextDate(day)) dateAvailability[day] = open.has(day);
      return Response.json({ dateAvailability, events }, { headers: NO_STORE });
    }
    default:
      return jsonError('Not found.', 404);
  }
}

type Host = OwnerSession;
type Settings = Awaited<ReturnType<typeof readBookingSettings>>;

/**
 * The member whose room is `slug`, from the `people` rows. A
 * room in OWNER_ROOM_MAP whose member has never signed in here has no
 * calendar to book against yet: `not_signed_in`, which the page shows as not
 * taking bookings.
 */
async function bookingHost(env: Env, slug: string): Promise<Host | 'not_signed_in' | null> {
  const entry = (await bookingRooms(env)).find((candidate) => candidate.room === slug);
  if (!entry) return null;
  return (await hostForEmail(env, entry.email)) ?? 'not_signed_in';
}

/** A host's `people` row by any of their addresses on this workspace; null if revoked or never seen. */
export async function hostForEmail(env: Env, email: string): Promise<Host | null> {
  const addresses = memberAddresses(env, email);
  const row = await env.USAGE.prepare(
    `SELECT sub, email, name FROM people
      WHERE lower(email) IN (${addresses.map((_, index) => `?${index + 1}`).join(', ')})
        AND revoked_at IS NULL
      ORDER BY last_seen_at DESC LIMIT 1`,
  ).bind(...addresses).first<{ sub: string; email: string; name: string | null }>();
  if (!row) return null;
  return { sub: row.sub, email: row.email, name: row.name?.trim() || row.email };
}

/**
 * The slots a guest may book in `range`: the member's hours minus Google and
 * D1, and minus every day an in-person or hybrid public event they host
 * closes. Also those events, which the booking page lists.
 */
async function openSlots(
  env: Env,
  host: Host,
  settings: Settings,
  range: { from: number; to: number },
): Promise<{ slots: BookableSlot[]; events: PublicEvent[]; busy: BusyInterval[] }> {
  const now = Date.now();
  const zone = settings.timezone ?? 'UTC';
  const events = await hostEvents(env, host, zonedDateKey(range.from, zone), zonedDateKey(range.to, zone));
  const closed = new Set(events.filter(closesBookingDay).map((event) => event.date));
  const open = (slot: BookableSlot) => !closed.has(zonedDateKey(Date.parse(slot.start), zone));
  const candidates = bookableSlots(settings, [], range, now).filter(open);
  if (candidates.length === 0) return { slots: [], events: listed(events), busy: [] };
  const window = {
    from: Date.parse(candidates[0]!.start) - settings.buffer_minutes * 60_000,
    to: Date.parse(candidates[candidates.length - 1]!.end) + settings.buffer_minutes * 60_000,
  };
  const busy = await busyIntervals(env, host, window);
  return { slots: bookableSlots(settings, busy, range, now).filter(open), events: listed(events), busy };
}

/**
 * The events this host is at: the ones whose `host_emails` name them. An
 * event with no hosts closes nobody's day. On Envisioning they are the
 * published CMS events, read through Core; on a `d1` workspace they are the
 * workspace's own event rows. Fails closed: a booking page that cannot see the
 * events would offer a day an event has closed.
 */
async function hostEvents(env: Env, host: Host, start: string, end: string): Promise<PublicEvent[]> {
  if (!usesCore(env)) return d1HostEvents(env, host, start, end);
  const target = new URL(`${coreApiOrigin(env)}/api/public/meet-events`);
  target.searchParams.set('startDate', start);
  target.searchParams.set('endDate', end);
  target.searchParams.set('host', host.email.toLowerCase());
  const response = await fetch(target, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new CalendarError('Events are unavailable right now.', 502, 'calendar_failed');
  const body = (await response.json().catch(() => null)) as { events?: unknown } | null;
  return Array.isArray(body?.events) ? body.events.filter(isPublicEvent) : [];
}

interface PublicEvent {
  id: string;
  title: string;
  date: string;
  attendance?: string | null;
  cancelled?: boolean;
  /** A D1 event with no sign-up page: it closes the day, but the page does not name it. */
  unlisted?: boolean;
  [key: string]: unknown;
}

/** The events a guest may see: every one but the unlisted. */
function listed(events: PublicEvent[]): PublicEvent[] {
  return events.filter((event) => !event.unlisted);
}

/**
 * A `d1` workspace's own events this host is at, in the shape Core serves.
 * A D1 event is a work record, not a published one: only an event with a
 * sign-up page (a public slug and a room) is listed to the guest; the others
 * close the day without a name.
 */
async function d1HostEvents(env: Env, host: Host, start: string, end: string): Promise<PublicEvent[]> {
  const rows = await env.USAGE.prepare(
    `SELECT e.id, e.title, e.starts_on, e.starts_at, e.ends_at, e.location, e.attendance, e.public_slug, e.room_slug
       FROM events e
      WHERE e.starts_on >= ?2 AND e.starts_on <= ?3
        AND EXISTS (SELECT 1 FROM json_each(e.host_emails) h WHERE h.value = ?1)
      ORDER BY e.starts_on, e.starts_at`,
  ).bind(host.email.toLowerCase(), start, end).all<{
    id: string; title: string; starts_on: string; starts_at: number | null; ends_at: number | null;
    location: string | null; attendance: string | null; public_slug: string | null; room_slug: string | null;
  }>();
  return (rows.results ?? []).map((row) => {
    const page = row.public_slug && row.room_slug ? signUpPageURL(env, row.public_slug) : null;
    return {
      id: row.id,
      title: row.title,
      date: row.starts_on,
      starts_at: row.starts_at === null ? null : new Date(row.starts_at).toISOString(),
      ends_at: row.ends_at === null ? null : new Date(row.ends_at).toISOString(),
      is_all_day: row.starts_at === null,
      location: row.location,
      attendance: row.attendance,
      cancelled: false,
      signup_url: page,
      host: null,
      unlisted: page === null,
    };
  });
}

function isPublicEvent(value: unknown): value is PublicEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Record<string, unknown>;
  return typeof event.id === 'string' && typeof event.title === 'string' && typeof event.date === 'string';
}

/** Core's rule: an in-person or hybrid event closes its host's day to 1:1 slots. */
function closesBookingDay(event: PublicEvent): boolean {
  return event.cancelled !== true && (event.attendance === 'in_person' || event.attendance === 'hybrid');
}

/**
 * The member's own bookable time for their calendar's "My availability"
 * layer, on a workspace whose booking does not come from Core. The same
 * slots the booking page offers (`openSlots`): their hours minus Google, the
 * D1 bookings still holding a window, and the days an event closes. The range
 * is the calendar's `YYYY-MM-DD` days, widened by a day on each side so a zone
 * far from UTC still fills the days on screen.
 */
export async function ownBookableBlocks(
  env: Env,
  owner: OwnerSession,
  range: { start: string; end: string },
): Promise<CalendarAvailabilityBlock[]> {
  const settings = await readBookingSettings(owner, env);
  if (!settings.active) return [];
  const { slots, busy } = await openSlots(env, owner, settings, {
    from: Date.parse(`${range.start}T00:00:00Z`) - DAY,
    to: Date.parse(`${range.end}T00:00:00Z`) + 2 * DAY,
  });
  // A 30-minute meeting on a 60-minute step leaves 30 free minutes between
  // slots. Draw that as one block unless something busy sits in the gap.
  const step = settings.slot_step_minutes * 60_000;
  return mergeSlotsIntoBlocks(slots, (gap) => {
    const from = Date.parse(gap.start);
    const to = Date.parse(gap.end);
    return to - from < step && !busy.some((interval) => from < interval.end && to > interval.start);
  });
}

async function busyIntervals(env: Env, host: Host, window: { from: number; to: number }): Promise<BusyInterval[]> {
  const [google, booked] = await Promise.all([
    ownBusyIntervals(env, host, new Date(window.from).toISOString(), new Date(window.to).toISOString()),
    env.USAGE.prepare(
      `SELECT starts_at AS start, ends_at AS "end" FROM bookings
        WHERE owner_sub = ?1 AND status IN ('pending', 'confirmed') AND created_at > ?4
          AND starts_at < ?3 AND ends_at > ?2`,
    ).bind(host.sub, window.from, window.to, Date.now() - CLAIM_GRACE_MS).all<BusyInterval>(),
  ]);
  return [...google, ...(booked.results ?? [])];
}

async function book(request: Request, env: Env, host: Host, slug: string, settings: Settings): Promise<Response> {
  // Unauthenticated POST: origin, bound body, then Turnstile, as for Core.
  assertWebOrigin(request, env);
  const raw = await assertHumanJsonBody(request, env, await readBoundedText(request));
  const parsed = scheduleBookSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) return jsonError('Some booking details are missing or invalid.', 400);
  const input = parsed.data;

  const start = Date.parse(input.start_time);
  const end = start + settings.duration_minutes * 60_000;
  // A move names the booking it replaces; that one must still stand.
  const replacing = input.reschedule_token ? await managedRow(env, slug, input.reschedule_token) : null;
  if (input.reschedule_token && replacing?.status !== 'confirmed') {
    return jsonError('This booking link is not valid.', 404);
  }
  // A move keeps the NDA the first booking asked for: same request, no second mail.
  const carriedNda = replacing?.nda_request_id
    ? { document: replacing.nda_document_id, request: replacing.nda_request_id }
    : null;
  const ndaDocument = !carriedNda && input.requires_nda ? await bookingNdaDocument(env) : null;
  const ndaRequired = carriedNda !== null || ndaDocument !== null || replacing?.nda_required === 1;
  // The slot must be one the page offers now: inside the hours, past the
  // notice, within the horizon, clear of Google and of the other bookings.
  const { slots: offered } = await openSlots(env, host, settings, { from: start, to: end });
  if (!offered.some((slot) => Date.parse(slot.start) === start)) {
    return jsonError('This time is no longer available. Please pick another time.', 409);
  }

  // Claim the window in one statement, so two guests cannot take one slot
  // between the check above and the Google write below.
  const id = crypto.randomUUID();
  const manageToken = randomToken(24);
  const manageUrl = `${workspacePublicOrigin(env).replace(/\/$/u, '')}/book/${slug}?manage=${manageToken}`;
  const buffer = settings.buffer_minutes * 60_000;
  const claimed = await env.USAGE.prepare(
    `INSERT INTO bookings
       (id, owner_sub, room, starts_at, ends_at, guest_name, guest_email, guest_title,
        guest_organization, guest_notes, guest_timezone, status, created_at, manage_token,
        nda_required, rescheduled_at, previous_starts_at, previous_ends_at, nda_document_id, nda_request_id)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?12, ?15, ?16, ?17, ?18, ?19, ?20, ?21
      WHERE NOT EXISTS (
        SELECT 1 FROM bookings
         WHERE owner_sub = ?2 AND status IN ('pending', 'confirmed') AND created_at > ?14
           AND starts_at < ?5 + ?13 AND ends_at > ?4 - ?13
      )`,
  ).bind(
    id, host.sub, slug, start, end,
    input.guest_name, input.guest_email, input.guest_title, input.guest_organization,
    input.guest_notes ?? null, validZone(input.guest_timezone), Date.now(), buffer,
    Date.now() - CLAIM_GRACE_MS, manageToken,
    ndaRequired ? 1 : 0,
    replacing ? Date.now() : null, replacing?.starts_at ?? null, replacing?.ends_at ?? null,
    carriedNda?.document ?? null, carriedNda?.request ?? null,
  ).run();
  if ((claimed.meta.changes ?? 0) === 0) {
    return jsonError('This time is no longer available. Please pick another time.', 409);
  }

  let eventId: string | null = null;
  let joinToken: string | null = null;
  try {
    const event = await createCalendarEvent(env, host, {
      title: `${input.guest_name} and ${host.name}`,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      roomSlug: slug,
      attendees: [input.guest_email],
      description: [
        `Booked from ${host.name}'s booking page.`,
        `Guest: ${input.guest_name} <${input.guest_email}>`,
        `Topic: ${input.guest_title}`,
        `Organization: ${input.guest_organization}`,
        input.guest_notes ? `Notes: ${input.guest_notes}` : '',
        ndaRequired ? 'The guest asked to meet under NDA.' : '',
        `Cancel or reschedule: ${manageUrl}`,
      ].filter(Boolean).join('\n'),
      ...(settings.timezone ? { timeZone: settings.timezone } : {}),
      guestName: input.guest_name,
      guestEmail: input.guest_email,
      manageUrl,
      // Filed with Core below, with the guest's details.
      coreSync: false,
    });
    eventId = event.id;
    joinToken = event.joinUrl ? joinTokenFromUrl(event.joinUrl, slug) : null;
    await env.USAGE.prepare(
      `UPDATE bookings SET status = 'confirmed', google_event_id = ?2, join_url = ?3, join_token = ?4 WHERE id = ?1`,
    ).bind(id, event.id, event.joinUrl || null, joinToken).run();
  } catch (error) {
    // No event, no booking: free the window so the guest can try again.
    await env.USAGE.prepare('DELETE FROM bookings WHERE id = ?1').bind(id).run();
    if (eventId) {
      await deleteCalendarEvent(env, host, { calendarId: 'primary', eventId, notifyGuests: false }).catch(() => undefined);
    }
    throw error;
  }

  // On a workspace whose CRM is Core, Core files the booking's interaction,
  // keyed by the join token, so a call on that link merges into it. A move
  // keeps the first booking's interaction and moves it onto the new token,
  // unless that booking predates the route and has a host-issued row in Core.
  if (joinToken) {
    if (replacing?.join_token && !replacing.core_token) {
      await changeBookingInteraction(env, host, replacing.join_token, {
        action: 'moved',
        start_time: new Date(start).toISOString(),
        end_time: new Date(end).toISOString(),
        new_token: joinToken,
      });
    } else {
      await fileBookingInteraction(env, host, {
        token: joinToken,
        booking_id: id,
        title: `${input.guest_name} and ${host.name}`,
        start_time: new Date(start).toISOString(),
        end_time: new Date(end).toISOString(),
        google_event_id: eventId,
        guest: {
          name: input.guest_name,
          email: input.guest_email,
          title: input.guest_title,
          organization: input.guest_organization,
          notes: input.guest_notes ?? null,
        },
        nda_required: ndaRequired,
      });
    }
  }

  // On a workspace whose work model is its own, the booking lands on the
  // booker's subject.
  await fileBookingOnSubject(env, host, {
    id, google_event_id: eventId, guest_name: input.guest_name, guest_email: input.guest_email, starts_at: start,
  }, settings.timezone, replacing !== null);

  // The NDA goes once the booking stands, from Docs, as the host.
  let ndaSent = false;
  if (ndaDocument) {
    const requestId = await sendBookingNda(env, ndaDocument, host, { name: input.guest_name, email: input.guest_email });
    if (requestId) {
      await env.USAGE.prepare('UPDATE bookings SET nda_document_id = ?2, nda_request_id = ?3 WHERE id = ?1')
        .bind(id, ndaDocument, requestId).run();
      ndaSent = true;
    }
  }

  // A move: the old booking goes once the new one stands, never before.
  if (input.reschedule_token) await cancelManagedBooking(env, slug, input.reschedule_token, id).catch(() => undefined);

  return Response.json({
    success: true,
    booking: {
      id,
      start_time: new Date(start).toISOString(),
      end_time: new Date(end).toISOString(),
      guest_name: input.guest_name,
      guest_email: input.guest_email,
      ...(ndaDocument ? { nda_sent: ndaSent } : {}),
    },
  } satisfies ScheduleBookResponse, { headers: NO_STORE });
}

interface ManagedRow {
  id: string;
  owner_sub: string;
  starts_at: number;
  ends_at: number;
  guest_name: string;
  guest_email: string;
  status: 'pending' | 'confirmed' | 'cancelled';
  google_event_id: string | null;
  join_url: string | null;
  nda_required: number;
  nda_document_id: string | null;
  nda_request_id: string | null;
  join_token: string | null;
  core_token: string | null;
}

async function managedRow(env: Env, slug: string, token: string): Promise<ManagedRow | null> {
  return env.USAGE.prepare(
    `SELECT id, owner_sub, starts_at, ends_at, guest_name, guest_email, status, google_event_id, join_url,
            nda_required, nda_document_id, nda_request_id, join_token, core_token
       FROM bookings WHERE manage_token = ?1 AND room = ?2`,
  ).bind(token, slug).first<ManagedRow>();
}

/** The booking a manage link names, for the page that cancels or moves it. */
export async function readManagedBooking(env: Env, slug: string, token: string): Promise<Response> {
  const row = await managedRow(env, slug, token);
  if (!row || row.status === 'pending') return jsonError('This booking link is not valid.', 404);
  const host = row.nda_document_id && row.nda_request_id ? await hostBySub(env, row.owner_sub) : null;
  const nda = host && row.nda_document_id && row.nda_request_id
    ? await bookingNdaStatus(env, row.nda_document_id, host, row.nda_request_id)
    : null;
  return Response.json({
    booking: {
      start_time: new Date(row.starts_at).toISOString(),
      end_time: new Date(row.ends_at).toISOString(),
      guest_name: row.guest_name,
      status: row.status,
      nda,
    },
  } satisfies ScheduleManagedBooking, { headers: NO_STORE });
}

/**
 * Cancel the booking a manage link names: the Google event goes (Google tells
 * the guest), the join card stops answering, and the window is free. A second
 * cancel answers as the first did. `replacedBy` is the booking a guest's move
 * made, so INBOX shows the move and not a cancellation.
 */
export async function cancelManagedBooking(env: Env, slug: string, token: string, replacedBy: string | null = null): Promise<Response> {
  const row = await managedRow(env, slug, token);
  if (!row || row.status === 'pending') return jsonError('This booking link is not valid.', 404);
  if (row.status === 'confirmed') {
    const host = await hostBySub(env, row.owner_sub);
    // The row goes first, so the event's delete below finds no booking to
    // cancel and leaves a moved booking's NDA with the new one.
    await cancelBookingRow(env, row.id, replacedBy);
    if (host && row.google_event_id) {
      try {
        await deleteCalendarEvent(env, host, { calendarId: 'primary', eventId: row.google_event_id, notifyGuests: false });
      } catch (error) {
        // An event the guest or host already removed in Google is already cancelled.
        if (!(error instanceof ControlError && error.code === 'calendar_event_not_found')) {
          await env.USAGE.prepare(`UPDATE bookings SET status = 'confirmed', cancelled_at = NULL, replaced_by = NULL WHERE id = ?1`)
            .bind(row.id).run();
          throw error;
        }
      }
    }
    if (row.join_url) await forgetMeetBooking(env, slug, row.join_url);
    // A move carries the NDA and the CRM interaction to the new booking; a
    // cancel withdraws the NDA unless signed and marks the interaction.
    if (!replacedBy && host && row.nda_request_id) await withdrawBookingNda(env, host, row.nda_request_id);
    if (!replacedBy && host && row.join_token && !row.core_token) {
      await changeBookingInteraction(env, host, row.join_token, { action: 'cancelled' });
    }
    if (!replacedBy && host) {
      await noteBookingCancelledOnSubject(env, host, row);
    }
  }
  return Response.json({ ok: true }, { headers: NO_STORE });
}

async function hostBySub(env: Env, sub: string): Promise<Host | null> {
  const row = await env.USAGE.prepare('SELECT sub, email, name FROM people WHERE sub = ?1')
    .bind(sub)
    .first<{ sub: string; email: string; name: string | null }>();
  return row ? { sub: row.sub, email: row.email, name: row.name?.trim() || row.email } : null;
}

/** The seven days in Core's per-weekday shape, which the booking page reads. */
function coreWorkingHours(week: Settings['weekly_hours']) {
  const names = { mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday', sun: 'sunday' } as const;
  return Object.fromEntries(BOOKING_WEEKDAYS.map((day) => [names[day], {
    enabled: Boolean(week?.[day].enabled),
    start: clock(week?.[day].start_minute ?? 0),
    end: clock(week?.[day].end_minute ?? 0),
  }]));
}

function clock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function guestZone(url: URL): string {
  return validZone(url.searchParams.get('timezone')) ?? 'UTC';
}

function validZone(zone: string | null | undefined): string | null {
  const trimmed = zone?.trim();
  return trimmed && trimmed.length <= 64 && isKnownTimeZone(trimmed) ? trimmed : null;
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
}

const NO_STORE = { 'cache-control': 'no-store' };

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: NO_STORE });
}
