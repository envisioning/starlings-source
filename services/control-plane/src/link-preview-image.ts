import { sniffImageType } from './avatars';
import { constantTimeEqualSync, hmacSHA256Hex } from './crypto';
import { sessionSigningSecrets } from './session-keys';
import { assertUnfurlable, LinkPreviewError } from './link-preview';

/**
 * The picture on a link preview, served from Meet rather than from the site.
 *
 * `link-preview.ts` reads the page here so the site never learns who is in the
 * room. Handing the client the publisher's own image address would give that
 * straight back: the browser would fetch it directly, and the site would see
 * every participant who happened to be present when somebody pasted a link —
 * including the guests, who pasted nothing. So the bytes come through here
 * too, and the address that route was closed against is the one thing this
 * one must not accept.
 *
 * **The signature is the whole difference between this and an open proxy.**
 * A route that fetched any URL a caller named would be a general-purpose
 * fetcher on our origin, aimable at anything by anyone who can type in a chat
 * box. So the URL is not trusted because it was asked for — it is trusted
 * because it carries an HMAC proving *this Worker* found it, in the `<head>`
 * of a page it had already agreed to read. A caller can replay an address Meet
 * published; it cannot mint one.
 *
 * Everything else is the same defensive shape as the unfurl itself: the same
 * host rules (an `og:image` can point at `http://192.168.1.1/` as easily as at
 * a CDN), a bounded read, a sniffed type, and headers that keep a picture from
 * being talked into behaving like a document.
 */

/** A preview picture is a picture. Past this it is a payload. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 6_000;
const MAX_REDIRECTS = 3;
/** A day. The signature does not expire, so neither does the usefulness. */
const CACHE_SECONDS = 86_400;

/**
 * Label the signing key, rather than signing bare URLs with it.
 *
 * `SESSION_SIGNING_SECRET` signs sessions. A signature over `<url>` alone would
 * be a token from that key with no statement of what it authorizes; the prefix
 * is what makes this one only ever mean "Meet found this picture", and stops a
 * digest minted here from being worth anything anywhere else.
 */
const SIGNATURE_LABEL = 'link-preview-image:v1:';

async function signature(secret: string, url: string): Promise<string> {
  const digest = await hmacSHA256Hex(secret, `${SIGNATURE_LABEL}${url}`);
  // Half a SHA-256 is 128 bits — far past guessing, and it keeps the address
  // short enough to sit in a message payload without dominating it.
  return digest.slice(0, 32);
}

/**
 * The address to publish for a picture the unfurl found, or null when there is
 * nothing worth publishing.
 *
 * Validated here rather than at serve time as well as: an image the host rules
 * refuse is one this should never have advertised, and refusing it now means a
 * card never draws a broken picture.
 */
export async function signedImageURL(
  env: Env,
  origin: string,
  candidate: string | null | undefined,
  base: URL,
): Promise<string | undefined> {
  if (!candidate) return undefined;
  let resolved: URL;
  try {
    // Relative `og:image` is common and legal; resolve against the page that
    // declared it, which is the address after redirects.
    resolved = assertUnfurlable(new URL(candidate, base).toString());
  } catch {
    return undefined;
  }
  const target = resolved.toString();
  const stamp = await signature(env.SESSION_SIGNING_SECRET, target);
  const address = new URL(`${origin.replace(/\/$/u, '')}/api/link-preview/image`);
  address.searchParams.set('url', target);
  address.searchParams.set('sig', stamp);
  return address.toString();
}

/**
 * Hand back one picture, if this Worker is the one that found it.
 *
 * A bad or missing signature is a 403 and not a 404: there is nothing secret
 * about which addresses exist — the caller supplied it — and saying "not
 * signed" is more useful to us in a log than pretending the route is empty.
 */
export async function serveLinkPreviewImage(env: Env, request: Request): Promise<Response> {
  const url = await verifiedTarget(env, new URL(request.url));
  const target = url.toString();

  const cache = await caches.open('link-preview-image');
  const key = new Request(`https://link-preview-image.invalid/${encodeURIComponent(target)}`);
  const hit = await cache.match(key);
  if (hit) return hit;

  const bytes = await readImage(url);
  if (!bytes) throw new LinkPreviewError('That picture could not be read.', 502);
  const contentType = sniffImageType(bytes);
  if (!contentType) {
    throw new LinkPreviewError('That address is not an image we can vouch for.', 415, 'invalid_request');
  }

  const response = new Response(bytes as unknown as BodyInit, {
    headers: {
      'content-type': contentType,
      // The same two headers the issue-image route carries, for the same
      // reason: this is somebody else's bytes on our origin.
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
      'cache-control': `public, max-age=${CACHE_SECONDS}`,
      // The publisher learns nothing about who is looking, which is the whole
      // point of the picture coming through here.
      'referrer-policy': 'no-referrer',
    },
  });
  await cache.put(key, response.clone());
  return response;
}

/**
 * The picture behind an address this Worker signed, as bytes — for a copy
 * kept server-side rather than a picture served to a client: a Docs link
 * save's cover. The same signature check, host rules, bounded read
 * and sniffed type as `serveLinkPreviewImage`; null for anything short of a
 * picture this Worker can vouch for.
 */
export async function previewImageBytes(
  env: Env,
  signedAddress: string,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  try {
    const url = await verifiedTarget(env, new URL(signedAddress));
    const bytes = await readImage(url);
    const contentType = bytes ? sniffImageType(bytes) : null;
    return bytes && contentType ? { bytes, contentType } : null;
  } catch {
    return null;
  }
}

/** The target of a signed address, or a refusal. */
async function verifiedTarget(env: Env, address: URL): Promise<URL> {
  const target = address.searchParams.get('url') ?? '';
  const stamp = address.searchParams.get('sig') ?? '';
  if (!target || !stamp) {
    throw new LinkPreviewError('That picture address is not signed.', 403, 'invalid_request');
  }
  // Signed with the current secret, or with the one a rotation just replaced:
  // a card posted before the rotation keeps its picture.
  const given = stamp.trim().toLowerCase();
  let signed = false;
  for (const secret of sessionSigningSecrets(env)) {
    if (constantTimeEqualSync(await signature(secret, target), given)) signed = true;
  }
  if (!signed) {
    throw new LinkPreviewError('That picture address is not signed.', 403, 'invalid_request');
  }
  // Re-checked even though `signedImageURL` checked: the rules can tighten
  // between the signature being minted and being redeemed, and the newer rule
  // is the one that should win.
  return assertUnfurlable(target);
}

/**
 * Read at most `MAX_IMAGE_BYTES`, then stop pulling.
 *
 * Counted while it arrives rather than trusted from `content-length`, for the
 * same reason the HTML read is: what a server claims and what it sends are two
 * different numbers, and a body with no end is the cheapest way to tie up a
 * Worker.
 */
async function readImage(url: URL): Promise<Uint8Array | null> {
  let target = url;
  let response: Response | null = null;

  // Image CDNs commonly redirect a stable asset URL to a regional or
  // versioned one. Follow those hops by hand so every destination is checked
  // against the same public-host rules as the original signed URL.
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    response = await fetch(target, {
      redirect: 'manual',
      headers: {
        accept: 'image/jpeg,image/png,image/webp',
        'user-agent': 'starlings-link-preview',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => null);

    if (!response) return null;
    if (response.status < 300 || response.status >= 400) break;

    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location || hop === MAX_REDIRECTS) return null;
    try {
      target = assertUnfurlable(new URL(location, target).toString());
    } catch {
      return null;
    }
  }

  if (!response?.ok) return null;

  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < MAX_IMAGE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (total === 0 || total > MAX_IMAGE_BYTES) return null;

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}
