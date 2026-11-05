// Keep's door for the platform operator console (`starlings-ops` on
// the ops host, in the meet repo: docs/OPS_CONSOLE.md). The console
// calls `OpsService` over a service binding. The entrypoint has no URL and no
// route, so nothing on the internet reaches it.
//
// Counts and times only. Never a vault name, an item name, an address, a
// wrap or a ciphertext. The shape matches `opsServiceMetadataSchema` in
// meet's packages/contracts/src/ops.ts; the console parses it again on its
// side.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';

const opsServiceMetadataSchema = z.object({
  service: z.literal('keep'),
  migration: z.string().nullable(),
  counts: z.array(z.object({ label: z.string().min(1).max(40), value: z.number().int().nonnegative() }).strict()).max(24),
  last_activity_at: z.number().nullable(),
}).strict();
export type OpsServiceMetadata = z.infer<typeof opsServiceMetadataSchema>;

const DAY_MS = 86_400_000;

const COUNTS: [label: string, sql: string][] = [
  ['Vaults', 'SELECT COUNT(*) AS n FROM vaults'],
  ['Items', 'SELECT COUNT(*) AS n FROM items'],
  ['People with access', 'SELECT COUNT(DISTINCT m.email) AS n FROM vault_members m JOIN vaults v ON v.id = m.vault_id WHERE v.machine = 0'],
  ['Machine vaults', 'SELECT COUNT(*) AS n FROM vaults WHERE machine = 1'],
  ['Enrolled staff', 'SELECT COUNT(*) AS n FROM staff_keys'],
  ['Active devices', 'SELECT COUNT(*) AS n FROM device_tokens WHERE revoked_at IS NULL AND expires_at > ?1'],
  ['Reveals, 7 days', "SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'item.reveal' AND created_at >= ?2"],
  ['Recovery key set', 'SELECT COUNT(*) AS n FROM recovery_key'],
];

/** The metadata `OpsService` returns, parsed before it leaves. */
export async function keepOpsMetadata(env: Pick<Env, 'DB'>, now = new Date()): Promise<OpsServiceMetadata> {
  const iso = now.toISOString();
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const bind = (sql: string) => {
    const statement = env.DB.prepare(sql);
    if (sql.includes('?2')) return statement.bind(iso, weekAgo);
    if (sql.includes('?1')) return statement.bind(iso);
    return statement;
  };
  const statements = [
    ...COUNTS.map(([, sql]) => bind(sql)),
    env.DB.prepare('SELECT MAX(created_at) AS at FROM audit_events'),
    env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1'),
  ];
  let results: D1Result[] | null = null;
  try {
    results = await env.DB.batch(statements);
  } catch {
    results = null;
  }
  const first = (index: number) => results?.[index]?.results?.[0] as Record<string, unknown> | undefined;
  const at = first(COUNTS.length)?.at;
  const parsed = typeof at === 'string' ? Date.parse(at) : Number.NaN;
  const migration = first(COUNTS.length + 1)?.name;
  return opsServiceMetadataSchema.parse({
    service: 'keep',
    migration: typeof migration === 'string' ? migration : null,
    counts: results ? COUNTS.map(([label], index) => ({ label, value: Number(first(index)?.n ?? 0) })) : [],
    last_activity_at: Number.isFinite(parsed) ? parsed : null,
  });
}

/** RPC for `starlings-ops` only, over a service binding. It has no `fetch`. */
export class OpsService extends WorkerEntrypoint<Env> {
  async metadata(): Promise<OpsServiceMetadata> {
    return keepOpsMetadata(this.env);
  }
}
