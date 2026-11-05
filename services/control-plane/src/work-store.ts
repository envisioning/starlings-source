/**
 * Where this workspace keeps its records: Envisioning's Core, or its own D1
 * (docs/WORKSPACE_STORE.md). Read once per call from `WORK_STORE`.
 *
 * Fail closed: only the exact value `core` reaches Core. `d1`, unset, or any
 * other value is a workspace that never sends a request to a Core host
 *. Envisioning sets `core`; `scripts/check-production-config.mjs`
 * requires the value in a deployed configuration.
 */
import { WORK_GROUP_VARS, type WorkGroup, type WorkGroupVar } from '@starlings/contracts/work-groups';

export type WorkStoreKind = 'core' | 'd1';

export function workStore(env: Pick<Env, 'WORK_STORE'>): WorkStoreKind {
  const value = env.WORK_STORE?.trim();
  return value === 'core' ? 'core' : 'd1';
}

/** True only on a workspace whose records live in Core. Every Core request checks this first. */
export function usesCore(env: Pick<Env, 'WORK_STORE'>): boolean {
  return workStore(env) === 'core';
}

type GroupStoreEnv = Pick<Env, 'WORK_STORE'> & Partial<Record<WorkGroupVar, string | undefined>>;

/**
 * Where one table group answers from (docs/CORE_FOLD_PLAN.md §The
 * group move). A D1 workspace is D1 for every group. On a Core workspace the
 * group's var (`WORK_STORE_SUBJECTS`, …) names it; only the exact value `d1`
 * moves the group, and unset or any other value stays on Core, as
 * `bookingStore` does. The deploy check refuses another value, and a group on
 * D1 while a group before it is still on Core.
 */
export function groupStore(env: GroupStoreEnv, group: WorkGroup): WorkStoreKind {
  if (!usesCore(env)) return 'd1';
  return env[WORK_GROUP_VARS[group]]?.trim() === 'd1' ? 'd1' : 'core';
}

/** True when this group's records live in Core. Every `crm.ts` branch on the store asks this. */
export function usesCoreFor(env: GroupStoreEnv, group: WorkGroup): boolean {
  return groupStore(env, group) === 'core';
}

/**
 * The group a subject kind's rows belong to. Leads, projects and
 * organizations are `subjects`. An event is a CMS row (Phase 5) and is in no
 * group: it follows `WORK_STORE`.
 */
export function subjectKindGroup(kind: string): WorkGroup | null {
  return kind === 'lead' || kind === 'project' || kind === 'organization' ? 'subjects' : null;
}

/** `usesCoreFor` for a subject kind: an event follows the workspace. */
export function usesCoreForKind(env: GroupStoreEnv, kind: string): boolean {
  const group = subjectKindGroup(kind);
  return group ? usesCoreFor(env, group) : usesCore(env);
}

/**
 * Where booking pages, slots and bookings come from (docs/CORE_FOLD_PLAN.md
 * §Phase 3d). `BOOKING_STORE` names it; unset follows `WORK_STORE`. Core is
 * only reachable on a workspace that uses Core, so a D1 workspace that sets
 * `core` here still answers from D1.
 */
export function bookingStore(env: Pick<Env, 'WORK_STORE' | 'BOOKING_STORE'>): WorkStoreKind {
  if (!usesCore(env)) return 'd1';
  return env.BOOKING_STORE?.trim() === 'd1' ? 'd1' : 'core';
}

/**
 * Where every Core request goes: this workspace's `CORE_API_ORIGIN`, without a
 * trailing slash. Throws on a workspace that does not use Core, and on one
 * that names no Core: there is no compiled default.
 */
export function coreApiOrigin(env: Pick<Env, 'WORK_STORE' | 'CORE_API_ORIGIN'>): string {
  if (!usesCore(env)) throw new Error('This workspace does not use Core.');
  const origin = env.CORE_API_ORIGIN?.trim();
  if (!origin) throw new Error('CORE_API_ORIGIN is not configured.');
  return origin.replace(/\/+$/u, '');
}
