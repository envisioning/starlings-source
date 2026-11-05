import assert from 'node:assert/strict';
import test from 'node:test';
import { plan } from './sync-core-fixtures.mjs';

const files = (entries) => new Map(Object.entries(entries));

test('identical sets are clean', () => {
  assert.equal(plan(files({ 'a.json': '1', 'b.json': '2' }), files({ 'a.json': '1', 'b.json': '2' })).clean, true);
});

test('a file Core added is missing, one it changed is changed, one it dropped is extra', () => {
  const result = plan(
    files({ 'new.json': '1', 'same.json': '2', 'edited.json': 'b' }),
    files({ 'same.json': '2', 'edited.json': 'a', 'gone.json': '3' }),
  );
  assert.deepEqual(result.missing, ['new.json']);
  assert.deepEqual(result.changed, ['edited.json']);
  assert.deepEqual(result.extra, ['gone.json']);
  assert.equal(result.clean, false);
});

test('an empty copy against a populated source lists every file as missing', () => {
  assert.deepEqual(plan(files({ 'a.json': '1' }), files({})).missing, ['a.json']);
});
