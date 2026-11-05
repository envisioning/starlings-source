#!/usr/bin/env node
// Records the D1 Time Travel bookmark before `migrations apply`.
//
// The deploy applies migrations to production with nobody watching. This
// line in the Workers Builds log is the restore point for the migration
// that follows: `wrangler d1 time-travel restore <database> --bookmark=<it>`
// (docs/DEPLOYMENT.md §Rollback). Fails closed: no bookmark, no migration.
//
//   node scripts/d1-bookmark.mjs <database> [--env <name>] [--config <path>]
//
// Every workspace has its own D1, so the database name is an
// argument. `scripts/deploy-fleet.mjs` uses the exported parts.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The arguments: one database name, then optional `--env` and `--config`. Throws on anything else. */
export function parseBookmarkArgs(argv) {
  const options = { database: undefined, env: undefined, config: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--env' || arg === '--config') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = value;
      i++;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else if (options.database) {
      throw new Error(`one database only; ${arg} is a second one`);
    } else {
      options.database = arg;
    }
  }
  if (!options.database) throw new Error('the database name is missing');
  return options;
}

/** The wrangler arguments that read the current bookmark of one database. */
export function bookmarkCommand({ database, env, config }) {
  return ['d1', 'time-travel', 'info', database, '--json', ...(env ? ['--env', env] : []), ...(config ? ['--config', config] : [])];
}

/** The bookmark in wrangler's `--json` answer, or undefined. Wrangler can print lines before the JSON. */
export function parseBookmark(output) {
  const start = output.indexOf('{');
  if (start < 0) return undefined;
  try {
    const bookmark = JSON.parse(output.slice(start)).bookmark;
    return typeof bookmark === 'string' && bookmark.length > 0 ? bookmark : undefined;
  } catch {
    return undefined;
  }
}

/** The log line DEPLOYMENT.md §Rollback tells the reader to find. */
export function bookmarkLine(database, bookmark, now = new Date()) {
  return `d1.bookmark ${database} ${bookmark} ${now.toISOString()}`;
}

function main() {
  let options;
  try {
    options = parseBookmarkArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`d1-bookmark: ${error.message}. Usage: node scripts/d1-bookmark.mjs <database> [--env <name>] [--config <path>]`);
    process.exit(1);
  }
  let output;
  try {
    output = execFileSync('npx', ['wrangler', ...bookmarkCommand(options)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
  } catch {
    console.error(`d1-bookmark: could not read the bookmark for ${options.database}; migrations not applied.`);
    process.exit(1);
  }
  const bookmark = parseBookmark(output);
  if (!bookmark) {
    console.error(`d1-bookmark: wrangler answered without a bookmark; migrations not applied.\n${output}`);
    process.exit(1);
  }
  console.log(bookmarkLine(options.database, bookmark));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
