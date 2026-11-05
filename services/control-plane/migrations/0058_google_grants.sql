-- The Google connector grant (meet#394, docs/CONNECTORS.md).
--
-- One row per member: the refresh token for the connector's own Google Cloud
-- project, sealed with GOOGLE_TOKEN_ENCRYPTION_KEY, and the scopes Google
-- reported at the last consent. Google revokes a grant whole, so one member
-- holds one grant; Gmail and Drive are scopes on it, not rows.
--
-- Calendar's tokens stay in KV (CALENDAR_TOKENS, meet#324). They belong to a
-- different Google Cloud project, so this grant and Calendar's never revoke
-- each other.
CREATE TABLE google_grants (
  sub         TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  iv          TEXT NOT NULL,
  ciphertext  TEXT NOT NULL,
  scopes      TEXT NOT NULL,
  granted_at  INTEGER NOT NULL,
  used_at     INTEGER
);
