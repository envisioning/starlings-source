import assert from 'node:assert/strict';
import test from 'node:test';
import { refsInLines } from './report-issue-refs.mjs';

const refs = (text) => refsInLines(text.split('\n')).map(({ index, ref }) => `${index}:${ref}`);

test('a reference on the continuation line of a JSX block comment counts', () => {
  assert.deepEqual(refs(['{/* The header row stays', '    put while it scrolls (meet#489). */}', '<div />'].join('\n')), ['1:meet#489']);
});

test('a reference after a multi-line block comment closes is code, not comment', () => {
  assert.deepEqual(refs(['/* opens', ' closes */ const s = "meet#1";'].join('\n')), []);
});

test('a glob in a string does not open a block', () => {
  assert.deepEqual(refs(["const files = 'src/**/*.ts';", "const s = 'meet#2';"].join('\n')), []);
});

test('single-line comments still count, and a string reference does not', () => {
  assert.deepEqual(refs(["const a = 'meet#3'; // meet#4", '/* meet#5 */'].join('\n')), ['0:meet#4', '1:meet#5']);
});
