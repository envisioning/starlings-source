#!/usr/bin/env node
/**
 * Issue references in code comments (AGENTS.md: a code comment says why; it
 * does not cite an issue). Outside the company a `` points nowhere,
 * and the public export strips them. Commit messages and docs may cite
 * issues; this reads code only.
 *
 * Report-only: it prints and exits 0. It is the count to bring down, and the
 * note that says a change adds to it.
 *
 *   node scripts/report-issue-refs.mjs                 the count, by top-level folder
 *   node scripts/report-issue-refs.mjs --list          every reference, file:line
 *   node scripts/report-issue-refs.mjs --added <base>  the references this branch adds since <base>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const CODE = /\.(ts|tsx|js|mjs|cjs|swift|py|sh|css|sql)$/;
// ``, ``, ``, ``.
const REF = /\b(?:[a-z0-9-]+\/)?(?:meet|core|keep|pilot|site|starlings|signals)#\d+/g;
// A comment starts at `//`, `/*`, a leading `*`, a `--` (SQL) or a `#` (shell,
// Python) followed by a space. Only references after that point count.
const COMMENT = /\/\/|\/\*|^\s*\*|--\s|(?:^|\s)#\s/;

/** References in the comment part of one line. */
function refsInLine(line) {
  const start = line.search(COMMENT);
  if (start < 0) return [];
  return [...line.slice(start).matchAll(REF)].map((m) => m[0]);
}

// A block comment opens at a `/*` that starts the line or follows a space or
// `{` (a JSX `{/* … */}`), so a glob such as `src/**/*.ts` in a string does not.
const BLOCK_OPEN = /(?:^|[\s{])\/\*/g;

/** Whether a block comment opened on this line is still open at its end. */
function opensBlock(line) {
  let open = false;
  for (const m of line.matchAll(BLOCK_OPEN)) {
    const at = m.index + m[0].indexOf('/*');
    open = line.indexOf('*/', at + 2) < 0;
  }
  return open;
}

/**
 * References in the comments of consecutive lines. The continuation lines of
 * a multi-line block comment carry no marker of their own, so the scan keeps
 * whether a block is open from one line to the next.
 */
export function refsInLines(lines) {
  const out = [];
  let inBlock = false;
  lines.forEach((line, index) => {
    if (inBlock) {
      const end = line.indexOf('*/');
      const body = end < 0 ? line : line.slice(0, end);
      for (const m of body.matchAll(REF)) out.push({ index, ref: m[0] });
      if (end < 0) return;
      inBlock = false;
      const rest = line.slice(end + 2);
      for (const ref of refsInLine(rest)) out.push({ index, ref });
      inBlock = opensBlock(rest);
      return;
    }
    for (const ref of refsInLine(line)) out.push({ index, ref });
    inBlock = opensBlock(line);
  });
  return out;
}

// Generated files follow their source; a migration that has run is never edited.
const isCode = (path) =>
  CODE.test(path) && !path.includes('/Generated/') && !path.startsWith('web/public/') && !/(^|\/)(auth-)?migrations\//.test(path);

function allRefs() {
  const out = [];
  for (const path of git('ls-files').split('\n').filter(isCode)) {
    let text;
    try { text = readFileSync(join(repoRoot, path), 'utf8'); } catch { continue; }
    for (const { index, ref } of refsInLines(text.split('\n'))) out.push({ path, line: index + 1, ref });
  }
  return out;
}

function addedRefs(base) {
  const diff = git('diff', '--unified=0', '--no-color', base, '--', '.');
  const out = [];
  let path = null;
  let line = 0;
  // A run of added lines is read as one block, so a comment opened in the run
  // counts its continuation lines; one opened above the hunk is not seen.
  let run = [];
  const flush = () => {
    for (const { index, ref } of refsInLines(run.map((r) => r.text))) out.push({ path: run[index].path, line: run[index].line, ref });
    run = [];
  };
  for (const row of diff.split('\n')) {
    if (row.startsWith('+++ ')) { flush(); path = row.slice(4).replace(/^b\//, ''); continue; }
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) { flush(); line = Number(hunk[1]); continue; }
    if (!path || !isCode(path)) continue;
    if (row.startsWith('+')) {
      run.push({ path, line, text: row.slice(1) });
      line += 1;
    } else {
      flush();
    }
  }
  flush();
  return out;
}

// Run as a command; a test imports `refsInLines` alone.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args[0] === '--added') {
    if (!args[1]) { console.error('usage: report-issue-refs.mjs --added <base>'); process.exit(2); }
    const added = addedRefs(args[1]);
    if (added.length) {
      console.log(`issue-refs: this change adds ${added.length} issue reference${added.length === 1 ? '' : 's'} to code comments; say why instead (AGENTS.md):`);
      for (const r of added) console.log(`  ${r.path}:${r.line}: ${r.ref}`);
    }
  } else if (args[0] === '--list') {
    for (const r of allRefs()) console.log(`${r.path}:${r.line}: ${r.ref}`);
  } else if (args.length === 0) {
    const refs = allRefs();
    const byFolder = new Map();
    for (const r of refs) {
      const folder = r.path.includes('/') ? r.path.slice(0, r.path.indexOf('/')) : '.';
      byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1);
    }
    console.log(`issue-refs: ${refs.length} issue references in code comments`);
    for (const [folder, n] of [...byFolder].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${folder}`);
  } else {
    console.error('usage: report-issue-refs.mjs [--list | --added <base>]');
    process.exit(2);
  }
}
