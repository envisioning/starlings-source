-- The account-level ledger. docs/ADMIN.md §6, finally built.
--
-- Every fact Meet holds lives in a per-room Durable Object keyed by slug, and
-- Durable Objects are not enumerable — there is no "list all rooms" call, in
-- the platform or in this repo. So `/admin` assembled its history by fanning
-- out over the slugs in `OWNER_ROOM_MAP` and asking each DO for its meetings.
-- That works with one room. It is O(rooms x meetings) on every page load, it
-- reports nothing at all for a room whose slug has left the map, and a DO that
-- cannot be reached takes its whole history out of the numbers.
--
-- `meetings_ledger` is the durable aggregate. The DO stays the source of truth
-- for a live meeting; this is what survives the room.
--
-- Metadata only. There is nowhere here to put a transcript, a summary, or a
-- guest's address, by construction — see PRIVACY.md §12. `guest_domains` is
-- the deliberate line: which organisations were in the room, never who.
--
-- `webhook_seconds` is the column Phase 3 fills from LiveKit's own webhooks.
-- Until then `client_seconds` — flushed by clients once a minute, and lost
-- when a browser dies without a final flush — is all there is, which is why
-- the two are separate columns rather than one reconciled number.
CREATE TABLE meetings_ledger (
  meeting_id            TEXT PRIMARY KEY,
  room_slug             TEXT NOT NULL,
  host_email            TEXT NOT NULL,
  title                 TEXT,
  started_at            INTEGER NOT NULL,
  ended_at              INTEGER,
  participant_count     INTEGER NOT NULL DEFAULT 0,
  guest_count           INTEGER NOT NULL DEFAULT 0,
  guest_domains         TEXT NOT NULL DEFAULT '[]',
  webhook_seconds       INTEGER,
  client_seconds        INTEGER NOT NULL DEFAULT 0,
  was_booked            INTEGER NOT NULL DEFAULT 0,
  meeting_kind          TEXT,
  summary_generated     INTEGER NOT NULL DEFAULT 0,
  emails_sent           INTEGER NOT NULL DEFAULT 0,
  crm_synced            INTEGER NOT NULL DEFAULT 0,
  worst_quality         TEXT,
  reconnects            INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX meetings_ledger_started_idx ON meetings_ledger (started_at DESC);
CREATE INDEX meetings_ledger_host_idx    ON meetings_ledger (host_email, started_at DESC);

-- Append-only, and write-only for now — deliberately.
--
-- The funnel `/admin` draws today comes from the DO, which has every knock
-- since the room was created. These rows start at zero. A surface that swapped
-- to them on the day they landed would report that nobody has ever knocked, so
-- the funnel stays on the fan-out until this table has history worth reading;
-- what it buys immediately is that the history starts accumulating somewhere
-- that outlives the room.
--
-- `kind` is a closed set: signin, knock, admit, reject, abandon, join,
-- meeting_start, meeting_end, summary_generated, email_sent, crm_sync_failed,
-- feedback_filed.
--
-- No IP, ever. `country` comes from `request.cf` at the moment of the event,
-- the same way guest presence already takes it.
CREATE TABLE usage_events (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                    INTEGER NOT NULL,
  kind                  TEXT NOT NULL,
  room_slug             TEXT,
  meeting_id            TEXT,
  actor_kind            TEXT,
  client_app            TEXT,
  country               TEXT
);

CREATE INDEX usage_events_ts_idx   ON usage_events (ts DESC);
CREATE INDEX usage_events_kind_idx ON usage_events (kind, ts DESC);
