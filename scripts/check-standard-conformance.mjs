// The Starlings Subject Spec's conformance suite (ADR 0005 slice E), run against
// the reference package and against Starlings' own door reader, which must
// read every standard door the same way. Also checks that cases.json names
// the same kinds and version as the package, so the suite cannot drift from
// the code it tests. In `pnpm verify:fast`.
//
//   node --import ./scripts/node-ts-resolve.mjs ./scripts/check-standard-conformance.mjs
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { runConformance } from '../standard/conformance/run.mjs';
import reference from '../standard/conformance/reference-adapter.mjs';
import { DOOR_KINDS, SPEC_VERSION, SUBJECT_KINDS, subjectSchema, taskSchema } from '../standard/src/index.ts';
import { toStandardSubject, toStandardTask } from '../packages/contracts/src/standard-records.ts';
import { SEARCH_SUBJECT_KINDS, parseSearchDoor, searchDoorString } from '../packages/contracts/src/search-values.ts';

const cases = JSON.parse(await readFile(new URL('../standard/conformance/cases.json', import.meta.url), 'utf8'));
const drift = [
  cases.version !== SPEC_VERSION && `version ${cases.version}, package ${SPEC_VERSION}`,
  !isDeepStrictEqual(cases.subjectKinds, [...SUBJECT_KINDS]) && `subjectKinds ${cases.subjectKinds}, package ${SUBJECT_KINDS}`,
  !isDeepStrictEqual(cases.doorKinds, [...DOOR_KINDS]) && `doorKinds ${cases.doorKinds}, package ${DOOR_KINDS}`,
].filter(Boolean);
const plugin = JSON.parse(await readFile(new URL('../standard/.claude-plugin/plugin.json', import.meta.url), 'utf8'));
if (plugin.version !== SPEC_VERSION) drift.push(`.claude-plugin/plugin.json: version ${plugin.version}, package ${SPEC_VERSION}`);
for (const line of drift) console.error(`standard: ${line}`);

const starlings = { subjectKinds: SEARCH_SUBJECT_KINDS, parseDoor: parseSearchDoor, doorString: searchDoorString };
let failed = drift.length;
for (const [name, adapter] of [['reference', reference], ['starlings', starlings]]) {
  const result = runConformance(cases, adapter);
  for (const line of result.failures) console.error(`${name}: FAIL ${line}`);
  console.log(`${name}: ${result.suite} ${result.version}: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`);
  failed += result.failed;
}
// Starlings' real wire shapes, projected to the spec's records: every subject
// and task in the response fixtures must come out valid.
const fixture = async (name) => JSON.parse(await readFile(new URL(`../fixtures/responses/${name}.json`, import.meta.url), 'utf8'));
const [mine, board, subjects] = await Promise.all(['crm-mine', 'crm-board', 'crm-subjects'].map(fixture));
let projected = 0;
for (const subject of [...board.subjects, ...subjects.subjects]) {
  const result = subjectSchema.safeParse(toStandardSubject(subject));
  if (result.success) projected++; else { failed++; console.error(`starlings: subject ${subject.id} does not project to a valid Subject: ${result.error.message}`); }
}
for (const task of [...mine.tasks, ...board.tasks]) {
  const record = toStandardTask(task);
  const result = record === null ? null : taskSchema.safeParse(record);
  if (result?.success) projected++; else { failed++; console.error(`starlings: task ${task.id} does not project to a valid Task: ${result ? result.error.message : `status "${task.status}" is not in the spec`}`); }
}
console.log(`starlings: ${projected} fixture records project to valid spec records`);
process.exit(failed === 0 ? 0 : 1);
