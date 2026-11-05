// Moving rooms and Quick Notes into the EU jurisdiction (meet#312,
// docs/ROOM_JURISDICTION_PLAN.md steps 2 and 3): a move copies every row and
// points the lookups at the copy, a frozen object refuses writes with a 503,
// a rollback brings writes made after the move back, and the old copy is
// deleted only 14 days on with a fresh backup. workerd has no jurisdictions,
// so the EU copy is the object `eu:<name>` here (`movedStub`).
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import type { AmbientMeetingResponse, ObjectMoveResponse } from '@starlings/contracts';
import { backupKey } from '../src/backups';
import { forgetMoves, objectCopies, quickNotesStub, roomStub } from '../src/do-jurisdiction';
import { moveObject, purgeObject, rollbackObject, runObjectMove } from '../src/object-moves';
import { compareSnapshots, type ObjectSnapshot } from '../src/object-snapshot';

async function session(email: string, name = 'Ada') {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email }),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json', origin: env.WEB_ORIGIN };
}

/** An ended meeting in `rosa`, through the route, so it lands wherever `roomStub` points. */
async function endedMeeting(title: string): Promise<Response> {
  const headers = await session('rosa@example.com', 'Rosa');
  return exports.default.fetch(new Request('http://local/api/rooms/rosa/meetings/ambient', {
    method: 'POST',
    headers,
    body: JSON.stringify({ started_at: '2026-09-16T09:00:00.000Z', ended_at: '2026-09-16T09:40:00.000Z', title }),
  }));
}

/**
 * The error a call to a Durable Object rejects with. `expect(...).rejects` on
 * an RPC promise leaves a second, unhandled rejection behind in workerd.
 */
async function rejection(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'resolved';
}

const titles = (snapshot: ObjectSnapshot) => (snapshot.tables.meetings ?? []).map((row) => row.title);

afterEach(async () => {
  await env.USAGE.prepare('DELETE FROM do_jurisdiction_moves').run();
  forgetMoves();
  const copies = objectCopies(env, 'rooms', 'rosa');
  await copies.legacy.unfreeze();
  await copies.eu.unfreeze();
});

describe('moving a room', () => {
  it('copies every row, points the lookup at the copy, and freezes the old one', async () => {
    expect((await endedMeeting('Before the move')).status).toBe(201);
    const copies = objectCopies(env, 'rooms', 'rosa');
    const before = await copies.legacy.exportState();

    const result = await moveObject(env, 'rooms', 'rosa');
    expect(result).toMatchObject({ outcome: 'moved' });
    expect(result.rows).toBeGreaterThan(0);
    expect(await compareSnapshots(before, await copies.eu.exportState())).toEqual([]);

    // The route now writes into the copy, and the old object takes no write.
    expect((await endedMeeting('After the move')).status).toBe(201);
    expect(titles(await copies.eu.exportState())).toContain('After the move');
    expect(titles(await copies.legacy.exportState())).not.toContain('After the move');
    expect(await rejection(copies.legacy.importState(before))).toMatch(/object_moving/u);

    const row = await env.USAGE.prepare("SELECT state, rows_copied FROM do_jurisdiction_moves WHERE namespace = 'rooms' AND name = 'rosa'").first();
    expect(row).toEqual({ state: 'moved', rows_copied: result.rows });
    expect(await moveObject(env, 'rooms', 'rosa')).toMatchObject({ outcome: 'skipped', reason: 'moved already' });
  });

  it('answers a write to a frozen room with a 503', async () => {
    await objectCopies(env, 'rooms', 'rosa').legacy.freeze();
    const response = await endedMeeting('While frozen');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'This room is moving. Try again in a minute.' });
  });

  it('rolls back with the writes made after the move', async () => {
    await endedMeeting('Before the move');
    await moveObject(env, 'rooms', 'rosa');
    const created = await (await endedMeeting('Written in the EU')).json<AmbientMeetingResponse>();

    expect(await rollbackObject(env, 'rooms', 'rosa')).toMatchObject({ outcome: 'rolled_back' });
    const copies = objectCopies(env, 'rooms', 'rosa');
    expect(titles(await copies.legacy.exportState())).toContain('Written in the EU');
    // The lookup is the old object again, and it takes writes; the EU copy does not.
    const room = await roomStub(env, 'rosa');
    expect(await room.isEnded(created.meeting_id)).toBe(true);
    expect((await endedMeeting('After the rollback')).status).toBe(201);
    expect(titles(await copies.legacy.exportState())).toContain('After the rollback');
    const legacyNow = await copies.legacy.exportState();
    expect(await rejection(copies.eu.importState(legacyNow))).toMatch(/object_moving/u);
  });

  it('refuses a room move without a name, and a room the workspace does not have', async () => {
    await expect(runObjectMove(env, 'move', 'rooms', undefined)).rejects.toThrow(/one at a time/u);
    await expect(moveObject(env, 'rooms', 'nobody')).rejects.toThrow(/No room/u);
  });

  it('moves nothing in a workspace that starts in the EU or the US', async () => {
    await expect(moveObject({ ...env, DO_JURISDICTION: 'eu' } as Env, 'rooms', 'rosa')).rejects.toThrow(/Nothing moves/u);
    // A US workspace is not legacy: nothing of it may go to the EU.
    await expect(moveObject({ ...env, DO_JURISDICTION: 'us' } as unknown as Env, 'rooms', 'rosa')).rejects.toThrow(/in the US\. Nothing moves/u);
  });
});

describe('deleting the old copy', () => {
  it('waits 14 days and needs a backup of the EU copy from today or yesterday', async () => {
    await endedMeeting('Before the move');
    const movedAt = Date.parse('2038-01-01T12:00:00Z');
    await moveObject(env, 'rooms', 'rosa', movedAt);

    expect(await purgeObject(env, 'rooms', 'rosa', movedAt + 13 * 86_400_000))
      .toMatchObject({ outcome: 'skipped', reason: 'kept until 2038-01-15' });
    const later = movedAt + 15 * 86_400_000;
    expect(await purgeObject(env, 'rooms', 'rosa', later))
      .toMatchObject({ outcome: 'skipped', reason: 'no backup of the EU copy from today or yesterday' });

    await env.BACKUPS.put(backupKey('2038-01-16', 'room', 'rosa'), '{}');
    expect(await purgeObject(env, 'rooms', 'rosa', later)).toMatchObject({ outcome: 'purged' });
    const old = await objectCopies(env, 'rooms', 'rosa').legacy.exportState();
    expect(Object.values(old.tables).flat()).toEqual([]);
    expect(await rollbackObject(env, 'rooms', 'rosa')).toMatchObject({ outcome: 'skipped', reason: 'the old copy is deleted' });
  });
});

describe('moving Quick Notes', () => {
  it('moves every inbox in one run, through the admin route', async () => {
    const sub = `sub-move-${crypto.randomUUID()}`;
    await env.USAGE.prepare(`INSERT INTO people (sub, email, name, first_seen_at, last_seen_at) VALUES (?1, ?2, 'Ana', 1, 1)`)
      .bind(sub, `${sub}@example.com`).run();
    const legacy = objectCopies(env, 'quick_notes', sub).legacy;
    const stored = await legacy.fetch('https://quick-notes/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Moves along', source: 'home' }),
    });
    expect(stored.status).toBe(201);

    const headers = await session('rosa@example.com', 'Rosa');
    const response = await exports.default.fetch(new Request('http://local/api/admin/object-moves', {
      method: 'POST', headers, body: JSON.stringify({ action: 'move', namespace: 'quick_notes' }),
    }));
    expect(response.status).toBe(200);
    const { results } = await response.json<ObjectMoveResponse>();
    expect(results).toContainEqual({ namespace: 'quick_notes', name: sub, outcome: 'moved', rows: 1 });

    const notes = await (await quickNotesStub(env, sub)).fetch('https://quick-notes/notes');
    expect((await notes.json<{ notes: Array<{ body: string }> }>()).notes.map((note) => note.body)).toEqual(['Moves along']);
    const refused = await legacy.fetch('https://quick-notes/notes', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'Too late', source: 'home' }),
    });
    expect(refused.status).toBe(503);
  });
});

describe('compareSnapshots', () => {
  const snapshot = (rows: Array<Record<string, string | number | null>>, extra: ObjectSnapshot['tables'] = {}): ObjectSnapshot => ({
    version: 1, exported_at: 0, tables: { meetings: rows, _sql_schema_migrations: [{ id: 1 }], ...extra },
  });

  it('ignores row order, column order, bookkeeping, and columns the target dropped', async () => {
    const source = snapshot([{ id: 'a', title: 'One', old_column: 'x' }, { id: 'b', title: 'Two', old_column: 'y' }]);
    const target = snapshot([{ title: 'Two', id: 'b' }, { title: 'One', id: 'a' }]);
    target.tables._sql_schema_migrations = [];
    expect(await compareSnapshots(source, target)).toEqual([]);
  });

  it('names a table whose rows differ or whose count differs', async () => {
    const source = snapshot([{ id: 'a', title: 'One' }], { lines: [{ id: 1 }] });
    const target = snapshot([{ id: 'a', title: 'Changed' }], { lines: [] });
    expect(await compareSnapshots(source, target)).toEqual([
      { table: 'lines', sourceRows: 1, targetRows: 0, rowsDiffer: false },
      { table: 'meetings', sourceRows: 1, targetRows: 1, rowsDiffer: true },
    ]);
  });
});
