-- What a finished provisioning run leaves on its request
-- (scripts/provision-workspace.mjs, docs/ONBOARDING.md):
--   provisioned_at  when the run ended; the Requests card then says to send
--                   the ready mail.
--   service_hosts   a JSON list of the workspace's Docs and Keep origins,
--                   which Send ready mail checks besides the workspace.
--   agent_state     the managed meeting agent's stage at the end of the run,
--                   shown, never required.
-- A rerun clears provisioned_at when it moves the request back to provisioning.
ALTER TABLE workspace_requests ADD COLUMN provisioned_at INTEGER;
ALTER TABLE workspace_requests ADD COLUMN service_hosts TEXT;
ALTER TABLE workspace_requests ADD COLUMN agent_state TEXT;
