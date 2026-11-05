#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
// The router is `index.ts` and the route table's families under `routes/`.
const srcDir = resolve(repoRoot, 'services/control-plane/src');
const sourcePaths = [
  resolve(srcDir, 'index.ts'),
  ...(await readdir(resolve(srcDir, 'routes'))).filter((name) => name.endsWith('.ts')).sort().map((name) => resolve(srcDir, 'routes', name)),
];
let source = '';

function skipQuoted(sourceText, index) {
  const quote = sourceText[index];
  let escaped = false;
  for (let cursor = index + 1; cursor < sourceText.length; cursor += 1) {
    const char = sourceText[cursor];
    if (escaped) escaped = false;
    else if (char === '\\') escaped = true;
    else if (char === quote) return cursor + 1;
  }
  return sourceText.length;
}

function skipComment(sourceText, index) {
  if (sourceText[index + 1] === '/') {
    const end = sourceText.indexOf('\n', index + 2);
    return end === -1 ? sourceText.length : end + 1;
  }
  if (sourceText[index + 1] === '*') {
    const end = sourceText.indexOf('*/', index + 2);
    return end === -1 ? sourceText.length : end + 2;
  }
  return index;
}

function skipTrivia(sourceText, index) {
  let cursor = index;
  while (cursor < sourceText.length) {
    if (/\s/u.test(sourceText[cursor])) cursor += 1;
    else if (sourceText[cursor] === '/' && (sourceText[cursor + 1] === '/' || sourceText[cursor + 1] === '*')) {
      cursor = skipComment(sourceText, cursor);
    } else break;
  }
  return cursor;
}

function scanDelimited(sourceText, openingIndex) {
  const openToClose = new Map([['(', ')'], ['{', '}'], ['[', ']']]);
  const stack = [openToClose.get(sourceText[openingIndex])];
  let cursor = openingIndex + 1;
  while (cursor < sourceText.length && stack.length > 0) {
    const char = sourceText[cursor];
    if (char === '"' || char === "'" || char === '`') cursor = skipQuoted(sourceText, cursor);
    else if (char === '/' && (sourceText[cursor + 1] === '/' || sourceText[cursor + 1] === '*')) {
      cursor = skipComment(sourceText, cursor);
    } else if (openToClose.has(char)) {
      stack.push(openToClose.get(char));
      cursor += 1;
    } else if (char === stack.at(-1)) {
      stack.pop();
      cursor += 1;
    } else cursor += 1;
  }
  return cursor;
}

function topLevelComma(sourceText) {
  const stack = [];
  const openToClose = new Map([['(', ')'], ['{', '}'], ['[', ']']]);
  for (let cursor = 0; cursor < sourceText.length; cursor += 1) {
    const char = sourceText[cursor];
    if (char === '"' || char === "'" || char === '`') cursor = skipQuoted(sourceText, cursor) - 1;
    else if (char === '/' && (sourceText[cursor + 1] === '/' || sourceText[cursor + 1] === '*')) {
      cursor = skipComment(sourceText, cursor) - 1;
    } else if (openToClose.has(char)) stack.push(openToClose.get(char));
    else if (char === stack.at(-1)) stack.pop();
    else if (char === ',' && stack.length === 0) return cursor;
  }
  return sourceText.length;
}

function hasTopLevelSatisfies(expression) {
  const stack = [];
  const openToClose = new Map([['(', ')'], ['{', '}'], ['[', ']']]);
  for (let cursor = 0; cursor < expression.length;) {
    const char = expression[cursor];
    if (char === '"' || char === "'" || char === '`') cursor = skipQuoted(expression, cursor);
    else if (char === '/' && (expression[cursor + 1] === '/' || expression[cursor + 1] === '*')) {
      cursor = skipComment(expression, cursor);
    } else if (openToClose.has(char)) {
      stack.push(openToClose.get(char));
      cursor += 1;
    } else if (char === stack.at(-1)) {
      stack.pop();
      cursor += 1;
    } else if (stack.length === 0 && expression.startsWith('satisfies', cursor) &&
        !/[\w$]/u.test(expression[cursor - 1] ?? '') && !/[\w$]/u.test(expression[cursor + 9] ?? '')) {
      return true;
    } else cursor += 1;
  }
  return false;
}

function isErrorBody(expression) {
  return /^\s*\{\s*(?:error|['"]error['"])\s*:/u.test(expression);
}

function isSuccessfulStatus(expression) {
  const status = expression.trim();
  if (!status) return true;
  if (/^\d+$/u.test(status)) return Number(status) >= 200 && Number(status) < 300;
  const conditional = status.match(/^.*\?.*:\s*(\d+)\s*$/su);
  if (conditional) {
    const separator = status.lastIndexOf(':');
    const branches = [status.slice(status.indexOf('?') + 1, separator).trim(), status.slice(separator + 1).trim()];
    return branches.every((branch) => /^\d+$/u.test(branch) && Number(branch) >= 200 && Number(branch) < 300);
  }
  return true;
}

function lineAt(index) {
  return source.slice(0, index).split('\n').length;
}

const failures = [];
for (const sourcePath of sourcePaths) {
  source = await readFile(sourcePath, 'utf8');
  const file = sourcePath.slice(repoRoot.length);
  for (let cursor = 0; cursor < source.length;) {
    const char = source[cursor];
    if (char === '"' || char === "'" || char === '`') cursor = skipQuoted(source, cursor);
    else if (char === '/' && (source[cursor + 1] === '/' || source[cursor + 1] === '*')) {
      cursor = skipComment(source, cursor);
    } else if (/[A-Za-z_$]/u.test(char)) {
      const start = cursor;
      cursor += 1;
      while (/[\w$]/u.test(source[cursor] ?? '')) cursor += 1;
      if (source.slice(start, cursor) !== 'json' || /[\w$]/u.test(source[start - 1] ?? '')) continue;
      const opening = skipTrivia(source, cursor);
      if (source[opening] !== '(') continue;
      const end = scanDelimited(source, opening);
      const args = source.slice(opening + 1, end - 1);
      const comma = topLevelComma(args);
      const body = args.slice(0, comma);
      const status = comma < args.length ? args.slice(comma + 1).trim() : '';
      if ((body.trim() === 'body' && status === 'status') || isErrorBody(body) ||
          !isSuccessfulStatus(status) || hasTopLevelSatisfies(body)) {
        cursor = end;
        continue;
      }
      failures.push(`${file}:${lineAt(start)}`);
      cursor = end;
    } else cursor += 1;
  }
}

if (failures.length > 0) {
  console.error(`Worker success json() calls missing a top-level satisfies contract (${failures.length}):`);
  for (const where of failures) console.error(`  ${where}`);
  process.exitCode = 1;
} else {
  console.log('Every success json() response in the Worker route names its contract with satisfies.');
}
