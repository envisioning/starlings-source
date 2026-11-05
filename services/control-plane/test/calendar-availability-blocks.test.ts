import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAvailabilityBlocks } from '../src/schedule-proxy';

/** Stub Core's per-day `/availability` route, keyed by the `date` it was asked for. */
function stubCoreDays(slotsByDate: Record<string, Array<{ start: string; end: string }>>): {
  urls: () => string[];
} {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    const date = new URL(url).searchParams.get('date') ?? '';
    return Response.json({ date, slots: slotsByDate[date] ?? [] });
  });
  return { urls: () => urls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchAvailabilityBlocks', () => {
  it('asks Core for each day in the range, not a ranged route', async () => {
    const core = stubCoreDays({});
    await fetchAvailabilityBlocks(env as Env, 'rosa', { start: '2026-09-07', end: '2026-09-09' });
    expect(core.urls()).toEqual([
      'https://core.invalid/api/meet/rosa/availability?date=2026-09-07',
      'https://core.invalid/api/meet/rosa/availability?date=2026-09-08',
      'https://core.invalid/api/meet/rosa/availability?date=2026-09-09',
    ]);
  });

  it('unions back-to-back slots within a day into one block', async () => {
    stubCoreDays({
      '2026-09-07': [
        { start: '2026-09-07T09:00:00.000Z', end: '2026-09-07T09:30:00.000Z' },
        { start: '2026-09-07T09:30:00.000Z', end: '2026-09-07T10:00:00.000Z' },
      ],
    });
    const blocks = await fetchAvailabilityBlocks(env as Env, 'rosa', { start: '2026-09-07', end: '2026-09-07' });
    expect(blocks).toEqual([
      { start: '2026-09-07T09:00:00.000Z', end: '2026-09-07T10:00:00.000Z' },
    ]);
  });

  it('unions slots that overlap, as a meeting length longer than the 30-minute step produces', async () => {
    stubCoreDays({
      '2026-09-07': [
        { start: '2026-09-07T09:00:00.000Z', end: '2026-09-07T10:00:00.000Z' },
        { start: '2026-09-07T09:30:00.000Z', end: '2026-09-07T10:30:00.000Z' },
      ],
    });
    const blocks = await fetchAvailabilityBlocks(env as Env, 'rosa', { start: '2026-09-07', end: '2026-09-07' });
    expect(blocks).toEqual([
      { start: '2026-09-07T09:00:00.000Z', end: '2026-09-07T10:30:00.000Z' },
    ]);
  });

  it('keeps a gap between days as separate blocks', async () => {
    stubCoreDays({
      '2026-09-07': [{ start: '2026-09-07T09:00:00.000Z', end: '2026-09-07T09:30:00.000Z' }],
      '2026-09-08': [{ start: '2026-09-08T09:00:00.000Z', end: '2026-09-08T09:30:00.000Z' }],
    });
    const blocks = await fetchAvailabilityBlocks(env as Env, 'rosa', { start: '2026-09-07', end: '2026-09-08' });
    expect(blocks).toEqual([
      { start: '2026-09-07T09:00:00.000Z', end: '2026-09-07T09:30:00.000Z' },
      { start: '2026-09-08T09:00:00.000Z', end: '2026-09-08T09:30:00.000Z' },
    ]);
  });

  it('drops a malformed entry rather than letting it through as a block', async () => {
    vi.stubGlobal('fetch', async () => Response.json({
      slots: [
        { start: '2026-09-07T09:00:00.000Z', end: '2026-09-07T09:30:00.000Z' },
        { start: '2026-09-07T10:00:00.000Z' },
        'not an object',
      ],
    }));
    const blocks = await fetchAvailabilityBlocks(env as Env, 'rosa', { start: '2026-09-07', end: '2026-09-07' });
    expect(blocks).toEqual([
      { start: '2026-09-07T09:00:00.000Z', end: '2026-09-07T09:30:00.000Z' },
    ]);
  });

  it('throws when Core is down, so the caller can degrade rather than draw a wrong empty calendar', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ error: 'boom' }, { status: 503 }));
    await expect(fetchAvailabilityBlocks(env as Env, 'rosa', { start: '2026-09-07', end: '2026-09-07' }))
      .rejects.toThrow();
  });
});
