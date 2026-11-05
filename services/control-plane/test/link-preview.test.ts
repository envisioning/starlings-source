import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertUnfurlable, parseLinkPreview } from '../src/link-preview';
import { hmacSHA256Hex } from '../src/crypto';
import { serveLinkPreviewImage } from '../src/link-preview-image';

/**
 * Unfurling is the one route that fetches an address a message chose, so the
 * refusals are the interesting part: most of this file is about what it will
 * not go and read.
 */

function html(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

describe('what may be unfurled', () => {
  it('accepts an ordinary https page', () => {
    expect(assertUnfurlable('https://org.example/about').hostname).toBe('org.example');
    expect(assertUnfurlable('https://www.example.co.uk/a?b=c#d').hostname).toBe('www.example.co.uk');
  });

  it('refuses anything that is not https', () => {
    for (const raw of [
      'http://org.example',
      'file:///etc/passwd',
      'data:text/html,<title>x</title>',
      'ftp://org.example',
      'javascript:alert(1)',
      'not a url at all',
    ]) {
      expect(() => assertUnfurlable(raw), raw).toThrow();
    }
  });

  it('refuses an address literal, in every spelling', () => {
    for (const raw of [
      'https://127.0.0.1/',
      'https://10.0.0.5/',
      'https://192.168.1.1/',
      // The metadata service is the whole reason this rule exists.
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/',
      'https://[fd00::1]/',
      // 127.0.0.1 with no dots in it.
      'https://2130706433/',
      'https://0x7f000001/',
    ]) {
      expect(() => assertUnfurlable(raw), raw).toThrow();
    }
  });

  it('refuses names only a private resolver knows', () => {
    for (const raw of [
      'https://localhost/',
      'https://router/',
      'https://metadata/',
      'https://printer.local/',
      'https://vault.internal/',
      'https://box.home.arpa/',
    ]) {
      expect(() => assertUnfurlable(raw), raw).toThrow();
    }
  });

  it('refuses a non-default port, which is how an internal service is reached', () => {
    expect(() => assertUnfurlable('https://org.example:8787/')).toThrow();
    expect(() => assertUnfurlable('https://org.example:6379/')).toThrow();
    // The default, written out, is still the default.
    expect(assertUnfurlable('https://org.example:443/').hostname).toBe('org.example');
  });

  it('refuses credentials rather than forwarding them', () => {
    expect(() => assertUnfurlable('https://user:secret@example.com/')).toThrow();
  });
});

describe('what a page turns into', () => {
  const target = new URL('https://www.org.example/piece');

  it('prefers Open Graph, then Twitter, then the plain tags', async () => {
    const preview = await parseLinkPreview(html(`
      <html><head>
        <title>Plain title</title>
        <meta name="description" content="Plain description">
        <meta name="twitter:title" content="Twitter title">
        <meta property="og:title" content="Graph title">
        <meta property="og:site_name" content="Envisioning">
      </head><body>ignored</body></html>
    `), target);
    expect(preview.title).toBe('Graph title');
    // No og:description, so this falls to Twitter's, then would fall to plain.
    expect(preview.description).toBe('Plain description');
    expect(preview.site_name).toBe('Envisioning');
    expect(preview.domain).toBe('org.example');
    expect(preview.url).toBe('https://www.org.example/piece');
  });

  it('falls back to <title> when a page carries no metadata at all', async () => {
    const preview = await parseLinkPreview(html('<html><head><title>  Just \n a title </title></head></html>'), target);
    expect(preview.title).toBe('Just a title');
    expect(preview.description).toBeNull();
    expect(preview.site_name).toBeNull();
  });

  it('is all nulls but a domain for a page with nothing in its head', async () => {
    const preview = await parseLinkPreview(html('<html><body>hello</body></html>'), target);
    expect(preview.title).toBeNull();
    expect(preview.description).toBeNull();
    expect(preview.domain).toBe('org.example');
  });

  it('keeps the first tag of a kind, not the last', async () => {
    const preview = await parseLinkPreview(html(`
      <meta property="og:title" content="First">
      <meta property="og:title" content="Second">
    `), target);
    expect(preview.title).toBe('First');
  });

  it('bounds a title so a card cannot become a payload', async () => {
    const preview = await parseLinkPreview(html(
      `<meta property="og:title" content="${'x'.repeat(5_000)}">`,
    ), target);
    expect(preview.title!.length).toBe(200);
    expect(preview.title!.endsWith('…')).toBe(true);
  });

  it('decodes the entities publishers actually write', async () => {
    const preview = await parseLinkPreview(html(
      '<meta property="og:title" content="Tom &amp; Jerry&#39;s &#x2014; caf&#233;">',
    ), target);
    expect(preview.title).toBe("Tom & Jerry's — café");
  });

  it('takes the metadata as text, never as markup', async () => {
    const preview = await parseLinkPreview(html(
      '<meta property="og:title" content="&lt;img src=x onerror=alert(1)&gt;">',
    ), target);
    // Decoded to characters, which is right: this is a string on its way to a
    // React text node, not markup on its way to a DOM. Nothing downstream is
    // allowed to treat it as HTML, and `markdown.tsx` is where that is held.
    expect(preview.title).toBe('<img src=x onerror=alert(1)>');
  });

  it('leaves a malformed reference alone rather than guessing', async () => {
    const preview = await parseLinkPreview(html(
      '<meta property="og:title" content="100% &notreal; &#xD800; A&B">',
    ), target);
    expect(preview.title).toBe('100% &notreal; &#xD800; A&B');
  });
});

describe('the routes', () => {
  it('refuses an unauthenticated unfurl', async () => {
    const response = await exports.default.fetch(new Request(
      'http://local/api/link-preview?url=https%3A%2F%2Forg.example%2F',
    ));
    expect(response.status).toBe(401);
  });

  it('refuses a guest unfurl with no artifact token', async () => {
    const response = await exports.default.fetch(new Request(
      'http://local/api/rooms/rosa/meetings/00000000-0000-4000-8000-000000000000/link-preview'
      + '?url=https%3A%2F%2Forg.example%2F',
    ));
    expect(response.status).toBe(401);
  });

  it('asks for a url before it asks anything of the network', async () => {
    const session = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }));
    const { access_token: token } = await session.json<{ access_token: string }>();
    const response = await exports.default.fetch(new Request('http://local/api/link-preview', {
      headers: { authorization: `Bearer ${token}` },
    }));
    expect(response.status).toBe(400);
  });
});

/**
 * The picture on a card, which is the part that could have been an open proxy.
 *
 * The route takes a URL from the caller, so the only thing separating it from
 * a general-purpose fetcher on our origin is the signature saying this Worker
 * found that address in a page it had already agreed to read. These are the
 * tests for that: a caller may replay an address Meet published, and may not
 * mint one.
 */
describe('the picture on a preview card', () => {
  const signing = { ...env, SESSION_SIGNING_SECRET: 'preview-image-signing-secret-32-chars' } as Env;

  afterEach(() => vi.restoreAllMocks());

  async function imageRequest(target: string): Promise<Request> {
    const digest = await hmacSHA256Hex(
      signing.SESSION_SIGNING_SECRET,
      `link-preview-image:v1:${target}`,
    );
    const url = new URL('https://envisioning.starlings.example/api/link-preview/image');
    url.searchParams.set('url', target);
    url.searchParams.set('sig', digest.slice(0, 32));
    return new Request(url);
  }

  async function previewOf(body: string, page = 'https://org.example/post') {
    return parseLinkPreview(html(body), new URL(page), {
      env: signing,
      origin: 'https://envisioning.starlings.example',
    });
  }

  it('publishes the picture on our origin, never the publisher’s', async () => {
    const preview = await previewOf(
      '<meta property="og:image" content="https://cdn.example.com/banner.png">'
      + '<meta property="og:image_alt" content="A banner">',
    );
    const address = new URL(preview.image_url ?? '');
    expect(address.origin).toBe('https://envisioning.starlings.example');
    expect(address.pathname).toBe('/api/link-preview/image');
    // The publisher's address travels as a parameter, signed — the browser
    // still never talks to cdn.example.com.
    expect(address.searchParams.get('url')).toBe('https://cdn.example.com/banner.png');
    expect(address.searchParams.get('sig')).toMatch(/^[0-9a-f]{32}$/u);
    expect(preview.image_alt).toBe('A banner');
  });

  it('resolves a relative picture against the page that declared it', async () => {
    const preview = await previewOf('<meta property="og:image" content="/img/card.png">');
    expect(new URL(preview.image_url ?? '').searchParams.get('url'))
      .toBe('https://org.example/img/card.png');
  });

  it('publishes no picture for an address the host rules refuse', async () => {
    // An og:image is as forgeable as any other tag on somebody else's page, so
    // it goes through the same gate the page itself did. Advertising one of
    // these would mean minting a signature for an address we would then refuse
    // to fetch — a card with a permanently broken picture.
    for (const raw of [
      'http://cdn.example.com/banner.png',
      'https://192.168.1.1/banner.png',
      'https://localhost/banner.png',
      'https://cdn.example.com:8080/banner.png',
      'https://internal/banner.png',
    ]) {
      const preview = await previewOf(`<meta property="og:image" content="${raw}">`);
      expect(preview.image_url, raw).toBeUndefined();
    }
  });

  it('says nothing about a picture when the page offers none', async () => {
    const preview = await previewOf('<title>A page</title>');
    expect(preview.image_url).toBeUndefined();
    expect(preview.image_alt).toBeUndefined();
  });

  it('refuses an address nobody signed', async () => {
    // The whole point: a caller may not aim this at a host of their choosing.
    for (const query of [
      'url=https://cdn.example.com/banner.png',
      'url=https://cdn.example.com/banner.png&sig=',
      'url=https://cdn.example.com/banner.png&sig=' + 'f'.repeat(32),
      'sig=' + 'f'.repeat(32),
      '',
    ]) {
      const response = await exports.default.fetch(
        new Request(`http://local/api/link-preview/image?${query}`),
      );
      expect(response.status, query).toBe(403);
    }
  });

  it('refuses a signature minted for a different address', async () => {
    // Lifting the signature off one published picture and pointing it at
    // another is the obvious attempt, and it is the one the label plus the
    // per-URL digest exists to stop.
    const preview = await previewOf('<meta property="og:image" content="https://cdn.example.com/a.png">');
    const stamp = new URL(preview.image_url ?? '').searchParams.get('sig') ?? '';
    const response = await exports.default.fetch(new Request(
      `http://local/api/link-preview/image?url=${encodeURIComponent('https://cdn.example.com/b.png')}&sig=${stamp}`,
    ));
    expect(response.status).toBe(403);
  });

  it('serves a signed image and follows a public CDN redirect', async () => {
    const target = 'https://cdn.example.com/card.webp';
    const redirected = 'https://images.example.com/card.webp';
    const webp = new TextEncoder().encode('RIFF____WEBPVP8 ');
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const requested = new URL(String(input)).toString();
      if (requested === target) {
        return new Response(null, { status: 302, headers: { location: redirected } });
      }
      return new Response(webp, { headers: { 'content-type': 'image/webp' } });
    });

    const response = await serveLinkPreviewImage(signing, await imageRequest(target));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(webp);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
