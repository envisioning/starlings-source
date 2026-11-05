import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customRoutesMatchAliases } from './production-domain-policy.mjs';
const alias = 'https://envisioning.starlings.example';
test('only explicit workspace custom domains coexist with workers.dev', () => {
  assert.equal(customRoutesMatchAliases([{ pattern: 'envisioning.starlings.example', custom_domain: true }], alias), true);
  for (const route of [
    { pattern: 'other.starlings.example', custom_domain: true },
    { pattern: '*.starlings.example', custom_domain: true },
    { pattern: 'envisioning.starlings.example/*', custom_domain: true },
    { pattern: 'envisioning.starlings.example', custom_domain: false },
    { pattern: 'envisioning.starlings.example' },
  ]) assert.equal(customRoutesMatchAliases([route], alias), false);
  assert.equal(customRoutesMatchAliases([{ pattern: 'envisioning.starlings.example', custom_domain: true }], ''), false);
  assert.equal(customRoutesMatchAliases([{ pattern: '*.starlings.example', custom_domain: true }], 'https://*.starlings.example'), false);
});
