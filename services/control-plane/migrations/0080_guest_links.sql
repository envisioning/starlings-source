-- A guest grant's link (docs/ACCESS.md slice 4).
--
-- A guest reaches a subject through a link a member copies to them. Only the
-- link's SHA-256 is stored, on the grant it opens; granting again replaces
-- it, and revoking the grant closes it. Null on every other grant.
ALTER TABLE subject_grants ADD COLUMN link_hash TEXT;
CREATE UNIQUE INDEX subject_grants_link_hash
  ON subject_grants (link_hash)
  WHERE link_hash IS NOT NULL;
