import { afterEach, beforeEach } from 'vitest';

// The suite never reaches the network (meet#591). A test that wants an outside
// host stubs `fetch` itself (`vi.stubGlobal('fetch', …)`); anything it did not
// stub is refused here, by name, instead of quietly calling Core, Google or
// GitHub. `vi.unstubAllGlobals()` restores this guard, not the real `fetch`.
//
// Throwing alone is not enough: most Worker code catches a failed Core call and
// degrades (a 502, an empty list), so the test would go green on the refusal.
// Each refusal is also recorded and fails the test that caused it.
// The list lives on `globalThis` so the guard's own test can reach the same one.
const REFUSED = Symbol.for('meet.test.refusedFetches');
const refused: string[] = ((globalThis as Record<symbol, unknown>)[REFUSED] ??= []) as string[];

const guard: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
  const message = `unexpected outbound request: ${method} ${url}`;
  refused.push(message);
  throw new Error(message);
};

globalThis.fetch = guard;

beforeEach(() => {
  refused.length = 0;
});

afterEach(() => {
  if (refused.length === 0) return;
  const lines = [...new Set(refused)];
  refused.length = 0;
  throw new Error(`${lines.join('\n')}\nStub fetch for this host in the test (see test/crm.test.ts).`);
});
