-- GitHub's numeric id for each repository the App has seen, with the name it
-- had then (meet#798). Every other table stores a repository as `owner/repo`.
-- When GitHub reports a known id under a new name, `github-renames.ts`
-- rewrites those tables, so a renamed repository keeps its subject, its pulls
-- and its card history. Rows fill from the App's repository list; the first
-- connector list or hourly pass after this migration records every id.
CREATE TABLE github_repositories (
  repo_id  INTEGER PRIMARY KEY,
  owner    TEXT NOT NULL,
  repo     TEXT NOT NULL,
  seen_at  INTEGER NOT NULL   -- when this name was first recorded for the id
);
CREATE UNIQUE INDEX github_repositories_name ON github_repositories (owner, repo);
