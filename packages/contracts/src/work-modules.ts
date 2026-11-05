/**
 * The work modules a workspace admin turns on, decided once
 * (docs/WORK_MODEL.md).
 *
 * Every workspace has the same base: organizations, contacts, projects, tasks,
 * goals, decisions, the meeting log. A work module adds record types on top,
 * and is off on a new workspace. This table says which subject kind each one
 * adds, if any, and which stores can serve it; a work module a store cannot
 * serve cannot be turned on there. The setting itself (which are on) is the
 * workspace's, saved in its D1 settings.
 *
 * Rule input, not a wire shape: the Worker, the web and Admin read it, the
 * Swift table (`Sources/Generated/WorkModulesRegistry.swift`) and
 * `fixtures/work-modules.json` are generated from it (`pnpm registries:gen`).
 * Adding a work module starts here and in WORK_MODEL.md.
 */

import type { SubjectKind } from './subject-kinds';

/** Where a workspace keeps its records (`WORK_STORE`, docs/WORKSPACE_STORE.md). */
export const WORK_STORES = ['core', 'd1'] as const;
export type WorkStore = (typeof WORK_STORES)[number];

/** Every work module, in the order Admin lists them. */
export const WORK_MODULES = [
  'sales',
  'partners',
  'events',
  'support',
  'offers',
  'licenses',
  'spec_fields',
] as const;
export type WorkModule = (typeof WORK_MODULES)[number];

export interface WorkModuleSpec {
  /** The subject kind the work module adds, or null when it adds none. */
  subjectKind: SubjectKind | null;
  /** The stores that can serve it today. Empty: not available anywhere yet. */
  stores: readonly WorkStore[];
  /** One of Envisioning's commercial pieces, a work module once generalized (WORK_MODEL.md). */
  commercial: boolean;
}

export const WORK_MODULE_SPECS: Readonly<Record<WorkModule, WorkModuleSpec>> = {
  sales: { subjectKind: 'lead', stores: ['core', 'd1'], commercial: false },
  // The partnership relationship on an organization (ADR 0006); no kind of its own.
  partners: { subjectKind: null, stores: ['core', 'd1'], commercial: false },
  // D1 serves events since migration 0087.
  events: { subjectKind: 'event', stores: ['core', 'd1'], commercial: false },
  // Support requests on an organization's guest thread (docs/SUPPORT.md).
  support: { subjectKind: null, stores: [], commercial: false },
  // D1 serves offers since migration 0140; on a Core workspace the commercial group's store decides.
  offers: { subjectKind: null, stores: ['core', 'd1'], commercial: true },
  // An accepted offer makes a license on D1 too; the group lists them.
  licenses: { subjectKind: null, stores: ['core', 'd1'], commercial: true },
  spec_fields: { subjectKind: null, stores: ['core'], commercial: true },
};

/** The word Admin shows for each work module. */
export const WORK_MODULE_LABELS: Readonly<Record<WorkModule, string>> = {
  sales: 'Sales',
  partners: 'Partners',
  events: 'Events',
  support: 'Support',
  offers: 'Offers',
  licenses: 'Licenses',
  spec_fields: 'Project specs',
};

/** True when a workspace on `store` can turn the work module on. */
export function workModuleAvailable(module: WorkModule, store: WorkStore): boolean {
  return WORK_MODULE_SPECS[module].stores.includes(store);
}

/** The work modules a workspace on `store` can turn on, in Admin's order. */
export function workModulesAvailableOn(store: WorkStore): WorkModule[] {
  return WORK_MODULES.filter((module) => workModuleAvailable(module, store));
}

/**
 * The work module that gates `kind`, or null when the kind is in the base.
 * Every `organization` subject is a partner until the relationships slice
 * (ADR 0006), so Partners still gates the kind.
 */
export function workModuleForSubjectKind(kind: SubjectKind): WorkModule | null {
  if (kind === 'organization') return 'partners';
  return WORK_MODULES.find((module) => WORK_MODULE_SPECS[module].subjectKind === kind) ?? null;
}

/** True when a subject of `kind` shows on a workspace with `on` work modules: the base always, a gated kind when its work module is on. */
export function subjectKindShown(kind: SubjectKind, on: readonly WorkModule[]): boolean {
  const module = workModuleForSubjectKind(kind);
  return module === null || on.includes(module);
}
