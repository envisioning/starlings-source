-- Signing up for a workspace (docs/ONBOARDING.md). Platform data, so it lives
-- in starlings-auth's own D1 and in no workspace's.
--
-- signup_links: one single-use link per address, minted by an operator. Only
-- the SHA-256 of the token is kept. A request keeps the same hash, so the
-- link becomes the request's status page after it is spent.
CREATE TABLE signup_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  interest_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX signup_links_created ON signup_links(created_at);

-- One application for one workspace. `answers` is plain JSON and never leaves
-- the platform (decision 9).
CREATE TABLE workspace_requests (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE REFERENCES signup_links(token_hash),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  workspace_name TEXT NOT NULL,
  slug TEXT NOT NULL,
  accent TEXT NOT NULL,
  membership TEXT NOT NULL,
  answers TEXT NOT NULL,
  interest_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('submitted', 'approved', 'provisioning', 'ready', 'declined', 'failed', 'expired')),
  payment TEXT NOT NULL CHECK (payment IN ('waived', 'pending', 'paid')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  host TEXT,
  failure TEXT
);
CREATE INDEX workspace_requests_state ON workspace_requests(state, created_at);

-- Every slug that is in use or held. The primary key makes holding a slug
-- atomic: two requests cannot hold one. `live` rows are workspaces that
-- exist; `held` rows belong to an open request and are released on decline
-- or expiry.
CREATE TABLE workspace_slugs (
  slug TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('live', 'held')),
  request_id TEXT,
  updated_at INTEGER NOT NULL
);
INSERT INTO workspace_slugs (slug, state, request_id, updated_at) VALUES
  ('envisioning', 'live', NULL, 0),
  ('hq', 'live', NULL, 0);

-- What an operator did, and when. The detail never holds a token.
CREATE TABLE operator_actions (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  operator TEXT NOT NULL,
  action TEXT NOT NULL,
  request_id TEXT,
  detail TEXT
);
CREATE INDEX operator_actions_at ON operator_actions(at);
