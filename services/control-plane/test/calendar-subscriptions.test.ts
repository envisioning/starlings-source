import { describe, expect, it } from 'vitest';
import { parseICS } from '../src/ics';
import { normalizeFeedURL } from '../src/calendar-subscriptions';
import { googleEventTimes, startTimeZoneOf, travelTimeMinutesFromMetadata } from '../src/calendar';
import { calendarEventCreateSchema, calendarEventPatchSchema } from '@starlings/contracts';

const firstEvent = (...args: Parameters<typeof parseICS>) => {
  const [event] = parseICS(...args);
  if (!event) throw new Error('expected at least one event');
  return event;
};

const feed = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:TripIt\r\n${body}\r\nEND:VCALENDAR\r\n`;

describe('ics parsing', () => {
  it('reads a plain timed event', () => {
    const events = parseICS(feed([
      'BEGIN:VEVENT',
      'UID:trip-1',
      'SUMMARY:Flight to Lisbon',
      'LOCATION:AMS',
      'DTSTART:20260818T081500Z',
      'DTEND:20260818T101500Z',
      'END:VEVENT',
    ].join('\r\n')));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      uid: 'trip-1',
      title: 'Flight to Lisbon',
      location: 'AMS',
      start: '2026-08-18T08:15:00.000Z',
      end: '2026-08-18T10:15:00.000Z',
      allDay: false,
    });
  });

  it('reads a wall-clock time in a named zone at that zone’s offset', () => {
    const event = firstEvent(feed([
      'BEGIN:VEVENT',
      'UID:zoned',
      'SUMMARY:Standup',
      'DTSTART;TZID=Europe/Amsterdam:20260818T100000',
      'DTEND;TZID=Europe/Amsterdam:20260818T103000',
      'END:VEVENT',
    ].join('\r\n')));
    // Amsterdam is UTC+2 in August.
    expect(event.start).toBe('2026-08-18T08:00:00.000Z');
    expect(event.end).toBe('2026-08-18T08:30:00.000Z');
  });

  it('treats a date-only value as all-day', () => {
    const event = firstEvent(feed([
      'BEGIN:VEVENT',
      'UID:allday',
      'SUMMARY:Conference',
      'DTSTART;VALUE=DATE:20260818',
      'DTEND;VALUE=DATE:20260820',
      'END:VEVENT',
    ].join('\r\n')));
    expect(event.allDay).toBe(true);
    expect(event.start).toBe('2026-08-18T00:00:00.000Z');
    expect(event.end).toBe('2026-08-20T00:00:00.000Z');
  });

  it('unfolds continued lines and unescapes text', () => {
    const event = firstEvent(feed([
      'BEGIN:VEVENT',
      'UID:folded',
      'SUMMARY:Dinner with Ana\\, Bo',
      'DESCRIPTION:First line\\nSecond line and a very long tail that the feed',
      '  wrapped onto another physical line',
      'DTSTART:20260818T180000Z',
      'DTEND:20260818T200000Z',
      'END:VEVENT',
    ].join('\r\n')));
    expect(event.title).toBe('Dinner with Ana, Bo');
    expect(event.description).toContain('First line\nSecond line');
    expect(event.description).toContain('wrapped onto another physical line');
  });

  it('gives an event with no end a sensible one, and drops cancelled rows', () => {
    const events = parseICS(feed([
      'BEGIN:VEVENT',
      'UID:open-ended',
      'SUMMARY:Layover',
      'DTSTART:20260818T090000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:gone',
      'SUMMARY:Cancelled flight',
      'STATUS:CANCELLED',
      'DTSTART:20260819T090000Z',
      'END:VEVENT',
    ].join('\r\n')));
    expect(events).toHaveLength(1);
    expect(events[0]?.end).toBe('2026-08-18T10:00:00.000Z');
  });

  it('expands a simple weekly rule and stops at COUNT', () => {
    const now = new Date('2026-08-18T00:00:00.000Z');
    const events = parseICS(feed([
      'BEGIN:VEVENT',
      'UID:weekly',
      'SUMMARY:Team sync',
      'DTSTART:20260818T090000Z',
      'DTEND:20260818T093000Z',
      'RRULE:FREQ=WEEKLY;COUNT=3',
      'END:VEVENT',
    ].join('\r\n')), now);
    expect(events.map((event) => event.start)).toEqual([
      '2026-08-18T09:00:00.000Z',
      '2026-08-25T09:00:00.000Z',
      '2026-09-01T09:00:00.000Z',
    ]);
    expect(events.every((event) => event.recurring)).toBe(true);
  });

  it('keeps a rule it cannot honour as one occurrence rather than guessing', () => {
    const events = parseICS(feed([
      'BEGIN:VEVENT',
      'UID:byday',
      'SUMMARY:Standup',
      'DTSTART:20260818T090000Z',
      'DTEND:20260818T091500Z',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR',
      'END:VEVENT',
    ].join('\r\n')), new Date('2026-08-18T00:00:00.000Z'));
    expect(events).toHaveLength(1);
  });
});

describe('feed addresses', () => {
  it('accepts webcal and https, and normalises webcal to https', () => {
    expect(normalizeFeedURL('webcal://tripit.com/feed/abc.ics')).toBe('https://tripit.com/feed/abc.ics');
    expect(normalizeFeedURL(' https://tripit.com/feed/abc.ics ')).toBe('https://tripit.com/feed/abc.ics');
  });

  it('refuses addresses that would make the server read something private', () => {
    for (const bad of [
      'http://localhost:8787/api/calendar/status',
      'https://127.0.0.1/feed.ics',
      'https://10.0.0.4/feed.ics',
      'https://192.168.1.9/feed.ics',
      'https://169.254.169.254/latest/meta-data',
      'https://172.20.1.1/feed.ics',
      'https://intranet/feed.ics',
      'https://records.internal/feed.ics',
      'file:///etc/passwd',
      'https://user:secret@tripit.com/feed.ics',
      '',
    ]) {
      expect(() => normalizeFeedURL(bad), bad).toThrow();
    }
  });
});

describe('all-day writes (meet#232)', () => {
  it('sends days as `date` and clears `dateTime` on a patch, nothing extra on an insert', () => {
    expect(googleEventTimes({ start: '2026-09-21', end: '2026-09-22', allDay: true })).toEqual({
      start: { date: '2026-09-21', dateTime: null },
      end: { date: '2026-09-22', dateTime: null },
    });
    expect(googleEventTimes({ start: '2026-09-21', end: '2026-09-22', allDay: true }, 'insert')).toEqual({
      start: { date: '2026-09-21' },
      end: { date: '2026-09-22' },
    });
    expect(googleEventTimes({ start: '2026-09-21T09:00:00Z', end: '2026-09-21T10:00:00Z', timeZone: 'Europe/Amsterdam' })).toEqual({
      start: { dateTime: '2026-09-21T09:00:00Z', date: null, timeZone: 'Europe/Amsterdam' },
      end: { dateTime: '2026-09-21T10:00:00Z', date: null, timeZone: 'Europe/Amsterdam' },
    });
  });

  it('refuses days on a timed event and instants on an all-day one', () => {
    const base = { calendar_id: 'primary', event_id: 'e1' };
    expect(calendarEventPatchSchema.safeParse({ ...base, start: '2026-09-21', end: '2026-09-22', all_day: true }).success).toBe(true);
    expect(calendarEventPatchSchema.safeParse({ ...base, start: '2026-09-21', end: '2026-09-22' }).success).toBe(false);
    expect(calendarEventPatchSchema.safeParse({ ...base, start: '2026-09-21T09:00:00Z', end: '2026-09-21T10:00:00Z', all_day: true }).success).toBe(false);
    expect(calendarEventPatchSchema.safeParse({ ...base, start: '2026-09-22', end: '2026-09-21', all_day: true }).success).toBe(false);
    expect(calendarEventCreateSchema.safeParse({ title: 'Offsite', start: '2026-09-21', end: '2026-09-22', all_day: true }).success).toBe(true);
  });
});

describe('travel time on the wire (meet#238)', () => {
  it('takes 0 to 1440 minutes or null, and refuses the rest', () => {
    const base = { calendar_id: 'primary', event_id: 'e1' };
    expect(calendarEventPatchSchema.safeParse({ ...base, travel_time_minutes: 30 }).success).toBe(true);
    expect(calendarEventPatchSchema.safeParse({ ...base, travel_time_minutes: 0 }).success).toBe(true);
    expect(calendarEventPatchSchema.safeParse({ ...base, travel_time_minutes: null }).success).toBe(true);
    expect(calendarEventPatchSchema.safeParse({ ...base, travel_time_minutes: 1_441 }).success).toBe(false);
    expect(calendarEventPatchSchema.safeParse({ ...base, travel_time_minutes: 7.5 }).success).toBe(false);
    expect(calendarEventCreateSchema.safeParse({ title: 'Site visit', start: '2026-09-21T09:00:00Z', end: '2026-09-21T10:00:00Z', travel_time_minutes: 45 }).success).toBe(true);
  });

  it('carries the zone Google stored on a timed start, and nothing for all-day or unzoned events (meet#610)', () => {
    expect(startTimeZoneOf({ start: { dateTime: '2026-10-01T12:05:00+02:00', timeZone: 'Europe/Berlin' } })).toEqual({ startTimeZone: 'Europe/Berlin' });
    expect(startTimeZoneOf({ start: { dateTime: '2026-10-01T12:05:00+02:00' } })).toEqual({});
    expect(startTimeZoneOf({ start: { date: '2026-10-01' } })).toEqual({});
    expect(startTimeZoneOf({})).toEqual({});
  });

  it('is read back from the key the Worker writes', () => {
    expect(travelTimeMinutesFromMetadata({ extendedProperties: { private: { meetTravelTimeMinutes: '30' } } })).toBe(30);
    expect(travelTimeMinutesFromMetadata({ extendedProperties: { private: { meetTravelTimeMinutes: '0' } } })).toBeNull();
  });
});
