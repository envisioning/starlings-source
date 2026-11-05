import { BackgroundTransformer, ProcessorWrapper } from '@livekit/track-processors';
import type { ProcessorOptions, Track, TrackProcessor } from 'livekit-client';
import { setProcessorHealthSource, type ProcessorHealth } from './processor-health';
import { t } from './i18n';

/**
 * Why this file exists.
 *
 * `@livekit/track-processors` has two rendering paths. Chromium gets the
 * "modern" one (MediaStreamTrackProcessor/Generator piped through a
 * TransformStream). Everything else — Safari and Firefox — gets a
 * requestAnimationFrame loop that draws into a canvas and publishes
 * `canvas.captureStream()`.
 *
 * That fallback loop has a fatal bug (0.5.7, ProcessorWrapper.startRenderLoop):
 *
 *     if (this.sourceDummy.paused) {
 *       this.sourceDummy.play();
 *       return;              // <- no requestAnimationFrame reschedule
 *     }
 *
 * The hidden source <video> LiveKit feeds the processor is never added to the
 * document and (on Safari) never gets `autoplay`, so Safari is free to pause it
 * on occlusion, display sleep or power saving. The first pause kills the render
 * loop permanently: the canvas is never painted again, the captured track goes
 * to 0fps, and the publisher sends 0bps with no frames ever encoded. Audio is
 * unaffected, so the call "works" while the camera is silently dead.
 *
 * So we own the fallback path. The loop here reschedules unconditionally, the
 * source element is mounted and kept playing, and a supervisor re-arms or
 * rebuilds the pipeline when frames stop. Chromium keeps the upstream modern
 * path — it has no rAF loop to break.
 */

const CAPTURE_FPS = 30;
const MAX_FPS = 30;
/** No painted frame for this long (page visible) counts as a stall. */
const STALL_MS = 2_500;
const SUPERVISOR_INTERVAL_MS = 1_000;
/** Consecutive stall ticks before we rebuild the WebGL transformer. */
const STALL_TICKS_BEFORE_REBUILD = 3;
/** Rebuilds that fail to restore frames before we declare the effect unusable. */
const MAX_TRANSFORMER_REBUILDS = 3;

type VideoFrameCallback = (now: DOMHighResTimeStamp, metadata: object) => void;

type SourceVideoElement = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

/** Anything the transformer needs from us, minus the parts we do not call. */
type VideoTransformerLike = {
  init(options: {
    outputCanvas: OffscreenCanvas | HTMLCanvasElement;
    inputElement: HTMLVideoElement;
  }): Promise<void>;
  restart(options: {
    outputCanvas: OffscreenCanvas | HTMLCanvasElement;
    inputElement: HTMLVideoElement;
  }): Promise<void>;
  destroy(): Promise<void>;
  transform(frame: VideoFrame, controller: { enqueue(frame: VideoFrame): void }): Promise<void>;
};

/** Chromium-only APIs the upstream modern path needs. */
function hasInsertableStreams(): boolean {
  return (
    typeof (globalThis as Record<string, unknown>).MediaStreamTrackProcessor !== 'undefined' &&
    typeof (globalThis as Record<string, unknown>).MediaStreamTrackGenerator !== 'undefined'
  );
}

/**
 * Upstream's `supportsBackgroundProcessors()` also demands insertable streams
 * *or* canvas capture; we always have our own canvas path, so the transformer's
 * own requirements (WebGL2, WebCodecs, OffscreenCanvas) are the real gate.
 */
export function backgroundEffectsSupported(): boolean {
  return (
    BackgroundTransformer.isSupported &&
    typeof HTMLCanvasElement !== 'undefined' &&
    'captureStream' in HTMLCanvasElement.prototype
  );
}

function createOutputCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * The source track reports 0x0 for a beat after getUserMedia on some platforms.
 * LiveKit calls `init` *before* it attaches the stream to the element, so the
 * track is the only size we can ask.
 */
async function trackResolution(
  track: MediaStreamTrack,
): Promise<{ width: number; height: number }> {
  const deadline = performance.now() + 1_000;
  for (;;) {
    const { width, height } = track.getSettings();
    if (width && height) return { width, height };
    if (performance.now() > deadline) return { width: 640, height: 480 };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Safari throttles and pauses media elements that are detached, `display:none`
 * or fully transparent. Keep the source element in the document, painted, and
 * effectively invisible.
 */
function mountSourceElement(element: HTMLVideoElement): HTMLDivElement {
  const host = document.createElement('div');
  host.dataset.meetProcessorSource = 'true';
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText =
    'position:fixed;top:0;left:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1';
  element.muted = true;
  element.defaultMuted = true;
  element.playsInline = true;
  element.autoplay = true;
  element.setAttribute('playsinline', '');
  element.setAttribute('muted', '');
  host.appendChild(element);
  document.body.appendChild(host);
  return host;
}

/**
 * The canvas render path, rewritten so a paused source can never end the loop.
 */
export class CanvasBackgroundProcessor implements TrackProcessor<Track.Kind.Video> {
  readonly name: string;

  processedTrack?: MediaStreamTrack;

  private readonly transformer: VideoTransformerLike;

  private element?: SourceVideoElement;

  private host?: HTMLDivElement;

  private displayCanvas?: HTMLCanvasElement;

  private renderContext?: CanvasRenderingContext2D | null;

  private outputCanvas?: OffscreenCanvas | HTMLCanvasElement;

  private captured?: MediaStream;

  private running = false;

  private frameHandle?: number;

  private frameHandleKind: 'rvfc' | 'raf' = 'raf';

  private supervisorTimer?: number;

  private transformInFlight = false;

  private resumeInFlight = false;

  private rebuildInFlight = false;

  private lastSourceTime = -1;

  private lastPaintedAt = 0;

  private stallTicks = 0;

  private health: ProcessorHealth = {
    path: 'canvas',
    framesProduced: 0,
    resumeAttempts: 0,
    stalls: 0,
    rebuilds: 0,
  };

  constructor(transformer: VideoTransformerLike, name: string) {
    this.transformer = transformer;
    this.name = name;
  }

  getHealth(): ProcessorHealth {
    return {
      ...this.health,
      sourcePaused: this.element?.paused ?? true,
      msSinceFrame: this.lastPaintedAt ? Math.round(performance.now() - this.lastPaintedAt) : undefined,
    };
  }

  async init(options: ProcessorOptions<Track.Kind.Video>): Promise<void> {
    const element = options.element;
    if (!(element instanceof HTMLVideoElement)) {
      throw new TypeError(t('Background effects need a video element to read from.'));
    }

    this.element = element as SourceVideoElement;
    this.host = mountSourceElement(element);
    element.addEventListener('pause', this.handleSourcePause);
    element.addEventListener('ended', this.handleSourcePause);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);

    try {
      const { width, height } = await trackResolution(options.track);
      element.width = width;
      element.height = height;

      this.displayCanvas = document.createElement('canvas');
      this.displayCanvas.width = width;
      this.displayCanvas.height = height;
      this.renderContext = this.displayCanvas.getContext('2d', { alpha: false });
      if (!this.renderContext) throw new Error(t('Couldn’t open a 2D canvas for background effects.'));

      // An explicit frame rate keeps the captured track ticking even if a paint
      // is skipped; the zero-argument form only emits on canvas mutation.
      this.captured = this.displayCanvas.captureStream(CAPTURE_FPS);
      this.processedTrack = this.captured.getVideoTracks()[0];

      this.outputCanvas = createOutputCanvas(width, height);
      (this.outputCanvas as EventTarget).addEventListener(
        'webglcontextlost',
        this.handleContextLost as EventListener,
      );

      await this.transformer.init({ outputCanvas: this.outputCanvas, inputElement: element });
    } catch (error) {
      // LiveKit never learns about a processor whose init rejected, so it will
      // never call destroy() — clean up the mounted element ourselves rather
      // than leaking one per failed attempt.
      await this.destroy().catch(() => undefined);
      throw error;
    }

    this.running = true;
    this.lastPaintedAt = performance.now();
    this.health.lastError = undefined;
    this.health.unrecoverable = false;
    this.schedule();
    this.supervisorTimer = window.setInterval(this.supervise, SUPERVISOR_INTERVAL_MS);
  }

  async restart(options: ProcessorOptions<Track.Kind.Video>): Promise<void> {
    await this.destroy();
    await this.init(options);
  }

  async destroy(): Promise<void> {
    this.running = false;
    this.cancelScheduled();
    if (this.supervisorTimer !== undefined) {
      window.clearInterval(this.supervisorTimer);
      this.supervisorTimer = undefined;
    }
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.element?.removeEventListener('pause', this.handleSourcePause);
    this.element?.removeEventListener('ended', this.handleSourcePause);
    (this.outputCanvas as EventTarget | undefined)?.removeEventListener(
      'webglcontextlost',
      this.handleContextLost as EventListener,
    );

    for (const track of this.captured?.getTracks() ?? []) track.stop();
    this.captured = undefined;
    this.processedTrack = undefined;

    // Hand the element back to LiveKit unattached — it owns that element and
    // may reuse it when the next processor is set.
    if (this.element && this.element.parentNode === this.host) this.host?.removeChild(this.element);
    this.host?.remove();
    this.host = undefined;
    this.displayCanvas = undefined;
    this.renderContext = undefined;
    this.outputCanvas = undefined;

    await this.transformer.destroy();
  }

  // --- render loop ---------------------------------------------------------

  /**
   * The whole point: rescheduling happens before any work that could throw or
   * bail, so no code path can leave the loop unscheduled.
   */
  private step = (): void => {
    this.frameHandle = undefined;
    if (!this.running) return;
    this.schedule();
    void this.paint();
  };

  private schedule(): void {
    if (!this.running || this.frameHandle !== undefined) return;
    const element = this.element;
    // requestVideoFrameCallback fires exactly once per presented frame — no
    // polling, no duplicate work. It stops while the element is paused, which
    // is what the supervisor is for.
    if (element?.requestVideoFrameCallback && element.srcObject) {
      this.frameHandleKind = 'rvfc';
      this.frameHandle = element.requestVideoFrameCallback(this.step);
      return;
    }
    this.frameHandleKind = 'raf';
    this.frameHandle = requestAnimationFrame(this.step);
  }

  private cancelScheduled(): void {
    if (this.frameHandle === undefined) return;
    if (this.frameHandleKind === 'rvfc') this.element?.cancelVideoFrameCallback?.(this.frameHandle);
    else cancelAnimationFrame(this.frameHandle);
    this.frameHandle = undefined;
  }

  private async paint(): Promise<void> {
    const element = this.element;
    if (!element || !this.running || this.transformInFlight) return;
    if (element.paused) {
      this.resumeSource();
      return;
    }
    if (element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    // Only the rAF path needs throttling — it fires on display refresh (often
    // 60–120Hz) regardless of the camera. requestVideoFrameCallback already
    // fires once per presented frame, and throttling it against a 30fps budget
    // would drop every other frame to jitter.
    const now = performance.now();
    if (this.frameHandleKind === 'raf' && now - this.lastPaintedAt < 1_000 / MAX_FPS) return;
    // currentTime only advances when the source produced a new frame.
    if (element.currentTime === this.lastSourceTime) return;
    this.lastSourceTime = element.currentTime;

    this.transformInFlight = true;
    try {
      // The transformer closes this frame itself (its own `finally`).
      await this.transformer.transform(new VideoFrame(element), this.controller);
    } catch (error) {
      this.noteError(error);
    } finally {
      this.transformInFlight = false;
    }
  }

  private readonly controller = {
    enqueue: (frame: VideoFrame): void => {
      try {
        const canvas = this.displayCanvas;
        const context = this.renderContext;
        if (!canvas || !context) return;
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        context.drawImage(frame, 0, 0, canvas.width, canvas.height);
        this.lastPaintedAt = performance.now();
        this.health.framesProduced = (this.health.framesProduced ?? 0) + 1;
        this.stallTicks = 0;
      } catch (error) {
        this.noteError(error);
      } finally {
        // Safe even when the transformer passes the input frame straight
        // through and closes it again — close() is idempotent.
        frame.close();
      }
    },
  };

  // --- supervision ---------------------------------------------------------

  private supervise = (): void => {
    if (!this.running) return;
    const element = this.element;
    if (!element) return;

    if (element.paused) this.resumeSource();
    // rVFC never fires for a paused element, so the loop can be sitting idle
    // with no pending callback. Re-arm unconditionally.
    if (this.frameHandle === undefined) this.schedule();

    // A hidden page stops painting by design — rAF and rVFC are both frozen —
    // so this is not a stall. Pump one frame per tick anyway so a backgrounded
    // tab publishes a slow trickle instead of freezing for everyone else.
    if (document.visibilityState !== 'visible') {
      void this.paint();
      return;
    }

    if (performance.now() - this.lastPaintedAt < STALL_MS) {
      this.stallTicks = 0;
      return;
    }

    this.stallTicks += 1;
    this.health.stalls = (this.health.stalls ?? 0) + 1;
    this.resumeSource();
    this.cancelScheduled();
    this.schedule();

    if (this.stallTicks >= STALL_TICKS_BEFORE_REBUILD) void this.rebuildTransformer();
  };

  private handleSourcePause = (): void => {
    this.resumeSource();
  };

  private handleVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible' || !this.running) return;
    // Coming back from a hidden tab: the last paint is arbitrarily old, so
    // reset the stall clock instead of tripping recovery on the next tick.
    this.lastPaintedAt = performance.now();
    this.resumeSource();
    this.cancelScheduled();
    this.schedule();
  };

  private handleContextLost = (event: Event): void => {
    // Preventing the default lets the context be restored at all.
    event.preventDefault();
    this.noteError(new Error(t('WebGL context lost')));
    void this.rebuildTransformer();
  };

  private resumeSource(): void {
    const element = this.element;
    if (!element || this.resumeInFlight || !element.srcObject) return;
    if (!element.paused) return;
    this.resumeInFlight = true;
    this.health.resumeAttempts = (this.health.resumeAttempts ?? 0) + 1;
    void element
      .play()
      .catch((error: unknown) => this.noteError(error))
      .finally(() => {
        this.resumeInFlight = false;
      });
  }

  private async rebuildTransformer(): Promise<void> {
    if (this.rebuildInFlight || !this.running) return;
    const element = this.element;
    const outputCanvas = this.outputCanvas;
    if (!element || !outputCanvas) return;

    if ((this.health.rebuilds ?? 0) >= MAX_TRANSFORMER_REBUILDS) {
      // Out of local moves. Rebuilding the transformer only recreates the GL
      // pipeline, not the MediaPipe segmenter — the watchdog's full processor
      // restart does that, and failing that it drops the effect rather than
      // leaving a black tile up.
      this.health.unrecoverable = true;
      return;
    }

    this.rebuildInFlight = true;
    this.health.rebuilds = (this.health.rebuilds ?? 0) + 1;
    try {
      await this.transformer.restart({ outputCanvas, inputElement: element });
      this.lastSourceTime = -1;
      this.lastPaintedAt = performance.now();
      this.stallTicks = 0;
    } catch (error) {
      this.noteError(error);
    } finally {
      this.rebuildInFlight = false;
    }
  }

  private noteError(error: unknown): void {
    this.health.lastError =
      error instanceof Error ? error.message : String(error ?? 'unknown error');
  }
}

// --- factory -----------------------------------------------------------------

export type BackgroundProcessorSpec = {
  blurRadius?: number;
  imagePath?: string;
  assetPaths?: { tasksVisionFileSet?: string; modelAssetPath?: string };
};

type ActiveProcessor = TrackProcessor<Track.Kind.Video> & { getHealth?: () => ProcessorHealth };

let active: ActiveProcessor | undefined;

function publishHealth(): void {
  setProcessorHealthSource(() => {
    if (!active) return undefined;
    return active.getHealth?.() ?? { path: 'insertable-streams' };
  });
}

/**
 * Resolves once the active processor has painted, rejects if it never does.
 *
 * Applying an effect that produces no frames is the worst outcome available:
 * the call looks fine to the person who turned it on and their tile is black
 * for everyone else. Failing loudly here means the caller reverts to the plain
 * camera before anyone joins on a dead track.
 *
 * No-ops on the insertable-streams path, which we do not instrument.
 */
export async function waitForFirstFrame(timeoutMs = 4_000): Promise<void> {
  const current = active;
  if (!current?.getHealth) return;
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    // A newer processor replaced this one — its own apply owns the check.
    if (active !== current) return;
    const health = current.getHealth();
    if ((health.framesProduced ?? 0) > 0) return;
    if (performance.now() > deadline) {
      throw new Error(
        health.lastError?.trim()
          ? t('Background effect never produced video ({lastError}).', { lastError: health.lastError })
          : t('Background effect never produced video.'),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function forgetActiveProcessor(processor?: unknown): void {
  if (!processor || active === processor) {
    active = undefined;
    setProcessorHealthSource(undefined);
  }
}

/**
 * Chromium keeps the upstream stream-based processor; everyone else gets the
 * supervised canvas path above.
 */
export function createBackgroundProcessor(
  spec: BackgroundProcessorSpec,
  name: string,
): TrackProcessor<Track.Kind.Video> {
  if (!BackgroundTransformer.isSupported) {
    throw new Error(t('Background effects are not supported by this browser.'));
  }

  const transformer = new BackgroundTransformer({
    blurRadius: spec.blurRadius,
    imagePath: spec.imagePath,
    assetPaths: spec.assetPaths,
  });

  const processor: ActiveProcessor = hasInsertableStreams()
    ? (new ProcessorWrapper(transformer, name) as unknown as ActiveProcessor)
    : new CanvasBackgroundProcessor(transformer as unknown as VideoTransformerLike, name);

  active = processor;
  publishHealth();
  return processor;
}
