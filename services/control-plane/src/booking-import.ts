// The Envisioning switch (docs/CORE_FOLD_PLAN.md §Phase 3d): copy each host's
// Core booking settings into D1 once, and check every host is ready before
// BOOKING_STORE flips. Admin only. Nothing here flips anything.

import {
  BOOKING_SETTINGS_DEFAULTS,
  BOOKING_WEEKDAYS,
  bookingWeeklyHoursSchema,
  type BookingImportResponse,
  type BookingReadinessResponse,
  type BookingWeekday,
  type BookingWeeklyHours,
} from '@starlings/contracts/booking-settings';
import { bookingRooms, readBookingSettings, storeBookingSettings } from './booking-settings';
import { isKnownTimeZone } from './booking-slots';
import { ownBusyIntervals } from './calendar';
import { hostForEmail } from './booking-public';
import { ownerRoomMap } from './contracts';
import { bookingStore, coreApiOrigin, usesCore } from './work-store';

const CORE_DAY_NAMES: Record<BookingWeekday, string> = {
  mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday', sun: 'sunday',
};

type BookingImportRow = BookingImportResponse['hosts'][number];

/**
 * Copy each OWNER_ROOM_MAP host's Core settings into D1, from Core's public
 * `/api/meet/<room>/info`. A host who already saved booking settings in
 * Starlings is kept unless `overwrite`. What Core's info does not carry
 * (buffer, notice, horizon) takes Core's column defaults, which match ours.
 */
export async function importCoreBookingSettings(env: Env, overwrite: boolean): Promise<BookingImportRow[]> {
  if (!usesCore(env)) return [];
  const rows: BookingImportRow[] = [];
  for (const [email, room] of Object.entries(ownerRoomMap(env.OWNER_ROOM_MAP))) {
    const notes: string[] = [];
    const person = await hostForEmail(env, email);
    if (!person) {
      rows.push({ room, email, outcome: 'no_person', notes: ['Has never signed in to Starlings here.'] });
      continue;
    }
    const existing = await env.USAGE.prepare('SELECT 1 AS found FROM booking_settings WHERE sub = ?1')
      .bind(person.sub).first<{ found: number }>();
    if (existing && !overwrite) {
      rows.push({ room, email, outcome: 'kept', notes: ['Already saved booking hours in Starlings.'] });
      continue;
    }
    try {
      const response = await fetch(`${coreApiOrigin(env)}/api/meet/${room}/info`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 404) {
        rows.push({ room, email, outcome: 'no_core_settings', notes: ['Core has no active booking settings.'] });
        continue;
      }
      if (!response.ok) throw new Error(`Core answered ${response.status}.`);
      const info = await response.json<{ duration_minutes?: unknown; timezone?: unknown; working_hours?: unknown }>();
      const week = weekFromCore(info.working_hours, notes);
      const timezone = typeof info.timezone === 'string' && isKnownTimeZone(info.timezone) ? info.timezone : null;
      if (!week || !timezone) throw new Error('Core sent hours or a zone Meet cannot read.');
      const duration = typeof info.duration_minutes === 'number' ? Math.min(240, Math.max(15, Math.round(info.duration_minutes))) : 30;
      await storeBookingSettings(env, person.sub, {
        active: true,
        duration_minutes: duration,
        buffer_minutes: BOOKING_SETTINGS_DEFAULTS.buffer_minutes,
        min_notice_hours: BOOKING_SETTINGS_DEFAULTS.min_notice_hours,
        max_booking_days: BOOKING_SETTINGS_DEFAULTS.max_booking_days,
        // Meet offered Core's slots on the hour only (`filterOnTheHourSlots`).
        slot_step_minutes: 60,
        timezone,
        weekly_hours: week,
      });
      notes.push('Gap, notice and horizon are not in Core\'s public info: set to 0 minutes, 24 hours and 60 days. Check them in Settings.');
      rows.push({ room, email, outcome: 'imported', notes });
    } catch (error) {
      rows.push({ room, email, outcome: 'failed', notes: [error instanceof Error ? error.message : String(error)] });
    }
  }
  return rows;
}

/** Core's `{ monday: { enabled, start: "09:00", end: "17:00" } }` as the seven days. */
function weekFromCore(raw: unknown, notes: string[]): BookingWeeklyHours | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Record<string, { enabled?: unknown; start?: unknown; end?: unknown } | undefined>;
  const week = Object.fromEntries(BOOKING_WEEKDAYS.map((day) => {
    const entry = source[CORE_DAY_NAMES[day]];
    const start = minuteOf(entry?.start) ?? 9 * 60;
    const end = minuteOf(entry?.end) ?? 17 * 60;
    let enabled = entry?.enabled === true;
    // Core never offered a weekend, whatever the setting said. Keep it that way.
    if (enabled && (day === 'sat' || day === 'sun')) {
      enabled = false;
      notes.push(`${CORE_DAY_NAMES[day]} was on in Core, which never offered weekends. Imported as off.`);
    }
    return [day, { enabled, start_minute: start, end_minute: end === start ? (start + 60) % 1440 : end }];
  }));
  const parsed = bookingWeeklyHoursSchema.safeParse(week);
  return parsed.success ? parsed.data : null;
}

function minuteOf(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{2}):(\d{2})$/u);
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return minute >= 0 && minute < 1440 ? minute : null;
}

type BookingReadinessRow = BookingReadinessResponse['hosts'][number];

/**
 * Whether every host with a booking room (`bookingRooms`) can take bookings from D1: a person row, saved
 * settings with a zone and at least one open day, and a Google connection
 * that answers free/busy now. Run before BOOKING_STORE flips, and after.
 *
 * A host who has never signed in here does not hold the switch back (decided
 * by MZ, 2026-10-06): their page says they are not taking bookings until
 * they sign in and set their hours.
 */
export async function bookingReadiness(env: Env): Promise<BookingReadinessResponse> {
  const hosts: BookingReadinessRow[] = [];
  for (const { email, room } of await bookingRooms(env)) {
    const person = await hostForEmail(env, email);
    if (!person) {
      hosts.push({
        room, email, ready: false, detail: 'Has never signed in to Starlings here. Their page is not taking bookings; this does not hold the switch back.',
        checks: { person: false, active: false, settings_saved: false, timezone: false, open_days: 0, calendar: 'unchecked' },
      });
      continue;
    }
    const settings = await readBookingSettings(person, env);
    const openDays = settings.weekly_hours ? BOOKING_WEEKDAYS.filter((day) => settings.weekly_hours![day].enabled).length : 0;
    let calendar: BookingReadinessRow['checks']['calendar'] = 'ok';
    let detail: string | null = null;
    try {
      const now = Date.now();
      await ownBusyIntervals(env, person, new Date(now).toISOString(), new Date(now + 24 * 60 * 60 * 1000).toISOString());
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      calendar = code === 'calendar_not_connected' ? 'not_connected' : 'failed';
      detail = error instanceof Error ? error.message : String(error);
    }
    const checks = {
      person: true,
      active: settings.active,
      settings_saved: settings.updated_at !== null,
      timezone: settings.timezone !== null,
      open_days: openDays,
      calendar,
    };
    hosts.push({
      room, email, checks, detail,
      ready: settings.active && checks.settings_saved && checks.timezone && openDays > 0 && calendar === 'ok',
    });
  }
  // A host who never signed in, or whose page is off, takes no bookings to break.
  return { store: bookingStore(env), ready: hosts.every((host) => host.ready || !host.checks.person || host.checks.active === false), hosts };
}
