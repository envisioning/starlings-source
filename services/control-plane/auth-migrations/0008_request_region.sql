-- Where the workspace keeps its data (MZ, 2026-10-15;): eu or us,
-- from packages/contracts/src/workspace-region.ts. The applicant chooses it on
-- /start and nobody changes it after: provisioning writes it to
-- WORKSPACE_REGION and every store's jurisdiction. Requests sent before the
-- field existed are eu, where every workspace so far was made.
ALTER TABLE workspace_requests ADD COLUMN region TEXT NOT NULL DEFAULT 'eu';
