/**
 * A small iCalendar (RFC 5545) reader — enough of it to turn a published feed
 * (TripIt, a conference schedule, a shared "subscribe to this" link) into the
 * same event shape the rest of the calendar speaks.
 *
 * Deliberately not a full implementation. Feeds of this kind are overwhelmingly
 * a flat list of dated rows, so what is here is the flat list plus the simple
 * recurrences; see `expandRecurrence` for exactly which rules are honoured and
 * which are read as a single occurrence.
 */

export interface IcsEvent {
  uid: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  url: string;
  recurring: boolean;
}

/** Beyond this a feed is treated as hostile rather than large. */
const maxEvents = 5000;
const maxOccurrencesPerRule = 400;

export function parseICS(text: string, now = new Date()): IcsEvent[] {
  const lines = unfold(text);
  const events: IcsEvent[] = [];
  let current: Map<string, { value: string; params: Map<string, string> }> | null = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = new Map();
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) {
        const parsed = buildEvent(current, now);
        for (const event of parsed) {
          if (events.length >= maxEvents) return events;
          events.push(event);
        }
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const property = parseProperty(line);
    if (property) current.set(property.name, { value: property.value, params: property.params });
  }
  return events;
}

/**
 * Content lines may be split across physical lines, continued by a leading
 * space or tab. Everything downstream assumes whole lines, so this runs first.
 */
function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines.map((line) => line.trimEnd()).filter(Boolean);
}

function parseProperty(line: string): { name: string; value: string; params: Map<string, string> } | null {
  const colon = indexOfUnquoted(line, ':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(';');
  const name = (parts.shift() ?? '').toUpperCase();
  if (!name) return null;
  const params = new Map<string, string>();
  for (const part of parts) {
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    params.set(part.slice(0, equals).toUpperCase(), part.slice(equals + 1).replace(/^"|"$/g, ''));
  }
  return { name, value, params };
}

/** A colon inside a quoted parameter does not end the property name. */
function indexOfUnquoted(line: string, needle: string): number {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') quoted = !quoted;
    else if (!quoted && character === needle) return index;
  }
  return -1;
}

function buildEvent(
  fields: Map<string, { value: string; params: Map<string, string> }>,
  now: Date,
): IcsEvent[] {
  const startField = fields.get('DTSTART');
  if (!startField) return [];
  const start = parseDateValue(startField.value, startField.params);
  if (!start) return [];

  const endField = fields.get('DTEND');
  const durationField = fields.get('DURATION');
  let end = endField ? parseDateValue(endField.value, endField.params) : null;
  if (!end && durationField) {
    const seconds = parseDuration(durationField.value);
    if (seconds !== null) end = { date: new Date(start.date.getTime() + seconds * 1000), allDay: start.allDay };
  }
  if (!end) {
    // No end at all: an all-day row covers its day, a timed one gets an hour —
    // the same reading Apple and Google apply to the same input.
    const span = start.allDay ? 86_400_000 : 3_600_000;
    end = { date: new Date(start.date.getTime() + span), allDay: start.allDay };
  }
  if (end.date.getTime() <= start.date.getTime()) {
    end = { date: new Date(start.date.getTime() + (start.allDay ? 86_400_000 : 3_600_000)), allDay: start.allDay };
  }

  const status = (fields.get('STATUS')?.value ?? '').toUpperCase();
  if (status === 'CANCELLED') return [];

  const base: IcsEvent = {
    uid: fields.get('UID')?.value?.trim() || `${start.date.toISOString()}|${fields.get('SUMMARY')?.value ?? ''}`,
    title: unescapeText(fields.get('SUMMARY')?.value ?? ''),
    start: start.date.toISOString(),
    end: end.date.toISOString(),
    allDay: start.allDay,
    location: unescapeText(fields.get('LOCATION')?.value ?? ''),
    description: unescapeText(fields.get('DESCRIPTION')?.value ?? ''),
    url: (fields.get('URL')?.value ?? '').trim(),
    recurring: fields.has('RRULE'),
  };

  const rule = fields.get('RRULE')?.value;
  if (!rule) return [base];
  return expandRecurrence(base, rule, end.date.getTime() - start.date.getTime(), now);
}

/**
 * Handles the plain repeats — FREQ with INTERVAL, COUNT and UNTIL. A rule with
 * BYDAY, BYMONTHDAY or the rest is kept as its first occurrence rather than
 * guessed at: one row on the right day beats a fan of rows on wrong ones.
 */
function expandRecurrence(base: IcsEvent, rule: string, durationMs: number, now: Date): IcsEvent[] {
  const parts = new Map<string, string>();
  for (const piece of rule.split(';')) {
    const equals = piece.indexOf('=');
    if (equals > 0) parts.set(piece.slice(0, equals).toUpperCase(), piece.slice(equals + 1));
  }
  const freq = (parts.get('FREQ') ?? '').toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return [base];
  if ([...parts.keys()].some((key) => key.startsWith('BY'))) return [base];

  const interval = Math.max(1, Number.parseInt(parts.get('INTERVAL') ?? '1', 10) || 1);
  const count = parts.has('COUNT') ? Number.parseInt(parts.get('COUNT') ?? '', 10) : null;
  const untilValue = parts.get('UNTIL');
  const until = untilValue ? parseDateValue(untilValue, new Map())?.date ?? null : null;
  // A feed can repeat forever; a calendar only ever draws a window. A year
  // either side of today is more than any view asks for.
  const horizon = new Date(now.getTime() + 400 * 86_400_000);
  const floor = new Date(now.getTime() - 400 * 86_400_000);

  const events: IcsEvent[] = [];
  const first = new Date(base.start);
  for (let index = 0; index < maxOccurrencesPerRule; index += 1) {
    if (count !== null && Number.isFinite(count) && index >= count) break;
    const start = advance(first, freq, interval * index);
    if (until && start.getTime() > until.getTime()) break;
    if (start.getTime() > horizon.getTime()) break;
    if (start.getTime() >= floor.getTime()) {
      events.push({
        ...base,
        uid: index === 0 ? base.uid : `${base.uid}:${index}`,
        start: start.toISOString(),
        end: new Date(start.getTime() + durationMs).toISOString(),
      });
    }
  }
  return events.length > 0 ? events : [base];
}

function advance(from: Date, freq: string, steps: number): Date {
  const next = new Date(from.getTime());
  switch (freq) {
    case 'DAILY': next.setUTCDate(next.getUTCDate() + steps); break;
    case 'WEEKLY': next.setUTCDate(next.getUTCDate() + steps * 7); break;
    case 'MONTHLY': next.setUTCMonth(next.getUTCMonth() + steps); break;
    default: next.setUTCFullYear(next.getUTCFullYear() + steps); break;
  }
  return next;
}

/**
 * Three shapes appear in the wild: a date (all-day), a UTC instant ending in Z,
 * and a wall-clock time in a named zone. Only the last needs a timezone
 * database, and `Intl` is one — so the zone's offset is read at that instant
 * rather than assumed.
 */
export function parseDateValue(
  value: string,
  params: Map<string, string>,
): { date: Date; allDay: boolean } | null {
  const trimmed = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    return Number.isNaN(date.getTime()) ? null : { date, allDay: true };
  }

  const stamp = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(trimmed);
  if (!stamp) return null;
  const [, year, month, day, hour, minute, second, zulu] = stamp;
  const utc = Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second),
  );
  if (Number.isNaN(utc)) return null;
  if (zulu) return { date: new Date(utc), allDay: false };

  const zone = params.get('TZID');
  if (!zone) return { date: new Date(utc), allDay: false };
  const offset = zoneOffsetMs(zone, utc);
  return offset === null ? { date: new Date(utc), allDay: false } : { date: new Date(utc - offset), allDay: false };
}

/**
 * How far the named zone is from UTC at that moment, by asking `Intl` what the
 * wall clock there reads and comparing. Two passes because the answer shifts
 * the instant, and a daylight-saving boundary can move it across the change.
 */
function zoneOffsetMs(zone: string, utcMs: number): number | null {
  try {
    let offset = rawOffset(zone, utcMs);
    offset = rawOffset(zone, utcMs - offset);
    return offset;
  } catch {
    return null;
  }
}

function rawOffset(zone: string, utcMs: number): number {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = new Map(format.formatToParts(new Date(utcMs)).map((part) => [part.type, part.value]));
  const asUTC = Date.UTC(
    Number(parts.get('year')),
    Number(parts.get('month')) - 1,
    Number(parts.get('day')),
    Number(parts.get('hour')) % 24,
    Number(parts.get('minute')),
    Number(parts.get('second')),
  );
  return asUTC - utcMs;
}

function parseDuration(value: string): number | null {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!match) return null;
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const total =
    Number(weeks ?? 0) * 604_800 +
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);
  return sign === '-' ? -total : total;
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}
