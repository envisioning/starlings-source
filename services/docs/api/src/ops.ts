// Docs' door for the platform operator console (`starlings-ops` on
// the ops host, in the meet repo: docs/OPS_CONSOLE.md). The console
// calls `OpsService` over a service binding. The entrypoint has no URL and no
// route, so nothing on the internet reaches it.
//
// Counts and times only. Never a title, a path, a body, an address or a
// token. The shape matches `opsServiceMetadataSchema` in meet's
// packages/contracts/src/ops.ts; the console parses it again on its side.
import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';

const opsServiceMetadataSchema = z.object({
  service: z.literal('docs'),
  migration: z.string().nullable(),
  counts: z.array(z.object({ label: z.string().min(1).max(40), value: z.number().int().nonnegative() }).strict()).max(24),
  last_activity_at: z.number().nullable(),
}).strict();
export type OpsServiceMetadata = z.infer<typeof opsServiceMetadataSchema>;

const COUNTS: [label: string, sql: string][] = [
  ['Documents', "SELECT COUNT(*) AS n FROM documents WHERE status = 'active'"],
  ['Archived documents', "SELECT COUNT(*) AS n FROM documents WHERE status = 'archived'"],
  ['Mirrored documents', "SELECT COUNT(*) AS n FROM documents WHERE status = 'active' AND source_system <> 'native'"],
  ['Folders', 'SELECT COUNT(*) AS n FROM folders'],
  ['Versions', 'SELECT COUNT(*) AS n FROM document_versions'],
  ['Open comment threads', "SELECT COUNT(DISTINCT thread_id) AS n FROM annotations WHERE status = 'open' AND deleted_at IS NULL"],
  ['Pending signatures', "SELECT COUNT(*) AS n FROM signature_requests WHERE status = 'pending'"],
  ['Completed signatures', "SELECT COUNT(*) AS n FROM signature_requests WHERE status = 'completed'"],
  ['Active share links', 'SELECT COUNT(*) AS n FROM grants WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?1)'],
  ['Active API tokens', 'SELECT COUNT(*) AS n FROM api_tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?1)'],
  ['Stored MB', "SELECT CAST(ROUND(COALESCE(SUM(byte_size), 0) / 1048576.0) AS INTEGER) AS n FROM documents WHERE status <> 'deleted'"],
];

/** The metadata `OpsService` returns, parsed before it leaves. */
export async function docsOpsMetadata(env: Pick<Env, 'DB'>, now = new Date()): Promise<OpsServiceMetadata> {
  const iso = now.toISOString();
  const statements = [
    ...COUNTS.map(([, sql]) => sql.includes('?1') ? env.DB.prepare(sql).bind(iso) : env.DB.prepare(sql)),
    env.DB.prepare('SELECT MAX(updated_at) AS at FROM documents'),
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
    service: 'docs',
    migration: typeof migration === 'string' ? migration : null,
    counts: results ? COUNTS.map(([label], index) => ({ label, value: Number(first(index)?.n ?? 0) })) : [],
    last_activity_at: Number.isFinite(parsed) ? parsed : null,
  });
}

/** RPC for `starlings-ops` only, over a service binding. It has no `fetch`. */
export class OpsService extends WorkerEntrypoint<Env> {
  async metadata(): Promise<OpsServiceMetadata> {
    return docsOpsMetadata(this.env);
  }
}
