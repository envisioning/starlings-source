/**
 * The views of one subject, in the order every client offers them, with the
 * word each goes by. The ids are also the `?pane=` grammar of a Work URL.
 *
 * Every client draws them as one row of tabs in the subject header
 *. Which panes a kind has, and what each needs, is decided here
 * once: the web reads this table, and the generator writes the Swift
 * `SubjectPane` with its layout (`Sources/Generated/SubjectPanesRegistry.swift`).
 */

import { SUBJECT_KINDS, type SubjectKind } from './subject-kinds';

export const SUBJECT_PANES = [
  { id: 'overview', title: 'Overview' },
  { id: 'talk', title: 'Talk' },
  { id: 'tasks', title: 'Tasks' },
  { id: 'issues', title: 'Issues' },
  // A project's tasks and issues by stage (docs/BOARD.md).
  { id: 'board', title: 'Board' },
  // Durable CRM interactions.
  { id: 'interactions', title: 'History' },
  { id: 'fields', title: 'Fields' },
  { id: 'documents', title: 'Documents' },
  // The partner's own page (PARTNERS (HQ Docs)).
  { id: 'partner', title: 'Partner' },
  // The event's own page (docs/EVENTS.md).
  { id: 'event', title: 'Event' },
] as const;

export type SubjectPaneId = (typeof SUBJECT_PANES)[number]['id'];
export const SUBJECT_PANE_IDS: readonly SubjectPaneId[] = SUBJECT_PANES.map((pane) => pane.id);

export function subjectPaneTitle(id: SubjectPaneId): string {
  return SUBJECT_PANES.find((pane) => pane.id === id)!.title;
}

/**
 * The tabs of each kind, left to right. A partner and an event lead with
 * their own page. Issues stay a project's; an event has no history and its
 * fields are the CMS row its page edits (docs/EVENTS.md). An event has no
 * Documents: Docs files a document only under `DOCS_SUBJECT_KINDS`, and its
 * own subject table refuses `event`.
 */
export const SUBJECT_PANE_LAYOUT: Readonly<Record<SubjectKind, readonly SubjectPaneId[]>> = {
  project: ['overview', 'talk', 'board', 'tasks', 'issues', 'interactions', 'documents', 'fields'],
  lead: ['overview', 'talk', 'tasks', 'interactions', 'documents', 'fields'],
  organization: ['overview', 'partner', 'talk', 'tasks', 'interactions', 'documents', 'fields'],
  event: ['overview', 'event', 'talk', 'tasks'],
};

/**
 * What a pane needs before it is a tab:
 * - `repo`: a linked GitHub repository.
 * - `narrow`: a narrow screen. On a wide one Talk is half of Overview.
 * - `core`: the workspace has Core. No pane needs it since Fields reads and
 *   writes through the Worker on both stores.
 * - `docs`: the workspace has Docs.
 */
export const SUBJECT_PANE_NEEDS_LIST = ['repo', 'narrow', 'core', 'docs'] as const;
export type SubjectPaneNeed = (typeof SUBJECT_PANE_NEEDS_LIST)[number];

export const SUBJECT_PANE_NEEDS: Readonly<Partial<Record<SubjectPaneId, SubjectPaneNeed>>> = {
  issues: 'repo',
  talk: 'narrow',
  documents: 'docs',
};

/** The tabs one subject shows, in order. */
export function subjectPanes(kind: SubjectKind, has: Readonly<Partial<Record<SubjectPaneNeed, boolean>>>): SubjectPaneId[] {
  return SUBJECT_PANE_LAYOUT[kind].filter((pane) => {
    const need = SUBJECT_PANE_NEEDS[pane];
    return need === undefined || has[need] === true;
  });
}

/**
 * The pane a request lands on. A pane the subject does not have lands on
 * Overview; Talk on a wide screen is Overview, where Talk stands.
 */
export function subjectPaneOrOverview(
  pane: SubjectPaneId,
  kind: SubjectKind,
  has: Readonly<Partial<Record<SubjectPaneNeed, boolean>>>,
): SubjectPaneId {
  return subjectPanes(kind, has).includes(pane) ? pane : 'overview';
}

export { SUBJECT_KINDS as SUBJECT_PANE_KINDS };
