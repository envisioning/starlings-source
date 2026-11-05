-- Report the version last seen at native sign-in or refresh. Existing rows
-- stay valid and acquire metadata on their next successful token exchange.
ALTER TABLE owner_devices ADD COLUMN platform TEXT;
ALTER TABLE owner_devices ADD COLUMN app_version TEXT;
ALTER TABLE owner_devices ADD COLUMN version_seen_at INTEGER;
