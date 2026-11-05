import { useEffect, useSyncExternalStore } from 'react';
import type { WorkspacePlanResponse } from '@starlings/contracts/workspace-plan';
import { isProjectFrozen, PLAN_ERROR_CODES } from '@starlings/contracts/workspace-plans';
import { apiFetch } from './api';
import { fetchSubjectState } from './crm-work';
import { errorCodeOf } from './config';
import { t } from './i18n';
import { onOwnerPurge } from './owner-local-state';

/**
 * The workspace's plan as this document last read it (,
 * `GET /api/workspace/plan`), and whether the signed-in person is an admin.
 * Work draws the limit prompt and the read-only project from these; Admin
 * changes the plan and publishes the answer here.
 *
 * The plan is rule input for the prompt only. The Worker refuses the write;
 * this module only decides what the page says before and after.
 */

export type PlanErrorCode = (typeof PLAN_ERROR_CODES)[keyof typeof PLAN_ERROR_CODES];

const PLAN_CODES: readonly string[] = Object.values(PLAN_ERROR_CODES);

/** The plan code a failed write carries, or null for any other failure. */
export function planErrorCodeOf(error: unknown): PlanErrorCode | null {
  const code = errorCodeOf(error);
  return code && PLAN_CODES.includes(code) ? code as PlanErrorCode : null;
}

/** A read older than this is read again when a surface mounts. */
const FRESH_MS = 60_000;

type Store = { plan: WorkspacePlanResponse | null; isAdmin: boolean | null };

let store: Store = { plan: null, isAdmin: null };
let planReadAt = 0;
let planInflight: Promise<void> | null = null;
let adminInflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: Partial<Store>) {
  store = { ...store, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

onOwnerPurge(() => {
  planReadAt = 0;
  publish({ plan: null, isAdmin: null });
});

/** Read the plan again. A failed read keeps what the page has: the Worker still decides every write. */
export function refreshWorkspacePlan(): Promise<void> {
  planInflight ??= apiFetch<WorkspacePlanResponse>('/workspace/plan', {
    fallbackError: t('Couldn’t load the plan.'),
    noStore: true,
  })
    .then((plan) => { planReadAt = Date.now(); publish({ plan }); })
    .catch(() => undefined)
    .finally(() => { planInflight = null; });
  return planInflight;
}

/** Admin's writes answer the new plan; every surface draws it at once. */
export function publishWorkspacePlan(plan: WorkspacePlanResponse) {
  planReadAt = Date.now();
  publish({ plan });
}

/** The plan, read once `enabled` (a signed-in member) and again when stale. */
export function useWorkspacePlan(enabled = true): WorkspacePlanResponse | null {
  const current = useSyncExternalStore(subscribe, () => store.plan, () => null);
  useEffect(() => {
    if (enabled && Date.now() - planReadAt > FRESH_MS) void refreshWorkspacePlan();
  }, [enabled]);
  return current;
}

/** True when the plan makes this project read-only. False until the plan is known. */
export function projectFrozen(plan: WorkspacePlanResponse | null, projectId: string): boolean {
  return plan !== null && isProjectFrozen(plan, projectId);
}

/** Admin's overview carries the viewer's role; it hands it here so Work need not ask. */
export function rememberViewerAdmin(isAdmin: boolean) {
  if (store.isAdmin !== isAdmin) publish({ isAdmin });
}

/**
 * Whether the signed-in person is an admin, or null while unknown. The first
 * prompt in a document reads the role from `GET /api/crm/subject-state`
 * once, the same source the Mac and iOS read. Only a prompt asks.
 */
export function useViewerIsAdmin(): boolean | null {
  const current = useSyncExternalStore(subscribe, () => store.isAdmin, () => null);
  useEffect(() => {
    if (store.isAdmin !== null) return;
    adminInflight ??= fetchSubjectState()
      .then((state) => rememberViewerAdmin(state.role === 'admin'))
      // Unknown reads as a member: the words show, the button does not.
      .catch(() => rememberViewerAdmin(false))
      .finally(() => { adminInflight = null; });
  }, []);
  return current;
}
