import { t, dateLocale, uiLocale } from './i18n';
// One spelling of a meeting's day and time range, shared by the Schedule
// screen's slot picker and the invite card on Room entry, so a guest who books
// a slot and then follows the invite link reads the same words twice.

// Native Home uses `StarlingsDateFormatting.homeDate`: the weekday, day, and
// month in that order, in `dateLocale` like every other date on the web.
const homeDateFormatter = new Intl.DateTimeFormat(dateLocale, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

/** The date under Home's clock, in the same language and format as Mac/iOS. */
export function formatHomeDate(date: Date): string {
  return homeDateFormatter.format(date);
}

/**
 * A contact's birthday: the day and month, with the year when
 * known. Null when the month or the day is missing. Native clients spell it
 * in `ContactFieldText.birthday`.
 */
export function formatBirthday(month: number | null | undefined, day: number | null | undefined, year?: number | null): string | null {
  if (!month || !day) return null;
  return new Intl.DateTimeFormat(dateLocale, { day: 'numeric', month: 'long', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' })
    .format(new Date(Date.UTC(year ?? 2000, month - 1, day)));
}

/** The month names in the reader's language, January first. */
export function monthNames(): string[] {
  const format = new Intl.DateTimeFormat(dateLocale, { month: 'long', timeZone: 'UTC' });
  return Array.from({ length: 12 }, (_, index) => format.format(new Date(Date.UTC(2000, index, 1))));
}

/**
 * A stored day as a local calendar date. A date-only `YYYY-MM-DD` names that
 * day wherever the reader is (`new Date('2026-09-20')` is UTC midnight and
 * reads as the 19th west of Greenwich); a timestamp is the local day it falls
 * on. Null when the value is empty or not a date.
 */
export function parseDay(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (match) {
      const day = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      return Number.isNaN(day.getTime()) ? null : day;
    }
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The one spelling of a bare date on the web: "20 Sep", with the year once it
 * is not this year's. Raw ISO strings never reach the screen; a value that is
 * not a date reads as an empty string, so callers can `filter(Boolean)`.
 */
export function formatDay(value: string | number | Date | null | undefined, now: Date = new Date()): string {
  const date = parseDay(value);
  if (!date) return '';
  return date.toLocaleDateString(dateLocale, date.getFullYear() === now.getFullYear()
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The browser's own zone — what a guest reads without doing arithmetic. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

type ClockOptions = {
  timeZone?: string;
  seconds?: boolean;
  timeZoneName?: 'short' | 'long';
};

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** Meet's clock is always 24-hour, regardless of the browser's locale. */
export function formatTime(date: Date, options: ClockOptions = {}): string {
  const { timeZone, seconds = false, timeZoneName } = options;
  const key = `${timeZone ?? ''}|${seconds ? 'seconds' : 'minutes'}|${timeZoneName ?? ''}`;
  let formatter = clockFormatters.get(key);
  if (!formatter) {
    const formatOptions: Intl.DateTimeFormatOptions = {
      ...(timeZone ? { timeZone } : {}),
      hour: '2-digit',
      minute: '2-digit',
      ...(seconds ? { second: '2-digit' } : {}),
      ...(timeZoneName ? { timeZoneName } : {}),
      hourCycle: 'h23',
    };
    try {
      formatter = new Intl.DateTimeFormat('en-GB', formatOptions);
    } catch {
      // A bad or newly unavailable zone should not make a room unusable.
      delete formatOptions.timeZone;
      formatter = new Intl.DateTimeFormat('en-GB', formatOptions);
    }
    clockFormatters.set(key, formatter);
  }
  return formatter.format(date);
}

/** The local clock fields needed for presence, kept beside the clock formatter. */
export function localTimeComponents(
  date: Date,
  timeZone: string,
): { hour: number; minute: number; weekday: string } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    const weekday = parts.find((part) => part.type === 'weekday')?.value.toLowerCase();
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || !weekday) return null;
    return { hour, minute, weekday };
  } catch {
    return null;
  }
}

export function formatSlotTime(iso: string, timeZone: string): string {
  return formatTime(new Date(iso), { timeZone });
}

export function formatRange(startIso: string, endIso: string, timeZone: string): string {
  const start = new Date(startIso);
  const day = start.toLocaleDateString(dateLocale, {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
  return `${day} · ${formatSlotTime(startIso, timeZone)}–${formatSlotTime(endIso, timeZone)}`;
}

/**
 * Range plus the zone it is quoted in. Room entry names the zone because the
 * guest arrives from a calendar invite that may have been written in another
 * one, and a wrong hour is worse than a long line.
 */
export function formatRangeWithZone(startIso: string, endIso: string, timeZone: string): string {
  const range = formatRange(startIso, endIso, timeZone);
  const label = timeZoneLabel(startIso, timeZone);
  return label ? `${range} ${label}` : range;
}

/**
 * Compact countdown precision follows distance: minutes when close, five
 * minute steps within the first ten hours, and whole hours after that. A
 * precise "4h 42m" implies accuracy the person cannot use at that distance.
 */
export function compactDuration(milliseconds: number): string {
  const totalMinutes = Math.round(Math.max(0, milliseconds) / 60_000);
  if (totalMinutes < 1) return 'now';
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 10) return `${Math.max(hours, Math.round(totalMinutes / 60))}h`;
  if (minutes < 8) return `${hours}h`;

  const snapped = Math.round(minutes / 5) * 5;
  if (snapped >= 60) return `${hours + 1}h`;
  return `${hours}h ${snapped}m`;
}

/** The short name of a zone at an instant ("CEST"), or an empty string. */
export function timeZoneLabel(iso: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat(dateLocale, {
      timeZone,
      hour: '2-digit',
      timeZoneName: 'short',
    }).formatToParts(new Date(iso));
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/**
 * "in 25 minutes", "in 3 weeks", "Happening now" — how far off a meeting is,
 * in words rather than the host app's dense `3h 15m`, because this is read by
 * a guest deciding whether to wait or come back.
 *
 * Returns null once the meeting has ended; the card shows expired copy then.
 * Uses `Intl.RelativeTimeFormat`, so pluralisation and translation come free.
 */
export function timeUntilMeeting(
  startIso: string | null,
  endIso: string | null,
  now = Date.now(),
): string | null {
  const start = startIso ? new Date(startIso).getTime() : NaN;
  if (Number.isNaN(start)) return null;

  const end = endIso ? new Date(endIso).getTime() : NaN;
  if (!Number.isNaN(end) && now >= end) return null;
  if (now >= start) return t('Happening now');

  const seconds = Math.round((start - now) / 1000);
  if (seconds < 60) return t('Starting now');

  const relative = new Intl.RelativeTimeFormat(uiLocale, { numeric: 'always' });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return relative.format(minutes, 'minute');

  // Round hours down until the last one, so "in 2 hours" never appears while
  // there are still 2h50m to go.
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return relative.format(hours, 'hour');

  const days = Math.floor(minutes / (60 * 24));
  if (days < 14) return relative.format(days, 'day');

  const weeks = Math.floor(days / 7);
  if (weeks < 9) return relative.format(weeks, 'week');

  return relative.format(Math.floor(days / 30), 'month');
}

/** Half-open: a meeting is over once the clock passes its end. */
export function hasEnded(endIso: string | null, now = Date.now()): boolean {
  if (!endIso) return false;
  const end = new Date(endIso).getTime();
  return !Number.isNaN(end) && end <= now;
}

/** The UTC offset of an IANA zone at an instant, in seconds; null for a zone this browser does not know. */
export function zoneOffsetSeconds(zone: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);
    const read = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const wall = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second'));
    const instant = Math.floor(at.getTime() / 1000) * 1000;
    return Math.round((wall - instant) / 1000);
  } catch {
    return null;
  }
}
