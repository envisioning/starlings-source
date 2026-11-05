-- A device row the person can recognise.
--
-- `owner_devices` has always been keyed by a random id the install keeps in
-- its Keychain, which is right for rotation and useless for a person looking
-- at a list after losing a phone: three rows that say `ios` tell nobody which
-- one to sign out. The client names itself at sign-in and at every renewal
-- (`UIDevice.current.name`, the Mac's localized host name), so a row from
-- before this migration gets its label at its next renewal. Nullable on
-- purpose: a build that predates the field still renews.
ALTER TABLE owner_devices ADD COLUMN label TEXT;
