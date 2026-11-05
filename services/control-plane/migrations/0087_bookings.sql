-- A guest's booking on a member's page (docs/CORE_FOLD_PLAN.md §Phase 3d,
-- meet#932), on a workspace whose booking does not come from Core.
--
-- One row per booked window. The row is written before the Google event, by
-- an INSERT that refuses a window overlapping another confirmed booking of
-- the same member (booking-public.ts), so two guests cannot take one slot.
-- The join card still reads the minted token in CALENDAR_TOKENS; this row
-- holds the booking itself and the Google event behind it. Keyed by
-- `people.sub` like the other per-person tables; meet#720 moves them to
-- `person_id` together. Times are epoch milliseconds.
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL,
  room TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  guest_name TEXT NOT NULL,
  guest_email TEXT NOT NULL,
  guest_title TEXT NOT NULL,
  guest_organization TEXT NOT NULL,
  guest_notes TEXT,
  guest_timezone TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled')),
  google_event_id TEXT,
  join_url TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX bookings_owner_time ON bookings (owner_sub, starts_at);
