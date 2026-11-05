import { describe, expect, it } from 'vitest';
import {
  calendarRoleForSummary,
  detectConference,
  isAllDayValue,
  isDisplayableUpcomingEvent,
  isPendingCalendarInvitation,
  travelTimeMinutesFromMetadata,
} from '../src/calendar';

describe('shared calendar role', () => {
  it('recognises Internal by its stable bootstrap title', () => {
    expect(calendarRoleForSummary(' Envisioning Internal ', 'Envisioning Internal')).toBe('global_interest');
    expect(calendarRoleForSummary('Personal', 'Envisioning Internal')).toBe('ordinary');
    // A workspace that names no shared calendar has none (meet#939).
    expect(calendarRoleForSummary('Envisioning Internal', null)).toBe('ordinary');
  });
});

describe('calendar upcoming display filter', () => {
  const now = Date.parse('2026-08-11T12:00:00.000Z');

  it('keeps future and in-progress meetings', () => {
    expect(isDisplayableUpcomingEvent({ title: 'Design review', end: '2026-08-11T13:00:00.000Z' }, now)).toBe(true);
    expect(isDisplayableUpcomingEvent({ title: 'Design review', end: '2026-08-11T12:30:00.000Z' }, now)).toBe(true);
  });

  it('removes ended and placeholder rows', () => {
    expect(isDisplayableUpcomingEvent({ title: 'Yesterday', end: '2026-08-11T11:59:00.000Z' }, now)).toBe(false);
    expect(isDisplayableUpcomingEvent({ title: 'Block', end: '2026-08-11T13:00:00.000Z' }, now)).toBe(false);
    expect(isDisplayableUpcomingEvent({ title: 'Blank', end: '2026-08-11T13:00:00.000Z' }, now)).toBe(false);
    expect(isDisplayableUpcomingEvent({ title: '  ', end: '2026-08-11T13:00:00.000Z' }, now)).toBe(false);
  });
});

describe('calendar invitation filter', () => {
  it('keeps an incoming invitation awaiting this account', () => {
    expect(isPendingCalendarInvitation({
      organizer: { self: false },
      attendees: [{ self: true, responseStatus: 'needsAction' }],
    })).toBe(true);
  });

  it('does not treat owned, cancelled, or answered events as invitations', () => {
    expect(isPendingCalendarInvitation({
      organizer: { self: true },
      attendees: [{ self: true, responseStatus: 'needsAction' }],
    })).toBe(false);
    expect(isPendingCalendarInvitation({
      status: 'cancelled',
      attendees: [{ self: true, responseStatus: 'needsAction' }],
    })).toBe(false);
    expect(isPendingCalendarInvitation({
      organizer: { self: false },
      attendees: [{ self: true, responseStatus: 'accepted' }],
    })).toBe(false);
  });
});

describe('all-day Google events', () => {
  it('treats date-only start as all-day', () => {
    expect(isAllDayValue({ date: '2026-08-14' })).toBe(true);
    expect(isAllDayValue({ dateTime: '2026-08-14T10:00:00.000Z' })).toBe(false);
    expect(isAllDayValue({ date: '2026-08-14', dateTime: '2026-08-14T10:00:00.000Z' })).toBe(false);
  });
});

describe('calendar travel metadata', () => {
  it('reads the owner-specific minute value before shared metadata', () => {
    expect(travelTimeMinutesFromMetadata({
      extendedProperties: {
        private: { meetTravelTimeMinutes: '35' },
        shared: { travelTimeMinutes: '20' },
      },
    })).toBe(35);
  });

  it('reads Apple’s ISO duration when a provider exposes it', () => {
    expect(travelTimeMinutesFromMetadata({
      extendedProperties: { shared: { 'X-APPLE-TRAVEL-DURATION': 'PT1H15M' } },
    })).toBe(75);
  });

  it('does not turn malformed or excessive metadata into a display value', () => {
    expect(travelTimeMinutesFromMetadata({
      extendedProperties: { private: { meetTravelTimeMinutes: 'route-needed' } },
    })).toBeNull();
    expect(travelTimeMinutesFromMetadata({
      extendedProperties: { private: { travelTimeMinutes: '1441' } },
    })).toBeNull();
  });
});

describe('calendar conference detection', () => {
  it('does not mistake a physical address or map URL for a meeting link', () => {
    expect(detectConference(
      { location: 'Pina Bauschplein 4 https://maps.google.com/?q=Pina+Bauschplein+4' },
      { envisioningJoinUrl: '' },
    )).toEqual({ platform: 'none', url: '' });
  });

  it('still detects a provider URL from the event description', () => {
    expect(detectConference(
      { description: 'Join us: https://zoom.us/j/123456789' },
      { envisioningJoinUrl: '' },
    )).toEqual({ platform: 'zoom', url: 'https://zoom.us/j/123456789' });
  });

  it('detects a provider URL in location without treating map links as meetings', () => {
    expect(detectConference(
      { location: 'https://us02web.zoom.us/j/123456789' },
      { envisioningJoinUrl: '' },
    )).toEqual({ platform: 'zoom', url: 'https://us02web.zoom.us/j/123456789' });
  });

  it('keeps a clear provider label when a join URL was not retained', () => {
    expect(detectConference(
      { location: 'Microsoft Teams Meeting' },
      { envisioningJoinUrl: '' },
    )).toEqual({ platform: 'teams', url: '' });
    expect(detectConference(
      { location: 'Google Meet' },
      { envisioningJoinUrl: '' },
    )).toEqual({ platform: 'google_meet', url: '' });
  });
});
