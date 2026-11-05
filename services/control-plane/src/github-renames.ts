// A renamed GitHub repository keeps everything filed under its old name
//. Tables store a repository as `owner/repo`; GitHub's numeric id
// is the only name that survives a rename. `github_repositories` holds the
// id with the last name seen. When the App's list reports a known id under a
// new name, every stored `owner/repo` is rewritten in one batch.
//
// Not rewritten here: thread messages in Durable Objects (history; GitHub
// redirects the old links) and Core's `project_github_repos`, which Core's
// webhook matches by name. On a Core workspace that row is rewritten in Core
// at rename time.
import type { GithubRepository } from './github-app';

export interface RepoName {
  owner: string;
  repo: string;
}

/**
 * Rewrite every stored `from` to `to`. Rows keyed by name use `UPDATE OR
 * IGNORE`: when a row under the new name exists already (a sync that ran on
 * the new name first), the new row wins and the old one is deleted.
 */
export async function renameStoredGithubRepo(env: Env, from: RepoName, to: RepoName): Promise<void> {
  const fromName = `${from.owner}/${from.repo}`;
  const toName = `${to.owner}/${to.repo}`;
  const fromRef = `${fromName}#`;
  const toRef = `${toName}#`;
  const db = env.USAGE;
  await db.batch([
    db.prepare(`UPDATE OR IGNORE import_mappings SET external_id = ?2 WHERE source IN ('github', 'github-issues') AND external_id = ?1`).bind(fromName, toName),
    db.prepare(`DELETE FROM import_mappings WHERE source IN ('github', 'github-issues') AND external_id = ?1`).bind(fromName),
    db.prepare(`UPDATE OR IGNORE import_items SET external_id = ?2 WHERE source IN ('github', 'github-issues') AND external_id = ?1`).bind(fromName, toName),
    db.prepare(`DELETE FROM import_items WHERE source IN ('github', 'github-issues') AND external_id = ?1`).bind(fromName),
    db.prepare(
      `UPDATE OR IGNORE github_pulls SET owner = ?3, repo = ?4, id = ?5 || number, url = replace(url, '/' || ?6 || '/', '/' || ?7 || '/')
        WHERE owner = ?1 AND repo = ?2`,
    ).bind(from.owner, from.repo, to.owner, to.repo, toRef, fromName, toName),
    db.prepare(`DELETE FROM github_pulls WHERE owner = ?1 AND repo = ?2`).bind(from.owner, from.repo),
    db.prepare(`UPDATE OR IGNORE project_github_repos SET owner = ?3, repo = ?4 WHERE owner = ?1 AND repo = ?2`).bind(from.owner, from.repo, to.owner, to.repo),
    db.prepare(`DELETE FROM project_github_repos WHERE owner = ?1 AND repo = ?2`).bind(from.owner, from.repo),
    db.prepare(`UPDATE tasks SET github_owner = ?3, github_repo = ?4 WHERE github_owner = ?1 AND github_repo = ?2`).bind(from.owner, from.repo, to.owner, to.repo),
    // Issue refs (`owner/repo#12`). `instr`, not LIKE: `_` in a name is a LIKE wildcard.
    db.prepare(`UPDATE OR IGNORE card_trace SET ref_id = ?2 || substr(ref_id, ?3) WHERE ref_kind = 'issue' AND instr(ref_id, ?1) = 1`).bind(fromRef, toRef, fromRef.length + 1),
    db.prepare(`DELETE FROM card_trace WHERE ref_kind = 'issue' AND instr(ref_id, ?1) = 1`).bind(fromRef),
    db.prepare(`UPDATE OR IGNORE card_holds SET ref_id = ?2 || substr(ref_id, ?3) WHERE ref_kind = 'issue' AND instr(ref_id, ?1) = 1`).bind(fromRef, toRef, fromRef.length + 1),
    db.prepare(`DELETE FROM card_holds WHERE ref_kind = 'issue' AND instr(ref_id, ?1) = 1`).bind(fromRef),
    db.prepare(`UPDATE OR IGNORE favorites SET target_ref = replace(target_ref, ?1, ?2) WHERE instr(target_ref, ?1) > 0`).bind(fromRef, toRef),
    db.prepare(`DELETE FROM favorites WHERE instr(target_ref, ?1) > 0`).bind(fromRef),
    db.prepare(`UPDATE OR IGNORE inbox_dismissed SET key = replace(key, ?1, ?2) WHERE instr(key, ?1) > 0`).bind(fromRef, toRef),
    db.prepare(`DELETE FROM inbox_dismissed WHERE instr(key, ?1) > 0`).bind(fromRef),
  ]);
}

/**
 * Record each repository's id and current name; rewrite stored names for any
 * id GitHub now reports under a new name. Returns the renames it applied.
 */
export async function noteGithubRepositories(env: Env, repos: GithubRepository[], now = Date.now()): Promise<Array<{ from: RepoName; to: RepoName }>> {
  const renamed: Array<{ from: RepoName; to: RepoName }> = [];
  if (repos.length === 0) return renamed;
  const { results } = await env.USAGE.prepare('SELECT repo_id, owner, repo FROM github_repositories').all<{ repo_id: number; owner: string; repo: string }>();
  const known = new Map(results.map((row) => [row.repo_id, row]));
  for (const repository of repos) {
    if (typeof repository.id !== 'number') continue;
    const to = { owner: repository.owner.login, repo: repository.name };
    const before = known.get(repository.id);
    if (before && (before.owner !== to.owner || before.repo !== to.repo)) {
      const from = { owner: before.owner, repo: before.repo };
      await renameStoredGithubRepo(env, from, to);
      renamed.push({ from, to });
      console.log(JSON.stringify({
        level: 'info',
        message: 'github.repo.renamed',
        timestamp: new Date(now).toISOString(),
        repo_id: repository.id,
        from: `${from.owner}/${from.repo}`,
        to: `${to.owner}/${to.repo}`,
      }));
    }
  }
  // Write only what changed: a new id, or a known id under a new name. A
  // name freed by a rename and taken by another repository moves to that id.
  const changed = repos.filter((repository) => {
    if (typeof repository.id !== 'number') return false;
    const before = known.get(repository.id);
    return !before || before.owner !== repository.owner.login || before.repo !== repository.name;
  });
  if (changed.length) {
    await env.USAGE.batch(changed.flatMap((repository) => [
      env.USAGE.prepare('DELETE FROM github_repositories WHERE owner = ?1 AND repo = ?2 AND repo_id != ?3')
        .bind(repository.owner.login, repository.name, repository.id),
      env.USAGE.prepare(
        `INSERT INTO github_repositories (repo_id, owner, repo, seen_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (repo_id) DO UPDATE SET owner = excluded.owner, repo = excluded.repo, seen_at = excluded.seen_at`,
      ).bind(repository.id, repository.owner.login, repository.name, now),
    ]));
  }
  return renamed;
}
