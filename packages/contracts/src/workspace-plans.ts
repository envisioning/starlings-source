/**
 * The workspace plans and what each one permits (BUSINESS (HQ Docs)).
 *
 * Plans and rights are separate. A plan never grants authority: the Worker
 * checks the caller's role and subject access first, then the plan. The
 * prices live in `web/marketing/src/pricing.ts`; this table is what the
 * Worker enforces.
 *
 * Decided by MZ on 2026-10-04:
 * - A workspace with no stored plan is on Pro, so no existing workspace loses
 *   a function.
 * - Free holds one project, ever. Every project counts, whatever its status.
 *   Leads, partners and events never count.
 * - On Free, every project but the kept one is read-only. An admin picks the
 *   kept project once; until then it is the most recently updated one.
 *
 * Rule input, not a wire shape: no zod, so the web's entry path may import
 * it. The wire shape is `workspace-plan.ts`; the Swift table is generated
 * into `Sources/Generated/WorkspacePlansRegistry.swift`.
 */

import { PRODUCT_SITE_ORIGIN } from './deployment';

export const WORKSPACE_PLAN_IDS = ['free', 'starter', 'pro'] as const;
export type WorkspacePlanId = (typeof WORKSPACE_PLAN_IDS)[number];

/** A workspace with no stored plan. */
export const DEFAULT_WORKSPACE_PLAN: WorkspacePlanId = 'pro';

export interface WorkspacePlanSpec {
  id: WorkspacePlanId;
  /** The plan's name on every client. */
  label: string;
  /** How many projects the workspace may hold, in any status. Null is no limit. */
  projectLimit: number | null;
  /** Scheduled and event-triggered agent work. Nothing enforces it yet. */
  unattendedWorkflows: boolean;
}

export const WORKSPACE_PLANS: readonly WorkspacePlanSpec[] = [
  { id: 'free', label: 'Free', projectLimit: 1, unattendedWorkflows: false },
  { id: 'starter', label: 'Starter', projectLimit: null, unattendedWorkflows: false },
  { id: 'pro', label: 'Pro', projectLimit: null, unattendedWorkflows: true },
];

export function isWorkspacePlanId(value: unknown): value is WorkspacePlanId {
  return typeof value === 'string' && (WORKSPACE_PLAN_IDS as readonly string[]).includes(value);
}

export function workspacePlanSpec(id: WorkspacePlanId): WorkspacePlanSpec {
  return WORKSPACE_PLANS.find((spec) => spec.id === id) ?? WORKSPACE_PLANS[WORKSPACE_PLANS.length - 1]!;
}

/** The `code` of a Worker error the plan causes. A client shows the upgrade prompt on these. */
export const PLAN_ERROR_CODES = {
  projectLimit: 'plan_project_limit',
  projectFrozen: 'plan_project_frozen',
} as const;

/**
 * Where an admin's Upgrade button goes. The public pricing page and its pilot
 * inquiry, until Stripe Checkout exists.
 */
export const PLAN_UPGRADE_URL = `${PRODUCT_SITE_ORIGIN}/pricing`;

/** The words every client shows at a plan limit. */
export const PLAN_WORDS = {
  projectLimit: 'Free includes one project.',
  projectFrozen: 'This project is read-only on Free.',
  askAdmin: 'Ask an admin to upgrade.',
  upgrade: 'Upgrade',
} as const;

/** The plan facts a rule needs: the plan and the one writable project on Free. */
export interface WorkspacePlanFacts {
  plan: WorkspacePlanId;
  kept_project_id: string | null;
}

/**
 * True when the plan makes this project read-only. Only Free freezes, and
 * only once a kept project is set: a Free workspace with no project, or with
 * its one project, has nothing to freeze.
 */
export function isProjectFrozen(facts: WorkspacePlanFacts, projectId: string): boolean {
  if (workspacePlanSpec(facts.plan).projectLimit === null) return false;
  return facts.kept_project_id !== null && facts.kept_project_id !== projectId;
}
