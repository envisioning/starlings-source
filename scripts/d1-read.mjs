#!/usr/bin/env node
/**
 * Read a production D1, never write it.
 *
 *   node scripts/d1-read.mjs <workspace|auth> "SELECT ..."
 *
 * `<workspace>` is a slug from services/control-plane/wrangler.jsonc
 * (`envisioning` is the top-level Worker, the others are its `env` blocks);
 * `auth` is starlings-auth. The query must be one SELECT (or WITH ... SELECT)
 * statement with no write keyword anywhere in it, so an agent may run this
 * without a person approving each read. Anything else is refused before
 * wrangler starts. Output is the rows as JSON.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripJSONComments } from './check-production-config.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const service = join(root, 'services', 'control-plane');

const WRITE_WORDS = /\b(insert|update|delete|replace|upsert|drop|alter|create|attach|detach|vacuum|reindex|pragma|begin|commit|rollback|savepoint|release|analyze)\b/iu;

/** The refusal, or null when `sql` is one read-only statement. */
export function readOnlyProblem(sql) {
  const text = sql.trim().replace(/;\s*$/u, '');
  if (!text) return 'Give a query.';
  if (text.includes(';')) return 'One statement only.';
  if (!/^(select|with)\b/iu.test(text)) return 'Only SELECT or WITH ... SELECT.';
  // Literals are stripped first, so a word inside a string does not refuse the read.
  const bare = text.replace(/'(?:[^']|'')*'/gu, "''").replace(/"(?:[^"]|"")*"/gu, '""');
  const word = WRITE_WORDS.exec(bare);
  if (word) return `Refused: "${word[1]}" can write.`;
  return null;
}

/** `{ name, args }` for wrangler, from the slug. */
export function databaseFor(target) {
  if (target === 'auth') return { name: 'starlings-auth', args: ['--config', 'wrangler.auth.jsonc'] };
  const config = JSON.parse(stripJSONComments(readFileSync(join(service, 'wrangler.jsonc'), 'utf8')));
  if (target === 'envisioning') {
    const usage = config.d1_databases?.find((db) => db.binding === 'USAGE');
    if (usage) return { name: usage.database_name, args: [] };
  }
  const usage = config.env?.[target]?.d1_databases?.find((db) => db.binding === 'USAGE');
  if (usage) return { name: usage.database_name, args: ['--env', target] };
  const known = ['envisioning', ...Object.keys(config.env ?? {}), 'auth'].join(', ');
  throw new Error(`No D1 for "${target}". Known: ${known}.`);
}

function main() {
  const [target, sql] = process.argv.slice(2);
  if (!target || sql === undefined) {
    console.error('Usage: node scripts/d1-read.mjs <workspace|auth> "SELECT ..."');
    process.exit(2);
  }
  const problem = readOnlyProblem(sql);
  if (problem) {
    console.error(problem);
    process.exit(2);
  }
  const db = databaseFor(target);
  const result = spawnSync(
    'pnpm',
    ['--filter', '@starlings/control-plane', 'exec', 'wrangler', 'd1', 'execute', db.name, '--remote', '--json', ...db.args, '--command', sql],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
  const parsed = JSON.parse(result.stdout.slice(result.stdout.indexOf('[')));
  console.log(JSON.stringify(parsed[0]?.results ?? [], null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
