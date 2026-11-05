-- Sign in by email link (docs/ONBOARDING.md §The email link sign-in; MZ,
-- 2026-10-04). A workspace that signs in through starlings-auth offers it
-- beside Google. Single use, 15 minutes, only the SHA-256 of the token kept.
CREATE TABLE email_sign_in_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  return_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX email_sign_in_links_email ON email_sign_in_links(email, created_at);
