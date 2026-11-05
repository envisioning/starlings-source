#!/usr/bin/env node
// Size and change hot spots for one committed ref.
//
//   pnpm hotspots [--ref <ref>] [--days <n>] [--bug-commits <sha,sha,…>] [--json <path>]
//
// Read-only: it reads committed blobs and history through git, never the
// working tree, so a dirty checkout reports the same numbers for the same
// ref. It prints a summary; `--json` also writes the full report to a path
// outside the repository. No network, no GitHub API, no score: change
// frequency and churn are reported side by side, never combined. See
// docs/agents/code-hotspots.md for the rules and their limits.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const IMPLEMENTATION_EXTENSIONS = new Set([
  '.swift', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.sh', '.py', '.css', '.sql', '.html',
]);

/** Paths that are never counted: dependencies and build outputs. */
const EXCLUDED = [/(^|\/)node_modules\//u, /(^|\/)dist\//u, /(^|\/)DerivedData\//u, /(^|\/)\.build\//u, /(^|\/)build\//u, /^pnpm-lock\.yaml$/u];

/** Written by a tool, not a person: the generators' outputs and their snapshots. */
const GENERATED = [
  /^Sources\/Generated\//u,
  /^packages\/contracts\/swift\//u,
  /^packages\/contracts\/schema\//u,
  /\.xcodeproj\//u,
  /^CHANGELOG\.md$/u,
  /^web\/public\/openapi\.json$/u,
  /^web\/src\/i18n\/[^/]+\.json$/u,
  /\.xcstrings$/u,
];

const TESTS = [/(^|\/)tests?\//u, /^Tests\//u, /^iOSTests\//u, /\.test\.[cm]?[jt]sx?$/u, /Tests?\.swift$/u];

/** One class per path, in this order: excluded, generated, tests, docs, implementation, data. */
export function classify(file) {
  if (EXCLUDED.some((rule) => rule.test(file))) return 'excluded';
  if (GENERATED.some((rule) => rule.test(file))) return 'generated';
  if (TESTS.some((rule) => rule.test(file))) return 'tests';
  if (file.endsWith('.md') || file.startsWith('docs/')) return 'docs';
  if (IMPLEMENTATION_EXTENSIONS.has(path.extname(file))) return 'implementation';
  return 'data';
}

function git(cwd, args, input) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30, input });
}

/** Physical lines of every file at `ref`, by path. Blank and comment lines count. */
export function sizeAt(cwd, ref) {
  const entries = git(cwd, ['ls-tree', '-r', '--full-tree', ref])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta, file] = line.split('\t');
      const [, type, sha] = meta.split(' ');
      return { file, type, sha };
    })
    .filter((entry) => entry.type === 'blob' && classify(entry.file) !== 'excluded');
  const lines = new Map();
  if (entries.length === 0) return lines;
  // One cat-file pass for every blob; a blob's line count is its newlines,
  // plus one when it does not end in one.
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd,
    input: entries.map((entry) => entry.sha).join('\n') + '\n',
    maxBuffer: 1 << 30,
  });
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = out.indexOf(0x0a, offset);
    const size = Number(out.subarray(offset, headerEnd).toString('utf8').split(' ')[2]);
    const body = out.subarray(headerEnd + 1, headerEnd + 1 + size);
    let count = 0;
    for (const byte of body) if (byte === 0x0a) count += 1;
    if (size > 0 && body[size - 1] !== 0x0a) count += 1;
    lines.set(entry.file, count);
    offset = headerEnd + 1 + size + 1;
  }
  return lines;
}

/** `src/{a => b}/x.ts` and `a.ts => b.ts`, the two numstat rename spellings. */
export function renamedPaths(spec) {
  const braces = spec.match(/^(.*)\{(.*) => (.*)\}(.*)$/u);
  if (braces) {
    const [, head, from, to, tail] = braces;
    const join = (middle) => `${head}${middle}${tail}`.replace(/\/\//gu, '/');
    return { from: join(from), to: join(to) };
  }
  const plain = spec.match(/^(.*) => (.*)$/u);
  return plain ? { from: plain[1], to: plain[2] } : null;
}

/**
 * Commits in the `days` before `ref`'s own commit time, with their numstat.
 * The window hangs off the ref, not off today, so a rerun is the same report.
 */
export function historyBefore(cwd, ref, days) {
  const end = Number(git(cwd, ['log', '-1', '--format=%ct', ref]).trim());
  const start = end - days * 24 * 60 * 60;
  const raw = git(cwd, ['log', '--numstat', '-M', '--format=\u0001%H %ct', `--since=${new Date(start * 1000).toISOString()}`, ref]);
  const commits = [];
  for (const block of raw.split('\u0001').filter(Boolean)) {
    const [head, ...rows] = block.split('\n');
    const [sha, time] = head.split(' ');
    if (Number(time) < start) continue;
    const files = [];
    for (const row of rows.filter(Boolean)) {
      const [added, deleted, spec] = row.split('\t');
      const rename = renamedPaths(spec);
      files.push({
        file: rename ? rename.to : spec,
        renamedFrom: rename ? rename.from : null,
        // A binary file reports "-": no lines changed that a line count can see.
        added: added === '-' ? 0 : Number(added),
        deleted: deleted === '-' ? 0 : Number(deleted),
      });
    }
    commits.push({ sha, time: Number(time), files });
  }
  return { start, end, commits };
}

const byPath = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

/** The whole report as a plain object. Every list has a fixed order. */
export function report(cwd, { ref = 'HEAD', days = 30, bugCommits = [] } = {}) {
  const resolved = git(cwd, ['rev-parse', ref]).trim();
  const shallow = git(cwd, ['rev-parse', '--is-shallow-repository']).trim() === 'true';
  const lines = sizeAt(cwd, resolved);
  const totals = { implementation: 0, tests: 0, generated: 0, docs: 0, data: 0 };
  const files = { implementation: 0, tests: 0, generated: 0, docs: 0, data: 0 };
  for (const [file, count] of lines) {
    const kind = classify(file);
    totals[kind] += count;
    files[kind] += 1;
  }

  const history = historyBefore(cwd, resolved, days);
  const bugs = new Set(bugCommits.map((sha) => sha.toLowerCase()));
  const touched = new Map();
  const renames = [];
  for (const commit of history.commits) {
    const isBug = [...bugs].some((sha) => commit.sha.startsWith(sha));
    for (const change of commit.files) {
      if (change.renamedFrom) renames.push({ from: change.renamedFrom, to: change.file, commit: commit.sha });
      const kind = classify(change.file);
      if (kind !== 'implementation' && kind !== 'tests') continue;
      const row = touched.get(change.file) ?? { file: change.file, kind, commits: 0, added: 0, deleted: 0, bugFixCommits: 0 };
      row.commits += 1;
      row.added += change.added;
      row.deleted += change.deleted;
      if (isBug) row.bugFixCommits += 1;
      touched.set(change.file, row);
    }
  }
  // Only files that exist at the ref: a file deleted in the window has no size to report.
  const authored = [...touched.values()]
    .filter((row) => lines.has(row.file))
    .map((row) => ({ ...row, lines: lines.get(row.file), churn: row.added + row.deleted }))
    .sort(byPath);
  const top = (key) => [...authored].sort((a, b) => b[key] - a[key] || byPath(a, b)).slice(0, 20);
  renames.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) || (a.commit < b.commit ? -1 : 1));

  return {
    ref: resolved,
    window: {
      days,
      from: new Date(history.start * 1000).toISOString(),
      to: new Date(history.end * 1000).toISOString(),
      commits: history.commits.length,
      // Shallow history is a partial window: say so rather than report it as whole.
      complete: !shallow,
    },
    lines: totals,
    files,
    bugFixCommitsGiven: bugs.size,
    topByCommits: top('commits'),
    topByChurn: top('churn'),
    renames,
    authored,
  };
}

function summary(result) {
  const out = [];
  out.push(`ref ${result.ref.slice(0, 12)} · window ${result.window.days} days (${result.window.from.slice(0, 10)} to ${result.window.to.slice(0, 10)}), ${result.window.commits} commits${result.window.complete ? '' : ' · INCOMPLETE: shallow history'}`);
  out.push('physical lines (comments and blanks included):');
  for (const kind of Object.keys(result.lines)) out.push(`  ${kind.padEnd(15)} ${String(result.lines[kind]).padStart(8)} in ${result.files[kind]} files`);
  const table = (title, rows, key) => {
    out.push(`top ${rows.length} by ${title}:`);
    for (const row of rows) {
      const bug = result.bugFixCommitsGiven > 0 ? ` · bug-fix commits ${row.bugFixCommits}` : '';
      out.push(`  ${String(row[key]).padStart(6)}  ${row.file} (${row.lines} lines, ${row.commits} commits, +${row.added} −${row.deleted}${bug})`);
    }
  };
  table('change frequency', result.topByCommits, 'commits');
  table('churn (added + deleted)', result.topByChurn, 'churn');
  out.push(`renames in the window: ${result.renames.length}`);
  return out.join('\n');
}

function parseArgs(argv) {
  const options = { ref: 'HEAD', days: 30, bugCommits: [], json: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--ref') { options.ref = value; index += 1; }
    else if (flag === '--days') { options.days = Number(value); index += 1; }
    else if (flag === '--bug-commits') { options.bugCommits = value.split(',').map((sha) => sha.trim()).filter(Boolean); index += 1; }
    else if (flag === '--json') { options.json = value; index += 1; }
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!Number.isInteger(options.days) || options.days < 1) throw new Error('--days takes a whole number of days, 1 or more.');
  return options;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const result = report(root, options);
  console.log(summary(result));
  if (options.json) {
    const target = path.resolve(options.json);
    // The report never writes into the repository it reads.
    if (target === root || target.startsWith(`${root}${path.sep}`)) {
      throw new Error('--json must point outside the repository.');
    }
    writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`wrote ${target}`);
  }
}
