/**
 * A repository renamed on GitHub keeps what was filed under its old name
 * (meet#798): the id recorded first, then the same id under a new name
 * rewrites every stored `owner/repo`.
 */
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { GithubRepository } from '../src/github-app';
import { noteGithubRepositories } from '../src/github-renames';

const db = env.USAGE;

function repository(id: number, owner: string, name: string): GithubRepository {
  return {
    id, name, full_name: `${owner}/${name}`, owner: { login: owner },
    description: null, private: true, archived: false, pushed_at: null, open_issues_count: 0,
  };
}

async function seedOldName(): Promise<void> {
  await db.batch([
    db.prepare(`INSERT INTO import_mappings (source, external_id, subject_kind, subject_id, subject_title, decided_by, decided_at)
                VALUES ('github', 'envisioning/meet', 'project', 'p1', 'Product', 'a@x.test', 1)`),
    db.prepare(`INSERT INTO import_items (source, external_id, status, cursor, count) VALUES ('github', 'envisioning/meet', 'synced', '2026-10-01', 1)`),
    db.prepare(`INSERT INTO import_items (source, external_id, status) VALUES ('github-issues', 'envisioning/meet', 'synced')`),
    db.prepare(`INSERT INTO github_pulls (id, owner, repo, number, title, url, state, review, checks, synced_at)
                VALUES ('envisioning/meet#7', 'envisioning', 'meet', 7, 'A pull', 'https://github.com/envisioning/meet/pull/7', 'open', 'none', 'none', 1)`),
    db.prepare(`INSERT INTO card_trace (ref_kind, ref_id, thread_id, message_id, text, at) VALUES ('issue', 'envisioning/meet#12', 't', 'm', 'filed', 1)`),
    db.prepare(`INSERT INTO card_trace (ref_kind, ref_id, thread_id, message_id, text, at) VALUES ('issue', 'envisioning/meetings#3', 't', 'm', 'filed', 1)`),
    db.prepare(`INSERT INTO favorites (person_id, kind, target_ref, created_at) VALUES ('person-1', 'issue', 'envisioning/meet#12', 1)`),
  ]);
}

describe('noteGithubRepositories', () => {
  beforeEach(async () => {
    await db.batch(['github_repositories', 'import_mappings', 'import_items', 'github_pulls', 'card_trace', 'favorites']
      .map((table) => db.prepare(`DELETE FROM ${table}`)));
  });

  it('records a new id and rewrites nothing', async () => {
    await seedOldName();
    expect(await noteGithubRepositories(env as Env, [repository(42, 'envisioning', 'meet')])).toEqual([]);
    const row = await db.prepare('SELECT owner, repo FROM github_repositories WHERE repo_id = 42').first();
    expect(row).toEqual({ owner: 'envisioning', repo: 'meet' });
  });

  it('moves every stored name when a known id comes back renamed', async () => {
    await seedOldName();
    await noteGithubRepositories(env as Env, [repository(42, 'envisioning', 'meet')]);
    const renamed = await noteGithubRepositories(env as Env, [repository(42, 'envisioning', 'starlings')]);
    expect(renamed).toEqual([{ from: { owner: 'envisioning', repo: 'meet' }, to: { owner: 'envisioning', repo: 'starlings' } }]);

    const mapping = await db.prepare(`SELECT external_id, subject_id FROM import_mappings WHERE source = 'github'`).first();
    expect(mapping).toEqual({ external_id: 'envisioning/starlings', subject_id: 'p1' });
    const items = await db.prepare('SELECT source, external_id, cursor FROM import_items ORDER BY source').all();
    expect(items.results).toEqual([
      { source: 'github', external_id: 'envisioning/starlings', cursor: '2026-10-01' },
      { source: 'github-issues', external_id: 'envisioning/starlings', cursor: null },
    ]);
    const pull = await db.prepare('SELECT id, owner, repo, url FROM github_pulls').first();
    expect(pull).toEqual({ id: 'envisioning/starlings#7', owner: 'envisioning', repo: 'starlings', url: 'https://github.com/envisioning/starlings-source/pull/7' });
    const traces = await db.prepare('SELECT ref_id FROM card_trace ORDER BY ref_id').all();
    // A repository whose name starts with the old one is left alone.
    expect(traces.results).toEqual([{ ref_id: 'envisioning/meetings#3' }, { ref_id: 'envisioning/starlings#12' }]);
    const favorite = await db.prepare('SELECT target_ref FROM favorites').first();
    expect(favorite).toEqual({ target_ref: 'envisioning/starlings#12' });
    const known = await db.prepare('SELECT owner, repo FROM github_repositories WHERE repo_id = 42').first();
    expect(known).toEqual({ owner: 'envisioning', repo: 'starlings' });
  });

  it('keeps the row already written under the new name', async () => {
    await seedOldName();
    await noteGithubRepositories(env as Env, [repository(42, 'envisioning', 'meet')]);
    await db.prepare(`INSERT INTO github_pulls (id, owner, repo, number, title, url, state, review, checks, synced_at)
                      VALUES ('envisioning/starlings#7', 'envisioning', 'starlings', 7, 'Newer', 'https://github.com/envisioning/starlings-source/pull/7', 'merged', 'none', 'none', 2)`).run();
    await noteGithubRepositories(env as Env, [repository(42, 'envisioning', 'starlings')]);
    const pulls = await db.prepare('SELECT id, title FROM github_pulls').all();
    expect(pulls.results).toEqual([{ id: 'envisioning/starlings#7', title: 'Newer' }]);
  });

  it('gives a freed name to the repository that takes it', async () => {
    await noteGithubRepositories(env as Env, [repository(42, 'envisioning', 'meet')]);
    await noteGithubRepositories(env as Env, [repository(42, 'envisioning', 'starlings'), repository(99, 'envisioning', 'meet')]);
    const rows = await db.prepare('SELECT repo_id, repo FROM github_repositories ORDER BY repo_id').all();
    expect(rows.results).toEqual([{ repo_id: 42, repo: 'starlings' }, { repo_id: 99, repo: 'meet' }]);
  });
});
