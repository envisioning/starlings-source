import { useEffect, useState } from 'react';

/*
 * The grid texture behind Home and the meeting Stage, on or off for this
 * browser (#230). The same device-local switch the Mac and iOS Appearance
 * pages have (`HomeTexturePreferences`); nothing syncs it, on purpose.
 */
const STORAGE_KEY = 'meet.home.texture';
const CHANGE_EVENT = 'meet:home-texture-change';

export function readHomeTexture(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setHomeTexture(shows: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (shows) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, 'off');
  } catch {
    // Storage blocked: the change lasts for this page only.
  }
  window.dispatchEvent(new CustomEvent<boolean>(CHANGE_EVENT, { detail: shows }));
}

export function useHomeTexture(): [boolean, (shows: boolean) => void] {
  const [shows, setShows] = useState<boolean>(readHomeTexture);
  useEffect(() => {
    const onChange = (event: Event) => setShows((event as CustomEvent<boolean>).detail);
    const onStorage = (event: StorageEvent) => { if (event.key === STORAGE_KEY) setShows(readHomeTexture()); };
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return [shows, setHomeTexture];
}
