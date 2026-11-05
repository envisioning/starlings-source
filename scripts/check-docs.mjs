#!/usr/bin/env node
/**
 * The docs gate (docs/DOCUMENTATION.md, decisions 2 and 3;).
 *
 *   node scripts/check-docs.mjs            # errors fail; stale docs warn
 *   node scripts/check-docs.mjs --strict   # stale docs fail too
 *
 * Errors: a doc with no frontmatter or a bad field, a `capabilities` id the
 * registry does not have, an `owns` path that does not exist.
 *
 * Errors too: a surface in SURFACE_IDS with no reference page, or with two;
 * and a control named in a help page's `## Controls` table that is not a
 * string in the web table (`web/src/i18n/pt-BR.json`), a key only the English site uses,
 * or `Resources/Localizable.xcstrings`
 * — the help names what the app names, or it is wrong.
 *
 * A help page (docs/help/) that is stale is an error, not a warning: those
 * pages are the product's own account of itself and ship to /help and
 * llms.txt. Internal docs warn until `--strict`.
 *
 * Stale: a path in `owns` has a commit after `verified`, or a change not yet
 * committed (which counts as today; `docs-freshness.mjs`). The fix is to read
 * the doc against the code and move the date, or to change the doc. This is
 * `docs/MAP.md`'s "last verified" discipline as a mechanism.
 *
 * Runs under the TS loader because the registry is TypeScript:
 *   node --import ./scripts/node-ts-resolve.mjs scripts/check-docs.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES } from '../packages/contracts/src/capabilities.ts';
import { SURFACE_IDS, readAllDocs } from './docs-frontmatter.mjs';
import { lastChangeDate, splitOwns, uncommittedPaths } from './docs-freshness.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const strict = process.argv.includes('--strict');
const capabilityIds = new Set(CAPABILITIES.map((row) => row.id));

function symbolExists(path, symbol) {
  const pattern = new RegExp(`^[A-Za-z_$].*\\b${symbol.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\b`, 'u');
  return readFileSync(join(repoRoot, path), 'utf8').split('\n').some((line) => pattern.test(line));
}

/**
 * A shallow clone dates every file to its one commit, so each page verified
 * before that day reads as stale. Cloudflare Workers Builds clones shallow
 * (docs/agents/areas/worker.md), and this check failed every build that way.
 * Fetch the history instead of skipping the check: a fetch that fails fails
 * here, the same rule `check-wire-compat.mjs` keeps for its tag.
 */
function ensureHistory() {
  const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  if (shallow !== 'true') return;
  // `main` as well as the checkout's own refspec: a branch cloned alone
  // deepens only as far as that branch's ref reaches on origin.
  execFileSync('git', ['fetch', '--quiet', '--unshallow', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { cwd: repoRoot, stdio: 'inherit' });
  const still = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  if (still === 'true') throw new Error('check-docs: the checkout is still shallow after fetching history; page freshness cannot be read.');
}

let errors = 0;
let stale = 0;
const docs = readAllDocs(repoRoot);
ensureHistory();
const pending = uncommittedPaths(repoRoot);

const uiStrings = new Set([
  ...Object.keys(JSON.parse(readFileSync(join(repoRoot, 'web', 'src', 'i18n', 'pt-BR.json'), 'utf8'))),
  // The product site is English only and has no table: its keys come from the code.
  ...JSON.parse(execFileSync('node', [join(repoRoot, 'scripts', 'sync-web-strings.mjs'), '--site-keys'], { encoding: 'utf8' })),
  ...Object.keys(JSON.parse(readFileSync(join(repoRoot, 'Resources', 'Localizable.xcstrings'), 'utf8')).strings),
]);
/** The first cell of every body row of a page's `## Controls` table, split on ` / `. */
function controlsNamed(text) {
  const match = /## Controls\n\n((?:\|.*\n)+)/u.exec(text);
  if (!match) return [];
  return match[1].split('\n').filter((line) => line.startsWith('|')).slice(2)
    .flatMap((line) => line.split('|')[1].trim().replace(/[`*]/gu, '').split(' / '))
    .map((name) => name.trim()).filter(Boolean);
}
const isUIString = (name) => uiStrings.has(name) || uiStrings.has(`${name}…`) || uiStrings.has(name.replace(/…$/u, ''));
for (const id of SURFACE_IDS) {
  const pages = docs.filter((doc) => doc.fields?.surface === id).map((doc) => doc.path);
  const expected = `docs/help/surfaces/${id}.md`;
  if (pages.length === 0) console.error(`surface ${id} has no reference page (${expected})`);
  else if (pages.length > 1) console.error(`surface ${id} has ${pages.length} reference pages: ${pages.join(', ')}`);
  else if (pages[0] !== expected) console.error(`surface ${id} is documented at ${pages[0]}, expected ${expected}`);
  else continue;
  errors += 1;
}
for (const doc of docs) {
  const problems = [...doc.errors];
  const fields = doc.fields ?? {};
  for (const id of fields.capabilities ?? []) if (!capabilityIds.has(id)) problems.push(`capability ${id} is not in the registry`);
  for (const entry of fields.owns ?? []) {
    const { path, symbol } = splitOwns(entry);
    if (!existsSync(join(repoRoot, path))) problems.push(`owns ${path}, which does not exist`);
    else if (symbol && !symbolExists(path, symbol)) problems.push(`owns ${entry}, but no definition line names ${symbol}`);
  }
  const isHelp = doc.path.startsWith('docs/help/');
  if (isHelp && fields.surface) {
    for (const name of controlsNamed(readFileSync(join(repoRoot, doc.path), 'utf8'))) {
      if (!isUIString(name)) problems.push(`names a control "${name}" that is not a UI string in either catalog`);
    }
  }
  for (const problem of problems) console.error(`${doc.path}: ${problem}`);
  errors += problems.length;
  if (problems.length > 0 || !fields.verified) continue;

  const changed = (fields.owns ?? [])
    .map((path) => [path, lastChangeDate(repoRoot, path, pending)])
    .filter(([, date]) => date !== null && date > fields.verified);
  if (changed.length > 0) {
    const detail = changed.map(([path, date]) => `${path} (${date})`).join(', ');
    const fail = strict || isHelp;
    console[fail ? 'error' : 'warn'](`${doc.path}: verified ${fields.verified}, but changed since: ${detail}`);
    if (fail) errors += 1;
    else stale += 1;
  }
}

if (errors > 0) {
  console.error(`${errors} problem${errors === 1 ? '' : 's'} in docs/ frontmatter`);
  process.exit(1);
}
if (stale > 0) {
  console[strict ? 'error' : 'warn'](`${stale} doc${stale === 1 ? '' : 's'} stale (code under owns changed after verified)`);
  if (strict) process.exit(1);
}
