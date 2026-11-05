import { afterEach, describe, expect, it, vi } from 'vitest';

// meet#591: the suite never reaches the network. These pin the guard itself, so
// a change to the setup file cannot quietly turn the suite live again.

// Recorded refusals fail the test that caused them (test/no-network.ts); these
// tests cause them on purpose and take them back.
function acknowledgeRefusals(): string[] {
  return (globalThis as Record<symbol, string[]>)[Symbol.for('meet.test.refusedFetches')]!.splice(0);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the outbound guard', () => {
  it('refuses a host the test did not stub, by name', async () => {
    await expect(fetch('https://core.invalid/api/anything')).rejects.toThrow(
      'unexpected outbound request: GET https://core.invalid/api/anything',
    );
    await expect(fetch(new Request('https://docs.invalid/x', { method: 'POST', body: '{}' }))).rejects.toThrow(
      'unexpected outbound request: POST https://docs.invalid/x',
    );
    expect(acknowledgeRefusals()).toEqual([
      'unexpected outbound request: GET https://core.invalid/api/anything',
      'unexpected outbound request: POST https://docs.invalid/x',
    ]);
  });

  it('lets a test stub fetch, and goes back to refusing afterwards', async () => {
    vi.stubGlobal('fetch', async () => new Response('stubbed'));
    expect(await (await fetch('https://core.invalid/x')).text()).toBe('stubbed');
    vi.unstubAllGlobals();
    await expect(fetch('https://core.invalid/x')).rejects.toThrow('unexpected outbound request');
    acknowledgeRefusals();
  });

  it('keeps the test origins off every real host', async () => {
    const { env } = await import('cloudflare:workers');
    for (const origin of [env.CORE_API_ORIGIN, env.DOCS_ORIGIN, env.KEEP_ORIGIN, env.LIVEKIT_URL]) {
      expect(new URL(origin ?? '').hostname).toMatch(/\.invalid$/);
    }
  });

  it('starts with no secret that unlocks an outside call, whatever .dev.vars holds', async () => {
    const { env } = await import('cloudflare:workers');
    for (const name of ['INTERNAL_REQUEST_SECRET', 'DOCS_INTERNAL_SECRET', 'KEEP_INTERNAL_SECRET', 'POSTMARK_API_KEY', 'ANTHROPIC_API_KEY']) {
      expect((env as unknown as Record<string, string | undefined>)[name]?.trim() ?? '').toBe('');
    }
  });
});
