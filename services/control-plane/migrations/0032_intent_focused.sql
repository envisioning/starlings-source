-- Intent is now `available` or `focused`. `heads_down` was renamed to
-- `focused`; `stepped_out` was folded into unavailable (`dnd_until`) and no
-- client sends it. Rows on the old values are rewritten rather than left for
-- the reader to drop, so nothing on the wire ever carries a word the contract
-- no longer knows. See docs/PRESENCE.md.
UPDATE people SET intent = 'focused' WHERE intent = 'heads_down';
UPDATE people SET intent = NULL, intent_until = NULL WHERE intent = 'stepped_out';
