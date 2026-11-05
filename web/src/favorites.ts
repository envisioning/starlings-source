import type { SearchResponse } from '@starlings/contracts/search';
import type { FavoriteRow, FavoriteTarget } from '@starlings/contracts/favorites';
import { useEffect, useSyncExternalStore } from 'react';
import { apiFetch } from './api';
import { fetchStarred } from './crm-work';
import { t } from './i18n';
import { onOwnerPurge } from './owner-local-state';
import { loadSnapshot, saveSnapshot } from './snapshot-store';

export interface FavoritesSnapshot {
  rows: FavoriteRow[];
  starredRows: SearchResponse['rows'];
  loaded: boolean;
}

const emptySnapshot: FavoritesSnapshot = { rows: [], starredRows: [], loaded: false };
/** The last full read, so STARRED and the row stars draw on the first frame (docs/CACHING.md). */
const SAVED_KEY = 'crm/starred';
let snapshot: FavoritesSnapshot = savedFavorites() ?? emptySnapshot;

function savedFavorites(): FavoritesSnapshot | null {
  const saved = loadSnapshot<Pick<FavoritesSnapshot, 'rows' | 'starredRows'>>(SAVED_KEY);
  return saved ? { ...saved.value, loaded: true } : null;
}
let mutationVersion = 0;
let refreshInFlight: { version: number; promise: Promise<void> } | null = null;
const listeners = new Set<() => void>();
/** When the last full read landed. Every row and menu reads the store; only a stale store reads the server. */
let loadedAt = 0;
const FRESH_MS = 60_000;
let watchingVisibility = false;

function publish(next: FavoritesSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function targetKey(target: { kind: string; target_ref: string }): string {
  return `${target.kind}:${target.target_ref}`;
}

export function isFavorite(
  rows: FavoriteRow[] | undefined,
  target: Pick<FavoriteTarget, 'kind' | 'target_ref'>,
): boolean {
  const key = targetKey(target);
  return (rows ?? []).some((row) => targetKey(row) === key);
}

export async function refreshFavorites(): Promise<void> {
  const version = mutationVersion;
  if (refreshInFlight?.version === version) return refreshInFlight.promise;
  const promise = Promise.all([
    apiFetch<{ favorites: FavoriteRow[] }>('/crm/favorites', {
      fallbackError: t('Couldn’t load favorites.'),
      noStore: true,
    }),
    fetchStarred(),
  ]).then(([answer, starred]) => {
    if (version === mutationVersion) {
      loadedAt = Date.now();
      saveSnapshot(SAVED_KEY, { rows: answer.favorites, starredRows: starred.rows });
      publish({ rows: answer.favorites, starredRows: starred.rows, loaded: true });
    }
  }).finally(() => {
    if (refreshInFlight?.promise === promise) refreshInFlight = null;
  });
  refreshInFlight = { version, promise };
  return promise;
}

/** One mutation path for every browser surface; a successful write reaches Home and open rails. */
export async function setFavorite(
  target: FavoriteTarget,
  starred: boolean,
): Promise<void> {
  // A read that began before this write must not overwrite its result.
  mutationVersion += 1;
  if (starred) {
    const answer = await apiFetch<{ favorite: FavoriteRow }>('/crm/favorites', {
      method: 'POST',
      body: target,
      fallbackError: t('Couldn’t update favorites.'),
    });
    const rows = snapshot.rows.filter((row) => targetKey(row) !== targetKey(target));
    publish({ rows: [answer.favorite, ...rows], starredRows: snapshot.starredRows, loaded: true });
  } else {
    const query = new URLSearchParams({ kind: target.kind, target_ref: target.target_ref });
    await apiFetch(`/crm/favorites?${query}`, {
      method: 'DELETE',
      fallbackError: t('Couldn’t update favorites.'),
    });
    publish({ rows: snapshot.rows.filter((row) => targetKey(row) !== targetKey(target)), starredRows: snapshot.starredRows, loaded: true });
  }
  // Invalidate reads started while the mutation was in flight as well.
  mutationVersion += 1;
  // Pull canonical order and any queued writes back through the same API.
  void refreshFavorites().catch(() => {});
}

/** Read the server only when the store has not been read in the last minute. */
function refreshIfStale(): void {
  if (Date.now() - loadedAt < FRESH_MS) return;
  void refreshFavorites().catch(() => {});
}

/**
 * Stars change on other devices, so a tab coming back into view reads again
 * when stale. One listener for the store, not one per row.
 */
function watchVisibility(): void {
  if (watchingVisibility || typeof document === 'undefined') return;
  watchingVisibility = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && listeners.size > 0) refreshIfStale();
  });
}

/** Sign-out: the next owner on this browser starts with no stars and reads its own. */
function clearFavorites(): void {
  mutationVersion += 1;
  loadedAt = 0;
  publish(emptySnapshot);
}
onOwnerPurge(clearFavorites);

export function useFavorites(): FavoritesSnapshot {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => emptySnapshot,
  );
  // Each rail row and each opened menu mounts a reader. Without the
  // freshness check every mount sent two requests.
  useEffect(() => {
    watchVisibility();
    refreshIfStale();
  }, []);
  return current;
}
