#!/usr/bin/env node
/**
 * Everything clickable responds to the pointer (AGENTS.md invariant 18,
 * docs/DESIGN.md "Hover: the house rule"), on all three clients:
 *
 * Web (web/src)
 * - No hardcoded hover colour in a class string: hover goes through
 *   `hover-lift` / `hover-edge` / `hover-field`, `--accent-hover` /
 *   `--accent-cta-hover`, or answers in ink (`hover:text-*`, `hover:underline`).
 * - No colour literal inside a CSS `:hover` rule: the tokens are what go
 *   inert on touch.
 * - A lowercase JSX element that is clickable (`button`, `summary`, `onClick`,
 *   or a button/tab/option/menuitem role) carries a hover class.
 *
 * Mac (Sources)
 * - A borderless NSButton is wired to a hover helper near where it is built.
 * - A view that takes clicks itself (`mouseDown`/`mouseUp`, a click
 *   recognizer) references a hover helper.
 *
 * iOS (iOS)
 * - `.buttonStyle(.plain)`, `PlainButtonStyle()` and `.onTapGesture` sit next
 *   to a hover marker. New chromeless buttons use `.buttonStyle(.meetPlain)`.
 * - Every ButtonStyle / ToggleStyle declared here wires hover in its body.
 *
 * A site whose hover genuinely lives elsewhere (a parent that lifts, a row
 * that is not a target, a canvas that draws its own) says so with a
 * `hover: <reason>` comment on or within three lines above the site. That
 * comment is the allowlist; there is no other.
 *
 *   node scripts/check-hover.mjs
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const report = (file, line, say) => problems.push(`${relative(repoRoot, file)}:${line}: ${say}`);

function walk(dir, keep, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, keep, out);
    else if (keep(name)) out.push(path);
  }
  return out;
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;
const NOTE = /(\/\/|\/\*|\{\/\*)\s*hover:/;
/** A `hover:` note on the line or up to three lines above it. */
const noted = (lines, i) => lines.slice(Math.max(0, i - 3), i + 1).some((l) => NOTE.test(l));

// ── Web ─────────────────────────────────────────────────────────────────────

const webSrc = join(repoRoot, 'web/src');
const webCode = [webSrc, join(repoRoot, 'web/marketing/src')].flatMap(dir => walk(dir, (n) => /\.(ts|tsx)$/.test(n) && !/\.test\.|\.d\.ts$/.test(n)));
const webCss = walk(webSrc, (n) => n.endsWith('.css'));

const HARDCODED_HOVER =
  /hover:(?:(?:bg|shadow|fill|stroke|from|via|to)-(?!\(--(?:accent-hover|accent-cta-hover)\)|none\b)|(?:border|ring|outline)-(?!\d|\(--hover-border\))|(?:brightness|contrast|saturate)-)/g;
for (const file of webCode) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(HARDCODED_HOVER)) {
    report(file, lineAt(text, m.index), `hardcoded hover colour \`${m[0]}…\`: use hover-lift / hover-edge / hover-field`);
  }
}

const CSS_HOVER_LITERAL =
  /:hover[^{}]*\{[^}]*?(#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(|color-mix\(|\bwhite\b|\bblack\b)/g;
for (const file of webCss) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(CSS_HOVER_LITERAL)) {
    report(file, lineAt(text, m.index), `colour literal \`${m[1]}\` in a :hover rule: use --hover-lift / --hover-border`);
  }
}

// rolldown ships with vite; its parser is the only TSX AST in the tree (TS 7
// has no JS API).
const viteRequire = createRequire(realpathSync(join(repoRoot, 'web/node_modules/vite/package.json')));
const { parseAst } = await import(pathToFileURL(viteRequire.resolve('rolldown/parseAst')).href);

function visit(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach((n) => visit(n, fn));
  if (typeof node.type === 'string') fn(node);
  for (const key in node) if (key !== 'parent' && node[key] && typeof node[key] === 'object') visit(node[key], fn);
}

const parsed = [];
const constants = new Map();
for (const file of webCode) {
  const code = readFileSync(file, 'utf8');
  const ast = parseAst(code, { lang: file.endsWith('x') ? 'tsx' : 'ts' });
  parsed.push([file, code, ast]);
  visit(ast, (n) => {
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.init) {
      constants.set(n.id.name, code.slice(n.init.start, n.init.end));
    }
  });
}
// Class strings are often shared constants (`TILE_LINK`, `homeRowHover`).
const expand = (text, depth = 0) =>
  depth > 3
    ? text
    : text.replace(/\b[A-Za-z_]\w*\b/g, (id) =>
        constants.has(id) && /^[A-Z][A-Z0-9_]{2,}$|^[a-z]+[A-Z]\w*$/.test(id) ? ` ${expand(constants.get(id), depth + 1)} ` : id,
      );

for (const [file, code, ast] of parsed) {
  const lines = code.split('\n');
  visit(ast, (n) => {
    if (n.type !== 'JSXOpeningElement') return;
    const tag = code.slice(n.name.start, n.name.end);
    if (!/^[a-z]/.test(tag) || /^(label|input|form|a|textarea|select)$/.test(tag)) return;
    const attrs = {};
    for (const a of n.attributes) {
      if (a.type === 'JSXAttribute') attrs[code.slice(a.name.start, a.name.end)] = a.value ? code.slice(a.value.start, a.value.end) : 'true';
    }
    const role = (attrs.role ?? '').replace(/["'{}]/g, '');
    const clickable = /^(button|summary)$/.test(tag) || 'onClick' in attrs || /^(button|tab|option|menuitem)$/.test(role);
    if (!clickable || 'onMouseEnter' in attrs || 'onPointerEnter' in attrs) return;
    if (/hover/.test(expand(attrs.className ?? ''))) return;
    const line = lineAt(code, n.start);
    if (noted(lines, line - 1)) return;
    report(file, line, `clickable <${tag}> has no hover: add hover-lift (or a \`hover:\` note saying where it lives)`);
  });
}

// ── Mac ─────────────────────────────────────────────────────────────────────

const MAC_HOVER =
  /applyMeetHoverLift|applyQuietButton|trackMeetHover|applySecondaryButton|applyMeetFilledStyle|applyMeetControlStyle|applyHomeRow|scrimButton|meetHoverMonitor/;
// Defines the helpers; its own controls install hover in their initialisers.
const MAC_HELPERS = 'Sources/DesignSystem.swift';

for (const file of walk(join(repoRoot, 'Sources'), (n) => n.endsWith('.swift'))) {
  const rel = relative(repoRoot, file);
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  if (rel !== MAC_HELPERS) {
    lines.forEach((l, i) => {
      if (!/isBordered = false/.test(l) || noted(lines, i)) return;
      const receiver = l.trim().replace(/\.?isBordered = false.*/, '');
      const window = lines.slice(Math.max(0, i - 8), i + 31);
      const ok = window.some((w) => MAC_HOVER.test(w) && (receiver === '' || receiver === 'self' || w.includes(receiver)));
      if (!ok) report(file, i + 1, 'borderless button with no hover: applyQuietButton or applyMeetHoverLift');
    });
  }
  const clicks = lines.findIndex((l) => /override func mouse(Down|Up)\(|NSClickGestureRecognizer\(/.test(l));
  if (clicks >= 0 && !MAC_HOVER.test(text) && !NOTE.test(text)) {
    report(file, clicks + 1, 'takes clicks but references no hover helper');
  }
}

// ── iOS ─────────────────────────────────────────────────────────────────────

const IOS_MARK = /meetHover|meetHomeRow|meetPointerHighlight|hoverEffect|\/\/ hover:/;
const IOS_STYLE_HOVER = /onHover|hoverEffect|meetHover|meetPlain|meetPointerHighlight|\/\/ hover:/;

for (const file of walk(join(repoRoot, 'iOS'), (n) => n.endsWith('.swift'))) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (/^\s*\/\//.test(l) || !/buttonStyle\(\.plain\)|[^A-Za-z]PlainButtonStyle\(\)|\.onTapGesture/.test(l)) return;
    if (lines.slice(Math.max(0, i - 3), i + 4).some((w) => IOS_MARK.test(w))) return;
    report(file, i + 1, 'tappable without pointer hover: .buttonStyle(.meetPlain), .meetHoverLift or .meetPointerHighlight');
  });
  for (let i = 0; i < lines.length; i++) {
    if (!/struct \w+: (Primitive)?ButtonStyle|struct \w+: ToggleStyle/.test(lines[i])) continue;
    const start = i;
    let hover = false;
    for (i++; i < lines.length && !/^}/.test(lines[i]); i++) hover ||= IOS_STYLE_HOVER.test(lines[i]);
    if (!hover) report(file, start + 1, 'style without hover: wire onHover / hoverEffect in its body');
  }
}

if (problems.length) {
  console.error(`Clickable without pointer feedback (AGENTS.md 18, docs/DESIGN.md "Hover"):\n${problems.join('\n')}`);
  process.exit(1);
}
