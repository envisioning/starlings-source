import type { LinkPreview } from './contracts';
import { ControlError } from './errors';
import { signedImageURL } from './link-preview-image';

/**
 * Reading a pasted link, so a message can show what it points at.
 *
 * The device never fetches the page. Same rule, and the same reason, as the
 * GitHub avatar proxy in `crm.ts`: the bytes are public, but *who asks for
 * them* is not. A browser unfurling its own links tells every site anybody
 * pastes the address of every participant who happened to be in the room when
 * it was pasted — including the guests, who did not paste anything. Asking
 * from here means the site sees the Worker and learns nothing about the room.
 *
 * The picture comes through Meet too, for exactly the same reason — handing a
 * client the publisher's own image address would give back the thing reading
 * the page here was meant to protect. What keeps that from being an open image
 * proxy is that the address is *signed*: only a picture this Worker found in a
 * page it had already agreed to read can be redeemed. See
 * `link-preview-image.ts`, which holds that argument in full.
 */
export class LinkPreviewError extends ControlError {}

/** A page's metadata lives in `<head>`; this is well past the end of any of it. */
const MAX_HTML_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 6_000;
const MAX_REDIRECTS = 3;
/** Long enough to be a title, short enough that a card cannot become a payload. */
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 400;
/** An hour: long enough to spare a busy thread, short enough that a fixed page
 * stops looking broken by lunchtime. */
const CACHE_SECONDS = 3600;

/**
 * Hostnames that must never be fetched, whatever a message says.
 *
 * This route takes a URL from anybody who can type in a chat box, so it is the
 * one place in the Worker that can be aimed. The rules below are deliberately
 * blunt — a link worth previewing is a public page on a public name, so
 * anything that is not obviously that is refused rather than reasoned about.
 */
function assertPublicHostname(hostname: string): void {
  const host = hostname.toLowerCase();

  // An address literal is the whole SSRF class in one shape: `127.0.0.1`,
  // `[::1]`, `169.254.169.254`, `10.x`. No page worth previewing is named by
  // one, so none is allowed and the private ranges never have to be
  // enumerated — a list is a thing to leave a gap in.
  if (host.startsWith('[') || /^[0-9.]+$/u.test(host)) {
    throw new LinkPreviewError('Links to an address are not previewed.', 400, 'invalid_request');
  }

  // A single label is a name only a private resolver knows: `router`,
  // `metadata`, `wiki`. It also catches the other spellings of an address —
  // `2130706433` and `0x7f000001` are `127.0.0.1` with no dot in them. Public
  // pages are always under a registrable domain.
  if (!host.includes('.')) {
    throw new LinkPreviewError('Links to an internal name are not previewed.', 400, 'invalid_request');
  }

  const privateSuffixes = ['.local', '.internal', '.localdomain', '.home.arpa', '.localhost'];
  if (host === 'localhost' || privateSuffixes.some((suffix) => host.endsWith(suffix))) {
    throw new LinkPreviewError('Links to an internal name are not previewed.', 400, 'invalid_request');
  }
}

/**
 * The URL this may fetch, or a refusal. Exported so the rules can be tested
 * as rules, rather than only through a request that happens to exercise them.
 */
export function assertUnfurlable(raw: string): URL {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw new LinkPreviewError('Not a link.', 400, 'invalid_request');
  }
  // http:// is refused rather than upgraded: the answer describes a page, and
  // a page read over cleartext is one a network can choose the contents of.
  if (target.protocol !== 'https:') {
    throw new LinkPreviewError('Only https links are previewed.', 400, 'invalid_request');
  }
  // Credentials in a URL are either a mistake or bait, and forwarding them
  // would send somebody's password to whatever host the message named.
  if (target.username || target.password) {
    throw new LinkPreviewError('Not a link.', 400, 'invalid_request');
  }
  // A port is how an internal service is reached on a name that resolves
  // publicly. Public pages answer on 443.
  if (target.port && target.port !== '443') {
    throw new LinkPreviewError('Only https links are previewed.', 400, 'invalid_request');
  }
  assertPublicHostname(target.hostname);
  return target;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

/**
 * Turn the entities a page writes back into the characters it meant.
 *
 * `HTMLRewriter` hands attributes and text back exactly as they were written,
 * so a headline about "Tom &amp; Jerry" arrives with the `&amp;` still in it
 * and a card would show it. Only the handful publishers actually use, plus
 * numeric references — this is tidying display text, not implementing HTML.
 *
 * Safe to do here precisely because the result is bound for a React text node:
 * decoding for display cannot become markup downstream. One pass, so a decoded
 * `&amp;` can never be re-read as the start of another entity.
 */
function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (whole, body: string) => {
    const token = body.toLowerCase();
    if (token.startsWith('#')) {
      const code = token.startsWith('#x')
        ? Number.parseInt(token.slice(2), 16)
        : Number.parseInt(token.slice(1), 10);
      // Surrogates and out-of-range values are left as written rather than
      // guessed at; `fromCodePoint` would throw on them.
      if (!Number.isInteger(code) || code < 0x20 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[token] ?? whole;
  });
}

/** Collapse the whitespace a `<title>` may be laid out across, then bound it. */
function tidy(value: string | null, max: number): string | null {
  if (value === null) return null;
  const text = decodeEntities(value).replace(/\s+/gu, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Pull the card's text out of a page.
 *
 * `HTMLRewriter` rather than a regular expression over the markup: this parses
 * attacker-supplied HTML, and the failure mode of a regex here is reading a
 * `content=` out of something that was never a tag. Open Graph wins over
 * Twitter's tags, which win over the plain `<title>`/`<meta name=description>`,
 * which is the order publishers expect.
 */
export async function parseLinkPreview(
  response: Response,
  finalURL: URL,
  image?: { env: Env; origin: string },
): Promise<LinkPreview> {
  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  let metaDescription: string | null = null;
  let title = '';
  let inTitle = false;

  const rewriter = new HTMLRewriter()
    .on('meta', {
      element(element) {
        const content = element.getAttribute('content');
        if (!content) return;
        const property = element.getAttribute('property')?.toLowerCase();
        const name = element.getAttribute('name')?.toLowerCase();
        // First tag of a kind wins: a page that repeats `og:title` is either
        // sloppy or trying to get a second look at what the card says.
        if (property?.startsWith('og:')) {
          const key = property.slice(3);
          if (!(key in og)) og[key] = content;
        } else if (name?.startsWith('twitter:')) {
          const key = name.slice(8);
          if (!(key in twitter)) twitter[key] = content;
        } else if (name === 'description') {
          metaDescription ??= content;
        }
      },
    })
    .on('title', {
      element() { inTitle = true; },
      text(chunk) { if (inTitle && title.length < MAX_TITLE * 4) title += chunk.text; },
    });

  // The rewriter only runs over what is consumed, and nothing here needs the
  // transformed bytes — draining is what drives the parse.
  await drain(rewriter.transform(response));

  // `og:image` first, then Twitter's — the order publishers expect, same as
  // the text fields. Signed here rather than published raw; a page that names
  // an address the host rules refuse simply gets a card without a picture.
  const imageURL = image
    ? await signedImageURL(image.env, image.origin, og.image ?? twitter.image, finalURL)
    : undefined;

  return {
    url: finalURL.toString(),
    domain: finalURL.hostname.replace(/^www\./u, ''),
    title: tidy(og.title ?? twitter.title ?? title, MAX_TITLE),
    description: tidy(og.description ?? twitter.description ?? metaDescription, MAX_DESCRIPTION),
    site_name: tidy(og.site_name ?? null, MAX_TITLE),
    ...(imageURL ? { image_url: imageURL } : {}),
    // The publisher's own words for the picture, never the title standing in
    // for them: alt text that repeats the headline is worse than none, because
    // a screen reader then says it twice.
    ...(imageURL ? { image_alt: tidy(og.image_alt ?? twitter.image_alt ?? null, MAX_TITLE) } : {}),
  };
}

/**
 * Read at most `MAX_HTML_BYTES`, then stop pulling.
 *
 * Counted while it arrives rather than buffered whole: the size a page claims
 * in `content-length` is not the size it sends, and a body with no end at all
 * is the cheapest way to tie up a Worker.
 */
async function drain(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value?.byteLength ?? 0;
      if (read >= MAX_HTML_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * Fetch one page under the reader's rules: every hop checked, HTML only.
 *
 * Redirects are followed by hand so that every hop is checked against the same
 * rules as the address that was pasted — `redirect: 'follow'` would let a
 * public URL hand back a `Location` pointing at localhost and be obeyed. The
 * card reads the head of the answer; a link save reads the article from it
 * too (`link-article.ts`).
 */
export async function fetchPage(
  raw: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<{ response: Response; url: URL }> {
  let target = assertUnfurlable(raw);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(target, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        // Asking for HTML keeps a link to a large binary from being fetched at
        // all on servers that honour it.
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en',
        'user-agent': 'starlings-link-preview',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) throw new LinkPreviewError('That link could not be read.', 502);
      // Re-validated, not trusted: this is the hop an open redirect would use.
      target = assertUnfurlable(new URL(location, target).toString());
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new LinkPreviewError(`That link could not be read (${response.status}).`, 502);
    }

    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!type.includes('text/html') && !type.includes('application/xhtml+xml')) {
      await response.body?.cancel().catch(() => {});
      throw new LinkPreviewError('That link is not a page.', 415, 'invalid_request');
    }

    return { response, url: target };
  }

  throw new LinkPreviewError('That link redirects too many times.', 502);
}

/** Fetch one link's metadata. */
export async function fetchLinkPreview(
  raw: string,
  image?: { env: Env; origin: string },
): Promise<LinkPreview> {
  const page = await fetchPage(raw);
  return parseLinkPreview(page.response, page.url, image);
}

/**
 * Cache key for one target. A synthetic address, not the caller's request:
 * the answer depends only on the page, and the request carries a session that
 * must never become part of what is stored.
 */
function cacheKey(target: string): Request {
  return new Request(`https://link-preview.invalid/?u=${encodeURIComponent(target)}`);
}

/**
 * One link's metadata, from the edge cache when it is there.
 *
 * The cache is what keeps a busy thread from re-reading the same link once per
 * reader, and it is shared: a link previewed for one member is answered from
 * store for the next, so the site sees one fetch rather than one per person —
 * which is the privacy point as much as the cost one. Failures are not cached;
 * a site that was down for a minute should not look broken for an hour.
 */
export async function linkPreview(
  raw: string,
  image?: { env: Env; origin: string },
): Promise<LinkPreview> {
  // Validated before the cache is consulted so a refusal is never a cache
  // lookup, and so the key is the address we would actually fetch.
  const target = assertUnfurlable(raw).toString();
  const key = cacheKey(target);
  const cache = await caches.open('link-preview');

  const hit = await cache.match(key);
  if (hit) return hit.json<LinkPreview>();

  const preview = await fetchLinkPreview(target, image);
  await cache.put(key, new Response(JSON.stringify(preview), {
    headers: {
      'content-type': 'application/json',
      'cache-control': `public, max-age=${CACHE_SECONDS}`,
    },
  }));
  return preview;
}
