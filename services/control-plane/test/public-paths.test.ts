import { describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';
import { isAllowedPublicDocument } from '../src/index';
import { PRODUCT_SITE_PATHS } from '@starlings/contracts/paths';
import {
  bookPermalink,
  canonicalRoomPath,
  parsePublicBookPath,
  parsePublicRoomPath,
  roomPermalink,
} from '@starlings/contracts/paths';

// The Worker gates which documents it will serve on this grammar, and the SPA
// routes on it. A disagreement between the two shows up as a blank page on a
// link that was already sent, so the parsers and the root 404 are pinned here.

describe('room paths', () => {
  it('reads only the canonical room form', () => {
    expect(parsePublicRoomPath('/room/rosa')).toEqual({ slug: 'rosa' });
    expect(parsePublicRoomPath('/room/rosa/abc-123')).toEqual({ slug: 'rosa', bookingToken: 'abc-123' });
    expect(parsePublicRoomPath('/rosa')).toBeNull();
  });

  it('has no short form — /<slug> is not a room', () => {
    expect(parsePublicRoomPath('/rosa/abc-123')).toBeNull();
  });

  it('never reads a reserved segment as a room slug', () => {
    for (const path of ['/privacy', '/terms', '/workspace', '/workspace/status', '/workspace/capabilities', '/changelog', '/admin', '/api', '/assets', '/room', '/mediapipe', '/book', '/download', '/team', '/join', '/calendar', '/work', '/docs', '/settings']) {
      expect(parsePublicRoomPath(path)).toBeNull();
    }
  });

  it('serves the SPA shell at every member destination', async () => {
    const env = { OWNER_ROOM_MAP: '{"rosa@example.com":"rosa"}' } as unknown as Env;
    for (const path of [
      '/team', '/team/', '/agents', '/agents/', '/calendar',
      '/work', '/work/', '/work/mine', '/work/envisioning/', '/work/projects',
      '/work/leads/', '/work/partners', '/work/browse/',
      '/docs', '/docs/', '/meetings', '/meetings/',
      '/meetings/rosa/3f2a3a7e-2c4f-4a52-9c2e-9a7a1f6a3b10', '/join', '/settings', '/settings/',
    ]) {
      expect(await isAllowedPublicDocument(path, env), path).toBe(true);
    }
    expect(await isAllowedPublicDocument('/work/not-a-section', env)).toBe(false);
  });

  it('serves the room shell for an unmapped slug so the SPA can explain the error', async () => {
    const env = { OWNER_ROOM_MAP: '{"rosa@example.com":"rosa"}' } as unknown as Env;
    expect(await isAllowedPublicDocument('/room/felix', env)).toBe(true);
    expect(await isAllowedPublicDocument('/room/felix/invite-token', env)).toBe(true);
    expect(await isAllowedPublicDocument('/felix', env)).toBe(false);
  });

  it('serves the shell at every product-site page the contract lists, with or without a trailing slash', async () => {
    const env = { OWNER_ROOM_MAP: '{"rosa@example.com":"rosa"}' } as unknown as Env;
    for (const path of PRODUCT_SITE_PATHS) {
      expect(await isAllowedPublicDocument(path, env), path).toBe(true);
      expect(await isAllowedPublicDocument(`${path}/`, env), `${path}/`).toBe(true);
    }
    // The contract is the whole list: a path that looks like a product page but is not on it gets no shell.
    expect(await isAllowedPublicDocument('/workspace/roadmap', env)).toBe(false);
  });

  it('serves the shell at each of Admin’s sections, the connector pages, and the old addresses that redirect', async () => {
    const env = { OWNER_ROOM_MAP: '{"rosa@example.com":"rosa"}' } as unknown as Env;
    for (const path of [
      '/admin', '/admin/', '/admin/people', '/admin/people/',
      '/admin/connectors', '/admin/connectors/', '/admin/connectors/granola', '/admin/connectors/github', '/admin/connectors/slack/',
      '/admin/jobs', '/admin/jobs/', '/admin/agents', '/admin/agents/', '/admin/records', '/admin/records/', '/admin/activity',
      '/admin/org', '/admin/org/', '/connectors', '/connectors/granola/',
    ]) {
      expect(await isAllowedPublicDocument(path, env), path).toBe(true);
    }
    // The shell is not authorization, and an invented section is not a page.
    expect(await isAllowedPublicDocument('/admin/everything', env)).toBe(false);
  });

  it('does not mistake /book/<slug> for room "book" with a token', () => {
    // Before `book` was reserved this parsed as { slug: 'book', bookingToken: 'rosa' }
    // and 404'd as an unmapped room.
    expect(parsePublicRoomPath('/book/rosa')).toBeNull();
  });

  it('does not mistake a download destination for a room token', () => {
    expect(parsePublicRoomPath('/download/mac')).toBeNull();
    expect(parsePublicRoomPath('/download/ios')).toBeNull();
  });

  it('404s a short room alias for a mapped room instead of redirecting', async () => {
    const response = await exports.default.fetch(new Request('http://local/rosa'), { redirect: 'manual' });
    expect(response.status).toBe(404);

    const inviteResponse = await exports.default.fetch(new Request('http://local/rosa/abc-123_token'), { redirect: 'manual' });
    expect(inviteResponse.status).toBe(404);
  });
});

describe('book paths', () => {
  it('reads /book/<slug>, case-insensitively, with or without a trailing slash', () => {
    expect(parsePublicBookPath('/book/rosa')).toEqual({ slug: 'rosa' });
    expect(parsePublicBookPath('/book/rosa/')).toEqual({ slug: 'rosa' });
    expect(parsePublicBookPath('/BOOK/ROSA')).toEqual({ slug: 'rosa' });
  });

  it('has no token form — booking is how a token comes to exist', () => {
    expect(parsePublicBookPath('/book/rosa/abc-123')).toBeNull();
  });

  it('rejects the bare segment and anything unslug-shaped', () => {
    for (const path of ['/book', '/book/', '/book/x', '/book/a b', '/room/rosa']) {
      expect(parsePublicBookPath(path)).toBeNull();
    }
  });
});

describe('permalinks', () => {
  it('builds the two public links a host can hand out', () => {
    expect(canonicalRoomPath('rosa')).toBe('/room/rosa');
    expect(canonicalRoomPath('rosa', 'abc-123')).toBe('/room/rosa/abc-123');
    expect(roomPermalink('https://hq.starlings.example', 'rosa')).toBe('https://hq.starlings.example/room/rosa');
    expect(roomPermalink('https://hq.starlings.example/', 'rosa', 'abc-123')).toBe('https://hq.starlings.example/room/rosa/abc-123');
    expect(bookPermalink('https://hq.starlings.example', 'rosa')).toBe('https://hq.starlings.example/book/rosa');
  });

  it('round-trips through its own parser', () => {
    expect(parsePublicBookPath(new URL(bookPermalink('https://hq.starlings.example', 'rosa')).pathname)).toEqual({ slug: 'rosa' });
    expect(parsePublicRoomPath(new URL(roomPermalink('https://hq.starlings.example', 'rosa')).pathname)).toEqual({ slug: 'rosa' });
  });
});
