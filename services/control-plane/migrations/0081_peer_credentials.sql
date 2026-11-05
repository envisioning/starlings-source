-- Peer organizations (docs/ACCESS.md slice 5, decided 2026-10-04).
--
-- A peer is another company, as a row of the work model's own
-- `organizations` table (migration 0073), never a CRM row: the same record a
-- lead or project hangs off can be the peer. This table holds its one
-- credential. Only the token's SHA-256 is stored. Revoking closes every
-- subject granted to it at once; rotating replaces the hash. Its grants are
-- `subject_grants` rows with `principal_kind = 'peer_workspace'` and the
-- organization id.
CREATE TABLE peer_credentials (
  organization_id TEXT PRIMARY KEY REFERENCES organizations (id),
  token_hash TEXT,
  created_by TEXT NOT NULL,           -- people.sub
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX peer_credentials_token_hash
  ON peer_credentials (token_hash)
  WHERE token_hash IS NOT NULL;
