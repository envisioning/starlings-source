import type { LocalVideoTrack } from 'livekit-client';
import { activeProcessorHealth } from './processor-health';
import { t } from './i18n';

/**
 * Last line of defence for the published camera.
 *
 * Everything upstream of the encoder can fail silently: a background processor
 * whose render loop dies, a WebGL context that never comes back, a camera the
 * OS hands to another app, a track that ends when a Continuity Camera sleeps.
 * In every one of those cases the publisher stays "connected", audio keeps
 * flowing, and the participant tile shows a frozen frame — nobody in the call
 * gets told. LiveKit reports the participant as `poor` quality, which reads as
 * a network problem and sends everyone chasing the wrong thing.
 *
 * So we watch the only signal that cannot lie about it: `framesEncoded` on the
 * sender. If it stops advancing while the camera is on and the page is
 * visible, we walk a recovery ladder and, at worst, tell the user.
 */

const CHECK_INTERVAL_MS = 2_000;
/** Encoder must be stalled at least this long before we act. */
const STALL_MS = 6_000;
/** How long a recovery step gets to produce frames before we escalate. */
const RECOVERY_GRACE_MS = 6_000;

export type CameraWatchdogEvent =
  | { type: 'stalled' }
  | { type: 'recovered' }
  | { type: 'effect-dropped'; reason: string }
  | { type: 'camera-restarted' }
  | { type: 'failed'; reason: string };

type Stage = 'healthy' | 'restart-effect' | 'drop-effect' | 'restart-camera' | 'failed';

export type CameraWatchdogOptions = {
  getTrack: () => LocalVideoTrack | undefined;
  /** Re-apply the user's current background effect to a (re)published track. */
  reapplyEffect: (track: LocalVideoTrack) => Promise<void>;
  /** Whether an effect is currently meant to be on. */
  hasEffect: () => boolean;
  onEvent: (event: CameraWatchdogEvent) => void;
};

async function framesEncoded(track: LocalVideoTrack): Promise<number | undefined> {
  const report = await track.getRTCStatsReport().catch(() => undefined);
  if (!report) return undefined;
  let total = 0;
  let sawOutbound = false;
  report.forEach((entry) => {
    const stat = entry as { type?: string; kind?: string; framesEncoded?: number };
    if (stat.type !== 'outbound-rtp' || stat.kind !== 'video') return;
    sawOutbound = true;
    total += stat.framesEncoded ?? 0;
  });
  return sawOutbound ? total : undefined;
}

/**
 * Starts the watchdog. Returns a stop function; safe to call more than once.
 */
export function startCameraWatchdog(options: CameraWatchdogOptions): () => void {
  const { getTrack, reapplyEffect, hasEffect, onEvent } = options;

  let stopped = false;
  let stage: Stage = 'healthy';
  let lastFrames: number | undefined;
  let lastProgressAt = performance.now();
  let recoveryStartedAt = 0;
  let busy = false;
  let announcedStall = false;

  let lastRungError = '';

  const resetClock = () => {
    lastProgressAt = performance.now();
    lastFrames = undefined;
  };

  const noteRungFailure = (error: unknown): void => {
    lastRungError = error instanceof Error ? error.message : String(error ?? 'unknown error');
  };

  /** Rebuild the effect from scratch on the current track. */
  const restartEffect = async (track: LocalVideoTrack): Promise<void> => {
    await track.stopProcessor();
    await reapplyEffect(track);
  };

  const dropEffect = async (track: LocalVideoTrack, reason: string): Promise<void> => {
    await track.stopProcessor();
    onEvent({ type: 'effect-dropped', reason });
  };

  /**
   * One rung per call. A rung that throws is still a rung spent: the stage has
   * already advanced, so the next tick tries the next thing rather than giving
   * up. Only running out of rungs is terminal.
   */
  const escalate = async (track: LocalVideoTrack): Promise<void> => {
    const health = activeProcessorHealth();
    const effectOn = hasEffect();

    // Worth one full rebuild first: unlike the processor's own in-place
    // recovery, this recreates the MediaPipe segmenter and both canvases.
    if (effectOn && stage === 'healthy') {
      stage = 'restart-effect';
      await restartEffect(track).catch(noteRungFailure);
      return;
    }

    if (effectOn && (stage === 'healthy' || stage === 'restart-effect')) {
      stage = 'drop-effect';
      await dropEffect(
        track,
        health?.lastError?.trim()
          ? t('Background effect stopped your video ({lastError}).', { lastError: health.lastError })
          : t('Background effect stopped your video.'),
      ).catch(noteRungFailure);
      return;
    }

    if (stage !== 'restart-camera' && stage !== 'failed') {
      stage = 'restart-camera';
      await track
        .restartTrack()
        .then(() => onEvent({ type: 'camera-restarted' }))
        .catch(noteRungFailure);
      return;
    }

    // Out of rungs. Say so once, then keep watching quietly — if frames come
    // back on their own the healthy branch clears the stage.
    if (stage === 'failed') return;
    stage = 'failed';
    onEvent({
      type: 'failed',
      reason: lastRungError
        ? t('Your camera stopped sending video ({lastRungError}). Reload the page, or close any other app using the camera.', { lastRungError })
        : t('Your camera stopped sending video. Reload the page, or close any other app using the camera.'),
    });
  };

  const check = async (): Promise<void> => {
    const track = getTrack();
    if (!track) return resetClock();

    // Camera off, upstream deliberately paused, or a hidden page (where the
    // canvas render path legitimately idles) are all not stalls.
    if (track.isMuted || track.isUpstreamPaused || document.visibilityState !== 'visible') {
      return resetClock();
    }

    const frames = await framesEncoded(track);
    if (frames === undefined) {
      // Not published yet (prejoin) — nothing authoritative to measure.
      return resetClock();
    }

    const now = performance.now();
    if (lastFrames === undefined || frames > lastFrames) {
      lastFrames = frames;
      lastProgressAt = now;
      if (stage !== 'healthy' || announcedStall) {
        stage = 'healthy';
        announcedStall = false;
        onEvent({ type: 'recovered' });
      }
      return;
    }

    const threshold = stage === 'healthy' ? STALL_MS : RECOVERY_GRACE_MS;
    if (now - lastProgressAt < threshold) return;
    if (stage !== 'healthy' && now - recoveryStartedAt < RECOVERY_GRACE_MS) return;

    if (!announcedStall) {
      announcedStall = true;
      onEvent({ type: 'stalled' });
    }

    recoveryStartedAt = now;
    try {
      await escalate(track);
    } catch (error) {
      // Rungs swallow their own failures; anything reaching here is a bug in
      // the ladder itself, and must still not kill the watchdog.
      noteRungFailure(error);
    } finally {
      // Give the new pipeline a moment before judging it.
      lastFrames = undefined;
      lastProgressAt = performance.now();
    }
  };

  const tick = async (): Promise<void> => {
    // `check` awaits, so overlapping ticks would race the stage machine.
    if (stopped || busy) return;
    busy = true;
    try {
      await check();
    } finally {
      busy = false;
    }
  };

  const timer = window.setInterval(() => void tick(), CHECK_INTERVAL_MS);

  return () => {
    if (stopped) return;
    stopped = true;
    window.clearInterval(timer);
  };
}
