/**
 * The groups of a subject's Overview, beside its Talk: which ones each kind
 * has, in what order, what each needs, and which tab its "Show all" opens.
 *
 * Each client used to write this list itself, and the three copies drifted
 *: an event's Documents on the Mac only, Issues on iOS when a
 * project merely had issues. This table is that decision. It is rule input,
 * not a wire shape: the web reads it, and the generator writes the Swift
 * `SubjectOverviewGroup` (`Sources/Generated/SubjectOverviewGroupsRegistry.swift`),
 * pinned by `fixtures/subject-overview-groups.json`.
 *
 * Titles, rows and what a group draws stay with each client. A group with
 * nothing to show may draw nothing: Answers without a form, Related without
 * an edge. Contacts draws on every kind that has it, empty or not, so a
 * person can add the first one.
 */

import { SUBJECT_KINDS, type SubjectKind } from './subject-kinds';
import type { SubjectPaneId } from './subject-panes';

export const SUBJECT_OVERVIEW_GROUPS = [
  'goals',
  // The form answers that filed a lead (docs/FORMS.md).
  'submission',
  'tasks',
  'issues',
  // The people on it: an organization's contacts, a project's, a lead's contact.
  'contacts',
  // A lead's and an organization's offers and licences, behind their work modules.
  'offers',
  'licenses',
  'decisions',
  'documents',
  'history',
  // A partner's projects and leads; a lead's projects and a project's lead (ADR 0008).
  'related',
] as const;

export type SubjectOverviewGroup = (typeof SUBJECT_OVERVIEW_GROUPS)[number];

/** Top to bottom, per subject kind. */
export const SUBJECT_OVERVIEW_LAYOUT: Readonly<Record<SubjectKind, readonly SubjectOverviewGroup[]>> = {
  project: ['goals', 'tasks', 'issues', 'contacts', 'decisions', 'documents', 'history', 'related'],
  lead: ['submission', 'tasks', 'contacts', 'offers', 'licenses', 'decisions', 'documents', 'history', 'related'],
  organization: ['tasks', 'contacts', 'offers', 'licenses', 'decisions', 'documents', 'history', 'related'],
  // No history until Core files meetings under an event (docs/EVENTS.md), and
  // no documents: Docs has no event subject (`DOCS_SUBJECT_KINDS`).
  event: ['tasks', 'decisions'],
};

/**
 * What a group needs before it is drawn: a linked repository, Docs, or a
 * work module the workspace has on (`work_modules` in the subject state).
 */
export const SUBJECT_OVERVIEW_NEEDS_LIST = ['repo', 'docs', 'offers', 'licenses'] as const;
export type SubjectOverviewNeed = (typeof SUBJECT_OVERVIEW_NEEDS_LIST)[number];

export const SUBJECT_OVERVIEW_NEEDS: Readonly<Partial<Record<SubjectOverviewGroup, SubjectOverviewNeed>>> = {
  issues: 'repo',
  documents: 'docs',
  offers: 'offers',
  licenses: 'licenses',
};

/**
 * The tab a group's "Show all" opens. A group without one shows all it has:
 * goals settle in place, answers and related subjects are short.
 */
export const SUBJECT_OVERVIEW_SHOW_ALL: Readonly<Partial<Record<SubjectOverviewGroup, SubjectPaneId>>> = {
  tasks: 'tasks',
  issues: 'issues',
  decisions: 'interactions',
  documents: 'documents',
  history: 'interactions',
};

/** The groups one subject draws, in order. */
export function subjectOverviewGroups(
  kind: SubjectKind,
  has: Readonly<Partial<Record<SubjectOverviewNeed, boolean>>>,
): SubjectOverviewGroup[] {
  return SUBJECT_OVERVIEW_LAYOUT[kind].filter((group) => {
    const need = SUBJECT_OVERVIEW_NEEDS[group];
    return need === undefined || has[need] === true;
  });
}

export { SUBJECT_KINDS as SUBJECT_OVERVIEW_KINDS };
