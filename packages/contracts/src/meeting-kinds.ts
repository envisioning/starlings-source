import type { SubjectKind } from './subject-kinds';

/**
 * How a meeting is filed in Core (Envisioning-only; guests never see it).
 * The one list: `meetingKindSchema` in `index.ts`, the web's filing labels
 * and the Swift `MeetingCategoryKind` (generated into
 * `Sources/Generated/MeetingKindsRegistry.swift`) all read it.
 */
export const MEETING_KINDS = ['uncategorized', 'status', 'lead', 'project', 'internal', 'partner', 'event', 'personal'] as const;
export type MeetingKindId = (typeof MEETING_KINDS)[number];

export interface MeetingKindSpec {
  kind: MeetingKindId;
  /** The word every filing menu shows. */
  label: string;
  /** The subject a meeting of this kind is filed on, or null when it takes none. */
  subject: SubjectKind | null;
}

export const MEETING_KIND_SPECS: readonly MeetingKindSpec[] = [
  // Not decided yet: the one inbox of the filing queue.
  { kind: 'uncategorized', label: 'Unfiled', subject: null },
  { kind: 'status', label: 'Status', subject: null },
  { kind: 'lead', label: 'Lead', subject: 'lead' },
  { kind: 'project', label: 'Project', subject: 'project' },
  { kind: 'internal', label: 'Internal', subject: null },
  // A meeting with an organization; the subject is the organization itself
  // (`partner_organization_id`). The id stays `partner`: it is Core's filing
  // value (ADR 0006).
  { kind: 'partner', label: 'Partner', subject: 'organization' },
  // About a CMS event, before or after it (`event_id`).
  { kind: 'event', label: 'Event', subject: 'event' },
  // Not company business: the row stays in Core with no subject and on no
  // timeline. The terminal that empties the filing queue without a "misc"
  // bucket.
  { kind: 'personal', label: 'Personal', subject: null },
];

export function meetingKindSpec(kind: MeetingKindId): MeetingKindSpec {
  return MEETING_KIND_SPECS.find((spec) => spec.kind === kind)!;
}
