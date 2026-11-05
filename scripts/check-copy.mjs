#!/usr/bin/env node
/**
 * The mechanical half of the copy law (docs/DESIGN.md;,
 *), over every UI string in every catalog: `web/src/i18n/pt-BR.json`,
 * the keys only the English site uses (`sync-web-strings.mjs --site-keys`)
 * and `Resources/Localizable.xcstrings`. What a person reads comes from
 * these, so a rule here holds on every client.
 *
 * - "Couldn’t", never "Could not".
 * - A curly apostrophe, never a straight one.
 * - No Unicode glyph as UI (a star, a warning sign, a disclosure triangle, a
 *   check): an SF Symbol or an icon component draws those.
 *
 *   node scripts/check-copy.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = Object.keys(JSON.parse(readFileSync(join(repoRoot, 'web/src/i18n/pt-BR.json'), 'utf8')));
const site = JSON.parse(execFileSync('node', [join(repoRoot, 'scripts/sync-web-strings.mjs'), '--site-keys'], { encoding: 'utf8' }));
const apple = Object.keys(JSON.parse(readFileSync(join(repoRoot, 'Resources/Localizable.xcstrings'), 'utf8')).strings);

const rules = [
  { test: /\b[Cc]ould not\b/u, say: 'write “Couldn’t”, not “Could not”' },
  { test: /'/u, say: 'use a curly apostrophe (’), not a straight one' },
  { test: /[★☆⚠▸▾▶◀✓✔✗✘]/u, say: 'draw the glyph as an icon, not a Unicode character' },
];

const problems = [];
for (const [catalog, keys] of [['web/src/i18n/pt-BR.json', web], ['the English-only site’s strings', site], ['Resources/Localizable.xcstrings', apple]]) {
  for (const key of keys) {
    for (const rule of rules) {
      if (rule.test.test(key)) problems.push(`${catalog}: “${key}”: ${rule.say}`);
    }
  }
}

if (problems.length > 0) {
  for (const line of problems) console.error(line);
  console.error(`${problems.length} UI string${problems.length === 1 ? '' : 's'} break the copy law (docs/DESIGN.md)`);
  process.exit(1);
}
console.log(`copy: ${web.length + apple.length} UI strings follow the copy law`);
