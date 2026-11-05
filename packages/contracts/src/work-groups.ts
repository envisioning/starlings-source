// The table groups that move from Core to D1, together in one window (,
// docs/CORE_FOLD_PLAN.md §The window). No imports, so the Node scripts
// (check-production-config) load it as is. The admin route's schemas are in
// index.ts.

/**
 * The groups in the order they move (decided by MZ, 2026-10-10). The order is
 * the D1 foreign keys: `goals.project_id`, `milestones.project_id` and
 * `project_github_repos.project_id` reference `projects`, and
 * `projects.organization_id` / `lead_id` reference `organizations` and
 * `leads` (migrations 0073–0075). A group can answer from D1 only when every
 * group before it does. `commercial` moves after the four-group window (decided
 * by MZ, 2026-11-04). Signals is no group: a customer is a licence and
 * a prospect is a lead (decided by MZ, 2026-11-05).
 * The CMS (events) moves later, to its own Worker, and is not a group here.
 */
export const WORK_GROUPS = ['subjects', 'tasks', 'goals', 'interactions', 'commercial'] as const;
export type WorkGroup = (typeof WORK_GROUPS)[number];

/**
 * The D1 tables of each group, parents before children: the copy writes them
 * in this order, and a D1 foreign key refuses any other. The settings tables
 * contacts and leads need move with `subjects` (decided by MZ, 2026-10-22,
 *); each keeps Core's name. Currencies and exchange rates move with
 * the commercial group, not here (MZ, 2026-10-22). Partner
 * agreement signatures move with `interactions` (MZ, 2026-10-10).
 * Every commercial table keeps Core's name (its columns are in
 * `core-commercial.ts`).
 * `favorites` is the one D1 name that differs from
 * Core's (`member_favorites`), and Core's copy of this list keeps D1's name.
 */
export const WORK_GROUP_TABLES: Record<WorkGroup, readonly string[]> = {
  subjects: [
    'lead_characteristics_config', 'contact_characteristics_config', 'contact_source_definitions',
    'organizations', 'contacts', 'contact_source_events', 'leads', 'projects', 'project_contacts',
  ],
  tasks: ['milestones', 'tasks'],
  goals: ['goals', 'decisions', 'favorites', 'project_github_repos'],
  interactions: ['interactions', 'interaction_subjects', 'interaction_contacts', 'partner_agreement_signatures'],
  commercial: [
    'corporate_entities', 'currency_settings', 'exchange_rates_cache', 'settings_payment_terms', 'settings_delivery_conditions',
    'settings_offer_links', 'services', 'offers', 'offer_services', 'offer_selected_links', 'offer_access_logs', 'licenses',
    'license_offers', 'policies',
  ],
};

/**
 * The Worker var that names each group's store, `core` or `d1`. Unset follows
 * `WORK_STORE`, so nothing changes until a var is set. Only a `WORK_STORE=core`
 * workspace reads them; a D1 workspace is D1 for every group.
 */
export const WORK_GROUP_VARS = {
  subjects: 'WORK_STORE_SUBJECTS',
  tasks: 'WORK_STORE_TASKS',
  goals: 'WORK_STORE_GOALS',
  interactions: 'WORK_STORE_INTERACTIONS',
  commercial: 'WORK_STORE_COMMERCIAL',
} as const satisfies Record<WorkGroup, string>;
export type WorkGroupVar = (typeof WORK_GROUP_VARS)[WorkGroup];

export function isWorkGroup(value: unknown): value is WorkGroup {
  return typeof value === 'string' && (WORK_GROUPS as readonly string[]).includes(value);
}

/**
 * The group of each Core dashboard collection a client links to:
 * once the group answers from D1, Core's page shows a stale copy, so no
 * client links there. A collection in no group (events) stays on Core
 * and keeps its link.
 */
export const CORE_COLLECTION_GROUPS: Readonly<Record<string, WorkGroup>> = {
  organizations: 'subjects',
  contacts: 'subjects',
  leads: 'subjects',
  projects: 'subjects',
  milestones: 'tasks',
  tasks: 'tasks',
  goals: 'goals',
  decisions: 'goals',
  interactions: 'interactions',
  offers: 'commercial',
  licenses: 'commercial',
  services: 'commercial',
  policies: 'commercial',
};

/** The group a Core collection belongs to, or null when it is in none. */
export function coreCollectionGroup(collection: string): WorkGroup | null {
  return Object.prototype.hasOwnProperty.call(CORE_COLLECTION_GROUPS, collection) ? CORE_COLLECTION_GROUPS[collection]! : null;
}
