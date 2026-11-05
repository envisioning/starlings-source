-- Native sign-in through the workspace's web sign-in (meet#726,
-- docs/CENTRAL_AUTH.md). One row per code the finish step issued: only the
-- hash of the code, the PKCE challenge it is bound to, and the person.
-- A row lives 60 seconds; redemption deletes it.
CREATE TABLE IF NOT EXISTS native_sign_in_codes (
  code_hash TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  sub TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  picture TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS native_sign_in_codes_expiry ON native_sign_in_codes (expires_at);
