// The owner's day, on the web. Same feed, same rules, and the same words as
// the iOS Home tab (`iOS/MeetingFeed.swift`, `MobileMeetingCountdown`) — Home
// is "today" on every client, and two clients that phrase the same meeting
// differently read as two products. What "today" means is not decided here:
// `@starlings/contracts/upcoming` decides it for all three, against the shared table
// in `fixtures/upcoming-tiers.json`.
//
// Home reads the agenda; Calendar adds event editing through the same owner API.

import {
  SUBSCRIBED_ACCOUNT_KEY,
  accountKey,
  eventDemotionKey as demotionKey,
  googleAccountTitle,
  googleCalendarKey,
  withAccountHidden as withAccountKeyHidden,
  withCalendarHidden as withCalendarKeyHidden,
} from '@starlings/contracts/calendar-keys';
import { CALENDAR_LAYERS, CALENDAR_RSVP_ANSWERS, rawCalendarEventId, type CalendarLayerId } from '@starlings/contracts/calendar-values';
import type { CalendarEventSubject } from '@starlings/contracts';
import type {
  CalendarAttendeeSummary,
  CalendarEventSummary,
  CalendarSubscriptionListResponse,
  SubscriptionEventSummary,
  SubscriptionEventsResponse,
} from '@starlings/contracts/calendar';
import {
  canJoin,
  classifyUpcoming,
  closedDaySummary,
  DEFAULT_UPCOMING_PREFERENCES,
  heroLabel,
  normalizeUpcomingPreferences,
  UPCOMING_CONFIG,
  type UpcomingEventShape,
  type UpcomingPreferences,
  type UpcomingPlan,
  type UpcomingTier,
} from '@starlings/contracts/upcoming';
import { apiBase } from './config';
import { apiFetch } from './api';
import { compactDuration, formatTime } from './meeting-time';
import { t, dateLocale } from './i18n';
import { eventHref, subjectHref, subjectTaskHref, taskHref, workSubjectOf } from './work-hrefs';
import { isWorkspaceMemberEmail } from './workspace-identity';
import { workspaceBrand } from './workspace-brand';
import { isStarlingsRoom } from './meeting-platform';

export { heroLabel };

/** The closed day's sentence, from the contract's parts, in the page's language. */
export function closedDaySummaryLabel<E extends UpcomingEventShape>(plan: UpcomingPlan<E>): string {
  const summary = closedDaySummary(plan);
  switch (summary.kind) {
    case 'empty': return t('Nothing scheduled today or tomorrow.');
    case 'today': return t('Nothing left today.');
    case 'tomorrow':
      if (summary.time) {
        return summary.count === 1
          ? t('Nothing left today. 1 tomorrow, at {time}.', { time: summary.time })
          : t('Nothing left today. {count} tomorrow, first at {time}.', { count: summary.count, time: summary.time });
      }
      return summary.count === 1
        ? t('Nothing left today. 1 tomorrow.')
        : t('Nothing left today. {count} tomorrow.', { count: summary.count });
  }
}
export { UPCOMING_CONFIG as upcomingConfig };
export type { UpcomingPlan, UpcomingTier };

/**
 * The subset of the served `CalendarEventSummary` this surface renders,
 * named from the contract so a field the Worker renames fails the build
 * here too. Everything the page reads is required; what it may not have on
 * an older row stays optional.
 */
export type WebCalendarEvent = Pick<
  CalendarEventSummary,
  | 'id' | 'title' | 'start' | 'end' | 'calendarId' | 'calendarSummary' | 'location' | 'platform'
  | 'conferenceUrl' | 'joinUrl' | 'htmlLink' | 'roomSlug' | 'demoted' | 'allDay'
> & Partial<Pick<CalendarEventSummary, 'travelTimeMinutes' | 'startTimeZone' | 'description' | 'recurring' | 'recurringEventId' | 'subject' | 'calendarRole'>> & {
  attendees: WebCalendarAttendee[];
  /**
   * Set by the calendar page, not the wire: this row stands in for a
   * published Envisioning event with the same title and times.
   */
  published?: boolean;
};

/** The attendee as this surface reads it: the contract's row. */
export type WebCalendarAttendee = CalendarAttendeeSummary;

export type CalendarConnection = { connected: boolean; email?: string };

export async function fetchUpcoming(): Promise<WebCalendarEvent[]> {
  const body = await apiFetch<{ events: WebCalendarEvent[] }>(
    '/calendar/upcoming',
    { fallbackError: t('Couldn’t load your calendar.'), noStore: true },
  );
  return body.events ?? [];
}

/** The company-wide CMS event projection used by Home's optional EVENTS card. */
export async function fetchPublicEvents(): Promise<PublicCalendarEvent[]> {
  const start = startOfDay(new Date());
  const end = addDays(start, 120);
  const body = await apiFetch<{ events?: PublicCalendarEvent[] }>(
    `/public/events?startDate=${encodeURIComponent(calendarDay(start))}&endDate=${encodeURIComponent(calendarDay(end))}`,
    { fallbackError: t('Couldn’t load published events.'), noStore: true },
  );
  return body.events ?? [];
}

/** An answer to an invitation: an INBOX `invitation` row, or the Calendar's inspector. */
export type CalendarRSVP = 'accepted' | 'declined' | 'tentative';

/** The answers an invitation takes, in the order every surface lists them. */
export const CALENDAR_RSVP_CHOICES: ReadonlyArray<{ response: CalendarRSVP; title: string }> =
  CALENDAR_RSVP_ANSWERS.map((answer) => ({ response: answer.response, title: t(answer.title) }));

export async function respondToCalendarInvitation(
  event: Pick<WebCalendarEvent, 'calendarId' | 'id'>,
  response: CalendarRSVP,
): Promise<WebCalendarEvent> {
  const body = await apiFetch<{ event: WebCalendarEvent }>('/calendar/event/respond', {
    method: 'POST',
    body: { calendar_id: event.calendarId, event_id: rawCalendarEventId(event.calendarId, event.id), response },
    fallbackError: t('Couldn’t send your answer.'),
    noStore: true,
  });
  return body.event;
}

/**
 * Events proposed from mail forwarded to calendar@, answered from
 * their INBOX `forwarded` row: Add writes the event, Discard drops the row.
 */
export async function addPendingCalendarEvent(id: string): Promise<WebCalendarEvent> {
  const body = await apiFetch<{ event: WebCalendarEvent }>(`/calendar/pending/${encodeURIComponent(id)}/add`, {
    method: 'POST',
    body: {},
    fallbackError: t('Couldn’t add the event.'),
    noStore: true,
  });
  return body.event;
}

export async function discardPendingCalendarEvent(id: string): Promise<void> {
  await apiFetch<{ ok: true }>(`/calendar/pending/${encodeURIComponent(id)}/discard`, {
    method: 'POST',
    body: {},
    fallbackError: t('Couldn’t discard the event.'),
    noStore: true,
  });
}

export async function fetchCalendarConnection(): Promise<CalendarConnection> {
  return apiFetch<CalendarConnection>('/calendar/status', {
    fallbackError: t('Couldn’t check your calendar connection.'),
    noStore: true,
  });
}

/**
 * Google's own consent screen, and back here afterwards. The refresh token is
 * exchanged and stored by the control plane — it never reaches this browser.
 */
export function calendarConnectHref(returnTo = '/'): string {
  return `${apiBase}/calendar/connect/start?return_to=${encodeURIComponent(returnTo)}`;
}

/**
 * The day, read the same way the Mac and the phone read it: what is on the
 * agenda, which part of the day each row belongs to, and which one — if any —
 * is the hero. The rules are shared (`@starlings/contracts/upcoming`) and pinned to
 * `fixtures/upcoming-tiers.json`; this page only decides how to draw them.
 */
export function upcomingPlan(
  events: WebCalendarEvent[],
  now = Date.now(),
  preferences: UpcomingPreferences = DEFAULT_UPCOMING_PREFERENCES,
): UpcomingPlan<WebCalendarEvent> {
  return classifyUpcoming(events, { now, preferences });
}

/** Everything still relevant, soonest first. */
export function agendaEvents(events: WebCalendarEvent[], now = Date.now()): WebCalendarEvent[] {
  return upcomingPlan(events, now).agenda;
}

/** The agenda narrowed to meetings you can actually open — ours, Meet, Zoom, anyone's. */
export function joinableMeetings(events: WebCalendarEvent[], now = Date.now()): WebCalendarEvent[] {
  return agendaEvents(events, now).filter(
    (event) => isVideoMeeting(event) && Number.isFinite(Date.parse(event.start)),
  );
}

/**
 * What the countdown runs on: the meeting under way, else the soonest still to
 * come *today*. `undefined` is a closed day — the card says so rather than
 * counting down fourteen hours to tomorrow's standup as though it were next.
 */
export function nextMeeting(events: WebCalendarEvent[], now = Date.now()): WebCalendarEvent | undefined {
  return upcomingPlan(events, now).focus;
}

export function isVideoMeeting(event: WebCalendarEvent): boolean {
  return event.platform !== 'none' && eventLaunchURL(event) !== '';
}

export function isStarlingsMeet(event: WebCalendarEvent): boolean {
  return isStarlingsRoom(event.platform);
}

export function isInProgress(event: WebCalendarEvent, now = Date.now()): boolean {
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  return Number.isFinite(start) && Number.isFinite(end) && start <= now && end > now;
}

/**
 * Where a Home row goes: the event's permalink on the Calendar page. The page
 * opens it after its week is in, and `day` tells it which week that is.
 */
export function calendarEventHref(event: Pick<WebCalendarEvent, 'id' | 'start'>): string {
  const start = new Date(event.start);
  return eventHref(event.id, Number.isNaN(start.getTime()) ? undefined : calendarDay(start));
}

/** The inverse of `calendarEventHref`'s `day`: a local civil day, or null. */
export function parseCalendarDay(value: string | null): Date | null {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value) : null;
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function eventLaunchURL(event: WebCalendarEvent): string {
  // `htmlLink` is the calendar event page, not a conference destination. In
  // particular, an address may contain a Google Maps URL; it must never turn
  // an in-person event into an Open video action.
  return event.conferenceUrl || event.joinUrl || '';
}

/** Attendees for the row; the owner is implied and is not repeated. */
export function participantAttendees(event: WebCalendarEvent): WebCalendarAttendee[] {
  const people: WebCalendarAttendee[] = [];
  const seen = new Set<string>();
  for (const attendee of event.attendees ?? []) {
    if (attendee.self) continue;
    const name = attendee.name.trim();
    const key = (attendee.email || name).trim().toLocaleLowerCase();
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    people.push(attendee);
  }
  // Match the native calendar lists: people outside the workspace first, then
  // colleagues. The owner is implied and never appears in either group.
  return [
    ...people.filter((attendee) => !attendeeIsMember(attendee)),
    ...people.filter(attendeeIsMember),
  ];
}

/**
 * Who else is on an event, folded to one mark — the same three answers
 * `CalendarAttendance` gives on the Mac and the phone. `null` when the owner
 * is alone. A guest who declined drops out of the confirmed check.
 */
export type CalendarAttendance = 'confirmed' | 'pending' | 'declined';

export function attendanceOf(event: Pick<WebCalendarEvent, 'attendees'>): CalendarAttendance | null {
  const others = (event.attendees ?? []).filter((attendee) => !attendee.self);
  if (others.length === 0) return null;
  const coming = others.filter((attendee) => attendee.status !== 'declined');
  if (coming.length === 0) return 'declined';
  return coming.every((attendee) => attendee.status === 'accepted') ? 'confirmed' : 'pending';
}

export const ATTENDANCE_LABEL: Record<CalendarAttendance, string> = {
  confirmed: t('Guests confirmed'),
  pending: t('Guests pending'),
  declined: t('Guests declined'),
};

/** The same company mark rule used by CalendarAttendeeSummary on native. */
/** True when any address on the row is on this workspace's member domains. */
export function attendeeIsMember(attendee: WebCalendarAttendee): boolean {
  return [attendee.email, attendee.name].some((value) =>
    (value.match(/[^\s<>@:]+@[^\s<>]+/gu) ?? []).some((address) => isWorkspaceMemberEmail(address)),
  );
}

export function attendeeStatusLabel(status: WebCalendarAttendee['status']): string {
  switch (status) {
    case 'accepted': return 'Accepted';
    case 'declined': return 'Declined';
    case 'tentative': return 'Tentative';
    case 'needsAction': return 'Pending';
    default: return t('Unknown');
  }
}

/** Attendee names for callers that only need the visible name. */
export function participantNames(event: WebCalendarEvent): string[] {
  return participantAttendees(event).map((attendee) => attendee.name.trim());
}

/** The primary Envisioning calendar is already named by the page. */
export function calendarSourceLabel(event: WebCalendarEvent): string {
  const summary = event.calendarSummary.trim();
  // The workspace's own calendar needs no label.
  return summary.toLocaleLowerCase() === workspaceBrand().name.toLocaleLowerCase() ? '' : summary;
}

/**
 * Google can return the same event once per selected calendar. Calendar rows
 * are about the appointment, not the backing copy, so collapse same-title,
 * same-time entries and retain the useful links and attendee names from both.
 */
export function combineIdenticalEvents(
  events: WebCalendarEvent[],
  writableCalendarIds: ReadonlySet<string> = new Set(),
): WebCalendarEvent[] {
  const combined = new Map<string, WebCalendarEvent>();
  for (const event of events) {
    const key = identicalEventKey(event);
    const current = combined.get(key);
    if (!current) {
      combined.set(key, event);
      continue;
    }
    const preferred = preferEvent(current, event, writableCalendarIds);
    const other = preferred === current ? event : current;
    combined.set(key, {
      ...preferred,
      htmlLink: preferred.htmlLink || other.htmlLink,
      joinUrl: preferred.joinUrl || other.joinUrl,
      roomSlug: preferred.roomSlug || other.roomSlug,
      conferenceUrl: preferred.conferenceUrl || other.conferenceUrl,
      platform: preferred.platform !== 'none' ? preferred.platform : other.platform,
      location: preferred.location || other.location,
      travelTimeMinutes: preferred.travelTimeMinutes ?? other.travelTimeMinutes ?? null,
      description: preferred.description || other.description || '',
      attendees: combineAttendees(preferred.attendees, other.attendees),
      demoted: preferred.demoted || other.demoted,
      recurring: preferred.recurring || other.recurring || false,
      subject: preferred.subject ?? other.subject ?? null,
      calendarRole: preferred.calendarRole === 'global_interest' || other.calendarRole === 'global_interest'
        ? 'global_interest'
        : 'ordinary',
    });
  }
  return [...combined.values()];
}

/**
 * A published event the owner also has on Google is one appointment, not two.
 * The projection carries no Google id, so the match is the same title at the
 * same instants. The Google row stays, marked `published`: it has the join
 * link and the edit path. The layer row it replaces is dropped.
 */
export function splitMirroredLayerItems(
  layers: WebCalendarLayerItem[],
  events: WebCalendarEvent[],
): { layers: WebCalendarLayerItem[]; events: WebCalendarEvent[] } {
  const published = new Set(layers
    .filter((item) => item.kind === 'events')
    .map((item) => appointmentKey(item.title, item.allDay, item.start, item.end)));
  if (published.size === 0) return { layers, events };
  const covered = new Set<string>();
  const marked = events.map((event) => {
    const key = appointmentKey(event.title, event.allDay, event.start, event.end);
    if (!published.has(key)) return event;
    covered.add(key);
    return { ...event, published: true };
  });
  if (covered.size === 0) return { layers, events };
  return {
    layers: layers.filter((item) => item.kind !== 'events'
      || !covered.has(appointmentKey(item.title, item.allDay, item.start, item.end))),
    events: marked,
  };
}

function appointmentKey(title: string, allDay: boolean, start: string, end: string): string {
  const instant = (value: string) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? String(parsed) : value.trim();
  };
  return [title.trim().toLocaleLowerCase(), allDay ? 'all-day' : 'timed', instant(start), instant(end)].join('|');
}

function identicalEventKey(event: WebCalendarEvent): string {
  const instant = (value: string) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? String(parsed) : value.trim();
  };
  // Same title/time is not enough: an Envisioning room and a Teams meeting can
  // be deliberately scheduled back-to-back, or two calendar copies can carry
  // different conference destinations. If the provider is different, keep the
  // rows separate so one event cannot inherit the other's mark or join URL.
  const destination = (event.conferenceUrl || event.joinUrl || event.location)
    .trim()
    .toLocaleLowerCase()
    .replace(/\/$/u, '');
  return [
    event.title.trim().toLocaleLowerCase(),
    event.allDay ? 'all-day' : 'timed',
    instant(event.start),
    instant(event.end),
    event.platform,
    destination,
  ].join('|');
}

function preferEvent(
  current: WebCalendarEvent,
  candidate: WebCalendarEvent,
  writableCalendarIds: ReadonlySet<string>,
): WebCalendarEvent {
  const currentWritable = writableCalendarIds.has(current.calendarId);
  const candidateWritable = writableCalendarIds.has(candidate.calendarId);
  if (currentWritable !== candidateWritable) return candidateWritable ? candidate : current;
  return eventCompleteness(candidate) > eventCompleteness(current) ? candidate : current;
}

function eventCompleteness(event: WebCalendarEvent): number {
  return (event.conferenceUrl ? 4 : 0)
    + (event.joinUrl ? 2 : 0)
    + (event.location ? 1 : 0)
    + (event.travelTimeMinutes ? 1 : 0)
    + (event.description ? 1 : 0)
    + (event.attendees?.length ?? 0);
}

function combineAttendees(
  first: WebCalendarAttendee[] | undefined,
  second: WebCalendarAttendee[] | undefined,
): WebCalendarAttendee[] {
  const combined = new Map<string, WebCalendarAttendee>();
  for (const attendee of [...(first ?? []), ...(second ?? [])]) {
    const key = (attendee.email || attendee.name).trim().toLocaleLowerCase();
    if (!key) continue;
    const current = combined.get(key);
    if (!current) {
      combined.set(key, attendee);
      continue;
    }
    const canonical = attendee.inCrm && !current.inCrm ? attendee : current;
    const inCrm = current.inCrm || attendee.inCrm;
    const crmUrl = canonical.crmUrl || current.crmUrl || attendee.crmUrl;
    combined.set(key, {
      ...current,
      name: canonical.name || current.name || attendee.name,
      email: canonical.email || current.email || attendee.email,
      self: current.self || attendee.self,
      optional: current.optional && attendee.optional,
      status: current.status === 'unknown' ? attendee.status : current.status,
      ...(inCrm ? { inCrm: true } : {}),
      ...(crmUrl ? { crmUrl } : {}),
    });
  }
  return [...combined.values()];
}

/**
 * Whether the hero is currently the screen's one accent — a button is on it.
 * The room card reads this to step its own primary down to neutral.
 */
export function heroHoldsAccent(event: WebCalendarEvent | null | undefined, now = Date.now()): boolean {
  if (!event) return false;
  return isVideoMeeting(event) && canJoin(event, now);
}

/**
 * The hero button's words inside the window: the verb, then how long —
 * "Join · in 4 min". Matches `MeetingFocus.joinTitle`.
 */
export function joinTitle(event: WebCalendarEvent, now = Date.now()): string {
  return `${platformActionTitle(event)} · ${countdown(event, now)}`;
}

/**
 * Verb + product, matching `MobileCalendarEvent.platformActionTitle` and the
 * Mac's `CalendarMeetingPlatform.actionTitle` so no two clients name the same
 * button differently.
 */
export function platformActionTitle(event: WebCalendarEvent): string {
  if (isStarlingsMeet(event)) return 'Join';
  switch (event.platform) {
    case 'starlings':
    case 'envisioning': return 'Join';
    case 'google_meet': return 'Open Google Meet';
    case 'zoom': return 'Open Zoom';
    case 'teams': return 'Open Teams';
    case 'webex': return 'Open Webex';
    case 'other': return 'Open link';
    default: return t('Open');
  }
}

/** Short product label for the agenda; the destination itself stays an action. */
export function platformLabel(event: WebCalendarEvent): string {
  if (isStarlingsMeet(event)) return 'Starlings';
  switch (event.platform) {
    case 'starlings':
    case 'envisioning': return 'Starlings';
    case 'google_meet': return 'Google Meet';
    case 'zoom': return 'Zoom';
    case 'teams': return 'Teams';
    case 'webex': return 'Webex';
    case 'other': return 'Meeting link';
    default: return '';
  }
}

/** Meeting destinations are represented by the platform pill, not raw URLs. */
export function calendarLocationLabel(event: WebCalendarEvent): string {
  const location = event.location.trim();
  if (!location) return '';
  const isURL = /^https?:\/\//iu.test(location);
  const knownMeetingURL = /(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com)/iu.test(location);
  if (isURL && (event.platform !== 'none' || knownMeetingURL)) return '';
  // Google sometimes stores the provider's human label beside its join URL.
  // The platform pill already carries that meaning; repeating it makes a row
  // read as though it has two locations (notably "Microsoft Teams Meeting").
  const generatedMeetingLabel = /^(?:microsoft\s+teams|teams|google\s+meet|meet|zoom|webex)(?:\s+meeting)?$/iu;
  if (event.platform !== 'none' && generatedMeetingLabel.test(location)) return '';
  return location;
}

/** Absolute: "Today 15:00", "Tomorrow 09:30", "Mon 12 Aug 09:30". */
export function scheduleLine(event: WebCalendarEvent, now = Date.now()): string {
  const start = new Date(event.start);
  if (Number.isNaN(start.getTime())) {
    return [event.start, travelTimeLabel(event.travelTimeMinutes)].filter(Boolean).join(' · ');
  }
  const time = formatTime(start);
  const today = new Date(now);
  if (isSameDay(start, today)) return appendTravel(t('Today {time}', { time }), event.travelTimeMinutes);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (isSameDay(start, tomorrow)) return appendTravel(t('Tomorrow {time}', { time }), event.travelTimeMinutes);
  const day = start.toLocaleDateString(dateLocale, { weekday: 'short', day: 'numeric', month: 'short' });
  return appendTravel(`${day} ${time}`, event.travelTimeMinutes);
}

export function travelTimeLabel(minutes: number | null | undefined): string {
  if (!Number.isInteger(minutes) || !minutes || minutes < 0 || minutes > 24 * 60) return '';
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  const duration = hours > 0
    ? `${hours}h${remainder > 0 ? ` ${remainder}m` : ''}`
    : `${minutes} min`;
  return t('Travel time: {duration}', { duration });
}

function appendTravel(schedule: string, minutes: number | null | undefined): string {
  const travel = travelTimeLabel(minutes);
  return travel ? `${schedule} · ${travel}` : schedule;
}

/**
 * Relative, re-derived from `now` on every tick so a meeting that ends while
 * you are looking at it stops claiming to be in progress.
 */
export function countdown(event: WebCalendarEvent, now = Date.now()): string {
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  let target: number;
  let prefix: string;
  if (Number.isFinite(start) && start > now) {
    target = start;
    prefix = 'in ';
  } else if (Number.isFinite(end) && end > now) {
    target = end;
    prefix = 'ends in ';
  } else {
    return 'ended';
  }
  return `${prefix}${compactDuration(target - now)}`;
}

function isSameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

// --- The calendar page ------------------------------------------------------
//
// A week at a time, read-only. Which calendars are on, and which are hidden,
// are decisions the owner makes on the Mac or the phone; the web reads them
// back and renders what they chose rather than keeping a second opinion.

/** One entry of `GET /api/calendar/calendars`, as the Worker serializes it. */
export interface WebCalendarSource {
  id: string;
  summary: string;
  primary: boolean;
  /** Resolved against the owner's saved selection by the control plane. */
  selected: boolean;
  writable: boolean;
  accountEmail: string;
  backgroundColor?: string;
}

/** The read-only, Envisioning-owned calendars shown beside Google sources. */
export type WebCalendarLayerKind = CalendarLayerId;

export interface WebCalendarLayerDefinition {
  kind: WebCalendarLayerKind;
  title: string;
  caption: string;
  color: string;
}

// Tokens in styles.css; a workspace accent replaces them (workspace-accent.ts `ramp`).
const LAYER_COLOR: Record<WebCalendarLayerKind, string> = {
  events: 'var(--layer-events)', milestones: 'var(--layer-milestones)', tasks: 'var(--layer-tasks)', availability: 'var(--layer-availability)',
};
/** The layers, their order and words are the contract's (`CALENDAR_LAYERS`); the colours are the web's. */
export const CALENDAR_SPECIAL_LAYERS: WebCalendarLayerDefinition[] = CALENDAR_LAYERS.map((layer) => ({
  kind: layer.kind, title: t(layer.title), caption: t(layer.caption), color: LAYER_COLOR[layer.kind],
}));

export interface WebCalendarLayerItem {
  id: string;
  kind: WebCalendarLayerKind;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  detail: string;
  url: string;
  mine: boolean;
  status: string;
  /** Core's notes on a task or milestone; empty for the other layers. */
  notes: string;
  /** Who holds a task or milestone; empty for the other layers. */
  assignee: string;
  /** The project or event it is filed on; the location for a published event. */
  place: string;
  /**
   * Where the item lives in Work: your own task in Mine, then
   * the subject it is filed on. Empty for a published event and for
   * availability, whose way onward is `url`.
   */
  links: WebCalendarLayerLink[];
}

export interface WebCalendarLayerLink {
  label: string;
  href: string;
}

/** The subset of `GET /api/calendar/preferences` a read-only surface needs. */
export interface WebCalendarPreferences {
  hidden_calendar_keys: string[];
  disabled_calendar_keys: string[];
  demoted_event_keys?: string[];
  upcoming?: WebUpcomingPreferences;
}

export interface WebUpcomingPreferences {
  horizon_days: number;
  home_following_rows: number;
  show_tomorrow: boolean;
}

export function upcomingPreferencesFromWire(
  value?: WebUpcomingPreferences | null,
): UpcomingPreferences {
  return normalizeUpcomingPreferences(value && {
    horizonDays: value.horizon_days,
    homeFollowingRows: value.home_following_rows,
    showTomorrow: value.show_tomorrow,
  });
}

export async function setUpcomingPreferences(
  preferences: UpcomingPreferences,
): Promise<UpcomingPreferences> {
  const body = await apiFetch<WebCalendarPreferences>('/calendar/preferences', {
    method: 'PUT',
    body: {
      upcoming: {
        horizon_days: preferences.horizonDays,
        home_following_rows: preferences.homeFollowingRows,
        show_tomorrow: preferences.showTomorrow,
      },
    },
    fallbackError: t('Couldn’t save your Upcoming settings.'),
    noStore: true,
  });
  return upcomingPreferencesFromWire(body.upcoming);
}

/**
 * The key an event is hidden from Next under, the phone's grammar
 * (`StarlingsMobileModels.demotionKey`): a subscribed feed's row by its own id,
 * a Google row as `event:g:` and the served id.
 */
export function eventDemotionKey(event: Pick<WebCalendarEvent, 'calendarId' | 'id'>): string {
  return demotionKey(event.calendarId.startsWith('sub:'), event.id);
}

/**
 * Where an event may move from its row menu: writable calendars that are not
 * subscriptions, its own included so the menu can tick it, grouped by
 * account. Empty when the event cannot move: its own calendar is read-only,
 * a subscription, or the shared Global interest calendar (Swift
 * `canMoveBetweenCalendars`). The editor's calendar field offers the same list.
 */
export function eventMoveChoices(event: Pick<WebCalendarEvent, 'calendarId' | 'calendarRole'>, sources: WebCalendarSource[]): WebCalendarSource[] {
  const own = sources.find((source) => source.id === event.calendarId);
  if (!own?.writable || event.calendarId.startsWith('sub:') || event.calendarRole === 'global_interest') return [];
  const choices = sources.filter((source) => source.id === event.calendarId || (source.writable && !source.id.startsWith('sub:')));
  return choices.length > 1 ? choices : [];
}

/** Move an event to another calendar: the editor's write, from a row menu. */
export async function moveCalendarEvent(event: Pick<WebCalendarEvent, 'calendarId' | 'id'>, destinationId: string): Promise<void> {
  await apiFetch('/calendar/event/move', {
    method: 'POST',
    body: { calendar_id: event.calendarId, event_id: rawCalendarEventId(event.calendarId, event.id), destination_id: destinationId },
    fallbackError: t('Couldn’t move this event to that calendar.'),
  });
}

/** The tail of the demotion writes; each one waits for the one before. */
let demotionWrites: Promise<unknown> = Promise.resolve();

/**
 * Hide an event from Next, or show it again. The list is stored whole, so
 * this reads it, changes the one key, and writes it back, as the phone does.
 * The writes run one at a time: two quick changes that both read the old
 * list would otherwise each write it back without the other's key.
 */
export function setEventDemoted(event: Pick<WebCalendarEvent, 'calendarId' | 'id'>, demoted: boolean): Promise<void> {
  const write = demotionWrites.then(() => writeEventDemoted(event, demoted));
  demotionWrites = write.catch(() => undefined);
  return write;
}

async function writeEventDemoted(event: Pick<WebCalendarEvent, 'calendarId' | 'id'>, demoted: boolean): Promise<void> {
  const key = eventDemotionKey(event);
  const current = await fetchCalendarPreferences();
  const keys = new Set(current.demoted_event_keys ?? []);
  if (demoted) keys.add(key);
  else keys.delete(key);
  await apiFetch<WebCalendarPreferences>('/calendar/preferences', {
    method: 'PUT',
    body: { demoted_event_keys: [...keys] },
    fallbackError: demoted ? t('Couldn’t hide this event from Next.') : t('Couldn’t show this event in Next.'),
    noStore: true,
  });
}

export async function fetchCalendarSources(): Promise<WebCalendarSource[]> {
  const body = await apiFetch<{ calendars: WebCalendarSource[] }>('/calendar/calendars', {
    fallbackError: t('Couldn’t load your calendars.'),
    noStore: true,
  });
  return body.calendars ?? [];
}

export async function fetchCalendarPreferences(): Promise<WebCalendarPreferences> {
  return apiFetch<WebCalendarPreferences>('/calendar/preferences', {
    fallbackError: t('Couldn’t load your calendar settings.'),
    noStore: true,
  });
}

export async function fetchEventsInRange(from: Date, to: Date): Promise<WebCalendarEvent[]> {
  const params = new URLSearchParams({
    time_min: from.toISOString(),
    time_max: to.toISOString(),
  });
  const body = await apiFetch<{ events: WebCalendarEvent[] }>(`/calendar/events?${params}`, {
    fallbackError: t('Couldn’t load your calendar.'),
    noStore: true,
  });
  return body.events ?? [];
}

/**
 * The owner's `.ics` subscriptions for the same range. The Worker
 * owns them for every client (docs/CALENDAR.md); the Mac and iOS read the
 * same two routes. Each event gets the `sub:<id>` calendar id the shared
 * preference keys use. A feed is read-only, so nothing here is editable.
 */
export async function fetchSubscriptionEventsInRange(from: Date, to: Date): Promise<WebCalendarEvent[]> {
  const list = await apiFetch<CalendarSubscriptionListResponse>('/calendar/subscriptions', {
    fallbackError: t('Couldn’t load your subscribed calendars.'),
    noStore: true,
  });
  const subscriptions = list.subscriptions ?? [];
  if (subscriptions.length === 0) return [];
  const params = new URLSearchParams({
    time_min: from.toISOString(),
    time_max: to.toISOString(),
  });
  const body = await apiFetch<SubscriptionEventsResponse>(`/calendar/subscriptions/events?${params}`, {
    fallbackError: t('Couldn’t load your subscribed calendars.'),
    noStore: true,
  });
  const titles = new Map(subscriptions.map(({ id, title }) => [id, title]));
  return (body.events ?? []).map((event) => subscriptionEventToWeb(event, titles.get(event.subscriptionId) ?? ''));
}

function subscriptionEventToWeb(event: SubscriptionEventSummary, calendarSummary: string): WebCalendarEvent {
  const url = /^https?:\/\//iu.test(event.url) ? event.url : '';
  return {
    id: event.id,
    calendarId: `sub:${event.subscriptionId}`,
    calendarSummary,
    htmlLink: '',
    title: event.title,
    start: event.start,
    end: event.end,
    joinUrl: url,
    roomSlug: '',
    platform: 'none',
    conferenceUrl: url,
    allDay: event.allDay,
    recurring: event.recurring,
    description: event.description,
    location: event.location,
    demoted: false,
    attendees: [],
  };
}

export interface WebCalendarLayers {
  items: WebCalendarLayerItem[];
  /**
   * Which special calendars did not load. The Worker answers a Core outage
   * with an empty list and `degraded: true` rather than an error, so an empty
   * week and a dead feed look the same on the wire without this.
   */
  degraded: Set<WebCalendarLayerKind>;
}

/**
 * Load the four special calendars for the same seven local days as the grid.
 * Each layer is independently best-effort: an outage in Core's work or
 * availability projection must not hide the Google week or the other layers.
 */
export async function fetchCalendarLayers(from: Date, to: Date): Promise<WebCalendarLayers> {
  const start = calendarDay(from);
  const end = calendarDay(addDays(to, -1));
  const range = `start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  const degraded = new Set<WebCalendarLayerKind>();
  const [publicEvents, workItems, availability] = await Promise.all([
    apiFetch<{ events?: PublicCalendarEvent[]; degraded?: boolean }>(
      `/public/events?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`,
      { fallbackError: t('Couldn’t load published events.'), noStore: true },
    ).catch(() => ({ events: [], degraded: true })),
    apiFetch<{ items?: CoreCalendarWorkItem[]; degraded?: boolean }>(
      // `include_done` is a stringbool; left out, it is false.
      `/calendar/work-items?${range}`,
      { fallbackError: t('Couldn’t load milestones and tasks.'), noStore: true },
    ).catch(() => ({ items: [], degraded: true })),
    apiFetch<{ blocks?: CalendarAvailabilityBlock[]; degraded?: boolean }>(
      `/calendar/availability?${range}`,
      { fallbackError: t('Couldn’t load availability.'), noStore: true },
    ).catch(() => ({ blocks: [], degraded: true })),
  ]);
  if (publicEvents.degraded) degraded.add('events');
  // Milestones and tasks ride one feed, so they degrade together.
  if (workItems.degraded) { degraded.add('milestones'); degraded.add('tasks'); }
  if (availability.degraded) degraded.add('availability');

  return {
    items: [
      ...(publicEvents.events ?? []).flatMap(publicEventToLayer),
      ...(workItems.items ?? []).flatMap(workItemToLayer),
      ...(availability.blocks ?? []).flatMap(availabilityToLayer),
    ],
    degraded,
  };
}

/**
 * What the owner has actually switched on.
 *
 * The range read returns every calendar the account can see — the grid clients
 * filter it themselves — so this applies the same two rules they do: the saved
 * selection, and the hidden/disabled keys the sidebar writes. An account that
 * has never chosen falls back to the primary calendar, which is what the
 * upcoming feed does server-side; without that a fresh owner would open the
 * page to a blank week and read it as "nothing scheduled".
 */
export function visibleEvents(
  events: WebCalendarEvent[],
  sources: WebCalendarSource[],
  preferences?: WebCalendarPreferences,
): WebCalendarEvent[] {
  const chosen = sources.filter((source) => source.selected);
  const fallback = sources.filter((source) => source.primary);
  const allowed = new Set((chosen.length > 0 ? chosen : fallback).map((source) => source.id));
  // Google calendars are keyed `g:<calendar id>` in the shared preference
  // space, alongside `ek:` keys the web has no source for. A subscription's
  // calendar id is already its key, `sub:<id>`, and `account:subscribed`
  // switches the whole group off, as on the Mac.
  const off = new Set([
    ...(preferences?.hidden_calendar_keys ?? []),
    ...(preferences?.disabled_calendar_keys ?? []),
  ]);
  // A whole account switched off is one key, not one per calendar.
  const accountKeyOf = new Map<string, string>();
  for (const account of calendarAccounts(sources)) for (const calendar of account.calendars) accountKeyOf.set(calendar.id, account.key);
  return events.filter((event) => {
    if (event.calendarId.startsWith('sub:')) {
      return !off.has(SUBSCRIBED_ACCOUNT_KEY) && !off.has(event.calendarId);
    }
    if (allowed.size > 0 && !allowed.has(event.calendarId)) return false;
    const account = accountKeyOf.get(event.calendarId);
    if (account && off.has(account)) return false;
    return !off.has(googleCalendarKey(event.calendarId));
  });
}

/** `account:subscribed` switches every subscribed feed off at once. */
export { SUBSCRIBED_ACCOUNT_KEY };

/**
 * One Google account's calendars, as the native sidebars group them
 * (`CalendarWorkspace`): a single account is titled "Google", two or more are
 * titled by address. The keys are the shared grammar (`@starlings/contracts/calendar-keys`).
 */
export interface WebCalendarAccount {
  title: string;
  key: string;
  calendars: WebCalendarSource[];
}

export function calendarAccounts(sources: WebCalendarSource[]): WebCalendarAccount[] {
  const emails = new Set(sources.map((source) => source.accountEmail).filter(Boolean));
  const namesAccounts = emails.size > 1;
  const groups = new Map<string, WebCalendarAccount>();
  for (const source of sources) {
    const title = googleAccountTitle(source.accountEmail, namesAccounts);
    const group = groups.get(title) ?? { title, key: accountKey(title), calendars: [] };
    group.calendars.push(source);
    groups.set(title, group);
  }
  return [...groups.values()];
}

/** Hidden, or kept out of Meet, either by its own key or by its account's. */
export function isCalendarHidden(source: WebCalendarSource, account: WebCalendarAccount, preferences?: WebCalendarPreferences): boolean {
  const off = new Set([...(preferences?.hidden_calendar_keys ?? []), ...(preferences?.disabled_calendar_keys ?? [])]);
  return off.has(googleCalendarKey(source.id)) || off.has(account.key);
}

/** Show or hide one calendar; the rule, including the account-key expansion, is `withCalendarHidden` in the contracts. */
export function withCalendarHidden(keys: string[], source: WebCalendarSource, account: WebCalendarAccount, hidden: boolean): string[] {
  return withCalendarKeyHidden(
    keys,
    { key: googleCalendarKey(source.id), accountKey: account.key, siblingKeys: account.calendars.map((calendar) => googleCalendarKey(calendar.id)) },
    hidden,
  );
}

/** Show or hide a whole account: its own key stands for every calendar, present and future. */
export function withAccountHidden(keys: string[], account: WebCalendarAccount, hidden: boolean): string[] {
  return withAccountKeyHidden(keys, { key: account.key, memberKeys: account.calendars.map((calendar) => googleCalendarKey(calendar.id)) }, hidden);
}

/** Hidden keys are owner-wide: the Mac and the phone follow what the web writes. */
export async function writeHiddenCalendarKeys(keys: string[]): Promise<WebCalendarPreferences> {
  return apiFetch<WebCalendarPreferences>('/calendar/preferences', {
    method: 'PUT',
    body: { hidden_calendar_keys: keys },
    fallbackError: t('Couldn’t save your calendar choices.'),
    noStore: true,
  });
}

export interface AgendaDay {
  /** Local midnight, and the key the day is grouped by. */
  date: Date;
  events: WebCalendarEvent[];
  layers: WebCalendarLayerItem[];
}

/** Every day of the window, including the empty ones — a week has seven days. */
export function groupByDay(
  events: WebCalendarEvent[],
  from: Date,
  days: number,
  layers: WebCalendarLayerItem[] = [],
): AgendaDay[] {
  const buckets: AgendaDay[] = [];
  for (let index = 0; index < days; index += 1) {
    const date = new Date(from);
    date.setDate(date.getDate() + index);
    date.setHours(0, 0, 0, 0);
    buckets.push({ date, events: [], layers: [] });
  }
  for (const event of events) {
    const start = new Date(event.start);
    if (Number.isNaN(start.getTime())) continue;
    const bucket = buckets.find((day) => isSameDay(day.date, start));
    // An event outside the window is not an error: the range read is inclusive
    // of anything overlapping it, and a multi-day event starts before it.
    if (bucket) bucket.events.push(event);
  }
  for (const layer of layers) {
    const start = new Date(layer.start);
    if (Number.isNaN(start.getTime())) continue;
    const bucket = buckets.find((day) => isSameDay(day.date, start));
    if (bucket) bucket.layers.push(layer);
  }
  for (const bucket of buckets) {
    bucket.events.sort((left, right) => {
      if (left.allDay !== right.allDay) return left.allDay ? -1 : 1;
      return Date.parse(left.start) - Date.parse(right.start);
    });
    bucket.layers.sort((left, right) => {
      if (left.allDay !== right.allDay) return left.allDay ? -1 : 1;
      return Date.parse(left.start) - Date.parse(right.start);
    });
  }
  return buckets;
}

/** "Today", "Tomorrow", or the weekday — the heading over one day's rows. */
export function dayHeading(date: Date, now = Date.now()): { primary: string; secondary: string } {
  const today = new Date(now);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const long = date.toLocaleDateString(dateLocale, { weekday: 'long', day: 'numeric', month: 'long' });
  if (isSameDay(date, today)) return { primary: t('Today'), secondary: long };
  if (isSameDay(date, tomorrow)) return { primary: t('Tomorrow'), secondary: long };
  return {
    primary: date.toLocaleDateString(dateLocale, { weekday: 'long' }),
    secondary: date.toLocaleDateString(dateLocale, { day: 'numeric', month: 'long' }),
  };
}

/** "09:30 – 10:15", or "All day" for a date-only event. */
export function timeRange(event: WebCalendarEvent): string {
  if (event.allDay) return t('All day');
  const start = new Date(event.start);
  const end = new Date(event.end);
  if (Number.isNaN(start.getTime())) return '';
  const time = (value: Date) => formatTime(value);
  if (Number.isNaN(end.getTime())) return time(start);
  return `${time(start)} – ${time(end)}`;
}

/** The window a page of the calendar covers, in whole local days. */
export function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** The first of the month a date falls in, at local midnight. */
export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

/** The grid a month is drawn on: whole weeks, Monday first, from the Monday on or before the 1st. */
export function monthGrid(month: Date): { from: Date; days: number } {
  const first = startOfMonth(month);
  const offset = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return { from: addDays(first, -offset), days: Math.ceil((offset + daysInMonth) / 7) * 7 };
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** A local civil day as `YYYY-MM-DD`: the Calendar's `day` query. */
export function calendarDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export interface PublicCalendarEvent {
  id: string;
  title: string;
  date: string;
  starts_at?: string | null;
  ends_at?: string | null;
  is_all_day: boolean;
  location?: string | null;
  signup_url?: string | null;
}

interface CoreCalendarWorkItem {
  id: string;
  kind: 'task' | 'milestone' | string;
  title: string;
  status: string;
  due_at: string | null;
  mine?: boolean;
  notes?: string | null;
  assignee_name?: string | null;
  project_id?: string | null;
  project_title?: string | null;
  lead_id?: string | null;
  event_id?: string | null;
  event_title?: string | null;
  organization_id?: string | null;
  meeting_id?: string | null;
}

/** A work item's ways into Work, the same two the Mac inspector and the phone's sheet offer. */
function workItemLinks(item: CoreCalendarWorkItem): WebCalendarLayerLink[] {
  const links: WebCalendarLayerLink[] = [];
  const isTask = item.kind !== 'milestone';
  if (isTask && item.mine === true) links.push({ label: t('Open in Mine'), href: taskHref(item.id) });
  const subject = workSubjectOf(item);
  if (subject) {
    const title = subject.kind === 'project'
      ? item.project_title?.trim() || t('Project')
      : subject.kind === 'event'
        ? item.event_title?.trim() || t('Event')
        : subject.kind === 'organization'
          ? t('Partner')
          : t('Lead');
    const href = isTask ? subjectTaskHref(item.id, subject) : subjectHref(subject);
    links.push({ label: t('Open {title}', { title }), href });
  }
  return links;
}

/** The fields a task or milestone adds to its layer row. */
function workItemDetail(item: CoreCalendarWorkItem): Pick<WebCalendarLayerItem, 'notes' | 'assignee' | 'place' | 'links'> {
  return {
    notes: item.notes?.trim() ?? '',
    assignee: item.assignee_name?.trim() ?? '',
    place: item.project_title?.trim() || item.event_title?.trim() || '',
    links: workItemLinks(item),
  };
}

/** A layer row with no Core notes and nobody holding it. */
const NO_LAYER_DETAIL = { notes: '', assignee: '' };

interface CalendarAvailabilityBlock {
  start: string;
  end: string;
}

/**
 * A published event's page in Meet: the Work event subject. Core's public
 * feed carries the CMS `events.id`, the same id the subject has
 * (docs/EVENTS.md), so no second lookup is needed.
 */
function publicEventLinks(event: PublicCalendarEvent): WebCalendarLayerLink[] {
  return [{ label: t('Open in Work'), href: subjectHref({ kind: 'event', id: event.id }) }];
}

function publicEventToLayer(event: PublicCalendarEvent): WebCalendarLayerItem[] {
  const allDay = event.is_all_day || !event.starts_at;
  if (allDay) {
    const start = localCalendarDate(event.date);
    if (!start) return [];
    return [{
      id: `public:${event.id}`,
      kind: 'events',
      title: event.title.trim() || t('Event'),
      start: start.toISOString(),
      end: addDays(start, 1).toISOString(),
      allDay: true,
      detail: event.location?.trim() ?? '',
      url: event.signup_url?.trim() ?? '',
      mine: false,
      status: '',
      ...NO_LAYER_DETAIL,
      links: publicEventLinks(event),
      place: event.location?.trim() ?? '',
    }];
  }
  const start = event.starts_at ?? '';
  const end = event.ends_at || start;
  if (!validRange(start, end)) return [];
  return [{
    id: `public:${event.id}`,
    kind: 'events',
    title: event.title.trim() || t('Event'),
    start,
    end,
    allDay: false,
    detail: event.location?.trim() ?? '',
    url: event.signup_url?.trim() ?? '',
    mine: false,
    status: '',
    ...NO_LAYER_DETAIL,
    links: publicEventLinks(event),
    place: event.location?.trim() ?? '',
  }];
}

function workItemToLayer(item: CoreCalendarWorkItem): WebCalendarLayerItem[] {
  if (!item.due_at) return [];
  const kind: WebCalendarLayerKind = item.kind === 'milestone' ? 'milestones' : 'tasks';
  const allDay = /^\d{4}-\d{2}-\d{2}$/u.test(item.due_at);
  if (allDay) {
    const start = localCalendarDate(item.due_at);
    if (!start) return [];
    return [{
      id: `work:${item.id}`,
      kind,
      title: item.title.trim() || (kind === 'milestones' ? 'Milestone' : 'Task'),
      start: start.toISOString(),
      end: addDays(start, 1).toISOString(),
      allDay: true,
      detail: [item.project_title, item.assignee_name].filter(Boolean).join(' · '),
      url: '',
      mine: item.mine === true,
      status: item.status,
      ...workItemDetail(item),
    }];
  }
  const startTime = Date.parse(item.due_at);
  if (!Number.isFinite(startTime)) return [];
  const end = new Date(startTime + 30 * 60 * 1000).toISOString();
  if (!validRange(item.due_at, end)) return [];
  return [{
    id: `work:${item.id}`,
    kind,
    title: item.title.trim() || (kind === 'milestones' ? 'Milestone' : 'Task'),
    start: item.due_at,
    end,
    allDay: false,
    detail: [item.project_title, item.assignee_name].filter(Boolean).join(' · '),
    url: '',
    mine: item.mine === true,
    status: item.status,
    ...workItemDetail(item),
  }];
}

function availabilityToLayer(block: CalendarAvailabilityBlock): WebCalendarLayerItem[] {
  if (!validRange(block.start, block.end)) return [];
  return [{
    id: `availability:${block.start}:${block.end}`,
    kind: 'availability',
    title: t('Available'),
    start: block.start,
    end: block.end,
    allDay: false,
    detail: '',
    url: '',
    mine: true,
    status: '',
    ...NO_LAYER_DETAIL,
    links: [],
    place: '',
  }];
}

function localCalendarDate(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : startOfDay(date);
}

function validRange(start: string, end: string): boolean {
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  return Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime;
}
