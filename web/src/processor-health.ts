/**
 * Health of the background processor attached to the camera.
 *
 * Deliberately its own module with no heavy imports: the watchdog and the
 * debug report read this on every session, while the processor itself (and
 * MediaPipe behind it) stays behind a dynamic import that only loads when
 * someone actually turns an effect on.
 */

export type ProcessorPath = 'insertable-streams' | 'canvas';

export type ProcessorHealth = {
  path: ProcessorPath;
  /** Painted frames. `undefined` on the modern path, which we do not instrument. */
  framesProduced?: number;
  /** ms since the last painted frame, or `undefined` when not instrumented. */
  msSinceFrame?: number;
  sourcePaused?: boolean;
  resumeAttempts?: number;
  stalls?: number;
  rebuilds?: number;
  /** Set once the processor's own recovery is exhausted — drop the effect. */
  unrecoverable?: boolean;
  lastError?: string;
};

let source: (() => ProcessorHealth | undefined) | undefined;

/** @internal — called by the processor module when a processor is created. */
export function setProcessorHealthSource(next: (() => ProcessorHealth | undefined) | undefined): void {
  source = next;
}

export function activeProcessorHealth(): ProcessorHealth | undefined {
  return source?.();
}
