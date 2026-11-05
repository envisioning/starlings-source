#!/usr/bin/env node
/**
 * The web draws its controls with shadcn (docs/DESIGN.md "Web components:
 * shadcn"). In web/src and web/marketing/src, outside web/src/ui:
 *
 * - A raw `<button>`, `<select>`, `<details>`, `<label>`, `<table>`,
 *   `<dialog>` or `<input>` is a shadcn component instead (Button,
 *   NativeSelect, Collapsible, Label or Field, Table, Dialog, Input), unless
 *   shadcn has nothing for it: an event block on the calendar, a whole-row
 *   target, a hidden file input. Such a site says why with a
 *   `shadcn: <reason>` comment on or within three lines above it. That
 *   comment is the allowlist; there is no other.
 * - A literal `role="alert"` is ErrorNotice (an error) or shadcn Alert (a
 *   notice), so every error is red and carries Copy. Same `shadcn:` note.
 * - No `eyebrow` class: a heading has no small uppercase label over it, on
 *   the app or the public site. There is no exception.
 *
 *   node scripts/check-shadcn.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const report = (file, line, say) => problems.push(`${relative(repoRoot, file)}:${line}: ${say}`);

function walk(dir, keep, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, keep, out);
    else if (keep(name)) out.push(path);
  }
  return out;
}

const uiDir = join(repoRoot, 'web/src/ui');
const code = [join(repoRoot, 'web/src'), join(repoRoot, 'web/marketing/src')]
  .flatMap((dir) => walk(dir, (n) => n.endsWith('.tsx') && !n.includes('.test.')))
  .filter((file) => !file.startsWith(uiDir));

const RAW = /<(button|select|details|label|table|dialog|input)(?=[\s>/]|$)/g;
const NOTE = /(\/\/|\/\*|\{\/\*)\s*shadcn:/;
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*|\{\/\*)/;
const SHADCN = { button: 'Button', select: 'NativeSelect', details: 'Collapsible', label: 'Label or Field', table: 'Table', dialog: 'Dialog', input: 'Input' };

for (const file of code) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (COMMENT_LINE.test(line)) return;
    for (const match of line.matchAll(RAW)) {
      // Text inside an inline comment or a string is prose, not JSX.
      const before = line.slice(0, match.index);
      if (/\/\/|\/\*/.test(before) || (before.split('`').length - 1) % 2 === 1) continue;
      const noted = lines.slice(Math.max(0, i - 3), i + 1).some((l) => NOTE.test(l));
      if (!noted) report(file, i + 1, `raw <${match[1]}>: use shadcn ${SHADCN[match[1]]}, or say why not with a "shadcn: <reason>" comment`);
    }
    if (/role="alert"/.test(line) && !lines.slice(Math.max(0, i - 3), i + 1).some((l) => NOTE.test(l))) {
      report(file, i + 1, 'role="alert": use ErrorNotice for an error or shadcn Alert for a notice');
    }
  });
}

// No eyebrow, anywhere the web draws from: code, CSS and the site's HTML.
const EYEBROW = /className=["'{][^"'}]*\beyebrow\b|class="[^"]*\beyebrow\b|@utility eyebrow|\.eyebrow\b/;
const styled = [join(repoRoot, 'web/src'), join(repoRoot, 'web/marketing')]
  .flatMap((dir) => walk(dir, (n) => /\.(tsx|ts|css|html)$/.test(n) && !n.includes('.test.')));
for (const file of styled) {
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (EYEBROW.test(line)) report(file, i + 1, 'eyebrow: a heading has no label over it (docs/DESIGN.md)');
  });
}

if (problems.length) {
  console.error(`check-shadcn: ${problems.length} problem${problems.length === 1 ? '' : 's'}\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('check-shadcn: every raw control says why, alerts are ErrorNotice or Alert, and no page has an eyebrow');
