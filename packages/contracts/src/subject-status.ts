/**
 * The status words a project or a lead can hold, and the choices built from
 * them, decided once.
 *
 * Core owns the words (`crmProjectStatusSchema`, `crmLeadStatusSchema`). What
 * the clients did on their own was list them again: the editor's dropdown,
 * Browse's status filter and its default, and the Worker's idea of "open work".
 * Seven copies, on the Mac, iOS, web and the Worker. This table is the one
 * list. It is rule input, not a wire shape: Swift mirrors it
 * (`Sources/SubjectStatus.swift`) and `fixtures/subject-status.json` pins the
 * mirror.
 *
 * Labels stay with each client; a status word is a wire value and stays
 * English on the wire. A partner and an event have no status here.
 */

import { crmLeadStatusSchema, crmProjectStatusSchema } from './index';

export const SUBJECT_STATUS_KINDS = ['project', 'lead'] as const;
export type SubjectStatusKind = (typeof SUBJECT_STATUS_KINDS)[number];

export interface SubjectStatusChoices {
  /** Core's own words, in its order: the editor's dropdown. */
  statuses: readonly string[];
  /** Where the subject is still work; what the board and Browse's `open` read. */
  open: readonly string[];
  /**
   * Where the work is done: every status not in `open`. A closed lead (won or
   * lost, ADR 0008 decision 10) leaves the default lists, the pickers and the
   * counts, and Win does not show on it.
   */
  closed: readonly string[];
  /**
   * Browse's status filter. `open` and `all` are product choices, not Core
   * statuses: `open` keeps the default project view useful while Archived
   * stays an explicit choice.
   */
  filter: readonly string[];
  /** What Browse opens on until the person picks another; what the Worker answers with no `status`. */
  defaultFilter: string;
  /** What a new subject starts as. */
  defaultStatus: string;
}

const PROJECT = crmProjectStatusSchema.options;
const LEAD = crmLeadStatusSchema.options;

export const SUBJECT_STATUS_CHOICES: Readonly<Record<SubjectStatusKind, SubjectStatusChoices>> = {
  project: {
    statuses: PROJECT,
    open: ['Active', 'Paused'],
    closed: ['Archived'],
    filter: ['open', ...PROJECT, 'all'],
    defaultFilter: 'open',
    defaultStatus: 'Active',
  },
  lead: {
    statuses: LEAD,
    open: ['Conversations', 'Opportunity Identified', 'Proposal Out', 'Active Negotiation', 'Waiting on External Factor'],
    closed: ['Closed Won', 'Closed Lost'],
    filter: ['open', ...LEAD, 'all'],
    defaultFilter: 'open',
    defaultStatus: 'Conversations',
  },
};

/** Whether a project or lead is closed. Unknown or absent status reads as open. */
export function isSubjectClosed(kind: string, status: string | null | undefined): boolean {
  if (!status || (kind !== 'project' && kind !== 'lead')) return false;
  return SUBJECT_STATUS_CHOICES[kind].closed.includes(status);
}

/**
 * An organization's relationships (ADR 0006 decision 2), from its
 * related projects and leads, its partnership and existing-client marks, and
 * whether it holds an active license. The Worker sends the answer on the
 * organization's detail; no client works it out again.
 */
export function organizationRelationships(input: {
  is_partner?: boolean | null | undefined;
  is_existing_client?: boolean | null | undefined;
  projects: readonly { status: string | null }[];
  leads: readonly { status: string | null }[];
  activeLicense: boolean;
}): Array<'client' | 'partner' | 'prospect'> {
  const out: Array<'client' | 'partner' | 'prospect'> = [];
  if (input.activeLicense || input.is_existing_client === true || input.projects.some((project) => !isSubjectClosed('project', project.status))) out.push('client');
  if (input.is_partner === true) out.push('partner');
  if (input.leads.some((lead) => !isSubjectClosed('lead', lead.status))) out.push('prospect');
  return out;
}
