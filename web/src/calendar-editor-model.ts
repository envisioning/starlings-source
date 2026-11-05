import { t } from './i18n';
interface EventTimeRange { start: string; end: string; allDay: boolean }

export interface LocalDateTimeParts {
  date: string;
  time: string;
}

/** Split the value used by the calendar API editor into date and 24-hour time controls. */
export function splitLocalDateTime(value: string): LocalDateTimeParts {
  const [date = '', time = ''] = value.split('T');
  return { date, time };
}

export function combineLocalDateTime(date: string, time: string): string {
  return date || time ? `${date}T${time}` : '';
}

export function localDateTime(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The calendar day of an instant, in this browser's zone — the day an all-day row is shown on. */
/** The minutes a time field moves by on Arrow Up / Down, and the grid a new event starts on. */
export const TIME_STEP_MINUTES = 5;

/**
 * A new event's start: the next quarter hour from `now`, never an odd minute
 * like 08:03. A time already on the step stays where it is.
 */
export function nextEventStart(now: Date, stepMinutes = 15): Date {
  const step = stepMinutes * 60_000;
  const floored = new Date(now);
  floored.setSeconds(0, 0);
  const rounded = Math.ceil(floored.getTime() / step) * step;
  return new Date(rounded);
}

/**
 * "HH:MM" moved by `delta` steps of `stepMinutes`, wrapping at midnight. An
 * odd minute lands on the step first (08:03 up is 08:05, down is 08:00), so
 * a time read from Google keeps its minute until someone moves it.
 */
export function stepTime(time: string, delta: number, stepMinutes = TIME_STEP_MINUTES): string | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match || delta === 0) return undefined;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  const onStep = minutes % stepMinutes === 0;
  const base = onStep
    ? minutes + delta * stepMinutes
    : delta > 0
      ? Math.ceil(minutes / stepMinutes) * stepMinutes + (delta - 1) * stepMinutes
      : Math.floor(minutes / stepMinutes) * stepMinutes + (delta + 1) * stepMinutes;
  const day = 24 * 60;
  const wrapped = ((base % day) + day) % day;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

export function localDay(value: string | Date): string {
  return localDateTime(value).split('T')[0] ?? '';
}

/**
 * Google stores an all-day event as two days, the end exclusive: a one-day
 * event on the 21st is `2026-09-21` to `2026-09-22`. The editor shows the
 * last day *inclusive*, so the person reads "21 to 21", not "21 to 22".
 */
export function allDayRange(event: { start: string; end: string }): { startDay: string; endDay: string } {
  const startDay = dayOfAllDayValue(event.start);
  const exclusiveEnd = dayOfAllDayValue(event.end);
  return { startDay, endDay: shiftDay(exclusiveEnd, -1) < startDay ? startDay : shiftDay(exclusiveEnd, -1) };
}

/** An all-day boundary from the wire is `YYYY-MM-DD` or a midnight instant; either way, a day. */
function dayOfAllDayValue(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  // The wire may spell the day as a UTC midnight; read it in UTC so the day
  // does not slide west of the date line.
  return new Date(value).toISOString().slice(0, 10);
}

export function shiftDay(day: string, days: number): string {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date + days));
  return shifted.toISOString().slice(0, 10);
}

/**
 * What an all-day save sends: days, the end exclusive, and `all_day` so the
 * Worker writes `date` rather than `dateTime`. Unchanged days send nothing.
 */
export function allDayPatch(
  startDay: string,
  endDay: string,
  original?: EventTimeRange,
): { start?: string; end?: string; all_day?: boolean } {
  const dayPattern = /^\d{4}-\d{2}-\d{2}$/u;
  if (!dayPattern.test(startDay) || !dayPattern.test(endDay)) throw new Error(t('Choose a start day and an end day.'));
  if (endDay < startDay) throw new Error(t('Choose an end day on or after the start.'));
  if (original?.allDay) {
    const current = allDayRange(original);
    if (current.startDay === startDay && current.endDay === endDay) return {};
  }
  return { start: startDay, end: shiftDay(endDay, 1), all_day: true };
}

/**
 * Which Google event a write on a recurring instance addresses: the instance
 * itself, or the series behind it. Google lists instances expanded and has
 * no cheap "this and following", so the second choice is the whole series —
 * the same two the Mac inspector offers (`CalendarWorkspace.googleTarget`).
 */
export type RecurrenceScope = 'this' | 'all';

export function recurrenceTarget(
  event: { id: string; recurringEventId?: string | undefined },
  scope: RecurrenceScope,
): string {
  if (scope === 'all' && event.recurringEventId) return event.recurringEventId;
  return event.id;
}

export function eventTimePatch(start: string, end: string, original?: EventTimeRange): { start?: string; end?: string; all_day?: boolean } {
  // An all-day event turned timed: the times are new by definition, and
  // `all_day: false` tells the Worker to write `dateTime` and clear `date`.
  const becameTimed = original?.allDay === true;
  // Preserve the original instants, including seconds and offsets, unless edited.
  if (!becameTimed && original && start === localDateTime(original.start) && end === localDateTime(original.end)) return {};
  const localDateTimePattern = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/u;
  if (!localDateTimePattern.test(start) || !localDateTimePattern.test(end)) throw new Error(t('Enter times as HH:MM in 24-hour time.'));
  const from = new Date(start); const to = new Date(end);
  if (!start || !end || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) throw new Error(t('Choose an end time after the start.'));
  return { start: from.toISOString(), end: to.toISOString(), ...(becameTimed ? { all_day: false } : {}) };
}
