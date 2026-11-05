import { CUSTOM_BACKGROUND_MAX_BYTES, CUSTOM_BACKGROUND_MAX_HEIGHT, CUSTOM_BACKGROUND_MAX_WIDTH } from '@starlings/contracts/limits';
import { t } from './i18n';
/**
 * Your own picture, behind you.
 *
 * Stored on this device and nowhere else. Compositing already happens locally —
 * the room only ever sees the finished frames — and a background is a picture
 * of somebody's home, so uploading it would take a thing that never leaves the
 * device today and put it on a server. It also has to work for guests, who have
 * no account to store anything against, and a feature that only signed-in
 * members can use is not "on all surfaces".
 *
 * The cost of that choice is honest and worth stating: a picture added here is
 * on *this* browser. Adding it on the Mac too means adding it there too. Syncing
 * it for signed-in members would be an addition on top of this, not a
 * replacement for it — guests would still need exactly what is here.
 *
 * IndexedDB rather than `localStorage`: this is a megabyte of image, the quota
 * is measured in single-digit megabytes, and writing it synchronously on the
 * main thread would jank the very call it is meant to decorate.
 */

const DB_NAME = 'meet-backgrounds';
const DB_VERSION = 1;
const STORE = 'images';
/** One slot. A gallery is a different feature, with a different UI to match. */
const SLOT = 'custom';

/**
 * What the camera is worth matching, not what the file happens to be. A 24
 * megapixel phone photo behind a 720p camera costs memory and segmentation time
 * for detail the encoder throws away, so it is scaled down once on the way in
 * rather than every frame on the way out. The ceilings are the contract's.
 */
const MAX_WIDTH = CUSTOM_BACKGROUND_MAX_WIDTH;
const MAX_HEIGHT = CUSTOM_BACKGROUND_MAX_HEIGHT;
export { CUSTOM_BACKGROUND_MAX_BYTES };

/**
 * What a browser will reliably decode *and* what somebody plausibly means by a
 * background. PNG is what was asked for; JPEG and WebP come along because the
 * decode path is identical and refusing somebody's holiday photo for being the
 * wrong container would be a rule with no reason behind it.
 */
export const CUSTOM_BACKGROUND_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export interface CustomBackground {
  /** Already scaled to the ceiling above. */
  blob: Blob;
  width: number;
  height: number;
  /** What the file was called, so the control can say which picture is on. */
  name: string;
  addedAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(t('Couldn’t open local storage.')));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error(t('Local storage refused that.')));
    });
  } finally {
    db.close();
  }
}

/** The picture this browser has, or null. Never throws: no picture is a state. */
export async function loadCustomBackground(): Promise<CustomBackground | null> {
  try {
    return (await withStore<CustomBackground | undefined>('readonly', (store) => store.get(SLOT))) ?? null;
  } catch {
    // Private windows and blocked storage both land here. The rest of the
    // meeting is unaffected, and a background nobody can save is not an error
    // worth interrupting a call for.
    return null;
  }
}

export async function clearCustomBackground(): Promise<void> {
  try {
    await withStore('readwrite', (store) => store.delete(SLOT));
  } catch {
    // Nothing to do about it, and nothing depends on it having worked.
  }
}

/**
 * Decode, scale, and keep one picture.
 *
 * Re-encoded as PNG rather than stored as uploaded, which does two things at
 * once: it bounds the size, and it means the bytes behind you are pixels this
 * browser drew rather than a file straight off disk with whatever metadata the
 * camera wrote into it. A background should not carry someone's GPS coordinates
 * around, even locally.
 */
export async function prepareBackgroundImage(file: File): Promise<CustomBackground> {
  if (file.size > CUSTOM_BACKGROUND_MAX_BYTES) {
    throw new Error(t('That image is too large — 12 MB is the limit.'));
  }
  if (!(CUSTOM_BACKGROUND_TYPES as readonly string[]).includes(file.type)) {
    throw new Error(t('Backgrounds must be a PNG, JPEG or WebP image.'));
  }

  const source = await decode(file);
  const scale = Math.min(1, MAX_WIDTH / source.width, MAX_HEIGHT / source.height);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error(t('This browser couldn’t read that image.'));
  context.drawImage(source, 0, 0, width, height);
  if ('close' in source) source.close();

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
  if (!blob) throw new Error(t('This browser couldn’t read that image.'));

  return { blob, width, height, name: file.name, addedAt: Date.now() };
}

export async function saveCustomBackground(file: File): Promise<CustomBackground> {
  const stored = await prepareBackgroundImage(file);
  try {
    await withStore('readwrite', (store) => store.put(stored, SLOT));
  } catch {
    // Private mode keeps the selected picture for this session.
  }
  return stored;
}

/** `createImageBitmap` where it exists, an `<img>` where it does not (Safari). */
async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through: a bitmap decoder that refuses the file may still be a
      // browser whose <img> accepts it.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(t('That file is not an image this browser can read.')));
      image.src = url;
    });
  } finally {
    // Revoked after load: the decoded pixels are the image's own now.
    URL.revokeObjectURL(url);
  }
}
