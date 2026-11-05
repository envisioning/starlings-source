-- Merges of organizations, contacts and leads on D1 (meet#1203,
-- docs/CORE_FOLD_PLAN.md Phase 4 and §Before each group moves).
--
-- One row per merged record: which row it became. A merge deletes the merged
-- row in D1, but a group that has not moved yet still holds Core rows that
-- name it. The copy of that group reads this table and writes the survivor's
-- id instead, so the D1 foreign keys accept the row and the verify agrees.
-- A later merge of the survivor moves every row that pointed at it.
CREATE TABLE record_merges (
  -- organizations, contacts or leads (CORE_MERGE_ENTITIES).
  entity     TEXT NOT NULL,
  from_id    TEXT NOT NULL,
  into_id    TEXT NOT NULL,
  -- people.person_id of the member who merged, when known.
  merged_by  TEXT,
  merged_at  INTEGER NOT NULL,
  PRIMARY KEY (entity, from_id)
);
CREATE INDEX record_merges_into ON record_merges (entity, into_id);
