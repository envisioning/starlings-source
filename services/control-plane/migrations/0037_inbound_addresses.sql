-- One inbound email address per subject channel (meet#216).
--
-- The local part lives on the channel's index row: `<local>@<INBOUND_EMAIL_DOMAIN>`
-- is what the channel header shows, and what the `email` handler looks up
-- when a member forwards a message there. Minted from the subject's title the
-- first time the channel is opened after this migration; unique, and never
-- rewritten once set, because the address is on people's clipboards.
-- `p-<id>` / `l-<id>` / `pt-<id>` also resolve without a row, so a subject
-- opened before its address was minted still has one.
ALTER TABLE threads ADD COLUMN inbound_local TEXT;
CREATE UNIQUE INDEX threads_inbound_local ON threads(inbound_local);
