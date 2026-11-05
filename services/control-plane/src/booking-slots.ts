// The bookable slots of one member (docs/CORE_FOLD_PLAN.md §Phase 3d). A port
// of Core's `calculateAvailability` without its defects: the member's own
// days decide the weekend, the slot step is a setting, a milestone does not
// close every host's day, and there is no fixed fallback zone (no zone, no
// slots).

import type { BookingSettingsResponse, BookingWeekday } from '@starlings/contracts/booking-settings';

export interface BusyInterval {
  /** Epoch milliseconds. */
  start: number;
  end: number;
}

export interface BookableSlot {
  start: string;
  end: string;
}

export type SlotRules = Pick<
  BookingSettingsResponse,
  'timezone' | 'weekly_hours' | 'duration_minutes' | 'buffer_minutes' | 'min_notice_hours' | 'max_booking_days' | 'slot_step_minutes'
>;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** `Date.getUTCDay()` (Sunday first) to the weekly hours' key. */
const WEEKDAY_KEYS: readonly BookingWeekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Every slot inside `[from, to)` a guest may book: inside the member's hours
 * in their own zone, at least the notice away from `now`, no further than the
 * booking horizon, and clear of every busy interval by the buffer.
 */
export function bookableSlots(
  rules: SlotRules,
  busy: readonly BusyInterval[],
  range: { from: number; to: number },
  now: number,
): BookableSlot[] {
  const { timezone, weekly_hours: week } = rules;
  if (!timezone || !week) return [];
  const duration = rules.duration_minutes * MINUTE;
  const step = rules.slot_step_minutes * MINUTE;
  const buffer = rules.buffer_minutes * MINUTE;
  const earliest = Math.max(range.from, now + rules.min_notice_hours * 60 * MINUTE);
  const latest = Math.min(range.to, now + rules.max_booking_days * DAY);
  if (earliest >= latest) return [];

  const slots: BookableSlot[] = [];
  // From the local day before `earliest`: an overnight window that opened the
  // evening before still covers its morning.
  let day = localDate(earliest - DAY, timezone);
  const lastDay = localDate(latest, timezone);
  while (compareDates(day, lastDay) <= 0) {
    const hours = week[WEEKDAY_KEYS[weekday(day)] ?? 'sun'];
    if (hours.enabled) {
      const open = zonedToEpoch(day, hours.start_minute, timezone);
      const closeDay = hours.end_minute > hours.start_minute ? day : nextDate(day);
      const close = zonedToEpoch(closeDay, hours.end_minute, timezone);
      for (let start = open; start + duration <= close; start += step) {
        const end = start + duration;
        if (start < earliest || end > latest) continue;
        if (busy.some((interval) => start < interval.end + buffer && end > interval.start - buffer)) continue;
        slots.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
      }
    }
    day = nextDate(day);
  }
  return slots;
}

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

function localDate(epoch: number, timezone: string): CivilDate {
  const parts = zoneParts(epoch, timezone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function nextDate(date: CivilDate): CivilDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function compareDates(a: CivilDate, b: CivilDate): number {
  return Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day);
}

function weekday(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/**
 * The instant a wall-clock minute of a local date names in `timezone`. Two
 * passes settle a day that changes offset; a minute that a spring-forward
 * skips lands just after the gap.
 */
function zonedToEpoch(date: CivilDate, minuteOfDay: number, timezone: string): number {
  const wall = Date.UTC(date.year, date.month - 1, date.day, 0, minuteOfDay);
  let guess = wall - offsetAt(wall, timezone);
  guess = wall - offsetAt(guess, timezone);
  return guess;
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function offsetAt(epoch: number, timezone: string): number {
  const parts = zoneParts(epoch, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(epoch / 1000) * 1000;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneParts(epoch: number, timezone: string) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, formatter);
  }
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(epoch))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  const read = (type: string) => values[type] ?? 0;
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * Slots overlap when the meeting is longer than the step, so "contiguous"
 * means the next slot starts at or before the current block ends. A step
 * longer than the meeting leaves a gap between open slots; `bridges` says
 * whether that gap is still free time, so the block does not break on it.
 */
export function mergeSlotsIntoBlocks(
  slots: readonly BookableSlot[],
  bridges: (gap: BookableSlot) => boolean = () => false,
): BookableSlot[] {
  const sorted = [...slots].sort((a, b) => a.start.localeCompare(b.start));
  const blocks: BookableSlot[] = [];
  for (const slot of sorted) {
    const last = blocks[blocks.length - 1];
    if (last && (slot.start <= last.end || bridges({ start: last.end, end: slot.start }))) {
      if (slot.end > last.end) last.end = slot.end;
    } else {
      blocks.push({ start: slot.start, end: slot.end });
    }
  }
  return blocks;
}

/** The instant a `YYYY-MM-DD` day starts in `timezone`. */
export function zonedDayStart(date: string, timezone: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return zonedToEpoch({ year: year ?? 1970, month: month ?? 1, day: day ?? 1 }, 0, timezone);
}

/** The `YYYY-MM-DD` day an instant falls on in `timezone`. */
export function zonedDateKey(epoch: number, timezone: string): string {
  const { year, month, day } = localDate(epoch, timezone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** True for a zone the runtime knows. */
export function isKnownTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
