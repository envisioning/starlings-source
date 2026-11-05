import { describe, expect, it } from 'vitest';
import fixture from '../../fixtures/calendar-tile.json';
import { tilePlace, tileRows, tileTimeLabel } from './calendar-tile';
import type { WebCalendarEvent } from './owner-agenda';

describe('calendar tile detail (fixtures/calendar-tile.json)', () => {
  for (const row of fixture.timeLabels) {
    it(`time: ${row.name}`, () => {
      expect(tileTimeLabel(new Date(row.start), new Date(row.end), row.originZone, row.viewerZone)).toBe(row.expect);
    });
  }
  for (const row of fixture.rows) {
    it(`rows: ${row.name}`, () => {
      expect(tileRows(row)).toEqual(row.expect);
    });
  }
  for (const row of fixture.places) {
    it(`place: ${row.name}`, () => {
      const event = { location: row.location, platform: row.platform } as WebCalendarEvent;
      expect(tilePlace(event)).toBe(row.expect ?? '');
    });
  }
});
