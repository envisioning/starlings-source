-- How other people book a time with one member (docs/CORE_FOLD_PLAN.md
-- §Phase 3d, meet#932).
--
-- Only the booking fields live here. The hours and the zone are the member's
-- profile hours on `people` (`timezone`, `work_start_minute`,
-- `work_end_minute`, `work_days`), which team presence also reads, so a
-- member keeps one set of hours. No row is the contract's default
-- (`BOOKING_SETTINGS_DEFAULTS`). Keyed by `people.sub` like the other
-- per-person tables; meet#720 moves them to `person_id` together.
CREATE TABLE booking_settings (
  sub TEXT PRIMARY KEY,
  active INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL,
  buffer_minutes INTEGER NOT NULL,
  min_notice_hours INTEGER NOT NULL,
  max_booking_days INTEGER NOT NULL,
  slot_step_minutes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
