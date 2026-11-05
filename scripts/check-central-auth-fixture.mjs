#!/usr/bin/env node
/**
 * The service sign-in fixture (fixtures/central-auth/service-sign-in.json)
 * parses with Meet's own schemas. Docs and Keep keep a copy of the file and
 * of the schemas they need, and parse the copy with those; a sibling Meet
 * checkout tells them when the copy is behind (docs/CENTRAL_AUTH.md
 * "Services"). So a change here is: the schema, this fixture, then a sync in
 * Docs and Keep.
 *
 * Run with `node --import ./scripts/node-ts-resolve.mjs`. Part of
 * `pnpm verify:fast`.
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
} from '../packages/contracts/src/browser-auth.ts';

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/central-auth/service-sign-in.json', import.meta.url)), 'utf8'));
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
    if (!parsed.success) problems.push(`${key}[${index}]: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  });
}
for (const key of Object.keys(fixture)) {
  if (key !== 'about' && !(key in schemas)) problems.push(`${key}: no schema checks it`);
}

if (problems.length > 0) {
  console.error('check-central-auth-fixture: fixtures/central-auth/service-sign-in.json does not match the schemas:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`check-central-auth-fixture: ${Object.keys(schemas).length} shapes parse`);
