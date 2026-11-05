-- Rooms in the workspace's D1 (meet#878, docs/ONBOARDING.md decision 10).
-- Every member gets a permanent room with no deploy: sign-in, or accepting an
-- invitation, writes the row. `OWNER_ROOM_MAP` stays a read fallback, so a
-- workspace with no rows (Envisioning) resolves every room as before.
--
-- `slug` is the primary key and a row is never deleted: revoking a person
-- sets `retired_at`, and the slug stays taken, so it is never reissued to
-- somebody else. One live room per address (`rooms_live_owner`).
-- `owner_email` is lowercase. `created_by` is the sub of the person whose
-- sign-in or invitation made the row.
CREATE TABLE rooms (
  slug TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  retired_at INTEGER
);

CREATE UNIQUE INDEX rooms_live_owner ON rooms (owner_email) WHERE retired_at IS NULL;
