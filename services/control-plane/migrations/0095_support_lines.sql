-- The support line (meet#927), on hq: which workspace origin is which
-- organization. A workspace that connects again gets a new token for the
-- same organization, never a second organization.
CREATE TABLE support_lines (
  origin           TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL,
  created_at       INTEGER NOT NULL
);
