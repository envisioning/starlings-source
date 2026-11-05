import {
  backgroundCells,
  BACKGROUND_GENERATORS,
  type BackgroundChoice,
  type BackgroundTonePair,
} from '@starlings/contracts/background-gallery';
import { t } from './i18n';
import { workspaceTonePair } from './workspace-backgrounds';

/**
 * The background gallery on the web: the generator's cells from
 * the shared rule, drawn on a canvas. Every client draws the same pixels for
 * the same seed.
 */

export function freshBackgroundSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

/** The colours an entry draws in: Envisioning's pinned tones until a workspace sets its own. */
export function backgroundTonePair(choice: BackgroundChoice): BackgroundTonePair {
  return workspaceTonePair(choice.tone);
}

/** What a person calls an entry: its tone's name. */
export function backgroundChoiceLabel(choice: BackgroundChoice): string {
  return `${t(BACKGROUND_GENERATORS.find(g => g.id === choice.generator)!.label)} · ${t(backgroundTonePair(choice).label)}`;
}

/** The entry as a PNG data URL, or '' when the browser has no 2D canvas. */
export function renderGalleryBackground(options: {
  width: number;
  height: number;
  choice: BackgroundChoice;
  seed: number;
  tones?: Record<BackgroundChoice['tone'], Pick<BackgroundTonePair, 'base' | 'modules'>>;
}): string {
  const { width, height, choice, seed } = options;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return '';
  const pair = options.tones?.[choice.tone] ?? backgroundTonePair(choice);
  context.imageSmoothingEnabled = false;
  context.fillStyle = pair.base;
  context.fillRect(0, 0, width, height);
  context.fillStyle = pair.modules;
  for (const cell of backgroundCells(choice.generator, width, height, seed)) {
    context.globalAlpha = cell.alpha;
    if (choice.generator === 'flock') {
      context.beginPath();
      context.ellipse(cell.x + cell.width / 2, cell.y + cell.height / 2, cell.width / 2, cell.height / 2, 0, 0, Math.PI * 2);
      context.fill();
    } else {
      context.fillRect(cell.x, cell.y, cell.width, cell.height);
    }
  }
  context.globalAlpha = 1;
  return canvas.toDataURL('image/png');
}
