import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import type { IssueImageResponse } from '@starlings/contracts';
import { isIssueImageID, issueImageKey } from '../src/issue-images';

/**
 * The interesting property here is the asymmetry: writing needs a member,
 * reading needs nobody. That is not an oversight — github.com renders an issue
 * body with no Meet session in hand — so it is worth a test that says so out
 * loud, and one that pins the id shape the address relies on.
 */

const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

const uploaded: string[] = [];

afterEach(async () => {
  for (const id of uploaded.splice(0)) {
    await env.ATTACHMENTS?.delete(issueImageKey(id));
  }
});

async function memberHeaders() {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}` };
}

async function upload(headers: Record<string, string>, bytes: Uint8Array) {
  return exports.default.fetch(new Request('http://local/api/issue-images', {
    method: 'POST',
    headers,
    body: bytes as unknown as BodyInit,
  }));
}

describe('the id an address is built from', () => {
  it('accepts only what we mint', () => {
    expect(isIssueImageID('0123456789abcdef0123456789abcdef')).toBe(true);
    // Anything else would be a key built from caller input.
    for (const raw of [
      '',
      '0123456789ABCDEF0123456789ABCDEF',
      '0123456789abcdef0123456789abcde',
      '0123456789abcdef0123456789abcdef0',
      '../../avatars/somebody',
      '0123456789abcdef0123456789abcde/',
    ]) {
      expect(isIssueImageID(raw), raw).toBe(false);
    }
  });
});

describe('uploading', () => {
  it('refuses somebody with no member session', async () => {
    const response = await upload({}, png);
    expect(response.status).toBe(401);
  });

  it('refuses a file whose bytes are not an image it can vouch for', async () => {
    // The type is sniffed rather than believed, because the serve route hands
    // this back to a browser: what it says a file is has to come from the file.
    const headers = await memberHeaders();
    const response = await upload(
      { ...headers, origin: env.WEB_ORIGIN },
      new TextEncoder().encode('<html><script>alert(1)</script></html>'),
    );
    expect(response.status).toBe(415);
  });

  it('refuses an empty body', async () => {
    const headers = await memberHeaders();
    const response = await upload({ ...headers, origin: env.WEB_ORIGIN }, new Uint8Array());
    expect(response.status).toBe(400);
  });
});

describe('reading', () => {
  it('answers a stored picture to a caller with no session at all', async () => {
    const headers = await memberHeaders();
    const stored = await upload({ ...headers, origin: env.WEB_ORIGIN }, png);
    expect(stored.status).toBe(201);
    const body = await stored.json<IssueImageResponse>();
    uploaded.push(body.id);
    expect(body.url.endsWith(`/api/issue-images/${body.id}`)).toBe(true);

    // No authorization header, no cookie: this is what github.com is.
    const read = await exports.default.fetch(new Request(body.url));
    expect(read.status).toBe(200);
    expect(read.headers.get('content-type')).toBe('image/png');
    // The headers that keep an image host from becoming an XSS.
    expect(read.headers.get('x-content-type-options')).toBe('nosniff');
    expect(read.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(png);
  });

  it('is a 404 for an address nobody minted', async () => {
    const response = await exports.default.fetch(new Request(
      'http://local/api/issue-images/ffffffffffffffffffffffffffffffff',
    ));
    expect(response.status).toBe(404);
  });

  it('does not route an id of the wrong shape at all', async () => {
    const response = await exports.default.fetch(new Request(
      'http://local/api/issue-images/not-a-real-id',
    ));
    expect(response.status).toBe(404);
  });
});
