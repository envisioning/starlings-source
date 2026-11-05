-- Take a row out of the global roster without taking it out of history.
--
-- Test accounts (`accounts@example.org` and friends) sign in like anyone
-- else, so they earn a `people` row and then sit in the Team list forever
-- beside actual colleagues. Deleting the row is not the fix: a `people` row is
-- what an old message resolves its sender through, and dropping one would
-- leave a thread quoting nobody — the same reason a retired agent is filtered
-- on the read rather than removed (see `peerRoster`).
--
-- So: hidden is a *view* concern. `hidden_at` is NULL for everyone by default;
-- when it is set the row stops appearing in `GET /api/peers` — the roster
-- behind Team and every surface built on it — and nothing else changes. Admin
-- still lists them (that is where the toggle lives), their history still
-- resolves, and un-hiding is one click because no data was lost.
--
-- `hidden_by_sub` is the audit half: an org-wide toggle with no author is a
-- mystery the next person has to reconstruct.
ALTER TABLE people ADD COLUMN hidden_at INTEGER;
ALTER TABLE people ADD COLUMN hidden_by_sub TEXT;
