/**
 * The flock: the Starlings mark's 4 × 4 dots, how they move, and the
 * wordmark it sits in. The web (`web/src/GatheringDots.tsx`) and both Swift
 * apps (`Sources/StarlingsWordmark.swift`, through the generated
 * `Sources/Generated/GatheringDotsRegistry.swift`) draw from this one table.
 * Lengths are in the mark's 28-unit square; wordmark lengths are in ems of
 * the word's font size.
 */

/** The side of the square the dots sit in. */
export const GATHERING_VIEWBOX = 28;

/** Four resting radii; motion moves between them, never past them. */
export const GATHERING_RADII = [1.55, 1.87, 2.18, 2.5] as const;

/** Which radius each dot rests at, row by row, top left first. */
export const GATHERING_PATTERN = [
  [1, 2, 3, 3],
  [0, 2, 3, 2],
  [0, 1, 2, 1],
  [0, 0, 1, 0],
] as const;

const ORIGIN = 4.4;
const STEP = 6.4;

export interface GatheringDot {
  x: number;
  y: number;
  /** The resting radius. */
  radius: number;
  /** Where in the sweep this dot starts, 0 to 1, so neighbours move as one wave (murmuration, thinking). */
  phase: number;
  /** Where in its own breath this dot starts, 0 to 1 (drift). */
  driftPhase: number;
  /** This dot's breath length, as a share of `driftSeconds` (drift). */
  driftFactor: number;
}

/** A fixed scatter in [0, 1) for dot `i`: the same on every client, and no two dots alike. */
const scatter = (i: number, salt: number) => {
  const v = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

export const GATHERING_DOTS: readonly GatheringDot[] = GATHERING_PATTERN.flatMap((row, y) => row.map((level, x) => {
  const i = y * row.length + x;
  return {
    x: Number((ORIGIN + x * STEP).toFixed(2)),
    y: Number((ORIGIN + y * STEP).toFixed(2)),
    radius: GATHERING_RADII[level],
    phase: Number(((x * 0.13 + y * 0.17 + Math.sin(y * 1.2) * 0.08) % 1).toFixed(3)),
    driftPhase: Number(scatter(i, 1).toFixed(3)),
    // 0.7 to 1.3 of the base breath: the dots drift out of step and stay out of it.
    driftFactor: Number((0.7 + scatter(i, 2) * 0.6).toFixed(3)),
  };
}));

/**
 * The still Starlings glyph: one radius per dot, row by row, top left first,
 * in the same 28-unit square. The app icons, the favicons and
 * `web/public/starlings.svg` draw this shape, never the moving flock. It is
 * hand-tuned, not derived from the resting radii: the bulk sits at column 3,
 * row 2, and the flock thins out to the bottom left.
 */
export const STARLINGS_GLYPH_RADII = [
  [1.956, 2.494, 2.6, 2.05],
  [1.4, 2.494, 3.05, 2.494],
  [1.0, 1.7, 2.494, 1.956],
  [0.45, 1.0, 1.7, 1.4],
] as const;

/**
 * The share of an icon tile the glyph's 28-unit square spans, on the app
 * icons and the favicons alike: 840 of 1024. The outer dots sit inside that
 * square, so the dots themselves fill about 69% of the tile.
 */
export const STARLINGS_GLYPH_ICON_SPAN = 840 / 1024;

/**
 * How the flock moves. The flock is the only animated loader on every
 * client; each mode is one meaning (docs/DESIGN.md, "Waiting").
 *
 * - `still`: no motion, the resting radii.
 * - `drift` breathes each dot a little around its own radius, each on its
 *   own clock (`driftPhase`, `driftFactor`), so the dots never move in step
 *   and the shape holds: the wordmark's motion, and a mark with nothing to
 *   show (camera off, an empty list).
 * - `murmuration`, `thinking` and `busy` sweep every dot through all four
 *   radii as one wave, at three speeds: `murmuration` while connecting or
 *   waiting at the door, `thinking` while an agent works, `busy` for a short
 *   wait on a control (the web `Spinner`). `busy` is short enough that a
 *   16px flock in a button reads as busy.
 *
 * Reduced motion stops every mode at the resting radii.
 */
export const GATHERING_MOTION = {
  driftSeconds: 4.2,
  /** A drifting dot's radius, as a share of its resting radius, at each end of the breath; at 0 it vanishes. */
  driftLow: 0,
  driftHigh: 1.14,
  murmurationSeconds: 12,
  thinkingSeconds: 4.8,
  busySeconds: 1.4,
} as const;

/** The wordmark: `Starlings`, the flock after it. */
export const STARLINGS_WORDMARK = {
  word: 'Starlings',
  weight: 650,
  trackingEm: -0.046,
  gapEm: 0.25,
  /** The flock's side; 20% larger than the 0.73 em it first had. */
  flockEm: 0.88,
} as const;
