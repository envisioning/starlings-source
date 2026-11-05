// The Starlings Subject Spec's conformance runner. Zero dependencies; Node 22 or
// later. Any JavaScript or TypeScript implementation runs it with an adapter:
//
//   node run.mjs ./my-adapter.mjs [cases.json]
//
// The adapter module's default export (or the module itself) provides:
//   subjectKinds   string[]                     the kinds the implementation knows
//   parseDoor      (door: string) => object|null its door reader
//   doorString     (parsed: object) => string    its door writer
//   validateDecision (record: object) => boolean optional; the section is skipped without it
//   validateSubject  (record: object) => boolean optional; likewise
//   validateTask     (record: object) => boolean optional; likewise
//
// Another language ports cases.json, which is the contract; this file is one
// reading of it. The rules are in SPEC.md §Conformance.

import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

/** Run every case against an adapter. Returns the counts and one line per failure. */
export function runConformance(cases, adapter) {
  const failures = [];
  let passed = 0;
  let skipped = 0;
  const check = (ok, message) => (ok ? passed++ : failures.push(message));

  check(isDeepStrictEqual([...adapter.subjectKinds].sort(), [...cases.subjectKinds].sort()), `subject kinds: expected ${cases.subjectKinds.join(', ')}, got ${[...adapter.subjectKinds].join(', ')}`);

  for (const { door, parsed } of cases.doors.valid) {
    const got = adapter.parseDoor(door);
    check(isDeepStrictEqual(got, parsed), `door "${door}": expected ${JSON.stringify(parsed)}, got ${JSON.stringify(got)}`);
    const written = adapter.doorString(parsed);
    check(written === door, `door ${JSON.stringify(parsed)}: expected to write "${door}", wrote "${written}"`);
  }
  for (const { door, parsed, written } of cases.doors.aliased ?? []) {
    const got = adapter.parseDoor(door);
    check(isDeepStrictEqual(got, parsed), `aliased door "${door}": expected ${JSON.stringify(parsed)}, got ${JSON.stringify(got)}`);
    check(adapter.doorString(parsed) === written, `aliased door "${door}": expected to write "${written}"`);
  }
  for (const door of cases.doors.invalid) {
    const got = adapter.parseDoor(door);
    check(got === null, `door "${door}": expected null, got ${JSON.stringify(got)}`);
  }
  for (const door of cases.doors.productOnly) {
    const got = adapter.parseDoor(door);
    check(got === null || !cases.doorKinds.includes(got.to), `door "${door}": a product door must not read as a standard thing door, got ${JSON.stringify(got)}`);
  }

  const records = [['decisions', 'decision', adapter.validateDecision], ['subjects', 'subject', adapter.validateSubject], ['tasks', 'task', adapter.validateTask]];
  for (const [key, label, validate] of records) {
    for (const [section, expected] of [['valid', true], ['invalid', false]]) {
      for (const item of cases[key]?.[section] ?? []) {
        if (typeof validate !== 'function') { skipped++; continue; }
        const record = item.bodyLength ? { ...item.record, body: 'x'.repeat(item.bodyLength) } : item.record;
        const got = validate(record) === true;
        check(got === expected, `${label} "${item.name}": expected ${expected ? 'valid' : 'invalid'}, got ${got ? 'valid' : 'invalid'}`);
      }
    }
  }
  return { suite: cases.suite, version: cases.version, passed, failed: failures.length, skipped, failures };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const [adapterPath, casesPath = new URL('./cases.json', import.meta.url)] = process.argv.slice(2);
  if (!adapterPath) {
    console.error('usage: node run.mjs <adapter.mjs> [cases.json]');
    process.exit(2);
  }
  const mod = await import(pathToFileURL(path.resolve(adapterPath)).href);
  const cases = JSON.parse(await readFile(casesPath, 'utf8'));
  const result = runConformance(cases, mod.default ?? mod);
  for (const line of result.failures) console.log(`FAIL ${line}`);
  console.log(`${result.suite} ${result.version}: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`);
  process.exit(result.failed === 0 ? 0 : 1);
}
