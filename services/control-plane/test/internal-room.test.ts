import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { internalRoomMap, internalRoomSlugs } from '@starlings/contracts';
import { isAllowedPublicDocument } from '../src/index';
import { parsePublicRoomPath } from '@starlings/contracts/paths';

async function endInternalRoom() {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
  }));
  const { access_token: token } = await response.json<{ access_token: string }>();
  await exports.default.fetch(new Request('http://local/api/rooms/team/end', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  }));
}

/*
 * The internal room — docs/adr/0001-internal-room.md.
 *
 * Every case here is one seam where a guest exists on an ordinary room. The
 * point of the room is that all of them are shut, so they are pinned together:
 * a half-closed door is worse than an open one, because it looks shut.
 *
 * `wrangler.test.jsonc` configures `team` as the internal room, hostable by any
 * verified Envisioning member.
 */

async function memberSession(email = 'rosa@example.com', name = 'Rosa') {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email }),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}` };
}

describe('internal room configuration', () => {
  it('parses the map and defaults to no internal room', () => {
    expect(internalRoomMap('{"rosa@example.com":"team"}')).toEqual({ 'rosa@example.com': 'team' });
    // Absent, blank and empty are the same answer, so a deployment that has
    // never heard of this feature behaves exactly as it did before.
    expect(internalRoomMap(undefined)).toEqual({});
    expect(internalRoomMap('')).toEqual({});
    expect(internalRoomMap('   ')).toEqual({});
    expect(internalRoomMap('{}')).toEqual({});
    expect(internalRoomSlugs(env.INTERNAL_ROOM_MAP).has('team')).toBe(true);
  });

  it('lowercases the host address and drops an invalid slug', () => {
    expect(internalRoomMap('{"ROSA@example.com":"team"}')).toEqual({ 'rosa@example.com': 'team' });
    expect(internalRoomMap('{"rosa@example.com":"Not A Slug"}')).toEqual({});
  });

  it('names the variable it could not read', () => {
    expect(() => internalRoomMap('not json')).toThrow('INTERNAL_ROOM_MAP is invalid JSON.');
    expect(() => internalRoomMap('[]')).toThrow('INTERNAL_ROOM_MAP must be an object.');
  });
});

describe('the internal room door', () => {
  it('404s the room lookup for a visitor, and answers a member', async () => {
    const visitor = await exports.default.fetch(new Request('http://local/api/rooms/team'));
    expect(visitor.status).toBe(404);
    // Byte-identical to a slug that was never configured. A 403, or any other
    // shape of body, would confirm the room exists.
    const unmapped = await exports.default.fetch(new Request('http://local/api/rooms/nosuchroom'));
    expect(unmapped.status).toBe(404);
    await expect(visitor.json()).resolves.toEqual(await unmapped.json());

    const member = await exports.default.fetch(new Request('http://local/api/rooms/team', {
      headers: await memberSession(),
    }));
    expect(member.status).toBe(200);
    // `you` is the member's own identity echoed back, so Room entry has nothing
    // left to ask them — no song and dance between a colleague and the meeting.
    await expect(member.json()).resolves.toMatchObject({
      slug: 'team',
      internal: true,
      you: { name: 'Rosa', email: 'rosa@example.com' },
    });
  });

  it('echoes each member their own identity and nobody else’s', async () => {
    const ada = await exports.default.fetch(new Request('http://local/api/rooms/team', {
      headers: await memberSession('ada@example.com', 'Ada'),
    }));
    await expect(ada.json()).resolves.toMatchObject({ you: { email: 'ada@example.com' } });
  });

  it('marks only the internal room internal', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/rooms/rosa'));
    expect(response.status).toBe(200);
    const body = await response.json<{ internal?: boolean }>();
    expect(body.internal).toBeUndefined();
  });

  it('refuses a knock from a visitor before it costs anything', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/rooms/team/join-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({ name: 'Ana', email: 'ana@acme.example' }),
    }));
    expect(response.status).toBe(404);
  });

  it('tells a member with a stale bearer to renew, instead of hiding the room (meet#204)', async () => {
    // f4aa4d4f: a bearer that no longer verifies is a colleague whose session
    // expired, not a stranger. 404 here left the Mac client on "Not found."
    // with nothing to renew; 401 `owner_auth_required` is what it acts on.
    const response = await exports.default.fetch(new Request('http://local/api/rooms/team/join-requests', {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-session', 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'owner_auth_required' });
  });

  it('writes no pre-knock presence, so the abandon sweep has nothing to count', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/rooms/team/guest-presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({ presence_id: crypto.randomUUID(), stage: 'visit' }),
    }));
    expect(response.status).toBe(404);
  });

  it('has no booking door', async () => {
    const booking = await exports.default.fetch(new Request('http://local/api/rooms/team/bookings/abcdefgh12345678'));
    expect(booking.status).toBe(404);
    // And no booking *document*, so `/book/team` is not even a page.
    expect(await isAllowedPublicDocument('/book/team', env)).toBe(false);
    expect(await isAllowedPublicDocument('/book/rosa', env)).toBe(true);
  });

  it('still serves the room document, because the shell is not authorization', async () => {
    expect(await isAllowedPublicDocument('/room/team', env)).toBe(true);
    expect(await isAllowedPublicDocument('/room/rosa', env)).toBe(true);
    expect(await isAllowedPublicDocument('/room/nosuchroom', env)).toBe(true);
  });

  it('keeps /team the Team surface; the room is only ever the canonical address', async () => {
    expect(parsePublicRoomPath('/team')).toBeNull();
    expect(await isAllowedPublicDocument('/team', env)).toBe(true);
  });
});

describe('hosting the internal room', () => {
  afterEach(endInternalRoom);

  it('lets any verified member start it', async () => {
    const host = await memberSession();
    const started = await exports.default.fetch(new Request('http://local/api/rooms/team/start', {
      method: 'POST',
      headers: host,
    }));
    expect(started.status).toBe(200);

    // The room is shared: another verified member may take the host and use
    // the same host-control paths while the meeting remains open.
    const other = await memberSession('ada@example.com', 'Ada');
    const resumed = await exports.default.fetch(new Request('http://local/api/rooms/team/start', {
      method: 'POST',
      headers: other,
    }));
    expect(resumed.status).toBe(200);
  });

  it('admits a member without a waiting room once it is live', async () => {
    const host = await memberSession();
    const started = await exports.default.fetch(new Request('http://local/api/rooms/team/start', {
      method: 'POST',
      headers: host,
    }));
    expect(started.status).toBe(200);

    const member = await memberSession('ada@example.com', 'Ada');
    const knock = await exports.default.fetch(new Request('http://local/api/rooms/team/join-requests', {
      method: 'POST',
      headers: { ...member, 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({ name: 'Ada', email: 'ada@example.com' }),
    }));
    expect(knock.status).toBe(201);
    // Admitted on arrival: membership is the admission, so nothing waits.
    await expect(knock.json()).resolves.toMatchObject({ status: 'admitted' });
  });

  it('keeps the call up when the host ends their part, and closes it only for everyone (meet#160)', async () => {
    const deleted: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('RoomService/DeleteRoom')) {
        deleted.push(url);
        return new Response('{}', { status: 200 });
      }
      return realFetch(input, init);
    });
    try {
      const host = await memberSession();
      const start = async () => {
        const started = await exports.default.fetch(new Request('http://local/api/rooms/team/start', { method: 'POST', headers: host }));
        expect(started.status).toBe(200);
        return (await started.json<{ meeting_id: string }>()).meeting_id;
      };
      const end = async (meetingId: string) => exports.default.fetch(new Request(`http://local/api/rooms/team/meetings/${meetingId}/end`, {
        method: 'POST',
        headers: host,
      }));

      // The host leaving: the record ends, the SFU room does not.
      const first = await start();
      const left = await end(first);
      expect(left.status).toBe(200);
      await expect(left.json()).resolves.toMatchObject({ status: 'ended', room_closed: false });
      expect(deleted).toEqual([]);

      // Finalize after leaving does not close it either.
      const finalized = await exports.default.fetch(new Request(`http://local/api/rooms/team/meetings/${first}/finalize`, { method: 'POST', headers: host }));
      expect(finalized.status).toBe(202);
      expect(deleted).toEqual([]);

      // End for everyone: any member may, and the room goes.
      const second = await start();
      const other = await memberSession('ada@example.com', 'Ada');
      const endedForAll = await exports.default.fetch(new Request(`http://local/api/rooms/team/meetings/${second}/end`, {
        method: 'POST',
        headers: { ...other, 'content-type': 'application/json' },
        body: JSON.stringify({ everyone: true }),
      }));
      expect(endedForAll.status).toBe(200);
      await expect(endedForAll.json()).resolves.toMatchObject({ status: 'ended', room_closed: true });
      expect(deleted).toHaveLength(1);

      // A personal room is unchanged: the owner's end drops everyone.
      const own = await exports.default.fetch(new Request('http://local/api/rooms/rosa/start', { method: 'POST', headers: host }));
      expect(own.status).toBe(200);
      const ownId = (await own.json<{ meeting_id: string }>()).meeting_id;
      const ownEnd = await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${ownId}/end`, { method: 'POST', headers: host }));
      await expect(ownEnd.json()).resolves.toMatchObject({ status: 'ended', room_closed: true });
      expect(deleted).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('lets the phone host it by name through the typed owner bootstrap', async () => {
    // iOS hosts through /api/owner/host-session, which used to answer only
    // "my room". A named room is allowed when the owner may host it; the
    // internal room is the case that needs it.
    const host = await memberSession();
    const started = await exports.default.fetch(new Request('http://local/api/owner/host-session', {
      method: 'POST',
      headers: { ...host, 'content-type': 'application/json' },
      body: JSON.stringify({ device: 'iphone', room: 'team' }),
    }));
    expect(started.status).toBe(200);
    await expect(started.json()).resolves.toMatchObject({
      room: { slug: 'team' },
      lease: { renew_after_ms: expect.any(Number) },
    });

    // Somebody else's room, or one that does not exist: the same 404, so the
    // body cannot probe for rooms.
    const other = await memberSession('ada@example.com', 'Ada');
    const foreign = await exports.default.fetch(new Request('http://local/api/owner/host-session', {
      method: 'POST',
      headers: { ...other, 'content-type': 'application/json' },
      body: JSON.stringify({ room: 'rosa' }),
    }));
    expect(foreign.status).toBe(404);
    const unknown = await exports.default.fetch(new Request('http://local/api/owner/host-session', {
      method: 'POST',
      headers: { ...other, 'content-type': 'application/json' },
      body: JSON.stringify({ room: 'nosuchroom' }),
    }));
    expect(unknown.status).toBe(404);
    await expect(foreign.json()).resolves.toEqual(await unknown.json());
  });

  it('does not make the internal room the answer to "my room"', async () => {
    // `/api/owner/room` carries no slug, so it answers with the owner's *own*
    // room. Hosting the internal room as well must never change that answer.
    const host = await memberSession();
    const response = await exports.default.fetch(new Request('http://local/api/owner/room', { headers: host }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ room: { slug: 'rosa' } });
  });
});
