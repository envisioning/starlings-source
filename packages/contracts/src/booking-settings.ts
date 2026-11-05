import { z } from 'zod';
import { emailSchema, peerProfileSchema } from './index';

// Booking settings: how other people book a time with one member
// (docs/CORE_FOLD_PLAN.md §Phase 3d). Each weekday has its own
// window, as in Core (decided by MZ, 2026-10-05). The zone is the member's
// profile zone. Saving also writes the profile's one presence window, derived
// from the seven days, so a member edits their hours in one place.

/** Monday first, the keys of `WORK_DAY_BITS`. */
export const BOOKING_WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type BookingWeekday = typeof BOOKING_WEEKDAYS[number];

const dayMinuteSchema = z.number().int().min(0).max(1439);

/** One weekday's window in the member's zone. An end at or before the start runs past midnight. */
export const bookingDayHoursSchema = z.object({
  enabled: z.boolean(),
  start_minute: dayMinuteSchema,
  end_minute: dayMinuteSchema,
}).strict().refine((day) => day.start_minute !== day.end_minute, {
  message: 'A day needs an end that differs from its start.',
});
export type BookingDayHours = z.infer<typeof bookingDayHoursSchema>;

export const bookingWeeklyHoursSchema = z.object({
  mon: bookingDayHoursSchema,
  tue: bookingDayHoursSchema,
  wed: bookingDayHoursSchema,
  thu: bookingDayHoursSchema,
  fri: bookingDayHoursSchema,
  sat: bookingDayHoursSchema,
  sun: bookingDayHoursSchema,
}).strict();
export type BookingWeeklyHours = z.infer<typeof bookingWeeklyHoursSchema>;

export const BOOKING_SETTINGS_DEFAULTS = {
  active: true,
  duration_minutes: 30,
  buffer_minutes: 0,
  min_notice_hours: 24,
  max_booking_days: 60,
  slot_step_minutes: 30,
} as const;

const bookingFields = {
  /** False hides the booking page; the settings stay. */
  active: z.boolean(),
  duration_minutes: z.number().int().min(15).max(240),
  /** Kept clear before and after every busy time. */
  buffer_minutes: z.number().int().min(0).max(120),
  /** The earliest slot offered is this far from now. */
  min_notice_hours: z.number().int().min(0).max(168),
  /** The latest day offered, counted from today. */
  max_booking_days: z.number().int().min(1).max(365),
  /** How far apart slot starts are. */
  slot_step_minutes: z.number().int().min(5).max(240),
};

/** `PUT /api/calendar/booking-settings` body. The zone writes the profile. */
export const bookingSettingsUpdateSchema = z.object({
  ...bookingFields,
  timezone: peerProfileSchema.shape.timezone.unwrap().unwrap(),
  weekly_hours: bookingWeeklyHoursSchema,
}).strict();
export type BookingSettingsUpdate = z.infer<typeof bookingSettingsUpdateSchema>;

/** `GET` and `PUT /api/calendar/booking-settings` response. */
export const bookingSettingsResponseSchema = z.object({
  ...bookingFields,
  /** The profile zone. Null until a device checks in or the member sets it. */
  timezone: z.string().nullable(),
  /**
   * The seven days. Before the first save they come from the profile's
   * presence window; null when that is unset too, and no slots are offered.
   */
  weekly_hours: bookingWeeklyHoursSchema.nullable(),
  /** The booking page this member's settings serve, or null without a room. */
  room: z.string().nullable(),
  /** Null until the member has saved once. */
  updated_at: z.number().int().nullable(),
});
export type BookingSettingsResponse = z.infer<typeof bookingSettingsResponseSchema>;

/**
 * `POST /api/schedule/:slug/book` body, as the guest booking page sends it
 * (Core's shape, so the page does not change when a workspace leaves Core).
 */
export const scheduleBookSchema = z.object({
  guest_name: z.string().trim().min(1).max(100),
  guest_email: emailSchema,
  guest_title: z.string().trim().min(1).max(100),
  guest_organization: z.string().trim().min(1).max(100),
  guest_notes: z.string().trim().max(500).optional(),
  start_time: z.string().datetime({ offset: true }),
  /** The zone the guest picked the slot in. */
  guest_timezone: z.string().trim().max(64).optional(),
  /**
   * The guest asks to meet under the workspace's NDA. Docs mails them a
   * signature request on it. Ignored where the workspace offers no NDA
   * (`info.nda` false).
   */
  requires_nda: z.boolean().optional(),
  /** Moving a booking: the old one's manage token. It is cancelled once the new one stands. */
  reschedule_token: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/u).optional(),
});
export type ScheduleBookInput = z.infer<typeof scheduleBookSchema>;

/** `POST /api/schedule/:slug/book` answer. */
export const scheduleBookResponseSchema = z.object({
  success: z.literal(true),
  booking: z.object({
    id: z.string(),
    start_time: z.string(),
    end_time: z.string(),
    guest_name: z.string(),
    guest_email: z.string(),
    /** The guest asked for the NDA and Docs mailed it. Absent from a store that has no NDA step. */
    nda_sent: z.boolean().optional(),
  }),
});
export type ScheduleBookResponse = z.infer<typeof scheduleBookResponseSchema>;

/** `GET /api/schedule/:slug/booking/:token`: the booking a manage link names. */
export const scheduleManagedBookingSchema = z.object({
  booking: z.object({
    start_time: z.string(),
    end_time: z.string(),
    guest_name: z.string(),
    status: z.enum(['confirmed', 'cancelled']),
    /**
     * The NDA the guest asked for, through Docs: `pending` until they sign the
     * request Docs mailed, `signed` after, `closed` when it expired or was
     * withdrawn. Null when they asked for none, or Docs cannot say now.
     */
    nda: z.enum(['pending', 'signed', 'closed']).nullable().optional(),
  }),
});
export type ScheduleManagedBooking = z.infer<typeof scheduleManagedBookingSchema>;

/** `POST /api/admin/booking/import-core`: one row per OWNER_ROOM_MAP host (admin only). */
export const bookingImportResponseSchema = z.object({
  hosts: z.array(z.object({
    room: z.string(),
    email: z.string(),
    outcome: z.enum(['imported', 'kept', 'no_person', 'no_core_settings', 'failed']),
    notes: z.array(z.string()),
  })),
});
export type BookingImportResponse = z.infer<typeof bookingImportResponseSchema>;

/** `GET /api/admin/booking/readiness`: whether every host can take bookings from D1 (admin only). */
export const bookingReadinessResponseSchema = z.object({
  /** Where booking pages answer from now. */
  store: z.enum(['core', 'd1']),
  /** True when every host below who has signed in and takes bookings is ready. Anyone else does not hold it back. */
  ready: z.boolean(),
  hosts: z.array(z.object({
    room: z.string(),
    email: z.string(),
    ready: z.boolean(),
    checks: z.object({
      person: z.boolean(),
      /** Their booking page is on. Absent from an older Worker: read it as on. */
      active: z.boolean().optional(),
      settings_saved: z.boolean(),
      timezone: z.boolean(),
      open_days: z.number().int(),
      calendar: z.enum(['ok', 'not_connected', 'failed', 'unchecked']),
    }),
    detail: z.string().nullable(),
  })),
});
export type BookingReadinessResponse = z.infer<typeof bookingReadinessResponseSchema>;

/**
 * The NDA a guest can ask to meet under on any booking page here: a
 * document in the workspace's Docs, chosen by an admin (`/admin/people`).
 * `PUT /api/admin/booking-nda` body; null offers no NDA.
 */
export const bookingNdaUpdateSchema = z.object({
  document_id: z.string().trim().min(1).max(128).nullable(),
}).strict();
export type BookingNdaUpdate = z.infer<typeof bookingNdaUpdateSchema>;

/** `GET` and `PUT /api/admin/booking-nda`. */
export const bookingNdaAdminResponseSchema = z.object({
  /** False on a workspace with no Docs: there is no NDA to choose. */
  docs: z.boolean(),
  document_id: z.string().nullable(),
  /** Null when the admin reading cannot open the document. */
  document_title: z.string().nullable(),
  /** Null until an admin has saved once. */
  updated_at: z.number().int().nullable(),
});
export type BookingNdaAdminResponse = z.infer<typeof bookingNdaAdminResponseSchema>;
