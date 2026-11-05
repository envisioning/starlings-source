-- Per-user subject state: follow, star, mute (envisioning/meet#147 decision 5,
-- slice 2). Reader state, so it lives here per owner and never in Core — Core
-- says what a subject is; this says what one person wants from it.
--
-- Overrides only. A row exists when somebody has said something about a
-- subject; everything else is the role default, computed at read time
-- (packages/contracts/src/subject-state.ts, pinned by
-- fixtures/subject-state.json). That is why `followed` is nullable: NULL means
-- "the default decides", which is what lets a project that appears tomorrow
-- be followed by everyone who follows CLIENTS without a backfill per person.
-- `starred` and `muted` have no default to fall back to, so they are plain
-- flags. A row that says nothing (followed NULL, both flags 0) is deleted
-- rather than kept, so the table stays a list of opinions.
CREATE TABLE subject_state (
  sub TEXT NOT NULL,
  kind TEXT NOT NULL,           -- lead | project | partner
  subject_id TEXT NOT NULL,     -- Core's id for that kind
  followed INTEGER,             -- 1 / 0 / NULL = role default
  starred INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (sub, kind, subject_id)
);

-- Work preferences that are not about one subject. `sales_enabled` is the
-- SALES opt-in ("only when Sales is on for you"): it was a client-local
-- sidebar toggle (`work.leads` visibility); INBOX (slice 2b) is built in the
-- Worker, so the Worker has to know. Off by default for every role.
CREATE TABLE work_preferences (
  sub TEXT PRIMARY KEY,
  sales_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
