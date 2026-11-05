// The Google scopes each consent asks for. One list for the workspace flows
// (calendar.ts, google-grants.ts) and the auth Worker (src/auth-worker/), so
// a central consent asks for exactly what the direct flow asks for.
import type { GoogleGrantProduct } from './contracts';

const calendarEventsScope = 'https://www.googleapis.com/auth/calendar.events';
const calendarListScope = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
// Google's `freebusy.query` does not accept `calendar.events`, so free/busy
// needs its own scope: the booking page's own busy time and Team's colleague
// availability. A grant from before it answers 403 there, and the
// member reconnects Calendar once.
const calendarFreeBusyScope = 'https://www.googleapis.com/auth/calendar.events.freebusy';
export const CALENDAR_OAUTH_SCOPES = `${calendarEventsScope} ${calendarListScope} ${calendarFreeBusyScope}`;

/** The read scope each connector product needs. Nothing else is ever asked for. */
export const GOOGLE_GRANT_SCOPES: Readonly<Record<GoogleGrantProduct, string>> = {
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  drive: 'https://www.googleapis.com/auth/drive.readonly',
};
