import { describe, expect, it } from 'vitest';
import { allDayPatch, allDayRange, eventTimePatch, nextEventStart, recurrenceTarget, shiftDay, stepTime } from './calendar-editor-model';

/*
 * #232: all-day boundaries (Google's end is the exclusive next day; the
 * editor shows the last day inclusive) and which Google event a write on a
 * recurring instance addresses.
 */
describe('all-day boundaries', () => {
  it('shows the exclusive end as an inclusive last day, and sends it back exclusive', () => {
    expect(allDayRange({ start: '2026-09-21', end: '2026-09-22' })).toEqual({ startDay: '2026-09-21', endDay: '2026-09-21' });
    expect(allDayRange({ start: '2026-09-21', end: '2026-09-24' })).toEqual({ startDay: '2026-09-21', endDay: '2026-09-23' });
    // A midnight instant on the wire is the same day, read in UTC.
    expect(allDayRange({ start: '2026-09-21T00:00:00.000Z', end: '2026-09-22T00:00:00.000Z' })).toEqual({ startDay: '2026-09-21', endDay: '2026-09-21' });
    expect(allDayPatch('2026-09-21', '2026-09-21')).toEqual({ start: '2026-09-21', end: '2026-09-22', all_day: true });
    expect(allDayPatch('2026-12-31', '2027-01-01')).toEqual({ start: '2026-12-31', end: '2027-01-02', all_day: true });
    expect(shiftDay('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('sends nothing for unchanged days, and refuses an end before the start', () => {
    const original = { start: '2026-09-21', end: '2026-09-22', allDay: true };
    expect(allDayPatch('2026-09-21', '2026-09-21', original)).toEqual({});
    expect(allDayPatch('2026-09-21', '2026-09-22', original)).toEqual({ start: '2026-09-21', end: '2026-09-23', all_day: true });
    expect(() => allDayPatch('2026-09-22', '2026-09-21')).toThrow();
    expect(() => allDayPatch('', '2026-09-21')).toThrow();
  });

  it('an all-day event turned timed sends its instants and all_day false', () => {
    const original = { start: '2026-09-21', end: '2026-09-22', allDay: true };
    const patch = eventTimePatch('2026-09-21T09:00', '2026-09-21T10:00', original);
    expect(patch.all_day).toBe(false);
    expect(patch.start).toBeDefined();
    // A timed event left alone still sends nothing.
    const timed = { start: '2026-09-21T09:00:00.000Z', end: '2026-09-21T10:00:00.000Z', allDay: false };
    const asLocal = (iso: string) => {
      const date = new Date(iso);
      const pad = (part: number) => String(part).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    };
    expect(eventTimePatch(asLocal(timed.start), asLocal(timed.end), timed)).toEqual({});
  });
});

describe('recurrence target', () => {
  const instance = { id: 'primary:abc_20260921T090000Z', recurringEventId: 'abc' };
  it('is the instance for this event, and the series for all events', () => {
    expect(recurrenceTarget(instance, 'this')).toBe(instance.id);
    expect(recurrenceTarget(instance, 'all')).toBe('abc');
    // A one-off has no series to address.
    expect(recurrenceTarget({ id: 'primary:solo' }, 'all')).toBe('primary:solo');
  });
});

describe('time steps (meet#1050)', () => {
  it('a new event starts on the next quarter hour', () => {
    expect(nextEventStart(new Date(2026, 9, 7, 8, 3, 20)).getMinutes()).toBe(15);
    expect(nextEventStart(new Date(2026, 9, 7, 8, 15, 0)).getMinutes()).toBe(15);
    const late = nextEventStart(new Date(2026, 9, 7, 8, 50));
    expect([late.getHours(), late.getMinutes()]).toEqual([9, 0]);
  });

  it('arrows move the clock in 5-minute steps and land an odd minute on the step', () => {
    expect(stepTime('08:00', 1)).toBe('08:05');
    expect(stepTime('08:00', -1)).toBe('07:55');
    expect(stepTime('08:03', 1)).toBe('08:05');
    expect(stepTime('08:03', -1)).toBe('08:00');
    expect(stepTime('23:55', 1)).toBe('00:00');
    expect(stepTime('00:00', -1)).toBe('23:55');
    expect(stepTime('8:0', 1)).toBeUndefined();
  });
});
