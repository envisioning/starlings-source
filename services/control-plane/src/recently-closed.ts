import type {
  CrmIssue,
  CrmRecentlyClosedItem,
  CrmRecentlyClosedWorkResponse,
  CrmSubject,
  CrmTask,
} from '@starlings/contracts/crm';
import { taskKey, type SubjectAccessView } from './subject-access';
import { hiddenRepos, issueVisible } from './subject-access-filters';
import { FINISHED_TASK_STATUSES } from '@starlings/contracts';
import { recentlyClosed, type WorkCardShape } from '@starlings/contracts/work-items';
import { BOARD_FINISHED_WINDOW_MS, openSubjects } from './board';
import { staleOnError } from './core-cache';
import { fetchCachedPartnerSubjects, fetchCrmMyWork, fetchCrmTasksByStatus } from './crm';
import { projectIssues } from './unowned';

/** The statuses a finished task can have; a declined proposal is a deliberate answer, not recoverable work. */
const FINISHED_STATUSES = FINISHED_TASK_STATUSES;
/** Core's ceiling per page of the cross-subject read. */
const STATUS_PAGE = 100;
/** Pages are newest first and stop at the window; this only caps a week with an unusual pile. */
const STATUS_PAGES = 10;

type Source =
  | { kind: 'task'; task: CrmTask; subjectTitle: string | null }
  | { kind: 'issue'; issue: CrmIssue; project: CrmSubject };

/**
 * The signed-in member's own finished work from the last seven days. The
 * shared WorkItems rule puts tasks and issues in one newest-first order;
 * the client never rebuilds that list or decides what counts as finished.
 *
 * Tasks come from Core's cross-subject read of each finished status, which
 * Core answers newest first, so paging stops at the window. This used to be
 * the board's read — once per open subject — which took minutes once Core
 * answered the fan-out with 429s, and the clients timed out (2026-10-01).
 * Issues come from the cached per-project read, on repo-linked projects.
 */
export async function fetchRecentlyClosedWork(
  env: Env,
  ownerEmail: string,
  access?: SubjectAccessView,
): Promise<CrmRecentlyClosedWorkResponse> {
  const finishedSince = Date.now() - BOARD_FINISHED_WINDOW_MS;
  const partial: string[] = [];
  const [mine, subjects, partners] = await Promise.all([
    fetchCrmMyWork(env, ownerEmail),
    openSubjects(env, partial),
    fetchCachedPartnerSubjects(env).catch(() => {
      partial.push('partners');
      return [] as CrmSubject[];
    }),
  ]);
  const titles = new Map([...subjects, ...partners].map((subject) => [subject.id, subject.title]));

  const mineEmail = ownerEmail.trim().toLowerCase();
  const mineLogin = mine.github_login?.trim().toLowerCase() ?? '';
  const [taskRows, issueRows] = await Promise.all([
    Promise.all(FINISHED_STATUSES.map((status) => finishedTasks(env, status, finishedSince, partial))).then((pages) => pages.flat()),
    mineLogin ? projectIssues(env, subjects, partial, 'recently_closed') : Promise.resolve([]),
  ]);

  const sources = new Map<string, Source>();
  const cards: WorkCardShape[] = [];

  // docs/ACCESS.md: a closed item on a subject the member no longer reaches
  // is not theirs to undo. Filtered here, where the task still carries its key.
  const hiddenRepoSet = access ? await hiddenRepos(env, access) : new Set<string>();
  for (const task of taskRows) {
    if ((task.assignee_email ?? '').trim().toLowerCase() !== mineEmail) continue;
    const on = taskKey(task);
    if (access && on && !access.canSee(on.kind, on.id)) continue;
    const subjectID = task.project_id ?? task.lead_id ?? task.event_id ?? task.meeting_id ?? task.organization_id ?? null;
    // A subject no longer open still holds the task; it reads without a title.
    sources.set(`task:${task.id}`, { kind: 'task', task, subjectTitle: subjectID ? titles.get(subjectID) ?? null : null });
    cards.push({
      id: task.id,
      origin: 'task',
      done: true,
      filed: Boolean(subjectID),
      dueDate: task.due_date,
      updatedAt: task.updated_at,
      githubRef: task.github_owner && task.github_repo && task.github_issue_number
        ? `${task.github_owner}/${task.github_repo}#${task.github_issue_number}`
        : null,
      status: task.status,
    });
  }

  for (const { issue, project } of issueRows) {
    if (issue.state !== 'closed') continue;
    if (access && (!access.canSee(project.kind, project.id) || !issueVisible(issue, hiddenRepoSet))) continue;
    const assigned = issue.assignee_login?.trim().toLowerCase() === mineLogin ||
      issue.assignees?.some((assignee) => assignee.login.trim().toLowerCase() === mineLogin) === true;
    if (!assigned) continue;
    sources.set(`issue:${issue.id}`, { kind: 'issue', issue, project });
    cards.push({
      id: issue.id,
      origin: 'issue',
      done: true,
      filed: true,
      updatedAt: issue.updated_at,
      state: issue.state,
      ...(issue.state_reason !== undefined ? { stateReason: issue.state_reason } : {}),
      labels: issue.labels,
    });
  }

  const items: CrmRecentlyClosedItem[] = [];
  for (const card of recentlyClosed(cards, finishedSince)) {
    const source = sources.get(`${card.origin}:${card.id}`);
    if (!source) continue;
    if (source.kind === 'task') {
      items.push({
        kind: 'task',
        id: source.task.id,
        title: source.task.title,
        subject_title: source.subjectTitle,
        project_id: source.task.project_id ?? null,
        updated_at: source.task.updated_at,
        issue: null,
      });
      continue;
    }
    items.push({
      kind: 'issue',
      id: source.issue.id,
      title: source.issue.title,
      subject_title: source.project.title,
      project_id: source.project.id,
      updated_at: source.issue.updated_at,
      issue: source.issue,
    });
  }

  return { items, partial: [...new Set(partial)] };
}

/**
 * One finished status across every subject, newest first, until a row older
 * than the window or a short page. A page Core will not answer serves its
 * last-known copy; with none, the status is named in `partial`.
 */
async function finishedTasks(env: Env, status: string, sinceMs: number, partial: string[]): Promise<CrmTask[]> {
  const rows: CrmTask[] = [];
  try {
    for (let page = 0; page < STATUS_PAGES; page += 1) {
      const offset = page * STATUS_PAGE;
      const found = await staleOnError(`tasks-status/${status}/${offset}`, () => fetchCrmTasksByStatus(env, status, STATUS_PAGE, offset));
      rows.push(...found);
      const oldest = found.at(-1)?.updated_at;
      const pastWindow = oldest ? Date.parse(oldest) < sinceMs : false;
      if (found.length < STATUS_PAGE || pastWindow) return rows;
    }
    partial.push(`${status} tasks past ${STATUS_PAGE * STATUS_PAGES}`);
  } catch {
    partial.push(`${status} tasks`);
  }
  return rows;
}
