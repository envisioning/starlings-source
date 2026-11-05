-- The GitHub connector (meet#256), and the source-agnostic import ledger the
-- Slack (#254), Google Drive (#255) and Notion (#257) imports reuse. `source`
-- is a column from day one so the next connector adds rows, not tables.

-- What a person decided for one external thing: which subject it belongs to,
-- or that it is skipped. A skip is a row too, so the list does not re-ask.
-- Never content: ids, a title Core already holds, who decided, when.
CREATE TABLE import_mappings (
  source        TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  subject_kind  TEXT,
  subject_id    TEXT,
  subject_title TEXT,
  decided_by    TEXT NOT NULL,
  decided_at    INTEGER NOT NULL,
  PRIMARY KEY (source, external_id)
);

-- Where the sync stands on one external thing: the cursor it will resume
-- from, how many rows it wrote, and the last error. Read by the connector
-- list, and the source of truth for "did it land".
CREATE TABLE import_items (
  source          TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  status          TEXT NOT NULL,
  cursor          TEXT,
  backfill_done   INTEGER NOT NULL DEFAULT 0,
  count           INTEGER NOT NULL DEFAULT 0,
  last_synced_at  INTEGER,
  error           TEXT,
  PRIMARY KEY (source, external_id)
);

-- Pull requests on mapped repositories, one row each, upserted by the sync.
-- Titles and logins only; a body never lands here. `closes` is a JSON array
-- of issue numbers the body said it closes.
CREATE TABLE github_pulls (
  id           TEXT PRIMARY KEY,
  owner        TEXT NOT NULL,
  repo         TEXT NOT NULL,
  number       INTEGER NOT NULL,
  title        TEXT NOT NULL,
  url          TEXT NOT NULL,
  state        TEXT NOT NULL,
  review       TEXT NOT NULL,
  checks       TEXT NOT NULL,
  author_login TEXT,
  closes       TEXT NOT NULL DEFAULT '[]',
  head_ref     TEXT,
  head_sha     TEXT,
  created_at   TEXT,
  updated_at   TEXT,
  merged_at    TEXT,
  closed_at    TEXT,
  synced_at    INTEGER NOT NULL
);
CREATE INDEX github_pulls_repo_updated ON github_pulls (owner, repo, updated_at DESC);
