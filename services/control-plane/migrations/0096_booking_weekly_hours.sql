-- Each weekday has its own booking window, as in Core (decided by MZ,
-- 2026-10-05; docs/CORE_FOLD_PLAN.md §Phase 3d). JSON, Monday first:
-- {"mon":{"enabled":true,"start_minute":540,"end_minute":1020},...}
-- (`bookingWeeklyHoursSchema`). Null until the member saves: the read then
-- derives the days from the profile's presence window, as before.
ALTER TABLE booking_settings ADD COLUMN weekly_hours TEXT;

-- The guest's cancel and reschedule capability: a random token in the link
-- the Google invite and the join card carry (`/book/<room>?manage=<token>`).
ALTER TABLE bookings ADD COLUMN manage_token TEXT;
CREATE UNIQUE INDEX bookings_manage_token ON bookings (manage_token) WHERE manage_token IS NOT NULL;
