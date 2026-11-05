#!/usr/bin/env node
/**
 * Meet's service sign-in fixture, copied in (envisioning/meet
 * docs/CENTRAL_AUTH.md "Services").
 *
 * Meet keeps `fixtures/central-auth/service-sign-in.json`: what a workspace's
 * Keep sends to and reads from the auth host and the workspace. Keep keeps a
 * byte-for-byte copy in `fixtures/meet/`, and
 * `scripts/check-central-auth-fixture.mjs` parses it with Keep's copy of the
 * schemas (`packages/contracts/src/central-auth.ts`). So a change to the
 * handoff is: the schema and fixture in Meet, then this sync, then a schema
 * change here until the check passes.
 *
 * Usage:
 *   node scripts/sync-meet-fixtures.mjs           copy this repository's file in
 *   node scripts/sync-meet-fixtures.mjs --check   fail when it differs; with no source, pass and say so
 *   --from <dir>                                  another checkout (default this repository)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const NAME = 'service-sign-in.json';
const dest = path.join(repoRoot, 'fixtures/meet', NAME);

const args = process.argv.slice(2);
const check = args.includes('--check');
const fromIndex = args.indexOf('--from');
const from = fromIndex >= 0 ? path.resolve(args[fromIndex + 1] ?? '') : path.resolve(repoRoot, '../..');
const source = path.join(from, 'fixtures/central-auth', NAME);

if (!existsSync(source)) {
  console.log(`sync-meet-fixtures: no ${path.relative(from, source)} in ${from} (no checkout, or one from before the fixture); the copy in fixtures/meet is not compared`);
  process.exit(0);
}
const text = readFileSync(source, 'utf8');
const copy = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
if (check) {
  if (copy !== text) {
    console.error(`sync-meet-fixtures: fixtures/meet/${NAME} differs from ${source}. Run node scripts/sync-meet-fixtures.mjs, then make the check pass.`);
    process.exit(1);
  }
  console.log(`sync-meet-fixtures: fixtures/meet/${NAME} matches ${from}`);
} else {
  writeFileSync(dest, text);
  console.log(`sync-meet-fixtures: copied ${source}`);
}
