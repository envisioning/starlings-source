import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_HOME_LAYOUT,
  homeLayoutEquals,
  resolveHomeLayout,
  type HomeModuleSetting,
} from '@starlings/contracts/home-layout-values';
import type { HomePreferencesResponse } from '@starlings/contracts/home-layout';
import { apiFetch } from './api';
import { staleReadError, storeGeneration } from './snapshot-store';
import { readStored, StorageKeys, writeStored } from './storage';
import { t } from './i18n';

/**
 * What Home is made of on this browser: the owner-synced module order
 * (`fixtures/home-layout.json`), cached locally for the first paint and
 * replaced by the Worker's answer on load. Settings writes through
 * `saveHomeLayout`, and every mounted `useHomeLayout` re-draws at once.
 */

function readCached(): HomeModuleSetting[] {
  try {
    const raw = readStored(StorageKeys.homeLayout);
    if (!raw) return [...DEFAULT_HOME_LAYOUT];
    const parsed: unknown = JSON.parse(raw);
    return resolveHomeLayout(Array.isArray(parsed) ? parsed as Array<{ id: string; enabled: boolean }> : null);
  } catch {
    return [...DEFAULT_HOME_LAYOUT];
  }
}

function writeCached(layout: HomeModuleSetting[]): void {
  writeStored(StorageKeys.homeLayout, JSON.stringify(layout));
}

const listeners = new Set<(layout: HomeModuleSetting[]) => void>();
let current: HomeModuleSetting[] = readCached();

function publish(layout: HomeModuleSetting[]): void {
  if (homeLayoutEquals(layout, current)) return;
  current = layout;
  writeCached(layout);
  for (const listener of listeners) listener(layout);
}

export async function fetchHomeLayout(): Promise<HomeModuleSetting[]> {
  const started = storeGeneration();
  const body = await apiFetch<HomePreferencesResponse>('/home/preferences', {
    fallbackError: t('Couldn’t load your Home layout.'),
    noStore: true,
  });
  // Signed out while the request was out: this is the last owner's.
  if (storeGeneration() !== started) throw staleReadError();
  const layout = resolveHomeLayout(body.modules);
  publish(layout);
  return layout;
}

export async function saveHomeLayout(next: HomeModuleSetting[]): Promise<HomeModuleSetting[]> {
  const resolved = resolveHomeLayout(next);
  const previous = current;
  // Draw the new order now; the round trip confirms or reverts it.
  publish(resolved);
  try {
    const body = await apiFetch<HomePreferencesResponse>('/home/preferences', {
      method: 'PUT',
      body: { modules: resolved },
      fallbackError: t('Couldn’t save your Home layout.'),
      noStore: true,
    });
    const saved = resolveHomeLayout(body.modules);
    publish(saved);
    return saved;
  } catch (error) {
    publish(previous);
    throw error;
  }
}

/** Signed out: nobody's layout. */
export function clearHomeLayout(): void {
  publish([...DEFAULT_HOME_LAYOUT]);
}

/**
 * The layout to draw, and a way to change it. `enabled` false (a visitor)
 * reads the cache only and never asks the Worker.
 */
export function useHomeLayout(enabled: boolean): {
  layout: HomeModuleSetting[];
  save: (next: HomeModuleSetting[]) => Promise<HomeModuleSetting[]>;
  loaded: boolean;
} {
  const [layout, setLayout] = useState<HomeModuleSetting[]>(current);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    listeners.add(setLayout);
    setLayout(current);
    return () => {
      listeners.delete(setLayout);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchHomeLayout()
      .catch(() => undefined)
      .then(() => {
        // The cached order is still the right order to draw after a failed read.
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const save = useCallback((next: HomeModuleSetting[]) => saveHomeLayout(next), []);

  return { layout, save, loaded };
}
