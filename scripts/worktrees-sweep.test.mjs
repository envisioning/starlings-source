// The worktree sweep against throwaway repositories (meet#1143).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sweep = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worktrees-sweep.sh');

function setup() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sweep-')));
  const origin = path.join(root, 'origin.git');
  const main = path.join(root, 'main');
  const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, main], { stdio: 'ignore' });
  run(main, 'config', 'user.email', 'test@example.net');
  run(main, 'config', 'user.name', 'Test');
  writeFileSync(path.join(main, 'a.txt'), 'one\n');
  run(main, 'add', 'a.txt');
  run(main, 'commit', '-q', '-m', 'first');
  run(main, 'push', '-q', 'origin', 'main');

  const worktree = (slug, { commit = false } = {}) => {
    const dir = path.join(root, `starlings-${slug}`);
    run(main, 'worktree', 'add', '-q', '-b', `ship/${slug}`, dir, 'origin/main');
    if (commit) {
      writeFileSync(path.join(dir, `${slug}.txt`), `${slug}\n`);
      run(dir, 'add', '.');
      run(dir, 'commit', '-q', '-m', slug);
    }
    return dir;
  };
  // A session last touched it three hours ago.
  const age = (dir) => {
    const gitDir = run(dir, 'rev-parse', '--absolute-git-dir').trim();
    const then = new Date(Date.now() - 3 * 3600 * 1000);
    for (const file of ['index', 'HEAD', 'logs/HEAD']) {
      if (existsSync(path.join(gitDir, file))) utimesSync(path.join(gitDir, file), then, then);
    }
  };
  const sweepIn = (cwd, ...args) => execFileSync('sh', [sweep, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, MEET_SWEEP_IDLE_MINUTES: '120', MEET_SWEEP_CWDS: cwds.join('\n') },
  });
  const cwds = [];
  const branches = () => run(main, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);
  return { root, main, run, worktree, age, sweepIn, branches, cwds, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('removes clean, idle worktrees whose work is on main, and keeps the rest', () => {
  const t = setup();
  try {
    // Landed: its commit is on main as is.
    const landed = t.worktree('landed', { commit: true });
    t.run(landed, 'push', '-q', 'origin', 'HEAD:main');
    // Rebased by the queue: a different commit with the same change.
    const rebased = t.worktree('rebased', { commit: true });
    t.run(t.main, 'pull', '-q', '--ff-only', 'origin', 'main');
    t.run(t.main, 'cherry-pick', t.run(rebased, 'rev-parse', 'HEAD').trim());
    t.run(t.main, 'push', '-q', 'origin', 'main');
    const empty = t.worktree('empty');
    const dirty = t.worktree('dirty');
    writeFileSync(path.join(dirty, 'draft.txt'), 'not committed\n');
    const unlanded = t.worktree('unlanded', { commit: true });
    for (const dir of [landed, rebased, empty, dirty, unlanded]) t.age(dir);
    const fresh = t.worktree('fresh');

    const report = t.sweepIn(t.main);

    for (const dir of [landed, rebased, empty]) assert.equal(existsSync(dir), false, `${dir} should go`);
    for (const dir of [dirty, unlanded, fresh]) assert.equal(existsSync(dir), true, `${dir} should stay`);
    assert.equal(existsSync(t.main), true);
    assert.match(report, /kept .*starlings-dirty .*uncommitted changes/u);
    assert.match(report, /kept .*starlings-unlanded .*commits not on main \(ship\/unlanded\)/u);
    assert.match(report, /kept .*starlings-fresh .*in use 0 minutes ago/u);
    assert.match(report, /sweep: removed 3 worktree\(s\)/u);
    assert.deepEqual(t.branches().sort(), ['main', 'ship/dirty', 'ship/fresh', 'ship/unlanded']);
  } finally {
    t.done();
  }
});

test('--dry-run removes nothing', () => {
  const t = setup();
  try {
    const empty = t.worktree('empty');
    t.age(empty);
    const report = t.sweepIn(t.main, '--dry-run');
    assert.match(report, /would go .*starlings-empty/u);
    assert.equal(existsSync(empty), true);
  } finally {
    t.done();
  }
});

test('--branch --landed removes only that branch, and not a commit made after the push', () => {
  const t = setup();
  try {
    // The queue landed this commit rebased; `git cherry` need not match it.
    const target = t.worktree('target', { commit: true });
    const pushed = t.run(target, 'rev-parse', 'HEAD').trim();
    const other = t.worktree('other');
    // Its session committed again after the push.
    const later = t.worktree('later', { commit: true });
    const laterPushed = t.run(later, 'rev-parse', 'HEAD').trim();
    writeFileSync(path.join(later, 'more.txt'), 'more\n');
    t.run(later, 'add', '.');
    t.run(later, 'commit', '-q', '-m', 'more');
    for (const dir of [target, other, later]) t.age(dir);

    const report = t.sweepIn(t.main, '--branch', 'ship/target', '--landed', pushed);
    assert.equal(t.sweepIn(t.main, '--branch', 'ship/later', '--landed', laterPushed).includes('commits not on main'), true);
    assert.match(report, /removed .*starlings-target/u);
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(other), true);
    assert.equal(existsSync(later), true);
    assert.deepEqual(t.branches().sort(), ['main', 'ship/later', 'ship/other']);
  } finally {
    t.done();
  }
});

test('keeps a worktree a running process works in, even when it looks idle', () => {
  const t = setup();
  try {
    const session = t.worktree('session');
    t.age(session);
    t.cwds.push(path.join(session, 'web', 'src'));
    const report = t.sweepIn(t.main);
    assert.equal(existsSync(session), true);
    assert.match(report, /kept .*starlings-session .*a running process works in it/u);
  } finally {
    t.done();
  }
});

test('never removes the worktree it runs in', () => {
  const t = setup();
  try {
    const queue = t.worktree('queue');
    t.age(queue);
    t.sweepIn(queue);
    assert.equal(existsSync(queue), true);
  } finally {
    t.done();
  }
});
