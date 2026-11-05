-- The import ledger, keyed by member (meet#394, docs/CONNECTORS.md).
--
-- `import_items` keyed a cursor by `(source, external_id)`. Gmail keeps one
-- cursor per mailbox and Drive one change token per member, so the member
-- joins the key. `owner_sub = ''` is a workspace-level connector: GitHub,
-- Slack, Notion.
--
-- SQLite cannot change a primary key in place, and migrations here are
-- additive (AGENTS.md §D1 migrations). So this is a new table with every
-- existing row copied in. The Worker reads and writes only this table from
-- this release on. `import_items` is dropped one release later, so a
-- rollback still finds the table it reads; a cursor it misses meanwhile is
-- read again, and every import is idempotent.
CREATE TABLE import_ledger (
  source          TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  owner_sub       TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL,
  cursor          TEXT,
  backfill_done   INTEGER NOT NULL DEFAULT 0,
  count           INTEGER NOT NULL DEFAULT 0,
  last_synced_at  INTEGER,
  error           TEXT,
  PRIMARY KEY (source, external_id, owner_sub)
);

INSERT INTO import_ledger (source, external_id, owner_sub, status, cursor, backfill_done, count, last_synced_at, error)
SELECT source, external_id, '', status, cursor, backfill_done, count, last_synced_at, error
  FROM import_items;
