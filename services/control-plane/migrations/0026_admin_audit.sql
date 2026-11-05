-- Every admin write leaves a row.
--
-- Before this table, the only trace of any administrative action anywhere in
-- Meet was `people.hidden_by_sub` — and un-hiding overwrote it, so the record
-- of who hid somebody died the moment somebody else put them back. A colleague
-- vanishing from Team, or a role that changed without a trace, was a mystery
-- the next person had to reconstruct from wrangler tail.
--
-- Append-only and deliberately small. `subject` is whatever the action was
-- about (usually an email), `detail` is one short human string — never a
-- payload, never anything that would put meeting content or a guest address in
-- a table that Admin renders as JSON (PRIVACY.md §12).
--
-- The actor's email is stored rather than joined: an audit row must still read
-- correctly after the `people` row it points at is gone.
CREATE TABLE admin_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           INTEGER NOT NULL,
  actor_sub    TEXT NOT NULL,
  actor_email  TEXT NOT NULL,
  action       TEXT NOT NULL,
  subject      TEXT,
  detail       TEXT
);

CREATE INDEX admin_audit_ts ON admin_audit (ts DESC);
