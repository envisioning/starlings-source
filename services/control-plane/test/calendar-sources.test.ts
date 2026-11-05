import { describe, expect, it } from 'vitest';
import { hasCalendarSource } from '../src/calendar-sources';

describe('calendar sources (meet#982)', () => {
  it('has none without a connected account or a subscription', () => {
    expect(hasCalendarSource([], [])).toBe(false);
    // An extra account whose token was revoked is not a source.
    expect(hasCalendarSource([{ connected: false }], [])).toBe(false);
  });

  it('counts any connected Google account', () => {
    expect(hasCalendarSource([{ connected: false }, { connected: true }], [])).toBe(true);
  });

  it('counts a subscription without Google', () => {
    expect(hasCalendarSource([], [{ id: 'sub_1' }])).toBe(true);
  });
});
