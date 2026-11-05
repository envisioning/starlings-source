/**
 * What Work's Browse offers for each group of subjects, decided once.
 *
 * `SUBJECT_GROUPS` names the five groups (`subject-state-values.ts`). Which of
 * them has a status filter and a sort, which starts folded, which needs Sales
 * on, and the key each one's saved choices live under was written again in the
 * Mac window, the iOS list and the web page. This table is that decision. It is
 * rule input, not a wire shape: Swift mirrors it (`Sources/BrowseGroups.swift`)
 * and `fixtures/browse-groups.json` pins the mirror.
 *
 * Titles stay with each client.
 */

import { SUBJECT_GROUPS } from './subject-state-values';
import type { SubjectKind } from './subject-kinds';

export type BrowseGroup = (typeof SUBJECT_GROUPS)[number];

/** The lists a status filter and a sort belong to. Envisioning's projects and the clients' are two lists of one kind. */
export type BrowseList = 'envisioning' | 'project' | 'lead';

export interface BrowseGroupSpec {
  /** The kind of subject the group lists. */
  subjectKind: SubjectKind;
  /**
   * The list whose status filter and sort the group carries; null when it has
   * neither (partners and events). Its status words come from `subject-status`.
   */
  list: BrowseList | null;
  /** Folded until the person opens it. */
  startsCollapsed: boolean;
  /** Only while the person has Sales on. */
  needsSales: boolean;
  /**
   * The key the group's folds and choices are saved under. It stays
   * `work.projects` for the clients, for preference continuity.
   */
  preferenceKey: string;
}

export const BROWSE_GROUPS: Readonly<Record<BrowseGroup, BrowseGroupSpec>> = {
  envisioning: { subjectKind: 'project', list: 'envisioning', startsCollapsed: false, needsSales: false, preferenceKey: 'work.envisioning' },
  clients: { subjectKind: 'project', list: 'project', startsCollapsed: false, needsSales: false, preferenceKey: 'work.projects' },
  partners: { subjectKind: 'organization', list: null, startsCollapsed: true, needsSales: false, preferenceKey: 'work.partners' },
  events: { subjectKind: 'event', list: null, startsCollapsed: true, needsSales: false, preferenceKey: 'work.events' },
  sales: { subjectKind: 'lead', list: 'lead', startsCollapsed: true, needsSales: true, preferenceKey: 'work.leads' },
};

/** Whether Browse draws a group: every group, except the Sales one while the person has Sales off. */
export function browseGroupShown(group: BrowseGroup, salesEnabled: boolean): boolean {
  return !BROWSE_GROUPS[group].needsSales || salesEnabled;
}

/** The groups in the order Browse draws them. */
export const BROWSE_GROUP_ORDER: readonly BrowseGroup[] = SUBJECT_GROUPS;

/**
 * The records Browse lists beside the subjects (decided by MZ, 2026-11-05). They
 * have no subject page: web and Mac filter and edit, and the phones read. Each
 * shows while its work module is on. Titles stay with each client.
 */
export interface BrowseRecordGroupSpec {
  module: 'offers' | 'licenses';
  startsCollapsed: boolean;
  preferenceKey: string;
  /** What the group's filters narrow by, in the order they draw. */
  filters: readonly ('status' | 'product')[];
}

export const BROWSE_RECORD_GROUPS: Readonly<Record<'offers' | 'licenses', BrowseRecordGroupSpec>> = {
  offers: { module: 'offers', startsCollapsed: true, preferenceKey: 'work.offers', filters: ['status'] },
  licenses: { module: 'licenses', startsCollapsed: true, preferenceKey: 'work.licenses', filters: ['product', 'status'] },
};
