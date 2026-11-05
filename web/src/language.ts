import { useCallback, useEffect, useState } from 'react';
import { resolveLanguage } from '@starlings/contracts/language-values';
import type { Language } from '@starlings/contracts/language-values';
import type { LanguagePreferenceResponse } from '@starlings/contracts/language';
import { apiFetch } from './api';
import { staleReadError, storeGeneration } from './snapshot-store';
import { readStored, removeStored, StorageKeys, writeStored } from './storage';
import { languageFor, t, uiLanguage } from './i18n';

/**
 * The language the interface is drawn in, on this browser: the owner-synced
 * choice, cached locally so the next load knows it and replaced
 * by the Worker's answer on load. Settings writes through `saveLanguage`,
 * and every mounted `useLanguage` re-draws at once.
 *
 * `null` is "follow the browser". `./i18n` reads the cached choice once at
 * load and fixes the page's language; a change reloads the page.
 */

function readCached(): Language | null {
  try {
    return resolveLanguage(readStored(StorageKeys.language));
  } catch {
    return null;
  }
}

function writeCached(language: Language | null): void {
  if (language) writeStored(StorageKeys.language, language);
  else removeStored(StorageKeys.language);
}

const listeners = new Set<(language: Language | null) => void>();
let current: Language | null = readCached();

function publish(language: Language | null): void {
  if (language === current) return;
  current = language;
  writeCached(language);
  for (const listener of listeners) listener(language);
}

export async function fetchLanguage(): Promise<Language | null> {
  const started = storeGeneration();
  const body = await apiFetch<LanguagePreferenceResponse>('/profile/language', {
    fallbackError: t('Couldn’t load your language.'),
    noStore: true,
  });
  // Signed out while the request was out: this is the last owner's.
  if (storeGeneration() !== started) throw staleReadError();
  const language = resolveLanguage(body.language);
  publish(language);
  // Chosen on another device: this page drew in the old language. The
  // cache now holds the new one, so one reload draws it — the web's
  // version of the native restart. Nothing loops: the next load reads the
  // cache and matches.
  if (languageFor(language) !== uiLanguage) window.location.reload();
  return language;
}

export async function saveLanguage(next: Language | null): Promise<Language | null> {
  const previous = current;
  // Show the choice now; the round trip confirms or reverts it.
  publish(next);
  try {
    const body = await apiFetch<LanguagePreferenceResponse>('/profile/language', {
      method: 'PUT',
      body: { language: next },
      fallbackError: t('Couldn’t save your language.'),
      noStore: true,
    });
    const saved = resolveLanguage(body.language);
    publish(saved);
    return saved;
  } catch (error) {
    publish(previous);
    throw error;
  }
}

/** Signed out: nobody's choice. */
export function clearLanguage(): void {
  publish(null);
}

/**
 * The choice to draw, and a way to change it. `enabled` false (a visitor)
 * reads the cache only and never asks the Worker.
 */
export function useLanguage(enabled: boolean): {
  language: Language | null;
  save: (next: Language | null) => Promise<Language | null>;
  loaded: boolean;
} {
  const [language, setLanguage] = useState<Language | null>(current);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    listeners.add(setLanguage);
    setLanguage(current);
    return () => {
      listeners.delete(setLanguage);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchLanguage()
      .catch(() => undefined)
      .then(() => {
        // The cached choice is still the right one after a failed read.
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const save = useCallback((next: Language | null) => saveLanguage(next), []);

  return { language, save, loaded };
}
