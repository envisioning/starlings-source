// Event sign-up pages (docs/SESSIONS.md §0). An event with a room
// and a public slug has a page at /event/<slug>. A person signs up with a
// name and an address and gets a personal room link.
//
// One set of shapes for both stores (fold rule F1): D1 on a `d1` workspace,
// Core on Envisioning. The page, the endpoint, the mails, the join card and
// auto-admit do not know which store answered.
//
// Two kinds of shape live here. `SessionEvent` and the register input and
// answer reach a browser. The records (`SessionEventRecord`,
// `EventRegistrationRecord`, `EventRegistrationMailRecord`) stay in the
// Worker: they are what a store answers. Only the mail record carries an
// address, and no route sends it to a client.
import { z } from 'zod';
// Imported from index, not re-exported by it: consumers use
// `@starlings/contracts/event-signups`, which keeps this module out of a value cycle.
import { turnstileTokenSchema } from './index';

/** Registration closes at 90, leaving headroom under the room's 99 (SESSIONS.md decision 1). */
export const SESSION_REGISTRATION_CAP = 90;

/** Why a sign-up page takes no more sign-ups. */
export const SESSION_CLOSED_REASONS = ['started', 'full'] as const;
export const sessionClosedReasonSchema = z.enum(SESSION_CLOSED_REASONS);
export type SessionClosedReason = z.infer<typeof sessionClosedReasonSchema>;

/** The three mails (SESSIONS.md S5). Each has a sent-at stamp per registration. */
export const SESSION_MAIL_KINDS = ['confirmation', 'reminder', 'follow_up'] as const;
export const sessionMailKindSchema = z.enum(SESSION_MAIL_KINDS);
export type SessionMailKind = z.infer<typeof sessionMailKindSchema>;

/** An event's description: one or two sentences of plain text (docs/EVENTS_AGENT.md §What the agent writes). */
export const SESSION_DESCRIPTION_MAX = 500;

/** The event's long text, Markdown: the page shows it under About. */
export const SESSION_BODY_MAX = 20_000;

/** How a person attends (the CMS `attendance` column). A session event in a room is online. */
export const SESSION_ATTENDANCE = ['in_person', 'online', 'hybrid'] as const;
export const sessionAttendanceSchema = z.enum(SESSION_ATTENDANCE);
export type SessionAttendance = z.infer<typeof sessionAttendanceSchema>;

/** The page shows "N spots left" only at this many or fewer (MZ, 2026-10-05). */
export const SESSION_SPOTS_SHOWN_AT = 20;
/** The page shows "N going" only from this many registrations. Never names or faces. */
export const SESSION_GOING_SHOWN_FROM = 5;

/** A page slug: lower case letters, digits and hyphens. */
export const sessionSlugSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/u);

const isoTime = z.string().min(1);

/** What a store answers for a session event. Worker-internal. */
export const sessionEventRecordSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  /**
   * Plain text. A store that does not send the field reads as null, so Meet
   * and Core deploy in either order.
   */
  description: z.string().nullable().default(null),
  /** Markdown. Null on a store that does not send it, as `description`. */
  body: z.string().nullable().default(null),
  /** The cover image. */
  image_url: z.string().nullable().default(null),
  attendance: sessionAttendanceSchema.nullable().default(null),
  /** The length in minutes. Null where the store does not send it: the page reads it from the times. */
  duration_minutes: z.number().int().positive().nullable().default(null),
  starts_at: isoTime,
  ends_at: isoTime,
  time_zone: z.string().nullable(),
  room_slug: z.string().min(1),
  cta_url: z.string().nullable(),
  cta_label: z.string().nullable(),
  /** The host's note in the follow-up mail. Never sent to a browser. */
  follow_up_note: z.string().nullable(),
  /** Live registrations, for the cap. Never sent to a browser. */
  registration_count: z.number().int().nonnegative(),
  /**
   * The person who made the event, by person id, for the follow-up's
   * permission rule. Null where the store does not know (a CMS event).
   */
  created_by: z.string().nullable().optional(),
});
export type SessionEventRecord = z.infer<typeof sessionEventRecordSchema>;

/** POST /api/events/:id/follow-up → 200: how many follow-ups this call sent. */
export const eventFollowUpResponseSchema = z.object({
  sent: z.number().int().nonnegative(),
});
export type EventFollowUpResponse = z.infer<typeof eventFollowUpResponseSchema>;

/**
 * Who hosts the event: the room owner's name and photo, from Meet's own room
 * and people records on both stores, never free text. The photo is a path on
 * the workspace host.
 */
export const sessionHostSchema = z.object({
  name: z.string(),
  image_url: z.string().nullable(),
});
export type SessionHost = z.infer<typeof sessionHostSchema>;

/** The public projection: what the sign-up page reads. */
export const sessionEventSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string().max(SESSION_DESCRIPTION_MAX).nullable(),
  /** Markdown; the page renders it with the app's safe renderer. */
  body: z.string().max(SESSION_BODY_MAX).nullable(),
  /** An https cover image, or null. */
  image_url: z.string().nullable(),
  attendance: sessionAttendanceSchema.nullable(),
  duration_minutes: z.number().int().positive(),
  /** Null when the room has no owner with a name. */
  host: sessionHostSchema.nullable(),
  /** Null above 20 spots left, and when closed. */
  spots_left: z.number().int().nonnegative().nullable(),
  /** The count of sign-ups from 5; null under 5. Never names. */
  going: z.number().int().nonnegative().nullable(),
  starts_at: isoTime,
  ends_at: isoTime,
  time_zone: z.string().nullable(),
  room_slug: z.string(),
  cta_url: z.string().nullable(),
  cta_label: z.string().nullable(),
  open: z.boolean(),
  closed_reason: sessionClosedReasonSchema.nullable(),
});
export type SessionEvent = z.infer<typeof sessionEventSchema>;

/**
 * Open or closed, one rule for both stores: closed at the start, and full at
 * the cap. A store refuses a register on the same rule.
 */
export function sessionClosedReason(
  record: Pick<SessionEventRecord, 'starts_at' | 'registration_count'>,
  now: Date,
): SessionClosedReason | null {
  if (Date.parse(record.starts_at) <= now.getTime()) return 'started';
  if (record.registration_count >= SESSION_REGISTRATION_CAP) return 'full';
  return null;
}

/** A description as the page and the mail show it: trimmed, at most 500 characters, null when empty. */
export function sessionDescription(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text.slice(0, SESSION_DESCRIPTION_MAX).trimEnd() : null;
}

/** The body as the page shows it: trimmed, at most 20,000 characters, null when empty. */
export function sessionBody(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text.slice(0, SESSION_BODY_MAX).trimEnd() : null;
}

/** An image a browser may load: an https URL, else null. */
export function sessionImageURL(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  try {
    return new URL(text).protocol === 'https:' ? text : null;
  } catch {
    return null;
  }
}

/** The length in minutes: the store's value, else the time between start and end. */
export function sessionDurationMinutes(record: Pick<SessionEventRecord, 'duration_minutes' | 'starts_at' | 'ends_at'>): number {
  if (record.duration_minutes && record.duration_minutes > 0) return record.duration_minutes;
  const minutes = Math.round((Date.parse(record.ends_at) - Date.parse(record.starts_at)) / 60_000);
  return minutes > 0 ? minutes : 60;
}

/**
 * The record, cut to what a browser may see. Field by field, so a store
 * column added later cannot reach one. `host` comes from Meet's own records,
 * not from the store.
 */
export function sessionEventFromRecord(record: SessionEventRecord, now: Date, host: SessionHost | null = null): SessionEvent {
  const closed = sessionClosedReason(record, now);
  const left = Math.max(0, SESSION_REGISTRATION_CAP - record.registration_count);
  return {
    id: record.id,
    slug: record.slug,
    title: record.title,
    description: sessionDescription(record.description),
    body: sessionBody(record.body),
    image_url: sessionImageURL(record.image_url),
    attendance: record.attendance ?? null,
    duration_minutes: sessionDurationMinutes(record),
    host,
    spots_left: closed === null && left <= SESSION_SPOTS_SHOWN_AT ? left : null,
    going: record.registration_count >= SESSION_GOING_SHOWN_FROM ? record.registration_count : null,
    starts_at: record.starts_at,
    ends_at: record.ends_at,
    time_zone: record.time_zone,
    room_slug: record.room_slug,
    cta_url: record.cta_url,
    cta_label: record.cta_label,
    open: closed === null,
    closed_reason: closed,
  };
}

/** Inside [start − 15 min, end + 15 min]: the window a session arms and admits in (SESSIONS.md §7). */
export const SESSION_WINDOW_MARGIN_MS = 15 * 60_000;

export function sessionCovers(record: Pick<SessionEventRecord, 'starts_at' | 'ends_at'>, at: Date): boolean {
  return Date.parse(record.starts_at) - SESSION_WINDOW_MARGIN_MS <= at.getTime()
    && at.getTime() <= Date.parse(record.ends_at) + SESSION_WINDOW_MARGIN_MS;
}

/** What the sign-up form sends. */
export const eventRegistrationInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.string().trim().email().max(254),
  turnstile_token: turnstileTokenSchema.optional(),
});
export type EventRegistrationInput = z.infer<typeof eventRegistrationInputSchema>;

/**
 * The answer to a sign-up (decision S9, amends S3). A new registration gets
 * its personal link and its calendar id, so the page can show "Join with your
 * link" and "Add to calendar". A repeat address gets `join: null` and its
 * link only by mail, so typing another person's address never shows their
 * link.
 */
export const eventRegistrationJoinSchema = z.object({
  /** The registrant's own room link. */
  url: z.string(),
  /** The registration's calendar id: the `.ics` download is the same entry as the mail's invite. */
  ics_uid: z.string(),
  ics_sequence: z.number().int().nonnegative(),
});
export type EventRegistrationJoin = z.infer<typeof eventRegistrationJoinSchema>;

export const eventRegistrationResponseSchema = z.object({
  ok: z.literal(true),
  join: eventRegistrationJoinSchema.nullable(),
});
export type EventRegistrationResponse = z.infer<typeof eventRegistrationResponseSchema>;

/** One registration as a store answers it. Worker-internal; no address. */
export const eventRegistrationRecordSchema = z.object({
  id: z.string().min(1),
  event_id: z.string().min(1),
  name: z.string(),
  join_token: z.string().min(1),
  source: z.enum(['meet', 'luma']),
  status: z.enum(['registered', 'cancelled']),
  ics_uid: z.string().min(1),
  ics_sequence: z.number().int().nonnegative(),
  confirmation_sent_at: z.string().nullable(),
  reminder_sent_at: z.string().nullable(),
  follow_up_sent_at: z.string().nullable(),
  created_at: z.string(),
});
export type EventRegistrationRecord = z.infer<typeof eventRegistrationRecordSchema>;

/** A registration that needs a mail: the one record with the address. Worker-internal, never to a client. */
export const eventRegistrationMailRecordSchema = eventRegistrationRecordSchema.extend({
  email: z.string().min(1),
});
export type EventRegistrationMailRecord = z.infer<typeof eventRegistrationMailRecordSchema>;

/** A token, read for the join card and auto-admit. */
export const eventRegistrationResolutionSchema = z.object({
  id: z.string().min(1),
  event_id: z.string().min(1),
  status: z.enum(['registered', 'cancelled']),
  name: z.string(),
});
export type EventRegistrationResolution = z.infer<typeof eventRegistrationResolutionSchema>;

/** What a store does with a sign-up. */
export type SessionRegisterResult =
  | { kind: 'registered'; created: boolean; registration: EventRegistrationRecord }
  | { kind: 'refused'; reason: SessionClosedReason };

// ---------------------------------------------------------------------------
// The event record a member creates and edits in Work (,
// docs/SESSIONS.md §0 S8). One form and one contract for both stores: on a
// `d1` workspace the Worker writes the D1 row, on Envisioning it writes the
// CMS event through Core as the person. The form does not know the store.
//
// The time is what a person types: a day, a start and an end on a 24-hour
// clock, and the zone they mean. The Worker turns them into instants.

/** A public slug: lower case letters, digits and hyphens, at most 80. */
export const eventPublicSlugSchema = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/u, 'Use lower case letters, digits and hyphens.');

const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Use a YYYY-MM-DD date.');
const clockString = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, 'Use HH:MM on a 24-hour clock.');
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const httpsURL = z.string().trim().url().regex(/^https:\/\//iu, 'Use an https:// link.');

/** How people attend. An in-person or hybrid event closes its hosts' booking days. */
export const eventAttendanceSchema = z.enum(['in_person', 'online', 'hybrid']);
export type EventAttendance = z.infer<typeof eventAttendanceSchema>;

/** The members at the event, as lowercase emails. Empty: the event closes nobody's day. */
export const eventHostEmailsSchema = z.array(z.string().trim().toLowerCase().email().max(320)).max(20)
  .transform((list) => [...new Set(list)]);

/** The editable fields. `null` clears a field on an update. */
const workEventFields = {
  title: z.string().trim().min(1).max(200),
  /** One or two sentences of plain text. The sign-up page and the confirmation mail show it. */
  description: optionalText(SESSION_DESCRIPTION_MAX),
  /** Markdown. The sign-up page shows it under About. On Envisioning it is the CMS body. */
  body: optionalText(SESSION_BODY_MAX),
  date: dayString,
  start_time: clockString,
  end_time: clockString,
  /** An IANA zone, e.g. Europe/Amsterdam. */
  time_zone: z.string().trim().min(1).max(64),
  location: optionalText(200),
  url: httpsURL.nullable().optional(),
  notes: optionalText(5000),
  public_slug: eventPublicSlugSchema.nullable().optional(),
  /** One of the workspace's rooms (`GET /api/work/events/options`). */
  room_slug: z.string().trim().regex(/^[a-z0-9-]{2,40}$/u).nullable().optional(),
  cta_url: httpsURL.nullable().optional(),
  cta_label: optionalText(80),
  follow_up_note: optionalText(5000),
  attendance: eventAttendanceSchema.nullable().optional(),
  host_emails: eventHostEmailsSchema.optional(),
};

export const workEventCreateSchema = z.object(workEventFields);
export type WorkEventCreate = z.infer<typeof workEventCreateSchema>;

export const workEventUpdateSchema = z.object(workEventFields).partial();
export type WorkEventUpdate = z.infer<typeof workEventUpdateSchema>;

/** An event as the form reads it back. */
export const workEventSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  body: z.string().nullable(),
  date: z.string(),
  start_time: z.string().nullable(),
  end_time: z.string().nullable(),
  time_zone: z.string().nullable(),
  starts_at: z.string().nullable(),
  ends_at: z.string().nullable(),
  location: z.string().nullable(),
  url: z.string().nullable(),
  notes: z.string().nullable(),
  public_slug: z.string().nullable(),
  room_slug: z.string().nullable(),
  cta_url: z.string().nullable(),
  cta_label: z.string().nullable(),
  follow_up_note: z.string().nullable(),
  attendance: eventAttendanceSchema.nullable(),
  host_emails: z.array(z.string()),
  /** The sign-up page, once the event has a public slug and a room. */
  public_url: z.string().nullable(),
});
export type WorkEvent = z.infer<typeof workEventSchema>;

export const workEventResponseSchema = z.object({ event: workEventSchema });
export type WorkEventResponse = z.infer<typeof workEventResponseSchema>;

/**
 * What the form offers: the workspace's rooms, and whether this person may
 * create an event here. The Worker decides; the form does not know the store.
 */
export const workEventOptionsSchema = z.object({
  rooms: z.array(z.string()),
  can_create: z.boolean(),
});
export type WorkEventOptions = z.infer<typeof workEventOptionsSchema>;

/** The UTC offset of `zone` at `instant`, in minutes. */
function zoneOffsetMinutes(zone: string, instant: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUTC = Date.UTC(value('year'), value('month') - 1, value('day'), value('hour'), value('minute'), value('second'));
  return Math.round((asUTC - instant) / 60_000);
}

/** True when `zone` names an IANA time zone this runtime knows. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The instant a wall-clock `date` and `time` name in `zone`, as an ISO string. */
export function zonedInstant(date: string, time: string, zone: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes settle the offset across a daylight-saving change.
  let instant = wall - zoneOffsetMinutes(zone, wall) * 60_000;
  instant = wall - zoneOffsetMinutes(zone, instant) * 60_000;
  return new Date(instant).toISOString();
}

/** The wall-clock day and time of an instant in `zone`. */
export function zonedWallClock(iso: string, zone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(iso));
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return { date: `${value('year')}-${value('month')}-${value('day')}`, time: `${value('hour')}:${value('minute')}` };
}

/**
 * A CMS event's page slug: the title cut to 64 characters and the first 8
 * characters of the id, as Core's `eventSlug` and the organisation's site write it.
 * Core keys the lookup on the id part, so a title edit does not break a link
 * (fold rule F7: Envisioning's page stays `/event/<CMS slug>`).
 */
export function cmsEventSlug(title: string, id: string): string {
  const titleSlug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 64)
    .replace(/-+$/gu, '') || 'event';
  const idSlug = id.replace(/[^a-zA-Z0-9]/gu, '').slice(0, 8).toLowerCase();
  return idSlug ? `${titleSlug}-${idSlug}` : titleSlug;
}
