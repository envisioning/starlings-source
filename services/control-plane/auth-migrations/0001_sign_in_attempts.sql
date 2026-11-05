-- The starlings-auth Worker's own D1 (docs/CENTRAL_AUTH.md).
-- Browser-bound, single-use sign-in attempts. No session, no refresh token,
-- no plaintext identity: a result is sealed with AES-GCM, and only the hash
-- of the redemption code is kept.
CREATE TABLE sign_in_attempts (
  ticket TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('login', 'calendar', 'google-grant')),
  -- From the caller's AUTH binding props, never from the caller.
  workspace_origin TEXT NOT NULL,
  return_path TEXT NOT NULL,
  owner_sub TEXT,
  product TEXT,
  login_hint TEXT,
  -- The sign-in screen and Google's account chooser.
  workspace_name TEXT,
  mark_path TEXT,
  hosted_domain TEXT,
  browser_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  started_at INTEGER,
  redeem_hash TEXT,
  result_iv TEXT,
  result_ciphertext TEXT
);
CREATE INDEX sign_in_attempts_expiry ON sign_in_attempts(expires_at);
