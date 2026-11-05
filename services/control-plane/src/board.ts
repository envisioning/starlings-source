// Every card at once, for the board (docs/BOARD.md).
//
// Core answers work one subject at a time — tasks by project or lead, issues
// by project — and the board wants all of it in one read. So this is a
// fan-out: the open subjects first, then their tasks and issues in parallel,
// then the last event line on each card out of `card_trace`. Nothing is
// merged or staged here; the client deals the rows into columns with the one
// shared `planBoard`, exactly as Mine deals them into sections.
//
// Failures are per subject and named, never fatal. A project Core would not
// answer for is listed in `failed` (and `partial`), with its cause, and the
// board says so on its face rather than drawing a column that reads as
// empty. A subject that answered but hit the row cap is `truncated`: quiet,
// not an error.

import { isTaskDone, isTaskProposed, type CrmIssue, type CrmSubject, type CrmTask } from './contracts';
import { cachedRead, trackIssueCacheProjects } from './core-cache';
import { fetchCachedPartnerSubjects, fetchCrmIssues, fetchCrmPartnerTasks, fetchCrmSubjects, fetchCrmTasks } from './crm';
import type { CardTrace, CrmBoardResponse } from '@starlings/contracts/crm';
import { SUBJECT_STATUS_CHOICES } from '@starlings/contracts/subject-status';
import { subjectKindFilter } from './work-modules';
import { emptyReadGaps, readFailureOf, settleReadGaps, type ReadGaps } from './read-gaps';

/** Where a subject is still work: the registry's `open` statuses (`@starlings/contracts/subject-status`). */
const OPEN_PROJECT_STATUSES = SUBJECT_STATUS_CHOICES.project.open;
const OPEN_LEAD_STATUSES = SUBJECT_STATUS_CHOICES.lead.open;

/** A window of finished work, so `done` and `dropped` are the last few days and not the archive. */
export const BOARD_FINISHED_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
/** Core's own ceiling per subject read. */
const TASKS_PER_SUBJECT = 100;
const ISSUES_PER_PROJECT = 100;
/** One read answers every partner's own tasks; Core's ceiling for it. */
const PARTNER_TASKS_LIMIT = 100;
/** Enough subjects to name every open one at a small company. `truncated` says when it was not. */
const SUBJECT_PAGE = 100;
/**
 * Core's task projection is one subject at a time and is rate-limited. The
 * board used to start one task read for every open lead/project at once; a
 * normal CRM-sized account could therefore turn a healthy board into a row of
 * 429s. The subject summary already carries the open-task count, so idle
 * subjects do not need a task read at all. Keep the remaining fan-out gentle
 * for accounts whose Core is older and does not send that count.
 */
const SUBJECT_WORK_CONCURRENCY = 3;

/** The last event line naming a card — `card_trace`, migration 0012. */
export type { CardTrace, CrmBoardResponse };

/**
 * `project` narrows the board to one project: its tasks and its
 * issues, read once, with no fan-out over every subject and no partners. The
 * caller has already looked the project up; the response has the same shape.
 */
export async function fetchBoard(
  env: Env,
  input: { finishedSinceMs?: number; project?: CrmSubject } = {},
): Promise<CrmBoardResponse> {
  const finishedSince = input.finishedSinceMs ?? Date.now() - BOARD_FINISHED_WINDOW_MS;
  const gaps = emptyReadGaps();

  const subjects = input.project ? [input.project] : await openSubjects(env, [], gaps);
  await trackIssueCacheProjects(
    subjects.filter((subject) => subject.kind === 'project' && subject.has_repo !== false).map((subject) => subject.id),
  );

  // Partners' own tasks: two cached reads in all, never one per partner.
  const partnerWork = input.project
    ? Promise.resolve({ tasks: [] as CrmTask[], subjects: [] as CrmSubject[] })
    : partnerWorkOf(env, gaps, finishedSince);

  const tasks: CrmTask[] = [];
  const issues: CrmIssue[] = [];
  const issueProjects: Record<string, string> = {};
  for (let start = 0; start < subjects.length; start += SUBJECT_WORK_CONCURRENCY) {
    const batch = subjects.slice(start, start + SUBJECT_WORK_CONCURRENCY);
    const results = await Promise.all(batch.map(async (subject) => {
      const [subjectTasks, subjectIssues] = await Promise.all([
        // `open_tasks` is the count from the same Core subject projection. A
        // zero means there is no open task card to fetch; asking for the full
        // done archive on every idle subject is what exhausts Core's budget.
        // A subject that moved inside the finished window is read even at
        // zero: its last open task may be the card that just finished, and
        // the board promises those.
        !input.project && subject.open_tasks === 0 && !movedSince(subject.last_activity_at ?? null, finishedSince)
          ? Promise.resolve([] as CrmTask[])
          : tasksOf(env, subject).then((rows) => {
            if (rows.length >= TASKS_PER_SUBJECT) gaps.truncated.push(subject.title);
            return rows;
          }).catch((error: unknown) => {
            gaps.failed.push(readFailureOf(subject.title, error));
            warn('board.tasks.failed', error, subject);
            return [] as CrmTask[];
          }),
        subject.kind === 'project' && subject.has_repo !== false
          ? issuesOf(env, subject).then((rows) => {
            if (rows.length >= ISSUES_PER_PROJECT) gaps.truncated.push(subject.title);
            return rows;
          }).catch((error: unknown) => {
            gaps.failed.push(readFailureOf(subject.title, error));
            warn('board.issues.failed', error, subject);
            return [] as CrmIssue[];
          })
          : Promise.resolve([] as CrmIssue[]),
      ]);
      return { subject, subjectTasks, subjectIssues };
    }));

    for (const { subject, subjectTasks, subjectIssues } of results) {
      tasks.push(...subjectTasks.filter((task) => isOpenTask(task) || movedSince(task.updated_at, finishedSince)));
      for (const issue of subjectIssues) {
        if (issue.state !== 'open' && !movedSince(issue.updated_at, finishedSince)) continue;
        // A shared repository answers for each project that links it; the
        // first project keeps the card, so the board draws it once.
        if (issueProjects[issue.id]) continue;
        issueProjects[issue.id] = subject.id;
        issues.push(issue);
      }
    }
  }

  const partners = await partnerWork;
  tasks.push(...partners.tasks);
  subjects.push(...partners.subjects);

  const traces = await tracesFor(env, [
    ...tasks.map((task) => ({ kind: 'task' as const, id: task.id })),
    ...issues.map((issue) => ({ kind: 'issue' as const, id: issue.id })),
  ]);

  return {
    subjects,
    tasks,
    issues,
    traces,
    issue_projects: issueProjects,
    ...settleReadGaps(gaps),
    finished_since: new Date(finishedSince).toISOString(),
  };
}

/**
 * Partner tasks for the board, and the partner subjects that hold one. A
 * failed read is `partners` in `failed`, never a failed board. Partner
 * subjects carry no repository and no issues, so they only ever gain cards.
 */
async function partnerWorkOf(
  env: Env,
  gaps: ReadGaps,
  finishedSince: number,
): Promise<{ tasks: CrmTask[]; subjects: CrmSubject[] }> {
  try {
    const [rows, partners] = await Promise.all([
      fetchCrmPartnerTasks(env, { includeDone: true, limit: PARTNER_TASKS_LIMIT }),
      fetchCachedPartnerSubjects(env),
    ]);
    if (rows.length >= PARTNER_TASKS_LIMIT) gaps.truncated.push('partners');
    // A proposal is a question for the inbox, not a card: it never rides in on `movedSince`.
    const tasks = rows.filter((task) => !isTaskProposed(task.status) && (isOpenTask(task) || movedSince(task.updated_at, finishedSince)));
    const withTasks = new Set(tasks.map((task) => task.organization_id).filter((id): id is string => Boolean(id)));
    const subjects = partners.filter((subject) => withTasks.has(subject.id));
    // A task whose partner is not in the list (a page past the ceiling)
    // would be a card with no column owner: leave it out and say so.
    const known = new Set(subjects.map((subject) => subject.id));
    const placed = tasks.filter((task) => task.organization_id && known.has(task.organization_id));
    if (placed.length < tasks.length) gaps.truncated.push('partners');
    return { tasks: placed, subjects };
  } catch (error) {
    gaps.failed.push(readFailureOf('partners', error));
    warn('board.partners.failed', error);
    return { tasks: [], subjects: [] };
  }
}

/**
 * Every subject still in play. One read per open status, the same fan-out
 * the subject board makes, so a status Core would not answer for costs that
 * status and not the whole board.
 *
 * Exported for `feed.ts` (docs/TIMELINE.md Phase 3): the cross-subject feed
 * needs the same "every open subject" list this file already built for the
 * board, and a second copy of the status-fan-out logic is worse than one
 * shared one two callers happen to use differently.
 */
export async function openSubjects(env: Env, partial: string[], gaps?: ReadGaps): Promise<CrmSubject[]> {
  // Cached for a minute (core-cache.ts). A read that came back partial is
  // not kept, so the next caller tries the whole set again rather than
  // inheriting the gap. With `gaps`, a cap hit and a failure are told apart
  // there; without, both are names in `partial`, as before.
  const found = emptyReadGaps();
  const subjects = await cachedRead('subjects/open', () => openSubjectsLive(env, found), {
    keep: () => found.truncated.length === 0 && found.failed.length === 0,
  });
  if (gaps) {
    gaps.truncated.push(...found.truncated);
    gaps.failed.push(...found.failed);
  } else {
    partial.push(...found.truncated, ...found.failed.map((failure) => failure.subject));
  }
  // A kind whose work module is off is not open work here (docs/WORK_MODEL.md,
  //): the board, the feed, INBOX, search and Unowned all read this.
  const shown = await subjectKindFilter(env);
  return subjects.filter((subject) => shown(subject.kind));
}

async function openSubjectsLive(env: Env, gaps: ReadGaps): Promise<CrmSubject[]> {
  const reads: Array<{ kind: 'project' | 'lead' | 'event'; status: string }> = [
    ...OPEN_PROJECT_STATUSES.map((status) => ({ kind: 'project' as const, status })),
    ...OPEN_LEAD_STATUSES.map((status) => ({ kind: 'lead' as const, status })),
    // Upcoming and live events are open subjects (docs/EVENTS.md). Core's
    // "open" is today-or-later in UTC; the device draws the phase again in
    // the reader's zone, so an event at the day's edge is a day off here at
    // worst and never missing.
    { kind: 'event' as const, status: 'open' },
  ];
  const pages = await Promise.all(reads.map(async (read) => {
    try {
      const page = await fetchCrmSubjects(env, read.kind, '', read.status, SUBJECT_PAGE);
      if (page.hasMore) gaps.truncated.push(`${read.kind}s: ${read.status}`);
      return page.subjects as CrmSubject[];
    } catch (error) {
      gaps.failed.push(readFailureOf(`${read.kind}s: ${read.status}`, error));
      warn('board.subjects.failed', error);
      return [];
    }
  }));
  const seen = new Set<string>();
  const out: CrmSubject[] = [];
  for (const subject of pages.flat()) {
    const key = `${subject.kind}:${subject.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(subject);
  }
  return out;
}

/** Exported for inbox.ts: the proposed-task read is this same cached fan-out, minus issues. */
export async function tasksOf(env: Env, subject: CrmSubject): Promise<CrmTask[]> {
  const kind = subject.kind === 'lead' ? 'lead' : subject.kind === 'event' ? 'event' : 'project';
  return cachedRead(`tasks/${kind}/${subject.id}`, () => fetchCrmTasks(env, {
    projectId: subject.kind === 'project' ? subject.id : null,
    leadId: subject.kind === 'lead' ? subject.id : null,
    eventId: subject.kind === 'event' ? subject.id : null,
    includeDone: true,
    limit: TASKS_PER_SUBJECT,
  }));
}

/** Exported for unowned.ts: the same cached per-project issue read. */
export async function issuesOf(env: Env, subject: CrmSubject): Promise<CrmIssue[]> {
  return cachedRead(`issues/${subject.id}`, async () => {
    const page = await fetchCrmIssues(env, {
      project_id: subject.id,
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      limit: ISSUES_PER_PROJECT,
    });
    return page.linked ? page.issues : [];
  });
}

function isOpenTask(task: CrmTask): boolean {
  // A proposal is a question, not a card: it joins the board once accepted.
  return !isTaskDone(task.status) && !isTaskProposed(task.status);
}

/** Kept when it moved inside the window, and when nobody can say when it moved. */
function movedSince(updatedAt: string | null | undefined, sinceMs: number): boolean {
  if (!updatedAt) return true;
  const ms = Date.parse(updatedAt);
  return Number.isNaN(ms) || ms >= sinceMs;
}

/**
 * The last line on each card, read in one query. D1 binds are capped, so the
 * refs go in slices; the table is one row per card and the read stays small.
 */
async function tracesFor(env: Env, refs: Array<{ kind: 'task' | 'issue'; id: string }>): Promise<CardTrace[]> {
  if (refs.length === 0) return [];
  const out: CardTrace[] = [];
  const SLICE = 40;
  try {
    for (let start = 0; start < refs.length; start += SLICE) {
      const slice = refs.slice(start, start + SLICE);
      const placeholders = slice.map((_, index) => `(?${index * 2 + 1}, ?${index * 2 + 2})`).join(', ');
      const { results } = await env.USAGE.prepare(
        `SELECT ref_kind, ref_id, thread_id, message_id, text, at
           FROM card_trace WHERE (ref_kind, ref_id) IN (VALUES ${placeholders})`,
      ).bind(...slice.flatMap((ref) => [ref.kind, ref.id])).all<CardTrace>();
      out.push(...results);
    }
  } catch (error) {
    // A face with one line missing, not a board with none.
    warn('board.traces.failed', error);
  }
  return out;
}

function warn(message: string, error: unknown, subject?: Pick<CrmSubject, 'kind' | 'id' | 'title'>): void {
  console.warn(JSON.stringify({
    level: 'warn',
    message,
    ...(subject ? {
      subjectKind: subject.kind,
      subjectId: subject.id,
      subjectTitle: subject.title,
    } : {}),
    error: error instanceof Error ? error.message : 'Unknown error',
  }));
}
