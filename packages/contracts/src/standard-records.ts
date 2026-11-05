/**
 * Starlings' records as the Starlings Subject Spec's records (ADR 0005).
 *
 * Starlings' wire shapes carry Core's columns: a task hangs off one of four
 * ids, its date is a timestamp. The spec's records are neutral: a task names
 * `subject_kind` and `subject_id`, its date is a day. These projections are
 * the one place the two meet. `pnpm standard:check` runs them over
 * `fixtures/responses/` and validates the result against the spec's schemas,
 * so a change to the wire that breaks the spec fails the gate.
 */
import type { SubjectKind } from '@starlings/subject-spec/kinds';
import { TASK_STATUSES, type Subject, type Task, type TaskStatus } from '@starlings/subject-spec/schema';
import type { CrmSubject, CrmTask } from './crm';

/**
 * The subject a task sits on, or null. Core sets exactly one of project,
 * lead or event; it also echoes the organization on tasks that hang off
 * something else (a Signals account's included), so the organization names a
 * partner only when nothing else holds the task.
 */
export function taskSubject(task: {
  project_id?: string | null | undefined;
  lead_id?: string | null | undefined;
  event_id?: string | null | undefined;
  organization_id?: string | null | undefined;
  meeting_id?: string | null | undefined;
  signals_account_id?: string | null | undefined;
}): { kind: SubjectKind; id: string } | null {
  if (task.project_id) return { kind: 'project', id: task.project_id };
  if (task.lead_id) return { kind: 'lead', id: task.lead_id };
  if (task.event_id) return { kind: 'event', id: task.event_id };
  if (task.organization_id && !task.meeting_id && !task.signals_account_id) return { kind: 'organization', id: task.organization_id };
  return null;
}

export function toStandardSubject(subject: CrmSubject): Subject {
  return {
    id: subject.id,
    kind: subject.kind,
    title: subject.title,
    subtitle: subject.subtitle ?? null,
    ...(subject.last_activity_at !== undefined ? { last_activity_at: subject.last_activity_at } : {}),
  };
}

const isTaskStatus = (value: string): value is TaskStatus => (TASK_STATUSES as readonly string[]).includes(value);

/**
 * The task as the spec's record, or null when Core sent a status the spec
 * does not name. A field Core left out reads as null: some Core responses omit
 * the assignee rather than sending null.
 */
export function toStandardTask(task: CrmTask): Task | null {
  if (!isTaskStatus(task.status)) return null;
  const subject = taskSubject(task);
  const day = /^(\d{4}-\d{2}-\d{2})/u.exec(task.due_date ?? '')?.[1] ?? null;
  return {
    id: task.id,
    title: task.title,
    notes: task.notes ?? null,
    status: task.status,
    subject_kind: subject?.kind ?? null,
    subject_id: subject?.id ?? null,
    assignee_name: task.assignee_name ?? null,
    assignee_email: task.assignee_email ?? null,
    due_date: day,
    goal_id: task.goal_id ?? null,
    updated_at: task.updated_at ?? null,
  };
}
