import type { D1Migration } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[]; AUTH_DB: D1Database; AUTH_TEST_MIGRATIONS: D1Migration[] };

/**
 * `applyD1Migrations` from `cloudflare:test`, in one batch instead of one per
 * migration. Every test file starts on empty storage and replays all of them,
 * and a batch is a round trip into the D1 runtime: one per migration made
 * this setup most of the suite's time (about 7s per file, 2026-10-10). The
 * end state is the same: the same statements in the same order, and one
 * `d1_migrations` row per migration name (ops-console and release-info read
 * them).
 */
async function applyMigrations(db: D1Database, migrations: D1Migration[]): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  );`).run();
  const applied = new Set((await db.prepare('SELECT name FROM d1_migrations;').all<{ name: string }>()).results.map(({ name }) => name));
  const record = db.prepare('INSERT INTO d1_migrations (name) VALUES (?);');
  const statements = migrations
    .filter((migration) => !applied.has(migration.name))
    .flatMap((migration) => [...migration.queries.map((query) => db.prepare(query)), record.bind(migration.name)]);
  if (statements.length > 0) await db.batch(statements);
}

await applyMigrations(testEnv.USAGE, testEnv.TEST_MIGRATIONS);
// The starlings-auth Worker's own D1 (wrangler.auth.jsonc).
await applyMigrations(testEnv.AUTH_DB, testEnv.AUTH_TEST_MIGRATIONS);
