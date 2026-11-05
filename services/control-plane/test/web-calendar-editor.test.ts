import { beforeAll, describe, expect, it, vi } from 'vitest';
import { allDayPatch, combineLocalDateTime, eventTimePatch, localDateTime, splitLocalDateTime } from '../../../web/src/calendar-editor-model';
import type { WebCalendarEvent } from '../../../web/src/owner-agenda';

const event = { start: '2026-09-05T12:30:45+02:00', end: '2026-09-05T13:30:45+02:00', allDay: false };
describe('Web event editing', () => {
  it('keeps the editor clock as an explicit 24-hour value', () => {
    expect(splitLocalDateTime('2026-09-05T14:30')).toEqual({ date: '2026-09-05', time: '14:30' });
    expect(combineLocalDateTime('2026-09-05', '14:30')).toBe('2026-09-05T14:30');
    expect(() => eventTimePatch('2026-09-05T02:00 PM', '2026-09-05T14:30')).toThrow('24-hour');
    expect(() => eventTimePatch('2026-09-05T24:00', '2026-09-05T14:30')).toThrow('24-hour');
  });

  it('does not rewrite times, offsets or seconds when only the title changed', () => {
    expect(eventTimePatch(localDateTime(event.start), localDateTime(event.end), event)).toEqual({});
  });
  it('sends both instants when either endpoint changes', () => {
    const end = localDateTime(new Date(Date.parse(event.end) + 3600000));
    const patch = eventTimePatch(localDateTime(event.start), end, event);
    expect(patch.start).toBeTruthy(); expect(patch.end).toBeTruthy();
    expect(Date.parse(patch.end!)).toBeGreaterThan(Date.parse(patch.start!));
  });
  it('keeps an all-day event all-day unless the box is cleared (meet#232)', () => {
    // The editor routes an all-day event through allDayPatch while the box
    // is on; unchanged days send nothing.
    const allDay = { start: '2026-09-05', end: '2026-09-06', allDay: true };
    expect(allDayPatch('2026-09-05', '2026-09-05', allDay)).toEqual({});
    // Box cleared: the times are new by definition, and all_day: false tells
    // the Worker to write dateTime and clear date.
    const timed = eventTimePatch('2026-09-05T09:00', '2026-09-05T10:00', allDay);
    expect(timed.all_day).toBe(false);
    expect(timed.start).toBeTruthy();
  });
  it('rejects invalid or reversed ranges before sending a write', () => {
    expect(() => eventTimePatch('', 'bad')).toThrow();
    expect(() => eventTimePatch('2026-09-05T13:00', '2026-09-05T12:00')).toThrow();
  });
});

const calendarEvent = (overrides: Partial<WebCalendarEvent> = {}): WebCalendarEvent => ({
  id: 'primary:event',
  title: 'Status',
  start: '2026-09-08T13:00:00.000Z',
  end: '2026-09-08T14:00:00.000Z',
  calendarId: 'primary',
  // The page's workspace name; without the meta it is the product's (meet#934).
  calendarSummary: 'Starlings',
  location: '',
  platform: 'none',
  conferenceUrl: '',
  joinUrl: '',
  htmlLink: 'https://calendar.google.com/event',
  roomSlug: '',
  attendees: [],
  demoted: false,
  allDay: false,
  ...overrides,
});

describe('Web calendar list display model', () => {
  let agenda: typeof import('../../../web/src/owner-agenda');

  beforeAll(async () => {
    vi.stubGlobal('window', { location: { origin: 'http://local' } });
    agenda = await import('../../../web/src/owner-agenda');
  });

  it('combines same-provider copies and keeps the useful meeting details', () => {
    const combined = agenda.combineIdenticalEvents([
      calendarEvent({ platform: 'zoom', conferenceUrl: 'https://zoom.us/j/123' }),
      calendarEvent({
        id: 'secondary:event',
        calendarId: 'secondary',
        platform: 'zoom',
        conferenceUrl: 'https://zoom.us/j/123',
        attendees: [{ name: 'Ana', email: 'ana@example.net', status: 'accepted', optional: false, self: false }],
      }),
    ], new Set(['primary']));

    expect(combined).toHaveLength(1);
    expect(combined[0]).toMatchObject({ calendarId: 'primary', platform: 'zoom', conferenceUrl: 'https://zoom.us/j/123' });
    expect(agenda.participantNames(combined[0]!)).toEqual(['Ana']);
  });

  it('does not combine same-title, same-time rows from different providers', () => {
    const combined = agenda.combineIdenticalEvents([
      calendarEvent({ platform: 'envisioning', conferenceUrl: 'https://envisioning.starlings.example/rosa/token' }),
      calendarEvent({
        id: 'secondary:event',
        calendarId: 'secondary',
        platform: 'teams',
        conferenceUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
      }),
    ]);

    expect(combined).toHaveLength(2);
    expect(combined.map((item) => item.platform)).toEqual(['envisioning', 'teams']);
  });

  it('keeps the CRM name when duplicate calendar copies disagree', () => {
    const combined = agenda.combineIdenticalEvents([
      calendarEvent({ attendees: [{ name: 'Ana from Google', email: 'ana@example.net', status: 'accepted', optional: false, self: false }] }),
      calendarEvent({
        id: 'secondary:event',
        calendarId: 'secondary',
        attendees: [{
          name: 'Ana CRM',
          email: 'ana@example.net',
          inCrm: true,
          crmUrl: 'https://core.invalid/contacts/contact-1',
          status: 'accepted',
          optional: false,
          self: false,
        }],
      }),
    ]);

    expect(combined[0]?.attendees[0]).toMatchObject({
      name: 'Ana CRM',
      inCrm: true,
      crmUrl: 'https://core.invalid/contacts/contact-1',
    });
  });

  it('does not combine rows with different times and hides the repeated primary label', () => {
    expect(agenda.combineIdenticalEvents([
      calendarEvent(),
      calendarEvent({ id: 'later:event', start: '2026-09-08T14:00:00.000Z', end: '2026-09-08T15:00:00.000Z' }),
    ])).toHaveLength(2);
    expect(agenda.calendarSourceLabel(calendarEvent())).toBe('');
    expect(agenda.calendarSourceLabel(calendarEvent({ calendarSummary: 'Envisioning Internal' }))).toBe('Envisioning Internal');
  });

  it('uses a platform pill and keeps meeting URLs out of location copy', () => {
    expect(agenda.platformLabel(calendarEvent({ platform: 'zoom' }))).toBe('Zoom');
    expect(agenda.platformLabel(calendarEvent({ platform: 'google_meet' }))).toBe('Google Meet');
    expect(agenda.platformLabel(calendarEvent({ platform: 'teams' }))).toBe('Teams');
    expect(agenda.platformLabel(calendarEvent({ platform: 'envisioning' }))).toBe('Starlings');
    expect(agenda.calendarLocationLabel(calendarEvent({
      platform: 'zoom',
      location: 'https://zoom.us/j/123',
    }))).toBe('');
    expect(agenda.calendarLocationLabel(calendarEvent({ location: 'Room 4' }))).toBe('Room 4');
    expect(agenda.calendarLocationLabel(calendarEvent({ platform: 'teams', location: 'Microsoft Teams Meeting' }))).toBe('');
    expect(agenda.travelTimeLabel(60)).toBe('Travel time: 1h');
  });

  it('only shows a launch action while an event is active', () => {
    const now = Date.parse('2026-09-08T13:30:00.000Z');
    expect(agenda.isInProgress(calendarEvent(), now)).toBe(true);
    expect(agenda.isInProgress(calendarEvent({ start: '2026-09-08T14:00:00.000Z', end: '2026-09-08T15:00:00.000Z' }), now)).toBe(false);
    expect(agenda.isInProgress(calendarEvent({ start: '2026-09-08T12:00:00.000Z', end: '2026-09-08T13:00:00.000Z' }), now)).toBe(false);
  });

  it('does not turn a calendar page or map address into a video action', () => {
    const physical = calendarEvent({ location: 'Pina Bauschplein 4 https://maps.google.com/?q=Pina+Bauschplein+4' });
    expect(agenda.eventLaunchURL(physical)).toBe('');
    expect(agenda.isVideoMeeting(physical)).toBe(false);
    expect(agenda.eventLaunchURL(calendarEvent({ htmlLink: 'https://calendar.google.com/event' }))).toBe('');
  });

  it('coarsens distant countdowns to useful precision', () => {
    const now = Date.parse('2026-09-08T10:00:00.000Z');
    const event = calendarEvent({
      start: '2026-09-08T14:42:00.000Z',
      end: '2026-09-08T15:42:00.000Z',
    });
    expect(agenda.countdown(event, now)).toBe('in 4h 40m');
  });
});
