import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_GALLERY,
  backgroundCells,
  type BackgroundGeneratorId,
  ENVISIONING_BACKGROUND_TONES,
  backgroundTonesFromAccent,
  nextBackgroundChoice,
  pixelCellsDigest,
  pixelFieldCells,
  seededRandom,
  tonePairVisible,
} from '@starlings/contracts/background-gallery';
import fixture from '../../fixtures/background-gallery.json';
import { parseBackgroundEffect } from './meet-media-preferences';

// meet#862: one drawing rule for every client. The Mac and iPhone run the
// same fixture (Tests/BackgroundGalleryFixtureTests.swift).
describe('background gallery', () => {
  it('steps the PRNG the fixture pins', () => {
    for (const row of fixture.random) {
      const next = seededRandom(row.seed);
      expect(row.values.map(() => next())).toEqual(row.values);
    }
  });

  it('draws the cells the fixture pins', () => {
    for (const row of fixture.cells) {
      const cells = pixelFieldCells(row.width, row.height, row.seed);
      expect(cells.length, `${row.seed} ${row.width}x${row.height}`).toBe(row.count);
      expect(pixelCellsDigest(cells)).toBe(row.digest);
      expect(cells.slice(0, 3)).toEqual(row.first);
    }
  });

  it('pins flock and grid across seeds and landscape / portrait sizes', () => {
    for (const row of fixture.generatedCells) {
      const cells = backgroundCells(row.generator as BackgroundGeneratorId, row.width, row.height, row.seed);
      expect(cells.length).toBe(row.count);
      expect(pixelCellsDigest(cells)).toBe(row.digest);
      expect(cells.slice(0, 3)).toEqual(row.first);
    }
    expect(BACKGROUND_GALLERY).toHaveLength(9);
  });

  it('pins Envisioning\'s Night, Lime and Ice, each visible', () => {
    expect(Object.values(ENVISIONING_BACKGROUND_TONES).map((pair) => pair.label)).toEqual(['Night', 'Lime', 'Ice']);
    for (const pair of Object.values(ENVISIONING_BACKGROUND_TONES)) expect(tonePairVisible(pair)).toBe(true);
  });

  it('derives three visible tones from an accent, and refuses a value that is not one', () => {
    for (const accent of ['#2563eb', '#ffffff', '#000000', '#808080', '#D6F249']) {
      const tones = backgroundTonesFromAccent(accent);
      expect(tones, accent).not.toBeNull();
      expect(tones!.accent.base).toBe(accent.toLowerCase());
      expect(Object.values(tones!).map((pair) => pair.label)).toEqual(['Dark', 'Accent', 'Bright']);
    }
    expect(backgroundTonesFromAccent('blue')).toBeNull();
    expect(backgroundTonesFromAccent(null)).toBeNull();
  });

  it('steps through every entry, then off', () => {
    const seen = [];
    for (let entry = nextBackgroundChoice(null); entry; entry = nextBackgroundChoice(entry)) seen.push(entry);
    expect(seen).toEqual(BACKGROUND_GALLERY);
  });

  it('preserves each generator and tone in saved preferences', () => {
    for (const entry of BACKGROUND_GALLERY) {
      expect(parseBackgroundEffect({ mode: 'generated', ...entry })).toEqual({ mode: 'generated', ...entry });
    }
    for (const generator of ['flock', 'grid'] as const) {
      expect(backgroundCells(generator, 0, 90, 1)).toEqual([]);
      expect(backgroundCells(generator, 90, 0, 1)).toEqual([]);
    }
  });

  it('reads a plate saved before the gallery as the same plate', () => {
    expect(parseBackgroundEffect({ mode: 'block', blockThemeId: 'night' })).toEqual({ mode: 'generated', generator: 'pixel-field', tone: 'dark' });
    expect(parseBackgroundEffect({ mode: 'block', blockThemeId: 'lime' })).toEqual({ mode: 'generated', generator: 'pixel-field', tone: 'accent' });
    expect(parseBackgroundEffect({ mode: 'block', blockThemeId: 'ice' })).toEqual({ mode: 'generated', generator: 'pixel-field', tone: 'bright' });
    expect(parseBackgroundEffect({ mode: 'generated', generator: 'pixel-field', tone: 'bright' })).toEqual({ mode: 'generated', generator: 'pixel-field', tone: 'bright' });
    expect(parseBackgroundEffect({ mode: 'generated', generator: 'stars', tone: 'dark' })).toEqual({ mode: 'none' });
    expect(parseBackgroundEffect({ mode: 'blur', blockThemeId: null })).toEqual({ mode: 'blur' });
  });
});
