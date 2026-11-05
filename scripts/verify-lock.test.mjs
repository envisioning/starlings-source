import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

// pgrep -x answers only processes named xcodebuild ($FAKE_XCODEBUILD_PIDS,
// default 4242); ps prints a PID's arguments ($FAKE_ARGS, default a build
// that uses DerivedData).
function fakeXcodeTools(bin) {
  const pgrep = join(bin, 'pgrep');
  const ps = join(bin, 'ps');
  const lsof = join(bin, 'lsof');
  writeFileSync(pgrep, `#!/bin/sh\n[ "$1" = "-x" ] && [ "$2" = "xcodebuild" ] || exit 1\nfor p in \${FAKE_XCODEBUILD_PIDS-4242}; do echo "$p"; done\n`);
  writeFileSync(ps, `#!/bin/sh\nprintf '%s\\n' "\${FAKE_ARGS-/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild -project Meet -derivedDataPath DerivedData}"\n`);
  writeFileSync(lsof, `#!/bin/sh\nprintf 'p%s\\nfcwd\\nn%s\\n' "$3" "$FAKE_BUILD_CWD"\n`);
  chmodSync(pgrep, 0o755);
  chmodSync(ps, 0o755);
  chmodSync(lsof, 0o755);
}

function runVerify(bin, env) {
  const pnpm = join(bin, 'pnpm');
  writeFileSync(pnpm, '#!/bin/sh\nprintf "reached-pnpm\\n"\nexit 42\n');
  chmodSync(pnpm, 0o755);
  return spawnSync('sh', ['./scripts/verify.sh'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, FAKE_BUILD_CWD: repoRoot, MEET_GATE_REMOTE: '0', ...env },
  });
}

test('a shell whose text names xcodebuild is not a build (2026-10-04)', () => {
  const bin = mkdtempSync(join(tmpdir(), 'meet-verify-lock-'));
  try {
    fakeXcodeTools(bin);
    // No process is named xcodebuild; a waiting loop that names the pattern
    // in its own text used to match itself and block every gate.
    const result = runVerify(bin, { FAKE_XCODEBUILD_PIDS: '' });
    assert.equal(result.status, 42);
    assert.doesNotMatch(result.stderr, /refusing to start/u);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test('a build with multi-line arguments in this DerivedData still stops verify', () => {
  const bin = mkdtempSync(join(tmpdir(), 'meet-verify-lock-'));
  try {
    fakeXcodeTools(bin);
    const result = runVerify(bin, { FAKE_ARGS: 'xcodebuild -project Meet\n-derivedDataPath DerivedData\nbuild' });
    assert.notEqual(result.status, 42);
    assert.match(result.stderr, /xcodebuild PID 4242 is using -derivedDataPath DerivedData/u);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test('verify stops when another xcodebuild uses this worktree’s DerivedData folder', () => {
  const bin = mkdtempSync(join(tmpdir(), 'meet-verify-lock-'));
  try {
    fakeXcodeTools(bin);
    const pnpm = join(bin, 'pnpm');
    writeFileSync(pnpm, '#!/bin/sh\nexit 42\n');
    chmodSync(pnpm, 0o755);

    const result = spawnSync('sh', ['./scripts/verify.sh'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        FAKE_BUILD_CWD: repoRoot,
        MEET_GATE_REMOTE: '0',
      },
    });

    assert.notEqual(result.status, 0);
    assert.notEqual(result.status, 42, 'the worktree guard should stop before pnpm');
    assert.match(result.stderr, /xcodebuild PID 4242 is using -derivedDataPath DerivedData/u);
    assert.match(result.stderr, /4242/u);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test('verify allows xcodebuild in a separate worktree with separate DerivedData', () => {
  const bin = mkdtempSync(join(tmpdir(), 'meet-verify-lock-'));
  const otherWorktree = join(bin, 'other-worktree');
  mkdirSync(otherWorktree);
  try {
    fakeXcodeTools(bin);
    const pnpm = join(bin, 'pnpm');
    writeFileSync(pnpm, '#!/bin/sh\nprintf "reached-pnpm\\n"\nexit 42\n');
    chmodSync(pnpm, 0o755);

    const result = spawnSync('sh', ['./scripts/verify.sh'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        FAKE_BUILD_CWD: otherWorktree,
        MEET_GATE_REMOTE: '0',
      },
    });

    assert.equal(result.status, 42);
    assert.match(result.stdout, /reached-pnpm/u);
    assert.doesNotMatch(result.stderr, /refusing to start/u);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

// ssh answers with $FAKE_SSH_STATUS; remote-build prints its command and exits 7.
function fakeBuildHost(bin, sshStatus) {
  const ssh = join(bin, 'ssh');
  const remoteBuild = join(bin, 'remote-build');
  writeFileSync(ssh, `#!/bin/sh\nexit ${sshStatus}\n`);
  writeFileSync(remoteBuild, '#!/bin/sh\nprintf "remote-build on %s: %s\\n" "$REMOTE_BUILD_HOST" "$*"\nexit 7\n');
  chmodSync(ssh, 0o755);
  chmodSync(remoteBuild, 0o755);
}

const buildHostEnv = { REMOTE_BUILD_HOST: 'build-host-test', MEET_GATE_REMOTE: '', MEET_LAND_QUEUE: '' };

test('the Apple part runs on the build host when it answers (2026-10-20)', () => {
  const bin = mkdtempSync(join(tmpdir(), 'meet-verify-lock-'));
  try {
    fakeXcodeTools(bin);
    fakeBuildHost(bin, 0);
    // A build in this DerivedData does not stop a gate that builds elsewhere.
    const result = spawnSync('sh', ['./scripts/verify.sh', '--apple'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, FAKE_BUILD_CWD: repoRoot, ...buildHostEnv },
    });
    assert.equal(result.status, 7);
    assert.match(result.stdout, /remote-build on build-host-test: MEET_GATE_REMOTE=0 .*\.\/scripts\/verify\.sh --apple$/mu);
    assert.doesNotMatch(result.stderr, /refusing to start/u);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test('the Apple part stays here when the build host does not answer', () => {
  const bin = mkdtempSync(join(tmpdir(), 'meet-verify-lock-'));
  try {
    fakeXcodeTools(bin);
    fakeBuildHost(bin, 255);
    const result = runVerify(bin, { FAKE_XCODEBUILD_PIDS: '', ...buildHostEnv });
    assert.equal(result.status, 42);
    assert.match(result.stderr, /build-host-test does not answer; the Apple build runs on this Mac/u);
    assert.doesNotMatch(result.stdout, /remote-build on/u);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
