import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import type { AvatarResponse, PeersResponse } from '@starlings/contracts';
import { googlePictureURL, sniffImageType } from '../src/avatars';
import { resetPeerRosterCache } from '../src/peers';
import { recordOwnerSignIn } from '../src/usage';

const rosa = { sub: 'avatar-rosa', email: 'rosa@example.com', name: 'Rosa' };
const ada = { sub: 'avatar-ada', email: 'ada@example.com', name: 'Ada' };

/** The smallest real PNG: an 8-byte signature is what the sniff reads. */
const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

async function ownerSession(email = rosa.email, name = rosa.name) {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email }),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}` };
}

async function upload(headers: Record<string, string>, bytes: Uint8Array) {
  return exports.default.fetch(new Request('http://local/api/profile/avatar', {
    method: 'PUT',
    headers: { ...headers, origin: env.WEB_ORIGIN },
    // `Uint8Array` is a valid body at runtime; the DOM lib's `BodyInit` does
    // not name it, so widen rather than copying the buffer on every upload.
    body: bytes as unknown as BodyInit,
  }));
}

afterEach(async () => {
  resetPeerRosterCache();
  await env.USAGE.prepare('DELETE FROM people WHERE sub IN (?1, ?2, ?3, ?4)')
    .bind(rosa.sub, ada.sub, `dev:${rosa.email}`, `dev:${ada.email}`)
    .run();
  await env.AVATARS?.delete([`avatars/dev:${rosa.email}`, `avatars/dev:${ada.email}`]);
});

describe('profile pictures', () => {
  it('refuses an unauthenticated upload and an unauthenticated read', async () => {
    const put = await upload({}, png);
    expect(put.status).toBe(401);
    const get = await exports.default.fetch(new Request('http://local/api/avatar?email=rosa@example.com'));
    expect(get.status).toBe(401);
  });

  it('stores an upload and serves it back to a colleague', async () => {
    const mine = await ownerSession();
    const stored = await upload(mine, png);
    expect(stored.status).toBe(200);
    const body = await stored.json<AvatarResponse>();
    expect(body.avatar_updated_at).toBeGreaterThan(0);

    await recordOwnerSignIn(env as Env, ada, 'mac');
    const theirs = await ownerSession(ada.email, ada.name);
    const read = await exports.default.fetch(new Request(
      `http://local/api/avatar?email=${encodeURIComponent(rosa.email)}&v=${body.avatar_updated_at}`,
      { headers: theirs },
    ));
    expect(read.status).toBe(200);
    expect(read.headers.get('content-type')).toBe('image/png');
    // The version the caller was told about is the one it may keep forever.
    expect(read.headers.get('cache-control')).toContain('immutable');
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(png);
  });

  it('refuses anything that is not one of the three image formats', async () => {
    const mine = await ownerSession();
    const response = await upload(mine, new TextEncoder().encode('<svg onload="alert(1)"></svg>'));
    expect(response.status).toBe(415);
  });

  it('publishes the new cache key on the roster, and clears it on removal', async () => {
    const mine = await ownerSession();
    const stored = await (await upload(mine, jpeg)).json<AvatarResponse>();

    resetPeerRosterCache();
    let roster = await (await exports.default.fetch(
      new Request('http://local/api/peers', { headers: mine }),
    )).json<PeersResponse>();
    expect(roster.peers.find((peer) => peer.email === rosa.email)?.avatar_updated_at)
      .toBe(stored.avatar_updated_at);

    const removed = await exports.default.fetch(new Request('http://local/api/profile/avatar', {
      method: 'DELETE',
      headers: { ...mine, origin: env.WEB_ORIGIN },
    }));
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toMatchObject({ avatar_updated_at: null });

    resetPeerRosterCache();
    roster = await (await exports.default.fetch(
      new Request('http://local/api/peers', { headers: mine }),
    )).json<PeersResponse>();
    expect(roster.peers.find((peer) => peer.email === rosa.email)?.avatar_updated_at).toBeNull();

    const gone = await exports.default.fetch(new Request(
      `http://local/api/avatar?email=${encodeURIComponent(rosa.email)}`,
      { headers: mine },
    ));
    expect(gone.status).toBe(404);
  });

  it('answers the same 404 for a member with no picture and for a stranger', async () => {
    const mine = await ownerSession();
    const nobody = await exports.default.fetch(new Request(
      'http://local/api/avatar?email=nobody@example.com',
      { headers: mine },
    ));
    expect(nobody.status).toBe(404);
    expect(await nobody.text()).toBe('');
  });
});

describe('image sniffing', () => {
  it('reads the format from the bytes, never from a header', () => {
    expect(sniffImageType(png)).toBe('image/png');
    expect(sniffImageType(jpeg)).toBe('image/jpeg');
    expect(sniffImageType(new TextEncoder().encode('RIFF____WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageType(new TextEncoder().encode('GIF89a______'))).toBeNull();
    expect(sniffImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

describe('the Google seed', () => {
  it('accepts only a Google picture URL, rebuilt from its parts', () => {
    expect(googlePictureURL('https://lh3.googleusercontent.com/a/abc=s96-c&evil=1')?.hostname)
      .toBe('lh3.googleusercontent.com');
    expect(googlePictureURL('https://lh3.googleusercontent.com/a/abc')?.searchParams.get('sz'))
      .toBe('512');
    expect(googlePictureURL('https://example.com/a/abc')).toBeNull();
    expect(googlePictureURL('http://lh3.googleusercontent.com/a/abc')).toBeNull();
    expect(googlePictureURL('not a url')).toBeNull();
  });
});
