-- Signup links can be resent and revoked, and a request keeps the mails that
-- did not go out. A revoked link stops working; minting again for
-- the same address revokes the open one, which is a resend.
ALTER TABLE signup_links ADD COLUMN revoked_at INTEGER;
-- Comma-separated: `receipt` (to the applicant), `operator` (O1). Null when both went.
ALTER TABLE workspace_requests ADD COLUMN mail_failed TEXT;
