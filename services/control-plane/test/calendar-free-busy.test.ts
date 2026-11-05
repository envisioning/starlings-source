import { describe, expect, it } from 'vitest';
import { calendarFreeBusySchema } from '@starlings/contracts';

describe('availability query', () => {
  const base = {
    time_min: '2026-08-17T00:00:00.000Z',
    time_max: '2026-08-24T00:00:00.000Z',
  };

  it('accepts a week for a couple of people', () => {
    const parsed = calendarFreeBusySchema.parse({
      ...base,
      emails: ['a@example.com', 'b@example.com'],
    });
    expect(parsed.emails).toHaveLength(2);
  });

  it('requires at least one person, since nobody has no availability', () => {
    expect(() => calendarFreeBusySchema.parse({ ...base, emails: [] })).toThrow();
  });

  it('refuses a crowd', () => {
    const crowd = Array.from({ length: 21 }, (_, index) => `p${index}@example.com`);
    expect(() => calendarFreeBusySchema.parse({ ...base, emails: crowd })).toThrow();
  });

  it('refuses a range that runs backwards', () => {
    expect(() => calendarFreeBusySchema.parse({
      time_min: base.time_max,
      time_max: base.time_min,
      emails: ['a@example.com'],
    })).toThrow();
  });

  it('caps how far ahead availability can be asked for', () => {
    expect(() => calendarFreeBusySchema.parse({
      time_min: '2026-01-01T00:00:00.000Z',
      time_max: '2026-06-01T00:00:00.000Z',
      emails: ['a@example.com'],
    })).toThrow(/cannot exceed/u);
  });
});
