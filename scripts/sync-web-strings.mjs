#!/usr/bin/env node
// Keep the web's pt-BR table in step with every t('…') and plural() key
// — the web's counterpart of scripts/sync-string-catalog.py (AGENTS.md
// invariant 29):
//
//   web/src/i18n/pt-BR.json             the app and guest pages, and any key
//                                       the app and the site share
//
// The product site is English only: a key that only web/marketing, the
// interest form registry and the site's page titles use has no table.
// `--site-keys` prints those keys as JSON, for scripts/check-copy.mjs.
//
//   node scripts/sync-web-strings.mjs                  merge: new keys land as ""
//   node scripts/sync-web-strings.mjs --check          fail when the code has a key no table holds,
//                                                      or a key sits in the wrong table
//   node scripts/sync-web-strings.mjs --check --translated
//                                                      ...or when a key's value is ""
//
// A value of null means the key stays English on purpose (a product name,
// an admin readout, a wrangler constant): --translated accepts it, t()
// draws the key. "" means nobody has translated it yet.
//
// A key the code no longer uses is kept with its value and reported as
// stale, so a translation survives a refactor; `--prune` drops stale keys.
// Values are never rewritten here, except by --pseudo.
//
//   node scripts/sync-web-strings.mjs --export pt-BR.csv
//        key, pt-BR, first use, table: one row per live key, for a reader
//   node scripts/sync-web-strings.mjs --pseudo
//        rewrites every value to ⟦English English⟧ so a string that skips t()
//        stands out on screen with Português picked. Never commit it: undo
//        with `git checkout web/src/i18n/pt-BR.json`;
//        --check fails on it.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const srcDir = join(root, 'web', 'src');
const siteDir = join(root, 'web', 'marketing');
const TABLES = { app: join(srcDir, 'i18n', 'pt-BR.json') };
const args = new Set(process.argv.slice(2));
const check = args.has('--check');
const translated = args.has('--translated');
const prune = args.has('--prune');
const pseudo = args.has('--pseudo');
const argv = process.argv.slice(2);
const exportPath = argv.includes('--export') ? argv[argv.indexOf('--export') + 1] : null;
const PSEUDO_MARK = '⟦';

// t('key'), t("key"), tx('key', …), and the one/other forms of plural({ one: 'k', other: 'k' }).
const CALL = /\btx?\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
const FORM = /\b(?:one|other)\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;

function unescape(literal) {
  return literal.replace(/\\(['"\\n])/g, (whole, c) => (c === 'n' ? '\n' : c));
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'i18n') yield* sourceFiles(path); continue; }
    if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.|test-setup|vite-env/.test(entry.name)) yield path;
  }
}

/** key -> where it is first used (`web/src/File.tsx:12`), and which tables' code uses it. */
const keys = new Map();
const addKey = (key, where, user) => {
  const entry = keys.get(key) ?? { where, users: new Set() };
  entry.users.add(user);
  keys.set(key, entry);
};
for (const [dir, user] of [[srcDir, 'app'], [join(siteDir, 'src'), 'site'], [join(siteDir, 'og'), 'site']]) {
  for (const file of sourceFiles(dir)) {
    const text = readFileSync(file, 'utf8');
    for (const rx of [CALL, FORM]) {
      for (const m of text.matchAll(rx)) {
        const key = unescape(m[1] ?? m[2] ?? '');
        const line = text.slice(0, m.index).split('\n').length;
        if (/[A-Za-z]/.test(key)) addKey(key, `${relative(root, file)}:${line}`, user);
      }
    }
  }
}

// The product site's page titles and descriptions, for the copy rules.
{
  const file = join(root, 'web', 'agent-surface.ts');
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\b(?:title|description):\s*'((?:[^'\\]|\\.)*)'/g)) {
    addKey(unescape(m[1]), `web/agent-surface.ts:${text.slice(0, m.index).split('\n').length}`, 'site');
  }
}

// Labels the shared contracts hand the web as data ( step 4): Home
// module titles, Inbox sources, Work sort and group names,
// search-row subtitles, the interest form's options, the Upcoming section
// title. The web renders each through t(label), so the English value is the
// key. Swift keys the same strings in its own ports; the fixtures pin them.
//
// Every `*-values.ts` is read, so a label that moves into a new values file
// is found without an edit here (: two listed files lost their
// labels to `*-values.ts` and four keys fell back to English unseen). The
// named files are the registries that are not `*-values.ts`; a name that no
// longer exists fails the run.
const contractsDir = join(root, 'packages', 'contracts', 'src');
const NAMED_CONTRACT_FILES = ['meeting-kinds.ts', 'workspace-plans.ts', 'work-items.ts', 'subject-kinds.ts', 'subject-panes.ts', 'member-surfaces.ts', 'reactions.ts', 'interest.ts', 'agent-products.ts', 'search-rows.ts', 'work-modules.ts', 'setup-steps.ts', 'form-fields.ts'];
const CONTRACT_FILES = [...readdirSync(contractsDir).filter((name) => name.endsWith('-values.ts')), ...NAMED_CONTRACT_FILES];
const CONTRACT_VALUE = /\b(?:title|detail|label|hint|subtitle|caption|city|action|titleCaption|empty)\s*[:=]\s*'((?:[^'\\]|\\.)*)'/g;
const BARE_LABEL = /(?:\?|:|=|return|\|\|)\s*'([A-Z][^'\\]*)'/g;
// Modules whose words are plain `id: 'Word'` records rather than `label:` fields.
const BARE_LABEL_FILES = ['search-rows.ts', 'workspace-plans.ts', 'subject-state-values.ts', 'task-values.ts', 'presence-values.ts', 'subject-kinds.ts', 'sales-values.ts', 'search-values.ts', 'reactions.ts', 'work-modules.ts'];
for (const name of [...NAMED_CONTRACT_FILES, ...BARE_LABEL_FILES]) {
  if (!existsSync(join(contractsDir, name))) {
    console.error(`sync-web-strings: packages/contracts/src/${name} is gone. Point the list in scripts/sync-web-strings.mjs at the file that holds its labels now.`);
    process.exit(1);
  }
}
// The interest form's registry and the agent products it lists are drawn
// only by the product site.
const SITE_CONTRACT_FILES = ['interest.ts', 'agent-products.ts'];
for (const name of CONTRACT_FILES) {
  const text = readFileSync(join(contractsDir, name), 'utf8');
  const user = SITE_CONTRACT_FILES.includes(name) ? 'site' : 'app';
  for (const m of text.matchAll(CONTRACT_VALUE)) addKey(unescape(m[1]), `packages/contracts/src/${name}`, user);
  if (BARE_LABEL_FILES.includes(name)) for (const m of text.matchAll(BARE_LABEL)) addKey(m[1], `packages/contracts/src/${name}`, user);
}
{
  // Docs categories are the workspace's own data (labels people type), so
  // index.ts holds none to translate.
  const text = readFileSync(join(contractsDir, 'index.ts'), 'utf8');
  // The team channel's title, drawn through t(TEAM_THREAD_TITLE).
  const team = /export const TEAM_THREAD_TITLE = '([^']+)'/.exec(text);
  if (!team) { console.error('sync-web-strings: TEAM_THREAD_TITLE is gone from packages/contracts/src/index.ts.'); process.exit(1); }
  addKey(team[1], 'packages/contracts/src/index.ts', 'app');
  const config = JSON.parse(readFileSync(join(contractsDir, 'upcoming-config.json'), 'utf8'));
  addKey(config.sectionTitle, 'packages/contracts/src/upcoming-config.json', 'app');
  addKey('NOW', 'packages/contracts/src/upcoming-config.json', 'app');
}

const read = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
const tables = { app: read(TABLES.app) };
// Keys only the English site uses: no table holds them.
const siteKeys = [...keys.keys()].filter((key) => !keys.get(key).users.has('app')).sort();
if (args.has('--site-keys')) { writeFileSync(1, `${JSON.stringify(siteKeys)}\n`); process.exit(0); }
for (const key of siteKeys) keys.delete(key);
const home = () => 'app';
const has = (key) => key in tables.app;
const valueOf = (key) => tables.app[key];

const missing = [...keys.keys()].filter((key) => !has(key)).sort();
const misplaced = [];
const stale = Object.entries(tables).flatMap(([name, table]) => Object.keys(table).filter((key) => !keys.has(key)).map((key) => [name, key]));
const untranslated = [...keys.keys()].filter((key) => has(key) && valueOf(key) === '').sort();
const kept = [...keys.keys()].filter((key) => has(key) && valueOf(key) === null).length;
const pseudoValues = Object.values(tables).flatMap((table) => Object.values(table)).filter((value) => typeof value === 'string' && value.startsWith(PSEUDO_MARK));

if (exportPath) {
  const cell = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const rows = [...keys.keys()].sort((a, b) => a.localeCompare(b, 'en')).map((key) => {
    const value = valueOf(key) === null ? '(stays English)' : (valueOf(key) ?? '');
    return [key, value, keys.get(key).where, home(key)].map(cell).join(',');
  });
  writeFileSync(exportPath, `${['key', 'pt-BR', 'first use', 'table'].map(cell).join(',')}\n${rows.join('\n')}\n`);
  console.log(`sync-web-strings: ${rows.length} rows written to ${exportPath}`);
  process.exit(0);
}

if (check) {
  let problems = 0;
  if (missing.length || misplaced.length) {
    problems += 1;
    console.error('The pt-BR table is behind the code. Run node scripts/sync-web-strings.mjs and commit web/src/i18n/pt-BR.json.');
    for (const key of missing) console.error(`  new: ${JSON.stringify(key)}`);
    for (const key of misplaced) console.error(`  belongs in the ${home(key)} table: ${JSON.stringify(key)}`);
  }
  for (const [name, key] of stale) console.error(`sync-web-strings: stale in the ${name} table, remove when sure: ${JSON.stringify(key)}`);
  if (pseudoValues.length) {
    problems += 1;
    console.error(`The pt-BR table holds the --pseudo values (${pseudoValues.length}). Restore it: git checkout web/src/i18n/pt-BR.json`);
  }
  if (translated && untranslated.length) {
    problems += 1;
    console.error(`${untranslated.length} keys have no pt-BR translation:`);
    for (const key of untranslated) console.error(`  ${JSON.stringify(key)}`);
  }
  process.exit(problems ? 1 : 0);
}

const next = { app: {} };
for (const key of keys.keys()) next[home(key)][key] = has(key) ? valueOf(key) : '';
if (!prune) for (const [name, key] of stale) next[name][key] = tables[name][key];
// Doubled, so a label that would overflow in a longer language overflows here too.
if (pseudo) for (const key of keys.keys()) next[home(key)][key] = `${PSEUDO_MARK}${key} ${key}⟧`;
for (const [name, table] of Object.entries(next)) {
  const sorted = Object.fromEntries(Object.keys(table).sort((a, b) => a.localeCompare(b, 'en')).map((key) => [key, table[key]]));
  mkdirSync(dirname(TABLES[name]), { recursive: true });
  writeFileSync(TABLES[name], `${JSON.stringify(sorted, null, 2)}\n`);
}
const count = (name) => Object.keys(next[name]).length;
console.log(`sync-web-strings: ${keys.size} keys in code (app ${count('app')}, site ${siteKeys.length} English only), +${missing.length} new, ${misplaced.length} moved, ${stale.length} ${prune ? 'pruned' : 'stale'}, ${untranslated.length + missing.length} untranslated, ${kept} kept English`);
