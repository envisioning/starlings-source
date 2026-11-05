import { workStore } from './work-store';

/**
 * A person's Meet id on a D1 workspace (migration 0072, docs/WORKSPACE_STORE.md
 * slice 2). Minted once, the first time the workspace sees the person, and
 * never changed. On a Core workspace this returns null: seeds those
 * ids from Core, so minting one here would be a second id for the same person.
 */
export async function ensurePersonId(env: Env, sub: string): Promise<string | null> {
  if (workStore(env) !== 'd1') return null;
  await env.USAGE.prepare('UPDATE people SET person_id = ?2 WHERE sub = ?1 AND person_id IS NULL')
    .bind(sub, crypto.randomUUID())
    .run();
  const row = await env.USAGE.prepare('SELECT person_id FROM people WHERE sub = ?1')
    .bind(sub)
    .first<{ person_id: string | null }>();
  return row?.person_id ?? null;
}

/** The person id for an address on this workspace, minting one for a known person who has none yet. */
export async function personIdForEmail(env: Env, email: string): Promise<string | null> {
  const row = await env.USAGE.prepare('SELECT sub, person_id FROM people WHERE email = ?1')
    .bind(email.trim().toLowerCase())
    .first<{ sub: string; person_id: string | null }>();
  if (!row) return null;
  return row.person_id ?? ensurePersonId(env, row.sub);
}
