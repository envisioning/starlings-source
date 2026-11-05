-- The meeting log in D1, for workspaces with WORK_STORE=d1
-- (docs/WORKSPACE_STORE.md slice 6, meet#776). A finished or filed call on a
-- D1 workspace writes one interaction here instead of posting to Core's
-- meeting-log ingest (docs/MEETING_LOG.md). Empty on Envisioning, whose
-- interactions stay in Core until its own fold.
--
-- Columns follow Core's `interactions` where the wire (`crmInteractionSchema`)
-- reads them. The full transcript is not here: it is the Docs document that
-- `transcript_url` names. Times are epoch milliseconds; people are person ids
-- (migration 0072).

CREATE TABLE interactions (
  id                      TEXT PRIMARY KEY,
  -- crmInteractionTypeSchema: note, email, call, meeting, web.
  type                    TEXT NOT NULL DEFAULT 'meeting',
  title                   TEXT NOT NULL,
  -- in_progress while the meeting is on, logged once it ended.
  status                  TEXT,
  channel                 TEXT,
  -- Which system captured it, as Core's: meet_envisioning, meet_ambient, granola.
  source                  TEXT NOT NULL,
  -- The capturing system's own id: a Meet meeting id.
  external_id             TEXT NOT NULL,
  occurred_at             INTEGER NOT NULL,
  ended_at                INTEGER,
  summary_markdown        TEXT,
  transcript_preview      TEXT,
  transcript_url          TEXT,
  transcript_document_id  TEXT,
  url                     TEXT,
  meeting_kind            TEXT,
  host_person_id          TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);
-- A redelivery updates the row it wrote before, never a second one.
CREATE UNIQUE INDEX interactions_external ON interactions (source, external_id);
CREATE INDEX interactions_occurred ON interactions (occurred_at);

-- What an interaction is filed under: a lead, a project or a partner (its
-- organization). A status or internal meeting has no row here.
CREATE TABLE interaction_subjects (
  interaction_id  TEXT NOT NULL REFERENCES interactions (id),
  subject_kind    TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  PRIMARY KEY (interaction_id, subject_kind, subject_id)
);
CREATE INDEX interaction_subjects_subject ON interaction_subjects (subject_kind, subject_id);
