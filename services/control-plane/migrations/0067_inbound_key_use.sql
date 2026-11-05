-- One inbound key per caller (meet#607). `ops_inbound` already says when a
-- caller was last accepted or refused. These two say *how* it signed: with its
-- own key (`x-internal-key-id`) or with the old shared secret.
--
-- `last_legacy_at` is the changeover's finish line: when no caller has a
-- recent value here, nothing signs with the shared secret any more and it can
-- be deleted. Written at most once a minute per caller.
ALTER TABLE ops_inbound ADD COLUMN last_keyed_at INTEGER;
ALTER TABLE ops_inbound ADD COLUMN last_legacy_at INTEGER;
