-- The table-group move from Core to D1 (meet#757, docs/CORE_FOLD_PLAN.md
-- §The group move). One row per group that an admin has frozen, copied or
-- verified. Where a group answers from is not here: that is the
-- WORK_STORE_<GROUP> var, changed by a deploy.
--
-- `frozen` = 1 makes the Worker answer every write to the group with 503
-- `records_moving`; reads still answer. Every write on a WORK_STORE=core
-- workspace reads this row, so a freeze holds from the next request, with
-- no cache. A D1 workspace never reads it.
--
-- `report` is the last verify, as JSON: per table, the row counts and the
-- SHA-256 of Core's rows and of D1's.
CREATE TABLE work_group_moves (
  work_group   TEXT PRIMARY KEY CHECK (work_group IN ('subjects', 'tasks', 'goals', 'interactions')),
  frozen       INTEGER NOT NULL DEFAULT 0,
  frozen_at    INTEGER,
  copied_at    INTEGER,
  verified_at  INTEGER,
  verified_ok  INTEGER,
  report       TEXT,
  updated_at   INTEGER NOT NULL
);
