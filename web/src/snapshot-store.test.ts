// A read that started before sign-out lands after it (meet#193): nothing of
// it may be saved or shown. The purge is the boundary; `revalidate` and the
// preference stores compare the store generation across the await.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlRequestError } from './config';
import { loadSnapshot, purgeSnapshots, revalidate, saveSnapshot, storeGeneration } from './snapshot-store';

vi.mock('./api', () => ({ apiFetch: vi.fn() }));
const { apiFetch } = await import('./api');
const { fetchHomeLayout, clearHomeLayout } = await import('./home-layout');
const { fetchLanguage } = await import('./language');
const { purgeOwnerLocalState } = await import('./owner-local-state');

/** A request held open until the test lets it answer. */
function gate<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release };
}

beforeEach(() => {
  localStorage.clear();
  purgeSnapshots();
  vi.mocked(apiFetch).mockReset();
});

describe('revalidate across a sign-out', () => {
  it('keeps what a read saved when nobody signed out', async () => {
    const value = await revalidate('crm/mine', async () => ({ unchanged: false, value: { rows: [1] }, etag: 'a' }), (body) => body);
    expect(value).toEqual({ rows: [1] });
    expect(loadSnapshot('crm/mine')).toMatchObject({ value: { rows: [1] }, etag: 'a' });
  });

  it('refuses a read that lands after the purge, and saves nothing', async () => {
    saveSnapshot('crm/mine', { rows: ['the last owner'] }, 'old');
    const held = gate<{ unchanged: false; value: { rows: string[] }; etag: string }>();
    const read = revalidate('crm/mine', () => held.promise, (body) => body);

    purgeSnapshots();
    expect(loadSnapshot('crm/mine')).toBeNull();
    held.release({ unchanged: false, value: { rows: ['still the last owner'] }, etag: 'late' });

    await expect(read).rejects.toMatchObject({ status: 401, code: 'session_expired' });
    await expect(read).rejects.toBeInstanceOf(ControlRequestError);
    expect(loadSnapshot('crm/mine')).toBeNull();
    expect(localStorage.getItem('meet-snapshot:crm/mine')).toBeNull();
  });

  it('refuses a 304 the same way: the snapshot it would keep is gone', async () => {
    saveSnapshot('crm/mine', { rows: ['the last owner'] }, 'old');
    const held = gate<{ unchanged: true; etag: string }>();
    const read = revalidate('crm/mine', () => held.promise, (body: unknown) => body);
    purgeSnapshots();
    held.release({ unchanged: true, etag: 'old' });
    await expect(read).rejects.toMatchObject({ code: 'session_expired' });
    expect(loadSnapshot('crm/mine')).toBeNull();
  });

  it('counts every purge, so two sign-outs in a row are two boundaries', () => {
    const before = storeGeneration();
    purgeSnapshots();
    purgeSnapshots();
    expect(storeGeneration()).toBe(before + 2);
  });
});

describe('the preference stores across a sign-out', () => {
  it('drops a Home layout that lands after the purge', async () => {
    clearHomeLayout();
    const held = gate<{ modules: Array<{ id: string; enabled: boolean }> }>();
    vi.mocked(apiFetch).mockReturnValueOnce(held.promise);
    const read = fetchHomeLayout();
    purgeOwnerLocalState();
    held.release({ modules: [{ id: 'room', enabled: true }, { id: 'messages', enabled: false }] });
    await expect(read).rejects.toMatchObject({ code: 'session_expired' });
    expect(localStorage.getItem('meet-home-layout')).toBeNull();
  });

  it('drops a language that lands after the purge', async () => {
    const held = gate<{ language: string | null }>();
    vi.mocked(apiFetch).mockReturnValueOnce(held.promise);
    const read = fetchLanguage();
    purgeOwnerLocalState();
    held.release({ language: 'pt' });
    await expect(read).rejects.toMatchObject({ code: 'session_expired' });
    expect(localStorage.getItem('meet-language')).toBeNull();
  });
});
