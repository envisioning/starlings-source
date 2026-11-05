/**
 * The background gallery's tables. A camera background is a
 * generator drawn in a tone. The web, the Mac and the iPhone read these
 * tables, the Swift side through the generated
 * `Sources/Generated/BackgroundGalleryRegistry.swift`. The drawing rule is
 * in `background-gallery.ts`.
 */

/** The three tones, in picker order. */
export const BACKGROUND_TONES = ['dark', 'accent', 'bright'] as const;
export type BackgroundTone = (typeof BACKGROUND_TONES)[number];

/** A tone's word, the name a derived tone pair carries. */
export const BACKGROUND_TONE_LABELS: Record<BackgroundTone, { label: string }> = {
  dark: { label: 'Dark' },
  accent: { label: 'Accent' },
  bright: { label: 'Bright' },
};

/** A plate (`base`) and the colour its generator draws on it (`modules`). */
export interface BackgroundTonePair {
  label: string;
  base: string;
  modules: string;
}

/**
 * Envisioning's pinned tones: the Night, Lime and Ice of the the organisation's site
 * brand post generator (`www` app/about/brand/_lib/themes.ts). Every client
 * draws these until a workspace sets its own.
 */
export const ENVISIONING_BACKGROUND_TONES: Record<BackgroundTone, BackgroundTonePair> = {
  dark: { label: 'Night', base: '#25262e', modules: '#656877' },
  accent: { label: 'Lime', base: '#d6f249', modules: '#abc900' },
  bright: { label: 'Ice', base: '#f2f5f9', modules: '#c8d1de' },
};

/** The plate names Meet stored before the gallery. A saved `night` reads as `dark`. */
export const LEGACY_PLATE_TONES: Record<string, BackgroundTone> = {
  night: 'dark',
  lime: 'accent',
  ice: 'bright',
};

/** The generators, in picker order. Each one is a pure function of seed, size and tone. */
export const BACKGROUND_GENERATORS = [
  { id: 'pixel-field', label: 'Pixels' },
  { id: 'flock', label: 'Flock' },
  { id: 'grid', label: 'Grid' },
] as const;
export type BackgroundGeneratorId = (typeof BACKGROUND_GENERATORS)[number]['id'];

/**
 * `pixel-field`: square modules on a grid, denser and stronger toward the
 * bottom edge. Ported from the the organisation's site post generator's
 * `drawPostPixelField`, with the fade measured up from the bottom.
 */
export const PIXEL_FIELD = {
  /** The bottom margin, as a share of the width. */
  marginRatio: 0.08,
  /** The grid's anchor square, as a share of the short edge. */
  originRatio: 0.22,
  /** Cells across the anchor square. */
  grid: 33,
  /** A cell is drawn when the next random number is at most `keepBase + fade × keepFade`. */
  keepBase: 0.06,
  keepFade: 0.52,
  /** A drawn cell's opacity is `alphaBase + fade × alphaFade`. */
  alphaBase: 0.14,
  alphaFade: 0.52,
} as const;

/** Repeated resting Starlings marks, with seeded strength per mark. */
export const FLOCK_FIELD = { pitch: 112, size: 72, alphaBase: 0.25, alphaFade: 0.35 } as const;

/** Home's centre-anchored 32px lattice, baked variation and edge fades. */
export const GRID_FIELD = { pitch: 32, multiplierMin: 0.7, multiplierMax: 1, bakedLines: 80, alpha: 0.5, horizontalFade: 0.12, verticalFade: 0.18 } as const;
