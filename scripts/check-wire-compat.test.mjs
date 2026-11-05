import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyWireBreakWaivers, compareWireDocuments } from './check-wire-compat.mjs';

const fixtureRoot = fileURLToPath(new URL('./fixtures/wire-compat/', import.meta.url));

async function fixture(name) {
  return JSON.parse(await readFile(fixtureRoot + name + '.json', 'utf8'));
}

async function assertBreak(name, field, kind) {
  const previous = await fixture('baseline');
  const current = await fixture(name);
  const issues = compareWireDocuments(previous, current);
  assert.ok(
    issues.some((issue) => issue.type === 'Output' && issue.field === field && issue.kind === kind),
    'expected ' + kind + ' for Output.' + field + ', got ' + JSON.stringify(issues),
  );
}

test('removed output field fails', async () => {
  await assertBreak('removed-field', 'id', 'removed-field');
});

test('optional field made required fails', async () => {
  await assertBreak('optional-to-required', 'optional', 'optional-made-required');
});

test('string narrowed to an enum fails', async () => {
  await assertBreak('string-to-enum', 'label', 'type-narrowed');
});

test('the same narrowing is reported for every field path', async () => {
  const issues = compareWireDocuments(await fixture('baseline'), await fixture('string-to-enum'));
  const narrowedFields = issues
    .filter((issue) => issue.type === 'Output' && issue.kind === 'type-narrowed')
    .map((issue) => issue.field)
    .sort();
  assert.deepEqual(narrowedFields, ['label', 'optional']);
});

test('nullable field made non-null fails', async () => {
  await assertBreak('nullable-to-non-null', 'nullable', 'type-narrowed');
});

test('closed enum losing a member fails', async () => {
  await assertBreak('closed-enum-loss', 'mode', 'closed-enum-member-removed');
});

test('adding an optional field passes', async () => {
  assert.deepEqual(compareWireDocuments(await fixture('baseline'), await fixture('add-field')), []);
});

test('adding a wire type passes', async () => {
  assert.deepEqual(compareWireDocuments(await fixture('baseline'), await fixture('add-type')), []);
});

// A type name is not on the wire (meet#1060): a rename with the same shape
// passes, a rename that also changes the shape is still a removal.
test('renaming a wire type with the same shape passes', async () => {
  const previous = await fixture('baseline');
  const current = structuredClone(previous);
  current.$defs.Renamed = current.$defs.Output;
  delete current.$defs.Output;
  assert.deepEqual(compareWireDocuments(previous, current), []);
});

test('renaming a wire type and changing its shape fails', async () => {
  const previous = await fixture('baseline');
  const current = structuredClone(previous);
  current.$defs.Renamed = { ...current.$defs.Output, properties: {} };
  delete current.$defs.Output;
  assert.ok(compareWireDocuments(previous, current).some((issue) => issue.type === 'Output' && issue.kind === 'removed-type'));
});

test('adding a closed enum member passes', async () => {
  assert.deepEqual(compareWireDocuments(await fixture('baseline'), await fixture('add-enum-member')), []);
});

test('a listed break passes with its reason and shipping version', async () => {
  const issues = compareWireDocuments(await fixture('baseline'), await fixture('removed-field'));
  const result = applyWireBreakWaivers(issues, [{
    type: 'Output',
    field: 'id',
    reason: 'The retired client path no longer reads this field.',
    ships_in: '4.5.0',
  }]);
  assert.deepEqual(result.remaining, []);
  assert.deepEqual(result.problems, []);
  assert.equal(result.applied.length, 1);
});

test('unused break entries fail as stale', () => {
  const result = applyWireBreakWaivers([], [{
    type: 'Output',
    field: 'id',
    reason: 'No current break matches.',
    ships_in: '4.5.0',
  }]);
  assert.match(result.problems[0], /Stale wire break entry/);
});

test('a break whose version shipped is spent: it refuses nobody and waives nothing', async () => {
  const waiver = { type: 'Output', field: 'id', reason: 'Shipped.', ships_in: '4.5.0' };
  assert.deepEqual(applyWireBreakWaivers([], [waiver], 'v4.5.0').problems, []);
  assert.deepEqual(applyWireBreakWaivers([], [waiver], 'v4.5.1').problems, []);
  assert.match(applyWireBreakWaivers([], [waiver], 'v4.4.9').problems[0], /Stale wire break entry/);
  const issues = compareWireDocuments(await fixture('baseline'), await fixture('removed-field'));
  assert.equal(applyWireBreakWaivers(issues, [waiver], 'v4.5.0').remaining.length, issues.length);
});
