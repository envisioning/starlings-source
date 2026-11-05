import { describe, expect, it } from 'vitest';
import { calendarAvailabilityQuerySchema } from '@starlings/contracts';

describe('calendarAvailabilityQuerySchema', () => {
  it('accepts a plain-date range', () => {
    expect(calendarAvailabilityQuerySchema.parse({ start: '2026-09-07', end: '2026-10-18' }))
      .toEqual({ start: '2026-09-07', end: '2026-10-18' });
  });

  it('rejects instants, reversed ranges, and more than a season', () => {
    expect(() => calendarAvailabilityQuerySchema.parse({ start: '2026-09-07T00:00:00Z', end: '2026-09-08' }))
      .toThrow();
    expect(() => calendarAvailabilityQuerySchema.parse({ start: '2026-09-08', end: '2026-09-07' }))
      .toThrow();
    expect(() => calendarAvailabilityQuerySchema.parse({ start: '2026-01-01', end: '2026-06-01' }))
      .toThrow();
  });

  it('allows a single day', () => {
    expect(() => calendarAvailabilityQuerySchema.parse({ start: '2026-09-07', end: '2026-09-07' }))
      .not.toThrow();
  });
});
