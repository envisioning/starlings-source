-- One refresh token per device, not one per person.
--
-- `people.refresh_jti` recorded the single refresh token that was current for
-- a person. Rotation then meant that whichever device renewed last invalidated
-- every other device's token: a Mac sign-in in the morning signed the phone
-- out, silently, and the phone found out the next time it tried to renew.
--
-- A device row is the unit of rotation now. Renewing on one device replaces
-- that device's token and leaves the others alone; replaying a spent token is
-- still refused, because the row records which token is current for it.
-- `people.refresh_jti` is left in place for tokens minted before this
-- migration, which carry no device claim and are converted on their next
-- renewal.
CREATE TABLE owner_devices (
  device_id   TEXT PRIMARY KEY,
  sub         TEXT NOT NULL,
  client      TEXT NOT NULL,
  refresh_jti TEXT NOT NULL,
  issued_at   INTEGER NOT NULL,
  renewed_at  INTEGER NOT NULL
);

CREATE INDEX owner_devices_sub ON owner_devices (sub);
