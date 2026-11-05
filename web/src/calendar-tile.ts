import { calendarLocationLabel, platformLabel, type WebCalendarEvent } from './owner-agenda';
import { formatTime, zoneOffsetSeconds } from './meeting-time';

/**
 * What a timed calendar tile says under its title. The Mac and the
 * phone say the same through `CalendarTileDetail`; both answer to
 * `fixtures/calendar-tile.json`, so change that file first.
 *
 * Row order is title, location, time. Rows appear as the tile grows (time
 * first, then location) and a row that does not fit whole is not drawn.
 */
export type CalendarTileDetail = { location: string; time: string };

/** `GMT`, `GMT+2`, `GMT-5`, `GMT+5:30`, written from the offset, never asked of the platform. */
export function offsetName(seconds: number): string {
  if (seconds === 0) return 'GMT';
  const sign = seconds < 0 ? '-' : '+';
  const minutes = Math.floor(Math.abs(seconds) / 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `GMT${sign}${hours}` : `GMT${sign}${hours}:${String(rest).padStart(2, '0')}`;
}

/** `start – end` in the viewer's zone, then `(HH:mm ZONE)` when the event was made in a zone with another offset that day. */
export function tileTimeLabel(start: Date, end: Date, originZone: string | null | undefined, viewerZone?: string): string {
  const zone = viewerZone ? { timeZone: viewerZone } : {};
  let label = `${formatTime(start, zone)} – ${formatTime(end, zone)}`;
  if (originZone) {
    const origin = zoneOffsetSeconds(originZone, start);
    const viewer = viewerZone ? zoneOffsetSeconds(viewerZone, start) : -start.getTimezoneOffset() * 60;
    if (origin !== null && viewer !== null && origin !== viewer) {
      label += ` (${formatTime(start, { timeZone: originZone })} ${offsetName(origin)})`;
    }
  }
  return label;
}

/** The place, or the platform's name when the event has only a link; '' when there is neither. */
export function tilePlace(event: Pick<WebCalendarEvent, 'location' | 'platform'>): string {
  return calendarLocationLabel(event as WebCalendarEvent) || platformLabel(event as WebCalendarEvent);
}

export function calendarTileDetail(event: WebCalendarEvent): CalendarTileDetail | null {
  if (event.allDay) return null;
  const start = new Date(event.start);
  const end = new Date(event.end);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { location: tilePlace(event), time: tileTimeLabel(start, end, event.startTimeZone) };
}

/** Which rows a tile of `height` can hold. The title keeps one line when a row is shown. */
export function tileRows(input: {
  height: number; titleHeight: number; rowHeight: number; padding: number; hasLocation: boolean;
}): { time: boolean; location: boolean } {
  let remaining = input.height - input.padding - input.titleHeight;
  const time = remaining >= input.rowHeight;
  if (time) remaining -= input.rowHeight;
  return { time, location: input.hasLocation && time && remaining >= input.rowHeight };
}
