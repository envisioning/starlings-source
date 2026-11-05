-- D1 interactions keep what Core's interactions hold beyond the meeting log
-- (meet#1202, docs/CORE_FOLD_PLAN.md §Before each group moves). Without these
-- columns a Core note, email or Signals touch loses its text, its tags and
-- its Signals account when the `interactions` group is copied.
--
-- `description` is Core's free text: a note's body, an email's excerpt.
-- `tags` is a JSON array of strings and `metadata` a JSON object, as Core's
-- `text[]` and `jsonb` (§Postgres to D1). `signals_account_id` is an external
-- reference with no foreign key: Signals keeps its accounts.
--
-- The contacts of an interaction are `interaction_contacts` (migration 0121).
-- The `interactions` group copies that table after `interactions`.
ALTER TABLE interactions ADD COLUMN description TEXT;
ALTER TABLE interactions ADD COLUMN tags TEXT;
ALTER TABLE interactions ADD COLUMN metadata TEXT;
ALTER TABLE interactions ADD COLUMN signals_account_id TEXT;

CREATE INDEX interactions_signals_account ON interactions (signals_account_id) WHERE signals_account_id IS NOT NULL;
