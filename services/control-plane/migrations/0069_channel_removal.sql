-- Remove a channel whose subject is gone, and put it back (meet#707).
--
-- A subject's channel outlives its subject: delete the lead in Core and the
-- channel stays in everybody's list for good. An admin can now hide it.
-- Hiding is not deleting: the Durable Object's messages are untouched, and
-- clearing `removed_at` brings the channel back with its history.
--
-- `removed_at` is when it was hidden (epoch ms); null means visible, which is
-- every row that exists today. `removed_by` is the admin's email, kept on the
-- row so Admin can say who without reading the audit trail. A subject that
-- comes back, or any event or message that arrives for the channel, clears
-- both (`ensureSubjectThread`, `appendInboundMessage`).
ALTER TABLE threads ADD COLUMN removed_at INTEGER;
ALTER TABLE threads ADD COLUMN removed_by TEXT;
