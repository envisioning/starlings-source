// The hot-spot report against small throwaway repositories (meet#955).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classify, renamedPaths, report } from './code-hotspots.mjs';

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hotspots-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.net');
  git('config', 'user.name', 'Test');
  let clock = Date.parse('2026-10-01T10:00:00Z') / 1000;
  const commit = (files, message, gapHours = 1) => {
    for (const [file, body] of Object.entries(files)) {
      if (body === null) { git('rm', '-q', file); continue; }
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), body);
      git('add', file);
    }
    clock += gapHours * 3600;
    execFileSync('git', ['commit', '-q', '-m', message], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: `@${clock}`, GIT_COMMITTER_DATE: `@${clock}` },
    });
    return git('rev-parse', 'HEAD').trim();
  };
  return { dir, git, commit, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('classifies generated, tests, docs, implementation and data by path', () => {
  assert.equal(classify('Sources/Generated/HomeLayoutRegistry.swift'), 'generated');
  assert.equal(classify('packages/contracts/swift/Sources/StarlingsContracts/Wire.swift'), 'generated');
  assert.equal(classify('Tests/HomeLayoutFixtureTests.swift'), 'tests');
  assert.equal(classify('services/control-plane/test/agents.test.ts'), 'tests');
  assert.equal(classify('web/src/rail-row.test.tsx'), 'tests');
  assert.equal(classify('docs/WORK.md'), 'docs');
  assert.equal(classify('web/src/WorkPage.tsx'), 'implementation');
  assert.equal(classify('fixtures/home-layout.json'), 'data');
  assert.equal(classify('web/node_modules/x/index.js'), 'excluded');
});

test('reads both numstat rename spellings', () => {
  assert.deepEqual(renamedPaths('src/{a => b}/x.ts'), { from: 'src/a/x.ts', to: 'src/b/x.ts' });
  assert.deepEqual(renamedPaths('src/{ => new}/x.ts'), { from: 'src/x.ts', to: 'src/new/x.ts' });
  assert.deepEqual(renamedPaths('a.ts => b.ts'), { from: 'a.ts', to: 'b.ts' });
  assert.equal(renamedPaths('plain.ts'), null);
});

test('counts committed lines by class, whatever the working tree holds', () => {
  const r = repo();
  try {
    const sha = r.commit({
      'src/app.ts': 'a\nb\nc\n',
      'src/app.test.ts': 'x\n',
      'Sources/Generated/Reg.swift': '1\n2\n',
      'docs/a.md': 'one\ntwo',
      'data.json': '{}\n',
    }, 'first');
    writeFileSync(path.join(r.dir, 'src/app.ts'), 'dirty\n'.repeat(50));
    const result = report(r.dir, { ref: sha, days: 30 });
    assert.deepEqual(result.lines, { implementation: 3, tests: 1, generated: 2, docs: 2, data: 1 });
    assert.equal(result.window.complete, true);
  } finally { r.done(); }
});

test('an empty window reports sizes and no hot spots', () => {
  const r = repo();
  try {
    r.commit({ 'src/a.ts': 'x\n' }, 'code');
    // Three days later, a docs-only commit: a one-day window before it holds
    // no authored change at all.
    const docsOnly = r.commit({ 'docs/b.md': 'y\n' }, 'docs', 72);
    const result = report(r.dir, { ref: docsOnly, days: 1 });
    assert.equal(result.window.commits, 1);
    assert.deepEqual(result.topByCommits, []);
    assert.deepEqual(result.topByChurn, []);
    assert.equal(result.lines.implementation, 1);
    const wider = report(r.dir, { ref: docsOnly, days: 30 });
    assert.deepEqual(wider.topByCommits.map((row) => row.file), ['src/a.ts']);
  } finally { r.done(); }
});

test('reports a rename and follows the file to its new path', () => {
  const r = repo();
  try {
    r.commit({ 'src/old.ts': 'line\n'.repeat(20) }, 'add');
    r.git('mv', 'src/old.ts', 'src/new.ts');
    const moved = r.commit({}, 'move');
    const result = report(r.dir, { ref: moved, days: 30 });
    assert.deepEqual(result.renames.map(({ from, to }) => ({ from, to })), [{ from: 'src/old.ts', to: 'src/new.ts' }]);
    assert.ok(result.authored.some((row) => row.file === 'src/new.ts'));
    assert.ok(!result.authored.some((row) => row.file === 'src/old.ts'));
  } finally { r.done(); }
});

test('repeat runs are identical, and a bug-fix list is a separate column', () => {
  const r = repo();
  try {
    r.commit({ 'src/a.ts': '1\n', 'src/b.ts': '1\n' }, 'one');
    const fix = r.commit({ 'src/a.ts': '1\n2\n' }, 'fix');
    r.commit({ 'src/b.ts': '1\n2\n' }, 'feature');
    const once = report(r.dir, { ref: 'HEAD', days: 30, bugCommits: [fix.slice(0, 10)] });
    const twice = report(r.dir, { ref: 'HEAD', days: 30, bugCommits: [fix.slice(0, 10)] });
    assert.deepEqual(once, twice);
    const a = once.authored.find((row) => row.file === 'src/a.ts');
    const b = once.authored.find((row) => row.file === 'src/b.ts');
    assert.equal(a.bugFixCommits, 1);
    assert.equal(b.bugFixCommits, 0);
    assert.deepEqual(once.topByCommits.map((row) => row.file), ['src/a.ts', 'src/b.ts']);
  } finally { r.done(); }
});
