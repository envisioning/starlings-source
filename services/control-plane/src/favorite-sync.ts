import type {
  FavoriteMigrationStatusResponse,
  FavoriteRow,
  FavoriteTarget,
  SubjectStateResponse,
} from '@starlings/contracts';
import { LEGACY_SUBJECT_FAVORITE_KINDS } from '@starlings/contracts/favorites';
import { ControlError } from './errors';
import { addCoreFavorite, removeCoreFavorite } from './crm';

const SUBJECT_KIND_TO_FAVORITE = {
  lead: 'crm.lead',
  project: 'crm.project',
  organization: 'crm.partner',
  event: 'cms.event',
} as const;

const FAVORITE_TO_SUBJECT_KIND = {
  'crm.lead': 'lead',
  'crm.project': 'project',
  'crm.partner': 'organization',
  'cms.event': 'event',
} as const;

type LegacySubjectKind = keyof typeof SUBJECT_KIND_TO_FAVORITE;
type LegacyFavoriteKind = (typeof LEGACY_SUBJECT_FAVORITE_KINDS)[number];

interface LegacyStarRow {
  kind: LegacySubjectKind;
  subject_id: string;
  updated_at: number;
}

interface FavoriteSyncRow {
  id: number;
  sub: string;
  kind: string;
  target_ref: string;
  starred: number;
  created_at: number;
  attempts: number;
}

interface PendingFavoriteRow extends FavoriteSyncRow {
  last_error_code: string | null;
}

interface DueFavoriteSyncRow extends FavoriteSyncRow {
  /** Core signs in by email; the queue is keyed by `sub`. Null once the person is gone. */
  email: string | null;
}

/**
 * Core refused the target itself (it does not exist, or its ref is not one
 * Core reads). Retrying cannot fix that, so after a few tries the row goes.
 * A missing Core account is the member's to fix and stays queued.
 */
const REJECTED_TARGET_STATUSES = new Set([400, 404, 410, 422]);
const REJECTED_TARGET_ATTEMPTS = 5;

/** Bounds what one member's pending overlay reads on every favorites read. */
const PENDING_OVERLAY_LIMIT = 500;

function key(kind: string, targetRef: string): string {
  return `${kind}:${targetRef}`;
}

export function favoriteKindForSubject(kind: LegacySubjectKind): LegacyFavoriteKind {
  return SUBJECT_KIND_TO_FAVORITE[kind];
}

export function subjectKindForFavorite(kind: string): LegacySubjectKind | null {
  return Object.hasOwn(FAVORITE_TO_SUBJECT_KIND, kind)
    ? FAVORITE_TO_SUBJECT_KIND[kind as LegacyFavoriteKind]
    : null;
}

export function legacySubjectStarKeys(rows: FavoriteRow[]): Array<{ kind: LegacySubjectKind; id: string }> {
  return rows.flatMap((row) => {
    const kind = subjectKindForFavorite(row.kind);
    return kind ? [{ kind, id: row.target_ref.toLowerCase() }] : [];
  });
}

/** During cutover, Core owns star bits while D1 continues to own mutes. */
export function subjectStateWithSharedStars(
  state: SubjectStateResponse,
  rows: FavoriteRow[],
): SubjectStateResponse {
  const states = new Map<string, SubjectStateResponse['states'][number]>();
  for (const row of state.states) {
    if (row.muted) states.set(`${row.kind}:${row.id.toLowerCase()}`, { ...row, starred: false });
  }
  for (const favorite of rows) {
    const kind = subjectKindForFavorite(favorite.kind);
    if (!kind) continue;
    const id = favorite.target_ref.toLowerCase();
    const identity = `${kind}:${id}`;
    const current = states.get(identity);
    states.set(identity, {
      kind,
      id,
      starred: true,
      muted: current?.muted ?? false,
      updated_at: Date.parse(favorite.created_at) || current?.updated_at || Date.now(),
    });
  }
  return { ...state, states: [...states.values()] };
}

/** Save a legacy star mutation atomically with its retryable Core write. */
export async function enqueueFavoriteSync(
  env: Env,
  sub: string,
  kind: string,
  targetRef: string,
  starred: boolean,
  createdAt = Date.now(),
): Promise<void> {
  await env.USAGE.batch(favoriteSyncStatements(env, sub, kind, targetRef, starred, createdAt));
}

/**
 * The latest change for a target wins: queue it in place of any older
 * change, so a retried star can never land after a newer unstar.
 */
export function favoriteSyncStatements(
  env: Env,
  sub: string,
  kind: string,
  targetRef: string,
  starred: boolean,
  createdAt: number,
): D1PreparedStatement[] {
  return [
    clearFavoriteSyncStatement(env, sub, kind, targetRef),
    env.USAGE.prepare(
      `INSERT INTO favorite_sync_queue
        (sub, kind, target_ref, starred, created_at, next_attempt_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 0)`,
    ).bind(sub, kind, targetRef, starred ? 1 : 0, createdAt),
  ];
}

function clearFavoriteSyncStatement(env: Env, sub: string, kind: string, targetRef: string): D1PreparedStatement {
  return env.USAGE.prepare(
    'DELETE FROM favorite_sync_queue WHERE sub = ?1 AND kind = ?2 AND target_ref = ?3',
  ).bind(sub, kind, targetRef);
}

/** A direct Core write succeeded, so any older queued change for the target is stale. */
export async function clearFavoriteSync(env: Env, sub: string, kind: string, targetRef: string): Promise<void> {
  await clearFavoriteSyncStatement(env, sub, kind, targetRef).run();
}

/** Local legacy rows are a read bridge until the owner completes cutover. */
export async function legacyFavoriteRows(env: Env, sub: string): Promise<FavoriteRow[]> {
  const { results } = await env.USAGE.prepare(
    `SELECT kind, subject_id, updated_at FROM subject_state
     WHERE sub = ?1 AND starred = 1 ORDER BY updated_at DESC, kind, subject_id`,
  ).bind(sub).all<LegacyStarRow>();
  return (results ?? []).map((row) => ({
    kind: SUBJECT_KIND_TO_FAVORITE[row.kind],
    target_ref: row.subject_id.toLowerCase(),
    created_at: new Date(row.updated_at).toISOString(),
  }));
}

/** Bridge legacy stars until cutover; Core rows win when both sources contain a key. */
export async function favoriteRowsForMember(
  env: Env,
  sub: string,
  sharedRows: FavoriteRow[],
  includeLegacy = env.FAVORITES_READS_FROM_CORE !== 'true',
): Promise<FavoriteRow[]> {
  const rows = new Map(sharedRows.map((row) => [key(row.kind, row.target_ref), row]));
  if (includeLegacy) {
    for (const row of await legacyFavoriteRows(env, sub)) {
      const identity = key(row.kind, row.target_ref);
      if (!rows.has(identity)) rows.set(identity, row);
    }
  }
  return applyPendingFavoriteChanges(env, sub, [...rows.values()]);
}

/** Pending changes layer over both sources so a queued unstar hides old data. */
export async function applyPendingFavoriteChanges(
  env: Env,
  sub: string,
  sourceRows: FavoriteRow[],
): Promise<FavoriteRow[]> {
  const { results } = await env.USAGE.prepare(
    `SELECT id, sub, kind, target_ref, starred, created_at, attempts
       FROM favorite_sync_queue WHERE sub = ?1 ORDER BY id LIMIT ?2`,
  ).bind(sub, PENDING_OVERLAY_LIMIT).all<FavoriteSyncRow>();
  const rows = new Map(sourceRows.map((row) => [key(row.kind, row.target_ref), row]));
  for (const change of results ?? []) {
    const identity = key(change.kind, change.target_ref);
    if (change.starred === 1) {
      if (!rows.has(identity)) {
        rows.set(identity, {
          kind: change.kind,
          target_ref: change.target_ref,
          created_at: new Date(change.created_at).toISOString(),
        });
      }
    } else {
      rows.delete(identity);
    }
  }
  return [...rows.values()].sort((left, right) => {
    const timeDifference = Date.parse(right.created_at) - Date.parse(left.created_at);
    return timeDifference || left.kind.localeCompare(right.kind) || left.target_ref.localeCompare(right.target_ref);
  });
}

/** Drain a bounded page; one bad/unmapped owner backs off without blocking others. */
export async function drainFavoriteSyncQueue(
  env: Env,
  now = Date.now(),
  limit = 25,
): Promise<{ attempted: number; synced: number; deferred: number }> {
  // A row with a newer row for the same target is superseded: queues written
  // before the latest-wins rule can still hold more than one per target.
  const { results } = await env.USAGE.prepare(
    `SELECT q.id, q.sub, q.kind, q.target_ref, q.starred, q.created_at, q.attempts, p.email,
            EXISTS (
              SELECT 1 FROM favorite_sync_queue newer
               WHERE newer.sub = q.sub AND newer.kind = q.kind
                 AND newer.target_ref = q.target_ref AND newer.id > q.id
            ) AS superseded
       FROM favorite_sync_queue q
       LEFT JOIN people p ON p.sub = q.sub
      WHERE q.next_attempt_at <= ?1 ORDER BY q.id LIMIT ?2`,
  ).bind(now, limit).all<DueFavoriteSyncRow & { superseded: number }>();
  let synced = 0;
  let deferred = 0;
  for (const row of results ?? []) {
    if (row.superseded) {
      await env.USAGE.prepare('DELETE FROM favorite_sync_queue WHERE id = ?1').bind(row.id).run();
      continue;
    }
    const target: FavoriteTarget = { kind: row.kind as FavoriteTarget['kind'], target_ref: row.target_ref };
    let code: string;
    let rejected = false;
    if (row.email) {
      try {
        if (row.starred === 1) await addCoreFavorite(env, row.email, target);
        else await removeCoreFavorite(env, row.email, target);
        await env.USAGE.prepare('DELETE FROM favorite_sync_queue WHERE id = ?1').bind(row.id).run();
        synced += 1;
        continue;
      } catch (error) {
        code = error instanceof ControlError
          ? error.code ?? `upstream_${error.status}`
          : 'upstream_unavailable';
        rejected = error instanceof ControlError
          && REJECTED_TARGET_STATUSES.has(error.status)
          && error.code !== 'core_account_missing';
      }
    } else {
      code = 'owner_not_found';
    }
    const attempts = row.attempts + 1;
    if (rejected && attempts >= REJECTED_TARGET_ATTEMPTS) {
      await env.USAGE.prepare('DELETE FROM favorite_sync_queue WHERE id = ?1').bind(row.id).run();
      deferred += 1;
      continue;
    }
    const delay = Math.min(86_400_000, 30_000 * 2 ** Math.min(attempts - 1, 11));
    await env.USAGE.prepare(
      `UPDATE favorite_sync_queue SET attempts = ?2, last_error_code = ?3, next_attempt_at = ?4
       WHERE id = ?1`,
    ).bind(row.id, attempts, code, now + delay).run();
    deferred += 1;
  }
  return { attempted: results?.length ?? 0, synced, deferred };
}

/**
 * Compare the authenticated member's D1 legacy counts to Core and expose only
 * error codes/counts for this member. This is the manual pre-cutover check.
 */
export async function favoriteMigrationStatus(
  env: Env,
  sub: string,
  sharedRows: FavoriteRow[],
  sharedAvailable = true,
): Promise<FavoriteMigrationStatusResponse> {
  const [legacy, queue] = await Promise.all([
    env.USAGE.prepare(
      `SELECT kind, COUNT(*) AS count FROM subject_state
       WHERE sub = ?1 AND starred = 1 GROUP BY kind`,
    ).bind(sub).all<{ kind: LegacySubjectKind; count: number }>(),
    env.USAGE.prepare(
      `SELECT kind, target_ref, last_error_code, attempts FROM favorite_sync_queue
       WHERE sub = ?1 AND last_error_code IS NOT NULL ORDER BY id LIMIT 200`,
    ).bind(sub).all<{ kind: string; target_ref: string; last_error_code: string; attempts: number }>(),
  ]);
  const legacyCounts = new Map((legacy.results ?? []).map((row) => [SUBJECT_KIND_TO_FAVORITE[row.kind], row.count]));
  const pendingCounts = new Map<LegacyFavoriteKind, number>();
  for (const row of (await env.USAGE.prepare(
    `SELECT kind, COUNT(*) AS count FROM favorite_sync_queue
     WHERE sub = ?1 GROUP BY kind`,
  ).bind(sub).all<{ kind: string; count: number }>()).results ?? []) {
    if (subjectKindForFavorite(row.kind)) pendingCounts.set(row.kind as LegacyFavoriteKind, row.count);
  }
  const sharedCounts = new Map<LegacyFavoriteKind, number>();
  for (const row of sharedRows) {
    if (subjectKindForFavorite(row.kind)) {
      const kind = row.kind as LegacyFavoriteKind;
      sharedCounts.set(kind, (sharedCounts.get(kind) ?? 0) + 1);
    }
  }
  return {
    shared_available: sharedAvailable,
    by_kind: LEGACY_SUBJECT_FAVORITE_KINDS.map((kind) => ({
      kind,
      legacy_count: legacyCounts.get(kind) ?? 0,
      shared_count: sharedCounts.get(kind) ?? 0,
      pending_count: pendingCounts.get(kind) ?? 0,
    })),
    unresolved: (queue.results ?? []).map((row) => ({
      kind: row.kind,
      target_ref: row.target_ref,
      code: row.last_error_code,
      attempts: row.attempts,
    })),
  };
}
