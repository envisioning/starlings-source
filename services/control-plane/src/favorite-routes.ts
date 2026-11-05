import { ControlError } from './errors';
import type { FavoriteRow, FavoriteTarget } from '@starlings/contracts/favorites';
import { clearFavoriteSync, enqueueFavoriteSync, favoriteRowsForMember, subjectKindForFavorite } from './favorite-sync';
import { listCoreFavorites } from './crm';
import { writeSubjectState } from './subject-state';
import { usesCoreFor } from './work-store';

// What the favorites routes share with the subject-state read. Moved out of
// `index.ts` with the CRM routes.

/**
 * Whether a failed favorites write goes to the outbox for Core. Never on a D1
 * workspace: its favorites are its own rows (work-d1.ts), there is no Core to
 * retry, and a D1 failure is an error (docs/WORKSPACE_STORE.md §Fail closed).
 */
export function shouldQueueFavoriteFailure(error: unknown, env: Env): boolean {
  if (!usesCoreFor(env, 'goals')) return false;
  return !(error instanceof ControlError)
    || error.status >= 500
    || [401, 403, 404, 408, 429].includes(error.status);
}

export async function mirrorLegacyFavoriteChange(
  env: Env,
  sub: string,
  target: { kind: string; target_ref: string },
  starred: boolean,
): Promise<void> {
  const legacyKind = subjectKindForFavorite(target.kind);
  if (legacyKind) {
    // Those catalog kinds all use UUID references; Core canonicalizes them to
    // lowercase, and D1's previous routes did too in ordinary client writes.
    await writeSubjectState(env, sub, legacyKind, target.target_ref.toLowerCase(), { starred });
  } else {
    // Core now holds this change; an older queued one must not replay over it.
    await clearFavoriteSync(env, sub, target.kind, target.target_ref);
  }
}

export async function queueFavoriteChange(
  env: Env,
  sub: string,
  target: FavoriteTarget,
  starred: boolean,
): Promise<void> {
  if (subjectKindForFavorite(target.kind)) {
    await mirrorLegacyFavoriteChange(env, sub, target, starred);
  } else {
    await enqueueFavoriteSync(env, sub, target.kind, target.target_ref, starred);
  }
}

export async function sharedFavoriteRows(
  env: Env,
  sub: string,
  email: string,
): Promise<{ favorites: FavoriteRow[]; synced: boolean }> {
  // A D1 workspace's rows are the favorites: no legacy bridge, no outbox.
  if (!usesCoreFor(env, 'goals')) return { favorites: await listCoreFavorites(env, email), synced: true };
  try {
    const rows = await listCoreFavorites(env, email);
    return {
      favorites: await favoriteRowsForMember(env, sub, rows),
      synced: true,
    };
  } catch (error) {
    if (!shouldQueueFavoriteFailure(error, env)) throw error;
    return {
      favorites: await favoriteRowsForMember(env, sub, [], true),
      synced: false,
    };
  }
}
