#!/usr/bin/env node
// No new hand-copied list (docs/agents/areas/registries.md).
//
// A list the Mac, iOS and web all draw is one table in packages/contracts/src,
// generated into Swift by scripts/gen-swift-registries.mjs. A hand copy almost
// always carries a comment that says so: "Mirrors …", "keep in step",
// "Same words as …". This check finds those comments and fails on one that is
// not in scripts/mirror-baseline.json.
//
//   node scripts/check-mirrors.mjs           # check (part of verify:fast)
//   node scripts/check-mirrors.mjs --write   # rewrite the baseline from the tree
//
// The baseline is the comments that existed on 2026-10-03. Each entry names an
// issue: a child of for a list still to move to a registry,
// or `rule` for a mirror of behaviour that a case fixture already pins. --write
// keeps those notes, drops entries that are gone, and adds new ones with
// `issue: null`; the check fails on a null. So a new mirror needs a person to
// write why it is not a registry. Never add an entry to get past the check:
// move the list into a registry instead.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const baselinePath = join(root, 'scripts', 'mirror-baseline.json');

const DIRS = ['Sources', 'iOS', 'watchOS', 'iOSActivities', 'iOSShare', 'extension/src', 'CLI', 'web/src', 'services/control-plane/src', 'packages/contracts/src'];
const SKIP = /(^|\/)(Generated|node_modules|dist|build)(\/|$)|Wire\.swift$/;
const EXT = /\.(swift|ts|tsx|js|mjs)$/;

/** The words that mark a hand copy. Matched only inside a comment. */
export const MIRROR = /\b(?:[Mm]irrors?\s|[Mm]irrored by hand|[Kk]eep (?:the two |them |both )?in step|[Kk]ept in step|[Kk]eep [^.]{0,40} aligned with|[Ss]ame (?:words|keys|order|list|line|six|four) as)/;
const COMMENT = /^\s*(?:\/\/|\*|\/\*|\/\/\/)/;

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (SKIP.test(relative(root, path))) continue;
    if (entry.isDirectory()) yield* files(path);
    else if (EXT.test(entry.name) && !/\.test\./.test(entry.name)) yield path;
  }
}

/** Every mirror comment in the tree, as `{ file, text }`. */
export function findMirrors() {
  const found = [];
  for (const dir of DIRS) {
    let paths;
    try { paths = [...files(join(root, dir))]; } catch { continue; }
    for (const path of paths) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (COMMENT.test(line) && MIRROR.test(line)) found.push({ file: relative(root, path), text: line.trim() });
      }
    }
  }
  return found;
}

const key = ({ file, text }) => `${file}\n${text}`;

function main() {
  const write = process.argv.includes('--write');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const known = new Map(baseline.entries.map((entry) => [key(entry), entry]));
  const found = findMirrors();

  if (write) {
    const entries = found.map((hit) => known.get(key(hit)) ?? { ...hit, issue: null });
    entries.sort((a, b) => a.file.localeCompare(b.file) || a.text.localeCompare(b.text));
    writeFileSync(baselinePath, `${JSON.stringify({ ...baseline, entries }, null, 2)}\n`);
    console.log(`check-mirrors: ${entries.length} entries, ${entries.filter((entry) => entry.issue === null).length} need an issue`);
    return;
  }

  const fresh = found.filter((hit) => !known.has(key(hit)));
  const unexplained = baseline.entries.filter((entry) => entry.issue === null);
  const foundKeys = new Set(found.map(key));
  const gone = baseline.entries.filter((entry) => !foundKeys.has(key(entry)));
  for (const entry of gone) console.error(`check-mirrors: gone, run --write to drop it: ${entry.file}: ${entry.text}`);
  if (fresh.length || unexplained.length) {
    console.error('check-mirrors: a hand-copied list. Move it into a registry (docs/agents/areas/registries.md).');
    for (const hit of fresh) console.error(`  new: ${hit.file}: ${hit.text}`);
    for (const entry of unexplained) console.error(`  no issue: ${entry.file}: ${entry.text}`);
    process.exit(1);
  }
  console.log(`check-mirrors: ${found.length} known mirror comments, none new`);
}

if (import.meta.main) main();
