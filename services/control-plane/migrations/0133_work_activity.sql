-- The activity trail of the work model on D1 (meet#1218). Decided by MZ,
-- 2026-10-22: the Worker writes one row on every work-model write it sends
-- to D1, and Admin › Activity reads it, for admins only. Core's old
-- `activity_events` go to the R2 archive with Core and are not copied here.
--
-- `actor` is who wrote: a member's or an agent's address, or the door that
-- wrote for no member (`core-writes`, `public-form`, `interest-form`).
-- `changed_fields` is a JSON array of the fields the write set; a create
-- names the fields it was given.
CREATE TABLE work_activity (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  at              INTEGER NOT NULL,
  actor           TEXT,
  table_name      TEXT NOT NULL,
  row_id          TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('insert', 'update', 'delete')),
  label           TEXT,
  changed_fields  TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX work_activity_table ON work_activity (table_name, id DESC);
CREATE INDEX work_activity_actor ON work_activity (actor, id DESC);
CREATE INDEX work_activity_at ON work_activity (at);
