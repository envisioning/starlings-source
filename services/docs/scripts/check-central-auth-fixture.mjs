#!/usr/bin/env node
/**
 * Docs' copy of the central sign-in schemas parses Meet's fixture
 * (fixtures/meet/service-sign-in.json; see scripts/sync-meet-fixtures.mjs).
 * Every shape in the file must have a schema here, and every sample must
 * parse. Node 24 strips the types from the contract file.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  authBeginInputSchema,
  authBeginResultSchema,
  authBindingPropsSchema,
  authRedeemInputSchema,
  authRedeemResultSchema,
  memberCheckInputSchema,
  memberCheckResultSchema,
} from '../contracts/src/central-auth.ts';

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/meet/service-sign-in.json', import.meta.url)), 'utf8'));
const schemas = {
  bindingProps: authBindingPropsSchema,
  beginInput: authBeginInputSchema,
  beginResult: authBeginResultSchema,
  redeemInput: authRedeemInputSchema,
  redeemResult: authRedeemResultSchema,
  memberCheckInput: memberCheckInputSchema,
  memberCheckResult: memberCheckResultSchema,
};

const problems = [];
for (const [key, schema] of Object.entries(schemas)) {
  const samples = fixture[key];
  if (!Array.isArray(samples) || samples.length === 0) {
    problems.push(`${key}: missing or empty`);
    continue;
  }
  samples.forEach((sample, index) => {
    const parsed = schema.safeParse(sample);
    if (!parsed.success) problems.push(`${key}[${index}]: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`);
  });
}
for (const key of Object.keys(fixture)) {
  if (key !== 'about' && !(key in schemas)) problems.push(`${key}: no schema checks it`);
}

if (problems.length > 0) {
  console.error('check-central-auth-fixture: fixtures/meet/service-sign-in.json does not match contracts/src/central-auth.ts:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`check-central-auth-fixture: ${Object.keys(schemas).length} shapes parse`);
