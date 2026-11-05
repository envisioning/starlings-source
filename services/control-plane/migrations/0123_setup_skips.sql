-- The setup checklist (docs/ONBOARDING.md §The setup checklist): a step one
-- person cleared from their own card with Skip. One row per person and step;
-- bringing a step back deletes the row. `step` is a registry id
-- (packages/contracts/src/setup-steps.ts); an id the registry no longer has
-- is ignored on read.
CREATE TABLE IF NOT EXISTS setup_skips (
  sub TEXT NOT NULL,
  step TEXT NOT NULL,
  skipped_at INTEGER NOT NULL,
  PRIMARY KEY (sub, step)
);
