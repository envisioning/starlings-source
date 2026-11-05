-- D1 tasks keep every subject a Core task has (meet#1201,
-- docs/CORE_FOLD_PLAN.md §Before each group moves). Without these columns a
-- Core task on an event, a Signals account or a contact loses its subject
-- when the `tasks` group is copied.
--
-- `event_id` and `signals_account_id` are external references with no
-- foreign key: events follow WORK_STORE (the CMS, Phase 5), and Signals
-- accounts live in Signals. `contact_id` references `contacts`, which the
-- `subjects` group copies first. `tags` is a JSON array of strings, as Core's
-- `text[]` (§Postgres to D1).
ALTER TABLE tasks ADD COLUMN event_id TEXT;
ALTER TABLE tasks ADD COLUMN signals_account_id TEXT;
ALTER TABLE tasks ADD COLUMN contact_id TEXT REFERENCES contacts (id);
ALTER TABLE tasks ADD COLUMN tags TEXT;

CREATE INDEX tasks_event ON tasks (event_id, status) WHERE event_id IS NOT NULL;
CREATE INDEX tasks_signals_account ON tasks (signals_account_id, status) WHERE signals_account_id IS NOT NULL;
CREATE INDEX tasks_contact ON tasks (contact_id) WHERE contact_id IS NOT NULL;
