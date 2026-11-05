-- Link saves (envisioning/meet#345): a person drops a URL, Docs reads the
-- page's metadata, and the save is a native document with
-- `source_kind = 'link'`. The body is the person's notes; this table holds
-- what the page said about itself.
--
-- Additive only. `documents` keeps its CHECKs: rebuilding it on D1 would run
-- an implicit DELETE that `signatures` (RESTRICT) refuses and seven CASCADE
-- tables obey, and D1 cannot turn foreign keys off. So a save is marked by
-- `source_kind`, which has no CHECK, and `category` stays NULL on it.
--
-- No CHECK on `fetch_status` either: the zod enum in the contracts is the
-- list, and a CHECK here is a list SQLite can never widen.

CREATE TABLE link_saves (
  document_id    TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  -- What the person gave, trimmed.
  url            TEXT NOT NULL,
  -- The dedupe key: the page's canonical URL if it named a safe one, else the
  -- final URL after redirects, normalized (see `normalizeURL`).
  canonical_url  TEXT NOT NULL,
  site_name      TEXT,
  description    TEXT,
  -- og:image copied into R2 through the same guard as the page. Never
  -- hot-linked: a viewer's client would otherwise call the site on open.
  image_r2_key   TEXT,
  image_type     TEXT,
  -- ok | failed | skipped (not HTML)
  fetch_status   TEXT NOT NULL,
  fetch_error    TEXT,
  fetched_at     TEXT,
  created_by     TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- "Have I saved this already?" Not unique: a deleted save must not block a
-- new one, and uniqueness cannot see `documents.status`. The code checks.
CREATE INDEX idx_link_saves_author_url ON link_saves(created_by, canonical_url);
