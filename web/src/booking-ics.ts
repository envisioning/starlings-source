/**
 * An .ics file for the booking behind a token link, built in the browser.
 *
 * Nothing new is disclosed by this: every field written here is already on the
 * screen that offers the download (title, window, and the join URL the guest
 * followed to get here). It exists because a guest who books a time still has
 * to get that time into their own calendar by hand, and because the invite
 * that brought them here may have been a Core page rather than a calendar
 * event.
 *
 * Deliberately not a server endpoint: a `/bookings/<token>.ics` route would be
 * a second, cacheable way to read a booking, and the token is a capability we
 * would rather keep to the one path that already checks it.
 */

import { WORKSPACE_HOST_SUFFIX } from '@starlings/contracts/workspace-slug';
import { icsProductId } from '@starlings/contracts/deployment';
import { workspaceBrand } from './workspace-brand';

/** RFC 5545 wants CRLF, and folds long lines — titles here are short enough. */
const CRLF = '\r\n';

function icsTimestamp(value: Date): string {
  return `${value.toISOString().replace(/[-:]/gu, '').split('.')[0]}Z`;
}

/**
 * Escape per RFC 5545: backslash first, or it would double-escape what the
 * later replacements add.
 */
function icsText(value: string): string {
  return value
    .replace(/\\/gu, '\\\\')
    .replace(/;/gu, '\\;')
    .replace(/,/gu, '\\,')
    .replace(/\r?\n/gu, '\\n');
}

export function buildBookingIcs({ title, startsAt, endsAt, joinUrl, ownerName, workspaceName = workspaceBrand().name }: {
  title: string;
  startsAt: string;
  endsAt: string;
  joinUrl: string;
  ownerName?: string;
  /** Names the file's issuer (`PRODID`). Defaults to this page's workspace. */
  workspaceName?: string;
}): string | null {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;

  // Stable per join URL and start, so re-downloading updates the existing
  // event in the guest's calendar instead of adding a second copy.
  // The domain is the join link's own host, so each workspace names itself.
  const uid = `${icsTimestamp(start)}-${joinUrl.replace(/[^a-zA-Z0-9]/gu, '')}@${uidHost(joinUrl)}`;

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${icsProductId(workspaceName)}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsTimestamp(new Date())}`,
    `DTSTART:${icsTimestamp(start)}`,
    `DTEND:${icsTimestamp(end)}`,
    `SUMMARY:${icsText(ownerName ? `${title} with ${ownerName}` : title)}`,
    `DESCRIPTION:${icsText(`Join: ${joinUrl}`)}`,
    `URL:${icsText(joinUrl)}`,
    `LOCATION:${icsText(joinUrl)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join(CRLF) + CRLF;
}

/** Filename-safe slug of the title, so the download is not `download.ics`. */
export function icsFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60);
  return `${slug || 'meeting'}.ics`;
}

function uidHost(joinUrl: string): string {
  try {
    return new URL(joinUrl).host || WORKSPACE_HOST_SUFFIX;
  } catch {
    return WORKSPACE_HOST_SUFFIX;
  }
}
