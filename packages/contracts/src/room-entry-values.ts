import type { StarlingsMintedBookingProjection } from './calendar';
import type { PublicRoomResponse } from './index';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The browser-entry guard for GET /api/rooms/:slug. */
export function isPublicRoomResponse(value: unknown): value is PublicRoomResponse {
  const room = record(value);
  if (!room || typeof room.slug !== 'string' || room.kind !== 'permanent') return false;
  if (room.internal !== undefined && typeof room.internal !== 'boolean') return false;
  if (room.owner_name !== null && typeof room.owner_name !== 'string') return false;
  if (room.you === undefined) return true;
  const you = record(room.you);
  return you !== null && typeof you.name === 'string' && typeof you.email === 'string';
}

/** The browser-entry guard for a public projection of a Meet booking. */
export function isMeetMintedBookingProjection(value: unknown): value is StarlingsMintedBookingProjection {
  const projection = record(value);
  if (!projection) return false;
  const nullableStrings = [
    projection.title,
    projection.subject,
    projection.starts_at,
    projection.ends_at,
    projection.reschedule_url,
    projection.cancel_url,
    projection.guest_name,
    projection.guest_email,
  ];
  return nullableStrings.every((field) => field === null || typeof field === 'string')
    && (projection.status === 'scheduled' || projection.status === 'cancelled');
}
