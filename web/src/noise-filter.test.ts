import { describe, expect, it, vi } from 'vitest';
import type { Room } from 'livekit-client';
import { noiseFilterHealth, setNoiseFilterWanted, subscribeNoiseFilter } from './noise-filter';

/*
 * `useSyncExternalStore` compares snapshots with `Object.is`. A getter that
 * builds a new object per call is a new snapshot every render, and React
 * throws — which was the meeting error boundary for every guest (f4aa4d4f).
 * This pins the contract: same reference while nothing changed, a new one
 * once something did.
 */
describe('noiseFilterHealth', () => {
  it('returns the same snapshot while nothing changed', () => {
    expect(noiseFilterHealth()).toBe(noiseFilterHealth());
  });

  it('returns a new snapshot after the preference flips, and tells subscribers', async () => {
    const before = noiseFilterHealth();
    const listener = vi.fn();
    const unsubscribe = subscribeNoiseFilter(listener);
    // No microphone is published on this room, so the filter has nothing to
    // attach to and the preference is the only thing that moves.
    const room = { localParticipant: { getTrackPublication: () => undefined } } as unknown as Room;
    await setNoiseFilterWanted(room, !before.wanted);
    const after = noiseFilterHealth();
    expect(after).not.toBe(before);
    expect(after.wanted).toBe(!before.wanted);
    expect(after).toBe(noiseFilterHealth());
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});
