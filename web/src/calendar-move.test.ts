import { describe, expect, it } from 'vitest';
import { eventMoveChoices, type WebCalendarSource } from './owner-agenda';

const source = (id: string, accountEmail: string, writable = true): WebCalendarSource => ({ id, summary: id, primary: false, selected: true, writable, accountEmail });
const sources = [
  source('work', 'rosa@example.com'),
  source('home', 'rosa@example.com'),
  source('other', 'ada@example.com'),
  source('holidays', 'rosa@example.com', false),
  source('sub:feed', 'Subscribed'),
];

describe('eventMoveChoices', () => {
  it('lists writable calendars, the event\'s own included, and no subscription', () => {
    expect(eventMoveChoices({ calendarId: 'work' }, sources).map((choice) => choice.id)).toEqual(['work', 'home', 'other']);
  });

  it('offers no move from a read-only calendar, a subscription or the shared Global interest calendar', () => {
    expect(eventMoveChoices({ calendarId: 'holidays' }, sources)).toEqual([]);
    expect(eventMoveChoices({ calendarId: 'sub:feed' }, sources)).toEqual([]);
    expect(eventMoveChoices({ calendarId: 'work', calendarRole: 'global_interest' }, sources)).toEqual([]);
  });

  it('offers no move when the event\'s calendar is the only writable one', () => {
    expect(eventMoveChoices({ calendarId: 'work' }, [source('work', 'rosa@example.com')])).toEqual([]);
  });
});
