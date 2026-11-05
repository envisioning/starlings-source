// The hourly sweep: Core's surfaces into Docs, from inside the Worker.
//
// The same adapters as `scripts/mirror-core.ts`, the same `ingest` — only
// there is no HTTP between them. A surface that cannot be read is recorded
// in `sync_state` and the next surface still runs; a mirror that silently
// stops is the failure this exists to prevent, so `/api/health` reports the
// last run of every surface.

import type { SourceKind } from '@docs/contracts';
import { ADAPTERS, mirrorDocuments, readAll, type Project } from './mirror-adapters';
import { NOTE_SELECT, noteDocuments, readLabels, readTable } from './adopt-notes';
import { adopt, ingest } from './ingest';

/**
 * Notes are adopted, not mirrored, so they have no ADAPTERS entry — but they
 * run on the same clock and report through the same `sync_state` row. Kept a
 * surface rather than a special case at the call site so `/api/health`, the
 * by-hand script and the cron all see one list.
 */
export const NOTES_SURFACE = 'note';

const BATCH = 50;

export interface MirrorRun {
  surface: string;
  seen: number;
  written: number;
  unchanged: number;
  error?: string;
}

export function allSurfaces(): string[] {
  return [...Object.keys(ADAPTERS), NOTES_SURFACE];
}

export async function runMirror(env: Env, surfaces: string[] = allSurfaces()): Promise<MirrorRun[]> {
  const runs: MirrorRun[] = [];
  for (const surface of surfaces) {
    const adapter = ADAPTERS[surface];
    if (!adapter && surface !== NOTES_SURFACE) continue;
    const run: MirrorRun = { surface, seen: 0, written: 0, unchanged: 0 };
    runs.push(run);

    const credentials = credentialsFor(env, adapter?.project ?? 'crm');
    if (!credentials) {
      run.error = `Supabase ${(adapter?.project ?? 'crm').toUpperCase()} is not configured.`;
      await recordFailure(env, surface, run.error);
      continue;
    }

    try {
      if (!adapter) {
        const adopted = await adoptCoreNotes(env, credentials);
        run.seen = adopted.seen;
        run.written = adopted.written;
        run.unchanged = adopted.unchanged;
        await recordSuccess(env, surface, run);
        continue;
      }

      const rows = await readAll(credentials.url, credentials.key, adapter);
      const documents = mirrorDocuments(surface, adapter, rows);
      run.seen = documents.length;
      for (let index = 0; index < documents.length; index += BATCH) {
        const result = await ingest(env, { source_system: 'core', documents: documents.slice(index, index + BATCH) });
        run.written += result.written;
        run.unchanged += result.unchanged;
      }
      await ingest(env, {
        source_system: 'core',
        source_kind: surface as SourceKind,
        documents: [],
        complete: true,
        run_seen: run.seen,
        run_written: run.written,
      });
    } catch (error) {
      run.error = error instanceof Error ? error.message : String(error);
      await recordFailure(env, surface, run.error);
    }
  }
  return runs;
}

/**
 * Read CRM's notes and adopt whatever is not already ours. Reports the counts
 * a mirror surface reports, so `/api/health` reads the same for notes as for
 * anything else — the point being that a stalled adoption is as visible as a
 * stalled mirror.
 */
async function adoptCoreNotes(
  env: Env,
  credentials: { url: string; key: string },
): Promise<{ seen: number; written: number; unchanged: number }> {
  const notes = await readTable(credentials.url, credentials.key, 'notes', NOTE_SELECT);
  const documents = noteDocuments(notes, await readLabels(credentials.url, credentials.key));

  let written = 0;
  let unchanged = 0;
  for (let index = 0; index < documents.length; index += BATCH) {
    const result = await adopt(env, { source_system: 'core', documents: documents.slice(index, index + BATCH) });
    written += result.adopted + result.created;
    unchanged += result.unchanged;
  }
  return { seen: documents.length, written, unchanged };
}

function credentialsFor(env: Env, project: Project): { url: string; key: string } | null {
  const url = project === 'cms' ? env.SUPABASE_URL_CMS : env.SUPABASE_URL_CRM;
  const key = project === 'cms' ? env.SUPABASE_SERVICE_ROLE_KEY_CMS : env.SUPABASE_SERVICE_ROLE_KEY_CRM;
  return url?.trim() && key?.trim() ? { url: url.trim(), key: key.trim() } : null;
}

/**
 * The mirror path records its own run through `ingest(complete: true)`.
 * Adoption has no ingest call to piggyback on, so it writes the row itself.
 */
async function recordSuccess(env: Env, surface: string, run: MirrorRun): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sync_state (source_key, last_run_at, last_status, documents_seen, documents_written)
     VALUES (?, ?, 'ok', ?, ?)
     ON CONFLICT (source_key) DO UPDATE SET
       last_run_at = excluded.last_run_at,
       last_status = 'ok',
       documents_seen = excluded.documents_seen,
       documents_written = excluded.documents_written,
       error = NULL`,
  )
    .bind(`core:${surface}`, new Date().toISOString(), run.seen, run.written)
    .run();
}

async function recordFailure(env: Env, surface: string, error: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sync_state (source_key, last_run_at, last_status, error)
     VALUES (?, ?, 'error', ?)
     ON CONFLICT (source_key) DO UPDATE SET
       last_run_at = excluded.last_run_at,
       last_status = 'error',
       error = excluded.error`,
  )
    .bind(`core:${surface}`, new Date().toISOString(), error.slice(0, 1000))
    .run();
}

/**
 * A surface that has not run in this long is stale, whatever its last status
 * said. The sweep is hourly; three hours is two missed runs, which is a
 * scheduler that stopped rather than one slow afternoon.
 */
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

export interface MirrorSurfaceStatus extends Record<string, unknown> {
  source_key: string;
  last_run_at: string | null;
  last_status: string | null;
  healthy: boolean;
  stale: boolean;
}

/**
 * What `/api/health` says about the mirror: one line per surface, each
 * judged rather than merely reported.
 *
 * `last_status` alone is not health. `core:work` sat at `error` for seven
 * months and nothing said so; a surface can equally sit at `ok` forever
 * because the sweep stopped running, which reads as perfect and is worse.
 * So a row is healthy only if its last run succeeded *and* was recent, and a
 * surface that never ran at all is not healthy either.
 */
export async function mirrorStatus(env: Env): Promise<MirrorSurfaceStatus[]> {
  const { results } = await env.DB.prepare(
    `SELECT source_key, last_run_at, last_status, documents_seen, documents_written, error
       FROM sync_state WHERE source_key LIKE 'core:%' ORDER BY source_key`,
  ).all<Record<string, unknown>>();

  const now = Date.now();
  const rows = results.map((row) => {
    const lastRunAt = typeof row.last_run_at === 'string' ? row.last_run_at : null;
    const stale = !lastRunAt || now - Date.parse(lastRunAt) > STALE_AFTER_MS;
    return {
      ...row,
      source_key: String(row.source_key),
      last_run_at: lastRunAt,
      last_status: typeof row.last_status === 'string' ? row.last_status : null,
      stale,
      healthy: row.last_status === 'ok' && !stale,
    } as MirrorSurfaceStatus;
  });

  // A surface that is configured but has never run has no row at all, which
  // would otherwise read as nothing wrong. Configured means its Supabase
  // project's keys are set: a workspace deployment has no Core and no keys,
  // so it has no surfaces to report (env.hq). A surface whose keys went
  // missing after it ran keeps its row, and the run records the failure.
  for (const surface of allSurfaces()) {
    if (rows.some((row) => row.source_key === `core:${surface}`)) continue;
    if (!credentialsFor(env, ADAPTERS[surface]?.project ?? 'crm')) continue;
    rows.push({
      source_key: `core:${surface}`,
      last_run_at: null,
      last_status: null,
      documents_seen: 0,
      documents_written: 0,
      error: 'Has never run.',
      stale: true,
      healthy: false,
    });
  }

  return rows.sort((left, right) => left.source_key.localeCompare(right.source_key));
}
