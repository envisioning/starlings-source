/**
 * What "my work" is and the order it is owed — the one definition, shared by
 * Mac, iOS, and web.
 *
 * A task from Core and an issue from GitHub are two rows in two systems, but
 * they answer one question: *what do I owe*. Left to themselves the surfaces
 * each answered it with their own filter, their own ordering, and a vendor
 * seam down the middle of the list — so the plan is computed here, once, and
 * no surface is allowed a second opinion about which section a row is in or
 * what comes before what.
 *
 * The Swift port is `Sources/WorkItems.swift`. Both are pinned to the same
 * table of cases in `fixtures/work-items.json` — that file is the contract,
 * this is one implementation of it. Change the rules there first.
 */

import { civilDay } from './upcoming';

export type WorkItemOrigin = 'task' | 'issue';

/**
 * Where a row sits in the plan. `inbox` is work not yet filed to any subject —
 * filing comes before scheduling, whatever date the row carries. The date
 * sections compare civil days, never raw timestamps: work due earlier today is
 * due today, not late. Every issue is `undated`, because GitHub issues carry
 * no due date.
 */
export type WorkSection = 'inbox' | 'late' | 'today' | 'soon' | 'undated';

export const WORK_SECTIONS: readonly WorkSection[] = [
  'inbox',
  'late',
  'today',
  'soon',
  'undated',
];

/**
 * The contextual axes available in the MINE rail. `focus` is not a section: it
 * is the slice Home shows (`planFocus`), so a link from Home lands on the same
 * rows.
 */
export type MineSectionFilter = 'all' | 'focus' | WorkSection;
export type MineOriginFilter = 'all' | WorkItemOrigin;

export interface MineFilter {
  section: MineSectionFilter;
  origin: MineOriginFilter;
}

/** The Mine section menu, in order, with the word every client shows. */
export const MINE_SECTION_FILTERS: readonly { value: MineSectionFilter; title: string }[] = [
  { value: 'all', title: 'All open' },
  { value: 'focus', title: 'Focus' },
  { value: 'inbox', title: 'Unfiled' },
  { value: 'late', title: 'Late' },
  { value: 'today', title: 'Today' },
  { value: 'soon', title: 'Soon' },
  { value: 'undated', title: 'Undated' },
];

/** The Mine origin menu, in order, with the word every client shows. */
export const MINE_ORIGIN_FILTERS: readonly { value: MineOriginFilter; title: string }[] = [
  { value: 'all', title: 'All work' },
  { value: 'task', title: 'Tasks' },
  { value: 'issue', title: 'GitHub issues' },
];

export const DEFAULT_MINE_FILTER: MineFilter = {
  section: 'all',
  origin: 'all',
};

/**
 * The little a row has to expose to be planned. Deliberately not a wire type:
 * each client adapts its own task and issue shapes.
 */
export interface WorkItemShape {
  /** Stable identity; for an issue, its `owner/repo#number`. */
  id: string;
  origin: WorkItemOrigin;
  /** Completed/cancelled task, or closed issue. Done work is never planned. */
  done: boolean;
  /** Belongs to a project or lead. Every issue is filed by construction. */
  filed: boolean;
  /** ISO 8601, or absent. Unparseable means undated rather than today. */
  dueDate?: string | null;
  updatedAt?: string | null;
  /** `owner/repo#number` a promoted task points at. */
  githubRef?: string | null;
}

export interface WorkPlan<E> {
  /** Every planned row, sections concatenated in section order. */
  order: E[];
  sections: Record<WorkSection, E[]>;
  sectionOf: Record<string, WorkSection>;
  /** Planned rows after dedupe — the honest size of the plate. */
  openCount: number;
  lateCount: number;
}

/**
 * Narrow a completed plan without re-running its rules. Search belongs after
 * promotion dedupe so a task remains the canonical row for its GitHub issue.
 */
export function filterWorkPlan<E extends { id: string }>(
  plan: WorkPlan<E>,
  include: (item: E) => boolean,
): WorkPlan<E> {
  const sections = {
    inbox: plan.sections.inbox.filter(include),
    late: plan.sections.late.filter(include),
    today: plan.sections.today.filter(include),
    soon: plan.sections.soon.filter(include),
    undated: plan.sections.undated.filter(include),
  };
  const order = WORK_SECTIONS.flatMap((section) => sections[section]);
  const sectionOf: Record<string, WorkSection> = {};
  for (const section of WORK_SECTIONS) {
    for (const item of sections[section]) sectionOf[item.id] = section;
  }
  return {
    order,
    sections,
    sectionOf,
    openCount: order.length,
    lateCount: sections.late.length,
  };
}

/**
 * Narrow MINE after planning and promotion dedupe, without changing order.
 * `focus` keeps the rows `planFocus` puts first, without its Next fill: Home
 * fills an empty card, a filter shows what matches.
 */
export function filterMinePlan<E extends WorkCardShape>(
  plan: WorkPlan<E>,
  filter: MineFilter,
  nowMs: number = Date.now(),
  timeZone?: string,
): WorkPlan<E> {
  const focused = filter.section === 'focus'
    ? new Set(focusRows(plan, nowMs, timeZone).map((item) => item.id))
    : null;
  return filterWorkPlan(plan, (item) => {
    const sectionMatches = filter.section === 'all'
      || (focused ? focused.has(item.id) : plan.sectionOf[item.id] === filter.section);
    const originMatches = filter.origin === 'all' || item.origin === filter.origin;
    return sectionMatches && originMatches;
  });
}

// MARK: - Focus (docs/WORK.md §1)

/** How many soon rows fill Home when nothing is late, due today or started. */
export const FOCUS_NEXT_ROWS = 3;

/** The started stages: work a person picked up stays in view without a date. */
const FOCUS_STAGES: ReadonlySet<WorkStage> = new Set(['doing', 'review', 'blocked']);

/**
 * The slice of Mine that Home shows. `rows` is late, then due today, then
 * started work with no claim on a day. When all three are empty, `next` is
 * true and `rows` holds the first soon rows instead, so a clear day still says
 * what comes after it.
 */
export interface MineFocus<E> {
  rows: E[];
  next: boolean;
  lateCount: number;
  todayCount: number;
}

/**
 * Plan Home from Mine's plan. Dates come from `dateSection`, with filing left
 * out: an unfiled task that is late is late on Home. Late and today keep the
 * plan's due order; started rows follow by recent movement.
 */
export function planFocus<E extends WorkCardShape>(
  plan: WorkPlan<E>,
  nowMs: number,
  timeZone?: string,
): MineFocus<E> {
  const late: E[] = [];
  const today: E[] = [];
  const started: E[] = [];
  const soon: E[] = [];
  for (const item of plan.order) {
    const section = dateSection(item.dueDate, nowMs, timeZone);
    if (section === 'late') late.push(item);
    else if (section === 'today') today.push(item);
    else if (FOCUS_STAGES.has(stageOf(item))) started.push(item);
    else if (section === 'soon') soon.push(item);
  }
  late.sort(byDue);
  today.sort(byDue);
  started.sort(byRecentMovement);
  const rows = [...late, ...today, ...started];
  if (rows.length > 0) {
    return { rows, next: false, lateCount: late.length, todayCount: today.length };
  }
  return { rows: soon.sort(byDue).slice(0, FOCUS_NEXT_ROWS), next: true, lateCount: 0, todayCount: 0 };
}

function focusRows<E extends WorkCardShape>(plan: WorkPlan<E>, nowMs: number, timeZone?: string): E[] {
  const focus = planFocus(plan, nowMs, timeZone);
  return focus.next ? [] : focus.rows;
}

/**
 * Plan a mixed pile of tasks and issues.
 *
 * A live task that carries a `githubRef` claims that issue: the task is the
 * one row, because it holds the date and the subject. A done task claims
 * nothing — its still-open issue is real work and keeps its row.
 */
export function planWork<E extends WorkItemShape>(
  items: readonly E[],
  nowMs: number,
  timeZone?: string,
): WorkPlan<E> {
  const claimed = new Set<string>();
  for (const item of items) {
    if (item.origin === 'task' && !item.done && item.githubRef) claimed.add(item.githubRef);
  }

  const sections: Record<WorkSection, E[]> = {
    inbox: [],
    late: [],
    today: [],
    soon: [],
    undated: [],
  };
  const sectionOf: Record<string, WorkSection> = {};

  for (const item of items) {
    if (item.done) continue;
    if (item.origin === 'issue' && claimed.has(item.id)) continue;
    const section = classify(item, nowMs, timeZone);
    sections[section].push(item);
    sectionOf[item.id] = section;
  }

  sections.inbox.sort(byRecentMovement);
  sections.late.sort(byDue);
  sections.today.sort(byDue);
  sections.soon.sort(byDue);
  sections.undated.sort(byRecentMovement);

  const order = WORK_SECTIONS.flatMap((section) => sections[section]);
  return {
    order,
    sections,
    sectionOf,
    openCount: order.length,
    lateCount: sections.late.length,
  };
}

function classify(item: WorkItemShape, nowMs: number, timeZone: string | undefined): WorkSection {
  if (!item.filed) return 'inbox';
  return dateSection(item.dueDate, nowMs, timeZone);
}

/** The shared civil-day classification for a task due date. */
export function dateSection(
  dueDate: string | null | undefined,
  todayMs: number,
  timeZone?: string,
): WorkSection {
  const due = parseMs(dueDate);
  if (due === null) return 'undated';
  const day = civilDay(due, timeZone);
  const today = civilDay(todayMs, timeZone);
  if (day < today) return 'late';
  if (day === today) return 'today';
  return 'soon';
}

export function isLateDate(
  dueDate: string | null | undefined,
  nowMs = Date.now(),
  timeZone?: string,
): boolean {
  return dateSection(dueDate, nowMs, timeZone) === 'late';
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** The oldest debt first; ties break on id. */
function byDue(a: WorkItemShape, b: WorkItemShape): number {
  const difference = (parseMs(a.dueDate) ?? 0) - (parseMs(b.dueDate) ?? 0);
  if (difference !== 0) return difference;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Recent movement first, silence last; ties break on id. */
function byRecentMovement(a: WorkItemShape, b: WorkItemShape): number {
  const aMs = parseMs(a.updatedAt);
  const bMs = parseMs(b.updatedAt);
  if (aMs !== bMs) {
    if (aMs === null) return 1;
    if (bMs === null) return -1;
    return bMs - aMs;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// MARK: - Stages (docs/BOARD.md)

/**
 * Where a piece of work sits in the pipeline, whichever store holds it.
 *
 * `WorkSection` answers *when*; this answers *where*. A Core task says it with
 * `status`, a GitHub issue with `state`, `state_reason` and its `agent:*`
 * labels, and the board must never show a task half with four columns and an
 * issue half with six. The rules are pinned in `fixtures/work-items.json`
 * under `stages`; change them there first.
 */
export type WorkStage = 'queued' | 'doing' | 'review' | 'blocked' | 'done' | 'dropped';

export const WORK_STAGES = [
  'queued',
  'doing',
  'review',
  'blocked',
  'done',
  'dropped',
] as const satisfies readonly WorkStage[];

/**
 * The little a row has to expose to be staged. Task fields for a task, issue
 * fields for an issue; the other side's fields are ignored.
 */
export interface WorkStageShape {
  origin: WorkItemOrigin;
  /** Core's status string, verbatim. */
  status?: string | null;
  /** `open` or `closed`. */
  state?: string | null;
  /** `completed`, `not_planned`, `duplicate`, `reopened`, or nothing. */
  stateReason?: string | null;
  /** Label names as GitHub returns them. */
  labels?: readonly string[] | null;
}

/** A card is a row that can be planned and staged. */
export type WorkCardShape = WorkItemShape & WorkStageShape;

/**
 * The label an open issue carries for each stage an agent can put it in.
 * `queued` has none: a card queued for a person is not queued for an agent,
 * and the hand-off is what labels it.
 */
const STAGE_LABELS: Readonly<Record<'doing' | 'review' | 'blocked', string>> = {
  doing: 'agent:building',
  review: 'agent:review',
  blocked: 'agent:failed',
};

/** Every label that means a stage, so a write can take all of them off. */
const ALL_STAGE_LABELS: readonly string[] = ['agent:queued', ...Object.values(STAGE_LABELS)];

const TASK_STAGES: Readonly<Record<string, WorkStage>> = {
  pending: 'queued',
  in_progress: 'doing',
  review: 'review',
  blocked: 'blocked',
  completed: 'done',
  cancelled: 'dropped',
  // Core-proposed tasks: not committed work until accepted, so a
  // proposal reads as queued if it ever reaches a board — and the board
  // itself leaves proposals out (board.ts isOpenTask). Declined is dropped.
  proposed: 'queued',
  declined: 'dropped',
};

const TASK_STATUS: Readonly<Record<WorkStage, string>> = {
  queued: 'pending',
  doing: 'in_progress',
  review: 'review',
  blocked: 'blocked',
  done: 'completed',
  dropped: 'cancelled',
};

/** The stage of one row. Pure; the fixture is the spec. */
export function stageOf(item: WorkStageShape): WorkStage {
  if (item.origin === 'task') {
    return TASK_STAGES[item.status ?? ''] ?? 'queued';
  }
  if (item.state === 'closed') {
    return item.stateReason === 'not_planned' || item.stateReason === 'duplicate' ? 'dropped' : 'done';
  }
  const labels = new Set((item.labels ?? []).map((label) => label.toLowerCase()));
  // The strongest claim on a person's attention wins when labels disagree.
  if (labels.has(STAGE_LABELS.blocked)) return 'blocked';
  if (labels.has(STAGE_LABELS.review)) return 'review';
  if (labels.has(STAGE_LABELS.doing)) return 'doing';
  return 'queued';
}

export function isTaskDone(status: string | null | undefined): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'declined';
}

/** A Core-proposed task nobody has accepted yet. */
export function isTaskProposed(status: string | null | undefined): boolean {
  return status === 'proposed';
}

export function isFinished(stage: WorkStage): boolean {
  return stage === 'done' || stage === 'dropped';
}

/**
 * The head of each stage's column, in capitals as every client draws it. The
 * key is the capital word on purpose: "Done" is already a verb elsewhere, and
 * a column head is a state.
 */
export const WORK_STAGE_TITLES: readonly { value: WorkStage; title: string }[] = [
  { value: 'queued', title: 'QUEUED' },
  { value: 'doing', title: 'DOING' },
  { value: 'review', title: 'REVIEW' },
  { value: 'blocked', title: 'BLOCKED' },
  { value: 'done', title: 'DONE' },
  { value: 'dropped', title: 'DROPPED' },
];

/**
 * The machine has it: an open issue with any of the four stage labels,
 * `agent:queued` included — the same reading UNOWNED makes (`isUnowned`).
 * A task says so only once Core has agent team rows (docs/BOARD.md step 8);
 * until then a task is always a person's.
 */
export function isHeldByAgent(item: WorkStageShape): boolean {
  if (item.origin !== 'issue' || isFinished(stageOf(item))) return false;
  const labels = new Set((item.labels ?? []).map((label) => label.toLowerCase()));
  return ALL_STAGE_LABELS.some((label) => labels.has(label));
}

/**
 * The board's holder filter: `anyone`, `people`, `agents`, or
 * `agent:<email>` for one agent. The fixed choices are this table; one per
 * agent follows them in the menu.
 */
export type WorkHolderFilter = 'anyone' | 'people' | 'agents' | `agent:${string}`;

export const WORK_HOLDER_CHOICES: readonly { value: 'anyone' | 'people' | 'agents'; title: string }[] = [
  { value: 'anyone', title: 'Anyone' },
  { value: 'people', title: 'People' },
  { value: 'agents', title: 'Any agent' },
];

/**
 * Whether a card shows under the holder filter. `agentEmail` is the agent
 * the card's project names; one agent's filter keeps the cards that agent
 * holds. An unknown filter shows everything.
 */
export function passesHolderFilter(item: WorkStageShape, filter: string, agentEmail?: string | null): boolean {
  if (filter === 'people') return !isHeldByAgent(item);
  if (filter === 'agents') return isHeldByAgent(item);
  if (filter.startsWith('agent:')) {
    const wanted = filter.slice('agent:'.length).trim().toLowerCase();
    return isHeldByAgent(item) && (agentEmail ?? '').trim().toLowerCase() === wanted;
  }
  return true;
}

// MARK: - Task filters

/**
 * The task filters every task list and board offers beside the holder
 * filter: whether the task is overdue, and which side it is on. Core's task
 * index had both; they replace it when the `tasks` group moves.
 */
export type WorkDueFilter = 'any' | 'overdue';
export type WorkSideFilter = 'any' | 'team' | 'client' | 'unassigned';

export interface WorkTaskFilter {
  due: WorkDueFilter;
  side: WorkSideFilter;
}

export const DEFAULT_WORK_TASK_FILTER: WorkTaskFilter = { due: 'any', side: 'any' };

/** The due menu, in order, with the word every client shows. */
export const WORK_DUE_CHOICES: readonly { value: WorkDueFilter; title: string }[] = [
  { value: 'any', title: 'Any date' },
  { value: 'overdue', title: 'Overdue' },
];

/** The side menu, in order. `team` is the workspace's side; a client draws the workspace's name for it. */
export const WORK_SIDE_CHOICES: readonly { value: WorkSideFilter; title: string }[] = [
  { value: 'any', title: 'Any side' },
  { value: 'team', title: 'Team' },
  { value: 'client', title: 'Client' },
  { value: 'unassigned', title: 'Unassigned' },
];

/** What the task filters read of a row: a card's stage fields, its date and its side. */
export type WorkFilterShape = WorkStageShape & Pick<WorkItemShape, 'dueDate'> & Pick<WorkHolderShape, 'responsibleParty'>;

/**
 * Whether a row shows under the task filters. Overdue is open work due
 * before today, in civil days, as the plan's `late` section reads it. An
 * issue has no date and no side, so it shows only while both filters are
 * `any`. A task with no side reads as `unassigned`, as Core's column default.
 */
export function passesTaskFilter(item: WorkFilterShape, filter: WorkTaskFilter, nowMs: number = Date.now(), timeZone?: string): boolean {
  if (filter.due === 'any' && filter.side === 'any') return true;
  if (item.origin !== 'task') return false;
  if (filter.due === 'overdue' && (isFinished(stageOf(item)) || !isLateDate(item.dueDate, nowMs, timeZone))) return false;
  if (filter.side !== 'any' && (item.responsibleParty || 'unassigned') !== filter.side) return false;
  return true;
}

/**
 * The one write a stage move makes: a task PATCH, or an issue PATCH with the
 * whole label set (GitHub replaces on PATCH). Fields are spelled the way
 * `crmTaskUpdateSchema` and `crmIssueUpdateSchema` take them.
 */
export type WorkStageWrite =
  | { kind: 'task'; status: string }
  | { kind: 'issue'; state: 'open' | 'closed'; state_reason?: 'completed' | 'not_planned'; labels: string[] };

export function writeStage(item: WorkStageShape, stage: WorkStage): WorkStageWrite {
  if (item.origin === 'task') {
    return { kind: 'task', status: TASK_STATUS[stage] };
  }
  const kept = (item.labels ?? []).filter((label) => !ALL_STAGE_LABELS.includes(label.toLowerCase()));
  switch (stage) {
    case 'done':
      return { kind: 'issue', state: 'closed', state_reason: 'completed', labels: kept };
    case 'dropped':
      return { kind: 'issue', state: 'closed', state_reason: 'not_planned', labels: kept };
    case 'queued':
      return { kind: 'issue', state: 'open', labels: kept };
    default:
      return { kind: 'issue', state: 'open', labels: [...kept, STAGE_LABELS[stage]] };
  }
}

export interface WorkBoard<E> {
  columns: Record<WorkStage, E[]>;
  stageOf: Record<string, WorkStage>;
}

/** Finished task and issue rows, newest movement first, in one mixed list. */
export function recentlyClosed<E extends WorkCardShape>(
  items: readonly E[],
  finishedSinceMs?: number | null,
): E[] {
  return items
    .filter((item) => isFinished(stageOf(item)))
    .filter((item) => {
      if (finishedSinceMs === undefined || finishedSinceMs === null) return true;
      const moved = parseMs(item.updatedAt);
      return moved === null || moved >= finishedSinceMs;
    })
    .sort(byRecentMovement);
}

/**
 * Every card in its column.
 *
 * A live task that carries a `githubRef` claims its issue, exactly as the plan
 * does: the task's stage is the card's, and the issue leaves the board. Open
 * columns keep the plan's order; finished columns order by movement, newest
 * first. `finishedSinceMs` drops finished cards that moved before it, and
 * keeps the ones that cannot say when they moved.
 */
export function planBoard<E extends WorkCardShape>(
  items: readonly E[],
  nowMs: number,
  timeZone?: string,
  finishedSinceMs?: number | null,
): WorkBoard<E> {
  const stages = new Map<E, WorkStage>(items.map((item) => [item, stageOf(item)]));
  const stageOfId: Record<string, WorkStage> = {};
  const columns: Record<WorkStage, E[]> = {
    queued: [],
    doing: [],
    review: [],
    blocked: [],
    done: [],
    dropped: [],
  };

  const open = items.filter((item) => !isFinished(stages.get(item)!));
  // The plan already knows how to dedupe and order open work; hand it rows
  // that agree with the stage about being open, so its own `done` never
  // disagrees with the column.
  const plan = planWork(open.map((item) => ({ ...item, done: false })), nowMs, timeZone);
  for (const planned of plan.order) {
    const original = open.find((item) => item.id === planned.id)!;
    const stage = stages.get(original)!;
    columns[stage].push(original);
    stageOfId[original.id] = stage;
  }

  const finished = recentlyClosed(items, finishedSinceMs);
  for (const item of finished) {
    const stage = stages.get(item)!;
    columns[stage].push(item);
    stageOfId[item.id] = stage;
  }

  return { columns, stageOf: stageOfId };
}

// MARK: - Unowned (docs/BOARD.md §Unowned)

/**
 * Who holds a card, as far as the unowned rule reads it. Task fields for a
 * task, issue fields for an issue; the other side's are ignored.
 */
export interface WorkHolderShape {
  /** Task: the Core person it is assigned to, by id or address; null when nobody. */
  assignee?: string | null;
  /** Task: Core's side — `team`, `client` or `unassigned`. */
  responsibleParty?: string | null;
  /** Issue: the GitHub logins assigned. */
  assignees?: readonly string[] | null;
}

export type WorkHeldCardShape = WorkCardShape & WorkHolderShape;

/**
 * Nobody on our side holds it. A task with no person, unless the client owes
 * it — Envisioning's side and no side at all are both ours to answer for. An
 * issue with no assignee and no stage label: an `agent:*` stage means an
 * agent holds it (docs/BOARD.md §Who holds a card).
 */
export function isUnowned(item: WorkHeldCardShape): boolean {
  if (item.origin === 'task') {
    if ((item.assignee ?? '').trim()) return false;
    return item.responsibleParty !== 'client';
  }
  if ((item.assignees ?? []).some((login) => login.trim())) return false;
  const labels = new Set((item.labels ?? []).map((label) => label.toLowerCase()));
  return !ALL_STAGE_LABELS.some((label) => labels.has(label));
}

/**
 * Every open card nobody holds, in the plan's order. Open is the board's
 * open — stage not done or dropped, and never a proposal, which is a question
 * for INBOX. The plan dedupes first, so a promoted task is judged and the
 * issue it claims never is.
 */
export function planUnowned<E extends WorkHeldCardShape>(
  items: readonly E[],
  nowMs: number,
  timeZone?: string,
): E[] {
  const open = items.filter((item) => !isFinished(stageOf(item)) && !(item.origin === 'task' && isTaskProposed(item.status)));
  const byID = new Map(open.map((item) => [`${item.origin}:${item.id}`, item]));
  return planWork(open.map((item) => ({ ...item, done: false })), nowMs, timeZone).order
    .map((planned) => byID.get(`${planned.origin}:${planned.id}`)!)
    .filter(isUnowned);
}

// MARK: - Events (docs/EVENTS.md)

/**
 * Where an event is in its life. An event has one date and no status field:
 * the date is the status. `upcoming` and `live` are open subjects, listed in
 * the rail beside open projects; `past` is closed. Compared as civil days in
 * the reader's zone, the same way `dateSection` compares a due date, so an
 * event today is live all day wherever the reader woke up. Pinned in
 * `fixtures/work-items.json` under `events`; change it there first.
 */
export type EventPhase = 'upcoming' | 'live' | 'past';

/**
 * `eventDate` is the CMS `YYYY-MM-DD`, or null on an undated draft. Undated
 * is `upcoming`: a draft with tasks is open work, and hiding it would hide
 * the tasks. It has no sort key and lists last.
 */
export function eventPhase(
  eventDate: string | null | undefined,
  todayMs: number,
  timeZone?: string,
): EventPhase {
  const daysUntil = eventDaysUntil(eventDate, todayMs, timeZone);
  if (daysUntil === null) return 'upcoming';
  if (daysUntil < 0) return 'past';
  if (daysUntil === 0) return 'live';
  return 'upcoming';
}

/** Calendar days until the event in the reader's zone; null when undated. */
export function eventDaysUntil(
  eventDate: string | null | undefined,
  nowMs: number,
  timeZone?: string,
): number | null {
  const day = civilDayOfDate(eventDate);
  if (day === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(eventDate ?? '');
  if (!match) return null;
  const parsed = new Date(day * 86_400_000);
  if (
    parsed.getUTCFullYear() !== Number(match[1])
    || parsed.getUTCMonth() + 1 !== Number(match[2])
    || parsed.getUTCDate() !== Number(match[3])
  ) return null;
  return day - civilDay(nowMs, timeZone);
}

/** A plain `YYYY-MM-DD` as a civil day number, with no zone to apply: the CMS date is already a day. */
export function civilDayOfDate(date: string | null | undefined): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(date ?? '');
  if (!match) return null;
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000);
}
