/**
 * When the code a doc owns last changed — the freshness half of the docs
 * gate, shared by `check-docs.mjs` (every doc) and `check-docs-staged.mjs`
 * (the pre-commit hook, only the docs a commit touches).
 *
 * An `owns` entry is a path, or `path#Symbol` for one function or type in
 * it: `web/src/App.tsx#RoomEntry`. The symbol form asks git for the last
 * commit that touched that definition's lines (`git log -L :Symbol:path`),
 * so a page that owns one component of a 2000-line file goes stale only
 * when that component moves. git finds the symbol the way `diff` does: a
 * line starting in column 0 that contains the name.
 *
 * A change not yet committed counts as today (2026-09-30). The check used to
 * read commit dates only, so `pnpm verify` passed on a working tree whose
 * docs went stale the moment it was committed, and main went red four times
 * in one day.
 *
 * A commit counts on its author date, not its commit date (2026-10-08). The
 * land queue rebases each ship branch onto main, and a rebase sets the commit
 * date to the day it runs. A branch committed one day and landed the next
 * then failed the gate on every doc it had verified the day before. The
 * author date stays the day the code and its doc changed together.
 */
import { execFileSync } from 'node:child_process';

export function splitOwns(entry) {
  const hash = entry.indexOf('#');
  return hash === -1 ? { path: entry, symbol: null } : { path: entry.slice(0, hash), symbol: entry.slice(hash + 1) };
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Today in the local zone, as `%as` writes an author date. */
export function today() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Paths that differ from HEAD: staged, unstaged or untracked. */
export function uncommittedPaths(repoRoot) {
  const out = git(repoRoot, ['status', '--porcelain', '--untracked-files=all']);
  return new Set(out.split('\n').filter(Boolean).map((line) => line.slice(3).split(' -> ').pop()));
}

/** Paths staged for the next commit. */
export function stagedPaths(repoRoot) {
  return new Set(git(repoRoot, ['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split('\n').filter(Boolean));
}

/**
 * Whether an uncommitted change to `path` touches `symbol`: a changed line,
 * or a hunk header's function context, names it. `staged` reads the index
 * against HEAD; otherwise the working tree.
 */
export function changeTouchesSymbol(repoRoot, path, symbol, staged = false) {
  const args = ['diff', '-U0', ...(staged ? ['--cached'] : ['HEAD']), '--', path];
  const name = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u');
  return git(repoRoot, args).split('\n').some((line) =>
    (line.startsWith('@@') || ((line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---')))
    && name.test(line));
}

/** Whether `paths` holds `owned` or, for a directory entry, a path under it. */
export function includesOwned(paths, owned) {
  const dir = owned.endsWith('/') ? owned : `${owned}/`;
  for (const path of paths) if (path === owned || path.startsWith(dir)) return true;
  return false;
}

export function lastCommitDate(repoRoot, entry) {
  const { path, symbol } = splitOwns(entry);
  const args = symbol
    ? ['log', '-1', '--format=%as', '--no-patch', `-L:${symbol}:${path}`]
    : ['log', '-1', '--format=%as', '--', path];
  const out = git(repoRoot, args).trim();
  return out === '' ? null : out;
}

/**
 * The date an `owns` entry last changed: today when the change is not
 * committed yet, else its last commit.
 */
export function lastChangeDate(repoRoot, entry, pending) {
  const { path, symbol } = splitOwns(entry);
  if (includesOwned(pending, path) && (!symbol || changeTouchesSymbol(repoRoot, path, symbol))) return today();
  return lastCommitDate(repoRoot, entry);
}
