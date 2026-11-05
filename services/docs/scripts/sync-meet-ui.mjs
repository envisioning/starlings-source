#!/usr/bin/env node
/**
 * Meet's shadcn kit, copied in (decided in: a copy in
 * this repo, checked against web/ in this repository; no registry).
 *
 * Docs keeps a byte-for-byte copy of these files from Meet's `web/`:
 *
 *   components.json            the shadcn settings
 *   src/lib/utils.ts           cn()
 *   src/form-row.tsx           FormRow and CheckRow, on Field
 *   src/menu-focus.ts          focus return for dialog and sheet
 *   src/GatheringDots.tsx      the loader the spinner draws, and its CSS
 *   src/tailwind.css           layer order, base resets, --ui-* on Meet's token names
 *   src/ui-theme.css           the Tailwind names and the hover utilities
 *   src/ui/<name>.tsx          each component in UI below
 *
 * Do not edit a copied file. A change starts in Meet; then run this sync.
 * Docs defines Meet's token names (--surface, --accent-cta, ...) on its own
 * ladder in `web/src/styles.css`, and `web/src/i18n.ts` is Docs' own `t()`
 * (English only) for the components that import `../i18n`.
 *
 * Usage:
 *   node scripts/sync-meet-ui.mjs           copy the files from this repository
 *   node scripts/sync-meet-ui.mjs --check   fail when a copy differs; with no source, pass and say so
 *   --from <dir>                            another checkout (default this repository)
 *
 * sync-meet-fixtures.mjs is the same arrangement for the sign-in fixture.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = [
  'alert', 'alert-dialog', 'badge', 'button', 'card', 'checkbox', 'dialog', 'dropdown-menu', 'field', 'input', 'label',
  'native-select', 'radio-group', 'separator', 'sheet', 'skeleton', 'spinner', 'textarea', 'tooltip',
];
const FILES = [
  'components.json',
  'src/lib/utils.ts',
  'src/form-row.tsx',
  'src/menu-focus.ts',
  'src/GatheringDots.tsx',
  'src/gathering-dots.css',
  'src/tailwind.css',
  'src/ui-theme.css',
  ...UI.map((name) => `src/ui/${name}.tsx`),
];

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
for (const file of FILES) {
  const source = path.join(sourceDir, file);
  const dest = path.join(repoRoot, 'web', file);
  if (!existsSync(source)) { missing.push(file); continue; }
  const text = readFileSync(source, 'utf8');
  if (check) {
    const copy = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
    if (copy !== text) differ.push(file);
  } else {
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  }
}

if (missing.length > 0) {
  console.error(`sync-meet-ui: ${from} has no web/${missing.join(', web/')}. Meet removed or renamed it: change the list in scripts/sync-meet-ui.mjs.`);
  process.exit(1);
}
if (check) {
  if (differ.length > 0) {
    console.error(`sync-meet-ui: these copies differ from ${sourceDir}:\n- web/${differ.join('\n- web/')}\nRun node scripts/sync-meet-ui.mjs, then make pnpm verify pass.`);
    process.exit(1);
  }
  console.log(`sync-meet-ui: ${FILES.length} files match ${sourceDir}`);
} else {
  console.log(`sync-meet-ui: copied ${FILES.length} files from ${sourceDir}`);
}
