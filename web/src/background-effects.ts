import type { LocalVideoTrack } from 'livekit-client';
import { loadCustomBackground } from './custom-background';
import { nextBackgroundChoice, type BackgroundChoice } from '@starlings/contracts/background-gallery';
import { backgroundChoiceLabel, freshBackgroundSeed, renderGalleryBackground } from './background-gallery';
import { t } from './i18n';
import { workspaceBackgroundProfile } from './workspace-backgrounds';

/**
 * `generated` is an entry of the background gallery. `image` is
 * the picture this device holds — see `custom-background.ts`. The choice
 * names the mode only; the bytes live in IndexedDB, because a preferences
 * object that carried a megabyte of PNG would be written to `localStorage` on
 * every device change.
 */
export type BackgroundEffectChoice =
  | { mode: 'none' }
  | { mode: 'blur' }
  | ({ mode: 'generated' } & BackgroundChoice)
  | { mode: 'image' }
  | { mode: 'workspace-image' };

export type BackgroundEffectMode = BackgroundEffectChoice['mode'];

export const DEFAULT_BACKGROUND_EFFECT: BackgroundEffectChoice = { mode: 'none' };

/**
 * Same-origin MediaPipe assets (staged into public/ by vite). Both paths must
 * stay local: the library's defaults reach for jsdelivr and
 * storage.googleapis.com at runtime, which puts a third-party fetch — and a
 * CSP hole — on the path of turning blur on mid-call.
 */
const MEDIAPIPE_WASM_PATH = '/mediapipe/wasm';
const MEDIAPIPE_MODEL_PATH = '/mediapipe/selfie_segmenter.tflite';

export function backgroundEffectLabel(choice: BackgroundEffectChoice): {
  blur: string;
  block: string;
  image: string;
} {
  const blockLabel = choice.mode === 'generated' ? backgroundChoiceLabel(choice) : t('Block');
  return {
    blur: choice.mode === 'blur' ? 'Blur on' : 'Blur',
    block: blockLabel,
    image: choice.mode === 'image' ? 'Image on' : 'Image',
  };
}

/** One-line summary for a submenu row — what's on, or "Off". */
export function backgroundEffectSummary(choice: BackgroundEffectChoice): string {
  if (choice.mode === 'none') return 'Off';
  if (choice.mode === 'blur') return 'Blur';
  if (choice.mode === 'image') return 'Image';
  if (choice.mode === 'workspace-image') return t('Workspace picture');
  return backgroundEffectLabel(choice).block;
}

/** Toggle blur on/off (clears block). */
export function nextBlurChoice(current: BackgroundEffectChoice): BackgroundEffectChoice {
  if (current.mode === 'blur') return DEFAULT_BACKGROUND_EFFECT;
  return { mode: 'blur' };
}

/** Step through the gallery, then off (clears blur). */
export function nextBlockChoice(current: BackgroundEffectChoice): BackgroundEffectChoice {
  const next = nextBackgroundChoice(current.mode === 'generated' ? current : null);
  return next ? { mode: 'generated', generator: next.generator, tone: next.tone } : DEFAULT_BACKGROUND_EFFECT;
}

/**
 * A `blob:` URL for the stored picture, replacing the last one.
 *
 * The processor loads the image itself and holds it, so the URL has to outlive
 * the call that made it — revoking on the next line would hand the transformer
 * a dead address. Revoking the *previous* one instead means at most one URL is
 * ever alive, which is what keeps switching backgrounds twenty times in a
 * meeting from being twenty retained images.
 */
let liveBackgroundURL: string | null = null;

function customBackgroundURL(blob: Blob): string {
  if (liveBackgroundURL) URL.revokeObjectURL(liveBackgroundURL);
  liveBackgroundURL = URL.createObjectURL(blob);
  return liveBackgroundURL;
}

/** Toggle your own picture on/off (clears blur and block). */
export function nextImageChoice(current: BackgroundEffectChoice): BackgroundEffectChoice {
  if (current.mode === 'image') return DEFAULT_BACKGROUND_EFFECT;
  return { mode: 'image' };
}

export function backgroundEffectErrorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason;
  // MediaPipe script load failures under CSP reject with a bare Event.
  if (reason && typeof reason === 'object' && 'type' in reason && (reason as { type: string }).type === 'error') {
    return t('Background effects couldn’t load (blocked script or unsupported browser).');
  }
  return t('Background effect failed.');
}

export async function applyBackgroundEffect(
  track: LocalVideoTrack,
  choice: BackgroundEffectChoice,
): Promise<void> {
  // The processor module pulls in MediaPipe — keep it out of the main bundle.
  const {
    backgroundEffectsSupported,
    createBackgroundProcessor,
    forgetActiveProcessor,
    waitForFirstFrame,
  } = await import('./background-processor');

  if (choice.mode === 'none') {
    forgetActiveProcessor(track.getProcessor());
    await track.stopProcessor();
    return;
  }

  if (!backgroundEffectsSupported()) {
    throw new Error(t('Background effects are not supported by this browser.'));
  }

  const assetPaths = {
    tasksVisionFileSet: MEDIAPIPE_WASM_PATH,
    modelAssetPath: MEDIAPIPE_MODEL_PATH,
  };

  // Any throw past this point leaves a processor attached that is not painting,
  // so tear it back down to the plain camera before rethrowing — a raw feed is
  // always better than a black tile.
  const applyOrRevert = async (attach: () => Promise<void>) => {
    try {
      await attach();
      await waitForFirstFrame();
    } catch (reason) {
      await track.stopProcessor().catch(() => undefined);
      forgetActiveProcessor();
      throw reason;
    }
  };

  if (choice.mode === 'blur') {
    await applyOrRevert(() =>
      track.setProcessor(
        createBackgroundProcessor({ blurRadius: 12, assetPaths }, 'background-blur'),
        true,
      ),
    );
    return;
  }

  if (choice.mode === 'workspace-image') {
    const imagePath = workspaceBackgroundProfile().image_url;
    if (!imagePath) throw new Error(t('The workspace picture is no longer available.'));
    await applyOrRevert(() => track.setProcessor(createBackgroundProcessor({ imagePath, assetPaths }, 'virtual-background'), true));
    return;
  }

  if (choice.mode === 'image') {
    const stored = await loadCustomBackground();
    // Chosen and then cleared, or cleared on another tab: a mode with no
    // picture behind it is not an error to shout about, it is no effect.
    if (!stored) {
      await track.stopProcessor().catch(() => undefined);
      forgetActiveProcessor();
      throw new Error(t('Add a background image first.'));
    }
    await applyOrRevert(() =>
      track.setProcessor(
        createBackgroundProcessor({ imagePath: customBackgroundURL(stored.blob), assetPaths }, 'virtual-background'),
        true,
      ),
    );
    return;
  }

  const imagePath = renderGalleryBackground({
    width: 960,
    height: 540,
    choice,
    seed: freshBackgroundSeed(),
  });
  if (!imagePath) throw new Error(t('Couldn’t create the background.'));
  // Replace in place — never stopProcessor first on block→block, or the
  // real camera background flashes for a frame while the new effect boots.
  await applyOrRevert(() =>
    track.setProcessor(
      createBackgroundProcessor({ imagePath, assetPaths }, 'virtual-background'),
      true,
    ),
  );
}
