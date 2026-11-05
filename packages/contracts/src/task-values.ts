/**
 * Core task statuses and who a task is on, with the word each client shows.
 * The lists: `crmTaskStatusSchema` and `crmResponsiblePartySchema` in
 * `index.ts`, the web's `STATUS_LABEL` and `RESPONSIBLE_LABEL`, and the Swift
 * `CrmTaskStatus` and `CrmTaskResponsible` (generated into
 * `Sources/Generated/TaskValuesRegistry.swift`) read it.
 */
import { TASK_STATUSES } from '@starlings/subject-spec/schema';

/** The statuses are the open standard's (ADR 0005); the words are decided here. */
export const CRM_TASK_STATUSES = TASK_STATUSES;
export type CrmTaskStatusId = (typeof CRM_TASK_STATUSES)[number];

export const CRM_TASK_STATUS_LABELS: Record<CrmTaskStatusId, string> = {
  pending: 'Pending',
  in_progress: 'In progress',
  // The two columns the board has that Core's task table did not (docs/BOARD.md).
  review: 'In review',
  blocked: 'Blocked',
  completed: 'Done',
  cancelled: 'Cancelled',
  // Core proposed it from a CRM event; accept makes it pending, decline keeps
  // it as declined so the event cannot propose it twice.
  proposed: 'Proposed',
  declined: 'Declined',
};

export const CRM_RESPONSIBLE_PARTIES = ['team', 'client', 'unassigned'] as const;
export type CrmResponsiblePartyId = (typeof CRM_RESPONSIBLE_PARTIES)[number];

export const CRM_RESPONSIBLE_LABELS: Record<CrmResponsiblePartyId, string> = {
  // The workspace's own side. Clients draw the workspace's name for it; this
  // word is for readers without one.
  team: 'Team',
  client: 'Client',
  unassigned: 'Unassigned',
};
