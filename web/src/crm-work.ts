import { isPartnerTask, workSubjectOf } from './work-hrefs';
import {
  eventDaysUntil,
  eventPhase,
  filterWorkPlan,
  filterMinePlan,
  DEFAULT_MINE_FILTER,
  planWork,
  isLateDate,
  isTaskDone,
  passesTaskFilter,
  writeStage,
  type EventPhase,
  type WorkTaskFilter,
  type WorkCardShape,
  type WorkPlan,
  type WorkSection,
  type WorkStage,
} from '@starlings/contracts/work-items';
import type { CrmGithubRepo, CrmGithubReposResponse, CrmInteractionCreate, CrmInteractionDeleteResponse, CrmInteractionResponse, CrmInteractionUpdate, CrmLeadWinResponse, CrmOrganizationProjectTasksResponse, CrmTaskDeleteResponse, CrmOrganizationFacets, CrmProjectRepoResponse, CrmSubjectCountsResponse, MeetingFollowUpApproveResponse, ThreadHandoff, ThreadMessage } from '@starlings/contracts';
import type { InboxFollowUpItem } from '@starlings/contracts/inbox';
import { SUBJECT_STATUS_CHOICES } from '@starlings/contracts/subject-status';
import { formBody } from '@starlings/contracts/form-fields';
import { CRM_RESPONSIBLE_LABELS, CRM_TASK_STATUS_LABELS } from '@starlings/contracts/task-values';
import { UNTRIAGED_TOUCH_SOURCE_LABELS } from '@starlings/contracts/sales-values';
import type { CrmDecision, CrmDecisionCreateInput, CrmGoal, CrmGoalCreateInput, CrmGoalUpdateInput } from '@starlings/contracts/goals-decisions';
import {
  DEFAULT_INBOX_FILTER,
  INBOX_FILTER_SOURCES,
  inboxItemMatchesFilter,
  inboxSourceSpec,
} from '@starlings/contracts/inbox-values';
import type { InboxFilterSource, InboxDismissResponse, InboxItem, InboxResponse } from '@starlings/contracts/inbox';
import type { DecisionAsk } from '@starlings/contracts/decision-asks';
import { searchMatches } from '@starlings/contracts/search-values';
import type { SearchResponse } from '@starlings/contracts/search';
import type { CoreMergeBody, CoreMergeResponse } from '@starlings/contracts/core-fields';
import {
  resolveSubjectState,
  subjectGroup,
  SUBJECT_GROUPS,
  sortByWorkList,
} from '@starlings/contracts/subject-state-values';
import type {
  ResolvedSubjectState,
  SubjectGroup,
  SubjectStateOverride,
  SubjectStateResponse,
  SubjectStateRow,
  SubjectStateUpdate,
  SubjectStateUpdateResponse,
  WorkListPreferences,
  WorkPreferencesUpdate,
} from '@starlings/contracts/subject-state';
import type {
  CrmIssueCreateInput,
  CrmIssueDetailResponse,
  CrmIssue,
  CrmIssueLabel,
  CrmMyTask,
  CrmRecentlyClosedItem,
  CrmRecentlyClosedWorkResponse,
  CrmUnownedWorkResponse,
  CrmOrganizationOption,
  CrmOrganizationDeleteResponse,
  CrmSubjectDetail as CrmSubjectDetailWire,
  CrmOrganizationResponse,
  CrmOrganizationUpdate,
  CrmOrganizationsResponse,
  CrmTask,
  UntriagedTouch,
  UntriagedTouchDismissResponse,
  UntriagedTouchesResponse,
  UntriagedTouchSource,
} from '@starlings/contracts';
import { useEffect, useState } from 'react';
import { apiFetch, apiFetchConditional } from './api';
import { track } from './analytics';
import { formatTime } from './meeting-time';
import { invalidateFor, loadSnapshot, revalidate } from './snapshot-store';
import { readStored, removeStored, writeStored } from './storage';
import { plural, t, dateLocale } from './i18n';
import { workspaceBrand } from './workspace-brand';
import { workspaceProjectGroup } from './workspace-defaults';
import { localPartOf } from './mentions';
import type { CardTrace, CrmBoardResponse, CrmTeamMember, OrganizationRelationship } from '@starlings/contracts/crm';

/**
 * Snapshot keys (docs/CACHING.md) — the same spellings the Mac and iOS
 * stores use, so the table in the doc reads once for all three. A write that
 * makes a list stale names the prefix; `crm/subjects` takes every filtered
 * page with it.
 */
export const SNAPSHOT = {
  mine: 'crm/mine',
  inbox: 'crm/inbox',
  subjects: 'crm/subjects',
  tasks: 'crm/tasks',
  interactions: 'crm/interactions',
} as const;

export function subjectsSnapshotKey(kind: SubjectKind, query: string): string {
  return `${SNAPSHOT.subjects}?kind=${kind}&q=${query.trim()}`;
}

export function tasksSnapshotKey(subject: Pick<CrmSubject, 'kind' | 'id'>): string {
  return `${SNAPSHOT.tasks}?${new URLSearchParams(taskSubjectQuery(subject))}`;
}

export function interactionsSnapshotKey(subject: Pick<CrmSubject, 'kind' | 'id'>): string {
  const q = interactionsQuery(subject);
  return `${SNAPSHOT.interactions}?project_id=${q.project_id ?? ''}&lead_id=${q.lead_id ?? ''}&organization_id=${q.organization_id ?? ''}`;
}

export { isPartnerTask, workSubjectOf } from './work-hrefs';
export type { CrmIssue, CrmIssueLabel, CrmMyTask, CrmTask } from '@starlings/contracts';
export type { CrmRecentlyClosedItem, CrmRecentlyClosedWorkResponse, CrmUnownedSubject, CrmUnownedWorkResponse } from '@starlings/contracts';
export type { UntriagedTouch, UntriagedTouchSource } from '@starlings/contracts';
export type { InboxItem, InboxRecentEntry, InboxResponse } from '@starlings/contracts/inbox';
export type { InboxFilterSource } from '@starlings/contracts/inbox';
export { DEFAULT_INBOX_FILTER, INBOX_FILTER_SOURCES, inboxItemMatchesFilter } from '@starlings/contracts/inbox-values';
export {
  DEFAULT_WORK_RANK_CRITERIA,
  rankWorkSubjects,
  workRankRail,
  type RankedWorkSubject,
  type WorkRankCriteria,
  type WorkRankSignals,
} from '@starlings/contracts/work-ranker';
export type { ResolvedSubjectState, SubjectGroup, SubjectStateOverride, SubjectStateResponse, WorkListPreferences } from '@starlings/contracts/subject-state';
export { subjectGroup, DEFAULT_WORK_LIST, isDefaultWorkList, WORK_LIST_SORTS, WORK_LIST_GROUPS, WORK_LIST_SORT_TITLES, WORK_LIST_GROUP_TITLES } from '@starlings/contracts/subject-state-values';

export {
  filterWorkPlan,
  filterMinePlan,
  DEFAULT_MINE_FILTER,
  isFinished,
  passesHolderFilter,
  passesTaskFilter,
  planBoard,
  stageOf,
  DEFAULT_WORK_TASK_FILTER,
  WORK_DUE_CHOICES,
  WORK_HOLDER_CHOICES,
  WORK_SIDE_CHOICES,
  WORK_SECTIONS,
  WORK_STAGE_TITLES,
  WORK_STAGES,
  writeStage,
  type WorkSection,
  type WorkStage,
  type WorkTaskFilter,
  type MineFilter,
  type MineOriginFilter,
  type MineSectionFilter,
} from '@starlings/contracts/work-items';

/**
 * The CRM half of the work surface, for the browser.
 *
 * Every call is member-gated at the Worker, which holds the Core credentials —
 * the browser never talks to Core and never sees the shared secret. Same
 * endpoints the Mac window and the iOS tab use, so a task written here and one
 * written in a meeting are the same row.
 */

/**
 * `partner` is a CRM organization flagged `is_partner`, read as a Work
 * subject (PARTNERS (HQ Docs)). It has Talk, Tasks (filed on its organization),
 * its page, its history by organization, and Core; no issues.
 *
 * `event` is a CMS `events` row (docs/EVENTS.md): read-only as a
 * record, edited under Website in Core, but with Talk and Tasks of its own.
 * Its one date is its status; `eventPhase` says where it is.
 */
export type SubjectKind = 'project' | 'lead' | 'organization' | 'event';

export function isPartner(subject: Pick<CrmSubject, 'kind'>): boolean {
  return subject.kind === 'organization';
}

export function isEvent(subject: Pick<CrmSubject, 'kind'>): boolean {
  return subject.kind === 'event';
}

/** The one query a task list or write names its subject by. */
export function taskSubjectQuery(subject: Pick<CrmSubject, 'kind' | 'id'>): Record<string, string> {
  switch (subject.kind) {
    case 'project': return { project_id: subject.id };
    case 'lead': return { lead_id: subject.id };
    case 'event': return { event_id: subject.id };
    case 'organization': return { organization_id: subject.id };
  }
}

export interface CrmSubject {
  id: string;
  kind: SubjectKind;
  title: string;
  subtitle: string | null;
  /** A project's or lead's status, Core's word. Absent reads as open. */
  status?: string | null;
  open_tasks?: number;
  overdue_tasks?: number;
  has_repo?: boolean;
  /** The project agent named by Core's `projects.agent_email` edge. */
  agent_email?: string | null;
  /**
   * The organization this subject hangs off ( slice 1). Existing
   * Core rows may have none; every new lead or project now needs one. A
   * partner's organization id is its own id.
   */
  organization_id?: string | null;
  organization_name?: string | null;
  /**
   * The organization's logo when Core's enrichment has one; absent or null
   * draws as the kind's glyph (`SubjectMark`). Same field as the contract.
   */
  organization_logo_url?: string | null;
  /** Events only: the CMS `YYYY-MM-DD`, or null on an undated draft. */
  event_date?: string | null;
  /** Events only: whether the website lists it. Plays no part here. */
  published?: boolean;
  /** Projects only: Core's `is_internal`. See `isInternalProject`. */
  internal?: boolean;
  /** When something last moved here, ISO; null when nothing is known ( slice 3c). */
  last_activity_at?: string | null;
  /** The id asked for, when it was merged into this record. Same field as the contract. */
  merged_from?: string;
}

/**
 * The rail's order: what moved last, first. Rows with no activity known
 * come after every row with one, in the busiest order.
 */
export function sortByActivity<T extends CrmSubject>(subjects: T[], nowMs = Date.now()): T[] {
  return sortByWorkList(subjects, 'activity', nowMs);
}

/**
 * Envisioning's own projects. Core's `is_internal` flag decides (
 * decision 2); the "Envisioning " title prefix is only the fallback
 * for a row from a Core that has not sent the flag yet. Once Core has
 * backfilled, `false` means external whatever the title says.
 */
export function isInternalProject(subject: Pick<CrmSubject, 'kind' | 'title' | 'internal'>): boolean {
  if (subject.kind !== 'project') return false;
  if (typeof subject.internal === 'boolean') return subject.internal;
  // Envisioning's Core before the flag: matched as data, never translated.
  return subject.title.startsWith(`${workspaceProjectGroup()} `);
}

/**
 * The title as shown in the Envisioning Projects list. The leading
 * "Envisioning " is redundant with the list itself, so it's dropped for
 * display only — `subject.title` still carries the full CRM name. An
 * internal project titled without the prefix keeps its title whole.
 */
export function subjectDisplayTitle(subject: Pick<CrmSubject, 'kind' | 'title' | 'internal'>): string {
  // The group is titled with the workspace's name, so that prefix is redundant.
  const prefix = `${workspaceProjectGroup()} `;
  return isInternalProject(subject) && subject.title.startsWith(prefix)
    ? subject.title.slice(prefix.length)
    : subject.title;
}

/** How the Envisioning, Projects and Leads lists order their subjects. */
export type SubjectSortOption = 'busiest' | 'alphabetical';

/**
 * Overdue first, then open-task count, then title — the closest honest proxy
 * for "needs attention" the list payload supports. Mirrors
 * `sorted(bySidebarOption:)` in `Sources/WorkSurface.swift`; missing counts
 * sort as zero rather than throwing, since both fields are optional on the
 * wire.
 */
export function sortSubjects<T extends Pick<CrmSubject, 'title' | 'open_tasks' | 'overdue_tasks'>>(
  subjects: T[],
  option: SubjectSortOption,
): T[] {
  const sorted = [...subjects];
  if (option === 'alphabetical') {
    sorted.sort((a, b) => a.title.localeCompare(b.title));
    return sorted;
  }
  sorted.sort((a, b) => {
    const overdueDiff = (b.overdue_tasks ?? 0) - (a.overdue_tasks ?? 0);
    if (overdueDiff !== 0) return overdueDiff;
    const openDiff = (b.open_tasks ?? 0) - (a.open_tasks ?? 0);
    if (openDiff !== 0) return openDiff;
    return a.title.localeCompare(b.title);
  });
  return sorted;
}

const SUBJECT_SORT_KEYS = {
  envisioning: 'meet.workSidebar.sort.envisioning',
  project: 'meet.workSidebar.sort.projects',
  lead: 'meet.workSidebar.sort.leads',
} as const;

/** Which list a remembered sort belongs to — Mine and Team/Agents have none. */
export type SubjectSortListKey = keyof typeof SUBJECT_SORT_KEYS;

function isSubjectSortOption(value: string): value is SubjectSortOption {
  return value === 'busiest' || value === 'alphabetical';
}

/**
 * The remembered sort for one list, from `localStorage` — keyed like the
 * Mac's `WorkSidebarPreferences` (`meet.workSidebar.sort.*`) though the
 * storage mechanism differs; web has no per-user preference store of its
 * own. Missing or invalid falls back to Busiest First rather than throwing.
 */
export function readSubjectSort(list: SubjectSortListKey): SubjectSortOption {
  const stored = readStored(SUBJECT_SORT_KEYS[list]);
  return isSubjectSortOption(stored) ? stored : 'busiest';
}

export function writeSubjectSort(list: SubjectSortListKey, option: SubjectSortOption): void {
  writeStored(SUBJECT_SORT_KEYS[list], option);
}

const SUBJECT_STATUS_KEYS: Record<SubjectSortListKey, string> = {
  envisioning: 'meet.workSidebar.filter.envisioning',
  project: 'meet.workSidebar.filter.projects',
  lead: 'meet.workSidebar.filter.leads',
};

/**
 * The status choices a Browse group offers and what it opens on come from the one
 * table every client reads (`@starlings/contracts/subject-status`). `open` is
 * a product filter, not a Core status: Active and Paused, so Archived is an
 * explicit choice.
 */
const statusChoices = (list: SubjectSortListKey) => SUBJECT_STATUS_CHOICES[list === 'lead' ? 'lead' : 'project'];

export function subjectStatusOptions(list: SubjectSortListKey): readonly string[] {
  return statusChoices(list).filter;
}

/** What a list opens on until the person picks another; also what the Worker answers with no `status`. */
export function defaultSubjectStatus(list: SubjectSortListKey): string {
  return statusChoices(list).defaultFilter;
}

const SUBJECT_STATUS_LABELS: Record<string, string> = {
  open: t('Open'),
  Active: t('Active'),
  Paused: t('Paused'),
  Archived: t('Archived'),
  all: t('All'),
  Conversations: t('Conversations'),
  'Opportunity Identified': t('Opportunity Identified'),
  'Proposal Out': t('Proposal Out'),
  'Active Negotiation': t('Active Negotiation'),
  'Waiting on External Factor': t('Waiting on External Factor'),
  'Closed Won': t('Closed Won'),
  'Closed Lost': t('Closed Lost'),
};

export function subjectStatusLabel(status: string): string {
  return SUBJECT_STATUS_LABELS[status] ?? status;
}

/** The remembered status filter for one Browse list; missing or unknown falls back to the default. */
export function readSubjectStatus(list: SubjectSortListKey): string {
  const stored = readStored(SUBJECT_STATUS_KEYS[list]);
  return stored && subjectStatusOptions(list).includes(stored) ? stored : defaultSubjectStatus(list);
}

export function writeSubjectStatus(list: SubjectSortListKey, status: string): void {
  writeStored(SUBJECT_STATUS_KEYS[list], status);
}

/** The Organizations group's filter, per device, under the Mac's key. */
const ORGANIZATION_FILTER_KEY = 'meet.workSidebar.filter.organizations';

export function readOrganizationFilter(): OrganizationListFilter {
  try {
    const stored = JSON.parse(readStored(ORGANIZATION_FILTER_KEY) || 'null') as Partial<OrganizationListFilter> | null;
    if (!stored || typeof stored !== 'object') return DEFAULT_ORGANIZATION_FILTER;
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
    return {
      partner: stored.partner !== false,
      agency: stored.agency === true,
      existing_client: stored.existing_client === true,
      ...(text(stored.industry) ? { industry: text(stored.industry) } : {}),
      ...(text(stored.country) ? { country: text(stored.country) } : {}),
    };
  } catch {
    return DEFAULT_ORGANIZATION_FILTER;
  }
}

export function writeOrganizationFilter(filter: OrganizationListFilter): void {
  if (isDefaultOrganizationFilter(filter)) removeStored(ORGANIZATION_FILTER_KEY);
  else writeStored(ORGANIZATION_FILTER_KEY, JSON.stringify(filter));
}

/** `GET /api/crm/subject-counts`: one number per status for a kind; projects also split by Envisioning and client. */
export async function fetchSubjectCounts(kind: 'project' | 'lead'): Promise<CrmSubjectCountsResponse> {
  return apiFetch<CrmSubjectCountsResponse>(`/crm/subject-counts?${new URLSearchParams({ kind })}`, {
    fallbackError: t('Couldn’t load subject counts.'),
    noStore: true,
  });
}

/** Organizations only: the columns Core keeps, as the wire names them, and the relationships the Worker reads from records. */
type OrganizationProfile = Pick<CrmSubjectDetailWire,
  | 'legal_name' | 'address' | 'postcode' | 'city' | 'country' | 'vat_id' | 'tax_id' | 'size' | 'owner_id' | 'founded'
  | 'hq_location' | 'company_type' | 'linkedin_url' | 'logo_url' | 'logo_image_url' | 'profile_image_url' | 'entity' | 'domain'
  | 'is_agency' | 'is_existing_client' | 'is_partner' | 'relationships'>;

export interface CrmSubjectDetail extends CrmSubject, OrganizationProfile {
  status: string;
  updated_at: string | null;
  description?: string | null;
  url?: string | null;
  organization_id?: string | null;
  contact_id?: string | null;
  lead_id?: string | null;
  license_id?: string | null;
  contact_ids?: string[];
  evid?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  notes?: string | null;
  /** A lead's characteristics; the five qualification checks live here. */
  characteristics?: Record<string, boolean> | null;
  /** Partners only: the organization's industry and what hangs off the relationship. */
  industry?: string | null;
  /** Events only (docs/EVENTS.md): where and when, from the CMS row. */
  start_at?: string | null;
  timezone?: string | null;
  location?: string | null;
  place?: string | null;
  image_url?: string | null;
  host?: string | null;
  partner?: string | null;
  partner_url?: string | null;
  related?: {
    projects: Array<{ id: string; title: string | null; status: string | null }>;
    leads: Array<{ id: string; title: string | null; status: string | null }>;
    contacts: Array<{ id: string; name: string | null; email: string | null; title: string | null }>;
  } | null;
}

export interface SubjectDraft {
  kind: SubjectKind;
  title: string;
  status: string;
  start_date: string;
  end_date: string;
  description: string;
  url: string;
  notes: string;
  organization_id: string;
  /** A lead's one contact. */
  contact_id?: string | null;
  /** A project's contacts. */
  contact_ids?: string[];
  /**
   * A lead's characteristics as read, with the five qualification checks as
   * the person left them. Core replaces the whole record on a write, so the
   * rest travels back unchanged.
   */
  characteristics?: Record<string, boolean>;
}

export interface MyWork {
  tasks: CrmMyTask[];
  issues: CrmIssue[];
  /** Null until somebody says who they are on GitHub. */
  githubLogin: string | null;
}

export interface PeerWork {
  tasks: CrmMyTask[];
  issues: CrmIssue[];
  /** False when the roster address has no matching Core member. */
  matched: boolean;
  /** Null until that member says who they are on GitHub. */
  githubLogin: string | null;
}

interface CrmWorkPayload {
  tasks?: CrmMyTask[];
  issues?: CrmIssue[];
  matched?: boolean;
  github_login?: string | null;
}

function normalizeWork(body: CrmWorkPayload) {
  return {
    tasks: body.tasks ?? [],
    issues: body.issues ?? [],
    matched: body.matched === true,
    githubLogin: body.github_login ?? null,
  };
}

/** Everything you owe, across every subject. */
export async function fetchMyWork(): Promise<MyWork> {
  return revalidate(
    SNAPSHOT.mine,
    (ifNoneMatch) => apiFetchConditional<CrmWorkPayload>('/crm/mine', {
      fallbackError: t('Couldn’t load your work.'),
      noStore: true,
      ifNoneMatch,
    }),
    (body) => {
      const work = normalizeWork(body);
      return { tasks: work.tasks, issues: work.issues, githubLogin: work.githubLogin };
    },
  );
}

/** The signed-in member's own recently closed tasks and issues, newest first. */
export async function fetchRecentlyClosedWork(): Promise<CrmRecentlyClosedWorkResponse> {
  return apiFetch<CrmRecentlyClosedWorkResponse>('/crm/recently-closed', {
    fallbackError: t('Couldn’t load recently finished work.'),
    noStore: true,
  });
}

/** Open work nobody on our side holds (docs/BOARD.md §Unowned); the Worker applies the rule. */
export async function fetchUnownedWork(): Promise<CrmUnownedWorkResponse> {
  return apiFetch<CrmUnownedWorkResponse>('/crm/unowned', {
    fallbackError: t('Couldn’t load unowned work.'),
    noStore: true,
  });
}

/** Put a recently closed row back into open work. */
export async function reopenRecentlyClosedWork(item: CrmRecentlyClosedItem): Promise<void> {
  if (item.kind === 'task') {
    await apiFetch(`/crm/tasks/${item.id}`, {
      method: 'PATCH',
      body: { status: 'pending' },
      fallbackError: t('Couldn’t reopen that task.'),
    });
    invalidateFor('task.update');
    return;
  }
  if (!item.issue) throw new Error(t('Couldn’t reopen that issue.'));
  await setIssueState(item.issue, 'reopen', item.project_id ?? undefined);
}

/** Everything one colleague owes, for Team's person information surface. */
/** A subject you and a colleague both have open tasks on, and how many each. */
export interface SharedSubject {
  subject: { kind: 'project' | 'lead' | 'event' | 'organization'; id: string };
  title: string;
  theirs: number;
  mine: number;
}

/**
 * Subjects you both have open work on — the intersection is the whole
 * definition of "shared" the panel can honestly claim (the Mac's
 * `sharedSubjects`): two people with tasks on one project are working
 * together on it. Busiest first.
 */
export function sharedSubjects(mine: CrmMyTask[], theirs: CrmMyTask[]): SharedSubject[] {
  const group = (tasks: CrmMyTask[]) => {
    const by = new Map<string, { subject: NonNullable<ReturnType<typeof workSubjectOf>>; title: string | null; count: number }>();
    for (const task of tasks) {
      if (isTaskDone(task.status)) continue;
      const subject = workSubjectOf(task);
      if (!subject) continue;
      const key = `${subject.kind}:${subject.id}`;
      const entry = by.get(key);
      if (entry) entry.count += 1;
      else by.set(key, { subject, title: task.subject_title, count: 1 });
    }
    return by;
  };
  const ours = group(mine);
  const result: SharedSubject[] = [];
  for (const [key, them] of group(theirs)) {
    const us = ours.get(key);
    if (!us) continue;
    result.push({ subject: them.subject, title: them.title ?? us.title ?? t('Untitled'), theirs: them.count, mine: us.count });
  }
  return result.sort((a, b) => (b.theirs + b.mine) - (a.theirs + a.mine));
}

export async function fetchPeerWork(email: string): Promise<PeerWork> {
  const body = await apiFetch<CrmWorkPayload>(`/crm/work?assignee_email=${encodeURIComponent(email)}`, {
    fallbackError: t('Couldn’t load their work.'),
    noStore: true,
  });
  const work = normalizeWork(body);
  return {
    tasks: work.tasks,
    issues: work.issues,
    matched: work.matched,
    githubLogin: work.githubLogin,
  };
}

/** Say who you are on GitHub. Only ever your own record. */
export async function setGithubLogin(login: string | null): Promise<string | null> {
  const body = await apiFetch<{ github_login?: string | null }>('/crm/mine', {
    method: 'PATCH',
    fallbackError: t('Couldn’t save that username.'),
    body: { github_login: login },
  });
  invalidateFor('githubLogin.set');
  return body.github_login ?? null;
}

/**
 * Past its civil day, the same rule the shared work plan uses: work due
 * earlier today is due today, not late. Undated work is never late; it was
 * never promised.
 */
export function isOverdue(due: string | null): boolean {
  return isLateDate(due);
}

/**
 * One planned row for the page to render — the task or the issue it wraps.
 * `planWork` (fixtures/work-items.json) deduped a promoted task against its
 * issue, so exactly one side is set. It carries the stage fields too, so the
 * same row can be planned into a section or dealt onto the board.
 */
export type PlannedRow = WorkCardShape & (
  | { origin: 'task'; myTask: CrmMyTask; task?: undefined; issue?: undefined }
  | { origin: 'task'; task: CrmTask; myTask?: undefined; issue?: undefined }
  | { origin: 'issue'; issue: CrmIssue; task?: undefined; myTask?: undefined }
);

function githubRefOf(
  task: Pick<CrmTask, 'github_owner' | 'github_repo' | 'github_issue_number'>,
): string | null {
  if (!task.github_owner || !task.github_repo || !task.github_issue_number) return null;
  return `${task.github_owner}/${task.github_repo}#${task.github_issue_number}`;
}

function issueItem(issue: CrmIssue): PlannedRow {
  return {
    origin: 'issue',
    issue,
    id: issue.id,
    done: issue.state !== 'open',
    filed: true,
    dueDate: null,
    updatedAt: issue.updated_at,
    githubRef: null,
    state: issue.state,
    stateReason: issue.state_reason ?? null,
    labels: issue.labels,
  };
}

function taskItem(task: CrmTask, kind: 'subject'): Extract<PlannedRow, { task: CrmTask }>;
function taskItem(task: CrmMyTask, kind: 'mine'): Extract<PlannedRow, { myTask: CrmMyTask }>;
function taskItem(task: CrmMyTask | CrmTask, kind: 'mine' | 'subject'): PlannedRow {
  const base = {
    id: task.id,
    done: isTaskDone(task.status),
    filed: workSubjectOf(task) !== null,
    dueDate: task.due_date,
    updatedAt: task.updated_at,
    githubRef: githubRefOf(task),
    status: task.status,
  };

  // The API returns a smaller summary for Mine and a full record for a
  // subject. Normalize both through the same planner row; the source kind is
  // explicit because both shared contract types carry responsible_party.
  if (kind === 'subject') {
    return { origin: 'task', task: task as CrmTask, ...base };
  }
  return { origin: 'task', myTask: task as CrmMyTask, ...base };
}

function planTasksAndIssues(
  tasks: Array<CrmMyTask | CrmTask>,
  issues: CrmIssue[],
  kind: 'mine' | 'subject',
): WorkPlan<PlannedRow> {
  const rows: PlannedRow[] = [
    ...(kind === 'subject'
      ? tasks.map((task) => taskItem(task as CrmTask, 'subject'))
      : tasks.map((task) => taskItem(task as CrmMyTask, 'mine'))),
    ...issues.map(issueItem),
  ];
  return planWork(rows, Date.now());
}

function matchesMineQuery(row: PlannedRow, query: string): boolean {
  const values = row.issue
    ? [
      row.issue.title,
      row.issue.owner,
      row.issue.repo,
      row.issue.id,
      `#${row.issue.number}`,
      row.issue.assignee_login,
      ...(row.issue.assignees?.map((one) => one.login) ?? []),
      row.issue.author?.login,
    ]
    : [
      row.myTask?.title,
      row.myTask?.subject_title,
      row.myTask?.github_owner,
      row.myTask?.github_repo,
      row.myTask?.github_issue_number === null || row.myTask?.github_issue_number === undefined
        ? null
        : String(row.myTask.github_issue_number),
      row.myTask?.github_issue_number === null || row.myTask?.github_issue_number === undefined
        ? null
        : `#${row.myTask.github_issue_number}`,
    ];
  // The one matcher (invariant 27): the title is the title, the rest is the
  // subtitle a token can still reach.
  const parts = values.filter((value): value is string => typeof value === 'string' && value.length > 0);
  return searchMatches(query, parts[0] ?? '', parts.slice(1).join(' '));
}

/**
 * "Couldn't read proposed tasks on Acme, Globex" — the sources named as a
 * person says them (`INBOX_SOURCE_SPECS`' `partial`), and for tasks which
 * subjects. Same line as the Mac's `WorkInboxResponse.partialLine`.
 */
export function inboxPartialLine(inbox: Pick<InboxResponse, 'partial' | 'task_partial'>): string | null {
  if (inbox.partial.length === 0) return null;
  const subjects = inbox.task_partial ?? [];
  const names = inbox.partial.map((source) => {
    const noun = inboxSourceSpec(source)?.partial ?? source;
    if (source !== 'task' || subjects.length === 0) return noun;
    return `${noun} on ${subjects.slice(0, 3).join(', ')}${subjects.length > 3 ? ` and ${subjects.length - 3} more` : ''}`;
  });
  return `Couldn’t read ${names.join(', ')}.`;
}

/**
 * A source read up to its ceiling: what shows is right, and more is past
 * the cap. Not a failure, so no Retry. Same line as the Mac's
 * `WorkInboxResponse.cappedLine`.
 */
export function inboxCappedLine(inbox: Pick<InboxResponse, 'capped'>): string | null {
  return inbox.capped?.includes('comment') ? t('Showing comments on the newest documents only.') : null;
}

/**
 * The card board (docs/BOARD.md): every open task and issue on every subject,
 * read once from the Worker and dealt into the six stages by the shared
 * `planBoard`. `traces` are the last event line naming a card. A project's
 * Board pane draws one project's; no page draws the
 * company-wide one.
 */
// The board's wire shape is the contract's; `CrmBoardResponse`
// and `CardTrace` are no longer copied here.
export type { CardTrace, CrmBoardResponse } from '@starlings/contracts/crm';

export type BoardCard = PlannedRow & {
  subject: CrmSubject | null;
  trace: CardTrace | null;
};

/**
 * The Due and Side filters on a board card or a planned row:
 * the shared `passesTaskFilter`, with the task's side read off its record.
 */
export function cardPassesTaskFilter(card: PlannedRow, filter: WorkTaskFilter, nowMs: number = Date.now()): boolean {
  const record = card.task ?? card.myTask;
  return passesTaskFilter({ ...card, responsibleParty: record?.responsible_party ?? null }, filter, nowMs);
}

/** The same filters on a subject's Tasks list, which holds task records. */
export function taskPassesTaskFilter(task: Pick<CrmTask, 'status' | 'due_date' | 'responsible_party'>, filter: WorkTaskFilter, nowMs: number = Date.now()): boolean {
  return passesTaskFilter({ origin: 'task', status: task.status, dueDate: task.due_date, responsibleParty: task.responsible_party }, filter, nowMs);
}

/** The board; `projectId` reads one project's. */
export async function fetchBoard(projectId?: string): Promise<CrmBoardResponse> {
  const query = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  return apiFetch<CrmBoardResponse>(`/crm/board${query}`, { noStore: true, fallbackError: t('Couldn’t load the board.') });
}

/** The response as cards, each with its subject and last event line. */
export function boardCards(response: CrmBoardResponse): BoardCard[] {
  // Keyed by kind and id: a partner is its organization, and shares no id space with a project or lead.
  const subjects = new Map(response.subjects.map((subject) => [`${subject.kind}:${subject.id}`, subject]));
  const subjectOf = (row: Parameters<typeof workSubjectOf>[0]): CrmSubject | null => {
    const filed = workSubjectOf(row);
    return filed ? subjects.get(`${filed.kind}:${filed.id}`) ?? null : null;
  };
  const traces = new Map(response.traces.map((trace) => [`${trace.ref_kind}:${trace.ref_id}`, trace]));
  const tasks = response.tasks.map((task): BoardCard => ({
    ...taskItem(task, 'subject'),
    subject: subjectOf(task),
    trace: traces.get(`task:${task.id}`) ?? null,
  }));
  const issues = response.issues.map((issue): BoardCard => ({
    ...issueItem(issue),
    // An issue is read for a project; a partner has none.
    subject: subjects.get(`project:${response.issue_projects[issue.id] ?? ''}`) ?? null,
    trace: traces.get(`issue:${issue.id}`) ?? null,
  }));
  return [...tasks, ...issues];
}

/**
 * Hand a card to an agent: a message in the agent's conversation
 * that carries the card as its ref and the brief as `handoff`. The text
 * repeats the brief for the person reading later. The Mac's `handOff`.
 */
/**
 * What a hand-off names: a Board card, or a subject's task row.
 * Its subject is where it is said: the subject's channel, so everyone who
 * sees the card sees the work. A card with no subject goes to the agent's
 * direct conversation.
 */
export type HandOffCard = Pick<BoardCard, 'id'> & {
  task?: Pick<CrmTask, 'id' | 'title'> | undefined;
  issue?: Pick<CrmIssue, 'id' | 'number' | 'title'> | undefined;
  subject: Pick<CrmSubject, 'kind' | 'id'> | null;
};

export async function handOffCard(card: HandOffCard, agentEmail: string, handoff: ThreadHandoff): Promise<void> {
  const opened = await apiFetch<{ thread: { id: string } }>('/threads', {
    method: 'POST',
    body: card.subject ? { kind: card.subject.kind, subject_id: card.subject.id } : { peer_email: agentEmail },
    fallbackError: t('Couldn’t open this conversation.'),
  });
  const line = card.issue
    ? t('Take #{number}: {title}', { number: card.issue.number, title: card.issue.title })
    : t('Take this task: {title}', { title: card.task?.title ?? '' });
  const ref = card.issue ? { kind: 'issue' as const, id: card.issue.id } : { kind: 'task' as const, id: card.task?.id ?? card.id };
  await apiFetch(`/threads/${encodeURIComponent(opened.thread.id)}/messages`, {
    method: 'POST',
    body: {
      // In a channel the agent is named by @mention: that is how a channel
      // reaches an agent, and the Worker refuses a hand-off without it.
      text: [
        card.subject ? `@${localPartOf(agentEmail)} ${line}` : line,
        t('Done when: {text}', { text: handoff.done_when }),
        t('Deliverable: {text}', { text: handoff.deliverable }),
      ].join('\n'),
      refs: [ref],
      ...(card.subject ? { mentions: [agentEmail] } : {}),
      handoff,
    },
    fallbackError: t('Couldn’t hand that off.'),
  });
  invalidateFor('thread.message');
}

/**
 * The one write a stage move makes (`writeStage`): a task's status, or an
 * issue's state and whole label set, told to the project whose channel
 * hears about it.
 */
export async function moveCard(card: BoardCard, stage: WorkStage): Promise<void> {
  const write = writeStage(card, stage);
  if (write.kind === 'task') {
    await apiFetch<{ task: CrmTask }>(`/crm/tasks/${card.id}`, {
      method: 'PATCH',
      body: { status: write.status },
      fallbackError: t('Couldn’t move that card.'),
    });
    invalidateFor('task.update');
    return;
  }
  const issue = card.issue!;
  await apiFetch<unknown>('/crm/issue', {
    method: 'PATCH',
    body: {
      owner: issue.owner,
      repo: issue.repo,
      number: issue.number,
      ...(card.subject?.kind === 'project' ? { project_id: card.subject.id } : {}),
      state: write.state,
      ...(write.state_reason ? { state_reason: write.state_reason } : {}),
      labels: write.labels,
    },
    fallbackError: t('Couldn’t move that card.'),
  });
  invalidateFor('issue.write');
}

/** Everything you owe, in the order it is owed — the shared plan. */
export function planMine(
  tasks: CrmMyTask[],
  issues: CrmIssue[],
  query = '',
  filter = DEFAULT_MINE_FILTER,
): WorkPlan<PlannedRow> {
  const plan = planTasksAndIssues(tasks, issues, 'mine');
  const searched = filterWorkPlan(plan, (row) => matchesMineQuery(row, query));
  return filterMinePlan(searched, filter);
}

/** One colleague's open work, using the same mixed task and issue plan. */
export function planPeerWork(tasks: CrmMyTask[], issues: CrmIssue[]): WorkPlan<PlannedRow> {
  return planTasksAndIssues(tasks, issues, 'mine');
}

/** Overview's UNOWNED: the Worker's rows, in the same plan as Mine. */
export function planUnownedWork(tasks: CrmMyTask[], issues: CrmIssue[]): WorkPlan<PlannedRow> {
  return planTasksAndIssues(tasks, issues, 'mine');
}

/** One subject's open work — tasks and issues, one list, same plan. */
export function planSubjectWork(tasks: CrmTask[], issues: CrmIssue[]): WorkPlan<PlannedRow> {
  return planTasksAndIssues(tasks, issues, 'subject');
}

function eventRelativeLabel(eventDate: string | null | undefined, now: number): string {
  const daysUntil = eventDaysUntil(eventDate, now);
  if (daysUntil === null) return eventPhaseLabel(eventPhase(eventDate, now));
  if (daysUntil < 0) return t('Past');
  if (daysUntil === 0) return t('Today');
  return plural(daysUntil, {
    one: t('{count} day left'),
    other: t('{count} days left'),
  });
}

/** Where a subject stands, in one line: who it is for, then what is open. */
export function subjectStanding(subject: CrmSubject): string {
  // A partner has no tasks of its own in this slice; its subtitle already
  // says place and related work (PARTNERS (HQ Docs)).
  if (isPartner(subject)) return subject.subtitle ?? t('Partner');
  const parts: string[] = [];
  // An event's date is its standing (docs/EVENTS.md).
  if (isEvent(subject)) parts.push(eventRelativeLabel(subject.event_date, Date.now()));
  if (subject.subtitle) parts.push(subject.subtitle);
  parts.push(subject.open_tasks ? `${subject.open_tasks} open` : t('No open tasks'));
  if (subject.overdue_tasks) parts.push(`${subject.overdue_tasks} overdue`);
  if (subject.has_repo) parts.push(t('GitHub'));
  return parts.join(' · ');
}

/** The durable history attached to one project or lead. */
export interface CrmInteractionContact {
  id: string;
  name: string | null;
  email: string | null;
}

export interface CrmInteraction {
  id: string;
  title: string;
  type: 'note' | 'email' | 'call' | 'meeting' | 'web';
  occurred_at: string | null;
  created_at: string | null;
  summary_preview: string | null;
  /** The whole summary, Markdown, for a reader. The preview is one line of it. */
  summary_markdown: string | null;
  transcript_preview: string | null;
  duration_minutes: number | null;
  project_id: string | null;
  lead_id: string | null;
  organization_id: string | null;
  source: string | null;
  channel: string | null;
  status: string | null;
  url: string | null;
  contacts: CrmInteractionContact[];
  /** On a project's History: the lead's row (ADR 0008). */
  from_lead?: boolean;
}

/**
 * The labels with whatever colour is known. A control plane that only sends
 * names still draws, in the page's own grey, rather than not drawing at all.
 */
export function drawableLabels(issue: CrmIssue): CrmIssueLabel[] {
  if (issue.label_details?.length) return issue.label_details;
  return issue.labels.map((name) => ({ name, color: null, description: null }));
}

/**
 * A project's GitHub issues. `linked` false means its work does not live in
 * GitHub, which is not the same as having none — the section stays away rather
 * than claiming zero.
 */
export async function fetchIssues(projectId: string): Promise<{ issues: CrmIssue[]; linked: boolean }> {
  const body = await apiFetch<{ issues?: CrmIssue[]; linked?: boolean }>(
    `/crm/issues?project_id=${encodeURIComponent(projectId)}`,
    { fallbackError: t('Couldn’t load issues.'), noStore: true },
  );
  return { issues: body.issues ?? [], linked: body.linked === true };
}

/** A team member as the Worker answers: a person or an agent. */
export type { CrmTeamMember };

/** Core's own wording, drawn in the page's language. `team` is stored; the workspace's name is what people read. */
const labelled = <K extends string>(labels: Record<K, string>) =>
  Object.fromEntries(Object.entries<string>(labels).map(([key, label]) => [key, t(label)])) as Record<K, string>;

/** The words are the contract's (`task-values.ts`), drawn in the page's language. */
export const RESPONSIBLE_LABEL: Record<CrmTask['responsible_party'], string> = {
  ...labelled(CRM_RESPONSIBLE_LABELS),
  // The workspace's own side reads as the workspace's name.
  team: workspaceBrand().name,
};
export const STATUS_LABEL: Record<CrmTask['status'], string> = labelled(CRM_TASK_STATUS_LABELS);

/** A Side menu row's word (`WORK_SIDE_CHOICES`): the team side reads as the workspace's name, as `RESPONSIBLE_LABEL` does. */
export function sideChoiceTitle(choice: { value: string; title: string }): string {
  return choice.value === 'team' ? workspaceBrand().name : t(choice.title);
}

export interface SubjectPage {
  subjects: CrmSubject[];
  /** More exist than came back — past this the answer is to search. */
  hasMore: boolean;
  /** Organizations only: every industry and country, for the filter menus. */
  facets?: CrmOrganizationFacets;
}

/**
 * Core's organization list filters, as the Organizations group
 * holds them. Partner is on by default, so the default view is the partners.
 * Wire names, so the fixture reads the same on every client.
 */
export interface OrganizationListFilter {
  partner: boolean;
  agency: boolean;
  existing_client: boolean;
  industry?: string;
  country?: string;
}

export const DEFAULT_ORGANIZATION_FILTER: OrganizationListFilter = { partner: true, agency: false, existing_client: false };

/** True when the filter is the default view, the partners. */
export function isDefaultOrganizationFilter(filter: OrganizationListFilter): boolean {
  return filter.partner && !filter.agency && !filter.existing_client && !filter.industry?.trim() && !filter.country?.trim();
}

/**
 * The query string of `GET /api/crm/subjects`, in the contract's order. The
 * Mac and iOS build the same one in `CrmSubjectsQuery.browse`;
 * `fixtures/subject-query.json` pins both. `today` is this device's day: only
 * an event is open or closed by it. An organization filter sends only what
 * differs from the default.
 */
export function subjectsSearchParams(
  kind: SubjectKind,
  query: string,
  status?: string,
  today?: string,
  organizations?: OrganizationListFilter,
  leadSource?: string,
): URLSearchParams {
  const search = new URLSearchParams({ kind });
  if (query.trim()) search.set('q', query.trim());
  // Partners carry no status on the read that takes one.
  if (status?.trim() && (kind === 'lead' || kind === 'project' || kind === 'event')) search.set('status', status.trim());
  // An event is open where the reader is (docs/EVENTS.md): the day here,
  // not the Worker's UTC day.
  if (kind === 'event' && today) search.set('today', today);
  if (kind === 'lead' && leadSource) search.set('source', leadSource);
  if (kind === 'organization' && organizations) {
    if (!organizations.partner) search.set('partner', 'false');
    if (organizations.agency) search.set('agency', 'true');
    if (organizations.existing_client) search.set('existing_client', 'true');
    if (organizations.industry?.trim()) search.set('industry', organizations.industry.trim());
    if (organizations.country?.trim()) search.set('country', organizations.country.trim());
  }
  return search;
}

export async function fetchSubjects(kind: SubjectKind, query: string, status?: string, organizations?: OrganizationListFilter, leadSource?: string): Promise<SubjectPage> {
  const search = subjectsSearchParams(kind, query, status, localCivilDate(), organizations, leadSource);
  // A filtered organization list keeps its own snapshot, the way a status does.
  const filterTag = kind === 'organization' && organizations && !isDefaultOrganizationFilter(organizations)
    ? subjectsSearchParams(kind, '', undefined, undefined, organizations).toString()
    : leadSource ? `${status ?? ''}:source=${leadSource}` : status;
  return revalidate(
    subjectsSnapshotKey(kind, filterTag ? `${filterTag}:${query}` : query),
    (ifNoneMatch) => apiFetchConditional<{ subjects: CrmSubject[]; has_more?: boolean; facets?: CrmOrganizationFacets }>(
      `/crm/subjects?${search}`,
      { fallbackError: t('Couldn’t load projects.'), noStore: true, ifNoneMatch },
    ),
    (body) => ({ subjects: body.subjects ?? [], hasMore: body.has_more === true, ...(body.facets ? { facets: body.facets } : {}) }),
  );
}

/** Today as the CMS spells a date, `YYYY-MM-DD`, in this device's zone. */
function localCivilDate(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export async function fetchSubjectDetail(subject: CrmSubject): Promise<CrmSubjectDetail> {
  const body = await apiFetch<{ subject: CrmSubjectDetail }>(
    `/crm/subjects/${subject.kind}/${encodeURIComponent(subject.id)}`,
    { fallbackError: t('Couldn’t load that subject.'), noStore: true },
  );
  return body.subject;
}

/** An organization's open tasks, one group per project, for its Tasks pane By project. */
export async function fetchOrganizationProjectTasks(id: string): Promise<CrmOrganizationProjectTasksResponse> {
  return apiFetch<CrmOrganizationProjectTasksResponse>(`/crm/subjects/organization/${encodeURIComponent(id)}/project-tasks`, {
    noStore: true,
    fallbackError: t('Couldn’t load tasks.'),
  });
}

/** Core's owner-scoped organization search for the Work subject editor. */
export async function searchCrmOrganizations(query: string): Promise<CrmOrganizationOption[]> {
  const search = new URLSearchParams({ q: query.trim() });
  const body = await apiFetch<CrmOrganizationsResponse>(`/crm/organizations?${search}`, {
    fallbackError: t('Couldn’t search organizations.'),
    noStore: true,
  });
  return body.organizations;
}

/** Create the minimal Core organization, then select it in the open editor. */
export async function createCrmOrganization(name: string): Promise<CrmOrganizationOption> {
  const body = await apiFetch<CrmOrganizationResponse>('/crm/organizations', {
    method: 'POST',
    fallbackError: t('Couldn’t create that organization.'),
    body: formBody('organization', 'create', { name }),
  });
  return body.organization;
}

/**
 * An organization's fields: only the fields named change, on
 * the store the subjects group answers from. Answers the detail.
 */
export async function updateCrmOrganization(id: string, patch: CrmOrganizationUpdate): Promise<CrmSubjectDetail> {
  const body = await apiFetch<{ subject: CrmSubjectDetail }>(`/crm/subjects/organization/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    fallbackError: t('Couldn’t save that organization.'),
    body: patch,
  });
  return body.subject;
}

/**
 * Merge organizations. The oldest stays; every link moves onto it
 * and the others are deleted. Core merges while the subjects group is there,
 * the Worker on D1 after; the answer is the same from both.
 */
export async function mergeCrmOrganizations(ids: string[]): Promise<CoreMergeResponse> {
  return apiFetch<CoreMergeResponse>('/core/merge/organizations', {
    method: 'POST',
    body: { ids } satisfies CoreMergeBody,
    fallbackError: t('Couldn’t merge those organizations.'),
  });
}

/** Delete an organization. Refused while a project, lead, contact or task still points at it. */
export async function deleteCrmOrganization(id: string): Promise<CrmOrganizationDeleteResponse> {
  return apiFetch<CrmOrganizationDeleteResponse>(`/crm/subjects/organization/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    fallbackError: t('Couldn’t delete that organization.'),
  });
}

/**
 * A subject's body, as `FORM_FIELDS` says each field and each blank goes: a
 * blank is left out or cleared, never sent as `""` (zod refuses `""` for a
 * uuid and a url). Only the fields the kind's form draws.
 */
function subjectBody(draft: SubjectDraft, write: 'create' | 'update'): Record<string, unknown> {
  const shared = { title: draft.title, status: draft.status, organization: draft.organization_id, startDate: draft.start_date };
  if (draft.kind === 'lead') {
    return formBody('lead', write, {
      ...shared,
      ...(draft.contact_id !== undefined ? { contact: draft.contact_id } : {}),
      notes: draft.notes,
      characteristics: draft.characteristics,
    });
  }
  return formBody('project', write, {
    ...shared,
    contacts: draft.contact_ids ?? [],
    endDate: draft.end_date,
    url: draft.url,
    description: draft.description,
  });
}

export async function createSubject(draft: SubjectDraft): Promise<CrmSubjectDetail> {
  const body = await apiFetch<{ subject: CrmSubjectDetail }>('/crm/subjects', {
    method: 'POST',
    fallbackError: t('Couldn’t create that {kind}.', { kind: draft.kind }),
    body: { kind: draft.kind, ...subjectBody(draft, 'create') },
  });
  invalidateFor('subject.write');
  return body.subject;
}

/**
 * Choose who answers for a project or lead, or null to clear the choice
 * (docs/OWNERSHIP.md). A name, never a permission.
 */
export async function setSubjectResponsible(subject: CrmSubject, email: string | null): Promise<CrmSubjectDetail> {
  const body = await apiFetch<{ subject: CrmSubjectDetail }>(
    `/crm/subjects/${subject.kind}/${encodeURIComponent(subject.id)}`,
    { method: 'PATCH', fallbackError: t('Couldn’t change who is responsible.'), body: { responsible_email: email } },
  );
  invalidateFor('subject.write');
  return body.subject;
}

/**
 * After the call: approve one draft revision. The ticked tasks are
 * accepted and the rest declined; the answer is the mail draft to open.
 */
export async function approveFollowUp(item: InboxFollowUpItem, input: { subject: string; body: string; accept: string[]; decline: string[] }): Promise<MeetingFollowUpApproveResponse> {
  const body = await apiFetch<MeetingFollowUpApproveResponse>(
    `/rooms/${encodeURIComponent(item.meeting.room_slug)}/meetings/${encodeURIComponent(item.meeting.id)}/follow-up`,
    {
      method: 'POST',
      fallbackError: t('Couldn’t approve that follow-up.'),
      body: { revision: item.revision, subject: input.subject, body: input.body, accept_task_ids: input.accept, decline_task_ids: input.decline },
    },
  );
  invalidateFor('task.update');
  return body;
}

/** The host does not want the follow-up; its tasks stay in INBOX. */
export async function dismissFollowUp(item: InboxFollowUpItem): Promise<void> {
  await apiFetch(`/rooms/${encodeURIComponent(item.meeting.room_slug)}/meetings/${encodeURIComponent(item.meeting.id)}/follow-up`, {
    method: 'DELETE', fallbackError: t('Couldn’t dismiss that follow-up.'),
  });
}

export async function updateSubject(subject: CrmSubject, draft: SubjectDraft): Promise<CrmSubjectDetail> {
  const body = await apiFetch<{ subject: CrmSubjectDetail }>(
    `/crm/subjects/${subject.kind}/${encodeURIComponent(subject.id)}`,
    {
      method: 'PATCH',
      fallbackError: t('Couldn’t update that {kind}.', { kind: draft.kind }),
      // The editor shows the contacts, so its answer is the whole list.
      body: subjectBody(draft, 'update'),
    },
  );
  invalidateFor('subject.write');
  return body.subject;
}

/** The Worker's Win answer (`CrmLeadWinResponse`), with the web's own project detail. */
export type LeadWin = Omit<CrmLeadWinResponse, 'project'> & { project: CrmSubjectDetail };

/**
 * Win on an open lead (ADR 0008): the Worker starts a project from the lead,
 * moves the named open tasks to it, then closes the lead as won.
 */
export async function winLead(lead: CrmSubject, input: { title: string | null; task_ids: string[] }): Promise<LeadWin> {
  const body = await apiFetch<LeadWin>(`/crm/subjects/lead/${encodeURIComponent(lead.id)}/win`, {
    method: 'POST',
    fallbackError: t('Couldn’t win that lead.'),
    body: { title: input.title?.trim() || null, task_ids: input.task_ids },
  });
  invalidateFor('subject.write');
  invalidateFor('task.update');
  return body;
}

export async function fetchTasks(subject: CrmSubject): Promise<CrmTask[]> {
  const search = new URLSearchParams(taskSubjectQuery(subject));
  return revalidate(
    tasksSnapshotKey(subject),
    (ifNoneMatch) => apiFetchConditional<{ tasks: CrmTask[] }>(`/crm/tasks?${search}`, {
      fallbackError: t('Couldn’t load tasks.'),
      noStore: true,
      ifNoneMatch,
    }),
    (body) => body.tasks ?? [],
  );
}

/** Resolve a shared favorite directly, even when its task is not on Mine. */
export async function fetchTaskByID(id: string): Promise<CrmTask> {
  const body = await apiFetch<{ task: CrmTask }>(`/crm/tasks/${encodeURIComponent(id)}`, {
    fallbackError: t('Couldn’t load that task.'),
  });
  return body.task;
}

/** One row of the cross-subject feed (`GET /api/crm/feed`, docs/TIMELINE.md Phase 3). */
/**
 * The subject's quiet event trail (docs/WORK.md §3b) — the same lines Talk
 * draws, read here so History does not need Talk to have been opened first.
 * Best-effort: a thread that fails to open just means no events this time,
 * never an error for the pane, which stays reserved for the interactions read.
 */
export async function fetchSubjectEvents(subject: CrmSubject): Promise<ThreadMessage[]> {
  try {
    const opened = await apiFetch<{ thread: { id: string } }>('/threads', {
      method: 'POST',
      body: { kind: subject.kind, subject_id: subject.id },
      fallbackError: t('Couldn’t open this conversation.'),
    });
    const page = await apiFetch<{ messages: ThreadMessage[] }>(
      `/threads/${encodeURIComponent(opened.thread.id)}/messages?limit=50`,
      { noStore: true, fallbackError: t('Couldn’t load this conversation.') },
    );
    return (page.messages ?? []).filter((message) => message.type === 'event');
  } catch {
    return [];
  }
}

/** The interactions query for a subject of any kind — a partner reads by its organization, which is its id. */
export function interactionsQuery(subject: Pick<CrmSubject, 'kind' | 'id'>): Record<string, string> {
  switch (subject.kind) {
    case 'project': return { project_id: subject.id };
    case 'lead': return { lead_id: subject.id };
    case 'organization': return { organization_id: subject.id };
    // Core files meetings under projects, leads and organizations; an event
    // has no history yet (docs/EVENTS.md slice 3). An empty query reads nothing.
    case 'event': return {};
  }
}

export async function fetchInteractions(subject: CrmSubject): Promise<CrmInteraction[]> {
  const search = new URLSearchParams(interactionsQuery(subject));
  return revalidate(
    interactionsSnapshotKey(subject),
    (ifNoneMatch) => apiFetchConditional<{ interactions: CrmInteraction[] }>(`/crm/interactions?${search}`, {
      fallbackError: t('Couldn’t load interactions.'),
      noStore: true,
      ifNoneMatch,
    }),
    (body) => body.interactions ?? [],
  );
}

/**
 * A call, meeting or note in the History editor. The time is the
 * local `YYYY-MM-DDTHH:MM` the date and clock fields speak; a link is an id,
 * or empty for none.
 */
export interface InteractionDraft {
  type: CrmInteraction['type'];
  title: string;
  occurred_at: string;
  summary: string;
  url: string;
  organization_id: string;
  lead_id: string;
  project_id: string;
  contact_ids: string[];
}

type InteractionLinks = Pick<CrmInteraction, 'organization_id' | 'lead_id' | 'project_id'>;

/** What a new row is filed on: a project fills its project and organization, a lead its lead and organization, an organization itself. */
export function interactionLinksFor(subject: Pick<CrmSubject, 'kind' | 'id' | 'organization_id'>): InteractionLinks {
  const organization = subject.organization_id ?? null;
  switch (subject.kind) {
    case 'project': return { project_id: subject.id, lead_id: null, organization_id: organization };
    case 'lead': return { project_id: null, lead_id: subject.id, organization_id: organization };
    case 'organization': return { project_id: null, lead_id: null, organization_id: subject.id };
    case 'event': return { project_id: null, lead_id: null, organization_id: null };
  }
}

function localMinute(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

/** The editor's first state: the row being edited, or a new call filed on `links`, now. */
export function interactionDraftFor(interaction: CrmInteraction | null, links: InteractionLinks, now = new Date()): InteractionDraft {
  const at = interaction?.occurred_at ?? interaction?.created_at;
  const parsed = at ? new Date(at) : null;
  return {
    type: interaction?.type ?? 'call',
    title: interaction?.title ?? '',
    occurred_at: localMinute(parsed && Number.isFinite(parsed.getTime()) ? parsed : now),
    summary: interaction ? interaction.summary_markdown ?? '' : '',
    url: interaction?.url ?? '',
    organization_id: (interaction ?? links).organization_id ?? '',
    lead_id: (interaction ?? links).lead_id ?? '',
    project_id: (interaction ?? links).project_id ?? '',
    contact_ids: interaction?.contacts.map((contact) => contact.id) ?? [],
  };
}

/** The local minute as an instant with its offset; a clock that is not HH:MM is refused here, not by the Worker. */
export function interactionWireTime(local: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/u.test(local)) throw new Error(t('Enter times as HH:MM in 24-hour time.'));
  const parsed = new Date(local);
  if (!Number.isFinite(parsed.getTime())) throw new Error(t('Enter times as HH:MM in 24-hour time.'));
  return parsed.toISOString();
}

/** A bare host is sent with https://, as the subject editor's URL is. Empty is none. */
export function interactionWireURL(value: string): string | null {
  const url = value.trim();
  if (!url) return null;
  return /^[a-z][a-z\d+.-]*:\/\//iu.test(url) ? url : `https://${url}`;
}

/** `POST /api/crm/interactions`: an empty field is left out. */
export function interactionCreateBody(draft: InteractionDraft): CrmInteractionCreate {
  if (draft.type !== 'call' && draft.type !== 'meeting' && draft.type !== 'note') throw new Error(t('Log a call, a meeting or a note.'));
  const summary = draft.summary.trim();
  const url = interactionWireURL(draft.url);
  return {
    type: draft.type,
    title: draft.title.trim(),
    occurred_at: interactionWireTime(draft.occurred_at),
    ...(summary ? { summary_markdown: summary } : {}),
    ...(url ? { url } : {}),
    ...(draft.organization_id ? { organization_id: draft.organization_id } : {}),
    ...(draft.lead_id ? { lead_id: draft.lead_id } : {}),
    ...(draft.project_id ? { project_id: draft.project_id } : {}),
    contact_ids: [...draft.contact_ids],
  };
}

/**
 * `PATCH /api/crm/interactions/:id`: only what the editor changed. A cleared
 * field is `null`; an unchanged time keeps the stored instant, seconds and all.
 */
export function interactionUpdateBody(original: CrmInteraction, draft: InteractionDraft): CrmInteractionUpdate {
  const before = interactionDraftFor(original, original);
  const body: CrmInteractionUpdate = {};
  if (draft.type !== before.type) body.type = draft.type;
  if (draft.title.trim() !== before.title.trim()) body.title = draft.title.trim();
  if (draft.occurred_at !== before.occurred_at) body.occurred_at = interactionWireTime(draft.occurred_at);
  if (draft.summary.trim() !== before.summary.trim()) body.summary_markdown = draft.summary.trim() || null;
  if (draft.url.trim() !== before.url.trim()) body.url = interactionWireURL(draft.url);
  for (const field of ['organization_id', 'lead_id', 'project_id'] as const) {
    if (draft[field] !== before[field]) body[field] = draft[field] || null;
  }
  const contacts = [...draft.contact_ids].sort().join(',');
  if (contacts !== [...before.contact_ids].sort().join(',')) body.contact_ids = [...draft.contact_ids];
  return body;
}

/** Log: a call, meeting or note filed by hand. */
export async function createInteraction(draft: InteractionDraft): Promise<CrmInteraction> {
  const body = await apiFetch<CrmInteractionResponse>('/crm/interactions', {
    method: 'POST',
    fallbackError: t('Couldn’t log that interaction.'),
    body: interactionCreateBody(draft),
  });
  invalidateFor('interaction.write');
  return body.interaction;
}

/** Edit on the reader: the row moves with its links, so both sides' History goes stale. */
export async function updateInteraction(original: CrmInteraction, draft: InteractionDraft): Promise<CrmInteraction> {
  const body = await apiFetch<CrmInteractionResponse>(`/crm/interactions/${encodeURIComponent(original.id)}`, {
    method: 'PATCH',
    fallbackError: t('Couldn’t update that interaction.'),
    body: interactionUpdateBody(original, draft),
  });
  invalidateFor('interaction.write');
  return body.interaction;
}

/** Delete on the reader; the caller asks first. */
export async function deleteInteraction(interaction: CrmInteraction): Promise<CrmInteractionDeleteResponse> {
  const body = await apiFetch<CrmInteractionDeleteResponse>(`/crm/interactions/${encodeURIComponent(interaction.id)}`, {
    method: 'DELETE',
    fallbackError: t('Couldn’t delete that interaction.'),
  });
  invalidateFor('interaction.write');
  return body;
}

export async function fetchTeam(): Promise<CrmTeamMember[]> {
  const body = await apiFetch<{ members: CrmTeamMember[] }>('/crm/team', {
    fallbackError: t('Couldn’t load the team.'),
    noStore: true,
  });
  return body.members ?? [];
}

export interface TaskDraft {
  title: string;
  notes: string;
  status: CrmTask['status'];
  responsible_party: CrmTask['responsible_party'];
  /**
   * Null is nobody, which is a real choice. Absent on a create is the
   * creator: the Worker assigns them.
   */
  assigned_to?: string | null;
  /** A plain `yyyy-mm-dd` from the date input, or empty for undated. */
  due_date: string;
  /** The goal this task serves. Null is none. */
  goal_id: string | null;
}

/**
 * The date input speaks days; the column stores a timestamp. Noon local keeps a
 * task on the day somebody picked whichever side of the date line reads it.
 */
function wireDate(day: string): string | null {
  if (!day) return null;
  const parsed = new Date(`${day}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * The stored timestamp as the day the date input shows: the *local* day, the
 * one the native editors read. `toISOString()` gave the UTC day, so a task
 * due on the 20th in Amsterdam opened as the 19th, and saving an unrelated
 * edit wrote the 19th back (#220).
 */
export function dayValue(due: string | null): string {
  if (!due) return '';
  const parsed = new Date(due);
  if (Number.isNaN(parsed.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

export async function createTask(subject: CrmSubject, draft: TaskDraft): Promise<CrmTask> {
  const body = await apiFetch<{ task: CrmTask }>('/crm/tasks', {
    method: 'POST',
    fallbackError: t('Couldn’t create that task.'),
    body: {
      ...taskWriteFields(draft),
      ...taskSubjectQuery(subject),
    },
  });
  invalidateFor('task.create');
  track('Task created');
  return body.task;
}

export async function updateTask(id: string, draft: TaskDraft): Promise<CrmTask> {
  const body = await apiFetch<{ task: CrmTask }>(`/crm/tasks/${id}`, {
    method: 'PATCH',
    fallbackError: t('Couldn’t update that task.'),
    body: taskWriteFields(draft),
  });
  invalidateFor('task.update');
  return body.task;
}

/**
 * Delete…: the task is gone for every client. The request
 * policy has no `task.delete` write; `task.update` clears the same lists.
 */
export async function deleteTask(id: string): Promise<CrmTaskDeleteResponse> {
  const body = await apiFetch<CrmTaskDeleteResponse>(`/crm/tasks/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    fallbackError: t('Couldn’t delete that task.'),
  });
  invalidateFor('task.update');
  return body;
}

/** Assign to… from a row's menu: the person, and Envisioning's side, since one of us now owes it. */
export async function assignTask(id: string, member: CrmTeamMember): Promise<CrmTask> {
  const body = await apiFetch<{ task: CrmTask }>(`/crm/tasks/${id}`, {
    method: 'PATCH',
    fallbackError: t('Couldn’t assign that task.'),
    body: { assigned_to: member.id, responsible_party: 'team' },
  });
  invalidateFor('task.update');
  return body.task;
}

/** Assign to… on an issue: that person's GitHub login becomes the whole assignee set. */
export async function assignIssue(issue: Pick<CrmIssue, 'owner' | 'repo' | 'number'>, login: string): Promise<void> {
  await apiFetch('/crm/issue', {
    method: 'PATCH',
    fallbackError: t('Couldn’t assign that issue.'),
    body: { owner: issue.owner, repo: issue.repo, number: issue.number, assignees: [login] },
  });
  invalidateFor('issue.write');
}

function taskWriteFields(draft: TaskDraft) {
  return {
    title: draft.title.trim(),
    notes: draft.notes.trim() || null,
    status: draft.status,
    responsible_party: draft.responsible_party,
    // A task the client owes cannot also be owed by one of us.
    assigned_to: draft.responsible_party === 'team' ? draft.assigned_to : null,
    due_date: wireDate(draft.due_date),
    goal_id: draft.goal_id,
  };
}

// ---------------------------------------------------------------------------
// Goals and decisions (#262). Read live: a subject's list is short
// and read on open, like issues.

export async function fetchGoals(projectId: string, includeClosed = false): Promise<CrmGoal[]> {
  const search = new URLSearchParams({ project_id: projectId, ...(includeClosed ? { include_closed: '1' } : {}) });
  const body = await apiFetch<{ goals: CrmGoal[] }>(`/crm/goals?${search}`, { fallbackError: t('Couldn’t load goals.'), noStore: true });
  return body.goals ?? [];
}

export async function createGoal(input: CrmGoalCreateInput): Promise<CrmGoal> {
  const body = await apiFetch<{ goal: CrmGoal }>('/crm/goals', { method: 'POST', fallbackError: t('Couldn’t create that goal.'), body: input });
  return body.goal;
}

export async function updateGoal(id: string, input: CrmGoalUpdateInput): Promise<CrmGoal> {
  const body = await apiFetch<{ goal: CrmGoal }>(`/crm/goals/${id}`, { method: 'PATCH', fallbackError: t('Couldn’t update that goal.'), body: input });
  return body.goal;
}

export async function fetchDecisions(subject: Pick<CrmSubject, 'kind' | 'id'>): Promise<CrmDecision[]> {
  const search = new URLSearchParams({ subject_kind: subject.kind, subject_id: subject.id });
  const body = await apiFetch<{ decisions: CrmDecision[] }>(`/crm/decisions?${search}`, { fallbackError: t('Couldn’t load decisions.'), noStore: true });
  return body.decisions ?? [];
}

export async function createDecision(input: CrmDecisionCreateInput): Promise<CrmDecision> {
  const body = await apiFetch<{ decision: CrmDecision }>('/crm/decisions', { method: 'POST', fallbackError: t('Couldn’t record that decision.'), body: input });
  return body.decision;
}

/**
 * Answer a Core-proposed task: accept → pending, decline →
 * declined, kept so the same CRM event cannot propose it again.
 */
/**
 * Move to…: the task goes onto `to` and off whatever it was on.
 * `from` is where it was, so the Worker drops that list from its cache and
 * a reload does not show the row twice.
 */
export async function moveTask(
  task: Pick<CrmTask, 'id' | 'project_id' | 'lead_id' | 'event_id' | 'meeting_id' | 'organization_id'>,
  to: { kind: 'project' | 'lead' | 'event' | 'organization' | 'meeting'; id: string },
): Promise<CrmTask> {
  const body = await apiFetch<{ task: CrmTask }>(`/crm/tasks/${task.id}`, {
    method: 'PATCH',
    fallbackError: t('Couldn’t move that task.'),
    body: {
      // A partner's key is the organization's; the others are `<kind>_id`.
      [to.kind === 'organization' ? 'organization_id' : `${to.kind}_id`]: to.id,
      // Only a partner task's own organization is where it was; on any other
      // task it is echoed context and moving it clears nothing of ours.
      moved_from: {
        project_id: task.project_id, lead_id: task.lead_id, event_id: task.event_id ?? null, meeting_id: task.meeting_id ?? null,
        ...(isPartnerTask(task) ? { organization_id: task.organization_id } : {}),
      },
    },
  });
  invalidateFor('task.update');
  return body.task;
}

export async function decideProposedTask(id: string, accepted: boolean): Promise<CrmTask> {
  const body = await apiFetch<{ task: CrmTask }>(`/crm/tasks/${id}`, {
    method: 'PATCH',
    fallbackError: accepted ? t('Couldn’t accept that task.') : t('Couldn’t decline that task.'),
    body: { status: accepted ? 'pending' : 'declined' },
  });
  invalidateFor('task.update');
  return body.task;
}

export async function completeTask(id: string): Promise<void> {
  await apiFetch(`/crm/tasks/${id}`, {
    method: 'PATCH',
    fallbackError: t('Couldn’t complete that task.'),
    body: { status: 'completed' },
  });
  invalidateFor('task.update');
}

/** A task that will not be done: status `cancelled`. The editor's status
 * field and the board can reopen it. */
export async function cancelTask(id: string): Promise<void> {
  await apiFetch(`/crm/tasks/${id}`, {
    method: 'PATCH',
    fallbackError: t('Couldn’t cancel that task.'),
    body: { status: 'cancelled' },
  });
  invalidateFor('task.update');
}

/** Close or reopen from a row menu. The reason keeps finished work and
 * decided-against work apart on GitHub. `projectId` lets that project's
 * channel hear about it, where the list is one project's. */
export type IssueStateChange = 'close' | 'close_not_planned' | 'reopen';

export async function setIssueState(
  issue: Pick<CrmIssue, 'owner' | 'repo' | 'number'>,
  change: IssueStateChange,
  projectId?: string,
): Promise<void> {
  await apiFetch('/crm/issue', {
    method: 'PATCH',
    fallbackError: t('Couldn’t update that issue.'),
    body: {
      owner: issue.owner,
      repo: issue.repo,
      number: issue.number,
      ...(projectId ? { project_id: projectId } : {}),
      state: change === 'reopen' ? 'open' : 'closed',
      ...(change === 'reopen' ? {} : { state_reason: change === 'close' ? 'completed' : 'not_planned' }),
    },
  });
  invalidateFor('issue.write');
}

/** Repositories Meet's GitHub App (or Core) can see, filtered by a search. */
export async function searchGithubRepos(query: string): Promise<CrmGithubRepo[]> {
  const search = new URLSearchParams({ q: query.trim() });
  const body = await apiFetch<CrmGithubReposResponse>(`/crm/github-repos?${search}`, {
    fallbackError: t('Couldn’t load repositories.'),
    noStore: true,
  });
  return body.repos ?? [];
}

/** Link a repository to a project: the same write the Mac and the phone make. */
export async function linkProjectRepo(projectId: string, repo: Pick<CrmGithubRepo, 'owner' | 'repo'>): Promise<CrmGithubRepo> {
  const body = await apiFetch<CrmProjectRepoResponse>('/crm/project-repos', {
    method: 'POST',
    body: { project_id: projectId, owner: repo.owner, repo: repo.repo },
    fallbackError: t('Couldn’t link that repository.'),
  });
  return body.repo;
}

/** File a new GitHub issue through the Worker's linked-repository route. */
export async function createIssue(input: CrmIssueCreateInput): Promise<CrmIssue> {
  const body = await apiFetch<CrmIssueDetailResponse>('/crm/issue', {
    method: 'POST',
    body: input,
    fallbackError: t('Couldn’t create this issue.'),
  });
  invalidateFor('issue.write');
  return body.issue;
}

/** Promote a project task to GitHub, preserving its notes as the issue body. */
export async function promoteTask(task: Pick<CrmMyTask, 'id' | 'title' | 'notes' | 'project_id' | 'github_issue_number'>): Promise<CrmIssue> {
  if (!task.project_id || task.github_issue_number !== null) {
    throw new Error(t('This task can’t be filed on GitHub.'));
  }
  return createIssue({
    project_id: task.project_id,
    task_id: task.id,
    title: task.title,
    ...(task.notes ? { body: task.notes } : {}),
  });
}

/**
 * The Sales inbox (docs/WORK.md "Channels on the work itself";
 *): CRM-originated touches with no Meet subject yet —
 * contact form, support case, pricing request, Future Readiness Assessment.
 * Read-only plus dismiss/undo; "Start a lead" reuses `createSubject` above,
 * pre-filled from `inboxDraftFromTouch`.
 */
export const SALES_INBOX_SOURCE_LABEL: Record<UntriagedTouchSource, string> = labelled(UNTRIAGED_TOUCH_SOURCE_LABELS);

export async function fetchSalesInbox(
  options: { includeDismissed?: boolean } = {},
): Promise<{ touches: UntriagedTouch[]; total: number }> {
  const search = new URLSearchParams();
  if (options.includeDismissed) search.set('include_dismissed', 'true');
  const query = search.toString();
  const body = await apiFetch<UntriagedTouchesResponse>(`/crm/sales-inbox${query ? `?${query}` : ''}`, {
    fallbackError: t('Couldn’t load the sales inbox.'),
    noStore: true,
  });
  // A touch that already produced a lead is not untriaged — the lead is in
  // Sales. Decided 2026-09-13; the feed itself still returns them.
  const touches = (body.data ?? []).filter((touch) => !touch.existing_lead_id && !touch.existing_offer_id);
  return { touches, total: touches.length };
}

/** An INBOX item with no other resolution (`booking:*`) leaves by hand, or comes back. */
export async function setInboxItemDismissed(key: string, dismissed: boolean): Promise<boolean> {
  const body = await apiFetch<InboxDismissResponse>(`/crm/inbox/${encodeURIComponent(key)}/dismiss`, {
    method: dismissed ? 'POST' : 'DELETE',
    fallbackError: dismissed ? t('Couldn’t dismiss that.') : t('Couldn’t undo that.'),
  });
  return body.dismissed;
}

/**
 * Answer a decision waiting on you: an option key, and an optional note.
 * Sending the same answer again is safe — it only retries the Core record.
 */
export async function answerDecisionAsk(id: string, answer: string, note?: string | null): Promise<DecisionAsk> {
  const body = await apiFetch<{ ask: DecisionAsk }>(`/decision-asks/${encodeURIComponent(id)}/answer`, {
    method: 'POST',
    body: { answer, ...(note?.trim() ? { note: note.trim() } : {}) },
    fallbackError: t('Couldn’t answer that decision.'),
  });
  return body.ask;
}

/** `dismissed: false` undoes a previous dismiss — same row, same id. */
export async function setSalesInboxDismissed(id: string, dismissed: boolean): Promise<boolean> {
  const body = await apiFetch<UntriagedTouchDismissResponse>(`/crm/sales-inbox/${encodeURIComponent(id)}/dismiss`, {
    method: dismissed ? 'POST' : 'DELETE',
    fallbackError: dismissed ? t('Couldn’t dismiss that.') : t('Couldn’t undo that.'),
  });
  return body.dismissed;
}

/**
 * What "Start a lead" hands the existing New Lead sheet (`SubjectEditor`).
 *
 * Core's lead-create schema (`crmLeadCreateSchema`) does carry
 * `organization_id`/`contact_id` — real uuids, already on `prefill` — and
 * those pass straight through onto the draft so `createSubject` sends them.
 * The *names* are folded into the notes text as well, purely for
 * human-readability in the sheet; that folding is not what carries the
 * relationship to Core, the ids are. `id`/`updated_at` are placeholders:
 * `SubjectEditor` reads this only to seed a *new* lead's draft, never as a
 * subject in its own right.
 */
export function inboxDraftFromTouch(touch: UntriagedTouch): CrmSubjectDetail {
  const orgLine = touch.prefill.organization_name ? t('Organization: {organization_name}', { organization_name: touch.prefill.organization_name }) : null;
  const contactLine = touch.prefill.contact_name || touch.prefill.contact_email
    ? `Contact: ${[touch.prefill.contact_name, touch.prefill.contact_email].filter(Boolean).join(' · ')}`
    : null;
  return {
    id: '',
    kind: 'lead',
    title: touch.prefill.title,
    subtitle: touch.prefill.organization_name,
    status: 'Conversations',
    updated_at: null,
    notes: [touch.prefill.notes, orgLine, contactLine].filter(Boolean).join('\n'),
    organization_id: touch.prefill.organization_id,
    contact_id: touch.prefill.contact_id,
  };
}

/** Source, org/contact, and when — the inbox row's one-line meta. */
export function inboxTouchMeta(touch: UntriagedTouch): string {
  const occurred = new Date(touch.occurred_at);
  const when = Number.isNaN(occurred.valueOf())
    ? null
    : `${occurred.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short' })} at ${formatTime(occurred)}`;
  const who = touch.organization?.name
    ? `${touch.contact.name} · ${touch.organization.name}`
    : touch.contact.name;
  return [SALES_INBOX_SOURCE_LABEL[touch.source], who, when].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// INBOX and per-user subject state

/**
 * INBOX: what needs you, merged across sources, newest first, each leaving
 * when resolved; `recent` is the Activity catch-up of what happened on the
 * subjects you follow. The same list the Mac rail and Home draw.
 */
/**
 * What needs you. Snapshotted like MINE (docs/CACHING.md): the page paints
 * the last answer first, and never says "nothing needs you" before one.
 */
export async function fetchInbox(): Promise<InboxResponse> {
  return revalidate(
    SNAPSHOT.inbox,
    (ifNoneMatch) => apiFetchConditional<InboxResponse>('/crm/inbox?questions=true&cards=true&followups=true&calendar=true', {
      fallbackError: t('Couldn’t load your inbox.'),
      noStore: true,
      ifNoneMatch,
    }),
    (body) => body,
  );
}

/** Everything in INBOX except unread talk, which every badge already counts live. */
export function inboxItemsBesideTalk(inbox: InboxResponse): InboxItem[] {
  return inbox.items.filter((item) => item.source !== 'talk' && item.source !== 'mention');
}

/**
 * Follow / star / mute and the SALES opt-in, per person. The Worker sends
 * overrides plus this person's `defaults`, so a row resolves without the
 * role table (`@starlings/contracts/subject-state`).
 */
export async function fetchSubjectState(): Promise<SubjectStateResponse> {
  return apiFetch<SubjectStateResponse>('/crm/subject-state', {
    fallbackError: t('Couldn’t read your subjects.'),
    noStore: true,
  });
}

/**
 * The things this person starred, resolved through their owning services as
 * search rows for Home's QUICK ACCESS list. The shared Worker endpoint gives
 * every client the same destinations.
 */
export async function fetchStarred(): Promise<SearchResponse> {
  return apiFetch<SearchResponse>('/crm/starred', {
    fallbackError: t('Couldn’t load favorites.'),
    noStore: true,
  });
}

export async function setSubjectState(
  subject: Pick<CrmSubject, 'kind' | 'id'>,
  update: SubjectStateUpdate,
): Promise<SubjectStateRow | null> {
  const body = await apiFetch<SubjectStateUpdateResponse>(
    `/crm/subject-state/${subject.kind}/${encodeURIComponent(subject.id)}`,
    { method: 'PUT', body: update, fallbackError: t('Couldn’t change that.') },
  );
  invalidateFor('subjectState.set');
  return body.state;
}

/** The SALES opt-in and the SUBJECTS list preferences; only the keys sent change. */
export async function setWorkPreferences(update: WorkPreferencesUpdate): Promise<SubjectStateResponse> {
  const response = await apiFetch<SubjectStateResponse>('/crm/subject-state', {
    method: 'PATCH',
    body: update,
    fallbackError: update.work_list ? t('Couldn’t change the list.') : t('Couldn’t change Sales.'),
  });
  invalidateFor('workPreferences.set');
  return response;
}

/** One run of the SUBJECTS list as `workListBlocks` cuts it. `group` is null when nothing is grouped. */
export interface WorkListBlock { group: SubjectGroup | null; subjects: CrmSubject[] }

/**
 * The SUBJECTS list, arranged — `WorkList.blocks` on the Mac and the phone.
 * `subjects` are the listed rows, mute and Sales already applied. Starred
 * first inside every block, each half in `prefs.sort`; grouped blocks come
 * in `SUBJECT_GROUPS` order and an empty group is not a block.
 */
export function workListBlocks(
  subjects: CrmSubject[],
  prefs: WorkListPreferences,
  isStarred: (subject: CrmSubject) => boolean,
): WorkListBlock[] {
  const kept = prefs.starred_only ? subjects.filter(isStarred) : subjects;
  // The shared rule (`@starlings/contracts/subject-state`, fixture
  // `work_list_order`): an event floats up as its date nears.
  const now = Date.now();
  const sortRows = (rows: CrmSubject[]) => sortByWorkList(rows, prefs.sort, now);
  const arranged = (rows: CrmSubject[]) => [...sortRows(rows.filter(isStarred)), ...sortRows(rows.filter((row) => !isStarred(row)))];
  if (prefs.group === 'none') return [{ group: null, subjects: arranged(kept) }];
  return SUBJECT_GROUPS.flatMap((group) => {
    const rows = kept.filter((subject) => subjectGroup(subject, workspaceProjectGroup()) === group);
    return rows.length === 0 ? [] : [{ group, subjects: arranged(rows) }];
  });
}

/** `SubjectState.key` on the Mac: one key per subject, never per kind alone. */
export function subjectStateKey(subject: Pick<CrmSubject, 'kind' | 'id'>): string {
  return `${subject.kind}:${subject.id}`;
}

/**
 * The person's answer for one subject. Before the Worker has answered,
 * every subject reads as listed — hiding rows on a guess would be worse
 * than a rail that fills in a moment later.
 */
export function resolveSubject(
  subject: Pick<CrmSubject, 'kind' | 'title' | 'internal'>,
  state: SubjectStateResponse | null,
  overrides: Map<string, SubjectStateOverride>,
): ResolvedSubjectState {
  if (!state) return { listed: true, starred: false, muted: false };
  const override = overrides.get(subjectStateKey(subject as Pick<CrmSubject, 'kind' | 'id'>));
  return resolveSubjectState(
    { kind: subject.kind, title: subject.title, internal: subject.internal },
    { sales_enabled: state.sales_enabled, hidden_kinds: state.hidden_kinds },
    override,
  );
}

/** The phase, spelled for a row. */
export function eventPhaseLabel(phase: EventPhase): string {
  switch (phase) {
    case 'upcoming': return t('Upcoming');
    case 'live': return t('Today');
    case 'past': return t('Past');
  }
}

/**
 * An organization's relationships (ADR 0006), as the Worker sends them, in one
 * line: "Client · Partner". Empty when none hold or an older Worker sent none.
 */
export function organizationRelationshipsLine(relationships: readonly OrganizationRelationship[] | null | undefined): string {
  return (relationships ?? []).map((relationship) => {
    switch (relationship) {
      case 'client': return t('Client');
      case 'partner': return t('Partner');
      case 'prospect': return t('Prospect');
    }
  }).join(' · ');
}

/** The kind, spelled for a row that no header names. */
export function subjectKindLabel(subject: Pick<CrmSubject, 'kind' | 'title' | 'internal'>): string {
  switch (subject.kind) {
    case 'lead': return 'Lead';
    case 'organization': return 'Partner';
    case 'event': return t('Event');
    default: return isInternalProject(subject) ? workspaceBrand().name : t('Client');
  }
}

/**
 * INBOX beside the talk, for a badge or a glance surface that is not the
 * Work page: polled on the Mac's WorkWatch cadence (five minutes) and again
 * whenever the unread threads change, since a read is the same fact. Talk
 * stays on the faster thread poll; the caller adds the two.
 */
export function useInboxBesideTalk(enabled: boolean, unreadCount: number): InboxItem[] {
  // Last known first: the badge starts from the saved INBOX, not from zero.
  const [items, setItems] = useState<InboxItem[]>(() => {
    const saved = enabled ? loadSnapshot<InboxResponse>(SNAPSHOT.inbox)?.value : undefined;
    return saved ? inboxItemsBesideTalk(saved) : [];
  });
  useEffect(() => {
    if (!enabled) { setItems([]); return; }
    let cancelled = false;
    async function read() {
      try {
        const inbox = await fetchInbox();
        if (!cancelled) setItems(inboxItemsBesideTalk(inbox));
      } catch {
        // Not signed in, or a blip: the last count stands.
      }
    }
    void read();
    const timer = window.setInterval(() => void read(), 5 * 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [enabled, unreadCount]);
  return items;
}

/**
 * Where a task lives, in one line: the kind and, when the caller has it, the
 * name ("Partner · Echos"). A meeting-only task reads "Meeting", a task on
 * nothing "No subject". `subject` is what the line links to, when it has one.
 * The name comes from context already in hand; without it the line is the kind.
 */
export function taskWhere(
  task: Parameters<typeof workSubjectOf>[0],
  name?: string | null,
): { label: string; subject: { kind: 'project' | 'lead' | 'event' | 'organization'; id: string } | null } {
  const subject = workSubjectOf(task);
  if (!subject) return { label: task.meeting_id ? t('Meeting') : t('No subject'), subject: null };
  const kind = subject.kind === 'project' ? t('Project')
    : subject.kind === 'lead' ? t('Lead')
    : subject.kind === 'event' ? t('Event')
    : t('Partner');
  const title = name?.trim();
  return { label: title ? `${kind} · ${title}` : kind, subject };
}
