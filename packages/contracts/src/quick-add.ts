/**
 * Calendar quick add: one typed sentence becomes an event draft.
 *
 * One grammar, written twice — here for the Worker and the web, and in
 * `Sources/CalendarQuickAdd.swift` for the Mac and the phone — and
 * `fixtures/quick-add.json` is what keeps them the same: every rule there is
 * a case here, and a change to either parser starts in the fixture.
 *
 * Deterministic and instant: no model, no network. What it does not read
 * (no date at all, or two time expressions) is what the Worker sends to the
 * notes engine instead; `confidence` says which. Times are local wall time
 * in the caller's zone, written without an offset; days are YYYY-MM-DD. The
 * arithmetic runs on calendar fields, never on `Date` in a zone, so a DST
 * edge cannot move a day.
 */

export interface QuickAddDraft {
  title: string;
  /** `YYYY-MM-DDTHH:MM` local, `YYYY-MM-DD` when all-day or when only a date was read, null when nothing was. */
  start: string | null;
  end: string | null;
  allDay: boolean;
  location: string | null;
  /** Names as typed after "with"; the caller resolves them against contacts. */
  invitees: string[];
  /** 1: a date and a time, or an all-day span. 0.5: only a date. 0: nothing read. */
  confidence: 0 | 0.5 | 1;
}

export interface QuickAddContext {
  /** The moment of typing as local wall time, `YYYY-MM-DDTHH:MM`. */
  now: string;
  defaultDurationMinutes: number;
}

export const QUICK_ADD_EMPTY_TITLE = 'New event';

interface Local { y: number; m: number; d: number }
interface Clock { h: number; min: number }
interface Span { start: number; end: number }

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_SHORT = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const WEEKDAY_RE = '(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)';
const MONTH_RE = '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';
/** A time with a marker: `14:00`, `14.00`, `2pm`, `2 pm`, `9:30am`, `14h`, `14h30`. */
const TIME_STRICT = '(\\d{1,2})(?::(\\d{2})|\\.(\\d{2})|h(\\d{2})?)?\\s*(am|pm)?';

/** The sentence as a draft. Pure. */
export function parseQuickAdd(input: string, context: QuickAddContext): QuickAddDraft {
  const text = input.replace(/\s+/gu, ' ').trim();
  const now = parseLocal(context.now);
  const consumed: Span[] = [];
  const take = (span: Span) => { consumed.push(span); };
  const free = (index: number) => !consumed.some((span) => index >= span.start && index < span.end);
  const lower = text.toLowerCase();

  // All day, anywhere.
  let allDay = false;
  for (const match of lower.matchAll(/\ball[- ]day\b/gu)) {
    allDay = true;
    take({ start: match.index, end: match.index + match[0].length });
  }

  // A span of days: "3-5 Oct", "3 to 5 Oct", "Oct 3-5", "14 Oct - 16 Oct".
  let day: Local | null = null;
  let lastDay: Local | null = null;
  let dayIsToday = false;
  const spanA = new RegExp(`\\b(\\d{1,2})\\s*(?:-|–|to)\\s*(\\d{1,2})\\s+(${MONTH_RE})\\b`, 'iu').exec(lower);
  const spanB = new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})\\s*(?:-|–|to)\\s*(\\d{1,2})\\b`, 'iu').exec(lower);
  const spanC = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_RE})\\s*(?:-|–|to)\\s*(\\d{1,2})\\s+(${MONTH_RE})\\b`, 'iu').exec(lower);
  if (spanC) {
    const first = nextDate(now, monthIndex(spanC[2]!), Number(spanC[1]));
    const last = { ...first, m: monthIndex(spanC[4]!), d: Number(spanC[3]) };
    if (compare(last, first) < 0) last.y += 1;
    day = first; lastDay = last; allDay = true;
    take({ start: spanC.index, end: spanC.index + spanC[0].length });
  } else if (spanA) {
    const month = monthIndex(spanA[3]!);
    day = nextDate(now, month, Number(spanA[1]));
    lastDay = { ...day, d: Number(spanA[2]) };
    allDay = true;
    take({ start: spanA.index, end: spanA.index + spanA[0].length });
  } else if (spanB) {
    const month = monthIndex(spanB[1]!);
    day = nextDate(now, month, Number(spanB[2]));
    lastDay = { ...day, d: Number(spanB[3]) };
    allDay = true;
    take({ start: spanB.index, end: spanB.index + spanB[0].length });
  }

  // A date: "14 October", "Oct 14", "14/10", "2026-10-14".
  if (!day) {
    const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/u.exec(lower);
    const dayMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\b`, 'iu').exec(lower);
    const monthDay = new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'iu').exec(lower);
    const numeric = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/u.exec(lower);
    if (iso) {
      day = { y: Number(iso[1]), m: Number(iso[2]) - 1, d: Number(iso[3]) };
      take({ start: iso.index, end: iso.index + iso[0].length });
    } else if (dayMonth) {
      day = nextDate(now, monthIndex(dayMonth[2]!), Number(dayMonth[1]));
      take({ start: dayMonth.index, end: dayMonth.index + dayMonth[0].length });
    } else if (monthDay) {
      day = nextDate(now, monthIndex(monthDay[1]!), Number(monthDay[2]));
      take({ start: monthDay.index, end: monthDay.index + monthDay[0].length });
    } else if (numeric) {
      const month = Number(numeric[2]) - 1;
      day = numeric[3] ? { y: Number(numeric[3]), m: month, d: Number(numeric[1]) } : nextDate(now, month, Number(numeric[1]));
      take({ start: numeric.index, end: numeric.index + numeric[0].length });
    }
  }

  // A day word: today, tomorrow, tonight, a weekday, "next <weekday>". A
  // weekday after "every" is recurrence, not a date, and stays in the title.
  let tonight = false;
  if (!day) {
    const word = /\b(today|tomorrow|tonight)\b/u.exec(lower);
    const weekday = new RegExp(`(?<!\\bevery\\s)\\b(next\\s+)?(${WEEKDAY_RE})\\b`, 'iu').exec(lower);
    if (word) {
      day = word[1] === 'tomorrow' ? addDays(now, 1) : { y: now.y, m: now.m, d: now.d };
      dayIsToday = word[1] !== 'tomorrow';
      tonight = word[1] === 'tonight';
      take({ start: word.index, end: word.index + word[0].length });
    } else if (weekday) {
      const target = weekdayIndex(weekday[2]!);
      const todayIndex = weekdayOf(now);
      let ahead = (target - todayIndex + 7) % 7;
      if (weekday[1]) ahead += 7;
      day = addDays(now, ahead);
      dayIsToday = ahead === 0;
      take({ start: weekday.index, end: weekday.index + weekday[0].length });
    }
  }
  // "on" before a day or date is dropped with it.
  for (const span of [...consumed]) {
    const before = /\bon\s+$/u.exec(text.slice(0, span.start));
    if (before) take({ start: before.index, end: span.start });
  }

  // Times: a range first, then "at <time>", then any marked time. More than
  // one expression is not for the grammar.
  const times: Array<{ clock: Clock; end?: Clock; span: Span }> = [];
  const range = new RegExp(`\\b${TIME_STRICT}\\s*(?:-|–|to|until)\\s*${TIME_STRICT}\\b`, 'iu');
  const rangeMatch = findFree(lower, range, free);
  if (rangeMatch) {
    const startClock = clockOf(rangeMatch[1]!, rangeMatch[2] ?? rangeMatch[3] ?? rangeMatch[4], rangeMatch[5]);
    const endClock = clockOf(rangeMatch[6]!, rangeMatch[7] ?? rangeMatch[8] ?? rangeMatch[9], rangeMatch[10]);
    if (startClock && endClock) {
      // A bare start takes the end's marker: "9-10am".
      if (!rangeMatch[5] && rangeMatch[10] && startClock.h <= 12) {
        const marked = clockOf(rangeMatch[1]!, undefined, rangeMatch[10]);
        if (marked) startClock.h = marked.h;
      }
      times.push({ clock: startClock, end: endClock, span: { start: rangeMatch.index, end: rangeMatch.index + rangeMatch[0].length } });
    }
  }
  const atTime = findFree(lower, new RegExp(`\\bat\\s+${TIME_STRICT}\\b`, 'iu'), free, times.map((entry) => entry.span));
  if (atTime) {
    const clock = clockOf(atTime[1]!, atTime[2] ?? atTime[3] ?? atTime[4], atTime[5]);
    if (clock) times.push({ clock, span: { start: atTime.index, end: atTime.index + atTime[0].length } });
  }
  const marked = new RegExp(`\\b(\\d{1,2})(?::(\\d{2})|\\.(\\d{2})|h(\\d{2})?|\\s*(am|pm))(?:\\s*(am|pm))?\\b`, 'giu');
  for (const match of lower.matchAll(marked)) {
    const span = { start: match.index, end: match.index + match[0].length };
    if (!free(span.start) || times.some((entry) => overlaps(entry.span, span))) continue;
    const isHourForm = match[4] !== undefined || /^\d{1,2}h/u.test(match[0]);
    // "1h30" after a time is a duration, not one o'clock.
    if (isHourForm && times.length > 0) continue;
    const clock = clockOf(match[1]!, match[2] ?? match[3] ?? match[4], match[5] ?? match[6]);
    if (clock) times.push({ clock, span });
  }
  if (times.length > 1) {
    return { title: text || QUICK_ADD_EMPTY_TITLE, start: null, end: null, allDay: false, location: null, invitees: [], confidence: 0 };
  }
  const time = times[0] ?? null;
  if (time) take(time.span);

  // A duration: "45 min", "1h30", "for 30 minutes", "1.5h".
  let durationMinutes: number | null = null;
  const duration = findFree(lower, /\b(?:for\s+)?(\d+(?:[.,]\d+)?)\s*(minutes?|mins?|hours?|hrs?|h)(?:\s*(\d{2}))?\b/iu, free);
  if (duration) {
    const amount = Number(duration[1]!.replace(',', '.'));
    const unit = duration[2]!.toLowerCase();
    durationMinutes = unit.startsWith('h') ? Math.round(amount * 60) + (duration[3] ? Number(duration[3]) : 0) : Math.round(amount);
    take({ start: duration.index, end: duration.index + duration[0].length });
  }

  // Invitees: "with <name>, <name> and <name>". Read, not consumed.
  const invitees: string[] = [];
  const name = "[A-ZÀ-ÝÁÉÍÓÚÂÊÔÃÕÇ][\\w'’-]*(?:\\s+[A-ZÀ-ÝÁÉÍÓÚÂÊÔÃÕÇ][\\w'’-]*)?";
  // Read over the sentence with what was consumed blanked out, so a weekday
  // after a name cannot pass for a surname.
  const residual = [...text].map((char, index) => (free(index) ? char : ' ')).join('');
  const withMatch = new RegExp(`\\bwith\\s+(${name}(?:\\s*,\\s*${name})*(?:\\s+and\\s+${name})?)`, 'u').exec(residual);
  if (withMatch) {
    for (const part of withMatch[1]!.split(/\s*,\s*|\s+and\s+/u)) {
      const trimmed = part.trim();
      if (trimmed) invitees.push(trimmed);
    }
  }

  // A place: "at <words>" up to a comma or something already read.
  let location: string | null = null;
  const at = findFree(text, /\bat\s+(?=\S)/iu, free);
  if (at) {
    const from = at.index + at[0].length;
    let end = text.length;
    for (const span of consumed) if (span.start >= from && span.start < end) end = span.start;
    const comma = text.indexOf(',', from);
    if (comma !== -1 && comma < end) end = comma;
    const withAt = text.slice(from).search(/\bwith\b/u);
    if (withAt !== -1 && from + withAt < end) end = from + withAt;
    const place = text.slice(from, end).trim();
    if (place) {
      location = place;
      take({ start: at.index, end });
    }
  }

  // The title is what is left.
  let title = '';
  for (let index = 0; index < text.length; index += 1) if (free(index)) title += text[index];
  title = title.replace(/\s+/gu, ' ').replace(/\s*,\s*/gu, ', ').trim();
  const dangling = /^(?:(?:on|for|from|the|at|,)\s+)+|(?:\s+(?:on|for|from|the|at))+$|[,\s]+$|^[,\s]+/giu;
  let previous = '';
  while (previous !== title) { previous = title; title = title.replace(dangling, '').trim(); }
  if (!title) title = QUICK_ADD_EMPTY_TITLE;

  // Assemble.
  if (!day && !time) {
    return { title, start: null, end: null, allDay: false, location, invitees, confidence: 0 };
  }
  if (allDay || lastDay) {
    const first = day ?? { y: now.y, m: now.m, d: now.d };
    const last = lastDay ?? first;
    return { title, start: formatDay(first), end: formatDay(addDays(last, 1)), allDay: true, location, invitees, confidence: 1 };
  }
  if (day && !time && !tonight) {
    return { title, start: formatDay(day), end: null, allDay: false, location, invitees, confidence: 0.5 };
  }
  const clock: Clock = time?.clock ?? { h: 19, min: 0 };
  let startDay = day;
  if (!startDay) {
    // No day: today while the time is ahead, otherwise tomorrow.
    const nowClock = clockOfLocal(context.now);
    startDay = clock.h * 60 + clock.min > nowClock.h * 60 + nowClock.min ? { y: now.y, m: now.m, d: now.d } : addDays(now, 1);
  } else if (dayIsToday && day && time) {
    const nowClock = clockOfLocal(context.now);
    if (clock.h * 60 + clock.min <= nowClock.h * 60 + nowClock.min && !tonight) {
      // A weekday that is today with its time gone is next week; "today"
      // itself stays today.
      if (!/\btoday\b/u.test(lower)) startDay = addDays(day, 7);
    }
  }
  const start = { day: startDay, clock };
  let end: { day: Local; clock: Clock };
  if (time?.end) {
    const endDay = time.end.h * 60 + time.end.min < clock.h * 60 + clock.min && clock.h >= 12 ? addDays(startDay, 1) : startDay;
    end = { day: endDay, clock: time.end };
  } else {
    end = addMinutes(start, durationMinutes ?? context.defaultDurationMinutes);
  }
  return { title, start: formatLocal(start.day, start.clock), end: formatLocal(end.day, end.clock), allDay: false, location, invitees, confidence: 1 };
}

// MARK: - Pieces

function findFree(haystack: string, pattern: RegExp, free: (index: number) => boolean, avoid: Span[] = []): RegExpExecArray | null {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (const match of haystack.matchAll(global)) {
    const span = { start: match.index, end: match.index + match[0].length };
    if (free(span.start) && free(Math.max(span.start, span.end - 1)) && !avoid.some((other) => overlaps(other, span))) {
      return match as unknown as RegExpExecArray;
    }
  }
  return null;
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

function clockOf(hourText: string, minuteText: string | undefined, meridiem: string | undefined): Clock | null {
  let h = Number(hourText);
  const min = minuteText ? Number(minuteText) : 0;
  if (Number.isNaN(h) || h > 23 || min > 59) return null;
  if (meridiem === 'pm' && h < 12) h += 12;
  if (meridiem === 'am' && h === 12) h = 0;
  return { h, min };
}

function monthIndex(name: string): number {
  const lower = name.toLowerCase();
  const long = MONTHS.indexOf(lower);
  if (long !== -1) return long;
  return MONTH_SHORT.indexOf(lower.slice(0, 3));
}

function weekdayIndex(name: string): number {
  const lower = name.toLowerCase();
  const long = WEEKDAYS.indexOf(lower);
  if (long !== -1) return long;
  return WEEKDAY_SHORT.indexOf(lower.slice(0, 3));
}

function parseLocal(value: string): Local {
  const [datePart] = value.split('T');
  const [y, m, d] = datePart!.split('-').map(Number);
  return { y: y!, m: m! - 1, d: d! };
}

function clockOfLocal(value: string): Clock {
  const timePart = value.split('T')[1] ?? '00:00';
  const [h, min] = timePart.split(':').map(Number);
  return { h: h ?? 0, min: min ?? 0 };
}

function compare(a: Local, b: Local): number {
  return a.y !== b.y ? a.y - b.y : a.m !== b.m ? a.m - b.m : a.d - b.d;
}

/** The next such day-and-month from `now`, today included. */
function nextDate(now: Local, month: number, dayOfMonth: number): Local {
  const candidate = { y: now.y, m: month, d: dayOfMonth };
  return compare(candidate, now) < 0 ? { ...candidate, y: now.y + 1 } : candidate;
}

function addDays(local: Local, days: number): Local {
  const stamp = Date.UTC(local.y, local.m, local.d + days);
  const date = new Date(stamp);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate() };
}

function weekdayOf(local: Local): number {
  return new Date(Date.UTC(local.y, local.m, local.d)).getUTCDay();
}

function addMinutes(at: { day: Local; clock: Clock }, minutes: number): { day: Local; clock: Clock } {
  const total = at.clock.h * 60 + at.clock.min + minutes;
  const days = Math.floor(total / (24 * 60));
  const rest = total - days * 24 * 60;
  return { day: addDays(at.day, days), clock: { h: Math.floor(rest / 60), min: rest % 60 } };
}

function formatDay(local: Local): string {
  return `${local.y}-${String(local.m + 1).padStart(2, '0')}-${String(local.d).padStart(2, '0')}`;
}

function formatLocal(local: Local, clock: Clock): string {
  return `${formatDay(local)}T${String(clock.h).padStart(2, '0')}:${String(clock.min).padStart(2, '0')}`;
}
