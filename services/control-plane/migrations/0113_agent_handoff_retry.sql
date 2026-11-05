-- One automatic retry of a stuck agent run (meet#1062).
--
-- The watchdog (resetStuckAgents) used to reset a run that never answered and
-- ask the person to resend. It now hands the same request to the agent once
-- more, quietly, and stamps `retried_at`. A second hang on the same request
-- finds `retried_at` set and posts the notice instead, with a Retry choice.
-- markWorking keeps `retried_at` while the request is the same one, and
-- clears it when a new request takes the row.
ALTER TABLE agent_handoffs ADD COLUMN retried_at INTEGER;
