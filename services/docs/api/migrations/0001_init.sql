-- Docs — initial schema.
--
-- Design notes that the column list alone does not carry:
--
--   * Everyone at @org.example reads and writes everything. There is no
--     per-folder ACL for staff, and adding one later must not require moving
--     data — that is why access lives in `grants`, keyed by document or folder,
--     rather than being denormalized onto rows.
--   * `path` is materialized on both folders and documents. A rename rewrites
--     descendants in one statement; every read is a single indexed lookup.
--   * A document is either *native* (born here, editable) or *mirrored*
--     (projected from Core or an Obsidian vault, body read-only here).
--     Annotations, links, tags, grants and signatures attach to both kinds, so
--     a newsletter issue from 2019 is as annotatable as a proposal drafted
--     today. `source_*` + `editable` is the whole of that distinction.
--   * FTS5 is fed by triggers, not by application code, so a bulk mirror sync
--     cannot silently drift from the index.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Folders
-- ---------------------------------------------------------------------------

CREATE TABLE folders (
  id           TEXT PRIMARY KEY,
  parent_id    TEXT REFERENCES folders(id) ON DELETE CASCADE,
  slug         TEXT NOT NULL,
  -- Materialized ancestry, always leading-slash, never trailing: '/clients/greiner'.
  path         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  depth        INTEGER NOT NULL DEFAULT 0,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  icon         TEXT,
  description  TEXT,
  -- Where this subtree is mirrored from, when the whole folder is a projection
  -- ('core:newsletter_issue', 'obsidian:Envisioning'). NULL for native folders.
  source_key   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by   TEXT,
  UNIQUE (parent_id, slug)
);

CREATE INDEX idx_folders_parent ON folders(parent_id, sort_order, title);
CREATE INDEX idx_folders_source ON folders(source_key) WHERE source_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------

CREATE TABLE documents (
  id              TEXT PRIMARY KEY,
  folder_id       TEXT REFERENCES folders(id) ON DELETE RESTRICT,
  slug            TEXT NOT NULL,
  path            TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'markdown'
                    CHECK (kind IN ('markdown', 'pdf')),

  -- Markdown body. NULL for kind='pdf'.
  body_md         TEXT,
  -- R2 object key for kind='pdf' (and for any future binary kind).
  r2_key          TEXT,
  -- Text pulled out of a PDF so search covers it. NULL until extraction runs.
  extracted_text  TEXT,
  byte_size       INTEGER NOT NULL DEFAULT 0,
  -- SHA-256 (hex) of the exact bytes: body_md for markdown, object for pdf.
  -- This is what a signature commits to, so it must never be recomputed
  -- from a re-serialization — hash what was stored.
  content_hash    TEXT NOT NULL DEFAULT '',
  -- YAML frontmatter preserved as JSON. Round-trips Obsidian properties.
  frontmatter     TEXT NOT NULL DEFAULT '{}',

  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'archived', 'deleted')),
  -- internal: staff only. link: anyone holding a grant token. public: world.
  visibility      TEXT NOT NULL DEFAULT 'internal'
                    CHECK (visibility IN ('internal', 'link', 'public')),

  source_system   TEXT NOT NULL DEFAULT 'native'
                    CHECK (source_system IN ('native', 'core', 'obsidian', 'meet')),
  -- 'newsletter_issue' | 'report' | 'research' | 'methodology' | 'work'
  -- | 'signals_brief' | 'faq' | 'note' | 'vault' | 'meeting'
  source_kind     TEXT,
  source_id       TEXT,
  source_url      TEXT,
  source_hash     TEXT,
  source_synced_at TEXT,
  -- 0 for mirrored bodies. Annotations and grants stay writable regardless.
  editable        INTEGER NOT NULL DEFAULT 1,

  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by      TEXT,
  updated_by      TEXT,
  -- Who last touched it: a person, or a named agent.
  updated_by_kind TEXT NOT NULL DEFAULT 'human'
                    CHECK (updated_by_kind IN ('human', 'agent', 'system')),

  UNIQUE (folder_id, slug)
);

-- One row per upstream object. Re-running a mirror sync updates in place.
CREATE UNIQUE INDEX idx_documents_source
  ON documents(source_system, source_kind, source_id)
  WHERE source_id IS NOT NULL;

CREATE INDEX idx_documents_folder  ON documents(folder_id, title);
CREATE INDEX idx_documents_updated ON documents(updated_at DESC);
CREATE INDEX idx_documents_status  ON documents(status) WHERE status <> 'active';
CREATE INDEX idx_documents_kind    ON documents(kind);

-- ---------------------------------------------------------------------------
-- Version history
-- ---------------------------------------------------------------------------

CREATE TABLE document_versions (
  id            TEXT PRIMARY KEY,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  title         TEXT NOT NULL,
  body_md       TEXT,
  r2_key        TEXT,
  content_hash  TEXT NOT NULL,
  byte_size     INTEGER NOT NULL DEFAULT 0,
  author        TEXT,
  author_kind   TEXT NOT NULL DEFAULT 'human'
                  CHECK (author_kind IN ('human', 'agent', 'system')),
  -- Free-text commit message. Agents are expected to fill this.
  message       TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (document_id, version)
);

CREATE INDEX idx_versions_document ON document_versions(document_id, version DESC);

-- ---------------------------------------------------------------------------
-- Graph: wikilinks and tags
-- ---------------------------------------------------------------------------

CREATE TABLE document_links (
  id           TEXT PRIMARY KEY,
  from_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- NULL while unresolved: the vault is full of links to notes that do not
  -- exist yet, and those are signal, not corruption.
  to_id        TEXT REFERENCES documents(id) ON DELETE SET NULL,
  target_text  TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'wikilink'
                 CHECK (kind IN ('wikilink', 'markdown', 'url')),
  UNIQUE (from_id, target_text, kind)
);

CREATE INDEX idx_links_to     ON document_links(to_id) WHERE to_id IS NOT NULL;
CREATE INDEX idx_links_target ON document_links(target_text);

CREATE TABLE document_tags (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag         TEXT NOT NULL,
  PRIMARY KEY (document_id, tag)
);

CREATE INDEX idx_tags_tag ON document_tags(tag);

-- ---------------------------------------------------------------------------
-- Full-text search
-- ---------------------------------------------------------------------------

CREATE VIRTUAL TABLE documents_fts USING fts5(
  title,
  body,
  path,
  document_id UNINDEXED,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER trg_documents_fts_insert AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts (rowid, title, body, path, document_id)
  VALUES (
    new.rowid,
    new.title,
    COALESCE(new.body_md, new.extracted_text, ''),
    new.path,
    new.id
  );
END;

CREATE TRIGGER trg_documents_fts_delete AFTER DELETE ON documents BEGIN
  DELETE FROM documents_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER trg_documents_fts_update AFTER UPDATE ON documents BEGIN
  DELETE FROM documents_fts WHERE rowid = old.rowid;
  INSERT INTO documents_fts (rowid, title, body, path, document_id)
  VALUES (
    new.rowid,
    new.title,
    COALESCE(new.body_md, new.extracted_text, ''),
    new.path,
    new.id
  );
END;

-- ---------------------------------------------------------------------------
-- Sharing: capability grants for people without an Envisioning account
-- ---------------------------------------------------------------------------

CREATE TABLE grants (
  id            TEXT PRIMARY KEY,
  document_id   TEXT REFERENCES documents(id) ON DELETE CASCADE,
  folder_id     TEXT REFERENCES folders(id) ON DELETE CASCADE,
  -- The share token. Long, random, and the only thing standing between a
  -- stranger and the document — treat every route that reads it as public.
  token         TEXT NOT NULL UNIQUE,
  -- NULL = anyone holding the link (still gated on entering *some* email).
  -- Set = only this address may claim the grant.
  email         TEXT,
  role          TEXT NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('viewer', 'commenter', 'signer')),
  -- Signers must prove the address with a mailed code; viewers normally need
  -- only to state one (matching how www/private/docs behaves today).
  require_verification INTEGER NOT NULL DEFAULT 0,
  label         TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at    TEXT,
  revoked_at    TEXT,
  last_used_at  TEXT,
  use_count     INTEGER NOT NULL DEFAULT 0,
  CHECK (document_id IS NOT NULL OR folder_id IS NOT NULL)
);

CREATE INDEX idx_grants_document ON grants(document_id) WHERE document_id IS NOT NULL;
CREATE INDEX idx_grants_folder   ON grants(folder_id) WHERE folder_id IS NOT NULL;
CREATE INDEX idx_grants_email    ON grants(email) WHERE email IS NOT NULL;

-- Short-lived email verification codes for grants that require them.
CREATE TABLE verification_codes (
  id          TEXT PRIMARY KEY,
  grant_id    TEXT NOT NULL REFERENCES grants(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT NOT NULL,
  consumed_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_verification_grant ON verification_codes(grant_id, email);

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------

CREATE TABLE access_events (
  id          TEXT PRIMARY KEY,
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  grant_id    TEXT REFERENCES grants(id) ON DELETE SET NULL,
  actor       TEXT,
  actor_kind  TEXT NOT NULL DEFAULT 'guest'
                CHECK (actor_kind IN ('staff', 'guest', 'agent', 'system')),
  kind        TEXT NOT NULL
                CHECK (kind IN ('view', 'download', 'annotate', 'sign', 'decline', 'edit', 'share')),
  ip          TEXT,
  user_agent  TEXT,
  referrer    TEXT,
  timezone    TEXT,
  language    TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_access_document ON access_events(document_id, created_at DESC);
CREATE INDEX idx_access_actor    ON access_events(actor, created_at DESC);

-- ---------------------------------------------------------------------------
-- Annotations and feedback
-- ---------------------------------------------------------------------------

CREATE TABLE annotations (
  id           TEXT PRIMARY KEY,
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- Version the comment was made against, so stale anchors are detectable.
  document_version INTEGER NOT NULL DEFAULT 1,
  -- Root of the thread; a root annotation points at itself.
  thread_id    TEXT NOT NULL,
  parent_id    TEXT REFERENCES annotations(id) ON DELETE CASCADE,
  author       TEXT NOT NULL,
  author_name  TEXT,
  author_kind  TEXT NOT NULL DEFAULT 'guest'
                 CHECK (author_kind IN ('staff', 'guest', 'agent')),
  body_md      TEXT NOT NULL,
  -- W3C-style selector as JSON. NULL means document-level feedback.
  --   markdown: {"type":"text","quote":"…","prefix":"…","suffix":"…"}
  --   pdf:      {"type":"pdf","page":3,"rects":[[x,y,w,h]],"quote":"…"}
  anchor       TEXT,
  status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'resolved')),
  resolved_by  TEXT,
  resolved_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at   TEXT
);

CREATE INDEX idx_annotations_document ON annotations(document_id, created_at);
CREATE INDEX idx_annotations_thread   ON annotations(thread_id, created_at);
CREATE INDEX idx_annotations_open     ON annotations(document_id, status) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- Signatures
-- ---------------------------------------------------------------------------

CREATE TABLE signature_requests (
  id                TEXT PRIMARY KEY,
  document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  -- Frozen at request time. The parties sign these exact bytes; if the
  -- document moves on, the request is invalidated rather than silently
  -- re-pointed.
  document_version  INTEGER NOT NULL,
  content_hash      TEXT NOT NULL,
  requested_by      TEXT NOT NULL,
  subject           TEXT,
  message           TEXT,
  -- 1 = parties sign in `sequence` order; 0 = all at once.
  ordered           INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'completed', 'declined', 'cancelled', 'expired')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at        TEXT,
  completed_at      TEXT
);

CREATE INDEX idx_sigreq_document ON signature_requests(document_id, created_at DESC);
CREATE INDEX idx_sigreq_status   ON signature_requests(status) WHERE status = 'pending';

CREATE TABLE signature_parties (
  id          TEXT PRIMARY KEY,
  request_id  TEXT NOT NULL REFERENCES signature_requests(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  name        TEXT,
  role        TEXT NOT NULL DEFAULT 'signer'
                CHECK (role IN ('signer', 'approver', 'cc')),
  sequence    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'viewed', 'signed', 'declined')),
  grant_id    TEXT REFERENCES grants(id) ON DELETE SET NULL,
  viewed_at   TEXT,
  signed_at   TEXT,
  declined_at TEXT,
  decline_reason TEXT,
  UNIQUE (request_id, email)
);

CREATE INDEX idx_parties_request ON signature_parties(request_id, sequence);

-- Append-only. Nothing in the application ever updates or deletes a row here;
-- a mistaken signature is voided by cancelling the request, not by editing
-- the evidence.
CREATE TABLE signatures (
  id                TEXT PRIMARY KEY,
  request_id        TEXT NOT NULL REFERENCES signature_requests(id) ON DELETE RESTRICT,
  party_id          TEXT NOT NULL REFERENCES signature_parties(id) ON DELETE RESTRICT,
  document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  document_version  INTEGER NOT NULL,
  -- SHA-256 of the exact bytes shown to the signer.
  content_hash      TEXT NOT NULL,
  signer_email      TEXT NOT NULL,
  signer_name       TEXT NOT NULL,
  method            TEXT NOT NULL CHECK (method IN ('typed', 'drawn')),
  typed_text        TEXT,
  signature_r2_key  TEXT,
  -- The exact consent sentence rendered above the button, stored verbatim.
  consent_text      TEXT NOT NULL,
  email_verified    INTEGER NOT NULL DEFAULT 0,
  ip                TEXT,
  user_agent        TEXT,
  timezone          TEXT,
  sealed_at         TEXT NOT NULL,
  -- HMAC-SHA256 over the canonical record. Detects post-hoc tampering with
  -- any column above, including sealed_at.
  seal              TEXT NOT NULL
);

CREATE INDEX idx_signatures_request  ON signatures(request_id);
CREATE INDEX idx_signatures_document ON signatures(document_id, sealed_at);

-- ---------------------------------------------------------------------------
-- Agent / CLI access tokens
-- ---------------------------------------------------------------------------

CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  -- Displayed prefix so a token is recognizable in a list without storing it.
  prefix       TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  owner        TEXT NOT NULL,
  -- JSON array: ["docs:read","docs:write","annotations:write","sign:manage"]
  scopes       TEXT NOT NULL DEFAULT '[]',
  -- Optional path prefix the token is confined to, e.g. '/agents/hermes'.
  path_prefix  TEXT,
  agent_name   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT
);

CREATE INDEX idx_tokens_owner ON api_tokens(owner) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Mirror bookkeeping — one row per upstream surface we project into Docs.
-- ---------------------------------------------------------------------------

CREATE TABLE sync_state (
  source_key      TEXT PRIMARY KEY,
  last_run_at     TEXT,
  last_cursor     TEXT,
  last_status     TEXT,
  documents_seen  INTEGER NOT NULL DEFAULT 0,
  documents_written INTEGER NOT NULL DEFAULT 0,
  error           TEXT
);
