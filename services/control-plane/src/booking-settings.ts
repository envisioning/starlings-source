// How other people book a time with one member (docs/CORE_FOLD_PLAN.md
// §Phase 3d). The booking fields and the seven weekday windows are a
// row in `booking_settings` (migrations 0086, 0096). The zone is the member's
// profile zone. Saving also writes the profile's one presence window, derived
// from the seven days, so Team's "their time" follows the booking hours.

import {
  BOOKING_SETTINGS_DEFAULTS,
  BOOKING_WEEKDAYS,
  bookingWeeklyHoursSchema,
  type BookingSettingsResponse,
  type BookingSettingsUpdate,
  type BookingWeeklyHours,
} from '@starlings/contracts/booking-settings';
import { WORK_DAY_BITS, WORK_DAYS_WEEKDAYS, type WorkingHoursPattern } from '@starlings/contracts/work-hours';
import type { OwnerSession } from './contracts';
import { setProfile } from './peers';
import { ownerRoomMap } from './contracts';
import { roomOfMember } from './member-rooms';
import { workspaceBookingSlotMinutes } from './workspace-defaults';

interface Row {
  active: number;
  duration_minutes: number;
  buffer_minutes: number;
  min_notice_hours: number;
  max_booking_days: number;
  slot_step_minutes: number;
  weekly_hours: string | null;
  updated_at: number;
}

interface ProfileRow {
  timezone: string | null;
  work_start_minute: number | null;
  work_end_minute: number | null;
  work_days: number | null;
}

/**
 * The room a member's booking page lives at: their `people` row's room, which
 * sign-in fills from their room (D1 first, then OWNER_ROOM_MAP),
 * then that lookup for a row signed in before the column was written
 *.
 */
export async function bookingRoomFor(env: Env, owner: Pick<OwnerSession, 'sub' | 'email'>): Promise<string | null> {
  const row = await env.USAGE.prepare(
    `SELECT room_slug FROM people
      WHERE sub = ?1 AND room_slug IS NOT NULL AND revoked_at IS NULL AND (kind IS NULL OR kind != 'agent')`,
  ).bind(owner.sub).first<{ room_slug: string }>();
  return row?.room_slug ?? roomOfMember(env, owner.email);
}

/**
 * Every room that can have a booking page, with its member's address: each
 * human `people` row with a room, then each OWNER_ROOM_MAP room no row holds
 * yet (a mapped member who never signed in here). Whether a page takes
 * bookings is `booking_settings.active`, read per host.
 */
export async function bookingRooms(env: Env): Promise<Array<{ email: string; room: string }>> {
  const { results } = await env.USAGE.prepare(
    `SELECT email, room_slug FROM people
      WHERE room_slug IS NOT NULL AND revoked_at IS NULL AND (kind IS NULL OR kind != 'agent')
      ORDER BY room_slug`,
  ).all<{ email: string; room_slug: string }>();
  const rooms = results.map((row) => ({ email: row.email, room: row.room_slug }));
  const held = new Set(rooms.map((entry) => entry.room));
  for (const [email, room] of Object.entries(ownerRoomMap(env.OWNER_ROOM_MAP))) {
    if (!held.has(room)) rooms.push({ email, room });
  }
  return rooms;
}

export async function readBookingSettings(owner: Pick<OwnerSession, 'sub' | 'email'>, env: Env): Promise<BookingSettingsResponse> {
  const [row, profile, slotMinutes] = await Promise.all([
    env.USAGE.prepare(
      `SELECT active, duration_minutes, buffer_minutes, min_notice_hours, max_booking_days,
              slot_step_minutes, weekly_hours, updated_at
         FROM booking_settings WHERE sub = ?1`,
    ).bind(owner.sub).first<Row>(),
    env.USAGE.prepare('SELECT timezone, work_start_minute, work_end_minute, work_days FROM people WHERE sub = ?1')
      .bind(owner.sub)
      .first<ProfileRow>(),
    workspaceBookingSlotMinutes(env, BOOKING_SETTINGS_DEFAULTS.slot_step_minutes),
  ]);
  return {
    active: row ? row.active === 1 : BOOKING_SETTINGS_DEFAULTS.active,
    duration_minutes: row?.duration_minutes ?? BOOKING_SETTINGS_DEFAULTS.duration_minutes,
    buffer_minutes: row?.buffer_minutes ?? BOOKING_SETTINGS_DEFAULTS.buffer_minutes,
    min_notice_hours: row?.min_notice_hours ?? BOOKING_SETTINGS_DEFAULTS.min_notice_hours,
    max_booking_days: row?.max_booking_days ?? BOOKING_SETTINGS_DEFAULTS.max_booking_days,
    slot_step_minutes: row?.slot_step_minutes ?? slotMinutes,
    timezone: profile?.timezone ?? null,
    weekly_hours: parseWeeklyHours(row?.weekly_hours ?? null) ?? weekFromPresence(profile),
    room: await bookingRoomFor(env, owner),
    updated_at: row?.updated_at ?? null,
  };
}

/**
 * Store a member's booking settings: the row, the profile zone, and the
 * profile's presence window derived from the seven days. The PUT route and
 * the Envisioning import both write through here.
 */
export async function storeBookingSettings(
  env: Env,
  sub: string,
  input: BookingSettingsUpdate,
): Promise<void> {
  await setProfile({ sub }, env, { timezone: input.timezone, working_hours: presenceFromWeek(input.weekly_hours) });
  await env.USAGE.prepare(
    `INSERT INTO booking_settings
       (sub, active, duration_minutes, buffer_minutes, min_notice_hours, max_booking_days,
        slot_step_minutes, weekly_hours, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (sub) DO UPDATE SET
       active = excluded.active,
       duration_minutes = excluded.duration_minutes,
       buffer_minutes = excluded.buffer_minutes,
       min_notice_hours = excluded.min_notice_hours,
       max_booking_days = excluded.max_booking_days,
       slot_step_minutes = excluded.slot_step_minutes,
       weekly_hours = excluded.weekly_hours,
       updated_at = excluded.updated_at`,
  ).bind(
    sub,
    input.active ? 1 : 0,
    input.duration_minutes,
    input.buffer_minutes,
    input.min_notice_hours,
    input.max_booking_days,
    input.slot_step_minutes,
    JSON.stringify(input.weekly_hours),
    Date.now(),
  ).run();
}

export async function writeBookingSettings(
  owner: Pick<OwnerSession, 'sub' | 'email'>,
  env: Env,
  input: BookingSettingsUpdate,
): Promise<BookingSettingsResponse> {
  await storeBookingSettings(env, owner.sub, input);
  return readBookingSettings(owner, env);
}

/** A stored week, or null for none or one no reader can trust. */
function parseWeeklyHours(raw: string | null): BookingWeeklyHours | null {
  if (!raw) return null;
  try {
    const parsed = bookingWeeklyHoursSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The week a member had before their first save: the presence window on each of its days. */
function weekFromPresence(profile: ProfileRow | null): BookingWeeklyHours | null {
  // Both ends or neither, as `peers.ts` reads them.
  if (!profile || profile.work_start_minute === null || profile.work_end_minute === null) return null;
  const days = profile.work_days ?? WORK_DAYS_WEEKDAYS;
  const start = profile.work_start_minute;
  const end = profile.work_end_minute;
  if (start === end) return null;
  return Object.fromEntries(BOOKING_WEEKDAYS.map((day) => [day, {
    enabled: (days & WORK_DAY_BITS[day]) !== 0,
    start_minute: start,
    end_minute: end,
  }])) as BookingWeeklyHours;
}

/**
 * The one presence window Team shows, from the seven days: the enabled days,
 * from the earliest start to the latest end among them. A day that runs past
 * midnight keeps its own window. No enabled day clears it.
 */
export function presenceFromWeek(week: BookingWeeklyHours): WorkingHoursPattern | null {
  const enabled = BOOKING_WEEKDAYS.filter((day) => week[day].enabled);
  if (enabled.length === 0) return null;
  const windows = enabled.map((day) => week[day]);
  const overnight = windows.find((window) => window.end_minute < window.start_minute);
  return {
    start_minute: overnight?.start_minute ?? Math.min(...windows.map((window) => window.start_minute)),
    end_minute: overnight?.end_minute ?? Math.max(...windows.map((window) => window.end_minute)),
    days: enabled.reduce((bits, day) => bits | WORK_DAY_BITS[day], 0),
  };
}
