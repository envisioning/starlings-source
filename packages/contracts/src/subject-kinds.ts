/**
 * What each subject kind can receive, decided once.
 *
 * A subject is a project, a lead, an organization, or an event. Whether one can hold
 * tasks, GitHub issues, documents, hosted meetings, calendar events, a Slack
 * channel or Granola filing used to be decided again in every picker, schema
 * and switch, which is how adding partners left gaps. This table is that
 * decision. It is rule input, not a wire shape: the web reads it, and the Swift
 * table (`Sources/Generated/SubjectKindsRegistry.swift`) and
 * fixtures/subject-kinds.json are generated from it (`pnpm registries:gen`).
 *
 * Adding a kind or a capability starts here.
 */

import { SUBJECT_KINDS, type SubjectKind } from '@starlings/subject-spec/kinds';

/** The kinds themselves are the open standard's (ADR 0005); what each one receives is decided here. */
export { SUBJECT_KINDS, SUBJECT_KIND_ALIASES, isSubjectKind, readSubjectKind, type SubjectKind } from '@starlings/subject-spec/kinds';

/**
 * The word for each kind, on every client: a picker tab, a row's context, a
 * search result. The web draws it through `t()`; the generator writes the
 * Swift `SubjectKind.label`.
 */
export const SUBJECT_KIND_LABELS: Record<SubjectKind, string> = {
  project: 'Project',
  lead: 'Lead',
  // Every organization is a subject (ADR 0006), and Work lists them all
  // with Partner as a filter.
  organization: 'Organization',
  event: 'Event',
};

/** The Core column a task on this subject sets. Exactly one per task. */
export type SubjectTaskField = 'project_id' | 'lead_id' | 'event_id' | 'organization_id';

/** The kind Docs files a document under. An organization files as itself. */
export type SubjectDocsKind = 'project' | 'lead' | 'organization';

export interface SubjectKindCapabilities {
  tasks: { field: SubjectTaskField };
  /** GitHub issues attach to a project only. */
  issues: boolean;
  documents: { docsKind: SubjectDocsKind } | null;
  /** The meeting kind a meeting is filed under; `hosted` when Meet can host one here. */
  meetings: { kind: SubjectKind; hosted: boolean } | null;
  calendarEvents: boolean;
  slack: boolean;
  granola: boolean;
  /** Every subject has a Talk channel. */
  talk: true;
}

/** Names of the boolean-ish capabilities `subjectKindsWith` can filter on. */
export const SUBJECT_CAPABILITIES = ['tasks', 'issues', 'documents', 'meetings', 'hostedMeetings', 'calendarEvents', 'slack', 'granola', 'talk'] as const;
export type SubjectCapability = (typeof SUBJECT_CAPABILITIES)[number];

export const SUBJECT_KIND_CAPABILITIES: Readonly<Record<SubjectKind, SubjectKindCapabilities>> = {
  project: {
    tasks: { field: 'project_id' },
    issues: true,
    documents: { docsKind: 'project' },
    meetings: { kind: 'project', hosted: true },
    calendarEvents: true,
    slack: true,
    granola: true,
    talk: true,
  },
  lead: {
    tasks: { field: 'lead_id' },
    issues: false,
    documents: { docsKind: 'lead' },
    meetings: { kind: 'lead', hosted: true },
    calendarEvents: true,
    slack: true,
    granola: true,
    talk: true,
  },
  organization: {
    tasks: { field: 'organization_id' },
    issues: false,
    documents: { docsKind: 'organization' },
    meetings: { kind: 'organization', hosted: true },
    calendarEvents: true,
    slack: true,
    granola: true,
    talk: true,
  },
  event: {
    tasks: { field: 'event_id' },
    issues: false,
    documents: null,
    meetings: { kind: 'event', hosted: false },
    calendarEvents: false,
    slack: false,
    granola: false,
    talk: true,
  },
};

export function subjectHas(kind: SubjectKind, capability: SubjectCapability): boolean {
  const caps = SUBJECT_KIND_CAPABILITIES[kind];
  switch (capability) {
    case 'hostedMeetings':
      return caps.meetings?.hosted === true;
    case 'tasks':
      return true;
    case 'talk':
      return true;
    case 'issues':
    case 'calendarEvents':
    case 'slack':
    case 'granola':
      return caps[capability];
    case 'documents':
    case 'meetings':
      return caps[capability] !== null;
  }
}

/** The subject kinds that have a capability, in `SUBJECT_KINDS` order. */
export function subjectKindsWith(capability: SubjectCapability): SubjectKind[] {
  return SUBJECT_KINDS.filter((kind) => subjectHas(kind, capability));
}

export function taskFieldFor(kind: SubjectKind): SubjectTaskField {
  return SUBJECT_KIND_CAPABILITIES[kind].tasks.field;
}

/** The Docs kind a subject's documents file under, or null when it has none. */
export function docsKindFor(kind: SubjectKind): SubjectDocsKind | null {
  return SUBJECT_KIND_CAPABILITIES[kind].documents?.docsKind ?? null;
}
