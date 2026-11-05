// The write freeze of a table group while it moves from Core to D1 (,
// docs/CORE_FOLD_PLAN.md §The group move). An admin sets it through
// `POST /api/admin/work-groups` (work-group-moves.ts); every write to the
// group in `crm.ts` asks here first. Reads never ask.

import type { WorkGroup } from '@starlings/contracts/work-groups';
import { ControlError } from './errors';
import { usesCore } from './work-store';

export const RECORDS_MOVING_MESSAGE = 'These records are moving to a new store. Try again in a few minutes.';

/** True while an admin has frozen the group. A D1 workspace has no move and never asks D1. */
export async function isGroupFrozen(env: Env, group: WorkGroup): Promise<boolean> {
  if (!usesCore(env)) return false;
  const row = await env.USAGE.prepare('SELECT frozen FROM work_group_moves WHERE work_group = ?1')
    .bind(group)
    .first<{ frozen: number }>();
  return row?.frozen === 1;
}

/**
 * Refuse a write to a frozen group: 503 `records_moving`, so the write lands
 * in neither store while the copy runs. No cache: the freeze holds from the
 * request after the admin sets it, in every isolate.
 */
export async function assertGroupWritable(env: Env, group: WorkGroup): Promise<void> {
  if (await isGroupFrozen(env, group)) {
    throw new ControlError(RECORDS_MOVING_MESSAGE, 503, 'records_moving');
  }
}
