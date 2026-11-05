import { createContext, useCallback, useEffect, useRef, useState } from 'react';
import { Track } from 'livekit-client';
import type { TrackReferenceOrPlaceholder } from '@livekit/components-react';
import { ownerAccountEmail } from '@starlings/contracts/identity-values';
import { readStored, removeStored, StorageKeys, writeStored } from './storage';

export const DEFAULT_FACE_ANCHOR = { x: 0.5, y: 0.42 };
export const SCREEN_SHARE_LAYOUT_CHOICES = ['automatic', 'overlay', 'rail'] as const;
export type ScreenShareLayoutChoice = typeof SCREEN_SHARE_LAYOUT_CHOICES[number];
const MAX_AUTOMATIC_OVERLAY_PARTICIPANTS = 4;
const SCREEN_SHARE_OVERLAY_TILE_SIDE = 76;
const SCREEN_SHARE_OVERLAY_SPACING = 12;

export function isScreenShareOverlay(
  choice: ScreenShareLayoutChoice,
  participantCount: number,
  width: number,
  height: number,
): boolean {
  if (height < SCREEN_SHARE_OVERLAY_TILE_SIDE + SCREEN_SHARE_OVERLAY_SPACING) return false;
  if (choice === 'overlay') return true;
  if (choice === 'rail' || participantCount > MAX_AUTOMATIC_OVERLAY_PARTICIPANTS) return false;
  const requiredWidth = participantCount * SCREEN_SHARE_OVERLAY_TILE_SIDE
    + (participantCount + 1) * SCREEN_SHARE_OVERLAY_SPACING;
  return width >= requiredWidth;
}

/** Remembered on this browser, so a guest can pick the same layout next time. */
export function useScreenShareLayoutChoice() {
  const [choice, setChoice] = useState<ScreenShareLayoutChoice>(() => {
    const stored = readStored(StorageKeys.screenShareLayout);
    return SCREEN_SHARE_LAYOUT_CHOICES.find((candidate) => candidate === stored) ?? 'automatic';
  });

  const choose = useCallback((next: ScreenShareLayoutChoice) => {
    writeStored(StorageKeys.screenShareLayout, next);
    setChoice(next);
  }, []);

  return [choice, choose] as const;
}

/**
 * Which person a connection belongs to. `mz+iphone@…` and `mz+mac@…` are one:
 * the stage merges their tiles by it, and spatial audio places their voices
 * by it (`spatial-audio.tsx`).
 */
export function personKey(identity: string | undefined): string {
  return ownerAccountEmail((identity ?? '').toLowerCase());
}

export const SELF_VIEW_SIZE_RANGE = { min: 110, max: 420 };
const DEFAULT_SELF_VIEW_SIZE = 180;

function clampSelfViewSize(value: number): number {
  return Math.min(
    SELF_VIEW_SIZE_RANGE.max,
    Math.max(SELF_VIEW_SIZE_RANGE.min, Math.round(value)),
  );
}

/**
 * The self-view square's side length, in px — resizable by dragging its
 * corner handle, remembered across reloads the same way media preferences
 * are (`meet-media-preferences.ts`).
 */
export function useSelfViewSize() {
  const [size, setSize] = useState(() => {
    const stored = Number(readStored(StorageKeys.selfViewSize));
    return stored > 0 ? clampSelfViewSize(stored) : DEFAULT_SELF_VIEW_SIZE;
  });

  const resize = useCallback((next: number) => {
    setSize((current) => {
      const clamped = clampSelfViewSize(next);
      if (clamped === current) return current;
      writeStored(StorageKeys.selfViewSize, String(clamped));
      return clamped;
    });
  }, []);

  return [size, resize] as const;
}

/** Camera tile for the local participant — the one the self-view mode governs. */
export function isLocalCameraTile(track: TrackReferenceOrPlaceholder): boolean {
  return track.participant.isLocal && track.source === Track.Source.Camera;
}

/**
 * Where your own camera shows on this browser's stage. Publishing is untouched
 * in every mode — same contract as Mac "Hide me".
 *
 * - `floating`: the resizable square over the stage (the default).
 * - `docked`: one tile among everyone else's, in the grid or the share
 *   carousel, so it never covers a shared screen (#212).
 * - `hidden`: no tile; "Show me" in the controls brings it back.
 */
export type SelfViewMode = 'floating' | 'docked' | 'hidden';

/**
 * Docked is remembered across reloads like the square's size; hidden is not,
 * so a fresh join always shows you where you are.
 */
export function useSelfViewMode() {
  const [mode, setModeState] = useState<SelfViewMode>(() => (
    readStored(StorageKeys.selfViewDocked) === '1' ? 'docked' : 'floating'
  ));

  const setMode = useCallback((next: SelfViewMode) => {
    if (next === 'docked') writeStored(StorageKeys.selfViewDocked, '1');
    else if (next === 'floating') removeStored(StorageKeys.selfViewDocked);
    setModeState(next);
  }, []);

  return [mode, setMode] as const;
}

/**
 * Set while the self tile is docked: the handler that floats it again, which
 * `MeetParticipantTile` draws on the local camera tile. Null everywhere else,
 * so the floating square never grows a second control set.
 */
export const SelfDockContext = createContext<(() => void) | null>(null);

export { squareGridPlan, type SquareGridPlan } from './square-grid';

interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NativeFaceDetector {
  detect(video: HTMLVideoElement): Promise<FaceBox[]>;
}

interface NativeFaceDetectorConstructor {
  new (options?: { fastMode?: boolean; maxDetectedFaces?: number }): NativeFaceDetector;
}

interface FaceDetectorGlobal {
  FaceDetector?: NativeFaceDetectorConstructor;
}

/**
 * Centers a camera progressively when the browser offers its native detector.
 * Safari and older browsers simply stay at the same face-safe default crop.
 */
export function useFaceCenteredCamera(enabled: boolean) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const anchorRef = useRef({ ...DEFAULT_FACE_ANCHOR });
  const lastDetectionAt = useRef<number | null>(null);
  const [anchor, setAnchor] = useState({ ...DEFAULT_FACE_ANCHOR });

  useEffect(() => {
    if (!enabled) return undefined;

    const detectorConstructor = (globalThis as typeof globalThis & FaceDetectorGlobal).FaceDetector;
    if (!detectorConstructor) return undefined;

    let cancelled = false;
    let detector: NativeFaceDetector;
    try {
      detector = new detectorConstructor({ fastMode: true, maxDetectedFaces: 3 });
    } catch {
      return undefined;
    }

    const update = async () => {
      const video = videoRef.current;
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
        || video.videoWidth <= 0 || video.videoHeight <= 0
        || video.getBoundingClientRect().width < 140) return;

      let faces: FaceBox[];
      try {
        faces = await detector.detect(video);
      } catch {
        return;
      }
      if (cancelled) return;

      const totalArea = faces.reduce(
        (total, face) => total + Math.max(0, face.width) * Math.max(0, face.height),
        0,
      );
      const target = totalArea > 0
        ? faces.reduce((center, face) => {
          const area = Math.max(0, face.width) * Math.max(0, face.height);
          return {
            x: center.x + ((face.x + face.width / 2) / video.videoWidth) * area / totalArea,
            y: center.y + ((face.y + face.height / 2) / video.videoHeight) * area / totalArea,
          };
        }, { x: 0, y: 0 })
        : null;

      const now = performance.now();
      if (target) {
        lastDetectionAt.current = now;
        const clamped = {
          x: Math.min(Math.max(target.x, 0.1), 0.9),
          y: Math.min(Math.max(target.y, 0.16), 0.84),
        };
        const dx = clamped.x - anchorRef.current.x;
        const dy = clamped.y - anchorRef.current.y;
        if (Math.hypot(dx, dy) > 0.035) {
          anchorRef.current = {
            x: anchorRef.current.x + dx * 0.28,
            y: anchorRef.current.y + dy * 0.28,
          };
        }
      } else if (lastDetectionAt.current !== null && now - lastDetectionAt.current > 2_000) {
        anchorRef.current = {
          x: anchorRef.current.x + (DEFAULT_FACE_ANCHOR.x - anchorRef.current.x) * 0.28,
          y: anchorRef.current.y + (DEFAULT_FACE_ANCHOR.y - anchorRef.current.y) * 0.28,
        };
      }
      setAnchor({ ...anchorRef.current });
    };

    void update();
    const interval = window.setInterval(() => { void update(); }, 1_250);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [enabled]);

  return {
    videoRef,
    objectPosition: `${anchor.x * 100}% ${anchor.y * 100}%`,
  };
}
