-- Which INBOX sources one person wants (packages/contracts/src/inbox.ts
-- `INBOX_SOURCE_SPECS`, `resolveInboxSources`). Beside the SALES opt-in and
-- `work_list`: "how I want Work to read", one row per owner. JSON map of
-- source to on/off, resolved source by source on every read, so a key a
-- newer build wrote is ignored by an older one and a source the row does
-- not name follows its default. NULL is "never said".
ALTER TABLE work_preferences ADD COLUMN inbox_sources TEXT;
