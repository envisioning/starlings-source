-- D1 milestones keep every column Core holds for them (meet#1222,
-- docs/CORE_FOLD_PLAN.md §Before each group moves). Without these columns the
-- `tasks` copy drops Core's data and the verify still passes, because it
-- digests only the copied columns. The public project page and Core's
-- milestones.ics feed show the notes, the place, the location and the start.
--
-- Read from core-web DATABASE.md, 2026-10-22. Starlings builds no milestone
-- create, edit or delete (MZ, 2026-10-22): the copy writes these columns, and
-- the readers read them. Times are epoch milliseconds (§Postgres to D1).
-- `start_time` is Core's `time` as its text (`HH:MM:SS`), and `timezone` an
-- IANA zone name. Not copied: the generated `search_vector`.
ALTER TABLE milestones ADD COLUMN notes TEXT;
ALTER TABLE milestones ADD COLUMN place TEXT;
ALTER TABLE milestones ADD COLUMN location TEXT;
ALTER TABLE milestones ADD COLUMN start_time TEXT;
ALTER TABLE milestones ADD COLUMN timezone TEXT;
ALTER TABLE milestones ADD COLUMN start_at INTEGER;
