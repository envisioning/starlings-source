#!/usr/bin/env node
// The changelog: checked, printed, regenerated, or released.
//
//   node scripts/assemble-changelog.mjs --check          # every update is well formed, CHANGELOG.md matches
//   node scripts/assemble-changelog.mjs --write          # regenerate CHANGELOG.md from changelog/
//   node scripts/assemble-changelog.mjs --count          # how many updates wait
//   node scripts/assemble-changelog.mjs --print          # the bullets the next release will carry
//   node scripts/assemble-changelog.mjs --next-version   # the version the next release takes
//   node scripts/assemble-changelog.mjs --release        # stamp the waiting updates; CHANGELOG.md, VERSION
//
// `--release` is `cut-release.sh`'s step; nothing else runs it. `--date
// YYYY-MM-DD` overrides today's date. See changelog/README.md.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changelogProblems,
  nextVersion,
  readReleases,
  readUpdates,
  release,
  renderChangelog,
  updateBullet,
  waitingUpdates,
} from './changelog-updates.mjs';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const dateFlag = args.indexOf('--date');
  const date = dateFlag >= 0 ? args[dateFlag + 1] : new Date().toISOString().slice(0, 10);

  if (mode === '--check') {
    const problems = changelogProblems(repoDir);
    if (problems.length > 0) {
      for (const problem of problems) console.error(problem);
      console.error('\nOne update is one file in changelog/updates/ with id, date, area and kind. See changelog/README.md.');
      process.exitCode = 1;
      return;
    }
    console.log(`changelog: ${waitingUpdates(readUpdates(repoDir)).length} updates waiting for the next release`);
    return;
  }
  if (mode === '--write') {
    writeFileSync(path.join(repoDir, 'CHANGELOG.md'), renderChangelog(readReleases(repoDir), readUpdates(repoDir)));
    return;
  }
  if (mode === '--count') {
    console.log(String(waitingUpdates(readUpdates(repoDir)).length));
    return;
  }
  if (mode === '--print') {
    const waiting = waitingUpdates(readUpdates(repoDir));
    if (waiting.length > 0) console.log(waiting.map(updateBullet).join('\n'));
    return;
  }
  if (mode === '--next-version') {
    console.log(nextVersion(readFileSync(path.join(repoDir, 'VERSION'), 'utf8')));
    return;
  }
  if (mode === '--release') {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date ?? '')) throw new Error('--date takes YYYY-MM-DD');
    console.log(release(repoDir, date));
    return;
  }
  console.error('usage: assemble-changelog.mjs --check | --write | --count | --print | --next-version | --release [--date YYYY-MM-DD]');
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`assemble-changelog: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
