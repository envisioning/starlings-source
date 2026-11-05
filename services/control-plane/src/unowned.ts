import type { CrmIssue, CrmMyTask, CrmSubject, CrmTask, CrmUnownedSubject, CrmUnownedWorkResponse } from '@starlings/contracts/crm';
import { OPEN_TASK_STATUSES } from '@starlings/contracts';
import { planUnowned, type WorkHeldCardShape } from '@starlings/contracts/work-items';
import { issuesOf, openSubjects } from './board';
import { staleOnError, trackIssueCacheProjects } from './core-cache';
import { fetchCachedPartnerSubjects, fetchCrmTasksByStatus } from './crm';
import { emptyReadGaps, readFailureOf, settleReadGaps, type ReadGaps } from './read-gaps';

/** The statuses an open card can have; a proposal is INBOX's, never a card. */
const OPEN_STATUSES = OPEN_TASK_STATUSES;
/** Core's ceiling per page of the cross-subject read. */
const STATUS_PAGE = 100;
/** Ten pages a status is a thousand open tasks: past it the list says it is short. */
const STATUS_PAGES = 10;
const ISSUES_PER_PROJECT = 100;
/** Repo-linked projects read at once: Core rate-limits its GitHub projection. */
const ISSUE_CONCURRENCY = 3;

/**
 * Open work nobody on our side holds, across every subject (docs/BOARD.md
 * §Unowned): a task with no person that the client does not owe, and an
 * issue with no assignee and no `agent:*` stage. Answered in Mine's shapes,
 * so clients plan and draw the rows the way they draw Mine and never decide
 * again who counts as nobody.
 *
 * Tasks come from Core's cross-subject read, one paged read per open
 * status — not the board's read per open subject, which took minutes once
 * Core started answering 429 to the fan-out and timed the clients out.
 * Issues are still read per repo-linked project, from the same cache the
 * board uses; there are few of those.
 */
export async function fetchUnownedWork(env: Env): Promise<CrmUnownedWorkResponse> {
  const gaps = emptyReadGaps();
  const [subjects, partners] = await Promise.all([
    openSubjects(env, [], gaps),
    fetchCachedPartnerSubjects(env).catch((error: unknown) => {
      gaps.failed.push(readFailureOf('partners', error));
      warn('unowned.partners.failed', error);
      return [] as CrmSubject[];
    }),
  ]);
  const bySubject = new Map([...subjects, ...partners].map((subject) => [`${subject.kind}:${subject.id}`, subject]));

  const [taskRows, issueRows] = await Promise.all([
    Promise.all(OPEN_STATUSES.map((status) => tasksWithStatus(env, status, gaps))).then((pages) => pages.flat()),
    projectIssues(env, subjects, [], 'unowned', gaps).then((rows) => rows.filter((row) => row.issue.state === 'open')),
  ]);

  const tasks = new Map<string, { task: CrmTask; subject: CrmSubject }>();
  for (const task of taskRows) {
    // Only work on a subject that is still in play, as the board draws it.
    const subject = subjectOf(task, bySubject);
    if (subject) tasks.set(task.id, { task, subject });
  }
  const issues = new Map(issueRows.map((row) => [row.issue.id, row]));

  const cards: WorkHeldCardShape[] = [];
  for (const { task } of tasks.values()) {
    cards.push({
      id: task.id,
      origin: 'task',
      done: false,
      filed: true,
      dueDate: task.due_date,
      updatedAt: task.updated_at,
      githubRef: task.github_owner && task.github_repo && task.github_issue_number
        ? `${task.github_owner}/${task.github_repo}#${task.github_issue_number}`
        : null,
      status: task.status,
      assignee: task.assignee_id ?? task.assignee_email ?? null,
      responsibleParty: task.responsible_party,
    });
  }
  for (const { issue } of issues.values()) {
    cards.push({
      id: issue.id,
      origin: 'issue',
      done: issue.state === 'closed',
      filed: true,
      updatedAt: issue.updated_at,
      state: issue.state,
      ...(issue.state_reason !== undefined ? { stateReason: issue.state_reason } : {}),
      labels: issue.labels,
      // Older Core rows carry only the single `assignee_login`.
      assignees: [
        ...(issue.assignees ?? []).map((assignee) => assignee.login),
        ...(issue.assignee_login ? [issue.assignee_login] : []),
      ],
    });
  }

  const issueSubjects: Record<string, CrmUnownedSubject> = {};
  const out: CrmUnownedWorkResponse = { tasks: [], issues: [], issue_subjects: issueSubjects, ...settleReadGaps(gaps) };
  for (const card of planUnowned(cards, Date.now())) {
    if (card.origin === 'task') {
      const found = tasks.get(card.id);
      if (found) out.tasks.push(myTask(found.task, found.subject));
      continue;
    }
    const found = issues.get(card.id);
    if (!found) continue;
    out.issues.push(found.issue);
    issueSubjects[found.issue.id] = { kind: found.project.kind, id: found.project.id, title: found.project.title };
  }
  return out;
}

/**
 * One open status across every subject, paged until a short page. A page
 * Core will not answer serves its last-known copy (`staleOnError`); with no
 * copy the status is named in `failed` and the list goes on without it.
 */
async function tasksWithStatus(env: Env, status: string, gaps: ReadGaps): Promise<CrmTask[]> {
  const rows: CrmTask[] = [];
  try {
    for (let page = 0; page < STATUS_PAGES; page += 1) {
      const offset = page * STATUS_PAGE;
      const found = await staleOnError(`tasks-status/${status}/${offset}`, () => fetchCrmTasksByStatus(env, status, STATUS_PAGE, offset));
      rows.push(...found);
      if (found.length < STATUS_PAGE) return rows;
    }
    gaps.truncated.push(`${status} tasks past ${STATUS_PAGE * STATUS_PAGES}`);
  } catch (error) {
    gaps.failed.push(readFailureOf(`${status} tasks`, error));
    warn('unowned.tasks.failed', error);
  }
  return rows;
}

/**
 * Every issue on the repo-linked projects among `subjects`, open and recently
 * closed, each with the project it was read for; a shared repository's issue
 * is drawn once, on the first project. The cached per-project read the board
 * uses — there are few such projects. Exported for recently-closed.ts.
 */
export async function projectIssues(
  env: Env,
  subjects: CrmSubject[],
  partial: string[],
  logPrefix: string,
  /** With it, a cap hit is `truncated` and a failure carries its cause; without, both are names in `partial`. */
  gaps?: ReadGaps,
): Promise<Array<{ issue: CrmIssue; project: CrmSubject }>> {
  const projects = subjects.filter((subject) => subject.kind === 'project' && subject.has_repo !== false);
  await trackIssueCacheProjects(projects.map((project) => project.id));
  const seen = new Set<string>();
  const out: Array<{ issue: CrmIssue; project: CrmSubject }> = [];
  for (let start = 0; start < projects.length; start += ISSUE_CONCURRENCY) {
    const batch = projects.slice(start, start + ISSUE_CONCURRENCY);
    const pages = await Promise.all(batch.map((project) => issuesOf(env, project).then((rows) => {
      if (rows.length >= ISSUES_PER_PROJECT) (gaps ? gaps.truncated : partial).push(project.title);
      return rows.map((issue) => ({ issue, project }));
    }).catch((error: unknown) => {
      if (gaps) gaps.failed.push(readFailureOf(project.title, error));
      else partial.push(project.title);
      warn(`${logPrefix}.issues.failed`, error, project);
      return [];
    })));
    for (const row of pages.flat()) {
      if (seen.has(row.issue.id)) continue;
      seen.add(row.issue.id);
      out.push(row);
    }
  }
  return out;
}

/** The open subject a task is filed on, or nothing when that subject is not in play. */
function subjectOf(task: CrmTask, bySubject: ReadonlyMap<string, CrmSubject>): CrmSubject | undefined {
  if (task.project_id) return bySubject.get(`project:${task.project_id}`);
  if (task.lead_id) return bySubject.get(`lead:${task.lead_id}`);
  if (task.event_id) return bySubject.get(`event:${task.event_id}`);
  // A partner's own task hangs off the organization alone.
  if (task.organization_id && !task.meeting_id && !task.signals_account_id) return bySubject.get(`organization:${task.organization_id}`);
  return undefined;
}

/** A task in Mine's row shape, with its subject's title. */
function myTask(task: CrmTask, subject: CrmSubject): CrmMyTask {
  return {
    id: task.id,
    title: task.title,
    notes: task.notes,
    status: task.status,
    responsible_party: task.responsible_party,
    due_date: task.due_date,
    priority: task.priority ?? null,
    project_id: task.project_id,
    lead_id: task.lead_id,
    event_id: task.event_id ?? null,
    organization_id: task.organization_id ?? null,
    meeting_id: task.meeting_id ?? null,
    signals_account_id: task.signals_account_id ?? null,
    subject_title: subject.title,
    github_owner: task.github_owner ?? null,
    github_repo: task.github_repo ?? null,
    github_issue_number: task.github_issue_number ?? null,
    updated_at: task.updated_at,
  };
}

function warn(message: string, error: unknown, subject?: Pick<CrmSubject, 'kind' | 'id' | 'title'>): void {
  console.warn(JSON.stringify({
    level: 'warn',
    message,
    ...(subject ? { subjectKind: subject.kind, subjectId: subject.id, subjectTitle: subject.title } : {}),
    error: error instanceof Error ? error.message : 'Unknown error',
  }));
}
