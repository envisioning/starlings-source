-- A public support contact gets a private guest thread on the intake subject
-- (docs/SUPPORT.md). Ordinary guest grants still address the subject's shared
-- guest thread, so this stays NULL for every existing grant.
ALTER TABLE subject_grants ADD COLUMN thread_id TEXT;
