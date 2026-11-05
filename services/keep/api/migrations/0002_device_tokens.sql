-- Device tokens for the native Meet client. Minted by Keep when the Meet
-- Worker proves the owner over a shared HMAC secret; one live token per
-- (owner, device name). Hashed — the plaintext is shown once and never
-- stored. A token proves who is asking, like the cookie; it opens nothing.
CREATE TABLE device_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  owner        TEXT NOT NULL,
  name         TEXT NOT NULL,
  device_name  TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX device_tokens_owner ON device_tokens (owner, created_at DESC);
