// Where a Durable Object lives (#1164, docs/ROOM_JURISDICTION_PLAN.md).
//
// A workspace has one data region, `eu` or `us`, set by `DO_JURISDICTION`
// when the workspace is created. Threads, rooms and Quick Notes follow it:
// an `eu` object is pinned to the EU jurisdiction, and a `us` object is
// placed with a location hint, because Cloudflare has no US jurisdiction
// (packages/contracts/src/workspace-region.ts).
// `legacy` is Envisioning until its rooms and Quick Notes have moved: its
// threads are `eu`, and D1 `do_jurisdiction_moves` says which rooms and
// inboxes have moved already (object-moves.ts). Every room and Quick Notes
// lookup goes through `roomStub` and `quickNotesStub`;
// test/do-jurisdiction.test.ts refuses a direct `getByName` on those two
// namespaces anywhere else.

import { REGION_PLACEMENT } from '@starlings/contracts/workspace-region';
import type { QuickNotesCoordinator } from './quick-notes';
import type { RoomCoordinator } from './room-coordinator';

/** A workspace's data region: where its objects live. */
export type DataRegion = 'eu' | 'us';

/** `DO_JURISDICTION`, parsed. wrangler types the var from today's values only. */
export type JurisdictionSetting = DataRegion | 'legacy';

/**
 * The workspace's `DO_JURISDICTION`. Production fails closed on any other
 * value: a guess would create objects in the wrong region, and they cannot
 * move afterwards. Off production an unset or unknown value is `legacy`, which
 * is what every value but `eu` meant before `us` existed.
 */
export function jurisdictionSetting(env: Pick<Env, 'ENVIRONMENT' | 'DO_JURISDICTION'>): JurisdictionSetting {
  const value = String(env.DO_JURISDICTION ?? '');
  if (value === 'eu' || value === 'us' || value === 'legacy') return value;
  if (String(env.ENVIRONMENT) === 'production') {
    throw new Error(`DO_JURISDICTION is "${value}". It must be eu, us or legacy.`);
  }
  return 'legacy';
}

/** Where this workspace's threads live: `us` for a US workspace, else `eu` (Envisioning's threads are EU already). */
export function threadRegion(env: Pick<Env, 'ENVIRONMENT' | 'DO_JURISDICTION'>): DataRegion {
  return jurisdictionSetting(env) === 'us' ? 'us' : 'eu';
}

/**
 * An object in one region: pinned to the region's jurisdiction, or placed with
 * its location hint where Cloudflare has no jurisdiction (`us`). A Durable
 * Object cannot move after it exists, so this has to be right from the first
 * request. workerd (local dev and the tests) does not implement
 * jurisdictions; falling back keeps both runnable. Production never takes the
 * fallback: silently unpinning is the failure this exists to prevent, and it
 * would be invisible. The ids differ, so a local object is not a deployed one.
 */
export function jurisdictionStub<T extends Rpc.DurableObjectBranded | undefined>(
  namespace: DurableObjectNamespace<T>,
  name: string,
  region: DataRegion,
  env: Pick<Env, 'ENVIRONMENT'>,
  localName = name,
): DurableObjectStub<T> {
  const { jurisdiction, location } = REGION_PLACEMENT[region];
  if (!jurisdiction) {
    return namespace.get(namespace.idFromName(name), location ? { locationHint: location } : undefined);
  }
  try {
    const pinned = namespace.jurisdiction(jurisdiction);
    return pinned.get(pinned.idFromName(name));
  } catch (error) {
    if (String(env.ENVIRONMENT) === 'production') throw error;
    return namespace.getByName(localName);
  }
}

export type MoveNamespace = 'rooms' | 'quick_notes';

type StubEnv = Pick<Env, 'ENVIRONMENT' | 'DO_JURISDICTION' | 'USAGE'>;

/** How long one isolate trusts its read of `do_jurisdiction_moves`. */
export const MOVE_CACHE_MS = 60_000;

let moveCache: { at: number; moved: Set<string> } | null = null;

const moveKey = (namespace: MoveNamespace, name: string) => `${namespace}:${name}`;

/** Forget the cached read: the isolate that writes a switch, and tests. */
export function forgetMoves(): void {
  moveCache = null;
}

/**
 * The objects of a `legacy` workspace that live in the EU now. One read of
 * the whole table per isolate per minute: it has one row per room and per
 * person. When D1 fails, a read that is too old still answers, as the table
 * changes only when an admin moves an object. With no read at all the lookup
 * fails: guessing the old object would answer from a frozen copy.
 */
async function movedObjects(env: StubEnv, now = Date.now()): Promise<Set<string>> {
  if (moveCache && now - moveCache.at < MOVE_CACHE_MS) return moveCache.moved;
  try {
    const rows = await env.USAGE.prepare(
      "SELECT namespace, name FROM do_jurisdiction_moves WHERE state = 'moved'",
    ).all<{ namespace: MoveNamespace; name: string }>();
    moveCache = { at: now, moved: new Set(rows.results.map((row) => moveKey(row.namespace, row.name))) };
    return moveCache.moved;
  } catch (error) {
    if (moveCache) return moveCache.moved;
    throw error;
  }
}

/**
 * The EU copy of an object that moved. In production it is the same object
 * an `eu` workspace names, so setting Envisioning to `eu` after the last move (plan
 * step 4) changes nothing. Off production, where both paths fall back to a
 * plain object, it takes another name, so a move in the tests copies into a
 * second object, not onto itself.
 */
export function movedStub<T extends Rpc.DurableObjectBranded | undefined>(
  namespace: DurableObjectNamespace<T>,
  name: string,
  env: Pick<Env, 'ENVIRONMENT'>,
): DurableObjectStub<T> {
  return jurisdictionStub(namespace, name, 'eu', env, `eu:${name}`);
}

/** Both copies of one object, for the move job. */
export function objectCopies(env: Pick<Env, 'ROOMS' | 'QUICK_NOTES' | 'ENVIRONMENT'>, namespace: MoveNamespace, name: string) {
  if (namespace === 'rooms') {
    return { legacy: env.ROOMS.getByName(name), eu: movedStub(env.ROOMS, name, env) };
  }
  const key = `owner:${name}`;
  return { legacy: env.QUICK_NOTES.getByName(key), eu: movedStub(env.QUICK_NOTES, key, env) };
}

export async function roomStub(env: Pick<Env, 'ROOMS'> & StubEnv, slug: string): Promise<DurableObjectStub<RoomCoordinator>> {
  const setting = jurisdictionSetting(env);
  if (setting !== 'legacy') return jurisdictionStub(env.ROOMS, slug, setting, env);
  if ((await movedObjects(env)).has(moveKey('rooms', slug))) return movedStub(env.ROOMS, slug, env);
  return env.ROOMS.getByName(slug);
}

export async function quickNotesStub(
  env: Pick<Env, 'QUICK_NOTES'> & StubEnv,
  ownerSub: string,
): Promise<DurableObjectStub<QuickNotesCoordinator>> {
  const name = `owner:${ownerSub}`;
  const setting = jurisdictionSetting(env);
  if (setting !== 'legacy') return jurisdictionStub(env.QUICK_NOTES, name, setting, env);
  if ((await movedObjects(env)).has(moveKey('quick_notes', ownerSub))) return movedStub(env.QUICK_NOTES, name, env);
  return env.QUICK_NOTES.getByName(name);
}
