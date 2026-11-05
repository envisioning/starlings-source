// The registry generator: its helpers against small shapes, and the files on
// disk against what the TypeScript modules say now (the same check
// `pnpm registries:check` makes, so a stale file fails here too).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compactJson, expectedFiles, swiftCase, swiftLocalized, swiftName, swiftString, swiftStringArray, withKeys } from '../../../scripts/gen-swift-registries.mjs';

test('swiftString quotes and escapes, and refuses what needs a unicode escape', () => {
  assert.equal(swiftString('Waiting on External Factor'), '"Waiting on External Factor"');
  assert.equal(swiftString('a "b"'), '"a \\"b\\""');
  assert.throws(() => swiftString('\u0001'));
});

test('swiftName only takes a plain lowerCamel word that is not a keyword', () => {
  assert.equal(swiftName('startsCollapsed'), 'startsCollapsed');
  assert.throws(() => swiftName('Work'));
  assert.throws(() => swiftName('needs-sales'));
  assert.throws(() => swiftName('default'));
});

test('swiftStringArray stays on a line when short and wraps when long', () => {
  assert.equal(swiftStringArray(['a', 'b'], '    '), '["a", "b"]');
  const long = Array.from({ length: 12 }, (_, i) => `status number ${i}`);
  assert.match(swiftStringArray(long, '    '), /^\[\n( {8}"status number \d+",\n){12} {4}\]$/);
});

test('swiftCase turns a wire id into the case it is declared as', () => {
  assert.equal(swiftCase('mark-seen'), 'markSeen');
  assert.equal(swiftCase('inbox_talk'), 'inboxTalk');
  assert.equal(swiftCase('open'), 'open');
  assert.throws(() => swiftCase('init'));
  assert.throws(() => swiftCase('Work'));
});

test('swiftLocalized wraps the English source in String(localized:)', () => {
  assert.equal(swiftLocalized('Quick access'), 'String(localized: "Quick access")');
});

test('withKeys replaces the table keys, keeps what is hand-written, and places a new key after its neighbour', () => {
  const existing = { version: 1, cases: [1], core: { a: 1 }, table: [0] };
  assert.deepEqual(Object.keys(withKeys(existing, { table: [1] })), ['version', 'cases', 'core', 'table']);
  assert.deepEqual(withKeys(existing, { table: [1] }).cases, [1]);
  assert.deepEqual(withKeys(existing, { table: [1] }).table, [1]);
  assert.deepEqual(Object.keys(withKeys(existing, { prefixes: {}, table: [1] })), ['version', 'prefixes', 'cases', 'core', 'table']);
  assert.deepEqual(Object.keys(withKeys({}, { b: 1, a: 2 })), ['b', 'a']);
});

test('compactJson keeps plain values on a line and opens the rest', () => {
  assert.equal(compactJson({ a: ['x', 'y'], b: { c: 1 } }), '{\n  "a": ["x", "y"],\n  "b": { "c": 1 }\n}');
  assert.equal(compactJson([{ id: 'a' }, { id: 'b' }]), '[\n  { "id": "a" },\n  { "id": "b" }\n]');
  assert.equal(compactJson({ list: [] }), '{\n  "list": []\n}');
  const long = Array.from({ length: 12 }, (_, i) => `status number ${i}`);
  assert.match(compactJson(long), /^\[\n( {2}"status number \d+",?\n){12}\]$/);
});

test('every generated file on disk is what the TypeScript modules produce', async () => {
  for (const [path, text] of await expectedFiles()) {
    assert.ok(existsSync(path), `${path} is missing: run pnpm registries:gen`);
    assert.equal(readFileSync(path, 'utf8'), text, `${path} is stale: run pnpm registries:gen`);
  }
});
