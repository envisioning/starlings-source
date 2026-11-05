-- What an agent says it is and what it can do, cached on its people row.
--
-- The runtime serves a manifest at `GET <endpoint>/manifest`; Meet fetches it
-- off the write path, clamps it, and keeps the last good copy here. This is a
-- cache, not a source of truth — exactly like `threads.last_message_preview`
-- or `card_trace`: reconstructible from the runtime, read by nothing that
-- decides anything, and absent for an agent whose runtime serves none. Meet is
-- never the writer of what an agent can do; it displays what the sandbox
-- proves, the same way it displays presence. See docs/AGENTS_SURFACE.md.
--
-- `agent_manifest` holds the clamped JSON (or NULL when the runtime has none,
-- 404s, or serves something unparseable). `agent_manifest_fetched_at` is the
-- fetched-at that gates the TTL, so a healthy runtime is asked about once per
-- AGENT_MANIFEST_TTL_MILLISECONDS rather than on every roster poll.
ALTER TABLE people ADD COLUMN agent_manifest TEXT;
ALTER TABLE people ADD COLUMN agent_manifest_fetched_at INTEGER;
