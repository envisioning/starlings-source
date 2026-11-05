-- Canonical attention repository (#794). Legacy routes are connected in #773.
CREATE TABLE attention_requests (
  id TEXT PRIMARY KEY,
  recipient_email TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'answered', 'dismissed', 'withdrawn', 'defaulted')),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  CHECK (json_extract(snapshot, '$.id') = id),
  CHECK (json_extract(snapshot, '$.recipient_email') = recipient_email),
  CHECK (json_extract(snapshot, '$.state') = state),
  CHECK (json_extract(snapshot, '$.revision') = revision),
  CHECK (json_extract(snapshot, '$.created_at') = created_at)
);
CREATE INDEX attention_requests_pending ON attention_requests (recipient_email, state, created_at, id);
