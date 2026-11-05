import { beforeAll } from 'vitest';

/*
 * The pool imports the Worker's `main` (`src/index.ts`, the whole app graph,
 * through Vite) lazily: on the first `exports.default.fetch` or Durable Object
 * call of a file. That import then runs inside the first test and counts
 * against its 30s budget. Under the gate (efficiency cores only, beside other
 * work) the import alone took longer than 30s, so the first test of a file
 * timed out and passed alone (meet#1232).
 *
 * This hook does the import before the first test. It runs after the test
 * file is collected, so the file's `vi.mock` calls still apply. The pool and
 * this hook share one module cache, so the lazy import later finds the module
 * loaded. The timeout is long because the hook waits on that import and
 * nothing else; a real hang inside a test still fails at 30s.
 */
beforeAll(async () => {
  await import('../src/index');
}, 180_000);
