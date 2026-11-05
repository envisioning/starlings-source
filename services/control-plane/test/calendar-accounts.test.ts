import { describe, expect, it } from 'vitest';
import { PRIMARY_ACCOUNT_ID, decodeCalendarRef, encodeCalendarRef } from '../src/calendar';

describe('calendar refs across accounts', () => {
  it('leaves the owner’s own calendars exactly as they were', () => {
    // Stored preferences and default-calendar choices are full of these ids, so
    // the primary account's encoding has to stay byte-identical.
    expect(encodeCalendarRef(null, 'primary')).toBe('primary');
    expect(encodeCalendarRef(PRIMARY_ACCOUNT_ID, 'primary')).toBe('primary');
    expect(encodeCalendarRef(null, 'team@example.com')).toBe('team@example.com');
    expect(decodeCalendarRef('primary')).toEqual({ accountId: null, calendarId: 'primary' });
    expect(decodeCalendarRef('team@group.calendar.google.com')).toEqual({
      accountId: null,
      calendarId: 'team@group.calendar.google.com',
    });
  });

  it('keeps two accounts’ same-named calendars apart', () => {
    const mine = encodeCalendarRef(null, 'primary');
    const personal = encodeCalendarRef('acc123', 'primary');
    expect(personal).toBe('acct:acc123:primary');
    expect(personal).not.toBe(mine);
    expect(decodeCalendarRef(personal)).toEqual({ accountId: 'acc123', calendarId: 'primary' });
  });

  it('round-trips an address-shaped calendar id', () => {
    const ref = encodeCalendarRef('acc123', 'rosa@gmail.com');
    expect(decodeCalendarRef(ref)).toEqual({ accountId: 'acc123', calendarId: 'rosa@gmail.com' });
  });

  it('reads a malformed prefix as a plain id rather than guessing an account', () => {
    expect(decodeCalendarRef('acct:')).toEqual({ accountId: null, calendarId: 'acct:' });
    expect(decodeCalendarRef('acct::primary')).toEqual({ accountId: null, calendarId: 'acct::primary' });
  });
});
