-- Link clicks in the access log (envisioning/starlings#1045). A guest who
-- opens a link inside a shared document is recorded as kind `click`, with the
-- link in `detail` ({"href": …}).
--
-- SQLite cannot alter a CHECK, so `access_events` is rebuilt: a new table with
-- the wider CHECK, every row copied, the old table dropped, the new one
-- renamed, the indexes made again. This is safe where rebuilding `documents`
-- is not (AGENTS.md, "D1 notes"): no table references `access_events`, so the
-- DROP cascades into nothing, and no trigger or FTS index reads it. The
-- rebuilt table keeps its own two references, to `documents` (CASCADE) and
-- `grants` (SET NULL); every copied row already satisfies both.

CREATE TABLE access_events_next (
  id          TEXT PRIMARY KEY,
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  grant_id    TEXT REFERENCES grants(id) ON DELETE SET NULL,
  actor       TEXT,
  actor_kind  TEXT NOT NULL DEFAULT 'guest'
                CHECK (actor_kind IN ('staff', 'guest', 'agent', 'system')),
  kind        TEXT NOT NULL
                CHECK (kind IN ('view', 'download', 'annotate', 'sign', 'decline', 'edit', 'share', 'click')),
  ip          TEXT,
  user_agent  TEXT,
  referrer    TEXT,
  timezone    TEXT,
  language    TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO access_events_next
  (id, document_id, grant_id, actor, actor_kind, kind, ip, user_agent, referrer, timezone, language, detail, created_at)
SELECT id, document_id, grant_id, actor, actor_kind, kind, ip, user_agent, referrer, timezone, language, detail, created_at
  FROM access_events;

DROP TABLE access_events;

ALTER TABLE access_events_next RENAME TO access_events;

CREATE INDEX idx_access_document ON access_events(document_id, created_at DESC);
CREATE INDEX idx_access_actor    ON access_events(actor, created_at DESC);
