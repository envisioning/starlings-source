/**
 * What "upcoming" means — the one definition, shared by Mac, iOS, and web.
 *
 * One feed answers two different questions: *what should I do now*, and *what
 * is on my plate*. They are not the same list, and filling the first with the
 * head of the second is how a Friday evening ended up counting down fourteen
 * hours to Monday's standup as if it were about to start. So the agenda and the
 * hero are computed here together, once, and no surface is allowed a second
 * opinion about either.
 *
 * The Swift port is `Sources/MeetingFocus.swift`. Both are pinned to the same
 * table of cases in `fixtures/upcoming-tiers.json` — that file is the rule
 * contract, while `upcoming-config.json` holds the product knobs consumed by
 * every surface, including the compact Home projection. Change the rules there
 * first.
 */

import { CALENDAR_KEY_FORMATS } from './calendar-keys';
import config from './upcoming-config.json';

/** The one product-level configuration consumed by Worker, web, Mac, and iOS. */
export const UPCOMING_CONFIG = config;

/** How far ahead a meeting may start and still be worth listing. */
export const UPCOMING_HORIZON_MS = UPCOMING_CONFIG.horizonDays * 24 * 60 * 60 * 1_000;

/** How far clients read past the display horizon to avoid edge flicker. */
export const UPCOMING_REQUEST_HOURS =
  (UPCOMING_CONFIG.horizonDays + UPCOMING_CONFIG.requestSlackDays) * 24;

/** How long before the start the hero grows its button. */
export const UPCOMING_JOIN_WINDOW_MS = UPCOMING_CONFIG.joinWindowMinutes * 60 * 1_000;

/**
 * Whether the hero shows a button at all. A meeting three hours out is a
 * countdown, not a call to action — and while the hero has no button, the
 * room card's primary holds the screen's one accent. Mirrored by
 * `MeetingFocus.canJoin` in Sources/MeetingFocus.swift.
 */
export function canJoin(event: { start: string; end: string }, now = Date.now()): boolean {
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start - UPCOMING_JOIN_WINDOW_MS <= now && now < end;
}

/** Owner-wide display choices. Product config remains the default and guardrail. */
export interface UpcomingPreferences {
  horizonDays: number;
  homeFollowingRows: number;
  showTomorrow: boolean;
}

export const DEFAULT_UPCOMING_PREFERENCES: UpcomingPreferences = {
  horizonDays: UPCOMING_CONFIG.horizonDays,
  homeFollowingRows: UPCOMING_CONFIG.homeFollowingRows,
  showTomorrow: UPCOMING_CONFIG.showTomorrow,
};

/**
 * Preferences are stored by the control plane, so an older or partially
 * written record must fall back field-by-field rather than blanking Home.
 */
export function normalizeUpcomingPreferences(value: unknown): UpcomingPreferences {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const integer = (candidate: unknown, fallback: number, min: number, max: number): number => {
    if (typeof candidate !== 'number' || !Number.isInteger(candidate)) return fallback;
    return Math.min(max, Math.max(min, candidate));
  };
  return {
    // The compact Home feed is intentionally fixed to today and tomorrow.
    // Keep accepting the old wire fields so older clients and stored records
    // remain readable, but do not let them restore the old multi-day range.
    horizonDays: DEFAULT_UPCOMING_PREFERENCES.horizonDays,
    homeFollowingRows: integer(source.homeFollowingRows, DEFAULT_UPCOMING_PREFERENCES.homeFollowingRows, 0, 5),
    showTomorrow: true,
  };
}

/** Fetch enough to cover the owner's display horizon plus product slack. */
export function upcomingRequestHours(preferences?: unknown): number {
  const resolved = normalizeUpcomingPreferences(preferences);
  return (resolved.horizonDays + UPCOMING_CONFIG.requestSlackDays) * 24;
}

/**
 * Where an event sits relative to the viewer's day. Purely temporal, and
 * anchored to civil days rather than to a duration: at 23:50, a meeting twenty
 * minutes away is *tomorrow*, and reads completely differently from one twenty
 * minutes away at noon.
 */
export type UpcomingTier = 'now' | 'today' | 'tomorrow' | 'ahead' | 'unscheduled';

export const UPCOMING_TIERS: readonly UpcomingTier[] = [
  'now',
  'today',
  'tomorrow',
  'ahead',
  'unscheduled',
];

/**
 * The little a calendar row has to expose to be placed. Deliberately not the
 * wire type: the Mac merges EventKit rows into the same list, and the web's own
 * event carries a dozen fields none of this cares about.
 */
export interface UpcomingEventShape {
  id: string;
  /** Shared source identity used to collapse duplicate calendar copies. */
  calendarId?: string | null;
  title: string;
  /** ISO 8601. Unparseable or absent means the event is `unscheduled`. */
  start: string | null | undefined;
  /** ISO 8601. Without a readable end an event cannot be shown to be ahead. */
  end: string | null | undefined;
  allDay: boolean;
  /** Owner-wide Hide from Next state. Hidden events are omitted from Upcoming. */
  demoted: boolean;
  /**
   * The guest list as the feed sent it. Present on every feed row, empty when
   * the event has no guests. Absent means the source carries no participation
   * facts (a widget's snapshot that the app already filtered), and the event
   * is not judged by `isMemberEvent`.
   */
  attendees?: readonly UpcomingAttendeeShape[];
}

/** What the member rule reads of one guest. `self` marks the member's own row. */
export interface UpcomingAttendeeShape {
  status: string;
  self: boolean;
}

export interface UpcomingPlan<E> {
  /** Everything still relevant, soonest first. The list. */
  agenda: E[];
  /** Tier by event id, for rows that show their own heading or countdown. */
  tiers: Record<string, UpcomingTier>;
  /** The agenda grouped, in tier order — what section headings render from. */
  tiered: Record<UpcomingTier, E[]>;
  /**
   * The hero: the countdown, the call to action, the one thing in focus.
   * `undefined` is a closed day — the surface collapses the hero to a summary
   * and shows the rest as an ordinary list. It must never fall through to
   * tomorrow.
   */
  focus: E | undefined;
  /** The owner-wide display policy used to produce this plan. */
  preferences: UpcomingPreferences;
  /** The compact Home rows, after the hero, using the shared display policy. */
  homeRows: E[];
  /**
   * Today-tier agenda events that do not fit in the compact Home projection.
   * This is deliberately separate from `agenda.length`: Home can have more
   * today without asking the reader to think about the whole horizon.
   */
  remainingTodayCount: number;
  /** Today-tier events hidden behind the compact Home foldout. */
  remainingToday: E[];
}

export interface UpcomingOptions {
  now?: number;
  /** IANA zone. Omitted means the host's own — which is what clients want. */
  timeZone?: string;
  horizonMs?: number;
  preferences?: UpcomingPreferences | Partial<UpcomingPreferences>;
}

/** Rows somebody used to defend an hour. Not meetings, and never the hero. */
const PLACEHOLDER_TITLES = new Set(UPCOMING_CONFIG.placeholderTitles);

export function hasRealMeetingTitle(title: string): boolean {
  return !PLACEHOLDER_TITLES.has(title.trim().toLowerCase());
}

/**
 * Place visible events on the feed, and decide which one — if any — the viewer
 * is actually being asked to act on.
 */
export function classifyUpcoming<E extends UpcomingEventShape>(
  events: readonly E[],
  options: UpcomingOptions = {},
): UpcomingPlan<E> {
  const now = options.now ?? Date.now();
  const preferences = normalizeUpcomingPreferences(options.preferences);
  const horizonMs = options.horizonMs ?? preferences.horizonDays * 24 * 60 * 60 * 1_000;
  const today = civilDay(now, options.timeZone);

  // Judge each copy before copies collapse, so the copy that survives is one
  // on the member's own calendar.
  const candidates = consolidateUpcoming(events.filter(isMemberEvent))
    .filter((event) => onAgenda(event, now, horizonMs))
    .sort((left, right) => compareByStart(left, right));

  // Home is deliberately a two-day surface: today, then tomorrow's summary.
  // The full Calendar surface remains the place for anything farther out.
  const agenda = candidates.filter((event) => {
    const tier = tierOf(event, now, today, options.timeZone);
    return tier === 'now' || tier === 'today' || tier === 'tomorrow';
  });

  const tiers: Record<string, UpcomingTier> = {};
  const tiered = emptyTiers<E>();
  for (const event of agenda) {
    const tier = tierOf(event, now, today, options.timeZone);
    tiers[event.id] = tier;
    tiered[tier].push(event);
  }

  const focus = agenda.find((event) => canFocus(event, tiers[event.id]));
  const homeRows = agenda
    .filter((event) => event.id !== focus?.id)
    .filter((event) => {
      const tier = tiers[event.id];
      if (tier === undefined) return false;
      // While today is active, keep the compact card about today. Once the
      // day is closed, the same rows become tomorrow's supporting summary.
      return focus
        ? tier === 'now' || tier === 'today'
        : tier === 'tomorrow';
    })
    .slice(0, preferences.homeFollowingRows);

  const visibleTodayIDs = new Set(
    [
      ...(focus ? [focus] : []),
      ...homeRows,
    ]
      .filter((event) => tiers[event.id] === 'now' || tiers[event.id] === 'today')
      .map((event) => event.id),
  );
  const remainingToday = [...tiered.now, ...tiered.today]
    .filter((event) => !visibleTodayIDs.has(event.id));
  const remainingTodayCount = remainingToday.length;

  return { agenda, tiers, tiered, focus, homeRows, remainingTodayCount, remainingToday, preferences };
}

/**
 * Whether Home shows this event to the member at all: they organize it or
 * attend it and have not declined. Home reads every selected calendar, and a
 * colleague's calendar or a shared Google calendar holds their flights and
 * meetings, not the member's.
 *
 * - The member's own calendar is a Google account's `primary` calendar
 *   (`primary`, or `acct:<account>:primary` for a second account). Google
 *   puts every event the member organizes or is invited to there, and marks
 *   the member's guest row `self`. An event there stays unless that row says
 *   `declined`. An event with no guests (an own block, a flight) stays.
 * - A subscribed feed (`sub:`) stays. The member added it and switched it on
 *   for Upcoming themselves, and a feed carries no guest list to read.
 * - Any other calendar (a colleague's, a shared or imported Google calendar)
 *   is dropped. On those, Google's `self` marks the calendar's owner, not the
 *   member. When the member is on such an event, its copy on their own
 *   primary calendar is the row that stays.
 * - No calendar id, or no guest list at all: no facts to judge, so it stays.
 *
 * Swift: `MeetingFocus.isMemberEvent`. Kotlin: `Upcoming.isMemberEvent`.
 */
export function isMemberEvent(event: Pick<UpcomingEventShape, 'calendarId' | 'attendees'>): boolean {
  const attendees = event.attendees;
  if (attendees === undefined) return true;
  const calendarId = event.calendarId?.trim() ?? '';
  if (!calendarId) return true;
  if (calendarId.startsWith(CALENDAR_KEY_FORMATS.subscriptionPrefix)) return true;
  if (!isOwnPrimaryCalendar(calendarId)) return false;
  return !attendees.some((attendee) => attendee.self && attendee.status === 'declined');
}

const SECOND_ACCOUNT_CALENDAR = /^acct:[^:]+:/u;

function isOwnPrimaryCalendar(calendarId: string): boolean {
  return calendarId.replace(SECOND_ACCOUNT_CALENDAR, '') === 'primary';
}

/** Collapse one event copied onto several selected calendars, but preserve
 * separate copies that genuinely coexist on the same calendar. */
function consolidateUpcoming<E extends UpcomingEventShape>(events: readonly E[]): E[] {
  const order: string[] = [];
  const byKey = new Map<string, E[]>();

  for (const event of events) {
    const key = fingerprint(event);
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, [...(byKey.get(key) ?? []), event]);
  }

  return order.flatMap((key) => {
    const members = byKey.get(key) ?? [];
    const sourceCalendar = members.find((member) => member.calendarId?.trim())?.calendarId?.trim();
    return members.filter((member) => {
      const calendarId = member.calendarId?.trim();
      return !sourceCalendar || !calendarId || calendarId === sourceCalendar;
    });
  });
}

function fingerprint(event: UpcomingEventShape): string {
  const title = event.title.trim().toLowerCase();
  const start = parse(event.start);
  const end = parse(event.end);
  const calendarId = event.calendarId?.trim();
  if (!calendarId || start === undefined || end === undefined) {
    return `unparseable|${calendarId ?? ''}|${event.id}`;
  }
  return [title, start, end, event.allDay].join('|');
}

/**
 * Still ahead, a real meeting, and near enough to be worth a row. An event with
 * no readable end is dropped rather than guessed at. All-day and hidden-from-
 * Next events are never part of the Upcoming feed.
 */
function onAgenda(event: UpcomingEventShape, now: number, horizonMs: number): boolean {
  if (event.demoted) return false;
  if (event.allDay) return false;
  const end = parse(event.end);
  if (end === undefined || end <= now) return false;
  if (!hasRealMeetingTitle(event.title)) return false;
  const start = parse(event.start);
  return start === undefined || start <= now + horizonMs;
}

function tierOf(
  event: UpcomingEventShape,
  now: number,
  today: number,
  timeZone: string | undefined,
): UpcomingTier {
  const start = parse(event.start);
  if (start === undefined) return 'unscheduled';
  // An offsite spanning the whole day is not something you are five minutes
  // late for, so it is never "now" even while it is happening.
  if (!event.allDay && start <= now) return 'now';
  const offset = civilDay(start, timeZone) - today;
  if (offset <= 0) return 'today';
  if (offset === 1) return 'tomorrow';
  return 'ahead';
}

/**
 * What the hero slot will accept. Note what is *not* on this list: having a
 * video link. An in-person meeting is still what is next — it simply has no
 * button, which is a question about the call to action, not about focus.
 */
function canFocus(event: UpcomingEventShape, tier: UpcomingTier | undefined): boolean {
  if (tier !== 'now' && tier !== 'today') return false;
  return !event.demoted && !event.allDay;
}

/**
 * Soonest first, and everything undated after everything dated — an event whose
 * date is still being agreed cannot sit above a meeting this afternoon. Ties
 * break on id so two meetings at the same minute keep one order across a
 * refresh, and across clients.
 */
function compareByStart(left: UpcomingEventShape, right: UpcomingEventShape): number {
  const leftStart = parse(left.start);
  const rightStart = parse(right.start);
  if (leftStart === undefined || rightStart === undefined) {
    if (leftStart !== undefined) return -1;
    if (rightStart !== undefined) return 1;
    const byEnd = (parse(left.end) ?? 0) - (parse(right.end) ?? 0);
    if (byEnd !== 0) return byEnd;
  } else if (leftStart !== rightStart) {
    return leftStart - rightStart;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function parse(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The civil date at an instant, as a day number, so "same day" and "the day
 * after" are subtraction. Doing this on the raw timestamp instead would put the
 * day boundary in UTC, and empty the hero mid-evening for everyone west of
 * Greenwich.
 */
export function civilDay(ms: number, timeZone: string | undefined): number {
  const parts = dayFormatter(timeZone).formatToParts(new Date(ms));
  let year = 0;
  let month = 1;
  let day = 1;
  for (const part of parts) {
    if (part.type === 'year') year = Number(part.value);
    else if (part.type === 'month') month = Number(part.value);
    else if (part.type === 'day') day = Number(part.value);
  }
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
const summaryClockFormatter = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function dayFormatter(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? '';
  let formatter = dayFormatters.get(key);
  if (!formatter) {
    // `en-US` with numeric parts, read back through formatToParts — the locale
    // only has to be one whose parts are labelled, never one whose text we read.
    formatter = new Intl.DateTimeFormat('en-US', {
      ...(timeZone ? { timeZone } : {}),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(key, formatter);
  }
  return formatter;
}

/**
 * What a surface says where the hero would have been. The words are matched by
 * `MeetingFocus.closedDaySummary` in Sources/MeetingFocus.swift — a closed day
 * that reads three different ways on three clients is the same bug as a hero
 * that reads three different ways.
 *
 * "Nothing left today" rather than "day's done": it is equally true at six in
 * the morning on a clear day, and the hero is empty then too. Tomorrow is
 * useful context; meetings farther ahead stay in Calendar rather than taking
 * over the idle surface's one-line answer.
 */
/**
 * The word over the hero. The config's "UPCOMING" while the meeting is still
 * ahead; "NOW" once it has started, because a card counting down the minutes
 * left in a call is not upcoming. Matched by `heroLabel` in
 * `Sources/MeetingFocus.swift`.
 */
export function heroLabel<E extends UpcomingEventShape>(plan: UpcomingPlan<E>): string {
  const focus = plan.focus;
  if (focus && plan.tiers[focus.id] === 'now') return 'NOW';
  return UPCOMING_CONFIG.sectionTitle;
}

/**
 * What a closed day's summary is written from. The sentence itself belongs
 * to the surface, in the person's language ( step 4); the contract
 * decides only which case applies and hands over the numbers.
 *
 * - `empty`: nothing on the agenda at all.
 * - `today`: nothing left today, and tomorrow is not shown or has nothing.
 * - `tomorrow`: nothing left today; `count` tomorrow, the first at `time`
 *   (24-hour, absent when the first one has no usable start).
 */
export type ClosedDaySummary =
  | { kind: 'empty' }
  | { kind: 'today' }
  | { kind: 'tomorrow'; count: number; time?: string };

export function closedDaySummary<E extends UpcomingEventShape>(plan: UpcomingPlan<E>): ClosedDaySummary {
  if (plan.agenda.length === 0) return { kind: 'empty' };
  if (!plan.preferences.showTomorrow) return { kind: 'today' };
  const tomorrow = plan.tiered.tomorrow;
  const first = tomorrow[0];
  if (!first) return { kind: 'today' };
  const start = first.start ? new Date(first.start) : undefined;
  const time = start && !Number.isNaN(start.getTime()) ? summaryClockFormatter.format(start) : undefined;
  return time ? { kind: 'tomorrow', count: tomorrow.length, time } : { kind: 'tomorrow', count: tomorrow.length };
}

function emptyTiers<E>(): Record<UpcomingTier, E[]> {
  return { now: [], today: [], tomorrow: [], ahead: [], unscheduled: [] };
}
