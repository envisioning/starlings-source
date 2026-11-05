#!/usr/bin/env node
/**
 * Parity gate: every route a client calls exists on the Worker, with
 * the method the Worker takes.
 *
 * The three clients write their paths by hand: the Mac's `MeetingControlAPI`,
 * the iPhone's `StarlingsAPI` (and the few files that call the Worker themselves),
 * and the web's `apiFetch` calls; the MCP tools call it too. Nothing used to
 * check that the Worker has the
 * route, or takes that method; was iOS sending `POST` to a `PUT` route
 * for weeks. This is the cheap guard. The full answer, one route table that
 * generates the clients, is.
 *
 * What it does:
 *   1. Reads every `(method, path)` the Worker's router answers: the rows of
 *      the route table (`services/control-plane/src/routes/*.ts`).
 *      `extractWorkerRoutes` still reads `index.ts` branch by branch (each `if`
 *      with its condition, its body and the `if`s inside it), for a route
 *      somebody writes there instead of in the table; there are none today.
 *      It writes them to `fixtures/routes.json`.
 *   2. Reads every `(method, path)` the Swift files, the web and `mcp.ts` call.
 *   3. Fails on a client pair the Worker does not have, printing file and line.
 *
 * Usage:
 *   node scripts/check-client-routes.mjs --check   inventory is current, no client calls a missing route
 *   node scripts/check-client-routes.mjs --write   rewrite fixtures/routes.json, then check
 *   node scripts/check-client-routes.mjs           check parity only
 *
 * Limits, on purpose (it is a guard, not a type system):
 *   - A branch whose method is decided inside its block (`messageMatch`: POST
 *     on one suffix, PATCH on another) is the path with the union of the
 *     methods named in the block. A wrong method on such a path can pass.
 *   - A path segment the client builds at run time (`kind.rawValue`) is a
 *     wildcard: it reaches whatever the Worker has in that place, literal or not.
 *   - A path the script cannot read at all is an error, not a skip: it goes on
 *     `UNPARSEABLE` below with its reason, or the run fails.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventoryPath = path.join(root, 'fixtures/routes.json');

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

// ---------------------------------------------------------------------------
// What the script cannot read, and why. A key is `<file>::<what the call passes>`.
// ---------------------------------------------------------------------------

/**
 * Client calls whose path is built at run time, each with the Worker route it
 * reaches (checked against the inventory) or `null` when it is no route.
 */
export const UNPARSEABLE = new Map([
  // The Worker hands back the upload path in the `attachments` response, and the
  // clients send the bytes to it: the PUT half of the attachment pair.
  ['Sources/StarlingsThreadRoutes.swift::trimmed.split(separator: "/").map(String.init)', { route: 'PUT /api/threads/{}/attachments/{}', why: 'the upload path the Worker returned' }],
  ['web/src/ThreadPane.tsx::staged.upload_path.replace(/^\\/api/u, \'\')', { route: 'PUT /api/threads/{}/attachments/{}', why: 'the upload path the Worker returned' }],
  ['web/src/api.ts::path', { route: null, why: 'apiFetch handing its own argument to apiFetchConditional' }],
  // The shared route builder: each `StarlingsRoute` is read where it is
  // declared, in the area's routes file under Sources/.
  ['Sources/StarlingsHTTPTransport.swift::route', { route: null, why: 'StarlingsHTTPTransport building the request for a StarlingsRoute' }],
]);

/**
 * Calls the Worker refuses today, each tied to the issue that fixes the call.
 * The gate fails when one of these stops being a mismatch, so the fix removes
 * its line. Key: `<file> <METHOD> <path>`.
 */
export const KNOWN_BREAKS = new Map([
]);

/**
 * Worker routes the router answers outside the route table and `index.ts`'s
 * own branches. None today: the three proxies in `schedule-proxy.ts` are rows
 * in `routes/booking.ts`. An entry's `needle` must still appear in its file,
 * so a rename there is a failure here.
 */
export const OTHER_WORKER_ROUTES = [
];

/**
 * Router branches the reader handles by hand: a prefix owner that sends
 * the rest to a Durable Object or splits the path itself, so no branch names
 * the full path. `needle` must still appear in `index.ts`.
 */
export const MANUAL_INDEX_ROUTES = [
];

// ---------------------------------------------------------------------------
// Reading JavaScript and TypeScript without a parser. The compiler the repo
// carries (TypeScript 7) has no synchronous syntax-tree API, so the scripts
// that read source here (this one, `mcp-discovery.mjs`) scan it: `maskJs`
// blanks strings, templates, regexes and comments so brackets can be matched
// without a quoted `}` getting in the way, and the readers slice the original
// text at the same offsets.
// ---------------------------------------------------------------------------

/** `text` with the inside of every string, template, regex and comment blanked. Same length. */
export function maskJs(text) {
  const out = text.split('');
  const blank = (from, to) => { for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  const n = text.length;

  function skipString(start) {
    const quote = text[start];
    let i = start + 1;
    while (i < n && text[i] !== quote && text[i] !== '\n') { if (text[i] === '\\') i += 1; i += 1; }
    // A quote with no partner on its line is JSX text (`don't`), not a string.
    return text[i] === quote ? i : -1;
  }
  function skipTemplate(start) {
    let i = start + 1;
    while (i < n) {
      const c = text[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') return i;
      if (c === '$' && text[i + 1] === '{') { i = skipBraces(i + 1); continue; }
      i += 1;
    }
    return n - 1;
  }
  function skipBraces(open) {
    let depth = 0;
    let i = open;
    while (i < n) {
      const c = text[i];
      if (c === '"' || c === "'") { const end = skipString(i); i = end < 0 ? i + 1 : end + 1; continue; }
      if (c === '`') { i = skipTemplate(i) + 1; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') { depth -= 1; if (depth === 0) return i + 1; }
      i += 1;
    }
    return n;
  }

  let prev = '';
  let prevWord = '';
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { const end = text.indexOf('\n', i); const to = end < 0 ? n : end; blank(i, to); i = to; continue; }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); const to = end < 0 ? n : end + 2; blank(i, to); i = to; continue; }
    if (c === '"' || c === "'") {
      const end = skipString(i);
      if (end < 0) { prev = c; i += 1; continue; }
      blank(i + 1, end); prev = c; i = end + 1; continue;
    }
    if (c === '`') { const end = skipTemplate(i); blank(i + 1, end); prev = c; i = end + 1; continue; }
    if (c === '/' && (prev === '' || '(,=:[!&|?{};'.includes(prev) || prevWord === 'return')) {
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j += 1;
      }
      if (text[j] === '/') { blank(i + 1, j); i = j + 1; while (/[a-z]/u.test(text[i] ?? '')) i += 1; prev = '/'; prevWord = ''; continue; }
    }
    if (!/\s/u.test(c)) {
      prev = c;
      if (/[A-Za-z_$]/u.test(c)) { const word = /^[A-Za-z_$][\w$]*/u.exec(text.slice(i))[0]; prevWord = word; i += word.length; prev = word.at(-1); continue; }
      prevWord = '';
    }
    i += 1;
  }
  return out.join('');
}

/** Index of the bracket that closes the one at `open`, in masked text. -1 when there is none. */
export function matchBracket(masked, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  for (let i = open; i < masked.length; i += 1) {
    const c = masked[i];
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** `text` split on top-level occurrences of `separator` (`,` `&&` `||`), by masked offsets. */
export function splitOn(text, masked, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const c = masked[i];
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (depth === 0 && masked.startsWith(separator, i)) {
      // `||` is not the tail of `|||`; `&&` is not `&&&`. Neither occurs here.
      parts.push(text.slice(start, i));
      i += separator.length - 1;
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim());
}

// ---------------------------------------------------------------------------
// Patterns. A route is `METHOD /api/a/{}/b`: `{}` is one dynamic segment.
// ---------------------------------------------------------------------------

export const ABSENT = Symbol('absent');
export const PRESENT = Symbol('present');

/**
 * A Worker regex, as the patterns it accepts. `pins` fixes capture groups:
 * `{ 2: '/sync' }` the group's text, `{ 2: ABSENT }` that it did not match,
 * `{ 2: PRESENT }` that it did (as itself).
 */
export function expandRegex(source, pins = {}) {
  const body = source.replace(/^\^/u, '').replace(/\$$/u, '');
  let index = 0;
  let groupCount = 0;
  const mark = (group) => String.fromCharCode(1 + group);

  function pinned(group) {
    const pin = pins[group];
    if (pin === undefined) return null;
    if (pin === ABSENT) return [mark(group)];
    return [`${mark(group)}${pin === PRESENT ? '{}' : pin}`];
  }

  function parseSequence(stop) {
    let results = [''];
    while (index < body.length && !stop(body[index])) {
      const char = body[index];
      if (char === '(') {
        const capturing = body[index + 1] !== '?';
        index += capturing ? 1 : 3; // `(` or `(?:`
        const group = capturing ? (groupCount += 1) : 0;
        const alternatives = [parseSequence((c) => c === '|' || c === ')')];
        while (body[index] === '|') {
          index += 1;
          alternatives.push(parseSequence((c) => c === '|' || c === ')'));
        }
        index += 1; // `)`
        let options = alternatives.flat();
        if (capturing) {
          const fixed = pinned(group);
          if (fixed) options = fixed;
          else if (options.length > 1 && options.every((option) => /^[A-Za-z0-9_./-]+$/u.test(option))) {
            // A literal alternation (`messages|read|mute`): each one is its own route.
          } else if (options.length === 1 && /^[A-Za-z0-9_./-]+$/u.test(options[0])) {
            // A literal in parentheses stays that literal.
          } else options = ['{}'];
        }
        if (body[index] === '?') { index += 1; options = ['', ...options]; }
        results = results.flatMap((prefix) => options.map((option) => prefix + option));
      } else if (char === '[') {
        // A character class and its quantifier: one dynamic piece.
        index = body.indexOf(']', index + 1) + 1;
        if (body[index] === '{') index = body.indexOf('}', index) + 1;
        else if (body[index] === '+' || body[index] === '*' || body[index] === '?') index += 1;
        results = results.map((prefix) => `${prefix}{}`);
      } else if (char === '\\') {
        const next = body[index + 1];
        index += 2;
        if (next === '/' || next === '.' || next === '-') {
          results = results.map((prefix) => prefix + next);
        } else {
          // `\d`, `\w`…: a dynamic character.
          if (body[index] === '{') index = body.indexOf('}', index) + 1;
          else if (body[index] === '+' || body[index] === '*') index += 1;
          results = results.map((prefix) => `${prefix}{}`);
        }
      } else if (char === '.') {
        index += 1;
        if (body[index] === '*' || body[index] === '+') index += 1;
        results = results.map((prefix) => `${prefix}{}`);
      } else {
        index += 1;
        results = results.map((prefix) => prefix + char);
      }
    }
    return results;
  }

  let patterns = parseSequence(() => false);
  for (const [group, pin] of Object.entries(pins)) {
    const wanted = pin !== ABSENT;
    patterns = patterns.filter((pattern) => pattern.includes(mark(Number(group))) === wanted);
  }
  // eslint-disable-next-line no-control-regex
  return [...new Set(patterns.map((pattern) => pattern.replace(/[\u0001-\u001f]/gu, '').replace(/\/+$/u, '').replace(/(\{\})+/gu, '{}')))];
}

const segments = (pattern) => pattern.split('/').filter((part) => part !== '');

/** Does a client path (`{}` = built at run time) reach a Worker pattern? */
export function pathReaches(workerPattern, clientPath) {
  const worker = segments(workerPattern);
  const client = segments(clientPath);
  if (worker.length !== client.length) return false;
  // A segment either side builds at run time reaches whatever the other has there.
  return worker.every((part, i) => part === '{}' || client[i] === '{}' || part === client[i]);
}

// ---------------------------------------------------------------------------
// The Worker's routes.
// ---------------------------------------------------------------------------

/**
 * A Worker condition as alternatives, each `{ methods, paths }`: `methods` a
 * Set (null when the condition names none), `paths` the patterns it matches
 * (null when it names no route), `dispatcher` when it tests a prefix (the
 * branches inside carry the routes).
 */
function conditionAlternatives(text, context) {
  let source = text.trim();
  let masked = maskJs(source);
  // Strip parentheses that wrap the whole condition.
  while (source.startsWith('(') && matchBracket(masked, 0) === source.length - 1) {
    source = source.slice(1, -1).trim();
    masked = maskJs(source);
  }
  const ors = splitOn(source, masked, '||');
  if (ors.length > 1) return ors.flatMap((part) => conditionAlternatives(part, context));
  const ands = splitOn(source, masked, '&&');
  if (ands.length > 1) {
    return ands.map((part) => conditionAlternatives(part, context)).reduce(
      (left, right) => left.flatMap((a) => right.map((b) => mergeAlternatives(a, b))),
    );
  }
  return [atomAlternative(source, context)];
}

function intersect(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return a.filter((pattern) => b.includes(pattern));
}

function mergeAlternatives(a, b) {
  return {
    methods: a.methods && b.methods ? new Set([...a.methods].filter((method) => b.methods.has(method))) : a.methods ?? b.methods,
    paths: intersect(a.paths, b.paths),
    dispatcher: a.dispatcher || b.dispatcher,
    refines: a.refines || b.refines,
  };
}

function atomAlternative(atom, context) {
  const { matchVars, aliasAt, tailPrefixes } = context;
  const none = { methods: null, paths: null };
  let m = atom.match(/^request\.method\s*===\s*'([A-Z]+)'$/u) ?? atom.match(/^'([A-Z]+)'\s*===\s*request\.method$/u);
  if (m) return { methods: new Set([m[1]]), paths: null };
  m = atom.match(/^path\s*===\s*'([^']*)'$/u);
  if (m) return { methods: null, paths: m[1].startsWith('/api/') ? [m[1]] : null };
  m = atom.match(/^tail\s*===\s*'([^']*)'$/u);
  if (m) return { methods: null, paths: tailPrefixes().map((prefix) => `${prefix}${m[1]}`.replace(/\/+$/u, '')), refines: true };
  // A capture group read through a name: `action === '/sync'`, `!action`, `id`.
  m = atom.match(/^(?:(!)\s*)?(\w+)(?:\s*===\s*'([^']*)')?$/u) ?? atom.match(/^(\w+)\[(\d+)\]\s*===\s*'([^']*)'$/u);
  if (m) {
    const direct = atom.match(/^(\w+)\[(\d+)\]\s*===\s*'([^']*)'$/u);
    if (direct && matchVars.has(direct[1])) {
      return { methods: null, paths: patternsOf(matchVars.get(direct[1]), tailPrefixes, { [Number(direct[2])]: direct[3] }), refines: true };
    }
    const [, bang, name, literal] = m;
    const alias = aliasAt(name);
    if (alias && direct === null) {
      const pin = literal !== undefined ? literal : bang ? ABSENT : PRESENT;
      return { methods: null, paths: patternsOf(matchVars.get(alias.variable), tailPrefixes, { [alias.group]: pin }), refines: true };
    }
    if (!bang && literal === undefined && matchVars.has(name)) {
      return { methods: null, paths: patternsOf(matchVars.get(name), tailPrefixes, {}) };
    }
  }
  if (/\bpath\.startsWith\(|\.test\(\s*path\s*\)|\btail\.startsWith\(/u.test(atom)) return { methods: null, paths: null, dispatcher: true };
  return none;
}

function patternsOf(variable, tailPrefixes, pins) {
  const patterns = expandRegex(variable.regex, pins);
  if (variable.base === 'path') return patterns;
  return tailPrefixes().flatMap((prefix) => patterns.map((pattern) => `${prefix}${pattern}`.replace(/\/+$/u, '')));
}

/** The methods a block names with `request.method === 'X'`, `!==` included. */
function methodsNamedIn(text) {
  return new Set([...text.matchAll(/request\.method\s*(?:===|!==)\s*'([A-Z]+)'/gu)].map((match) => match[1]));
}

/** Every `(method, pattern)` the router answers, and the branches that name no method. */
export function extractWorkerRoutes(indexText, { manual = true } = {}) {
  const masked = maskJs(indexText);
  const code = (index, word) => masked.startsWith(word, index);

  // Every `if`, with its condition, its body, and the `if`s inside it.
  const ifs = [];
  for (const m of masked.matchAll(/(?<![.\w$])if\s*\(/gu)) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(masked, open);
    if (close < 0) continue;
    let rest = close + 1;
    while (/\s/u.test(masked[rest] ?? '')) rest += 1;
    let end;
    if (masked[rest] === '{') end = matchBracket(masked, rest) + 1;
    else {
      end = rest;
      let depth = 0;
      for (; end < masked.length; end += 1) {
        const c = masked[end];
        if ('([{'.includes(c)) depth += 1;
        else if (')]}'.includes(c)) depth -= 1;
        else if (c === ';' && depth === 0) break;
      }
    }
    ifs.push({ start: m.index, condition: indexText.slice(open + 1, close), bodyStart: rest, bodyEnd: end, children: [] });
  }
  /** `const x = path.match(/…/)`, and `tail.match(/…/)` for what follows a room or thread id. */
  const matchVars = new Map();
  const declaration = /\bconst\s+(\w+)\s*=\s*(path|tail)\.match\(\s*\/((?:[^/\n\\[]|\\.|\[(?:[^\]\\]|\\.)*\])+)\/[a-z]*/gu;
  for (const m of indexText.matchAll(declaration)) {
    if (!code(m.index, 'const')) continue;
    matchVars.set(m[1], { base: m[2], regex: m[3] });
  }
  /** The `if` body around an offset, the scope a `const` there lives in; null at the top of the router. */
  const scopeOf = (pos) => {
    let found = null;
    for (const node of ifs) {
      if (node.bodyStart <= pos && pos < node.bodyEnd && (!found || node.bodyEnd - node.bodyStart < found.bodyEnd - found.bodyStart)) found = node;
    }
    return found && { start: found.bodyStart, end: found.bodyEnd };
  };
  const inScope = (entry, pos) => entry.pos <= pos && (!entry.scope || (entry.scope.start <= pos && pos < entry.scope.end));
  /** `const [, a, b] = xMatch` and `const id = xMatch[2] ? …`: names for capture groups, in scope from here on. */
  const aliases = [];
  for (const m of indexText.matchAll(/\bconst\s+\[([^\]]*)\]\s*=\s*(\w+Match)\b/gu)) {
    if (!code(m.index, 'const') || !matchVars.has(m[2])) continue;
    m[1].split(',').forEach((name, group) => { if (name.trim()) aliases.push({ name: name.trim(), variable: m[2], group, pos: m.index, scope: scopeOf(m.index) }); });
  }
  for (const m of indexText.matchAll(/\bconst\s+(\w+)\s*=\s*(\w+Match)\[(\d+)\]\s*\?/gu)) {
    if (code(m.index, 'const') && matchVars.has(m[2])) aliases.push({ name: m[1], variable: m[2], group: Number(m[3]), pos: m.index, scope: scopeOf(m.index) });
  }
  /** Where `tail` starts to mean what: `const tail = roomMatch[2] ?? ''`. */
  const tailDeclarations = [];
  for (const m of indexText.matchAll(/\bconst\s+tail\s*=\s*([^;\n]+)/gu)) {
    if (!code(m.index, 'const')) continue;
    tailDeclarations.push({ pos: m.index, scope: scopeOf(m.index), via: m[1].match(/\b(\w+Match)\b/u)?.[1] ?? null });
  }
  const contextAt = (pos) => ({
    matchVars,
    aliasAt: (name) => aliases.filter((alias) => alias.name === name && inScope(alias, pos)).at(-1) ?? null,
    tailPrefixes: () => {
      const owner = tailDeclarations.filter((entry) => inScope(entry, pos)).at(-1);
      const variable = owner?.via ? matchVars.get(owner.via) : null;
      if (!variable) throw new Error(`check-client-routes: \`tail\` is used at index.ts line ${lineOf(indexText, pos)} with no match variable behind it.`);
      // Everything before the optional tail group: `^/api/rooms/([a-z0-9-]{2,40})`.
      return expandRegex(variable.regex.replace(/\(\?:\\\/\([^)]*\)\)\?\$$/u, '')).map((pattern) => `${pattern}/`);
    },
  });

  const roots = [];
  const stack = [];
  for (const node of ifs) { // `matchAll` yields them in source order
    while (stack.length > 0 && stack.at(-1).bodyEnd <= node.start) stack.pop();
    if (stack.length > 0 && node.start >= stack.at(-1).bodyStart) stack.at(-1).children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  const allInside = (node) => node.children.flatMap((child) => [child, ...allInside(child)]);

  const routes = new Set();
  function visit(node, inherited) {
    const own = conditionAlternatives(node.condition, contextAt(node.start));
    if (own.some((alt) => alt.dispatcher)) {
      for (const child of node.children) visit(child, inherited);
      return;
    }
    const merged = inherited.flatMap((a) => own.map((b) => mergeAlternatives(a, b)));
    const body = indexText.slice(node.bodyStart, node.bodyEnd);
    const inside = allInside(node);
    const methodTests = inside.some((child) => /request\.method/u.test(child.condition));
    const refiners = inside.some((child) => conditionAlternatives(child.condition, contextAt(child.start)).some((alt) => alt.refines || (alt.paths && alt.paths.length)));
    for (const alt of merged) {
      if (!alt.paths || alt.paths.length === 0) continue;
      // The branches inside say which method, or which part of the path: they carry the routes.
      if (alt.methods === null && methodTests) continue;
      if (refiners) continue;
      if (/\bconst\s+tail\b/u.test(body)) continue;
      let methods = alt.methods;
      if (!methods || methods.size === 0) {
        const named = methodsNamedIn(body);
        methods = named.size > 0 ? named : new Set(['*']);
      }
      for (const method of methods) {
        if (method === '*' || METHODS.includes(method)) for (const pattern of alt.paths) routes.add(`${method} ${pattern}`);
      }
    }
    for (const child of node.children) visit(child, merged.filter((alt) => alt.paths || alt.methods));
  }
  for (const root of roots) visit(root, [{ methods: null, paths: null }]);

  // A pattern with a named method does not also take every method: the bare
  // `if (match)` guard a later branch refines came out as `*`.
  const named = new Set([...routes].filter((route) => !route.startsWith('* ')).map((route) => route.slice(route.indexOf(' ') + 1)));
  for (const route of [...routes]) if (route.startsWith('* ') && named.has(route.slice(2))) routes.delete(route);

  const unresolved = [...routes].filter((route) => route.startsWith('* '));
  for (const entry of manual ? MANUAL_INDEX_ROUTES : []) {
    if (!indexText.includes(entry.needle)) throw new Error(`check-client-routes: MANUAL_INDEX_ROUTES expects \`${entry.needle}\` in index.ts; the router changed.`);
    for (const route of entry.routes) routes.add(route);
  }
  return { routes: [...routes].sort(), unresolved };
}

/**
 * The route table's rows, read as text: `method: 'GET',` (or a list) and then
 * `path: '/api/x/:id',` on the next line, the format `route-types.ts` asks
 * rows to keep. `:name` becomes `{}`, except where the row's `params` makes it
 * a fixed set of words (`kind: { re: 'lead|project', … }`): that is one route
 * per word, as the inventory has always listed a regex alternation. HEAD is
 * not a route a client calls, so a row that takes it records the other methods.
 */
export function extractTableRoutes(text) {
  const routes = new Set();
  for (const chunk of text.split(/\bdefineRoute\(\{/u).slice(1)) {
    const row = /\bmethod:\s*(\[[^\]]*\]|'[A-Z]+'),\s*path:\s*'([^']+)'/u.exec(chunk);
    if (!row) continue;
    const methods = [...row[1].matchAll(/'([A-Z]+)'/gu)].map((m) => m[1]).filter((method) => method !== 'HEAD' && method !== 'OPTIONS');
    const words = new Map();
    for (const param of chunk.slice(row.index).matchAll(/\b(\w+):\s*\{\s*re:\s*'([a-z_-]+(?:\|[a-z_-]+)+)'/gu)) words.set(param[1], param[2].split('|'));
    let patterns = [row[2]];
    for (const [name, options] of words) patterns = patterns.flatMap((pattern) => pattern.includes(`:${name}`) ? options.map((word) => pattern.replace(`:${name}`, word)) : [pattern]);
    for (const method of methods) for (const pattern of patterns) routes.add(`${method} ${pattern.replace(/:\w+/gu, '{}')}`);
  }
  return [...routes].sort();
}

export function readWorkerInventory() {
  const indexText = readFileSync(path.join(root, 'services/control-plane/src/index.ts'), 'utf8');
  const { routes, unresolved } = extractWorkerRoutes(indexText);
  const all = new Set(routes);
  const familiesDir = path.join(root, 'services/control-plane/src/routes');
  for (const name of readdirSync(familiesDir).filter((file) => file.endsWith('.ts')).sort()) {
    for (const route of extractTableRoutes(readFileSync(path.join(familiesDir, name), 'utf8'))) all.add(route);
  }
  for (const other of OTHER_WORKER_ROUTES) {
    const text = readFileSync(path.join(root, other.file), 'utf8');
    if (!text.includes(other.needle)) throw new Error(`check-client-routes: OTHER_WORKER_ROUTES expects \`${other.needle}\` in ${other.file}; the router changed.`);
    for (const route of other.routes) all.add(route);
  }
  return { routes: [...all].sort(), unresolved };
}

// ---------------------------------------------------------------------------
// The clients: Swift.
// ---------------------------------------------------------------------------

/** Positions of every `(` and its matching `)`, skipping strings and comments. */
function swiftParens(text) {
  const pairs = [];
  const stack = [];
  let i = 0;
  const skipString = () => {
    // At the opening quote. Handles `"""` and `\(…)` interpolation.
    const triple = text.startsWith('"""', i);
    i += triple ? 3 : 1;
    while (i < text.length) {
      if (text[i] === '\\') {
        if (text[i + 1] === '(') {
          i += 2;
          let depth = 1;
          while (i < text.length && depth > 0) {
            if (text[i] === '"') { skipString(); continue; }
            if (text[i] === '(') depth += 1;
            else if (text[i] === ')') depth -= 1;
            i += 1;
          }
          continue;
        }
        i += 2;
        continue;
      }
      if (triple ? text.startsWith('"""', i) : text[i] === '"') { i += triple ? 3 : 1; return; }
      i += 1;
    }
  };
  while (i < text.length) {
    const char = text[i];
    if (char === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (char === '/' && text[i + 1] === '*') { i = text.indexOf('*/', i + 2); i = i < 0 ? text.length : i + 2; continue; }
    if (char === '"') { skipString(); continue; }
    if (char === '(') stack.push(i);
    else if (char === ')') { const open = stack.pop(); if (open !== undefined) pairs.push({ open, close: i }); }
    i += 1;
  }
  return pairs;
}

/** Splits `text` on top-level commas. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i += 1; i += 1; }
      continue;
    }
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

function matchingBracket(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i += 1; i += 1; }
      continue;
    }
    if (char === '[') depth += 1;
    else if (char === ']') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Every `path: ["a", id, "b"]` in a Swift file, with the `method:` of its call.
 * An element that is not a string literal is a run-time segment (`{}`).
 */
export function extractSwiftCalls(text, file) {
  const pairs = swiftParens(text);
  const calls = [];
  const client = file.startsWith('iOS/') ? 'iOS' : 'Mac';
  const pathOf = (elements) => `/api/${elements.map((element) => (/^"[^"\\]*"$/u.test(element) ? element.slice(1, -1) : '{}')).join('/')}`;
  const dynamicIn = (elements) => elements.find((element) => /\.split\(/u.test(element));
  const methodsIn = (args) => {
    for (const arg of args) {
      const named = arg.match(/^method:\s*(.+)$/su);
      if (named) return splitTernary(named[1]).map((arm) => { const literal = arm.trim().match(/^"([A-Z]+)"$/u); return literal ? literal[1] : `?${arm.trim()}`; });
    }
    return null;
  };
  const add = (index, elements, methods) => {
    const dynamic = dynamicIn(elements);
    const record = {
      file, line: lineOf(text, index), client,
      path: dynamic ? null : pathOf(elements),
      unparseable: dynamic ? `${file}::${dynamic}` : null,
    };
    for (const method of methods ?? [null]) calls.push({ ...record, method });
  };
  /** The method a request built from a URL a few lines on names: `httpMethod = "POST"`, `method: "GET"`, or a socket. */
  const methodsAfter = (index) => {
    const window = text.slice(index, index + 700);
    const named = window.match(/\bhttpMethod\s*=\s*"([A-Z]+)"|\bmethod:\s*"([A-Z]+)"/u);
    if (named) return [named[1] ?? named[2]];
    return /\bwebSocketTask\b/u.test(window) ? ['GET'] : null;
  };

  // 1. `path: ["a", id, "b"]` and `path: namedArray`, in a call that names its `method:`.
  for (const match of text.matchAll(/\bpath:\s*(\[|[A-Za-z_]\w*\b)/gu)) {
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    const before = text.slice(lineStart, match.index + match[0].length);
    // A declaration (`var path: [Destination]`, `path: [String]`, `path: String`) is a type, not a route.
    if (/\b(?:var|let)\s+path\s*:\s*(?:\[|\w)/u.test(before)) continue;
    const split = text.slice(match.index).match(/^path:\s*([\w.]+\.split\(separator: "\/"\)\.map\(String\.init\))/u);
    if (split) {
      // The path the Worker handed back (an upload URL): built from a string, not an array.
      const open = match.index + match[0].length;
      let owner = null;
      for (const pair of pairs) if (pair.open < open && pair.close > open && (!owner || pair.close - pair.open < owner.close - owner.open)) owner = pair;
      const methods = owner ? methodsIn(splitTopLevel(text.slice(owner.open + 1, owner.close))) : null;
      for (const method of methods ?? [null]) {
        calls.push({ file, line: lineOf(text, match.index), client, method, path: null, unparseable: `${file}::${split[1]}` });
      }
      continue;
    }
    let call = null;
    const open = match.index + match[0].length - (match[1] === '[' ? 1 : match[1].length);
    for (const pair of pairs) {
      if (pair.open < open && pair.close > open && (!call || pair.close - pair.open < call.close - call.open)) call = pair;
    }
    let elementsText;
    let close;
    if (match[1] === '[') {
      if (text.slice(open + 1, open + 8).startsWith('String]')) continue; // a parameter declaration
      close = matchingBracket(text, open);
      elementsText = text.slice(open + 1, close);
    } else {
      const name = match[1];
      const defaults = ['String', 'URL', 'Bool', 'Int', 'true', 'false', 'nil'];
      if (defaults.includes(name)) continue;
      // `.appending(path: room)` is the chain below; a call that names no `method:` is not a request builder.
      if (/\.appending\($/u.test(text.slice(Math.max(0, match.index - 12), match.index))) continue;
      const enclosing = call ? methodsIn(splitTopLevel(text.slice(call.open + 1, call.close))) : null;
      const reads = call && /\bauthorizedSnapshotting\s*\($/u.test(text.slice(Math.max(0, call.open - 30), call.open + 1));
      if (enclosing === null && !reads) continue;
      // `let path = ["rooms", …]` a few lines up; a forwarding helper's own parameter is not one.
      const lets = [...text.slice(0, match.index).matchAll(new RegExp(`\\blet\\s+${name}\\s*=\\s*\\[`, 'gu'))];
      const last = lets.at(-1);
      const inHelper = new RegExp(`\\bfunc\\b[^{]*\\b${name}:\\s*\\[String\\]`, 'u').test(text.slice(Math.max(0, match.index - 900), match.index));
      if (!last || match.index - last.index > 700) {
        if (inHelper) continue;
        calls.push({ file, line: lineOf(text, match.index), client, method: null, path: null, unparseable: `${file}::${name}` });
        continue;
      }
      close = matchingBracket(text, last.index + last[0].length - 1);
      elementsText = text.slice(last.index + last[0].length, close);
    }
    const methods = call ? methodsIn(splitTopLevel(text.slice(call.open + 1, call.close))) : null;
    // `authorizedSnapshotting` is the iPhone's cached read: it takes no method because it is a GET.
    const snapshotting = call && /\bauthorizedSnapshotting\s*\($/u.test(text.slice(Math.max(0, call.open - 30), call.open + 1));
    add(match.index, splitTopLevel(elementsText), methods ?? (snapshotting ? ['GET'] : null));
  }

  // 2. An address built by hand: `["calendar", "events"].reduce(environment.apiBaseURL) { … }`.
  for (const match of text.matchAll(/\[((?:"[^"\n]*"|[^\]"\n])*)\]\s*\.reduce\(\s*[\w.]*apiBaseURL/gu)) {
    add(match.index, splitTopLevel(match[1]), methodsAfter(match.index + match[0].length) ?? ['GET']);
  }

  // 3. `apiBaseURL.appending(path: "auth").appending(path: "refresh")`, on one line or several.
  const chain = /[\w.]*(?:apiBaseURL|configuredAPIBase|\bapiBase)\s*((?:\.appending\(path:\s*[^)\n]*\)\s*)+)/gu;
  for (const match of text.matchAll(chain)) {
    const elements = [...match[1].matchAll(/\.appending\(path:\s*([^)\n]*)\)/gu)].flatMap((piece) => {
      const value = piece[1].trim();
      const literal = value.match(/^"([^"\\]*)"$/u);
      return literal ? literal[1].split('/').map((part) => `"${part}"`) : [value];
    });
    add(match.index, elements, methodsAfter(match.index + match[0].length) ?? ['GET']);
  }
  return calls;
}

// ---------------------------------------------------------------------------
// The clients: web.
// ---------------------------------------------------------------------------

/** End index (exclusive) of the template literal opening at `start`, or -1. */
function templateEnd(text, start) {
  let i = start + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i + 1;
    if (c === '$' && text[i + 1] === '{') {
      const close = matchBracket(maskJs(text.slice(i + 1)), 0);
      if (close < 0) return -1;
      i += close + 2;
      continue;
    }
    i += 1;
  }
  return -1;
}

/** `a ? b : c` as `[b, c]`; any other text as `[text]`. */
export function splitTernary(text) {
  const masked = maskJs(text);
  let depth = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const c = masked[i];
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === '?' && depth === 0 && masked[i + 1] !== '.' && masked[i + 1] !== '?' && masked[i - 1] !== '?') {
      let inner = 0;
      for (let j = i + 1; j < masked.length; j += 1) {
        const d = masked[j];
        if ('([{'.includes(d)) inner += 1;
        else if (')]}'.includes(d)) inner -= 1;
        else if (d === '?' && masked[j + 1] !== '.' && masked[j + 1] !== '?' && masked[j - 1] !== '?' && inner === 0) inner += 0;
        else if (d === ':' && inner === 0) return [text.slice(i + 1, j).trim(), text.slice(j + 1).trim()];
      }
    }
  }
  return [text.trim()];
}

/** The initializer of `const name = …;` in `text`, or null. */
function initializerOf(text, name) {
  const m = new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]+)?=\\s*`, 'u').exec(text);
  if (!m) return null;
  const start = m.index + m[0].length;
  const masked = maskJs(text);
  let depth = 0;
  for (let i = start; i < masked.length; i += 1) {
    const c = masked[i];
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) { if (depth === 0) return text.slice(start, i).trim(); depth -= 1; }
    else if (c === ';' && depth === 0) return text.slice(start, i).trim();
  }
  return null;
}

const stripComments = (text) => text.replace(/^\s*\/\/.*$/gmu, '').trim();

/**
 * The paths an expression can be, as `\u0000`-marked literals (each `${…}` is
 * one `\u0000`), or null when it is not a string we can read. A ternary is
 * both its arms; a name is its `const` in the same file; `a + b` is joined.
 */
function webPaths(expression, fileText, depth = 0) {
  const text = stripComments(expression);
  if (depth > 4) return null;
  const arms = splitTernary(text);
  if (arms.length === 2) {
    const both = arms.map((arm) => webPaths(arm, fileText, depth + 1));
    return both.every((arm) => arm !== null) ? both.flat() : null;
  }
  const masked = maskJs(text);
  const pieces = splitOn(text, masked, '+');
  if (pieces.length > 1) {
    const parts = pieces.map((piece) => webPaths(piece, fileText, depth + 1));
    if (parts.some((part) => part === null || part.length !== 1)) return null;
    return [parts.map((part) => part[0]).join('')];
  }
  if (/^['"]/u.test(text) && /^(['"])(.*)\1$/su.test(text)) return [text.slice(1, -1)];
  if (text.startsWith('`') && templateEnd(text, 0) === text.length) {
    let literal = '';
    for (let i = 1; i < text.length - 1;) {
      if (text[i] === '$' && text[i + 1] === '{') {
        const close = matchBracket(maskJs(text.slice(i + 1)), 0);
        literal += '\u0000';
        i += close + 2;
      } else { literal += text[i]; i += 1; }
    }
    return [literal];
  }
  if (/^[A-Za-z_$][\w$]*$/u.test(text)) {
    const initializer = initializerOf(fileText, text);
    return initializer === null ? null : webPaths(initializer, fileText, depth + 1);
  }
  return null;
}

/** `/api/a/{}/b` from a `/a/${x}/b?q` literal: the base is added, the query dropped, pieces become `{}`. */
function toApiPath(literal) {
  const clean = literal.split('?', 1)[0];
  if (clean.startsWith('\u0000')) return null; // opens with an interpolation: somebody else's string
  const parts = clean.split('/');
  const last = parts.length - 1;
  const mapped = parts.map((part, index) => {
    if (!part.includes('\u0000')) return part;
    // `sales-inbox${query}` at the end: the interpolation is the query or an optional suffix.
    if (index === last && /^[^\u0000]+\u0000$/u.test(part)) return part.slice(0, -1);
    return '{}';
  });
  return `/api${clean.startsWith('/') ? '' : '/'}${mapped.join('/')}`.replace(/\/+$/u, '');
}

/**
 * Every web call into the Worker: `apiFetch(path, { method })`,
 * `apiFetchConditional`, `apiUpload`, `apiObjectURL`, a bare
 * ``fetch(`${apiBase}/…`)`` and any other ``${apiBase}/…`` (an `<img src>`, a
 * link, a socket: GETs). The default method is the helper's: POST with a body.
 */
export function extractWebCalls(text, file) {
  const masked = maskJs(text);
  const calls = [];
  const push = (index, method, p, unparseable) => calls.push({ file, line: lineOf(text, index), method, path: p, unparseable, client: 'web' });

  /** The methods an options argument names; `fallback` 'BODY' is the helper's default. */
  function optionsMethods(optionsText, fallback, depth = 0) {
    let trimmed = stripComments(optionsText);
    if (/^[A-Za-z_$][\w$]*$/u.test(trimmed) && depth < 3) {
      const initializer = initializerOf(text, trimmed);
      if (initializer !== null) return optionsMethods(initializer, fallback, depth + 1);
    }
    if (!trimmed.startsWith('{')) return [`?${trimmed}`];
    const inner = trimmed.slice(1, -1);
    const entries = splitOn(inner, maskJs(inner), ',');
    let hasBody = false;
    for (const entry of entries) {
      const named = entry.match(/^method\s*:\s*([\s\S]+)$/u);
      if (named) {
        const arms = splitTernary(named[1]);
        return arms.map((arm) => { const literal = arm.match(/^(['"])([A-Za-z]+)\1$/u); return literal ? literal[2].toUpperCase() : `?${arm}`; });
      }
      if (/^body\b/u.test(entry)) hasBody = true;
      // `...options` spreads somebody else's object: its `method`, if any, is theirs.
      const spread = entry.match(/^\.\.\.\s*([A-Za-z_$][\w$]*)$/u);
      if (spread && depth < 3) {
        const initializer = initializerOf(text, spread[1]);
        if (initializer !== null && /\bmethod\s*:/u.test(initializer)) return optionsMethods(initializer, fallback, depth + 1);
      }
    }
    return fallback === 'BODY' ? [hasBody ? 'POST' : 'GET'] : [fallback];
  }

  /** One record per (path, method) the expressions can be; two ternaries on one condition pair up. */
  function emit(index, pathLiterals, methods, label, argText) {
    if (pathLiterals === null) { push(index, null, null, `${file}::${stripComments(argText)}`); return; }
    const apiPaths = pathLiterals.map(toApiPath);
    if (apiPaths.some((p) => p === null)) { push(index, null, null, `${file}::${stripComments(argText)}`); return; }
    if (apiPaths.length === methods.length && apiPaths.length > 1) {
      apiPaths.forEach((p, i) => push(index, methods[i], p, null));
    } else {
      for (const p of apiPaths) for (const method of methods) push(index, method, p, null);
    }
  }

  const helper = /(?<![.\w$])(apiFetchConditional|apiFetch|apiUpload|apiObjectURL)\s*(<)?/gu;
  for (const m of masked.matchAll(helper)) {
    let i = m.index + m[0].length;
    // Skip a type argument list: `apiFetch<{ a?: B[] }>(`.
    if (m[2]) {
      let depth = 1;
      while (i < masked.length && depth > 0) {
        if (masked[i] === '=' && masked[i + 1] === '>') i += 1;
        else if (masked[i] === '<') depth += 1;
        else if (masked[i] === '>') depth -= 1;
        i += 1;
      }
      while (/\s/u.test(masked[i] ?? '')) i += 1;
    }
    if (masked[i] !== '(') continue;
    if (/\bfunction\s+$/u.test(masked.slice(Math.max(0, m.index - 12), m.index))) continue; // a declaration
    const close = matchBracket(masked, i);
    const args = splitOn(text.slice(i + 1, close), masked.slice(i + 1, close), ',');
    if (args.length === 0 || args[0] === '') continue;
    const name = m[1];
    let methods;
    if (name === 'apiUpload') methods = ['PUT'];
    else if (name === 'apiObjectURL') methods = ['GET'];
    else methods = args[1] === undefined ? ['GET'] : optionsMethods(args[1], 'BODY');
    emit(m.index, webPaths(args[0], text), methods, name, args[0]);
  }

  // `${apiBase}/…` outside the helpers: a fetch (method in its options) or a plain GET.
  for (const m of text.matchAll(/`\$\{apiBase\}\//gu)) {
    if (masked[m.index] !== '`') continue;
    const end = templateEnd(text, m.index);
    const template = text.slice(m.index, end).replace(/^`\$\{apiBase\}/u, '`');
    const before = masked.slice(Math.max(0, m.index - 12), m.index);
    let methods = ['GET'];
    if (/\bfetch\s*\(\s*$/u.test(before)) {
      let j = end;
      while (/\s/u.test(masked[j] ?? '')) j += 1;
      if (masked[j] === ',') {
        const open = masked.indexOf('{', j);
        const options = text.slice(open, matchBracket(masked, open) + 1);
        methods = optionsMethods(options, 'GET');
      }
    }
    emit(m.index, webPaths(template, text), methods, 'fetch', template);
  }
  return calls;
}

// ---------------------------------------------------------------------------
// Comparing.
// ---------------------------------------------------------------------------

/**
 * Client calls with no Worker route behind them, and allowlist lines that no
 * longer earn their place. A call is `{ file, line, client, method, path,
 * unparseable }`.
 */
export function findMismatches(workerRoutes, calls, { unparseable = UNPARSEABLE, knownBreaks = KNOWN_BREAKS } = {}) {
  const parsed = workerRoutes.map((route) => {
    const space = route.indexOf(' ');
    return { method: route.slice(0, space), pattern: route.slice(space + 1) };
  });
  const problems = [];
  const usedUnparseable = new Set();
  const usedBreaks = new Set();
  for (const call of calls) {
    if (call.unparseable) {
      const entry = unparseable.get(call.unparseable);
      if (!entry) {
        problems.push({ call, why: `cannot read the path (${call.unparseable.split('::')[1]}); add it to UNPARSEABLE with the route it reaches` });
        continue;
      }
      usedUnparseable.add(call.unparseable);
      if (entry.route && !workerRoutes.includes(entry.route)) {
        problems.push({ call, why: `UNPARSEABLE says this reaches ${entry.route} (${entry.why}); the Worker has no such route` });
      } else if (entry.route && call.method && call.method !== entry.route.split(' ')[0]) {
        problems.push({ call, why: `UNPARSEABLE says this is ${entry.route}; the call sends ${call.method}` });
      }
      continue;
    }
    if (call.method === null) {
      problems.push({ call, why: `${call.path} has no method: the call names none` });
      continue;
    }
    if (call.method.startsWith('?')) {
      problems.push({ call, why: `${call.path}: the method is not a literal (${call.method.slice(1)}); the gate cannot read it` });
      continue;
    }
    const reaching = parsed.filter((route) => pathReaches(route.pattern, call.path));
    let why = null;
    if (reaching.length === 0) why = `no Worker route answers ${call.path}`;
    else if (!reaching.some((route) => route.method === call.method || route.method === '*')) {
      why = `${call.method} ${call.path}: the Worker takes ${[...new Set(reaching.map((route) => route.method))].join(', ')} there`;
    }
    if (why === null) continue;
    const key = `${call.file} ${call.method} ${call.path}`;
    if (knownBreaks.has(key)) { usedBreaks.add(key); continue; }
    problems.push({ call, why });
  }
  const stale = [
    ...[...unparseable.keys()].filter((key) => !usedUnparseable.has(key)).map((key) => `UNPARSEABLE line for ${key} matches no call; remove it`),
    ...[...knownBreaks.entries()].filter(([key]) => !usedBreaks.has(key)).map(([key, why]) => `KNOWN_BREAKS line "${key}" (${why}) is no longer a mismatch; remove it`),
  ];
  return { problems, stale };
}

// ---------------------------------------------------------------------------
// Files.
// ---------------------------------------------------------------------------

function walk(dir, accept, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, accept, out);
    else if (accept(full)) out.push(full);
  }
  return out;
}

/** The Swift calls of the tree at `base`: this checkout, or a release's sources. */
export function readSwiftCalls(base = root) {
  const calls = [];
  const rel = (file) => path.relative(base, file);
  const swiftDirs = ['Sources', 'iOS', 'iOSActivities', 'iOSShare'].map((dir) => path.join(base, dir)).filter((dir) => existsSync(dir));
  for (const dir of swiftDirs) {
    for (const file of walk(dir, (f) => f.endsWith('.swift'))) {
      const text = readFileSync(file, 'utf8');
      if (!/\bpath:\s*[\[A-Za-z]|apiBaseURL|configuredAPIBase|\bapiBase\b/u.test(text)) continue;
      calls.push(...extractSwiftCalls(text, rel(file)));
    }
  }
  return calls;
}

export function readClientCalls() {
  const calls = readSwiftCalls();
  const rel = (file) => path.relative(root, file);
  for (const file of ['web/src', 'web/marketing/src'].flatMap(dir => walk(path.join(root, dir), (f) => /\.tsx?$/u.test(f) && !/\.test\.tsx?$/u.test(f)))) {
    const text = readFileSync(file, 'utf8');
    if (!/apiFetch|apiUpload|apiObjectURL|apiBase/u.test(text)) continue;
    calls.push(...extractWebCalls(text, rel(file)));
  }
  return calls;
}

/** The MCP tools are a fourth client: `mcp.ts` calls the Worker's own routes, and `mcp-discovery.mjs` already lists them. */
export async function readMcpCalls() {
  const { readMcpRouteCalls } = await import('../web/scripts/mcp-discovery.mjs');
  const mcpText = readFileSync(path.join(root, 'services/control-plane/src/mcp.ts'), 'utf8');
  return (await readMcpRouteCalls()).map((call) => {
    const literal = call.path.split('{param}')[0];
    const index = mcpText.indexOf(literal);
    return {
      file: 'services/control-plane/src/mcp.ts', line: index < 0 ? 0 : lineOf(mcpText, index), client: 'MCP',
      method: call.method.toUpperCase(), path: call.path.replace(/\{param\}/gu, '{}'), unparseable: null,
    };
  });
}

// ---------------------------------------------------------------------------
// Released apps. The gate above checks the clients in this
// checkout. A released app keeps calling the routes it was built with until
// the person updates, and the server ships on a different clock:
// removed `POST /api/docs/token` while every released app still called it.
// `fixtures/app-routes.json` records the routes each released Mac and iOS
// app calls, by first and last version. The check refuses a route table that
// no longer answers a route some accepted app calls: an app at or above an
// env's `MIN_RECOMMENDED_VERSION_*`.
// ---------------------------------------------------------------------------

const appRoutesPath = path.join(root, 'fixtures/app-routes.json');
const wranglerPath = path.join(root, 'services/control-plane/wrangler.jsonc');
export const APP_CLIENTS = ['macos', 'ios'];
const FLOOR_VARS = { macos: 'MIN_RECOMMENDED_VERSION_MACOS', ios: 'MIN_RECOMMENDED_VERSION_IOS' };

/** Order two dotted versions; a missing part reads as 0. */
export function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/**
 * Which app a Swift file builds into, read from `project.yml`: each macOS or
 * iOS target's `sources` paths. A file shared by both targets is in both.
 * Test targets build no app the Worker sees, so they are left out.
 */
export function appTargetsOf(projectText) {
  const paths = { macos: [], ios: [] };
  const targets = projectText.split(/^targets:\s*$/mu)[1] ?? '';
  for (const block of targets.split(/^ {2}(?=[A-Za-z][\w-]*:\s*$)/mu)) {
    const name = /^([\w-]+):/u.exec(block)?.[1];
    if (!name || /Tests$/u.test(name)) continue;
    const platform = /^ {4}platform:\s*(\S+)/mu.exec(block)?.[1];
    const client = platform === 'macOS' ? 'macos' : platform === 'iOS' ? 'ios' : null;
    if (!client) continue;
    for (const match of block.matchAll(/^ {6}- path:\s*(\S+)/gmu)) paths[client].push(match[1].replace(/\/$/u, ''));
  }
  return (file) => APP_CLIENTS.filter((client) => paths[client].some((entry) => file === entry || file.startsWith(`${entry}/`)));
}

/** `METHOD path` per app for one tree's Swift calls. Calls the gate cannot read resolve through UNPARSEABLE, or drop. */
export function appRoutesOf(calls, clientsOf, { unparseable = UNPARSEABLE } = {}) {
  const byClient = Object.fromEntries(APP_CLIENTS.map((client) => [client, new Set()]));
  for (const call of calls) {
    let route = null;
    if (call.unparseable) route = unparseable.get(call.unparseable)?.route ?? null;
    else if (call.method && !call.method.startsWith('?')) route = `${call.method} ${call.path}`;
    if (!route) continue;
    for (const client of clientsOf(call.file)) byClient[client].add(route);
  }
  return Object.fromEntries(APP_CLIENTS.map((client) => [client, [...byClient[client]].sort()]));
}

/**
 * Adds one release to the record: a route it calls gets `last` = version (and
 * a new row starts at version); a route it no longer calls keeps its `last`.
 */
export function recordRelease(record, version, routesByClient) {
  const rows = record.routes.map((row) => ({ ...row }));
  const index = new Map(rows.map((row) => [`${row.client} ${row.route}`, row]));
  for (const client of APP_CLIENTS) {
    for (const route of routesByClient[client] ?? []) {
      const row = index.get(`${client} ${route}`);
      if (!row) {
        const added = { client, route, first: version, last: version };
        rows.push(added);
        index.set(`${client} ${route}`, added);
      } else if (compareVersions(version, row.last) > 0) row.last = version;
      else if (compareVersions(version, row.first) < 0) row.first = version;
    }
  }
  const releases = [...new Set([...(record.releases ?? []), version])].sort(compareVersions);
  rows.sort((a, b) => a.client.localeCompare(b.client) || a.route.localeCompare(b.route));
  return { ...record, releases, routes: rows };
}

/** Each env's floor per app, from wrangler.jsonc. An unset floor accepts every version. */
export function floorsOf(config) {
  const envs = [['top level', config.vars ?? {}], ...Object.entries(config.env ?? {}).map(([name, env]) => [`env.${name}`, env.vars ?? {}])];
  return Object.fromEntries(APP_CLIENTS.map((client) => [client, envs.map(([env, vars]) => ({ env, floor: String(vars[FLOOR_VARS[client]] ?? '').trim() || '0.0.0' }))]));
}

/**
 * The released routes the Worker no longer answers while some env still
 * accepts an app that calls them. Each names the route, the apps and the
 * floor to raise.
 */
export function findFloorBreaks(record, workerRoutes, floors) {
  const parsed = workerRoutes.map((route) => {
    const space = route.indexOf(' ');
    return { method: route.slice(0, space), pattern: route.slice(space + 1) };
  });
  const releases = [...(record.releases ?? [])].sort(compareVersions);
  const problems = [];
  for (const row of record.routes) {
    const accepting = floors[row.client].filter(({ floor }) => compareVersions(row.last, floor) >= 0);
    if (accepting.length === 0) continue;
    const space = row.route.indexOf(' ');
    const method = row.route.slice(0, space);
    const clientPath = row.route.slice(space + 1);
    if (parsed.some((route) => pathReaches(route.pattern, clientPath) && (route.method === method || route.method === '*'))) continue;
    const next = releases.find((version) => compareVersions(version, row.last) > 0);
    problems.push(`${row.route}: the ${row.client === 'macos' ? 'Mac' : 'iOS'} app ${row.first}${row.first === row.last ? '' : `–${row.last}`} calls it, and the Worker no longer answers it. `
      + `${accepting.map(({ env, floor }) => `${env} accepts ${floor}`).join(', ')}. `
      + `Raise ${FLOOR_VARS[row.client]} to ${next ?? `the first release after ${row.last}`} in every env, or keep the route and answer 410 client_update_required (meet#1162).`);
  }
  return problems;
}

function appRoutesText(record) {
  return `${JSON.stringify({
    note: 'The Worker routes each released Mac and iOS app calls, by first and last release (meet#1163). `cut-release.sh` adds each release with `node scripts/check-client-routes.mjs --record-release <version>`; `--from <tag>` reads an older release. Do not edit by hand.',
    releases: record.releases,
    routes: record.routes,
  }, null, 2)}\n`;
}

/** The Swift sources of `ref`, unpacked into a scratch folder, or this checkout when `ref` is null. */
async function releaseTree(ref) {
  if (!ref) return { base: root, done: () => {} };
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const os = await import('node:os');
  const base = mkdtempSync(path.join(os.tmpdir(), 'app-routes-'));
  const listed = execFileSync('git', ['-C', root, 'ls-tree', '--name-only', ref], { encoding: 'utf8' }).split('\n');
  const parts = ['project.yml', 'Sources', 'iOS', 'iOSActivities', 'iOSShare'].filter((part) => listed.includes(part));
  const archive = execFileSync('git', ['-C', root, 'archive', ref, ...parts], { maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', base], { input: archive });
  return { base, done: () => rmSync(base, { recursive: true, force: true }) };
}

async function recordReleaseCommand(version, ref) {
  if (!/^\d+\.\d+\.\d+$/u.test(version ?? '')) {
    console.error('check-client-routes: --record-release needs a version, like 6.9.3');
    process.exit(1);
  }
  const { base, done } = await releaseTree(ref);
  try {
    const clientsOf = appTargetsOf(readFileSync(path.join(base, 'project.yml'), 'utf8'));
    const routes = appRoutesOf(readSwiftCalls(base), clientsOf);
    const current = existsSync(appRoutesPath) ? JSON.parse(readFileSync(appRoutesPath, 'utf8')) : { routes: [] };
    writeFileSync(appRoutesPath, appRoutesText(recordRelease(current, version, routes)));
    console.log(`check-client-routes: recorded ${version}: Mac ${routes.macos.length} routes, iOS ${routes.ios.length} routes, in fixtures/app-routes.json`);
  } finally {
    done();
  }
}

function inventoryText(routes) {
  return `${JSON.stringify({
    note: 'Every (method, path) the Worker answers, read from the route table (services/control-plane/src/routes/*.ts) by scripts/check-client-routes.mjs. `{}` is one dynamic segment, `*` is any method. Regenerate with `node scripts/check-client-routes.mjs --write`.',
    routes,
  }, null, 2)}\n`;
}

async function main(argv) {
  const recordAt = argv.indexOf('--record-release');
  if (recordAt >= 0) {
    const fromAt = argv.indexOf('--from');
    await recordReleaseCommand(argv[recordAt + 1], fromAt >= 0 ? argv[fromAt + 1] : null);
    return;
  }
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  const { routes, unresolved } = readWorkerInventory();
  if (routes.length < 150) {
    console.error(`check-client-routes: read only ${routes.length} Worker routes from the router; the extractor no longer understands it.`);
    process.exit(1);
  }

  let failed = false;
  const next = inventoryText(routes);
  if (write) {
    writeFileSync(inventoryPath, next);
    console.log(`check-client-routes: wrote ${routes.length} routes to fixtures/routes.json`);
  } else if (check) {
    const current = existsSync(inventoryPath) ? readFileSync(inventoryPath, 'utf8') : '';
    if (current !== next) {
      const before = new Set(current ? JSON.parse(current).routes : []);
      const after = new Set(routes);
      console.error('check-client-routes: fixtures/routes.json is not the Worker\'s route table.');
      for (const route of after) if (!before.has(route)) console.error(`  + ${route}`);
      for (const route of before) if (!after.has(route)) console.error(`  - ${route}`);
      console.error('Run `node scripts/check-client-routes.mjs --write` and commit it.');
      failed = true;
    }
  }

  const calls = [...readClientCalls(), ...await readMcpCalls()];
  const { problems, stale } = findMismatches(routes, calls);
  for (const { call, why } of problems) console.error(`${call.file}:${call.line}: ${call.client}: ${why}`);
  for (const line of stale) console.error(`check-client-routes: ${line}`);
  if (problems.length > 0 || stale.length > 0) failed = true;

  const { stripJSONComments } = await import('./check-production-config.mjs');
  const record = JSON.parse(readFileSync(appRoutesPath, 'utf8'));
  const floors = floorsOf(JSON.parse(stripJSONComments(readFileSync(wranglerPath, 'utf8'))));
  const floorBreaks = findFloorBreaks(record, routes, floors);
  for (const line of floorBreaks) console.error(`check-client-routes: ${line}`);
  if (floorBreaks.length > 0) failed = true;

  if (!failed) {
    const byClient = Object.entries(calls.reduce((acc, call) => ({ ...acc, [call.client]: (acc[call.client] ?? 0) + 1 }), {}))
      .map(([client, count]) => `${client} ${count}`).join(', ');
    const loose = unresolved.length;
    console.log(`check-client-routes: ${calls.length} client calls (${byClient}) all reach one of ${routes.length} Worker routes${loose ? `; ${loose} Worker branches name no method` : ''}; the ${record.routes.length} routes released apps call answer for every accepted app`);
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
