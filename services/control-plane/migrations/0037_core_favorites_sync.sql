-- Retryable bridge from Meet's deployed subject_state stars to Core's shared
-- member_favorites relation (meet#392). Mute and work preferences stay here.
CREATE TABLE favorite_sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sub TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 80),
  target_ref TEXT NOT NULL CHECK (length(target_ref) BETWEEN 1 AND 512),
  starred INTEGER NOT NULL CHECK (starred IN (0, 1)),
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error_code TEXT
);

CREATE INDEX favorite_sync_queue_due_idx
  ON favorite_sync_queue (next_attempt_at, id);
CREATE INDEX favorite_sync_queue_member_idx
  ON favorite_sync_queue (sub, kind, target_ref, id);

-- updated_at is the best legacy ordering proxy: the old table had no separate
-- starred_at. Seed in timestamp order so the queue inserts into Core in order.
INSERT INTO favorite_sync_queue
  (sub, kind, target_ref, starred, created_at, next_attempt_at)
SELECT sub,
       CASE kind
         WHEN 'lead' THEN 'crm.lead'
         WHEN 'project' THEN 'crm.project'
         WHEN 'partner' THEN 'crm.partner'
         WHEN 'event' THEN 'cms.event'
       END,
       lower(subject_id),
       1,
       updated_at,
       0
  FROM subject_state
 WHERE starred = 1
 ORDER BY sub, updated_at, kind, subject_id;
