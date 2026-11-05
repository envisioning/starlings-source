/**
 * The background gallery: every camera background is a generator
 * drawn in a tone. This file is the drawing rule every client follows, so a
 * seed draws the same pixels on the web, the Mac and the iPhone. The tables
 * are in `background-gallery-values.ts`; `fixtures/background-gallery.json`
 * pins the rule for the Swift port.
 *
 * Dependency-free: the browser bundle and the Worker both import it.
 */

import {
  BACKGROUND_GENERATORS,
  BACKGROUND_TONE_LABELS,
  BACKGROUND_TONES,
  ENVISIONING_BACKGROUND_TONES,
  LEGACY_PLATE_TONES,
  PIXEL_FIELD,
  FLOCK_FIELD,
  GRID_FIELD,
  type BackgroundGeneratorId,
  type BackgroundTone,
  type BackgroundTonePair,
} from './background-gallery-values';
import { GATHERING_DOTS, GATHERING_VIEWBOX } from './gathering-dots';
import { WORKSPACE_ACCENT_PATTERN, contrast, mix } from './workspace-accent';

export * from './background-gallery-values';

/** One entry in the gallery. */
export interface BackgroundChoice {
  generator: BackgroundGeneratorId;
  tone: BackgroundTone;
}

/** Every entry, generator by generator, each in tone order. */
export const BACKGROUND_GALLERY: readonly BackgroundChoice[] = BACKGROUND_GENERATORS.flatMap((generator) =>
  BACKGROUND_TONES.map((tone) => ({ generator: generator.id, tone })));

const isGenerator = (value: unknown): value is BackgroundGeneratorId =>
  BACKGROUND_GENERATORS.some((generator) => generator.id === value);
const isTone = (value: unknown): value is BackgroundTone =>
  (BACKGROUND_TONES as readonly unknown[]).includes(value);

/** A stored choice, or null when it names no entry. */
export function parseBackgroundChoice(generator: unknown, tone: unknown): BackgroundChoice | null {
  return isGenerator(generator) && isTone(tone) ? { generator, tone } : null;
}

/** The pixel-field entry for a plate name Meet stored before the gallery (`night`, `lime`, `ice`). */
export function legacyPlateChoice(plate: unknown): BackgroundChoice | null {
  const tone = typeof plate === 'string' ? LEGACY_PLATE_TONES[plate] : undefined;
  return tone ? { generator: 'pixel-field', tone } : null;
}

export function sameBackgroundChoice(a: BackgroundChoice | null, b: BackgroundChoice | null): boolean {
  return !!a && !!b && a.generator === b.generator && a.tone === b.tone;
}

/** The entry after `current`, the first one when nothing is chosen, and null after the last. */
export function nextBackgroundChoice(current: BackgroundChoice | null): BackgroundChoice | null {
  if (!current) return BACKGROUND_GALLERY[0] ?? null;
  const index = BACKGROUND_GALLERY.findIndex((entry) => sameBackgroundChoice(entry, current));
  return index < 0 ? (BACKGROUND_GALLERY[0] ?? null) : (BACKGROUND_GALLERY[index + 1] ?? null);
}

// MARK: Drawing

/**
 * Mulberry32. Both ports step it the same way, so a seed gives every client
 * the same numbers: `fixtures/background-gallery.json` pins the first few.
 */
export function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

/** One drawn module, in pixels from the top left, with its opacity. */
export interface PixelCell {
  x: number;
  y: number;
  width: number;
  height: number;
  alpha: number;
}

/**
 * Every module the pixel field draws on a `width` × `height` plate. Rounding
 * is `Math.round` (half up); the Swift port rounds the same way, not half
 * away from zero, or the cells left of the anchor would differ.
 */
export function pixelFieldCells(width: number, height: number, seed: number): PixelCell[] {
  const field = PIXEL_FIELD;
  const margin = Math.round(width * field.marginRatio);
  const size = Math.round(Math.min(width, height) * field.originRatio);
  if (size < 1) return [];
  // Bottom-centre, so the field grades up from the bottom, not in from a side.
  const originX = Math.round((width - size) / 2);
  const originY = height - margin - size;
  const cell = size / field.grid;
  const random = seededRandom(seed);
  const bottomY = height - margin;
  const maxDistance = Math.max(1, bottomY);

  const edgeX = (index: number) => Math.round(originX + index * cell);
  const edgeY = (index: number) => Math.round(originY + index * cell);
  const firstColumn = Math.floor(-originX / cell);
  const lastColumn = Math.ceil((width - originX) / cell);
  const firstRow = Math.floor(-originY / cell);
  const lastRow = Math.ceil((height - originY) / cell);

  const cells: PixelCell[] = [];
  for (let row = firstRow; row < lastRow; row += 1) {
    const y = Math.max(0, edgeY(row));
    const cellHeight = Math.min(height, edgeY(row + 1)) - y;
    if (cellHeight <= 0) continue;
    for (let column = firstColumn; column < lastColumn; column += 1) {
      const x = Math.max(0, edgeX(column));
      const cellWidth = Math.min(width, edgeX(column + 1)) - x;
      if (cellWidth <= 0) continue;
      const distance = Math.max(0, bottomY - (y + cellHeight / 2));
      const fade = Math.max(0, 1 - distance / maxDistance);
      if (random() > field.keepBase + fade * field.keepFade) continue;
      cells.push({ x, y, width: cellWidth, height: cellHeight, alpha: field.alphaBase + fade * field.alphaFade });
    }
  }
  return cells;
}

/**
 * FNV-1a over each cell's x, y, width, height and opacity in ten-thousandths,
 * four bytes each, low byte first. The fixture pins it so a port can be held
 * to thousands of cells without listing them.
 */
export function pixelCellsDigest(cells: readonly PixelCell[]): number {
  let hash = 0x811c9dc5;
  for (const cell of cells) {
    for (const value of [cell.x, cell.y, cell.width, cell.height, Math.round(cell.alpha * 10000)]) {
      for (let shift = 0; shift < 32; shift += 8) {
        hash ^= (value >>> shift) & 0xff;
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
    }
  }
  return hash >>> 0;
}

// MARK: Tones

/** A pair is usable when its modules can be told from its plate. */
export const TONE_PAIR_MIN_CONTRAST = 1.2;

export function tonePairVisible(pair: Pick<BackgroundTonePair, 'base' | 'modules'>): boolean {
  return WORKSPACE_ACCENT_PATTERN.test(pair.base)
    && WORKSPACE_ACCENT_PATTERN.test(pair.modules)
    && contrast(pair.base, pair.modules) >= TONE_PAIR_MIN_CONTRAST;
}

/**
 * The modules colour for a plate, as the the organisation's site generator derives a
 * custom background's `secondary`: a light plate (BT.601 luma ≥ 150) darkens
 * to 78 %, a dark one moves 28 % toward white.
 */
export function modulesFor(base: string): string {
  const value = Number.parseInt(base.slice(1), 16);
  const rgb = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  const light = 0.299 * rgb[0]! + 0.587 * rgb[1]! + 0.114 * rgb[2]! >= 150;
  const channels = rgb.map((channel) => light
    ? Math.max(0, Math.round(channel * 0.78))
    : Math.min(255, Math.round(channel + (255 - channel) * 0.28)));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** How much of the accent the neutral plates take on. */
const NEUTRAL_TINT = 0.08;

/**
 * The three tones derived from one workspace accent: the accent itself, and
 * a dark and a bright neutral that carry a trace of its hue. Null for a value
 * that is not `#rrggbb`. Each pair is named by its tone's word.
 */
export function backgroundTonesFromAccent(accent: string | null | undefined): Record<BackgroundTone, BackgroundTonePair> | null {
  if (!accent || !WORKSPACE_ACCENT_PATTERN.test(accent)) return null;
  const color = accent.toLowerCase();
  const bases: Record<BackgroundTone, string> = {
    dark: mix(ENVISIONING_BACKGROUND_TONES.dark.base, color, NEUTRAL_TINT),
    accent: color,
    bright: mix(ENVISIONING_BACKGROUND_TONES.bright.base, color, NEUTRAL_TINT),
  };
  const tones = Object.fromEntries(BACKGROUND_TONES.map((tone) => [tone, {
    label: BACKGROUND_TONE_LABELS[tone].label,
    base: bases[tone],
    modules: modulesFor(bases[tone]),
  }])) as Record<BackgroundTone, BackgroundTonePair>;
  return BACKGROUND_TONES.every((tone) => tonePairVisible(tones[tone])) ? tones : null;
}

/** Bounding boxes are integer pixels; flock cells draw as ellipses. */
export function backgroundCells(generator: BackgroundGeneratorId, width: number, height: number, seed: number): PixelCell[] {
  if (width <= 0 || height <= 0) return [];
  if (generator === 'pixel-field') return pixelFieldCells(width, height, seed);
  const cells: PixelCell[] = [];
  if (generator === 'flock') {
    const f = FLOCK_FIELD;
    const random = seededRandom(seed);
    const scale = f.size / GATHERING_VIEWBOX;
    for (let row = -Math.ceil(height / 2 / f.pitch); row <= Math.ceil(height / 2 / f.pitch); row++) {
      for (let col = -Math.ceil(width / 2 / f.pitch); col <= Math.ceil(width / 2 / f.pitch); col++) {
        const alpha = f.alphaBase + random() * f.alphaFade;
        for (const dot of GATHERING_DOTS) {
          const x = Math.round(width / 2 + col * f.pitch - f.size / 2 + (dot.x - dot.radius) * scale);
          const y = Math.round(height / 2 + row * f.pitch - f.size / 2 + (dot.y - dot.radius) * scale);
          const diameter = Math.round(dot.radius * 2 * scale);
          if (x + diameter <= 0 || y + diameter <= 0 || x >= width || y >= height) continue;
          cells.push({ x, y, width: diameter, height: diameter, alpha });
        }
      }
    }
    return cells;
  }
  const f = GRID_FIELD;
  let state = seed >>> 0;
  const bake = () => Array.from({ length: f.bakedLines }, () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return f.multiplierMin + (state >>> 16) / 65536 * (f.multiplierMax - f.multiplierMin);
  });
  const columns = bake();
  const rows = bake();
  const fade = (p: number, span: number, fraction: number) => Math.min(1, Math.max(0, Math.min(p, span - p) / (span * fraction)));
  // Pixel segments bake both axis fades, avoiding renderer-specific masks.
  for (const vertical of [true, false]) {
    const span = vertical ? width : height;
    const length = vertical ? height : width;
    const multipliers = vertical ? columns : rows;
    const reach = Math.ceil(span / 2 / f.pitch) + 1;
    for (let index = -reach; index <= reach; index++) {
      const position = Math.round(span / 2 + index * f.pitch);
      if (position < 0 || position >= span) continue;
      const strength = f.alpha * (multipliers[index + f.bakedLines / 2] ?? 1);
      for (let offset = 0; offset < length; offset++) {
        const x = vertical ? position : offset;
        const y = vertical ? offset : position;
        cells.push({ x, y, width: 1, height: 1, alpha: strength * fade(x + 0.5, width, f.horizontalFade) * fade(y + 0.5, height, f.verticalFade) });
      }
    }
  }
  return cells;
}
