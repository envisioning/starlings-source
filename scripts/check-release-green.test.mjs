import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeChecks } from './check-release-green.mjs';

const run = (over) => ({
  name: 'Workers Builds: starlings-envisioning',
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-10-01T10:00:00Z',
  ...over,
});

test('a finished, successful Worker build is green', () => {
  assert.equal(judgeChecks({ check_runs: [run()] }).ok, true);
});

test('a failed Worker build is not green', () => {
  const verdict = judgeChecks({ check_runs: [run({ conclusion: 'failure' })] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /failure/);
});

test('a build still running is not green', () => {
  const verdict = judgeChecks({ check_runs: [run({ status: 'in_progress', conclusion: null })] });
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /in_progress/);
});

test('a commit the Worker build has not reported on is not green', () => {
  assert.equal(judgeChecks({ check_runs: [] }).ok, false);
  assert.equal(judgeChecks({ check_runs: [run({ name: 'Something else' })] }).ok, false);
  assert.equal(judgeChecks({}).ok, false);
});

test('a green check on another name does not stand in for the Worker build', () => {
  const verdict = judgeChecks({ check_runs: [run({ name: 'lint' }), run({ conclusion: 'cancelled' })] });
  assert.equal(verdict.ok, false);
});

test('the build under the old Worker name no longer counts (#736)', () => {
  assert.equal(judgeChecks({ check_runs: [run({ name: 'Workers Builds: meet' })] }).ok, false);
});

test('the newest run of the check wins', () => {
  const failedThenPassed = judgeChecks({
    check_runs: [
      run({ conclusion: 'failure', started_at: '2026-10-01T10:00:00Z' }),
      run({ conclusion: 'success', started_at: '2026-10-01T10:05:00Z' }),
    ],
  });
  assert.equal(failedThenPassed.ok, true);
  const passedThenFailed = judgeChecks({
    check_runs: [
      run({ conclusion: 'success', started_at: '2026-10-01T10:00:00Z' }),
      run({ conclusion: 'failure', started_at: '2026-10-01T10:05:00Z' }),
    ],
  });
  assert.equal(passedThenFailed.ok, false);
});

test('the command exits 1 on a red commit and 0 on a green one', () => {
  // A stand-in `gh` that answers with the fixture named by $FIXTURE.
  const dir = mkdtempSync(join(tmpdir(), 'release-green-'));
  const gh = join(dir, 'gh');
  writeFileSync(gh, '#!/bin/sh\nprintf "%s\\n" "$FIXTURE"\n');
  chmodSync(gh, 0o755);
  const exec = (conclusion) => {
    try {
      execFileSync('node', [new URL('./check-release-green.mjs', import.meta.url).pathname, 'abc1234'], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FIXTURE: JSON.stringify(run({ conclusion })) },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return 0;
    } catch (error) {
      return error.status;
    }
  };
  assert.equal(exec('success'), 0);
  assert.equal(exec('failure'), 1);
});
