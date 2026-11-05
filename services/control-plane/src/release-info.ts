// Which release a workspace runs: the commit it was built from and the newest
// D1 migration applied to its database ( step 1). `/api/health` and
// the `OpsService` entrypoint both read it here.
import { BUILD_COMMIT } from './build-info';

export interface ReleaseInfo {
  build: string;
  migration: string | null;
}

/**
 * The highest-numbered migration in wrangler's `d1_migrations` table: the
 * name, not the row id. Two migrations that land out of order are applied
 * out of order (hq applied 0112 before 0111), and the newest row then named
 * 0111 while the release expected 0112, so every deploy failed its smoke
 * check and rolled back. Names are zero-padded, so their order is the
 * numbers' order. Null when D1 does not answer or the table is empty, so a
 * health check never fails on it.
 */
export async function newestMigration(db: D1Database): Promise<string | null> {
  try {
    const row = await db.prepare('SELECT name FROM d1_migrations ORDER BY name DESC LIMIT 1').first<{ name: string }>();
    return row?.name ?? null;
  } catch {
    return null;
  }
}

export async function releaseInfo(env: Pick<Env, 'USAGE'>): Promise<ReleaseInfo> {
  return { build: BUILD_COMMIT, migration: await newestMigration(env.USAGE) };
}
