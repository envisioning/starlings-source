-- The auth host's own browser session (docs/CENTRAL_AUTH.md "The auth
-- session"). One row per browser that signed in with Google here. It lets a
-- second sign-in skip Google.
--
-- Still no plaintext identity: the row keeps the SHA-256 of the cookie's
-- token, and a blob sealed under a key derived from that token. The blob
-- holds the identity Google proved and the origins this browser signed in
-- to. Without the cookie, the row opens nothing.
CREATE TABLE browser_sessions (
  id_hash TEXT PRIMARY KEY,
  sealed_iv TEXT NOT NULL,
  sealed_ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX browser_sessions_expiry ON browser_sessions(expires_at);
