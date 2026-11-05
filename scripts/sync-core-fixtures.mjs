#!/usr/bin/env node
/**
 * Core's recorded projections, copied in.
 *
 * Core's `/api/public/meet-*` routes and the channel events it posts to Meet
 * are recorded in `envisioning/core` as `fixtures/meet-projections/*.json`, by
 * route tests that run the real handlers. Meet keeps a copy in
 * `fixtures/core/`; a Worker test (`test/core-fixtures.test.ts`) parses every
 * file with the schema Meet reads that route with. So a change to a response
 * is one PR in Core with the fixture, then this sync in Meet, then a schema
 * change here until the test passes.
 *
 * Usage:
 *   node scripts/sync-core-fixtures.mjs            copy the sibling checkout's files in (and drop ones it no longer has)
 *   node scripts/sync-core-fixtures.mjs --check    fail when the sibling checkout's files differ from the copy;
 *                                                  with no sibling checkout, pass and say so (CI, Workers Builds)
 *   --from <dir>                                   another Core checkout (default ../core-web)
 *
 * The check is part of `pnpm verify:fast`. A sibling checkout that is behind
 * Core's `main` has older fixtures: pull it, or sync, before reading a failure
 * as a Core change.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
export const DEST = path.join(repoRoot, 'fixtures/core');
const SOURCE_SUBDIR = path.join('fixtures', 'meet-projections');

function jsonFiles(dir) {
  if (!existsSync(dir)) return new Map();
  return new Map(
    readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => [name, readFileSync(path.join(dir, name), 'utf8')]),
  );
}

/**
 * What a sync would change: files Core has that Meet does not (`missing`),
 * files whose text differs (`changed`), and files Meet has that Core dropped
 * (`extra`). Pure, so the test can hand it two maps.
 */
export function plan(source, dest) {
  const missing = [];
  const changed = [];
  const extra = [];
  for (const [name, text] of source) {
    if (!dest.has(name)) missing.push(name);
    else if (dest.get(name) !== text) changed.push(name);
  }
  for (const name of dest.keys()) if (!source.has(name)) extra.push(name);
  return { missing, changed, extra, clean: missing.length + changed.length + extra.length === 0 };
}

function describe(result) {
  return [
    ...result.missing.map((name) => `  new in Core, not synced: ${name}`),
    ...result.changed.map((name) => `  differs from Core: ${name}`),
    ...result.extra.map((name) => `  no longer in Core: ${name}`),
  ].join('\n');
}

function main(argv) {
  const check = argv.includes('--check');
  const fromIndex = argv.indexOf('--from');
  const explicit = fromIndex >= 0 ? argv[fromIndex + 1] : undefined;
  if (fromIndex >= 0 && !explicit) {
    console.error('sync-core-fixtures: --from needs a directory.');
    return 2;
  }
  const checkout = path.resolve(repoRoot, explicit ?? '../core-web');
  const sourceDir = path.join(checkout, SOURCE_SUBDIR);

  if (!existsSync(sourceDir)) {
    if (check) {
      console.log(`sync-core-fixtures: no Core fixtures at ${sourceDir}; skipped (no sibling checkout, or one from before meet#606).`);
      return 0;
    }
    console.error(`sync-core-fixtures: ${sourceDir} does not exist. Check out envisioning/core next to this repo, or pass --from.`);
    return 1;
  }

  const source = jsonFiles(sourceDir);
  if (source.size === 0) {
    console.error(`sync-core-fixtures: ${sourceDir} holds no .json files.`);
    return 1;
  }
  const dest = jsonFiles(DEST);
  const result = plan(source, dest);

  if (check) {
    if (result.clean) {
      console.log(`sync-core-fixtures: fixtures/core matches ${checkout} (${source.size} files).`);
      return 0;
    }
    console.error(`sync-core-fixtures: fixtures/core differs from ${checkout}:\n${describe(result)}\nRun: node scripts/sync-core-fixtures.mjs`);
    return 1;
  }

  mkdirSync(DEST, { recursive: true });
  for (const name of [...result.missing, ...result.changed]) writeFileSync(path.join(DEST, name), source.get(name));
  for (const name of result.extra) rmSync(path.join(DEST, name));
  console.log(result.clean
    ? `sync-core-fixtures: already current (${source.size} files).`
    : `sync-core-fixtures: ${result.missing.length} added, ${result.changed.length} updated, ${result.extra.length} removed.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
