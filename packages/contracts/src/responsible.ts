import { OPEN_TASK_STATUSES } from './index';

/**
 * Who answers for a project or a lead (docs/OWNERSHIP.md). A name,
 * never a permission: nothing reads it to decide what a person may see or do.
 * The chosen person is stored (Core's, or a D1 workspace's, `responsible_email`);
 * when nobody chose, the subject shows a suggestion and says it is one.
 * Pinned by fixtures/responsible.json, which the Swift port reads too.
 */
export type ResponsibleSource = 'chosen' | 'suggested';

export interface Responsible {
  email: string;
  source: ResponsibleSource;
}

export interface ResponsibleSubjectShape {
  kind: string;
  responsible_email?: string | null;
}

export interface ResponsibleTaskShape {
  assignee_email?: string | null;
  status?: string | null;
}

const OPEN = new Set<string>(OPEN_TASK_STATUSES);

/** The chosen person, else the one assigned the most open tasks, else null. Pure. */
export function responsibleOf(subject: ResponsibleSubjectShape, openTasks: readonly ResponsibleTaskShape[]): Responsible | null {
  if (subject.kind !== 'project' && subject.kind !== 'lead') return null;
  const chosen = subject.responsible_email?.trim().toLowerCase();
  if (chosen) return { email: chosen, source: 'chosen' };
  const counts = new Map<string, number>();
  for (const task of openTasks) {
    const email = task.assignee_email?.trim().toLowerCase();
    if (!email || !OPEN.has(task.status ?? '')) continue;
    counts.set(email, (counts.get(email) ?? 0) + 1);
  }
  let best: string | null = null;
  let most = 0;
  for (const [email, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    if (count > most) { best = email; most = count; }
  }
  return best ? { email: best, source: 'suggested' } : null;
}
