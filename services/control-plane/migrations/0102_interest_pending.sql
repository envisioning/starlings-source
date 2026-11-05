-- Early-access requests an agent sent, waiting for the person to confirm
-- (docs/FORMS.md §Agents). A row moves to interest_submissions when the
-- person opens the mailed link, and is deleted then or when it expires.
-- `token_hash` is the SHA-256 of the mailed token; the token itself is never
-- stored. `body` is the validated answers as JSON, as interest_submissions
-- keeps them.
CREATE TABLE IF NOT EXISTS interest_pending (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS interest_pending_email ON interest_pending (email, created_at DESC);
