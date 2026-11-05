import { useEffect, useState } from 'react';

export type ThemePreference = 'auto' | 'light' | 'dark';

const STORAGE_KEY = 'meet.appearance.mode';
const CHANGE_EVENT = 'meet:appearance-change';

/** Meet opens dark and stays dark until someone picks otherwise. Matches the
 *  Mac and iOS default (`StarlingsAppearanceSettings.defaultMode`), and the dark
 *  pre-paint already in `index.html`, so an unset browser never flashes. */
const DEFAULT_PREFERENCE: ThemePreference = 'dark';

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'auto' || value === 'light' || value === 'dark';
}

export function readThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return DEFAULT_PREFERENCE;
  const value = window.localStorage.getItem(STORAGE_KEY);
  return isThemePreference(value) ? value : DEFAULT_PREFERENCE;
}

/** Apply before React mounts so a reload does not flash the wrong palette. */
export function applyThemePreference(preference: ThemePreference = readThemePreference()): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = preference;
}

export function setThemePreference(preference: ThemePreference): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, preference);
  applyThemePreference(preference);
  window.dispatchEvent(new CustomEvent<ThemePreference>(CHANGE_EVENT, { detail: preference }));
}

export function useThemePreference(): [ThemePreference, (preference: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);

  useEffect(() => {
    applyThemePreference(preference);
  }, [preference]);

  useEffect(() => {
    function onChange(event: Event) {
      const next = (event as CustomEvent<ThemePreference>).detail;
      if (isThemePreference(next)) setPreference(next);
    }
    function onStorage(event: StorageEvent) {
      if (event.key === STORAGE_KEY) setPreference(readThemePreference());
    }
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return [preference, setThemePreference];
}

