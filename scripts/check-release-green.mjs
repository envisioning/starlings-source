#!/usr/bin/env node
// Is this commit one to ship? `cut-release.sh` asks before it builds
//: the Worker build for the commit must have concluded `success`.
// A release is whatever `origin/main` is at that moment, and a red commit
// has shipped to the Worker never, so it should not ship to the apps either.
//
//   node scripts/check-release-green.mjs <sha>          # exit 0 green, 1 not
//
// Reads `gh api repos/envisioning/starlings/commits/<sha>/check-runs`.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Envisioning Worker's build. The check carries the Worker's name: it was
// `Workers Builds: meet` until the rename in place (#736, 2026-10-15).
export const REQUIRED_CHECKS = ['Workers Builds: starlings-envisioning'];
const REPO = 'envisioning/starlings';

/**
 * Judge a check-runs payload. `ok` only when the newest run of a required
 * check (either name in `names`) is present,
 * finished, and concluded `success`. A missing or running check is not a pass.
 */
export function judgeChecks(payload, names = REQUIRED_CHECKS) {
  const runs = Array.isArray(payload?.check_runs) ? payload.check_runs : [];
  const matches = runs.filter((run) => names.includes(run?.name));
  if (matches.length === 0) {
    return { ok: false, reason: `no "${names[0]}" check has reported on this commit yet` };
  }
  // The newest run of a check wins: a re-run that passed supersedes a failure.
  const latest = matches.reduce((best, run) => (
    Date.parse(run.started_at ?? 0) >= Date.parse(best.started_at ?? 0) ? run : best
  ));
  const required = latest.name;
  if (latest.status !== 'completed') {
    return { ok: false, reason: `"${required}" is still ${latest.status ?? 'running'}` };
  }
  if (latest.conclusion !== 'success') {
    return { ok: false, reason: `"${required}" concluded ${latest.conclusion ?? 'with no result'}` };
  }
  return { ok: true, reason: `"${required}" concluded success` };
}

function fetchChecks(sha) {
  const raw = execFileSync(
    'gh',
    ['api', `repos/${REPO}/commits/${sha}/check-runs`, '--paginate', '--jq', '.check_runs[]'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  const check_runs = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { check_runs };
}

function main() {
  const sha = process.argv[2];
  if (!sha) {
    console.error('usage: check-release-green.mjs <sha>');
    process.exitCode = 2;
    return;
  }
  let verdict;
  try {
    verdict = judgeChecks(fetchChecks(sha));
  } catch (error) {
    verdict = { ok: false, reason: `could not read the checks: ${error instanceof Error ? error.message : error}` };
  }
  console.log(verdict.ok ? `green: ${verdict.reason}` : `not green: ${verdict.reason}`);
  process.exitCode = verdict.ok ? 0 : 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) main();
