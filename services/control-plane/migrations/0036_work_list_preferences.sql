-- How the SUBJECTS list is ordered and cut, per person: sort, group, starred
-- only (packages/contracts/src/subject-state.ts `work_list`, pinned by
-- fixtures/subject-state.json). Beside the SALES opt-in rather than in a
-- table of its own: both are "how I want Work to read", one row per owner.
-- JSON, resolved on every read, so a build that adds an option reaches a
-- row stored today and a value a newer build wrote falls back on an older
-- one instead of breaking the list. NULL is "never said": the default.
ALTER TABLE work_preferences ADD COLUMN work_list TEXT;
