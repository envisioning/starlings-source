-- Event follow-up mail can be refused (meet#1071). A follow-up carries the
-- host's note and call to action, so it can be marketing; each one has a
-- one-click unsubscribe link. Confirmation and reminder mail are
-- transactional and ignore this table.
--
-- `event_mail_opt_outs`: one row per address that refused follow-ups from
-- this workspace. `sendFollowUps` skips it.
--
-- `event_mail_unsubscribe_links`: one row per follow-up sent. The link holds
-- a random token; only its SHA-256 is stored, so the table names no link and
-- the URL names no address.
CREATE TABLE event_mail_opt_outs (
  email TEXT PRIMARY KEY,
  opted_out_at INTEGER NOT NULL
);

CREATE TABLE event_mail_unsubscribe_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
