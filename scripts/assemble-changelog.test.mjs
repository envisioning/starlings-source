import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  changelogProblems,
  changelogWithNext,
  nextVersion,
  NEXT_HEADING,
  parseUpdate,
  readUpdates,
  release,
  serializeUpdate,
} from './changelog-updates.mjs';

const OLDER = { id: '6.6.8-01', date: '2026-10-01', version: '6.6.8', area: 'work', kind: 'new', refs: [], body: '**Older.** Shipped before.' };
const OLDER_CHANGELOG = '# Changelog\n\n## 6.6.8 — 2026-10-01\n\n- **Older.** Shipped before.\n';

function checkout(version, updates) {
  const dir = mkdtempSync(path.join(tmpdir(), 'meet-changelog-'));
  writeFileSync(path.join(dir, 'VERSION'), `${version}\n`);
  writeFileSync(path.join(dir, 'CHANGELOG.md'), OLDER_CHANGELOG);
  mkdirSync(path.join(dir, 'changelog', 'updates'), { recursive: true });
  writeFileSync(path.join(dir, 'changelog', 'releases.json'), JSON.stringify([{ version: '6.6.8', date: '2026-10-01' }]));
  for (const update of [OLDER, ...updates]) {
    writeFileSync(path.join(dir, 'changelog', 'updates', `${update.id}.md`), serializeUpdate({ refs: [], ...update }));
  }
  return dir;
}

test('the next version is a patch step that rolls at 9', () => {
  assert.equal(nextVersion('6.6.8\n'), '6.6.9');
  assert.equal(nextVersion('6.6.9'), '6.7.0');
  assert.equal(nextVersion('6.9.9'), '7.0.0');
  assert.throws(() => nextVersion('6.10.0'));
});

test('an update file has an id that is its name, a known area and kind, and no list marker', () => {
  const ok = serializeUpdate({ id: '2026-10-01-ios-filing', date: '2026-10-01', area: 'calls', kind: 'fixed', refs: ['meet#585'], body: '**Filing works.** It was refused.' });
  assert.equal(parseUpdate('2026-10-01-ios-filing.md', ok).refs[0], 'meet#585');
  assert.throws(() => parseUpdate('other-name.md', ok), /the file is <id>.md/u);
  assert.throws(() => parseUpdate('2026-10-01-a.md', ok.replace('2026-10-01-ios-filing', '2026-10-01-a').replace('area: calls', 'area: billing')), /area/u);
  assert.throws(() => parseUpdate('2026-10-01-a.md', ok.replace('2026-10-01-ios-filing', '2026-10-01-a').replace('kind: fixed\n', '')), /kind/u);
  assert.throws(() => parseUpdate('2026-10-01-a.md', ok.replace('2026-10-01-ios-filing', '2026-10-01-a').replace('**Filing', '- **Filing')), /list marker/u);
  assert.throws(() => parseUpdate('2026-10-01-a.md', '- **A.** No frontmatter.\n'), /frontmatter/u);
});

test('the web changelog shows waiting updates under Next release, and nothing extra when there are none', () => {
  const withWaiting = changelogWithNext(checkout('6.6.8', [{ id: '2026-10-02-b', date: '2026-10-02', area: 'docs', kind: 'new', body: '**B.** New.' }]));
  assert.ok(withWaiting.startsWith(`# Changelog\n\n${NEXT_HEADING}\n\n`));
  assert.ok(withWaiting.indexOf('- **B.** New.') < withWaiting.indexOf('## 6.6.8'));
  assert.equal(changelogWithNext(checkout('6.6.8', [])), OLDER_CHANGELOG);
});

test('a hand-edited CHANGELOG.md, or a leftover changelog.d/ file, is a problem', () => {
  const dir = checkout('6.6.8', []);
  assert.deepEqual(changelogProblems(dir), []);
  writeFileSync(path.join(dir, 'CHANGELOG.md'), `${OLDER_CHANGELOG}- **Hand.** Added.\n`);
  assert.ok(changelogProblems(dir).some((problem) => problem.includes('--write')));
  writeFileSync(path.join(dir, 'CHANGELOG.md'), OLDER_CHANGELOG);
  mkdirSync(path.join(dir, 'changelog.d'));
  writeFileSync(path.join(dir, 'changelog.d', '2026-10-02-old.md'), '- **Old.** Fragment.\n');
  assert.ok(changelogProblems(dir).some((problem) => problem.startsWith('changelog.d/')));
});

test('a release stamps the waiting updates, adds the release, and bumps VERSION once', () => {
  const dir = checkout('6.6.9', [
    { id: '2026-10-01-a', date: '2026-10-01', area: 'calls', kind: 'fixed', body: '**A (Mac).** First.\nSecond line.' },
    { id: '2026-10-02-b', date: '2026-10-02', area: 'site', kind: 'new', body: '**B (web).** Newer.' },
  ]);
  assert.equal(release(dir, '2026-10-08'), '6.7.0');
  assert.equal(readFileSync(path.join(dir, 'VERSION'), 'utf8'), '6.7.0\n');
  assert.equal(
    readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8'),
    '# Changelog\n\n## 6.7.0 — 2026-10-08\n\n- **B (web).** Newer.\n- **A (Mac).** First.\n  Second line.\n\n## 6.6.8 — 2026-10-01\n\n- **Older.** Shipped before.\n',
  );
  assert.ok(readUpdates(dir).every((update) => update.version));
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'changelog', 'releases.json'), 'utf8'))[0], { version: '6.7.0', date: '2026-10-08' });
  assert.deepEqual(changelogProblems(dir), []);
});

test('a release with nothing waiting, or with a malformed file, changes nothing', () => {
  const empty = checkout('6.6.8', []);
  assert.throws(() => release(empty, '2026-10-08'), /nothing to release/u);
  const bad = checkout('6.6.8', []);
  writeFileSync(path.join(bad, 'changelog', 'updates', '2026-10-01-a.md'), '# Heading\n');
  assert.throws(() => release(bad, '2026-10-08'));
  assert.equal(readFileSync(path.join(bad, 'VERSION'), 'utf8'), '6.6.8\n');
});
