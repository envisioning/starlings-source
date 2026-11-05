-- Licence fields for the Signals product (decided by MZ, 2026-11-05). A Signals
-- customer is a licence with `product = 'signals'`: the one join key and the
-- usage snapshot that `signals_accounts` held land here, by the same names.
--
-- Core has none of these on `licenses`. A new column on a table the group copies
-- is not in `COMMERCIAL_COLUMNS`, so the copy's upsert never names it and the
-- verify never compares it (as migration 0140): a copied row takes NULL, and a
-- second copy keeps what D1 wrote. `COMMERCIAL_D1_COLUMNS` lists them.
--
-- `billing_status` and `billing_event_at` take the latest subscription fact. The
-- billing events table retires, so there is no event log.
--
-- The `signals_*` tables of migration 0139 stay in D1, empty and unused. Nothing
-- reads or writes them after this change.

ALTER TABLE licenses ADD COLUMN signals_org_id TEXT;
ALTER TABLE licenses ADD COLUMN usage_schema_version INTEGER;
ALTER TABLE licenses ADD COLUMN usage_snapshot_at INTEGER;
ALTER TABLE licenses ADD COLUMN usage_window_starts_at INTEGER;
ALTER TABLE licenses ADD COLUMN usage_window_ends_at INTEGER;
ALTER TABLE licenses ADD COLUMN usage_projects_count INTEGER;
ALTER TABLE licenses ADD COLUMN usage_sessions_created_30d INTEGER;
ALTER TABLE licenses ADD COLUMN usage_last_session_created_at INTEGER;
ALTER TABLE licenses ADD COLUMN usage_workflow_runs_succeeded_30d INTEGER;
ALTER TABLE licenses ADD COLUMN usage_last_successful_workflow_run_at INTEGER;
ALTER TABLE licenses ADD COLUMN usage_results_first_viewed_at INTEGER;
ALTER TABLE licenses ADD COLUMN usage_credit_buckets TEXT;
ALTER TABLE licenses ADD COLUMN billing_status TEXT;
ALTER TABLE licenses ADD COLUMN billing_event_at INTEGER;

-- One join key: a Signals organization names one licence.
CREATE UNIQUE INDEX licenses_signals_org ON licenses (signals_org_id) WHERE signals_org_id IS NOT NULL;
CREATE INDEX licenses_product ON licenses (product, start_date DESC);
CREATE INDEX leads_source ON leads (source) WHERE source IS NOT NULL;
