import { describe, expect, it } from 'vitest';
import { extractAttendees, firstEmailIn, guestNotification } from '../src/calendar';

describe('calendar attendee email extraction', () => {
  it('keeps display names and lowercases Google emails (.com and .io)', () => {
    const people = extractAttendees({
      attendees: [
        {
          displayName: 'Dara Cavalheiro',
          email: 'Dara@EXAMPLE.ORG',
          responseStatus: 'accepted',
          self: false,
        },
        {
          email: 'felix@example.org',
          responseStatus: 'needsAction',
        },
        {
          displayName: 'Conference Room A',
          email: 'room-a@example.com',
          resource: true,
          responseStatus: 'accepted',
        },
      ],
    });

    expect(people).toEqual([
      {
        name: 'Dara Cavalheiro',
        email: 'dara@example.org',
        status: 'accepted',
        optional: false,
        self: false,
      },
      {
        name: 'felix@example.org',
        email: 'felix@example.org',
        status: 'needsAction',
        optional: false,
        self: false,
      },
    ]);
  });

  it('recovers an address embedded only in displayName', () => {
    const people = extractAttendees({
      attendees: [
        {
          displayName: 'Theo Rezende <theo@example.org>',
          responseStatus: 'accepted',
        },
        {
          displayName: 'mailto:tarik@example.org',
          responseStatus: 'tentative',
        },
      ],
    });

    expect(people.map((person) => person.email)).toEqual([
      'theo@example.org',
      'tarik@example.org',
    ]);
  });

  it('uses the CRM roster name for an Envisioning attendee', () => {
    const people = extractAttendees({
      attendees: [{
        displayName: 'felix@example.org',
        email: 'felix@example.org',
        responseStatus: 'accepted',
      }],
    }, new Map([
      ['felix@example.org', {
        name: 'Felix Andrade',
        crmUrl: 'https://core.invalid/contacts/123e4567-e89b-12d3-a456-426614174000',
      }],
    ]));

    expect(people[0]).toMatchObject({
      name: 'Felix Andrade',
      email: 'felix@example.org',
      inCrm: true,
      crmUrl: 'https://core.invalid/contacts/123e4567-e89b-12d3-a456-426614174000',
    });
  });

  it('parses plain, mailto, and angle-bracket forms', () => {
    expect(firstEmailIn('dara@example.org')).toBe('dara@example.org');
    expect(firstEmailIn('Dara Cavalheiro <Dara@EXAMPLE.ORG>')).toBe('dara@example.org');
    expect(firstEmailIn('mailto:ROSA@EXAMPLE.COM')).toBe('rosa@example.com');
    expect(firstEmailIn('Dara Cavalheiro')).toBe('');
    expect(firstEmailIn('')).toBe('');
  });
});

describe('guest notification on an event change', () => {
  it('notifies when the invite list changed', () => {
    expect(guestNotification({ attendeesChanged: true, rescheduled: false })).toBe('all');
  });

  it('notifies on a reschedule even when the caller sent no guest list', () => {
    // A drag in the grid sends attendees: nil so RSVPs are never rewritten;
    // the guests still have to learn the meeting moved.
    expect(guestNotification({ attendeesChanged: false, rescheduled: true })).toBe('all');
  });

  it('stays quiet for a title or notes edit', () => {
    expect(guestNotification({ attendeesChanged: false, rescheduled: false })).toBe('none');
  });
});
