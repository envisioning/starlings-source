import assert from 'node:assert/strict';
import test from 'node:test';
import { ageInDays, needsExpiryAlert } from './check-testflight-age.mjs';

const now = Date.parse('2026-09-23T08:00:00.000Z');
const day = 24 * 60 * 60 * 1000;

function uploadedDaysAgo(days) {
  return new Date(now - days * day).toISOString();
}

test('a 74-day-old build is below the alert threshold', () => {
  const uploadedDate = uploadedDaysAgo(74);
  assert.equal(ageInDays(uploadedDate, now), 74);
  assert.equal(needsExpiryAlert(uploadedDate, now), false);
});

test('a 75-day-old build is at the alert threshold', () => {
  const uploadedDate = uploadedDaysAgo(75);
  assert.equal(ageInDays(uploadedDate, now), 75);
  assert.equal(needsExpiryAlert(uploadedDate, now), false);
});

test('a 76-day-old build exceeds the alert threshold', () => {
  const uploadedDate = uploadedDaysAgo(76);
  assert.equal(ageInDays(uploadedDate, now), 76);
  assert.equal(needsExpiryAlert(uploadedDate, now), true);
});
