#!/usr/bin/env node
/**
 * The Worker's recorded responses.
 *
 * `fixtures/responses/<name>.json` is the body the Worker answers for one read
 * the clients make, recorded by `services/control-plane/test/response-fixtures.test.ts`
 * with Core and the clock pinned. The web suite parses every file with its
 * route's zod schema and the Swift suites decode every file through the
 * generated wire type and the app's model, so a response cannot change on one
 * side alone.
 *
 * Usage:
 *   node scripts/record-response-fixtures.mjs            compare the Worker's answers to the files (same as --check)
 *   node scripts/record-response-fixtures.mjs --check    the same; `pnpm test:api` and `pnpm verify:fast` run it too
 *   node scripts/record-response-fixtures.mjs --write    re-record every file, dropping any no case claims, then compare
 *
 * After a change to a response: --write, read the diff in `fixtures/responses/`,
 * and update the clients (zod schema is the contract; Swift models decode it)
 * until `pnpm test:web` and the Apple tests pass.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const dest = path.join(repoRoot, 'fixtures/responses');
const workerDir = path.join(repoRoot, 'services/control-plane');
const TEST = 'test/response-fixtures.test.ts';

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== '--write' && arg !== '--check');
if (unknown.length > 0 || (args.includes('--write') && args.includes('--check'))) {
  console.error('record-response-fixtures: use --write or --check.');
  process.exit(2);
}

function vitest(write) {
  const result = spawnSync('pnpm', ['exec', 'vitest', 'run', TEST], {
    cwd: workerDir,
    stdio: 'inherit',
    env: { ...process.env, ...(write ? { RESPONSE_FIXTURES: 'write' } : {}) },
  });
  return result.status ?? 1;
}

if (args.includes('--write')) {
  // Every file a case still claims is written again; a file nobody claims goes.
  mkdirSync(dest, { recursive: true });
  if (existsSync(dest)) for (const file of readdirSync(dest)) if (file.endsWith('.json')) rmSync(path.join(dest, file));
  if (vitest(true) !== 0) process.exit(1);
  console.log('record-response-fixtures: recorded; comparing.');
}
process.exit(vitest(false));
