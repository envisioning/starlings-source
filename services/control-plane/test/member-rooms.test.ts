// Rooms in the workspace's D1 (meet#878): slugs from names, clashes, retired
// slugs never reissued, D1 first with OWNER_ROOM_MAP as the fallback, sign-in
// giving a member a room, and revocation retiring it. A room is not admin.
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allocateRoomSlug,
  ensureMemberRoom,
  isPublicRoom,
  publicRooms,
  roomOfMember,
  roomOwnerEmail,
  roomSlugFromName,
  roomSlugVariant,
} from '../src/member-rooms';
import { recordOwnerSignIn } from '../src/usage';
import { bookingRoomFor } from '../src/booking-settings';
import { isOrgAdmin } from '../src/auth';
import { setPersonAccess } from '../src/admin';

const workerEnv = env as Env;
const rosa = { sub: 'google-sub-rosa', email: 'rosa@example.com', name: 'Rosa Ortiz' };
const ana = { sub: 'google-sub-ana', email: 'ana@example.com', name: 'Ana Silva' };
const other = { sub: 'google-sub-ana2', email: 'ana.s@example.org', name: 'Ana Silva' };

afterEach(async () => {
  await workerEnv.USAGE.batch([
    workerEnv.USAGE.prepare('DELETE FROM rooms'),
    workerEnv.USAGE.prepare('DELETE FROM people'),
    workerEnv.USAGE.prepare('DELETE FROM meetings_ledger'),
  ]);
});

async function insertRoom(slug: string, email: string, retiredAt: number | null = null): Promise<void> {
  await workerEnv.USAGE.prepare('INSERT INTO rooms (slug, owner_email, created_at, created_by, retired_at) VALUES (?1, ?2, 1, NULL, ?3)')
    .bind(slug, email, retiredAt).run();
}

describe('room slugs from names', () => {
  it('is first-last, lowercase, diacritics folded', () => {
    expect(roomSlugFromName('Ana Silva', 'a@x.com')).toBe('ana-silva');
    expect(roomSlugFromName('José da Conceição', 'a@x.com')).toBe('jose-conceicao');
    expect(roomSlugFromName('  Zoë   Ørsted-Brandão ', 'a@x.com')).toBe('zoe-brandao');
    expect(roomSlugFromName('Jürgen Straße', 'a@x.com')).toBe('jurgen-strasse');
  });

  it('is the word itself for a one-word name', () => {
    expect(roomSlugFromName('Madonna', 'm@x.com')).toBe('madonna');
  });

  it('falls back to the address, then to room, when the name gives nothing usable', () => {
    expect(roomSlugFromName('', 'joao.pedro@x.com')).toBe('joao-pedro');
    expect(roomSlugFromName('李', 'x@x.com')).toBe('room');
  });

  it('keeps a variant inside the 40-character limit', () => {
    const base = roomSlugFromName(`${'a'.repeat(30)} ${'b'.repeat(30)}`, 'a@x.com');
    expect(base).toHaveLength(40);
    const variant = roomSlugVariant(base, 12);
    expect(variant).toHaveLength(40);
    expect(variant.endsWith('-12')).toBe(true);
    expect(roomSlugVariant('ana-silva', 1)).toBe('ana-silva');
    expect(roomSlugVariant('ana-silva', 2)).toBe('ana-silva-2');
  });
});

describe('allocating a slug', () => {
  it('takes the next variant on a clash', async () => {
    await insertRoom('ana-silva', ana.email);
    expect(await allocateRoomSlug(workerEnv, other)).toBe('ana-silva-2');
    await insertRoom('ana-silva-2', 'someone@example.com');
    expect(await allocateRoomSlug(workerEnv, other)).toBe('ana-silva-3');
  });

  it('never reissues a retired slug to somebody else', async () => {
    await insertRoom('ana-silva', ana.email, 1_000);
    expect(await allocateRoomSlug(workerEnv, other)).toBe('ana-silva-2');
    const slug = await ensureMemberRoom(workerEnv, other);
    expect(slug).toBe('ana-silva-2');
    expect(await roomOwnerEmail(workerEnv, 'ana-silva')).toBeNull();
  });

  it('treats map rooms and slugs with meeting history as taken', async () => {
    expect(await allocateRoomSlug(workerEnv, { name: 'Rosa', email: 'someone@example.com' })).toBe('rosa-2');
    await workerEnv.USAGE.prepare(
      `INSERT INTO meetings_ledger (meeting_id, room_slug, host_email, started_at) VALUES ('m1', 'old-room', 'x@example.com', 1)`,
    ).run();
    expect(await allocateRoomSlug(workerEnv, { name: 'Old Room', email: 'old@example.com' })).toBe('old-room-2');
  });
});

describe('lookup: D1 first, OWNER_ROOM_MAP as the fallback', () => {
  it('resolves a mapped member from the map when D1 has no row (Envisioning as today)', async () => {
    expect(await roomOfMember(workerEnv, rosa.email)).toBe('rosa');
    expect(await roomOfMember(workerEnv, 'rosa@example.org')).toBe('rosa');
    expect(await isPublicRoom(workerEnv, 'rosa')).toBe(true);
    expect(await roomOwnerEmail(workerEnv, 'rosa')).toBe(rosa.email);
    expect(await roomOfMember(workerEnv, ana.email)).toBeNull();
  });

  it('prefers a live D1 row, on any of the member\'s addresses', async () => {
    await insertRoom('ana-silva', ana.email);
    expect(await roomOfMember(workerEnv, ana.email)).toBe('ana-silva');
    expect(await roomOfMember(workerEnv, 'ana@example.org')).toBe('ana-silva');
    expect(await isPublicRoom(workerEnv, 'ana-silva')).toBe(true);
    expect((await publicRooms(workerEnv)).map((room) => room.slug).sort()).toEqual(['ana-silva', 'rosa']);
  });

  it('answers a retired room as no room', async () => {
    await insertRoom('ana-silva', ana.email, 1_000);
    expect(await roomOfMember(workerEnv, ana.email)).toBeNull();
    expect(await isPublicRoom(workerEnv, 'ana-silva')).toBe(false);
  });

  it('keeps the map when D1 cannot be read', async () => {
    const broken = { ...workerEnv, USAGE: { prepare() { throw new Error('d1 down'); } } } as unknown as Env;
    expect(await roomOfMember(broken, rosa.email)).toBe('rosa');
    expect(await isPublicRoom(broken, 'rosa')).toBe(true);
    expect(await isPublicRoom(broken, 'ana-silva')).toBe(false);
  });

  it('serves a D1 room to guests and 404s it once retired', async () => {
    await insertRoom('ana-silva', ana.email);
    expect((await exports.default.fetch(new Request('http://local/api/rooms/ana-silva'))).status).toBe(200);
    await workerEnv.USAGE.prepare('UPDATE rooms SET retired_at = 2 WHERE slug = ?1').bind('ana-silva').run();
    expect((await exports.default.fetch(new Request('http://local/api/rooms/ana-silva'))).status).toBe(404);
  });
});

describe('a member gets a room at sign-in', () => {
  it('creates the room once and writes people.room_slug, so booking finds it', async () => {
    await recordOwnerSignIn(workerEnv, ana, 'web', 1_700_000_000_000);
    await recordOwnerSignIn(workerEnv, ana, 'mac', 1_700_000_100_000);
    const rows = await workerEnv.USAGE.prepare('SELECT slug, owner_email, created_by FROM rooms').all();
    expect(rows.results).toEqual([{ slug: 'ana-silva', owner_email: ana.email, created_by: ana.sub }]);
    const person = await workerEnv.USAGE.prepare('SELECT room_slug FROM people WHERE sub = ?1').bind(ana.sub).first();
    expect(person).toEqual({ room_slug: 'ana-silva' });
    expect(await bookingRoomFor(workerEnv, ana)).toBe('ana-silva');
  });

  it('gives a mapped member no D1 row', async () => {
    await recordOwnerSignIn(workerEnv, rosa, 'web');
    expect((await workerEnv.USAGE.prepare('SELECT COUNT(*) AS n FROM rooms').first<{ n: number }>())?.n).toBe(0);
    expect((await workerEnv.USAGE.prepare('SELECT room_slug FROM people WHERE sub = ?1').bind(rosa.sub).first())).toEqual({ room_slug: 'rosa' });
  });

  it('gives an agent or a revoked person no room', async () => {
    await workerEnv.USAGE.batch([
      workerEnv.USAGE.prepare(`INSERT INTO people (sub, email, name, first_seen_at, last_seen_at, kind) VALUES ('agent:x', 'bot@example.com', 'Bot', 1, 1, 'agent')`),
      workerEnv.USAGE.prepare(`INSERT INTO people (sub, email, name, first_seen_at, last_seen_at, revoked_at) VALUES (?1, ?2, ?3, 1, 1, 5)`).bind(ana.sub, ana.email, ana.name),
    ]);
    expect(await ensureMemberRoom(workerEnv, { sub: 'agent:x', email: 'bot@example.com', name: 'Bot' })).toBeNull();
    expect(await ensureMemberRoom(workerEnv, ana)).toBeNull();
    expect((await workerEnv.USAGE.prepare('SELECT COUNT(*) AS n FROM rooms').first<{ n: number }>())?.n).toBe(0);
  });

  it('gives a restored person their own retired room back', async () => {
    await insertRoom('ana-silva', ana.email, 1_000);
    expect(await ensureMemberRoom(workerEnv, ana)).toBe('ana-silva');
    expect(await isPublicRoom(workerEnv, 'ana-silva')).toBe(true);
  });
});

describe('admin and revocation', () => {
  it('does not make a room owner an admin; people.role does', async () => {
    await recordOwnerSignIn(workerEnv, ana, 'web');
    expect(await roomOfMember(workerEnv, ana.email)).toBe('ana-silva');
    expect(await isOrgAdmin(workerEnv, ana)).toBe(false);
    await workerEnv.USAGE.prepare(`UPDATE people SET role = 'admin' WHERE sub = ?1`).bind(ana.sub).run();
    expect(await isOrgAdmin(workerEnv, ana)).toBe(true);
  });

  it('retires the room when the person is revoked, and the slug is never reissued', async () => {
    await recordOwnerSignIn(workerEnv, ana, 'web');
    await setPersonAccess(workerEnv, rosa, { email: ana.email, revoked: true });
    const row = await workerEnv.USAGE.prepare('SELECT retired_at FROM rooms WHERE slug = ?1').bind('ana-silva').first<{ retired_at: number | null }>();
    expect(row?.retired_at).not.toBeNull();
    expect(await isPublicRoom(workerEnv, 'ana-silva')).toBe(false);
    expect(await ensureMemberRoom(workerEnv, other)).toBe('ana-silva-2');
  });
});
