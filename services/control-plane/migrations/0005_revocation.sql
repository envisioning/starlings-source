-- Somebody who leaves Envisioning must stop being able to renew a session.
--
-- Sessions used to last 8h with no renewal, so the ceiling on a departed
-- member's access was 8h and nothing needed revoking. Long-lived refresh
-- tokens change that: without a way to say "not this person any more", a
-- token minted today would keep working for its full life. This is that way.
--
-- Null means current, which is what every existing row is.
ALTER TABLE people ADD COLUMN revoked_at INTEGER;

-- The refresh token currently good for this person.
--
-- Rotation on its own proves nothing: handing out a new token does not stop
-- the old one working. Recording which one is current, and refusing anything
-- else, is what makes a stolen refresh token useless the moment its owner
-- renews — and makes the replay visible instead of silent.
ALTER TABLE people ADD COLUMN refresh_jti TEXT;
