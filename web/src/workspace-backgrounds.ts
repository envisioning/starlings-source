import { useSyncExternalStore } from 'react';
import { BACKGROUND_TONE_LABELS, BACKGROUND_TONES, ENVISIONING_BACKGROUND_TONES, type BackgroundTone, type BackgroundTonePair } from '@starlings/contracts/background-gallery';
import type { WorkspaceBackgroundProfile } from '@starlings/contracts/workspace-backgrounds';
import type { BackgroundEffectChoice } from './background-effects';

const FALLBACK: WorkspaceBackgroundProfile = { tones: ENVISIONING_BACKGROUND_TONES, image_url: null, default: null };
let profile = FALLBACK;
let readAt = 0;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();
export const workspaceBackgroundProfile = () => profile;
export function subscribeWorkspaceBackgrounds(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useWorkspaceBackgrounds() { return useSyncExternalStore(subscribeWorkspaceBackgrounds, workspaceBackgroundProfile); }

/** Public descriptor: guests and members use the same profile, without cookies. */
export async function refreshWorkspaceBackgrounds(): Promise<void> {
  if (pending) return pending;
  if (Date.now() - readAt < 30_000) return;
  pending = (async () => {
    try {
      const response = await fetch('/.well-known/meet', { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return;
      const descriptor = await response.json() as { brand?: { backgrounds?: unknown } };
      const { workspaceBackgroundProfileSchema } = await import('@starlings/contracts/workspace-backgrounds');
      const parsed = workspaceBackgroundProfileSchema.safeParse(descriptor.brand?.backgrounds);
      if (!parsed.success) return;
      // A workspace cannot point the camera processor at an unrelated host.
      if (parsed.data.image_url && new URL(parsed.data.image_url).origin !== window.location.origin) return;
      setWorkspaceBackgroundProfile(parsed.data);
    } catch { /* Offline keeps the pinned profile; the next mount can retry. */ }
  })().finally(() => { pending = null; });
  return pending;
}

export function setWorkspaceBackgroundProfile(next: WorkspaceBackgroundProfile): void {
  profile = next;
  readAt = Date.now();
  for (const listener of listeners) listener();
}

export function workspaceDefaultBackground(): BackgroundEffectChoice {
  const value = profile.default;
  return value?.mode === 'generated' ? value : value?.mode === 'image' && profile.image_url ? { mode: 'workspace-image' } : { mode: 'none' };
}

export function workspaceTonePair(tone: BackgroundTone): BackgroundTonePair {
  const pair = profile.tones[tone];
  const pinned = BACKGROUND_TONES.every(t => profile.tones[t].base === ENVISIONING_BACKGROUND_TONES[t].base && profile.tones[t].modules === ENVISIONING_BACKGROUND_TONES[t].modules);
  return { ...pair, label: pinned ? ENVISIONING_BACKGROUND_TONES[tone].label : BACKGROUND_TONE_LABELS[tone].label };
}
