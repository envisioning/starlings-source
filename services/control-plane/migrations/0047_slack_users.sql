-- The Slack workspace directory (meet#254, docs/SLACK_IMPORT.md), so a page
-- of imported history resolves its senders without a call per message.
-- Re-read once a day by the sync. Names and addresses Slack already shows
-- every member; never message text.
CREATE TABLE slack_users (
  id         TEXT PRIMARY KEY,
  team_id    TEXT,
  name       TEXT,
  email      TEXT,
  is_bot     INTEGER NOT NULL DEFAULT 0,
  deleted    INTEGER NOT NULL DEFAULT 0,
  synced_at  INTEGER NOT NULL
);
CREATE INDEX slack_users_email ON slack_users (email);
