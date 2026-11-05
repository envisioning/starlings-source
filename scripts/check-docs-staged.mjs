#!/usr/bin/env node
/**
 * The docs freshness gate for one commit, fast enough for the pre-commit
 * hook (`check-docs.mjs` reads every doc's history and takes ~30 s).
 *
 * For each doc that owns a staged path, the doc's `verified` date as staged
 * must be today or later once the commit lands. A staged `path#Symbol`
 * counts only when the staged diff touches that symbol. Without this, a
 * commit made after `pnpm verify` passed on the working tree could still turn
 * main red: the full check reads commit dates, and the commit is the change.
 *
 *   node scripts/check-docs-staged.mjs
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listDocs } from './docs-frontmatter.mjs';
import { readFrontmatter } from './docs-frontmatter-parse.mjs';
import { changeTouchesSymbol, includesOwned, splitOwns, stagedPaths, today } from './docs-freshness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const staged = stagedPaths(repoRoot);
if (staged.size === 0) process.exit(0);

/** The doc as it will be committed: the index, or the tree when unstaged. */
function stagedText(path) {
  try {
    return execFileSync('git', ['show', `:${path}`], { cwd: repoRoot, encoding: 'utf8' });
  } catch {
    return null;
  }
}

const date = today();
const stale = [];
for (const path of listDocs(repoRoot)) {
  const text = stagedText(path);
  if (!text) continue;
  const { fields } = readFrontmatter(text);
  if (!fields?.verified || fields.verified >= date) continue;
  const touched = (fields.owns ?? []).filter((entry) => {
    const { path: owned, symbol } = splitOwns(entry);
    return includesOwned(staged, owned) && (!symbol || changeTouchesSymbol(repoRoot, owned, symbol, true));
  });
  if (touched.length > 0) stale.push(`${path}: verified ${fields.verified}, but this commit changes ${touched.join(', ')}`);
}

if (stale.length > 0) {
  for (const line of stale) console.error(line);
  console.error('');
  console.error('  Read each doc against the change, then move its `verified` to today');
  console.error('  (or edit the doc), and stage it. Main goes red otherwise.');
  process.exit(1);
}
