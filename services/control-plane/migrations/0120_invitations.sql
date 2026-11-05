-- Invitations (meet#873, docs/ONBOARDING.md §Invitations). An admin invites
-- an address with a role; signing in with an open invitation writes the
-- `people` row with that role and the person's room (0119) in one batch, and
-- sets `accepted_at`. An invitation is open while `accepted_at` and
-- `revoked_at` are null and `expires_at` is ahead (14 days, decision 8).
-- Resend moves `expires_at` and `mailed_at` on the same row.
--
-- `email` is lowercase. `invited_by` is the inviting admin's address, shown
-- in the mail. `mailed_at` is null when the mail could not be sent.
-- An accepted invitation is the membership of an address outside the
-- workspace's sign-in domains: the session gate reads it (capabilities.ts).
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  mailed_at INTEGER,
  accepted_at INTEGER,
  revoked_at INTEGER
);

-- One unspent invitation per address; a lapsed one is resent, not doubled.
CREATE UNIQUE INDEX invitations_unspent_email ON invitations (email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX invitations_email ON invitations (email);
