/** The calendar id prefixes rows, but Google writes take the bare event id. */
export function rawCalendarEventId(calendarId: string, eventId: string): string {
  const prefix = `${calendarId}:`;
  return eventId.startsWith(prefix) ? eventId.slice(prefix.length) : eventId;
}

/**
 * Lists every calendar client draws the same way. The web reads them; the
 * generator writes the Swift side (`Sources/Generated/CalendarValuesRegistry.swift`).
 */

/** The read-only rows Envisioning decides: what each is called and why it is on your calendar. */
export const CALENDAR_LAYERS = [
  { kind: 'events', title: 'Events', caption: 'Published company events' },
  { kind: 'milestones', title: 'Milestones', caption: 'Project milestones' },
  { kind: 'tasks', title: 'Tasks', caption: 'Dated tasks' },
  // Computed by Core: working hours minus busy time, buffers, notice and event days.
  { kind: 'availability', title: 'Availability', caption: 'When guests can book you' },
] as const;
export type CalendarLayerId = (typeof CALENDAR_LAYERS)[number]['kind'];

/** Travel time an event can block before it, in minutes; 0 is off. */
export const CALENDAR_TRAVEL_MINUTES = [0, 15, 30, 45, 60] as const;

/** The answers an invitation takes, in the order every surface lists them. */
export const CALENDAR_RSVP_ANSWERS = [
  { response: 'accepted', title: 'Accept' },
  { response: 'tentative', title: 'Maybe' },
  { response: 'declined', title: 'Decline' },
] as const;

/**
 * The host schedule's time-zone presets, west to east, so the row reads like
 * a strip of the world. `id` is the stored choice, `zone` the IANA name
 * Google Calendar and `TimeZone(identifier:)` accept, `code` the airport-style
 * label for a row too narrow for the city.
 */
export const SCHEDULE_TIME_ZONES = [
  { id: 'losAngeles', zone: 'America/Los_Angeles', city: 'Los Angeles', code: 'LAX' },
  { id: 'newYork', zone: 'America/New_York', city: 'New York', code: 'NYC' },
  { id: 'saoPaulo', zone: 'America/Sao_Paulo', city: 'São Paulo', code: 'SAO' },
  { id: 'lisbon', zone: 'Europe/Lisbon', city: 'Lisbon', code: 'LIS' },
  { id: 'london', zone: 'Europe/London', city: 'London', code: 'LON' },
  { id: 'amsterdam', zone: 'Europe/Amsterdam', city: 'Amsterdam', code: 'AMS' },
  { id: 'riyadh', zone: 'Asia/Riyadh', city: 'Riyadh', code: 'RUH' },
  { id: 'dubai', zone: 'Asia/Dubai', city: 'Dubai', code: 'DXB' },
  // Kolkata is the IANA name for India's half-hour zone; Mumbai is what people call it.
  { id: 'mumbai', zone: 'Asia/Kolkata', city: 'Mumbai', code: 'BOM' },
  { id: 'tokyo', zone: 'Asia/Tokyo', city: 'Tokyo', code: 'TYO' },
] as const;
