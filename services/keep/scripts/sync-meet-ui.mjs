#!/usr/bin/env node
/**
 * Meet's shadcn kit, copied in (decided in: a copy in
 * this repo, checked against web/ in this repository; no registry).
 *
 * Keep keeps a byte-for-byte copy of these files from Meet's `web/`:
 *
 *   components.json            the shadcn settings
 *   src/lib/utils.ts           cn()
 *   src/form-row.tsx           FormRow and CheckRow, on Field
 *   src/menu-focus.ts          focus return for dialog and sheet
 *   src/tailwind.css           layer order, base resets, --ui-* on Meet's token names
 *   src/ui-theme.css           the Tailwind names and the hover utilities
 *   src/Tip.tsx                the tooltip of an icon-only control
 *   src/use-media-query.ts     useMediaQuery()
 *   src/ui/<name>.tsx          each component in UI below
 *
 * and one slice: `src/meet-tokens.css` is the token block of Meet's
 * `src/styles.css` (the @font-face rules, the dark and light ladders, the
 * touch and contrast blocks), from its first line to the end of the
 * `@media (prefers-contrast: more)` block. So Keep draws on Meet's own token
 * values, not a second copy that can drift.
 *
 * Do not edit a copied file. A change starts in Meet; then run this sync.
 * `web/src/i18n.ts` is Keep's own `t()` (English only) for the components
 * that import `../i18n`. `web/src/styles.css` is Keep's own: the base element
 * rules and nothing that a utility can say.
 *
 * Usage:
 *   node scripts/sync-meet-ui.mjs           copy the files from this repository
 *   node scripts/sync-meet-ui.mjs --check   fail when a copy differs; with no source, pass and say so
 *   --from <dir>                            another checkout (default this repository)
 *
 * Docs has the same script (envisioning/docs scripts/sync-meet-ui.mjs).
 * sync-meet-fixtures.mjs is the same arrangement for the sign-in fixture.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = [
  'alert', 'alert-dialog', 'button', 'card', 'checkbox', 'dropdown-menu', 'field', 'input', 'item', 'label',
  'native-select', 'separator', 'sheet', 'table', 'tabs', 'textarea', 'tooltip',
];
const FILES = [
  'components.json',
  'src/lib/utils.ts',
  'src/form-row.tsx',
  'src/menu-focus.ts',
  'src/tailwind.css',
  'src/ui-theme.css',
  'src/Tip.tsx',
  'src/use-media-query.ts',
  ...UI.map((name) => `src/ui/${name}.tsx`),
];

/** The token block of Meet's styles.css: line 1 to the end of the contrast block. */
const TOKENS = { source: 'src/styles.css', dest: 'src/meet-tokens.css', end: '@media (prefers-contrast: more) {' };
const TOKENS_HEAD = `/* Copied from Meet's web/src/styles.css by scripts/sync-meet-ui.mjs. Do not edit. */\n`;

/** The slice, or null when Meet's file no longer has the end marker. */
function tokenSlice(text) {
  const start = text.indexOf(TOKENS.end);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return `${TOKENS_HEAD}${text.slice(0, i + 1)}\n`;
  }
  return null;
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const check = args.includes('--check');
const fromIndex = args.indexOf('--from');
const from = fromIndex >= 0 ? path.resolve(args[fromIndex + 1] ?? '') : path.resolve(repoRoot, '../..');
const sourceDir = path.join(from, 'web');

if (!existsSync(path.join(sourceDir, 'components.json'))) {
  console.log(`sync-meet-ui: no web/components.json in ${from} (no checkout, or one from before the kit); the copies in web/ are not compared`);
  process.exit(0);
}

const missing = [];
const differ = [];
const copies = [];
for (const file of FILES) {
  const source = path.join(sourceDir, file);
  if (!existsSync(source)) { missing.push(file); continue; }
  copies.push({ file, text: readFileSync(source, 'utf8') });
}
const tokenSource = path.join(sourceDir, TOKENS.source);
const tokens = existsSync(tokenSource) ? tokenSlice(readFileSync(tokenSource, 'utf8')) : null;
if (tokens === null) missing.push(`${TOKENS.source} (with "${TOKENS.end}")`);
else copies.push({ file: TOKENS.dest, text: tokens });

if (missing.length > 0) {
  console.error(`sync-meet-ui: ${from} has no web/${missing.join(', web/')}. Meet removed or renamed it: change the list in scripts/sync-meet-ui.mjs.`);
  process.exit(1);
}
for (const { file, text } of copies) {
  const dest = path.join(repoRoot, 'web', file);
  if (check) {
    const copy = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
    if (copy !== text) differ.push(file);
  } else {
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }
}

if (check) {
  if (differ.length > 0) {
    console.error(`sync-meet-ui: these copies differ from ${sourceDir}:\n- web/${differ.join('\n- web/')}\nRun node scripts/sync-meet-ui.mjs, then make pnpm verify pass.`);
    process.exit(1);
  }
  console.log(`sync-meet-ui: ${copies.length} files match ${sourceDir}`);
} else {
  console.log(`sync-meet-ui: copied ${copies.length} files from ${sourceDir}`);
}
