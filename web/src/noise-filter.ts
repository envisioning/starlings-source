/**
 * Krisp noise cancellation on the published microphone.
 *
 * The guest's device is the only place guest audio can be cleaned: by the
 * time it reaches the host it is already encoded, and the host's transcriber
 * hears whatever arrived. The browser's own `noiseSuppression` stays on as the
 * floor; Krisp sits on top of it as a LiveKit track processor, runs its model
 * in the page, and sends no audio anywhere.
 *
 * The package is large (it carries the WASM model inline), so it is a dynamic
 * import that only loads when a microphone is published with the filter on.
 * It licenses itself against the LiveKit Cloud project the room is on and is
 * refused elsewhere; every failure here degrades to browser suppression and
 * says so in the debug report. It never blocks the publish.
 */
import { LocalAudioTrack, RoomEvent, Track, type LocalTrackPublication, type Room } from 'livekit-client';
import type { KrispNoiseFilterProcessor } from '@livekit/krisp-noise-filter';
import { loadMeetMediaPreferences, saveMeetMediaPreferences } from './meet-media-preferences';
import { t } from './i18n';

export type NoiseFilterPath = 'krisp' | 'browser';

export type NoiseFilterHealth = {
  /** What is cleaning the microphone right now. */
  path: NoiseFilterPath;
  /** The browser's preference, which may differ from `path` after a failure. */
  wanted: boolean;
  /** Whether this browser can run the filter at all (AudioWorklet, WASM). */
  supported: boolean | undefined;
  lastError?: string;
};

let wanted = loadMeetMediaPreferences().noiseFilter;
let supported: boolean | undefined;
let lastError: string | undefined;
let processor: KrispNoiseFilterProcessor | undefined;
let attachedTo: LocalAudioTrack | undefined;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeNoiseFilter(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// `useSyncExternalStore` compares snapshots with `Object.is`: a fresh object
// on every call is a new snapshot every render, and React throws "Maximum
// update depth exceeded" — which is the meeting error boundary for every
// guest, since MeetingSettings is always mounted. Hand back the same object
// until a field actually changes.
let snapshot: NoiseFilterHealth | undefined;

export function noiseFilterHealth(): NoiseFilterHealth {
  const active = Boolean(processor && attachedTo && attachedTo.getProcessor() === processor && processor.isEnabled());
  const next: NoiseFilterHealth = { path: active ? 'krisp' : 'browser', wanted, supported, lastError };
  if (
    snapshot
    && snapshot.path === next.path
    && snapshot.wanted === next.wanted
    && snapshot.supported === next.supported
    && snapshot.lastError === next.lastError
  ) {
    return snapshot;
  }
  snapshot = next;
  return snapshot;
}

export function noiseFilterWanted(): boolean {
  return wanted;
}

function roomMicrophone(room: Room): LocalAudioTrack | undefined {
  const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  return track instanceof LocalAudioTrack ? track : undefined;
}

function describe(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  return String(reason);
}

async function attach(track: LocalAudioTrack): Promise<void> {
  if (attachedTo === track && processor && track.getProcessor() === processor) {
    await processor.setEnabled(true);
    return;
  }
  const { KrispNoiseFilter, isKrispNoiseFilterSupported } = await import('@livekit/krisp-noise-filter');
  supported = isKrispNoiseFilterSupported();
  if (!supported) throw new Error(t('This browser cannot run the noise filter.'));
  // A processor belongs to one track; a re-published microphone gets a new one.
  processor = KrispNoiseFilter();
  attachedTo = track;
  await track.setProcessor(processor);
}

async function detach(): Promise<void> {
  const track = attachedTo;
  const current = processor;
  attachedTo = undefined;
  processor = undefined;
  if (track && current && track.getProcessor() === current) {
    await track.stopProcessor();
  }
}

/**
 * Bring the microphone in line with the preference. Safe to call at any time;
 * a microphone that is not published is left for `LocalTrackPublished`.
 */
export async function applyNoiseFilter(room: Room): Promise<void> {
  const track = roomMicrophone(room);
  try {
    if (!track) {
      await detach();
    } else if (wanted) {
      await attach(track);
      lastError = undefined;
    } else {
      await detach();
    }
  } catch (reason) {
    lastError = describe(reason);
    // The microphone keeps publishing through browser suppression.
    await detach().catch(() => undefined);
  }
  notify();
}

export async function setNoiseFilterWanted(room: Room, next: boolean): Promise<void> {
  wanted = next;
  saveMeetMediaPreferences({ noiseFilter: next });
  notify();
  await applyNoiseFilter(room);
}

/**
 * Follow the microphone across publishes for the life of the room. Returns
 * the teardown, which also drops the processor.
 */
export function watchMicrophoneForNoiseFilter(room: Room): () => void {
  const onPublished = (publication: LocalTrackPublication) => {
    if (publication.source === Track.Source.Microphone) void applyNoiseFilter(room);
  };
  const onUnpublished = (publication: LocalTrackPublication) => {
    if (publication.source === Track.Source.Microphone) void applyNoiseFilter(room);
  };
  room.on(RoomEvent.LocalTrackPublished, onPublished);
  room.on(RoomEvent.LocalTrackUnpublished, onUnpublished);
  void applyNoiseFilter(room);
  return () => {
    room.off(RoomEvent.LocalTrackPublished, onPublished);
    room.off(RoomEvent.LocalTrackUnpublished, onUnpublished);
    void detach().catch(() => undefined);
  };
}
