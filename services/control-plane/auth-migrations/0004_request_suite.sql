-- Where the applicant's mail and calendar live (MZ, 2026-10-04): google,
-- microsoft or other. Provisioning writes it to the workspace's
-- WORKSPACE_SUITE var. Requests sent before the field existed are google.
ALTER TABLE workspace_requests ADD COLUMN suite TEXT NOT NULL DEFAULT 'google';
