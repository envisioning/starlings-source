// A guest's booking as D1 holds it (migrations 0087 and 0104), for the parts
// of the Worker that meet a booking after it is made: the host's calendar
// edits (calendar.ts), INBOX (inbox.ts) and the meeting log (crm.ts). The
// booking page itself writes the row (booking-public.ts).

import type { CoreHostBooking } from './crm';

export interface BookingRow {
  id: string;
  owner_sub: string;
  room: string;
  starts_at: number;
  ends_at: number;
  guest_name: string;
  guest_email: string;
  guest_title: string;
  guest_organization: string;
  guest_notes: string | null;
  status: 'pending' | 'confirmed' | 'cancelled';
  google_event_id: string | null;
  join_url: string | null;
  created_at: number;
  cancelled_at: number | null;
  rescheduled_at: number | null;
  previous_starts_at: number | null;
  previous_ends_at: number | null;
  replaced_by: string | null;
  nda_required: number;
  nda_document_id: string | null;
  nda_request_id: string | null;
  /** The room link's token; Core's booking interaction is keyed by it. */
  join_token: string | null;
  /** Set only on a booking from before Core's booking-interaction route: Core holds a host-issued row for it. */
  core_token: string | null;
}

const COLUMNS = `id, owner_sub, room, starts_at, ends_at, guest_name, guest_email, guest_title,
  guest_organization, guest_notes, status, google_event_id, join_url, created_at, cancelled_at,
  rescheduled_at, previous_starts_at, previous_ends_at, replaced_by, nda_required, nda_document_id, nda_request_id,
  join_token, core_token`;

/** The confirmed booking behind one of the host's Google events, if a guest booked it. */
export async function bookingForEvent(env: Env, ownerSub: string, eventId: string): Promise<BookingRow | null> {
  return env.USAGE.prepare(
    `SELECT ${COLUMNS} FROM bookings
      WHERE owner_sub = ?1 AND google_event_id = ?2 AND status = 'confirmed' LIMIT 1`,
  ).bind(ownerSub, eventId).first<BookingRow>();
}

/** The host moved the event: the row follows, and keeps where it was for INBOX. */
export async function moveBooking(env: Env, row: BookingRow, start: number, end: number): Promise<void> {
  if (row.starts_at === start && row.ends_at === end) return;
  await env.USAGE.prepare(
    `UPDATE bookings SET starts_at = ?2, ends_at = ?3, rescheduled_at = ?4,
            previous_starts_at = ?5, previous_ends_at = ?6
      WHERE id = ?1`,
  ).bind(row.id, start, end, Date.now(), row.starts_at, row.ends_at).run();
}

/** Mark a booking cancelled. `replacedBy` names the booking a guest's move made. */
export async function cancelBookingRow(env: Env, id: string, replacedBy: string | null = null): Promise<void> {
  await env.USAGE.prepare(
    `UPDATE bookings SET status = 'cancelled', cancelled_at = ?2, replaced_by = ?3
      WHERE id = ?1 AND status != 'cancelled'`,
  ).bind(id, Date.now(), replacedBy).run();
}

/**
 * The host's bookings that INBOX may show: every row that starts at `from` or
 * later, and every cancellation since `from`, in the shape Core lists its own.
 * A row a guest's move replaced is left out: the new row says it moved.
 */
export async function hostBookings(env: Env, ownerSub: string, from: number): Promise<CoreHostBooking[]> {
  const rows = await env.USAGE.prepare(
    `SELECT ${COLUMNS.split(',').map((column) => `b.${column.trim()}`).join(', ')}, p.name AS host_name
       FROM bookings b LEFT JOIN people p ON p.sub = b.owner_sub
      WHERE b.owner_sub = ?1 AND b.status IN ('confirmed', 'cancelled') AND b.replaced_by IS NULL
        AND (b.starts_at >= ?2 OR b.cancelled_at >= ?2)
      ORDER BY b.starts_at LIMIT 200`,
  ).bind(ownerSub, from).all<BookingRow & { host_name: string | null }>();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    source: 'self',
    status: row.status,
    // The Google event's title, as booking-public.ts writes it.
    title: row.host_name?.trim() ? `${row.guest_name} and ${row.host_name.trim()}` : row.guest_name,
    guest_name: row.guest_name,
    guest_email: row.guest_email,
    guest_title: row.guest_title || null,
    guest_organization: row.guest_organization || null,
    guest_notes: row.guest_notes,
    start_time: new Date(row.starts_at).toISOString(),
    end_time: new Date(row.ends_at).toISOString(),
    google_event_id: row.google_event_id,
    nda_required: row.nda_required === 1,
    created_at: new Date(row.created_at).toISOString(),
    cancelled_at: iso(row.cancelled_at),
    rescheduled_at: iso(row.rescheduled_at),
    previous_start_time: iso(row.previous_starts_at),
    previous_end_time: iso(row.previous_ends_at),
  }));
}

/** Core's token for each join token D1 knows one for (fold principle 3: Core is told in its own ids). */
export async function coreTokensForJoinTokens(env: Env, joinTokens: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(joinTokens.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await env.USAGE.prepare(
    `SELECT join_token, core_token FROM bookings
      WHERE core_token IS NOT NULL AND join_token IN (${unique.map((_, index) => `?${index + 1}`).join(', ')})`,
  ).bind(...unique).all<{ join_token: string; core_token: string }>();
  return new Map((rows.results ?? []).map((row) => [row.join_token, row.core_token]));
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}
