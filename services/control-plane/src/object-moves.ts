// Moving Envisioning's rooms and Quick Notes into the EU jurisdiction, one
// object at a time (docs/ROOM_JURISDICTION_PLAN.md steps 2 and 3).
//
// A Durable Object cannot change jurisdiction, so a move is a copy into a
// second object. One move: refuse a live room, mark it `moving` in D1, freeze
// the old object, copy its tables into the EU object, export the copy again
// and compare it with the first export, then mark it `moved`. From then on
// `roomStub` and `quickNotesStub` name the EU object (within one minute in
// every isolate). The old object stays, frozen, for 14 days, so a rollback
// can copy back; then `purge` deletes its storage.
//
// Only an admin runs these (POST /api/admin/object-moves), and each act is
// written to `admin_audit` by the route.

import type { ObjectMoveResult, ObjectMoveState, ObjectMoveStatus, RestoreObjectKind } from './contracts';
import { backupKey } from './backups';
import { forgetMoves, jurisdictionSetting, objectCopies, type MoveNamespace } from './do-jurisdiction';
import { ControlError } from './errors';
import { knownRoomSlugs } from './internal-rooms';
import { compareSnapshots, type ObjectSnapshot } from './object-snapshot';

/** How long the old copy is kept, frozen, after a move. */
export const MOVE_KEEP_DAYS = 14;
const DAY_MS = 24 * 60 * 60_000;

interface MoveRow {
  namespace: MoveNamespace;
  name: string;
  state: Exclude<ObjectMoveState, 'legacy'>;
  rows_copied: number | null;
  moved_at: number | null;
  purged_at: number | null;
}

const BACKUP_KIND: Record<MoveNamespace, RestoreObjectKind> = { rooms: 'room', quick_notes: 'quick-notes' };

/**
 * Only a `legacy` workspace moves: its objects go to the EU. A `us` workspace
 * is refused too, as nothing it has may go to the EU.
 */
function assertLegacy(env: Env): void {
  const setting = jurisdictionSetting(env);
  if (setting !== 'legacy') {
    throw new ControlError(`This workspace creates its rooms in the ${setting.toUpperCase()}. Nothing moves.`, 409, 'invalid_request');
  }
}

async function readRow(env: Env, namespace: MoveNamespace, name: string): Promise<MoveRow | null> {
  return env.USAGE.prepare(
    'SELECT namespace, name, state, rows_copied, moved_at, purged_at FROM do_jurisdiction_moves WHERE namespace = ?1 AND name = ?2',
  ).bind(namespace, name).first<MoveRow>();
}

async function writeState(
  env: Env,
  namespace: MoveNamespace,
  name: string,
  state: MoveRow['state'],
  now: number,
  moved?: { rows: number; at: number },
): Promise<void> {
  await env.USAGE.prepare(
    `INSERT INTO do_jurisdiction_moves (namespace, name, state, rows_copied, moved_at, purged_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6)
     ON CONFLICT (namespace, name) DO UPDATE SET
       state = excluded.state,
       rows_copied = COALESCE(excluded.rows_copied, do_jurisdiction_moves.rows_copied),
       moved_at = COALESCE(excluded.moved_at, do_jurisdiction_moves.moved_at),
       purged_at = NULL,
       updated_at = excluded.updated_at`,
  ).bind(namespace, name, state, moved?.rows ?? null, moved?.at ?? null, now).run();
}

/** Every object this workspace has of one kind: the configured rooms, or one inbox per person. */
async function objectNames(env: Env, namespace: MoveNamespace): Promise<string[]> {
  if (namespace === 'rooms') return [...(await knownRoomSlugs(env))].sort();
  const people = await env.USAGE.prepare('SELECT sub FROM people ORDER BY sub').all<{ sub: string }>();
  return people.results.map((row) => row.sub);
}

async function assertKnown(env: Env, namespace: MoveNamespace, name: string): Promise<void> {
  if (namespace === 'rooms' && !(await knownRoomSlugs(env)).has(name)) {
    throw new ControlError('No room with that slug.', 404, 'room_not_found');
  }
  if (namespace === 'quick_notes' && !await env.USAGE.prepare('SELECT sub FROM people WHERE sub = ?1').bind(name).first()) {
    throw new ControlError('No person with that id.', 404, 'person_not_found');
  }
}

function rowCount(snapshot: ObjectSnapshot): number {
  return Object.entries(snapshot.tables)
    .filter(([table]) => !table.startsWith('_'))
    .reduce((sum, [, rows]) => sum + rows.length, 0);
}

/**
 * Copy one object's tables from `from` into `to` and check the copy. `from`
 * is frozen first and stays frozen; `to` takes writes again. Throws when the
 * copy is not the source, naming the tables.
 */
async function copyChecked(
  from: ReturnType<typeof objectCopies>['legacy'],
  to: ReturnType<typeof objectCopies>['legacy'],
): Promise<number> {
  await from.freeze();
  const source = await from.exportState();
  await to.unfreeze();
  await to.importState(source);
  const copy = await to.exportState();
  const mismatches = await compareSnapshots(source, copy);
  if (mismatches.length > 0) {
    const tables = mismatches.map((mismatch) => `${mismatch.table} (${mismatch.sourceRows}→${mismatch.targetRows}${mismatch.rowsDiffer ? ', rows differ' : ''})`);
    throw new Error(`The copy differs from the source: ${tables.join(', ')}.`);
  }
  return rowCount(source);
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : 'The copy failed.';
}

/** Move one object to the EU. An object that moved already is skipped. */
export async function moveObject(env: Env, namespace: MoveNamespace, name: string, now = Date.now()): Promise<ObjectMoveResult> {
  assertLegacy(env);
  await assertKnown(env, namespace, name);
  const row = await readRow(env, namespace, name);
  if (row?.state === 'moved') return { namespace, name, outcome: 'skipped', reason: 'moved already' };
  const copies = objectCopies(env, namespace, name);
  // A move that stopped half way (the Worker was cut off) left the old object
  // frozen. It is still the one in use, so it takes writes again first.
  if (row?.state === 'moving') await copies.legacy.unfreeze();
  const blocker = await copies.legacy.moveBlocker();
  if (blocker) return { namespace, name, outcome: 'skipped', reason: blocker };

  await writeState(env, namespace, name, 'moving', now);
  let rows: number;
  try {
    rows = await copyChecked(copies.legacy, copies.eu);
  } catch (error) {
    await writeState(env, namespace, name, 'rolled_back', now);
    await copies.legacy.unfreeze();
    return { namespace, name, outcome: 'failed', reason: failureReason(error) };
  }
  await writeState(env, namespace, name, 'moved', now, { rows, at: now });
  forgetMoves();
  await copies.legacy.closeSockets('Room moved');
  return { namespace, name, outcome: 'moved', rows };
}

/**
 * Copy one moved object back to its old copy and point the lookups at it
 * again. Only while the old copy exists: until `purge`, 14 days after the
 * move. Writes made to the EU copy after the move come back with it.
 */
export async function rollbackObject(env: Env, namespace: MoveNamespace, name: string, now = Date.now()): Promise<ObjectMoveResult> {
  assertLegacy(env);
  await assertKnown(env, namespace, name);
  const row = await readRow(env, namespace, name);
  if (row?.state !== 'moved') return { namespace, name, outcome: 'skipped', reason: 'not moved' };
  if (row.purged_at !== null) return { namespace, name, outcome: 'skipped', reason: 'the old copy is deleted' };
  const copies = objectCopies(env, namespace, name);
  const blocker = await copies.eu.moveBlocker();
  if (blocker) return { namespace, name, outcome: 'skipped', reason: blocker };

  let rows: number;
  try {
    rows = await copyChecked(copies.eu, copies.legacy);
  } catch (error) {
    await copies.legacy.freeze();
    await copies.eu.unfreeze();
    return { namespace, name, outcome: 'failed', reason: failureReason(error) };
  }
  await writeState(env, namespace, name, 'rolled_back', now);
  forgetMoves();
  await copies.eu.closeSockets('Room moved');
  return { namespace, name, outcome: 'rolled_back', rows };
}

/**
 * Delete the old copy of one moved object: at least 14 days after the move,
 * and only when the backup bucket holds the EU copy from today or yesterday.
 */
export async function purgeObject(env: Env, namespace: MoveNamespace, name: string, now = Date.now()): Promise<ObjectMoveResult> {
  assertLegacy(env);
  const row = await readRow(env, namespace, name);
  if (row?.state !== 'moved' || row.moved_at === null) return { namespace, name, outcome: 'skipped', reason: 'not moved' };
  if (row.purged_at !== null) return { namespace, name, outcome: 'skipped', reason: 'deleted already' };
  const keepUntil = row.moved_at + MOVE_KEEP_DAYS * DAY_MS;
  if (now < keepUntil) {
    return { namespace, name, outcome: 'skipped', reason: `kept until ${new Date(keepUntil).toISOString().slice(0, 10)}` };
  }
  if (!env.BACKUPS) throw new ControlError('The backup bucket is not configured.', 503, 'not_configured');
  const days = [now, now - DAY_MS].map((at) => new Date(at).toISOString().slice(0, 10));
  const backups = await Promise.all(days.map((day) => env.BACKUPS!.head(backupKey(day, BACKUP_KIND[namespace], name))));
  if (!backups.some(Boolean)) return { namespace, name, outcome: 'skipped', reason: 'no backup of the EU copy from today or yesterday' };

  await objectCopies(env, namespace, name).legacy.purge();
  await env.USAGE.prepare('UPDATE do_jurisdiction_moves SET purged_at = ?3, updated_at = ?3 WHERE namespace = ?1 AND name = ?2')
    .bind(namespace, name, now).run();
  return { namespace, name, outcome: 'purged' };
}

/**
 * Run one act on one object, or, with no name, on every object of the kind
 * one after the other. A room moves only by name: each owner room moves at an
 * hour its owner has no meeting.
 */
export async function runObjectMove(
  env: Env,
  action: 'move' | 'rollback' | 'purge',
  namespace: MoveNamespace,
  name: string | undefined,
  now = Date.now(),
): Promise<ObjectMoveResult[]> {
  assertLegacy(env);
  const act = action === 'move' ? moveObject : action === 'rollback' ? rollbackObject : purgeObject;
  if (name) return [await act(env, namespace, name, now)];
  if (action !== 'purge' && namespace === 'rooms') {
    throw new ControlError('Name the room: rooms move one at a time.', 400, 'invalid_request');
  }
  if (action === 'rollback') throw new ControlError('Name the object to roll back.', 400, 'invalid_request');
  const results: ObjectMoveResult[] = [];
  for (const each of await objectNames(env, namespace)) results.push(await act(env, namespace, each, now));
  return results;
}

/** Where every room and inbox of this workspace is now. */
export async function objectMoveStatus(env: Env): Promise<ObjectMoveStatus> {
  const jurisdiction = jurisdictionSetting(env);
  const rows = jurisdiction !== 'legacy'
    ? []
    : (await env.USAGE.prepare('SELECT namespace, name, state, rows_copied, moved_at, purged_at FROM do_jurisdiction_moves').all<MoveRow>()).results;
  const byKey = new Map(rows.map((row) => [`${row.namespace}:${row.name}`, row]));
  const objects: ObjectMoveStatus['objects'] = [];
  for (const namespace of ['rooms', 'quick_notes'] as const) {
    for (const name of await objectNames(env, namespace)) {
      const row = byKey.get(`${namespace}:${name}`);
      objects.push({
        namespace,
        name,
        state: row?.state ?? 'legacy',
        rows_copied: row?.rows_copied ?? null,
        moved_at: row?.moved_at ?? null,
        purged_at: row?.purged_at ?? null,
      });
    }
  }
  return { jurisdiction, objects };
}
