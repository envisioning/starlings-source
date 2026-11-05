-- Filing suggestions for imported Granola notes (docs/GRANOLA_BRIDGE.md
-- §Suggested filing, docs/JEV.md recommended order 1).
--
-- One row per note: what the decision model proposed, with the probability it
-- gave, and later what a person actually filed. The second half is the
-- calibration record the vendor did not publish — per bucket, how often the
-- suggestion was right on our meetings — and it is what sets the threshold.
-- Never meeting content: kinds, ids, titles Core already holds, and numbers.
CREATE TABLE granola_suggestions (
  note_id             TEXT PRIMARY KEY,
  model               TEXT NOT NULL,
  meeting_kind        TEXT NOT NULL,
  kind_probability    REAL NOT NULL,
  subject_kind        TEXT,
  subject_id          TEXT,
  subject_title       TEXT,
  subject_probability REAL,
  -- How many subjects were offered, and whether they were the organization's
  -- own (scoped) or the wide list. A hit over five options is not a hit over
  -- a hundred.
  options             INTEGER NOT NULL,
  scoped              INTEGER NOT NULL,
  suggested_at        INTEGER NOT NULL,
  -- Filled when a person files the note: `accepted` when kind and subject
  -- match the suggestion, `corrected` otherwise.
  outcome             TEXT,
  filed_kind          TEXT,
  filed_subject_id    TEXT,
  decided_at          INTEGER
);

-- When each connector last did each thing, for the Connectors page. One row
-- per (connector, event); the value is the latest time.
CREATE TABLE connector_pulse (
  connector TEXT NOT NULL,
  event     TEXT NOT NULL,
  at        INTEGER NOT NULL,
  PRIMARY KEY (connector, event)
);
