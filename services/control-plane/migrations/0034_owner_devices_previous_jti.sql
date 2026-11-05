-- A refresh that was spent but never received is not a replay.
--
-- Rotation commits the new jti before the response leaves the Worker. When
-- that response is lost (timeout, dropped connection, app suspended or the
-- phone locked before the Keychain write), the device still holds the token
-- it just spent, and its next renewal was refused: signed out for a network
-- blip. The row now remembers the jti it just retired and when. For a short
-- grace window the retired token buys one more pair; after that it is a
-- replay again.
ALTER TABLE owner_devices ADD COLUMN previous_refresh_jti TEXT;
ALTER TABLE owner_devices ADD COLUMN rotated_at INTEGER;
