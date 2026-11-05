import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDay, parseDay } from './meeting-time';

describe('formatDay', () => {
  const now = new Date(2026, 8, 30, 12);
  beforeEach(() => { vi.stubEnv('TZ', 'America/Los_Angeles'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('keeps a date-only value on the day it names', () => {
    expect(formatDay('2026-09-20', now)).toMatch(/^20 Sept?$/);
    expect(parseDay('2026-09-20')?.getDate()).toBe(20);
  });

  it('adds the year outside the current one', () => {
    expect(formatDay('2025-03-04', now)).toBe('4 Mar 2025');
  });

  it('reads a timestamp as its local day', () => {
    expect(formatDay(new Date(2026, 8, 20, 23, 30).toISOString(), now)).toMatch(/^20 Sept?$/);
  });

  it('never echoes a value that is not a date', () => {
    expect(formatDay('soon', now)).toBe('');
    expect(formatDay(null, now)).toBe('');
    expect(formatDay('', now)).toBe('');
  });
});
