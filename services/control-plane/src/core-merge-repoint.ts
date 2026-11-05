// A merge on D1, and the tables that stay in Core.
//
// After the move, a merge of organizations, contacts or leads runs on D1 and
// Core does not see it. Tables that stay in Core still name the merged ids, so
// the Worker asks Core to move them. Once a group moved to D1 (`commercial`,
// `signals`), the D1 merge moves its rows and Core's function leaves the frozen
// copy alone. The route is `POST /api/public/meet-fold-merge-repoint`, which reads its columns from
// the ledger of the foreign keys the move dropped. A `WORK_STORE=d1` workspace
// has no Core and sends nothing.
//
// Core's merge refuses a conflict before it changes anything (two Signals
// accounts on one organization while Signals is on Core, another UNIQUE row), and
// a person resolves it. A
// dry run keeps that rule: the D1 merge does not start. Any other failure of the
// dry run does not stop the merge. After the merge, the D1 write stands and a
// failure counts under `core_merge_repoint` (docs/OPERATIONS.md). The route is
// idempotent, and `record_merges` keeps each merge, so an admin replays with
// `{"action":"repoint_merges","group":"subjects"}` on /api/admin/work-groups.
import type { CoreMergeEntity } from '@starlings/contracts/core-fields';
import {
  coreMergeRepointRequestSchema,
  coreMergeRepointResponseSchema,
  type CoreMergeRepoint,
  type CoreMergeRepointResult,
} from '@starlings/contracts/core-writes';
import type { WorkGroupMoveResponse } from '@starlings/contracts';
import { coreFailure, readCoreJson, signedCoreFetch } from './crm';
import { ControlError } from './errors';
import { recordFailure } from './ops';
import { usesCore } from './work-store';

const CORE_ROUTE = '/api/public/meet-fold-merge-repoint';
/** Postgres' unique violation: a conflict a person resolves. */
const CONFLICT = '23505';
/** What one call of the route takes. `/api/public/*` has a rate limit, so a replay sends many in one call. */
const MERGES_PER_CALL = 50;
const IDS_PER_MERGE = 100;

async function send(env: Env, merges: CoreMergeRepoint[], dryRun: boolean): Promise<CoreMergeRepointResult[]> {
  const body = coreMergeRepointRequestSchema.parse({ merges, ...(dryRun ? { dry_run: true } : {}) });
  const response = await signedCoreFetch(env, CORE_ROUTE, { method: 'POST', body: JSON.stringify(body) });
  if (!response.ok) throw coreFailure('merge repoint', response);
  return (await readCoreJson(response, coreMergeRepointResponseSchema, `POST ${CORE_ROUTE}`)).results;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Before a D1 merge: a conflict Core would refuse stops it, with Core's reason. */
export async function refuseCoreMergeConflict(env: Env, merge: CoreMergeRepoint): Promise<void> {
  if (!usesCore(env)) return;
  let result: CoreMergeRepointResult | undefined;
  try {
    [result] = await send(env, [merge], true);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'core.merge_repoint.dry_run.failed', entity: merge.entity, into_id: merge.into_id, error: messageOf(error) }));
    return;
  }
  if (result && !result.ok && result.code === CONFLICT) throw new ControlError(result.error, 409, 'invalid_request');
}

/** After a D1 merge. It never throws: the merge stands. */
export async function repointCoreMerge(env: Env, merge: CoreMergeRepoint): Promise<void> {
  if (!usesCore(env)) return;
  try {
    const [result] = await send(env, [merge], false);
    if (!result?.ok) throw new Error(result ? `${result.code}: ${result.error}` : 'Core answered no result');
  } catch (error) {
    const message = messageOf(error);
    console.error(JSON.stringify({ level: 'error', message: 'core.merge_repoint.failed', ...merge, error: message }));
    await recordFailure(env, 'core_merge_repoint', `${merge.entity} ${merge.into_id} from ${merge.from_ids.join(' ')}: ${message}`);
  }
}

/**
 * Every merge since the `subjects` copy, sent again. A merge before the copy was
 * Core's own, and Core moved its rows then. Safe to run at any time: a merge
 * that moved its rows moves nothing.
 */
export async function replayCoreMergeRepoints(env: Env): Promise<NonNullable<WorkGroupMoveResponse['repoint']>> {
  if (!usesCore(env)) throw new ControlError('This workspace keeps its CRM in D1.', 404, 'not_configured');
  const move = await env.USAGE.prepare("SELECT copied_at FROM work_group_moves WHERE work_group = 'subjects'").first<{ copied_at: number | null }>();
  const { results } = await env.USAGE.prepare(
    'SELECT entity, into_id, from_id FROM record_merges WHERE merged_at >= ?1 ORDER BY entity, into_id, from_id',
  ).bind(move?.copied_at ?? 0).all<{ entity: CoreMergeEntity; into_id: string; from_id: string }>();

  const byInto = new Map<string, CoreMergeRepoint>();
  const merges: CoreMergeRepoint[] = [];
  for (const row of results) {
    const key = `${row.entity}:${row.into_id}`;
    let merge = byInto.get(key);
    if (!merge || merge.from_ids.length >= IDS_PER_MERGE) {
      merge = { entity: row.entity, into_id: row.into_id, from_ids: [] };
      byInto.set(key, merge);
      merges.push(merge);
    }
    merge.from_ids.push(row.from_id);
  }

  let moved = 0;
  const failed: NonNullable<WorkGroupMoveResponse['repoint']>['failed'] = [];
  for (let start = 0; start < merges.length; start += MERGES_PER_CALL) {
    const batch = merges.slice(start, start + MERGES_PER_CALL);
    try {
      for (const result of await send(env, batch, false)) {
        if (result.ok) moved += result.moved;
        else failed.push({ entity: result.entity, into_id: result.into_id, code: result.code, error: result.error });
      }
    } catch (error) {
      for (const merge of batch) failed.push({ entity: merge.entity, into_id: merge.into_id, code: 'unreachable', error: messageOf(error) });
    }
  }
  return { merges: merges.length, moved, failed };
}
