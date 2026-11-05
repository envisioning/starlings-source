import { AVATAR_EDGE_PIXELS, AVATAR_MAX_BYTES } from '@starlings/contracts/limits';
import { apiBase, responseError } from './config';
import type { Peer } from './team-presence';
import { t } from './i18n';

/**
 * Profile pictures in the browser.
 *
 * The image is an ordinary same-origin `<img src>` rather than a fetch into a
 * blob: the member cookie rides along, the browser caches it, and a roster of
 * twenty faces costs twenty cached GETs instead of twenty pieces of React
 * state. `v` is `avatar_updated_at` from the roster, so a new picture is a new
 * URL and the old one is never shown again.
 */
export function avatarSrc(peer: Pick<Peer, 'email' | 'avatar_updated_at'>): string | null {
  if (peer.avatar_updated_at === null) return null;
  return `${apiBase}/avatar?email=${encodeURIComponent(peer.email)}&v=${peer.avatar_updated_at}`;
}

/**
 * Square, downscale and re-encode before uploading. The Worker stores what it
 * is given, so a 6MB photo straight off a phone would be a 6MB download for
 * every colleague who opens the roster — and the client is the one place that
 * already has the image decoded.
 */
export async function uploadAvatar(file: File): Promise<number> {
  const bytes = await squareJpeg(file);
  if (bytes.size > AVATAR_MAX_BYTES) throw new Error(t('That picture is too large.'));
  const response = await fetch(`${apiBase}/profile/avatar`, {
    method: 'PUT',
    headers: { 'content-type': bytes.type },
    body: bytes,
  });
  if (!response.ok) throw await responseError(response, t('Couldn’t save that picture.'));
  const body = await response.json() as { avatar_updated_at: number | null };
  return body.avatar_updated_at ?? Date.now();
}

export async function removeAvatar(): Promise<void> {
  const response = await fetch(`${apiBase}/profile/avatar`, { method: 'DELETE' });
  if (!response.ok) throw await responseError(response, t('Couldn’t remove your picture.'));
}

/**
 * Centre-cropped to a square and drawn at the shared edge size, so a picture
 * taken in landscape lands in a round well the same way one taken in portrait
 * does. JPEG rather than WebP: every browser that can encode one can encode
 * this, and the difference at 512px is not worth a format check.
 */
async function squareJpeg(file: File): Promise<Blob> {
  const image = await loadImage(file);
  const edge = Math.min(image.width, image.height);
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_EDGE_PIXELS;
  canvas.height = AVATAR_EDGE_PIXELS;
  const context = canvas.getContext('2d');
  if (!context) throw new Error(t('Couldn’t read that picture.'));
  context.drawImage(
    image,
    (image.width - edge) / 2,
    (image.height - edge) / 2,
    edge,
    edge,
    0,
    0,
    AVATAR_EDGE_PIXELS,
    AVATAR_EDGE_PIXELS,
  );
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', 0.86);
  });
  if (!blob) throw new Error(t('Couldn’t read that picture.'));
  return blob;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(t('That file isn’t an image Starlings can read.')));
    };
    image.src = url;
  });
}
