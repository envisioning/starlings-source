// What the calendar routes answer. The Worker builds these from Google,
// EventKit never touches them, and the web and the native clients read
// them: one shape per row, generated into Swift from here.
//
// Requests (`calendarEventCreateSchema`, `calendarPreferencesSchema`, the
// queries) stay in `index.ts` beside the other request bodies.
import { z } from 'zod';
import { acceptingKindAliases } from './crm';

export * from './calendar-values';

/**
 * What `event_subjects` holds per event, and what a served event carries.
 * An organization is its organization id with kind `organization`. The kinds are
 * `subjectKindsWith('calendarEvents')` in subject-kinds.ts; a test pins them.
 */
export const calendarEventSubjectSchema = z.object({
  kind: acceptingKindAliases(z.enum(['project', 'lead', 'organization'])),
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(200),
});
export type CalendarEventSubject = z.infer<typeof calendarEventSubjectSchema>;

/** Company meaning layered onto an otherwise ordinary writable calendar. */
export const calendarSemanticRoleSchema = z.enum(['ordinary', 'global_interest']);
export type CalendarSemanticRole = z.infer<typeof calendarSemanticRoleSchema>;

export const calendarAttendeeStatusSchema = z.enum(['accepted', 'declined', 'tentative', 'needsAction', 'unknown']);
export type CalendarAttendeeStatus = z.infer<typeof calendarAttendeeStatusSchema>;

export const calendarAttendeeSummarySchema = z.object({
  name: z.string(),
  /** Lowercased email when Google provides one; empty for name-only rows. */
  email: z.string(),
  /** Present when the address matched a canonical Core CRM contact. */
  inCrm: z.boolean().optional(),
  /** Canonical Core contact page when the address matched a CRM contact. */
  crmUrl: z.string().optional(),
  status: calendarAttendeeStatusSchema,
  optional: z.boolean(),
  self: z.boolean(),
});
export type CalendarAttendeeSummary = z.infer<typeof calendarAttendeeSummarySchema>;

/**
 * Video platform inferred from links on the event. `starlings` is a room on
 * this workspace. `envisioning` is its old name: the Worker no
 * longer sends it, and it stays one release so a cached answer still parses.
 */
export const calendarMeetingPlatformSchema = z.enum(['starlings', 'google_meet', 'zoom', 'teams', 'webex', 'other', 'none', 'envisioning']);
export type CalendarMeetingPlatform = z.infer<typeof calendarMeetingPlatformSchema>;

export const calendarEventSummarySchema = z.object({
  id: z.string(),
  calendarId: z.string(),
  calendarSummary: z.string(),
  htmlLink: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  joinUrl: z.string(),
  roomSlug: z.string(),
  isMeetEvent: z.boolean(),
  attendees: z.array(calendarAttendeeSummarySchema),
  /** True when the connected Google account is the event organizer. */
  organizerSelf: z.boolean(),
  platform: calendarMeetingPlatformSchema,
  /** Best URL to open for that platform (Envisioning room, Meet, Zoom, …). */
  conferenceUrl: z.string(),
  /** True when Google stored this as a date-only (all-day) event. */
  allDay: z.boolean(),
  /**
   * Series id when this row is one expanded instance of a recurring event.
   * We list with `singleEvents=true`, so this is the only signal a client gets
   * that editing the row can mean "this one" or "the whole series".
   */
  recurringEventId: z.string(),
  /** True when this row belongs to a recurring series. */
  recurring: z.boolean(),
  /** Free-text notes. Clients must round-trip this rather than drop it. */
  description: z.string(),
  /** Location as stored by Google: a room, an address, or a call URL. */
  location: z.string(),
  /**
   * IANA zone Google stored on the event's start, when it has one (a timed
   * event made in another zone). Absent for all-day events and older cached
   * rows. Lets a tile say `12:05 (10:05 GMT)` when the event was made
   * somewhere else.
   */
  startTimeZone: z.string().optional(),
  /** Explicit travel duration from the event's metadata, in whole minutes. */
  travelTimeMinutes: z.number().int().nullable(),
  /** Owner-wide "not for me" state. */
  demoted: z.boolean(),
  calendarRole: calendarSemanticRoleSchema,
  /** The project or lead this event is about, from the owner's preferences. */
  subject: calendarEventSubjectSchema.nullable(),
});
export type CalendarEventSummary = z.infer<typeof calendarEventSummarySchema>;

export const googleCalendarListEntrySchema = z.object({
  id: z.string(),
  summary: z.string(),
  primary: z.boolean(),
  selected: z.boolean(),
  writable: z.boolean(),
  /** Which connected account this calendar came from, and under whose address. */
  accountId: z.string(),
  accountEmail: z.string(),
  backgroundColor: z.string().optional(),
});
export type GoogleCalendarListEntry = z.infer<typeof googleCalendarListEntrySchema>;

/** `GET /api/calendar/status`, and the answer to a connect. */
export const calendarStatusSchema = z.object({
  connected: z.boolean(),
  email: z.string().optional(),
  /**
   * True when the member has any calendar the server can read: the primary
   * Google account, another Google account, or an `.ics` subscription. Only on
   * `GET /api/calendar/status`. Apple Calendar is on the device, so a client
   * adds it itself. The Calendar tab shows by this (`surface-visibility.ts`).
   */
  sources: z.boolean().optional(),
  /**
   * Only on the answer to a connect. KV is eventually consistent and caches
   * "no such key", so a client that lists calendars straight after connecting
   * can be told there is no token yet. This list was fetched with the access
   * token the exchange itself minted, which needs no read from KV at all.
   */
  calendars: z.array(googleCalendarListEntrySchema).optional(),
});
export type CalendarStatus = z.infer<typeof calendarStatusSchema>;

/** `GET /api/calendar/calendars` */
export const googleCalendarListResponseSchema = z.object({
  calendars: z.array(googleCalendarListEntrySchema),
});
export type GoogleCalendarListResponse = z.infer<typeof googleCalendarListResponseSchema>;

/**
 * A Google account whose calendars this owner reads.
 *
 * The owner's own account is the primary one and keeps the storage it always
 * had; anything added afterwards — a personal Gmail, a second workspace — is an
 * additional account, kept beside it. Additional accounts are calendar data and
 * nothing more: they never establish who the user is, and no session is ever
 * minted from one.
 */
export const calendarAccountSchema = z.object({
  id: z.string(),
  email: z.string(),
  connectedAt: z.number().int(),
  primary: z.boolean(),
  /**
   * False when the account is attached but its refresh token is gone — it died
   * and `accessTokenFor` dropped it. The account stays listed so the owner can
   * see it and reconnect it, instead of being told it is "already connected"
   * by a list that no longer shows it anywhere.
   */
  connected: z.boolean(),
});
export type CalendarAccount = z.infer<typeof calendarAccountSchema>;

/** `GET /api/calendar/accounts` */
export const calendarAccountListResponseSchema = z.object({
  accounts: z.array(calendarAccountSchema),
});
export type CalendarAccountListResponse = z.infer<typeof calendarAccountListResponseSchema>;

/** `POST /api/calendar/accounts/connect/exchange` */
export const calendarAccountResponseSchema = z.object({
  account: calendarAccountSchema,
  /** The account's calendars, listed with the token the exchange minted — the same head start `CalendarStatus.calendars` gives. */
  calendars: z.array(googleCalendarListEntrySchema).optional(),
});
export type CalendarAccountResponse = z.infer<typeof calendarAccountResponseSchema>;

/** A published `.ics` feed the owner wants drawn beside their own calendars. */
export const calendarSubscriptionSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string(),
  color: z.string(),
  addedAt: z.number().int(),
});
export type CalendarSubscription = z.infer<typeof calendarSubscriptionSchema>;

export const calendarSubscriptionListResponseSchema = z.object({
  subscriptions: z.array(calendarSubscriptionSchema),
});
export type CalendarSubscriptionListResponse = z.infer<typeof calendarSubscriptionListResponseSchema>;

export const calendarSubscriptionResponseSchema = z.object({
  subscription: calendarSubscriptionSchema,
});
export type CalendarSubscriptionResponse = z.infer<typeof calendarSubscriptionResponseSchema>;

export const subscriptionEventSummarySchema = z.object({
  id: z.string(),
  subscriptionId: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  allDay: z.boolean(),
  location: z.string(),
  description: z.string(),
  url: z.string(),
  recurring: z.boolean(),
});
export type SubscriptionEventSummary = z.infer<typeof subscriptionEventSummarySchema>;

/** `GET /api/calendar/subscriptions/events` */
export const subscriptionEventsResponseSchema = z.object({
  events: z.array(subscriptionEventSummarySchema),
});
export type SubscriptionEventsResponse = z.infer<typeof subscriptionEventsResponseSchema>;

/** `GET` and `PUT /api/calendar/preferences`: the owner's stored calendar choices, whole. */
/** Owner-wide Upcoming display policy, read and written whole. */
export const upcomingPreferencesSchema = z.object({
  horizon_days: z.number().int().min(1).max(30),
  home_following_rows: z.number().int().min(0).max(5),
  show_tomorrow: z.boolean(),
});
export type UpcomingPreferences = z.infer<typeof upcomingPreferencesSchema>;

export const calendarPreferencesResponseSchema = z.object({
  selected_calendar_ids: z.array(z.string()),
  /** Subscribed feeds opted out of Home's shared Upcoming feed. New feeds are included by default. */
  upcoming_excluded_subscription_ids: z.array(z.string()).optional(),
  hidden_calendar_keys: z.array(z.string()),
  disabled_calendar_keys: z.array(z.string()),
  demoted_event_keys: z.array(z.string()),
  includes_local_calendars: z.boolean(),
  event_subjects: z.record(z.string(), calendarEventSubjectSchema),
  upcoming: upcomingPreferencesSchema,
});
export type CalendarPreferencesResponse = z.infer<typeof calendarPreferencesResponseSchema>;

/** `POST /api/calendar/events` (201), `PATCH /api/calendar/event`, `POST .../event/move`, `.../event/respond`, `POST /api/calendar/pending/:id/add` (201). */
export const calendarEventResponseSchema = z.object({
  event: calendarEventSummarySchema,
});
export type CalendarEventResponse = z.infer<typeof calendarEventResponseSchema>;

/** `GET /api/calendar/events`, `/upcoming`, `/invitations`. */
export const calendarEventsResponseSchema = z.object({
  events: z.array(calendarEventSummarySchema),
});
export type CalendarEventsResponse = z.infer<typeof calendarEventsResponseSchema>;

/** `POST /api/calendar/booking-token` (201). */
export const calendarBookingMintResponseSchema = z.object({
  token: z.string(),
  join_url: z.string(),
});
export type CalendarBookingMintResponse = z.infer<typeof calendarBookingMintResponseSchema>;

/**
 * When one person is busy. Opaque on purpose: free/busy is the only calendar
 * read that crosses between people, so it carries no titles or guests.
 */
export const calendarBusyIntervalSchema = z.object({
  start: z.string(),
  end: z.string(),
});
export type CalendarBusyInterval = z.infer<typeof calendarBusyIntervalSchema>;

export const calendarFreeBusyPersonSchema = z.object({
  email: z.string(),
  busy: z.array(calendarBusyIntervalSchema),
  /**
   * Why this person came back empty. Google answers per calendar, and "no
   * access" and "genuinely free" both look like an empty list — a scheduling
   * UI that cannot tell them apart will confidently propose a slot that is
   * already taken.
   */
  error: z.string(),
});
export type CalendarFreeBusyPerson = z.infer<typeof calendarFreeBusyPersonSchema>;

/** `POST /api/calendar/free-busy` */
export const calendarFreeBusyResponseSchema = z.object({
  people: z.array(calendarFreeBusyPersonSchema),
});
export type CalendarFreeBusyResponse = z.infer<typeof calendarFreeBusyResponseSchema>;

/** One bookable block of the owner's own time, from Core's public availability. */
export const calendarAvailabilityBlockSchema = z.object({
  start: z.string(),
  end: z.string(),
});
export type CalendarAvailabilityBlock = z.infer<typeof calendarAvailabilityBlockSchema>;

/** `GET /api/calendar/availability`. Core unreachable answers empty and says so. */
export const calendarAvailabilityResponseSchema = z.object({
  blocks: z.array(calendarAvailabilityBlockSchema),
  degraded: z.boolean().optional(),
});
export type CalendarAvailabilityResponse = z.infer<typeof calendarAvailabilityResponseSchema>;

/**
 * The public projection of a Meet-minted booking: what the invite page shows
 * the holder of the token. `GET /api/rooms/:slug/bookings/:token`.
 */
export const meetMintedBookingProjectionSchema = z.object({
  title: z.string().nullable(),
  /** The guest's own "what should we cover?" from the booking form. */
  subject: z.string().nullable(),
  starts_at: z.string().nullable(),
  ends_at: z.string().nullable(),
  status: z.enum(['scheduled', 'cancelled']),
  /**
   * Absolute links to Core's reschedule and cancel pages. Meet does not
   * implement either: both change the booking row, the Google Calendar event
   * and the CRM interaction, so they live in one place.
   */
  reschedule_url: z.string().nullable(),
  cancel_url: z.string().nullable(),
  /**
   * The holder's own name and email, so the join form is filled in. A
   * forwarded link reveals them, which docs/ROOM_ENTRY.md accepts.
   */
  guest_name: z.string().nullable(),
  guest_email: z.string().nullable(),
  /**
   * True when the token is a registration for an event sign-up
   * (docs/SESSIONS.md §0, §8): the join form starts with mic and camera off.
   */
  session: z.boolean().optional(),
});
export type StarlingsMintedBookingProjection = z.infer<typeof meetMintedBookingProjectionSchema>;
