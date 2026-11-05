import { SignInGate } from './SignInGate';
import { openHelp } from './help-bus';
import { WorkActivity } from './WorkActivity';
import { retainQuestionInbox } from './inbox-rows';
import { FollowUpDialog } from './FollowUpDialog';
import type { InboxFollowUpItem } from '@starlings/contracts/inbox';
import { AttentionQuestionDialog } from './AttentionQuestionDialog';
import type { AttentionRequest } from '@starlings/contracts/attention';
import { IssueDetail, IssueWorkspace, type IssueReference } from './IssueWorkspace';
import { ProjectBoard } from './ProjectBoard';
import { railListClass } from './rail-list';
import { DatePicker } from './DatePicker';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Button } from '@/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';
import { Checkbox } from '@/ui/checkbox';
import { LinkRepositoryDialog } from './LinkRepositoryDialog';
import { toast } from './Toast';
import { useOwnerSession } from './owner-session';
import { ThreadPane } from './ThreadPane';
import { SubjectDocumentsPane } from './SubjectDocumentsPane';
import { SubjectGuestThread } from './SubjectGuestThread';
import { SubjectShareDialog } from './SubjectShareDialog';
import { SubjectFieldsPane } from './SubjectFieldsPane';
import { KeepHandoffDialog } from './KeepHandoffDialog';
import { Markdown, plainText } from './markdown';
import { githubURLForRef, OPEN_TASK_STATUSES, type CrmOrganizationFacets, type CrmSubjectCountsResponse, type DocsSubject, type QuickNote, type ThreadMessage, type ThreadMessageRef } from '@starlings/contracts';
import { SubjectPicker } from './SubjectPicker';
import { SearchablePicker } from './SearchablePicker';
import type { SearchablePickerOption } from './searchable-picker';
import type { SubjectStateUpdate } from '@starlings/contracts/subject-state';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { ControlRequestError } from './config';
import { markThreadRead, setThreadMuted, useUnreadMessages, type ThreadSummary } from './messages';
import { RailEmpty, RailRow, RailRowsPlaceholder, RailSection, railBlockProps, RightSidebarSlot, SCROLLBAR_AFFORDANCE_CLASS, SurfaceShell, useRightSidebar } from './SurfaceShell';
import { SurfaceCreate } from './SurfaceCreate';
import { QuickNoteDialog } from './QuickNoteDialog';
import { DecisionDialog } from './DecisionDialog';
import { DecisionAnswerItems } from './decision-menu';
import type { DecisionAsk } from '@starlings/contracts/decision-asks';
import { GlyphMark, SubjectMark } from './SubjectMark';
import { fetchTodayMeetings, type TodayMeeting } from './work-today';
import { CalendarIcon, ChevronIcon, InteractionIcon, MoreActionsIcon, PlusIcon, TaskIcon } from './action-icons';
import { Tip } from './Tip';
import { bookingEventHref, inboxItemHref, inboxItemMeta, inboxTaskID, RSVPAnswerItems } from './inbox-rows';
import type { InboxForwardedItem, InboxInvitationItem } from '@starlings/contracts/inbox';
import { addPendingCalendarEvent, discardPendingCalendarEvent, respondToCalendarInvitation } from './owner-agenda';
import { IssueRow, issueMeta, TASK_ROW_EXIT_MS, TaskRow } from './WorkRows';
import { EventAbout, hasEventAbout } from './EventAbout';
import { CmsRecordEditor, useWritableCmsEntity } from './CmsRecordEditor';
import { EventEditor, fetchWorkEvent, fetchWorkEventOptions } from './EventEditor';
import type { WorkEvent, WorkEventOptions } from '@starlings/contracts/event-signups';
import type { CmsRecord } from '@starlings/contracts/cms';
import { IssueMenuItems, TaskMenuItems } from './task-row-menu';
import { useRowMenu } from './use-row-menu';
import { HOME_ROW_ATTRIBUTE } from './home-keys';
import { formatTime, formatDay } from './meeting-time';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { useMenuTrigger } from './menu-focus';
import { FilterButton } from './FilterButton';
import {
  RESPONSIBLE_LABEL,
  SALES_INBOX_SOURCE_LABEL,
  STATUS_LABEL,
  WORK_SECTIONS,
  cancelTask,
  completeTask,
  promoteTask,
  setIssueState,
  decideProposedTask,
  moveTask,
  createSubject,
  createCrmOrganization,
  createTask,
  dayValue,
  fetchSubjectDetail,
  searchCrmOrganizations,
  fetchTaskByID,
  taskWhere,
  fetchMyWork,
  fetchRecentlyClosedWork,
  fetchUnownedWork,
  assignIssue,
  assignTask,
  reopenRecentlyClosedWork,
  setGithubLogin,
  setInboxItemDismissed,
  answerDecisionAsk,
  setSalesInboxDismissed,
  fetchSubjects,
  DEFAULT_ORGANIZATION_FILTER,
  isDefaultOrganizationFilter,
  readOrganizationFilter,
  writeOrganizationFilter,
  type OrganizationListFilter,
  fetchTasks,
  fetchGoals,
  fetchInteractions,
  fetchSubjectEvents,
  interactionsSnapshotKey,
  createInteraction,
  updateInteraction,
  deleteInteraction,
  type InteractionDraft,
  SNAPSHOT,
  subjectsSnapshotKey,
  tasksSnapshotKey,
  type MyWork,
  type SubjectPage,
  inboxDraftFromTouch,
  inboxTouchMeta,
  isOverdue,
  planMine,
  planUnownedWork,
  subjectStanding,
  fetchTeam,
  updateTask,
  updateSubject,
  setSubjectResponsible,
  dismissFollowUp,
  winLead,
  isPartner,
  isEvent,
  eventPhaseLabel,
  fetchInbox,
  inboxCappedLine,
  inboxPartialLine,
  fetchSubjectState,
  setSubjectState,
  setWorkPreferences,
  subjectStateKey,
  resolveSubject,
  subjectKindLabel,
  organizationRelationshipsLine,
  subjectGroup,
  type InboxItem,
  type InboxResponse,
  type InboxFilterSource,
  type ResolvedSubjectState,
  type SubjectGroup,
  type SubjectStateOverride,
  type SubjectStateResponse,
  workRankRail,
  subjectDisplayTitle,
  defaultSubjectStatus,
  fetchSubjectCounts,
  deleteCrmOrganization,
  deleteTask,
  fetchOrganizationProjectTasks,
  taskPassesTaskFilter,
  DEFAULT_WORK_TASK_FILTER,
  type WorkTaskFilter,
  readSubjectSort,
  readSubjectStatus,
  sortSubjects,
  subjectStatusLabel,
  subjectStatusOptions,
  writeSubjectSort,
  writeSubjectStatus,
  type CrmIssue,
  type CrmInteraction,
  type CrmMyTask,
  type CrmRecentlyClosedItem,
  type CardTrace,
  type CrmSubject,
  type WorkStage,
  type CrmUnownedSubject,
  type CrmUnownedWorkResponse,
  type CrmSubjectDetail,
  type CrmTask,
  type CrmTeamMember,
  type PlannedRow,
  type SubjectKind,
  type SubjectSortListKey,
  type SubjectSortOption,
  type UntriagedTouch,
  type WorkSection,
  type MineFilter,
  type MineOriginFilter,
  type MineSectionFilter,
  type SubjectDraft,
  type TaskDraft,
  type HandOffCard,
  DEFAULT_INBOX_FILTER,
  DEFAULT_MINE_FILTER,
  INBOX_FILTER_SOURCES,
  inboxItemMatchesFilter,
} from './crm-work';
import { inboxSourceSpec } from '@starlings/contracts/inbox-values';
import { SUBJECT_PANE_IDS, subjectPaneOrOverview, subjectPanes, subjectPaneTitle, type SubjectPaneId } from '@starlings/contracts/subject-panes';
import { subjectOverviewGroups } from '@starlings/contracts/subject-overview-groups';
import { contactHref, documentHref, issueHref, peerHref, subjectHref, taskHref, teamThreadHref, workSubjectOf } from './work-hrefs';
import { ContactDetail, ContactEditor, SubjectContactsField } from './WorkContact';
import { ContactsBrowseGroup } from './WorkContactsGroup';
import { OrganizationEditor, OrganizationMerger } from './WorkOrganization';
import { confirmDataLoss } from './ConfirmDataLoss';
import { TaskFilterMenu } from './task-filter-menu';
import { useRailFold } from './rail-row';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import type { CrmOrganizationProjectTasksResponse } from '@starlings/contracts';
import { eventPhase, filterMinePlan, filterWorkPlan, MINE_ORIGIN_FILTERS, MINE_SECTION_FILTERS } from '@starlings/contracts/work-items';
import { LEAD_QUALIFICATION_CHECKS, LEAD_QUALIFICATION_KEYS, leadQualification, leadQualificationCount, mergeLeadQualification, type LeadQualificationKey } from '@starlings/contracts/lead-qualification';
import { TASK_SUBJECT_KINDS } from './subject-pickers';
import { readFailureLine, truncatedLine } from './read-gaps';
import { ErrorNotice } from './ErrorNotice';
import { InteractionEditor, interactionTypeName } from './WorkInteractionEditor';
import { PlanLimitNotice } from './PlanLimitNotice';
import { planErrorCodeOf, projectFrozen, refreshWorkspacePlan, useWorkspacePlan, type PlanErrorCode } from './workspace-plan';
import { PLAN_ERROR_CODES } from '@starlings/contracts/workspace-plans';
import { storeRecent } from './search-doors';
import { cn } from '@/lib/utils';
import { subjectSearchRow } from '@starlings/contracts/search-rows';
import { INVALIDATE_EVENT, loadSnapshot, updatedLabel } from './snapshot-store';
import { purgeOwnerLocalState } from './owner-local-state';
import { readStored, StorageKeys, writeStored } from './storage';
import { MenuIcon, type MenuIconName } from './menu-icons';
import { SUBJECT_KINDS } from '@starlings/contracts/subject-kinds';
import { plural, t, dateLocale } from './i18n';
import { workspaceBrand } from './workspace-brand';
import { workspaceProjectGroup } from './workspace-defaults';
import { tx } from './i18n/tx';
import { navigate, writeAddress } from './navigation';
import { workspaceCoreGroups } from './workspace-core';
import { parsePermalinkPath } from '@starlings/contracts/permalinks';
import { SubjectGoals } from './SubjectGoals';
import { SubjectDecisions } from './SubjectDecisions';
import { subjectContextBlocks, type SubjectContextBlock } from '@starlings/contracts/subject-context';
import { SUBJECT_STATUS_CHOICES, isSubjectClosed } from '@starlings/contracts/subject-status';
import { FORM_FIELDS, missingFormField } from '@starlings/contracts/form-fields';
import { BROWSE_GROUPS as BROWSE_GROUP_SPECS, BROWSE_GROUP_ORDER, browseGroupShown } from '@starlings/contracts/browse-groups';
import { WORK_MODULES, subjectKindShown } from '@starlings/contracts/work-modules';
import { SIGNALS_LEAD_SOURCE } from '@starlings/contracts/licenses';
import { OverviewContacts, OverviewDocuments, OverviewLicenses, OverviewOffers, useSubjectCommercial, OverviewSubmission, OverviewGroup, OverviewIssues, overviewHalfClass, SubjectOverviewLayout } from './SubjectOverview';
import { useMediaQuery } from './use-media-query';
import { LicensesBrowseGroup, OffersBrowseGroup } from './WorkRecordGroups';
import { ConversationTeamBlock, InspectorContext, InspectorGroup, subjectTeam } from './ConversationTeam';
import { responsibleOf } from '@starlings/contracts/responsible';
import { isAgent, peerDisplayName, subscribePeers, type PeersResponse } from './team-presence';
import { HandOffDialog } from './HandOffDialog';
import { CardActivity } from './CardActivity';
import { apiFetch } from './api';
import { isLiveGoal, type CrmGoal } from '@starlings/contracts/goals-decisions';
import { refreshFavorites } from './favorites';
import { PlaceholderBar, PlaceholderRows, PlaceholderStatus } from '@/ui/placeholder-rows';
import { StarToggle } from './FavoriteToggle';
import { CopyEmailItem, coreSubjectDoor, coreTaskDoor, MenuGroups, OpenItem, RowMenuItems } from './row-menu-items';
import { refreshPoll, THREADS_POLL_KEY } from './shared-poll';
import { deleteQuickNote } from './quick-notes';
import { updateDocsAnnotation } from './docs';
import {
  DetailHead,
  HeadRow,
  PlanHead,
  ReaderFacts,
  SheetActions,
  SheetCard,
  SheetField,
  cancelOnEscape,
  detailTitleClass,
  fieldCaption,
  fieldProps,
  paneHelpClass,
  readerLinkClass,
  stateActionsClass,
} from './work-parts';

/**
 * Work on the web — projects and, when enabled, Sales for leads, plus what is
 * owed on each. The same destination the Mac window and the iOS tab reach.
 *
 * The browser reads durable work and interaction history. Conversation stays
 * in Talk/native for now; it is transient coordination, not the project's
 * system of record.
 *
 * Member-gated at the Worker rather than merely hidden — a visitor who guesses
 * this address gets a 403 from `/api/crm/subjects`, and the page says so.
 */
type MineWorkRowProps = {
  row: PlannedRow;
  section: WorkSection;
  activeTaskID: string | null;
  completingTaskIDs: ReadonlySet<string>;
  activeIssue: IssueReference | null;
  onComplete: (task: CrmMyTask) => void;
  onOpenTask: (task: CrmMyTask) => void;
  onOpenIssue: (issue: CrmIssue) => void;
  menu: (task: CrmMyTask) => RowMenu;
  issueMenu: (issue: CrmIssue) => RowMenu;
};

/** A rail row's context menu, as `RailRow` takes it. */
type RowMenu = ComponentProps<typeof RailRow>['menu'];

/** One row of Mine. The leading mark and action differ by origin; the row
 * shape does not. The same rows draw the rail and Overview's MINE column. */
function MineWorkRow({ row, section, activeTaskID, completingTaskIDs, activeIssue, onComplete, onOpenTask, onOpenIssue, menu, issueMenu }: MineWorkRowProps) {
  const issue = row.issue;
  const task = row.myTask;
  if (issue) {
    const active = activeIssue !== null && activeIssue.owner === issue.owner && activeIssue.repo === issue.repo && activeIssue.number === issue.number;
    return <IssueRow issue={issue} metadata={issueMeta(issue)} active={active} onOpen={() => onOpenIssue(issue)} menu={issueMenu(issue)} />;
  }
  if (!task) return null;
  return (
    <TaskRow
      title={task.title}
      favoriteTargetRef={task.id}
      metadata={[
        formatDay(task.due_date) || null,
        task.subject_title,
        row.githubRef,
      ].filter(Boolean).join(' · ')}
      // The section already says the row is late; the date only agrees
      // with it, never makes a second claim.
      late={section === 'late'}
      active={activeTaskID === task.id}
      leaving={completingTaskIDs.has(task.id)}
      onComplete={() => onComplete(task)}
      onOpen={() => onOpenTask(task)}
      menu={menu(task)}
    />
  );
}

function interactionMeta(interaction: CrmInteraction): string {
  const type = interactionTypeLabel(interaction);
  const occurred = interaction.occurred_at || interaction.created_at;
  const date = occurred ? new Date(occurred) : null;
  const people = interaction.contacts
    .map((contact) => contact.name || contact.email)
    .filter(Boolean)
    .slice(0, 3)
    .join(', ');
  return [
    // A project's History carries the lead it was won from (ADR 0008).
    interaction.from_lead ? t('From the lead') : null,
    type,
    date && !Number.isNaN(date.valueOf())
      ? `${date.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short', year: 'numeric' })} at ${formatTime(date)}`
      : null,
    interaction.duration_minutes ? `${interaction.duration_minutes} min` : null,
    people || null,
    interaction.status || null,
  ].filter(Boolean).join(' · ');
}

function historyEventMeta(message: ThreadMessage): string {
  const date = new Date(message.sent_at);
  return `${date.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short', year: 'numeric' })} at ${formatTime(date)}`;
}

function interactionTypeLabel(interaction: CrmInteraction): string {
  return interactionTypeName(interaction.type);
}

function interactionPreview(interaction: CrmInteraction): string | null {
  return [interaction.summary_preview, interaction.transcript_preview]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value)) ?? null;
}

function interactionTitle(interaction: CrmInteraction): string {
  const title = plainText(interaction.title).trim();
  return title || t('Untitled interaction');
}

type InteractionFilter = CrmInteraction['type'] | 'all';

const INTERACTION_FILTERS: Array<{ value: InteractionFilter; label: string }> = [
  { value: 'all', label: t('All types') },
  { value: 'meeting', label: t('Meetings') },
  { value: 'email', label: t('Emails') },
  { value: 'call', label: t('Calls') },
  { value: 'web', label: t('Web') },
  { value: 'note', label: t('Notes') },
];

/** Rows the feed block shows before "Show all" — a glance, not a second Mine. */

/** One thing History can show, ordered by when it happened. */
type HistoryEntry =
  | { kind: 'interaction'; interaction: CrmInteraction; at: number }
  | { kind: 'event'; message: ThreadMessage; at: number };

/** A subject's History, newest first: what was filed, and what changed here in Meet. */
function historyEntries(interactions: CrmInteraction[], events: ThreadMessage[], filter: InteractionFilter): HistoryEntry[] {
  const entries: HistoryEntry[] = interactions
    .filter((interaction) => filter === 'all' || interaction.type === filter)
    .map((interaction) => ({ kind: 'interaction' as const, interaction, at: interactionTimeMs(interaction) }));
  if (filter === 'all') {
    for (const message of events) entries.push({ kind: 'event', message, at: message.sent_at });
  }
  return entries.sort((left, right) => right.at - left.at);
}

/** One History line. An event line is read, not opened: no select, no hover lift. */
function historyRow(entry: HistoryEntry, onOpen: (interaction: CrmInteraction) => void, selectRef?: (button: HTMLButtonElement | null) => void) {
  if (entry.kind === 'event') {
    return (
      <RailRow
        key={entry.message.id}
        leading={<GlyphMark shape="square"><InteractionIcon type="note" size={14} /></GlyphMark>}
        title={entry.message.text}
        subtitle={historyEventMeta(entry.message)}
      />
    );
  }
  const { interaction } = entry;
  return (
    <RailRow
      key={interaction.id}
      leading={<GlyphMark shape={interaction.type === 'note' ? 'square' : 'round'}><InteractionIcon type={interaction.type} size={14} /></GlyphMark>}
      title={interactionTitle(interaction)}
      subtitle={interactionMeta(interaction)}
      ariaLabel={t('{interaction}, {interaction2}. Open interaction.', { interaction: interactionMeta(interaction), interaction2: interactionTitle(interaction) })}
      selectRef={selectRef}
      onSelect={() => onOpen(interaction)}
    />
  );
}

function interactionTimeMs(interaction: CrmInteraction): number {
  const raw = interaction.occurred_at || interaction.created_at;
  const ms = raw ? Date.parse(raw) : Number.NaN;
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

function interactionGroupTitle(interaction: CrmInteraction): string {
  return historyGroupTitle(interactionTimeMs(interaction));
}

function historyGroupTitle(at: number): string {
  const date = Number.isFinite(at) ? new Date(at) : null;
  if (!date || Number.isNaN(date.valueOf())) return t('Undated');
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((startOfToday.valueOf() - startOfDate.valueOf()) / 86_400_000);
  if (days === 0) return t('Today');
  if (days === 1) return t('Yesterday');
  return date.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The word a subject pane goes by in the strip that returns to Overview. */
function paneTitle(pane: WorkDetailPane): string {
  return t(subjectPaneTitle(pane));
}

type WorkView = 'overview' | 'browse';
type WorkDetailPane = SubjectPaneId;

/** What the web can offer a subject's tabs: Core and Docs are always there; Talk is a tab only when narrow. */
function webPaneNeeds(subject: CrmSubject, narrow: boolean) {
  return { repo: subject.kind === 'project' && Boolean(subject.has_repo), narrow, core: true, docs: true };
}
const WORK_DETAIL_PANES = SUBJECT_PANE_IDS;

type WorkURLDestination = {
  taskID: string | null;
  /** `owner/repo#n`, as a search door or a Talk ref names it. */
  issue: IssueReference | null;
  subjectID: string | null;
  subjectKind: SubjectKind | null;
  pane: WorkDetailPane;
  /** `?new=task|issue|document`: the subject's editor opens on arrival. */
  create: 'task' | 'issue' | 'document' | null;
  /** `?edit=task` opens the named subject task directly in its editor. */
  editTask: boolean;
  /** `/work/contact/<id>`: a contact's page. */
  contactID: string | null;
};

function parseIssueRef(id: string | null): IssueReference | null {
  const match = id ? /^([^/#\s]+)\/([^/#\s]+)#(\d+)$/u.exec(id.trim()) : null;
  return match ? { owner: match[1]!, repo: match[2]!, number: Number(match[3]) } : null;
}

/**
 * Two views and the subject ( slice 6, the Mac's shape): `/work` is
 * Overview, `/work/browse` the directory. The old list segments — mine,
 * envisioning, projects, leads, partners — still resolve, to the view that
 * now holds them, so a saved link does not 404.
 */
const WORK_VIEW_PATHS: Record<WorkView, string> = {
  overview: '/work',
  browse: '/work/browse',
};

function viewFromPath(pathname: string): WorkView {
  // A record's permalink opens over Overview.
  if (parsePermalinkPath(pathname)) return 'overview';
  const segment = pathname.replace(/^\/work\/?/i, '').replace(/\/$/, '').toLowerCase();
  if (segment === '' || segment === 'mine') return 'overview';
  return 'browse';
}

/**
 * What the address asks Work to open. The record is in the path
 * (`/work/project/<id>`, `/work/task/<id>`); the query adds the
 * pane, a subject's task, and a verb.
 */
function workDestinationFromLocation(): WorkURLDestination | null {
  const params = new URLSearchParams(window.location.search);
  const record = parsePermalinkPath(window.location.pathname);
  const onSubject = record?.surface === 'work' && record.kind !== 'task' && record.kind !== 'issue' && record.kind !== 'contact' ? record : null;
  const contactID = record?.surface === 'work' && record.kind === 'contact' ? record.id : null;
  // On a subject, `task` names the task open in its Tasks pane.
  const taskID = record?.surface === 'work' && record.kind === 'task' ? record.id : onSubject ? params.get('task')?.trim() || null : null;
  const issue = parseIssueRef(record?.surface === 'work' && record.kind === 'issue' ? record.id : null);
  const subjectID = onSubject?.id ?? null;
  const rawKind = onSubject?.kind ?? null;
  const subjectKind = rawKind === 'project' || rawKind === 'lead' || rawKind === 'organization' || rawKind === 'event' ? rawKind : null;
  const rawPane = params.get('pane');
  const pane = WORK_DETAIL_PANES.includes(rawPane as WorkDetailPane)
    ? rawPane as WorkDetailPane
    : 'overview';
  const rawCreate = params.get('new');
  const create = rawCreate === 'task' || rawCreate === 'issue' || rawCreate === 'document' ? rawCreate : null;
  const editTask = params.get('edit') === 'task';
  if (!taskID && !issue && !subjectID && !contactID) return null;
  return { taskID, issue, subjectID, subjectKind, pane, create, editTask, contactID };
}

/**
 * Put what Work shows in the address: a subject, a task or an
 * issue at its permalink, else the view's own path. A new record is a new
 * history entry, so Back returns to the one before; a pane on the same
 * record is not. `push: false` rewrites the entry in place: a task's
 * permalink becomes its subject's once Work knows where it is filed, and
 * Back does not walk through the first spelling.
 */
function writeWorkDestination(
  view: WorkView,
  destination?: {
    taskID?: string | null;
    subject?: CrmSubject | null;
    pane?: WorkDetailPane;
    issue?: IssueReference | null;
    contactID?: string | null;
  },
  { push = true }: { push?: boolean } = {},
): void {
  const params = new URLSearchParams(window.location.search);
  for (const key of ['task', 'pane', 'new', 'edit']) params.delete(key);
  let path = WORK_VIEW_PATHS[view];
  if (destination?.subject) {
    path = subjectHref(destination.subject);
    if (destination.taskID) params.set('task', destination.taskID);
  } else if (destination?.taskID) {
    path = taskHref(destination.taskID);
  } else if (destination?.issue) {
    const { owner, repo, number } = destination.issue;
    path = issueHref(`${owner}/${repo}#${number}`);
  } else if (destination?.contactID) {
    path = contactHref(destination.contactID);
  }
  if (destination?.pane) params.set('pane', destination.pane);
  const query = params.toString();
  writeAddress(`${path}${query ? `?${query}` : ''}`, {
    push: push && path !== window.location.pathname,
  });
}

function subjectFromThread(thread: ThreadSummary): CrmSubject | null {
  if (!thread.parent_id || (thread.kind !== 'project' && thread.kind !== 'lead' && thread.kind !== 'organization' && thread.kind !== 'event')) return null;
  return {
    id: thread.parent_id,
    kind: thread.kind,
    title: thread.title ?? t('Subject conversation'),
    subtitle: null,
  };
}

/** The Mine menus are the contract's (`work-items.ts`), drawn in the page's language. */
const MINE_FILTER_SECTIONS = MINE_SECTION_FILTERS.map((option) => ({ ...option, title: t(option.title) }));
const MINE_FILTER_ORIGINS = MINE_ORIGIN_FILTERS.map((option) => ({ ...option, title: t(option.title) }));

function readMineFilterPreference(): MineFilter {
  const raw = readStored(StorageKeys.workMineFilter);
  if (!raw) return DEFAULT_MINE_FILTER;
  try {
    const value = JSON.parse(raw) as Partial<MineFilter>;
    const section = value.section === 'all' || WORK_SECTIONS.includes(value.section as WorkSection)
      ? value.section as MineSectionFilter
      : 'all';
    const origin = value.origin === 'all' || value.origin === 'task' || value.origin === 'issue'
      ? value.origin as MineOriginFilter
      : 'all';
    return { section, origin };
  } catch {
    return DEFAULT_MINE_FILTER;
  }
}

/** UNOWNED shows tasks until a person picks otherwise (mz, 2026-10-01). */
const UNOWNED_ORIGIN_DEFAULT: MineOriginFilter = 'task';

function readUnownedFilterPreference(): MineOriginFilter {
  const raw = readStored(StorageKeys.workUnownedFilter);
  return raw === 'all' || raw === 'task' || raw === 'issue' ? raw : UNOWNED_ORIGIN_DEFAULT;
}

function readUnownedHiddenSubjects(): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(readStored(StorageKeys.workUnownedHiddenSubjects) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []);
  } catch {
    return new Set();
  }
}

/** One subject in UNOWNED's menu: its `kind:id` key, title and row count. */
type UnownedSubjectChoice = { key: string; title: string; count: number };

/** The subject an UNOWNED row is on: a task names its own, an issue rides on `issue_subjects`. */
function unownedSubjectOf(row: PlannedRow, issueSubjects: Record<string, CrmUnownedSubject> | undefined): { key: string; title: string } | null {
  if (row.issue) {
    const subject = issueSubjects?.[row.issue.id];
    return subject ? { key: `${subject.kind}:${subject.id}`, title: subject.title } : null;
  }
  const task = row.myTask;
  const filed = task ? workSubjectOf(task) : null;
  return task && filed ? { key: `${filed.kind}:${filed.id}`, title: task.subject_title ?? t('Untitled') } : null;
}

function readInboxFilterPreference(): InboxFilterSource {
  const raw = readStored(StorageKeys.workInboxFilter);
  if (raw === DEFAULT_INBOX_FILTER || (raw !== 'note' && INBOX_FILTER_SOURCES.includes(raw as Exclude<InboxFilterSource, 'all'>))) {
    return raw as InboxFilterSource;
  }
  return DEFAULT_INBOX_FILTER;
}

/** The open subject's overflow: Mute and Edit, the controls a person reaches for less often. */
function SubjectMoreMenu({ muted, onMute, onEdit, onWin, onLinkRepository }: { muted: boolean | null; onMute: () => void; onEdit?: () => void; onWin?: () => void; onLinkRepository?: () => void }) {
  const menu = useMenuTrigger();
  if (muted === null && !onEdit && !onWin && !onLinkRepository) return null;
  return (
    <DropdownMenu>
      <Tip label={t('More')}><DropdownMenuTrigger asChild>
        <Button ref={menu.trigger} data-slot="button" type="button" variant="ghost" size="icon-sm" className="size-7" aria-label={t('More')}>
          <MoreActionsIcon />
        </Button>
      </DropdownMenuTrigger></Tip>
      <DropdownMenuContent align="end" onCloseAutoFocus={menu.onCloseAutoFocus}>
        {muted !== null && <DropdownMenuItem onSelect={onMute}><MenuIcon name={muted ? 'unmute' : 'mute'} />{muted ? t('Unmute') : t('Mute')}</DropdownMenuItem>}
        {onEdit && <DropdownMenuItem onSelect={onEdit}><MenuIcon name="edit" />{t('Edit…')}</DropdownMenuItem>}
        {onWin && <DropdownMenuItem onSelect={onWin}><MenuIcon name="winLead" />{t('Win…')}</DropdownMenuItem>}
        {onLinkRepository && <DropdownMenuItem onSelect={onLinkRepository}><MenuIcon name="copyLink" />{t('Link GitHub repository…')}</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Due value for the web's Recently finished view, which replaces the open list (web only). */
const MINE_DONE_SECTION = 'done';

/** A menu row's title with its count on the right. */
function CountedTitle({ title, count }: { title: string; count: number }) {
  return (
    <span className="flex flex-1 items-baseline justify-between gap-4">
      <span>{title}</span>
      <span className="text-muted-foreground tabular-nums">{count}</span>
    </span>
  );
}

function MineFilterMenu({
  filter, done, plan, closed, onChange, onDoneChange,
}: {
  filter: MineFilter;
  done: boolean;
  /** The unfiltered open plan, counted per row. */
  plan: { order: { id: string; origin: string }[]; sectionOf: Record<string, string> };
  closed: readonly { kind: string }[];
  onChange: (next: MineFilter) => void;
  onDoneChange: (next: boolean) => void;
}) {
  const menu = useMenuTrigger();
  const dirty = done || filter.section !== DEFAULT_MINE_FILTER.section || filter.origin !== DEFAULT_MINE_FILTER.origin;
  // Each count is what the row would show given the other menu's choice.
  const openCount = (section: string, origin: string) => plan.order.filter((item) => (
    (section === 'all' || plan.sectionOf[item.id] === section) && (origin === 'all' || item.origin === origin)
  )).length;
  const closedCount = (origin: string) => closed.filter((item) => origin === 'all' || item.kind === origin).length;
  const originCount = (origin: string) => (done ? closedCount(origin) : openCount(filter.section, origin));
  return (
    <div className="flex-none">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <FilterButton ref={menu.trigger} dirty={dirty} label={t('Filter Mine')} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={menu.onCloseAutoFocus}>
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t('Due')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={done ? MINE_DONE_SECTION : filter.section}
            onValueChange={(value) => {
              if (value === MINE_DONE_SECTION) { onDoneChange(true); return; }
              onDoneChange(false);
              onChange({ ...filter, section: value as MineFilter['section'] });
            }}
          >
            {MINE_FILTER_SECTIONS.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}><CountedTitle title={option.title} count={openCount(option.value, filter.origin)} /></DropdownMenuRadioItem>
            ))}
            <DropdownMenuRadioItem value={MINE_DONE_SECTION}><CountedTitle title={t('Recently finished')} count={closedCount(filter.origin)} /></DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t('Type')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={filter.origin} onValueChange={(value) => onChange({ ...filter, origin: value as MineFilter['origin'] })}>
            {MINE_FILTER_ORIGINS.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}><CountedTitle title={option.title} count={originCount(option.value)} /></DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {dirty && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => { onDoneChange(false); onChange(DEFAULT_MINE_FILTER); }}><MenuIcon name="reset" />{t('Reset')}</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * UNOWNED's filter: Type (tasks, GitHub issues, or both — MINE's Type group),
 * then Subjects, one checkbox per subject with unowned work of that type.
 * A choice keeps the menu open, so several subjects can be turned off in a row.
 */
function UnownedFilterMenu({ origin, typeCount, subjects, hidden, onChange, onToggleSubject, onShowAllSubjects }: {
  origin: MineOriginFilter;
  /** Rows of a type within the shown subjects. */
  typeCount: (value: MineOriginFilter) => number;
  /** Subjects with rows of the chosen type, and every hidden one, by title. */
  subjects: readonly UnownedSubjectChoice[];
  hidden: ReadonlySet<string>;
  onChange: (next: MineOriginFilter) => void;
  onToggleSubject: (key: string) => void;
  onShowAllSubjects: () => void;
}) {
  const menu = useMenuTrigger();
  return (
    <div className="flex-none">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <FilterButton ref={menu.trigger} dirty={origin !== UNOWNED_ORIGIN_DEFAULT || hidden.size > 0} label={t('Filter Unowned')} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-[70vh] overflow-y-auto" onCloseAutoFocus={menu.onCloseAutoFocus}>
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t('Type')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={origin} onValueChange={(value) => onChange(value as MineOriginFilter)}>
            {MINE_FILTER_ORIGINS.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}><CountedTitle title={option.title} count={typeCount(option.value)} /></DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {subjects.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{t('Subjects')}</DropdownMenuLabel>
              {subjects.map((subject) => (
                <DropdownMenuCheckboxItem
                  key={subject.key}
                  checked={!hidden.has(subject.key)}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={() => onToggleSubject(subject.key)}
                >
                  <CountedTitle title={subject.title} count={subject.count} />
                </DropdownMenuCheckboxItem>
              ))}
            </>
          )}
          {hidden.size > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onShowAllSubjects}><MenuIcon name="reset" />{t('Show all subjects')}</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * The Organizations group's filters: Core's list filters, Partner
 * on by default. Industry and country offer what the organizations carry.
 */
function OrganizationFilterMenu({
  filter, facets, onChange,
}: {
  filter: OrganizationListFilter;
  facets: CrmOrganizationFacets | null;
  onChange: (next: OrganizationListFilter) => void;
}) {
  const menu = useMenuTrigger();
  const dirty = !isDefaultOrganizationFilter(filter);
  const choice = (label: string, value: string | undefined, options: string[], set: (value: string | undefined) => void) => (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{value ? `${label}: ${value}` : label}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
        <DropdownMenuRadioGroup value={value ?? ''} onValueChange={(next) => set(next || undefined)}>
          <DropdownMenuRadioItem value="">{t('Any')}</DropdownMenuRadioItem>
          {options.map((option) => <DropdownMenuRadioItem key={option} value={option}>{option}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <FilterButton ref={menu.trigger} dirty={dirty} label={t('Filter Organizations')} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={menu.onCloseAutoFocus}>
        <DropdownMenuCheckboxItem checked={filter.partner} onCheckedChange={(checked) => onChange({ ...filter, partner: checked === true })} onSelect={(event) => event.preventDefault()}>{t('Partner')}</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={filter.agency} onCheckedChange={(checked) => onChange({ ...filter, agency: checked === true })} onSelect={(event) => event.preventDefault()}>{t('Agency')}</DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={filter.existing_client} onCheckedChange={(checked) => onChange({ ...filter, existing_client: checked === true })} onSelect={(event) => event.preventDefault()}>{t('Existing client')}</DropdownMenuCheckboxItem>
        {facets && (facets.industries.length > 0 || facets.countries.length > 0) && <DropdownMenuSeparator />}
        {facets && facets.industries.length > 0 && choice(t('Industry'), filter.industry, facets.industries, (industry) => onChange({ ...filter, industry }))}
        {facets && facets.countries.length > 0 && choice(t('Country'), filter.country, facets.countries, (country) => onChange({ ...filter, country }))}
        {dirty && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange(DEFAULT_ORGANIZATION_FILTER)}><MenuIcon name="reset" />{t('Reset')}</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function InboxFilterMenu({
  filter, items, onChange,
}: {
  filter: InboxFilterSource;
  items: InboxItem[];
  onChange: (next: InboxFilterSource) => void;
}) {
  const menu = useMenuTrigger();
  const present = new Set(items.map((item) => item.source === 'mention' ? 'talk' : item.source));
  const options = INBOX_FILTER_SOURCES.filter((source) => source !== 'note' && (present.has(source) || filter === source));
  const dirty = filter !== DEFAULT_INBOX_FILTER;
  return (
    <div className="flex-none">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <FilterButton ref={menu.trigger} dirty={dirty} label={t('Filter Inbox')} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onCloseAutoFocus={menu.onCloseAutoFocus}>
          <DropdownMenuRadioGroup value={filter} onValueChange={(value) => onChange(value as InboxFilterSource)}>
            <DropdownMenuRadioItem value={DEFAULT_INBOX_FILTER}>{t('All items')}</DropdownMenuRadioItem>
            {options.map((source) => (
              <DropdownMenuRadioItem key={source} value={source}>{t(inboxSourceSpec(source)?.title ?? source)}</DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {dirty && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onChange(DEFAULT_INBOX_FILTER)}><MenuIcon name="reset" />{t('Reset')}</DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

// Which groups Browse has, in order, and which carry a status filter and a sort, come from the
// one table every client reads (`@starlings/contracts/browse-groups`); the words are this page's.
const BROWSE_GROUP_TITLES: Record<SubjectGroup, string> = {
  // The workspace's own projects, under its own name.
  envisioning: workspaceProjectGroup(),
  clients: t('Clients'),
  partners: t('Organizations'),
  events: t('Events'),
  sales: t('Leads'),
};
const BROWSE_GROUPS: readonly { group: SubjectGroup; title: string; sortKey: SubjectSortListKey | null }[] = BROWSE_GROUP_ORDER.map((group) => ({
  group,
  title: BROWSE_GROUP_TITLES[group],
  sortKey: BROWSE_GROUP_SPECS[group].list,
}));

export function WorkPage() {
  const ownerSession = useOwnerSession();
  /** The signed-in member's address: Assign to ▸ lists them first, as "Me". */
  const myEmail = ownerSession.kind === 'owner' ? ownerSession.owner.email : null;
  const rightSidebar = useRightSidebar('work');
  const [selectedIssue, setSelectedIssue] = useState<IssueReference | null>(null);
  /** A contact's page in the column, and the Add contact sheet on an organization. */
  const [selectedContact, setSelectedContact] = useState<string | null>(null);
  /** Moves when a contact is added, changed, merged or deleted, so the Contacts group reads again. */
  const [contactsVersion, setContactsVersion] = useState(0);
  const [addingContact, setAddingContact] = useState<{ id: string; name: string } | null>(null);
  /** The organization whose fields are open in the editor. */
  const [editingOrganization, setEditingOrganization] = useState<CrmSubjectDetail | null>(null);
  /** The organization a duplicate is being merged into. */
  const [mergingOrganization, setMergingOrganization] = useState<CrmSubjectDetail | null>(null);
  const [detailPane, setDetailPane] = useState<WorkDetailPane>('overview');
  // Above 900px a subject's Talk is half of its Overview, not a tab of its own.
  const wideSubject = useMediaQuery('(min-width: 901px)');
  const pane: WorkDetailPane = detailPane === 'talk' && wideSubject ? 'overview' : detailPane;
  const initialDestination = useMemo(workDestinationFromLocation, []);
  /** A pane that opens on its composer once, from `?new=`; forgotten on the next subject. */
  const [createOnArrival, setCreateOnArrival] = useState<'issue' | 'document' | null>(null);
  const createOnArrivalFor = useRef<string | null>(null);
  const subjectDetailRequest = useRef(0);
  const [view, setView] = useState<WorkView>(() => viewFromPath(window.location.pathname));
  const [mine, setMine] = useState<CrmMyTask[]>([]);
  const [completingTaskIDs, setCompletingTaskIDs] = useState<Set<string>>(() => new Set());
  const completingTaskIDsRef = useRef(new Set<string>());
  const mineLoadRequestID = useRef(0);
  const taskLoadRequestID = useRef(0);
  const inboxLoadRequestID = useRef(0);
  /** MINE has an answer to show, from the snapshot or the Worker; until then its half is placeholder rows. */
  const [mineLoaded, setMineLoaded] = useState(false);
  const [myIssues, setMyIssues] = useState<CrmIssue[]>([]);
  const [recentlyClosed, setRecentlyClosed] = useState<CrmRecentlyClosedItem[]>([]);
  const [recentlyClosedError, setRecentlyClosedError] = useState('');
  const recentlyClosedRequestID = useRef(0);
  /** Overview's UNOWNED (docs/BOARD.md §Unowned): null until the first answer. */
  const [unowned, setUnowned] = useState<CrmUnownedWorkResponse | null>(null);
  const [unownedError, setUnownedError] = useState('');
  const unownedRequestID = useRef(0);
  const [githubLogin, setLogin] = useState<string | null>(null);
  // The plan is computed once per change of the lists, never per row: the
  // order is a property of the pile, not of any row in it.
  const [mineFilter, setMineFilter] = useState<MineFilter>(readMineFilterPreference);
  const [mineDone, setMineDone] = useState(false);
  const mineAllPlan = useMemo(() => planMine(mine, myIssues), [mine, myIssues]);
  const minePlan = useMemo(() => planMine(mine, myIssues, '', mineFilter), [mine, myIssues, mineFilter]);
  const unownedAllPlan = useMemo(() => planUnownedWork(unowned?.tasks ?? [], unowned?.issues ?? []), [unowned]);
  const [unownedOrigin, setUnownedOrigin] = useState<MineOriginFilter>(readUnownedFilterPreference);
  const [unownedHidden, setUnownedHidden] = useState<ReadonlySet<string>>(readUnownedHiddenSubjects);
  const unownedIssueSubjects = unowned?.issue_subjects;
  // Subjects first, then type: a hidden subject's rows never count anywhere.
  const unownedShownPlan = useMemo(() => filterWorkPlan(unownedAllPlan, (row) => {
    const subject = unownedSubjectOf(row, unownedIssueSubjects);
    return !subject || !unownedHidden.has(subject.key);
  }), [unownedAllPlan, unownedIssueSubjects, unownedHidden]);
  const unownedPlan = useMemo(() => filterMinePlan(unownedShownPlan, { section: 'all', origin: unownedOrigin }), [unownedShownPlan, unownedOrigin]);
  const unownedSubjects = useMemo((): UnownedSubjectChoice[] => {
    const choices = new Map<string, UnownedSubjectChoice>();
    for (const row of unownedAllPlan.order) {
      if (unownedOrigin !== 'all' && row.origin !== unownedOrigin) continue;
      const subject = unownedSubjectOf(row, unownedIssueSubjects);
      if (!subject) continue;
      const choice = choices.get(subject.key) ?? { ...subject, count: 0 };
      choice.count += 1;
      choices.set(subject.key, choice);
    }
    return [...choices.values()].sort((a, b) => a.title.localeCompare(b.title));
  }, [unownedAllPlan, unownedIssueSubjects, unownedOrigin]);
  const [subjectDetail, setSubjectDetail] = useState<CrmSubjectDetail | null>(null);
  const [subjectDetailError, setSubjectDetailError] = useState('');
  const [peerRoster, setPeerRoster] = useState<PeersResponse | null>(null);
  /** Hand off is offered only where the team has an agent. */
  const hasAgents = (peerRoster?.peers ?? []).some(isAgent);
  /** The message Talk lands on, from a Board card's last line; cleared with the subject. */
  const [talkFocus, setTalkFocus] = useState<string | null>(null);
  // Every kind at once: the rail is one list across all of them and Browse
  // groups them, so nothing here reads one kind at a time any more.
  const [subjectsByKind, setSubjectsByKind] = useState<Record<SubjectKind, CrmSubject[]>>({ project: [], lead: [], organization: [], event: [] });
  const [hasMoreByKind, setHasMoreByKind] = useState<Record<SubjectKind, boolean>>({ project: false, lead: false, organization: false, event: false });
  const [sortOptions, setSortOptions] = useState<Record<SubjectSortListKey, SubjectSortOption>>(() => ({
    envisioning: readSubjectSort('envisioning'),
    project: readSubjectSort('project'),
    lead: readSubjectSort('lead'),
  }));
  // Browse's status filter, per group and per device (the Mac's `work.*` filter).
  // A group on its default reads the page's own lists; another status reads the
  // Worker once and keeps the answer by kind and status.
  const [browseStatus, setBrowseStatus] = useState<Record<SubjectSortListKey, string>>(() => ({
    envisioning: readSubjectStatus('envisioning'),
    project: readSubjectStatus('project'),
    lead: readSubjectStatus('lead'),
  }));
  const [browsePages, setBrowsePages] = useState<Record<string, SubjectPage>>({});
  // The Organizations group: its filter, per device, and its own
  // search. On the default filter with no search it reads the page's own
  // organization list; otherwise the Worker once per change.
  const [organizationFilter, setOrganizationFilter] = useState<OrganizationListFilter>(readOrganizationFilter);
  const [leadSource, setLeadSource] = useState<string>(() => readStored(StorageKeys.workLeadSource));
  const [leadSourcePage, setLeadSourcePage] = useState<SubjectPage | null>(null);
  const [organizationQuery, setOrganizationQuery] = useState('');
  const [organizationPage, setOrganizationPage] = useState<SubjectPage | null>(null);
  const [organizationFacets, setOrganizationFacets] = useState<CrmOrganizationFacets | null>(null);
  const [browseCounts, setBrowseCounts] = useState<Partial<Record<'project' | 'lead', CrmSubjectCountsResponse>>>({});
  const [selected, setSelected] = useState<CrmSubject | null>(null);
  //: an event is a CMS row; whoever may write it edits it here.
  const cmsEvents = useWritableCmsEntity(selected && isEvent(selected) ? 'events' : '');
  const [cmsEventEditing, setCmsEventEditing] = useState(false);
  //: an event Work's own form edits (a D1 row), its form's options,
  // and the open editor (null event: a new one).
  const [eventOptions, setEventOptions] = useState<WorkEventOptions | null>(null);
  const [workEvent, setWorkEvent] = useState<WorkEvent | null>(null);
  const [eventEditor, setEventEditor] = useState<{ event: WorkEvent | null } | null>(null);
  // The Share dialog (docs/ACCESS.md), and a counter that reloads the guest thread after it changes access.
  const [sharing, setSharing] = useState(false);
  const [accessVersion, setAccessVersion] = useState(0);
  /** Keep vault on the web is a handoff to the native clients. */
  const [keepHandoff, setKeepHandoff] = useState<CrmSubject | null>(null);
  /** The project whose repository is being linked (Link GitHub repository…). */
  const [linkingRepo, setLinkingRepo] = useState<CrmSubject | null>(null);
  /** A subject task row's Hand off: the dialog the Board's card opens. */
  const [handingOff, setHandingOff] = useState<HandOffCard | null>(null);
  // Win on a lead (ADR 0008): its sheet reads in the column, as the subject editor does.
  const [winningLead, setWinningLead] = useState<CrmSubject | null>(null);
  const [tasks, setTasks] = useState<CrmTask[]>([]);
  // A subject's Tasks list: Due and Side, per session as the board's holder filter.
  const [taskFilter, setTaskFilter] = useState<WorkTaskFilter>(DEFAULT_WORK_TASK_FILTER);
  const shownTasks = useMemo(() => tasks.filter((task) => taskPassesTaskFilter(task, taskFilter)), [tasks, taskFilter]);
  // An organization's Tasks By project: the choice is this device's; the groups are read when shown.
  const [byProject, setByProject] = useState(() => readStored(StorageKeys.workOrganizationByProject) === '1');
  const [projectTasks, setProjectTasks] = useState<{ organizationID: string; response: CrmOrganizationProjectTasksResponse } | null>(null);
  const [projectTasksError, setProjectTasksError] = useState('');
  function changeByProject(next: boolean) {
    setByProject(next);
    writeStored(StorageKeys.workOrganizationByProject, next ? '1' : '0');
  }
  /** Drop a task from the By project groups once it leaves the list. */
  function dropProjectTask(taskID: string) {
    setProjectTasks((current) => current
      ? { ...current, response: { ...current.response, projects: current.response.projects.map((project) => ({ ...project, tasks: project.tasks.filter((row) => row.id !== taskID) })) } }
      : current);
  }
  const groupedOrganizationID = byProject && pane === 'tasks' && selected && isPartner(selected) ? selected.id : null;
  const loadProjectTasks = useCallback(async (organizationID: string) => {
    try {
      const response = await fetchOrganizationProjectTasks(organizationID);
      setProjectTasks({ organizationID, response });
      setProjectTasksError('');
    } catch (cause) {
      setProjectTasksError(cause instanceof Error ? cause.message : t('Couldn’t load tasks.'));
    }
  }, []);
  useEffect(() => {
    if (groupedOrganizationID) void loadProjectTasks(groupedOrganizationID);
  }, [groupedOrganizationID, loadProjectTasks]);
  // The forwarding address of each subject channel opened this session, for EMAIL
  // in the subject's context (the Mac's `inboundAddresses`).
  const [inboundAddresses, setInboundAddresses] = useState<Record<string, string>>({});
  const noteInboundAddress = useCallback((thread: ThreadSummary) => {
    const { parent_id: subjectID, inbound_address: address } = thread;
    if (subjectID && address) setInboundAddresses((current) => (current[subjectID] === address ? current : { ...current, [subjectID]: address }));
  }, []);
  const [interactions, setInteractions] = useState<CrmInteraction[]>([]);
  const [subjectEvents, setSubjectEvents] = useState<ThreadMessage[]>([]);
  const [interactionsLoading, setInteractionsLoading] = useState(false);
  const [interactionsError, setInteractionsError] = useState('');
  const [interactionsUpdatedAt, setInteractionsUpdatedAt] = useState<number | null>(null);
  const [interactionFilter, setInteractionFilter] = useState<InteractionFilter>('all');
  const [selectedInteraction, setSelectedInteraction] = useState<CrmInteraction | null>(null);
  /** Log, or Edit on the reader: the editor reads in the History pane. */
  const [interactionEditor, setInteractionEditor] = useState<{ interaction: CrmInteraction | null } | null>(null);
  const interactionButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [team, setTeam] = useState<CrmTeamMember[]>([]);
  // The selected project's goals, every status: the Tasks pane
  // lists them, the task sheet and the decision form pick among the live ones.
  const [goals, setGoals] = useState<CrmGoal[]>([]);
  const [goalsError, setGoalsError] = useState('');
  const loadGoals = useCallback(async (subject: CrmSubject) => {
    if (subject.kind !== 'project') { setGoals([]); return; }
    try {
      setGoals(await fetchGoals(subject.id, true));
      setGoalsError('');
    } catch (cause) {
      setGoalsError(cause instanceof Error ? cause.message : t('Couldn’t load goals.'));
    }
  }, []);
  const [teamError, setTeamError] = useState('');
  const [auth, setAuth] = useState<'loading' | 'needed' | 'denied' | 'ok'>('loading');
  const [error, setError] = useState('');
  /** The plan code of the failure `error` shows, when the plan caused it. */
  const [planFailure, setPlanFailure] = useState<{ code: PlanErrorCode; message: string } | null>(null);
  const workspacePlan = useWorkspacePlan(auth === 'ok');
  /** A failed write's line: the plan prompt when the plan refused it, else the error. */
  function failWith(cause: unknown, fallback: string) {
    const message = cause instanceof Error ? cause.message : fallback;
    const code = planErrorCodeOf(cause);
    setPlanFailure(code ? { code, message } : null);
    if (code === PLAN_ERROR_CODES.projectFrozen) void refreshWorkspacePlan();
    setError(message);
  }
  const [stale, setStale] = useState<{ message: string; updatedAt: number | null; retry: () => void } | null>(null);
  const unreadThreads = useUnreadMessages(auth === 'ok');
  const unreadSubjectIDs = useMemo(
    () => new Set(unreadThreads.map((thread) => subjectFromThread(thread)?.id).filter((id): id is string => Boolean(id))),
    [unreadThreads],
  );
  const [editing, setEditing] = useState<{ task: CrmTask | null } | null>(null);
  const [focusedMineTask, setFocusedMineTask] = useState<CrmMyTask | null>(null);
  const [focusedTaskRecord, setFocusedTaskRecord] = useState<CrmTask | null>(null);
  const [focusedTaskLoading, setFocusedTaskLoading] = useState(false);
  /** The Mine row whose full record is being fetched by id (no subject to list it from). */
  const mineOpenRequest = useRef<string | null>(null);
  const [destinationRestored, setDestinationRestored] = useState(false);
  const [subjectRefusal, setSubjectRefusal] = useState<SubjectRefusal | null>(null);
  const [subjectEditor, setSubjectEditor] = useState<{
    kind: SubjectKind;
    detail: CrmSubjectDetail | null;
    subject: CrmSubject | null;
  } | null>(null);
  // INBOX: what needs you, from the Worker, the same list the
  // Mac rail and Home draw.
  const [inbox, setInbox] = useState<InboxResponse | null>(null);
  // Overview's TODAY block: today's meetings filed to a subject.
  const [todayRows, setTodayRows] = useState<TodayMeeting[]>([]);
  const [inboxError, setInboxError] = useState('');
  // The Quick Note dialog: an INBOX note (`filing` when File… opened it),
  // or `null` note for a new one from the `+`. INBOX is the only list of
  // unfiled notes here, as on the Mac and the phone (docs/WORK.md).
  const [noteDialog, setNoteDialog] = useState<{ note: QuickNote | null; filing: boolean } | null>(null);
  /** The decision opened from INBOX: its context, links and options. */
  const [questionDialog, setQuestionDialog] = useState<AttentionRequest | null>(null);
  const [followUpDialog, setFollowUpDialog] = useState<InboxFollowUpItem | null>(null);
  const [decisionDialog, setDecisionDialog] = useState<DecisionAsk | null>(null);
  const [inboxFilter, setInboxFilter] = useState<InboxFilterSource>(readInboxFilterPreference);
  // Star / mute and the SALES opt-in, per person. Overrides are kept
  // addressable and moved in place the moment a button is pressed.
  const [subjectState, applySubjectState] = useState<SubjectStateResponse | null>(null);
  const [overrides, setOverrides] = useState<Map<string, SubjectStateOverride>>(() => new Map());
  // "Start a lead" from a touch retires that touch once the lead is saved.
  const [inboxPendingTouchId, setInboxPendingTouchId] = useState<string | null>(null);
  // The subjects opened this session, like a browser's history, and where
  // in it we stand. ⌘[ and ⌘] walk it, as on the Mac; walking never records.
  // Home's Quick Access is not this list: that one is the device's recents
  // (`storeRecent`), which `recordHop` also writes.
  const [history, setHistory] = useState<CrmSubject[]>([]);
  const [historyCursor, setHistoryCursor] = useState(-1);
  const travellingRef = useRef(false);

  // The workspace's work modules (docs/WORK_MODEL.md); an older Worker sends none, read as all on.
  const workModules = subjectState?.work_modules ?? WORK_MODULES;
  const salesModuleOn = workModules.includes('sales');
  const eventsModuleOn = workModules.includes('events');
  const offersModuleOn = workModules.includes('offers');
  const licensesModuleOn = workModules.includes('licenses');
  // A lead's or an organization's offers and licences, one read for both Overview groups.
  const commercialKind = pane === 'overview' && (offersModuleOn || licensesModuleOn) && (selected?.kind === 'lead' || selected?.kind === 'organization') ? selected.kind : null;
  const commercial = useSubjectCommercial(commercialKind, commercialKind ? selected?.id ?? null : null);
  useEffect(() => {
    if (!eventsModuleOn) { setEventOptions(null); return; }
    let live = true;
    void fetchWorkEventOptions().then((options) => { if (live) setEventOptions(options); });
    return () => { live = false; };
  }, [eventsModuleOn]);
  const selectedEventID = selected && isEvent(selected) && eventOptions?.can_create ? selected.id : null;
  useEffect(() => {
    setWorkEvent(null);
    if (!selectedEventID) return;
    let live = true;
    void fetchWorkEvent(selectedEventID).then((event) => { if (live) setWorkEvent(event); });
    return () => { live = false; };
  }, [selectedEventID]);
  const salesEnabled = salesModuleOn && (subjectState?.sales_enabled ?? false);
  // The kinds this person hides for themselves; an older Worker sends only Sales.
  const hiddenKinds = subjectState?.hidden_kinds ?? (subjectState?.sales_enabled ? [] : ['lead']);

  function changeMineFilter(next: MineFilter) {
    setMineFilter(next);
    writeStored(StorageKeys.workMineFilter, JSON.stringify(next));
  }

  function changeUnownedOrigin(next: MineOriginFilter) {
    setUnownedOrigin(next);
    writeStored(StorageKeys.workUnownedFilter, next);
  }

  function changeUnownedHidden(next: ReadonlySet<string>) {
    setUnownedHidden(next);
    writeStored(StorageKeys.workUnownedHiddenSubjects, JSON.stringify([...next]));
  }

  function toggleUnownedSubject(key: string) {
    const next = new Set(unownedHidden);
    if (!next.delete(key)) next.add(key);
    changeUnownedHidden(next);
  }

  function changeInboxFilter(next: InboxFilterSource) {
    setInboxFilter(next);
    writeStored(StorageKeys.workInboxFilter, next);
  }

  const loadRecentlyClosed = useCallback(async () => {
    const requestID = ++recentlyClosedRequestID.current;
    try {
      const result = await fetchRecentlyClosedWork();
      if (requestID !== recentlyClosedRequestID.current) return;
      setRecentlyClosed(result.items);
      setRecentlyClosedError('');
    } catch (cause) {
      if (requestID !== recentlyClosedRequestID.current) return;
      setRecentlyClosedError(cause instanceof Error ? cause.message : t('Couldn’t load recently finished work.'));
    }
  }, []);

  // Rides on every Mine refresh: whatever a write did to Mine — assigning,
  // completing, filing — it may also have done to UNOWNED.
  const loadUnowned = useCallback(async () => {
    const requestID = ++unownedRequestID.current;
    try {
      const result = await fetchUnownedWork();
      if (requestID !== unownedRequestID.current) return;
      setUnowned(result);
      setUnownedError('');
    } catch (cause) {
      if (requestID !== unownedRequestID.current) return;
      setUnownedError(cause instanceof Error ? cause.message : t('Couldn’t load unowned work.'));
    }
  }, []);

  const loadMine = useCallback(async () => {
    const requestID = ++mineLoadRequestID.current;
    const cached = loadSnapshot<MyWork>(SNAPSHOT.mine);
    if (cached) {
      setMine(cached.value.tasks);
      setMyIssues(cached.value.issues);
      setLogin(cached.value.githubLogin);
      setMineLoaded(true);
    }
    void loadRecentlyClosed();
    void loadUnowned();
    try {
      const work = await fetchMyWork();
      if (requestID !== mineLoadRequestID.current) return;
      setMine(work.tasks);
      setMyIssues(work.issues);
      setLogin(work.githubLogin);
      setMineLoaded(true);
      setAuth('ok');
      setError('');
      setStale(null);
    } catch (cause) {
      if (requestID !== mineLoadRequestID.current) return;
      if (cause instanceof ControlRequestError && (cause.status === 401 || cause.status === 403)) {
        purgeOwnerLocalState();
        recentlyClosedRequestID.current += 1;
        setRecentlyClosed([]);
        setRecentlyClosedError('');
        unownedRequestID.current += 1;
        setUnowned(null);
        setUnownedError('');
        setAuth(cause.isCapabilityDenied ? 'denied' : 'needed');
        return;
      }
      const message = cause instanceof Error ? cause.message : t('Couldn’t load your work.');
      const showing = Boolean(cached && (cached.value.tasks.length > 0 || cached.value.issues.length > 0));
      setStale({ message, updatedAt: showing ? cached?.savedAt ?? null : null, retry: () => void loadMine() });
      // Only 401 and 403 mean signed out. Any other failure (an outage, or a
      // workspace whose store cannot answer yet) still has a valid session:
      // open the page and show the banner, never the skeleton forever
      // ( audit).
      setAuth((current) => (current === 'loading' ? 'ok' : current));
      setMineLoaded(true);
    }
  }, [loadRecentlyClosed, loadUnowned]);

  const loadSubjects = useCallback(async () => {
    const kinds: SubjectKind[] = [...SUBJECT_KINDS];
    for (const kind of kinds) {
      const cached = loadSnapshot<SubjectPage>(subjectsSnapshotKey(kind, ''));
      if (cached) {
        setSubjectsByKind((current) => ({ ...current, [kind]: cached.value.subjects }));
        setHasMoreByKind((current) => ({ ...current, [kind]: cached.value.hasMore }));
      }
    }
    const results = await Promise.allSettled(kinds.map((kind) => fetchSubjects(kind, '')));
    let failure: unknown = null;
    results.forEach((result, index) => {
      const kind = kinds[index]!;
      if (result.status === 'fulfilled') {
        setSubjectsByKind((current) => ({ ...current, [kind]: result.value.subjects }));
        setHasMoreByKind((current) => ({ ...current, [kind]: result.value.hasMore }));
        if (result.value.facets) setOrganizationFacets(result.value.facets);
      } else if (kind !== 'organization' && kind !== 'event') {
        // Partners and events ride behind the other lists and never fail
        // them: a Core that does not answer for them leaves the group quiet.
        failure = result.reason;
      }
    });
    if (failure instanceof ControlRequestError && (failure.status === 401 || failure.status === 403)) {
      purgeOwnerLocalState();
      setAuth(failure.isCapabilityDenied ? 'denied' : 'needed');
      return;
    }
    if (failure) {
      const message = failure instanceof Error ? failure.message : t('Couldn’t load subjects.');
      setStale({ message, updatedAt: null, retry: () => void loadSubjects() });
      return;
    }
    setAuth('ok');
    setError('');
    setStale(null);
  }, []);

  // The badges behind each status choice, read when Browse opens.
  useEffect(() => {
    if (auth !== 'ok' || view !== 'browse') return;
    for (const kind of ['project', 'lead'] as const) {
      void fetchSubjectCounts(kind).then((counts) => setBrowseCounts((current) => ({ ...current, [kind]: counts }))).catch(() => undefined);
    }
  }, [auth, view]);

  // A group filtered off its default reads that status from the Worker.
  useEffect(() => {
    if (auth !== 'ok' || view !== 'browse') return;
    const wanted = new Set<string>();
    for (const list of ['envisioning', 'project', 'lead'] as const) {
      if (browseStatus[list] !== defaultSubjectStatus(list)) wanted.add(`${list === 'lead' ? 'lead' : 'project'}:${browseStatus[list]}`);
    }
    for (const key of wanted) {
      const [kind, status] = key.split(':') as ['project' | 'lead', string];
      void fetchSubjects(kind, '', status)
        .then((page) => setBrowsePages((current) => ({ ...current, [key]: page })))
        .catch(() => undefined);
    }
  }, [auth, view, browseStatus]);

  // The Leads group narrowed to a product reads its own page. A prospect for
  // Signals is a lead with that source (decided by MZ, 2026-11-05).
  useEffect(() => {
    if (auth !== 'ok' || view !== 'browse' || !leadSource) {
      setLeadSourcePage(null);
      return;
    }
    let live = true;
    setLeadSourcePage(null);
    void fetchSubjects('lead', '', browseStatus.lead, undefined, leadSource)
      .then((page) => { if (live) setLeadSourcePage(page); })
      .catch(() => { if (live) setLeadSourcePage({ subjects: [], hasMore: false }); });
    return () => { live = false; };
  }, [auth, view, leadSource, browseStatus.lead]);

  // The Organizations group off its default view reads its own page.
  const organizationsCustom = !isDefaultOrganizationFilter(organizationFilter) || organizationQuery.trim() !== '';
  useEffect(() => {
    if (auth !== 'ok' || view !== 'browse' || !organizationsCustom) {
      setOrganizationPage(null);
      return;
    }
    let live = true;
    setOrganizationPage(null);
    // A search waits for a pause in typing; a filter reads at once.
    const timer = window.setTimeout(() => {
      void fetchSubjects('organization', organizationQuery, undefined, organizationFilter)
        .then((page) => {
          if (!live) return;
          setOrganizationPage(page);
          if (page.facets) setOrganizationFacets(page.facets);
        })
        .catch(() => { if (live) setOrganizationPage({ subjects: [], hasMore: false }); });
    }, organizationQuery.trim() ? 250 : 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [auth, view, organizationsCustom, organizationFilter, organizationQuery]);

  const changeOrganizationFilter = useCallback((next: OrganizationListFilter) => {
    setOrganizationFilter(next);
    writeOrganizationFilter(next);
  }, []);

  const loadInbox = useCallback(async () => {
    const requestID = ++inboxLoadRequestID.current;
    // The last answer first (docs/CACHING.md), so INBOX is right in the
    // first frame and never says "nothing" before it has read.
    setInbox((current) => current ?? loadSnapshot<InboxResponse>(SNAPSHOT.inbox)?.value ?? null);
    try {
      const response = await fetchInbox();
      if (requestID !== inboxLoadRequestID.current) return;
      setInbox((current) => retainQuestionInbox(current?.items ?? [], response));
      setInboxError('');
    } catch (cause) {
      if (requestID !== inboxLoadRequestID.current) return;
      if (cause instanceof ControlRequestError && (cause.status === 401 || cause.status === 403)) {
        setAuth(cause.isCapabilityDenied ? 'denied' : 'needed');
        return;
      }
      setInboxError(cause instanceof Error ? cause.message : t('Couldn’t load your inbox.'));
    }
  }, []);

  useEffect(() => {
    const onSnapshotsInvalidated = (event: Event) => {
      const prefixes = (event as CustomEvent<string[]>).detail;
      if (prefixes?.some((prefix) => prefix === SNAPSHOT.inbox || SNAPSHOT.inbox.startsWith(`${prefix}/`))) {
        void loadInbox();
      }
    };
    window.addEventListener(INVALIDATE_EVENT, onSnapshotsInvalidated);
    return () => window.removeEventListener(INVALIDATE_EVENT, onSnapshotsInvalidated);
  }, [loadInbox]);

  // `/work?decision=<id>` — Home's row, or a link — opens that decision once
  // INBOX has it, then leaves the address alone.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get('decision');
    if (!wanted || !inbox) return;
    const item = inbox.items.find((row) => row.source === 'decision' && row.ask.id === wanted);
    params.delete('decision');
    const query = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    if (item?.source === 'decision') setDecisionDialog(item.ask);
  }, [inbox]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get('question');
    if (!wanted || !inbox) return;
    const item = inbox.items.find((row) => row.source === 'question' && row.request.id === wanted);
    params.delete('question');
    const query = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    if (item?.source === 'question') setQuestionDialog(item.request);
  }, [inbox]);

  // Home's INBOX card opens a follow-up here.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get('followup');
    if (!wanted || !inbox) return;
    const item = inbox.items.find((row) => row.source === 'followup' && row.meeting.id === wanted);
    params.delete('followup');
    const query = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    if (item?.source === 'followup') setFollowUpDialog(item);
  }, [inbox]);

  const loadSubjectState = useCallback(async () => {
    try {
      const state = await fetchSubjectState();
      applySubjectState(state);
      setOverrides(new Map(state.states.map((row) => [`${row.kind}:${row.id}`, { starred: row.starred, muted: row.muted }])));
    } catch {
      // The rail drawn without it hides nothing; it fills in on the next read.
    }
  }, []);

  useEffect(() => {
    void loadMine();
  }, [loadMine]);

  useEffect(() => {
    if (auth !== 'ok') return;
    void loadInbox();
    void loadSubjectState();
  }, [auth, loadInbox, loadSubjectState]);

  // Today's meetings about a subject. A failed read keeps the last rows:
  // the block is a convenience, never an error.
  useEffect(() => {
    if (auth !== 'ok') return;
    let cancelled = false;
    fetchTodayMeetings()
      .then((rows) => { if (!cancelled) setTodayRows(rows); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [auth, unreadThreads]);

  // Something was read or arrived: INBOX's talk rows are the same fact.
  useEffect(() => {
    if (auth !== 'ok') return;
    void loadInbox();
  }, [auth, unreadThreads, loadInbox]);

  // A beat of quiet before asking, so typing a name is one request rather
  // than one per letter.
  useEffect(() => {
    if (auth !== 'ok') return;
    const timer = window.setTimeout(() => void loadSubjects(), 250);
    return () => window.clearTimeout(timer);
  }, [auth, loadSubjects]);

  const loadTasks = useCallback(async (subject: CrmSubject): Promise<CrmTask[]> => {
    const requestID = ++taskLoadRequestID.current;
    const cached = loadSnapshot<CrmTask[]>(tasksSnapshotKey(subject));
    if (cached) {
      setTasks(cached.value);
    }
    try {
      const rows = await fetchTasks(subject);
      if (requestID !== taskLoadRequestID.current) return [];
      setTasks(rows);
      setError('');
      setStale(null);
      return rows;
    } catch (cause) {
      if (requestID !== taskLoadRequestID.current) return [];
      const message = cause instanceof Error ? cause.message : t('Couldn’t load tasks.');
      const showing = Boolean(cached && cached.value.length > 0);
      if (!showing) setTasks([]);
      setStale({ message, updatedAt: showing ? cached?.savedAt ?? null : null, retry: () => void loadTasks(subject) });
      return cached?.value ?? [];
    }
  }, []);

  const loadInteractions = useCallback(async (subject: CrmSubject) => {
    const cached = loadSnapshot<CrmInteraction[]>(interactionsSnapshotKey(subject));
    if (cached) {
      setInteractions(cached.value);
      setInteractionsUpdatedAt(cached.savedAt);
    }
    setInteractionsLoading(true);
    try {
      setInteractions(await fetchInteractions(subject));
      setInteractionsUpdatedAt(Date.now());
      setInteractionsError('');
    } catch (cause) {
      if (!cached || cached.value.length === 0) setInteractions([]);
      setInteractionsError(cause instanceof Error ? cause.message : t('Couldn’t load interactions.'));
    } finally {
      setInteractionsLoading(false);
    }
    setSubjectEvents(isPartner(subject) ? [] : await fetchSubjectEvents(subject));
  }, []);

  useEffect(() => {
    if (auth !== 'ok' || team.length > 0) return;
    void fetchTeam()
      .then((members) => { setTeam(members); setTeamError(''); })
      .catch((cause: unknown) => {
        setTeamError(cause instanceof Error ? cause.message : t('Couldn’t load the team.'));
      });
  }, [auth, team.length]);

  // Context groups use the same app-wide peer poll as Team and Home. This is
  // only a second subscriber to the shared poll, never a second timer.
  useEffect(() => {
    if (auth !== 'ok') return;
    return subscribePeers({ onValue: setPeerRoster });
  }, [auth]);

  const mentionable = useMemo(
    () => team.filter((member): member is CrmTeamMember & { email: string } => member.email !== null)
      .map((member) => ({ email: member.email })),
    [team],
  );

  // Every subject in hand, and the person's answer for each.
  const allSubjects = useMemo(
    () => [...subjectsByKind.project, ...subjectsByKind.lead, ...subjectsByKind.organization, ...subjectsByKind.event],
    [subjectsByKind],
  );
  const states = useMemo(() => {
    const map = new Map<string, ResolvedSubjectState>();
    for (const subject of allSubjects) map.set(subject.id, resolveSubject(subject, subjectState, overrides));
    return map;
  }, [allSubjects, subjectState, overrides]);

  // SUBJECTS on the rail: a small automatic wall. Browse remains the full
  // directory; this rail is deliberately ranked from live signals and capped
  // so a large subject set never becomes a 70-row upfront list. The open
  // subject holds the place it was drawn at: opening it reads it, and a row
  // never moves because it was clicked.
  const railOrder = useRef<string[]>([]);
  const railSubjects = useMemo(() => {
    const listed = allSubjects.filter((subject) => {
      const state = states.get(subject.id);
      return !state || state.listed;
    });
    return workRankRail(
      listed,
      (subject) => ({
        starred: states.get(subject.id)?.starred === true,
        unread: unreadSubjectIDs.has(subject.id),
      }),
      undefined,
      undefined,
      { id: selected?.id, previous: railOrder.current },
    ).map(({ item }) => item);
  }, [allSubjects, states, unreadSubjectIDs, selected?.id]);
  useEffect(() => {
    railOrder.current = railSubjects.map((subject) => subject.id);
  }, [railSubjects]);

  const liveInboxItems = useMemo(() => {
    if (!inbox) return [];
    // A talk row the thread poll has already seen read is dropped rather
    // than shown stale.
    return inbox.items.filter((item) => !((item.source === 'talk' || item.source === 'mention') && !unreadThreads.some((thread) => thread.id === item.thread.id)));
  }, [inbox, unreadThreads]);
  const inboxAllItems = useMemo(
    () => liveInboxItems.filter((item) => item.source !== 'note'),
    [liveInboxItems],
  );
  const quickNoteItems = useMemo(
    () => liveInboxItems.filter((item) => item.source === 'note' && item.note.state === 'open'),
    [liveInboxItems],
  );
  const inboxItems = useMemo(
    () => inboxAllItems.filter((item) => inboxItemMatchesFilter(item, inboxFilter)),
    [inboxAllItems, inboxFilter],
  );

  const overviewHistory = useMemo(() => historyEntries(interactions, subjectEvents, 'all'), [interactions, subjectEvents]);
  const interactionGroups = useMemo(() => {
    const entries = historyEntries(interactions, subjectEvents, interactionFilter);
    const groups: Array<{ title: string; rows: HistoryEntry[] }> = [];
    for (const entry of entries) {
      const title = historyGroupTitle(entry.at);
      const last = groups[groups.length - 1];
      if (last?.title === title) last.rows.push(entry);
      else groups.push({ title, rows: [entry] });
    }
    return groups;
  }, [interactions, subjectEvents, interactionFilter]);

  function clearReaders() {
    setFocusedMineTask(null);
    setFocusedTaskRecord(null);
    setFocusedTaskLoading(false);
    setTasks([]);
    setInteractions([]);
    setInteractionsError('');
    setSubjectEvents([]);
    setSelectedInteraction(null);
    setInteractionEditor(null);
    setSelectedContact(null);
    setAddingContact(null);
    setEditingOrganization(null);
    setMergingOrganization(null);
  }

  function showOverview() {
    setView('overview');
    setSelected(null);
    clearReaders();
    writeWorkDestination('overview');
  }

  function showBrowse() {
    setView('browse');
    setSelected(null);
    clearReaders();
    writeWorkDestination('browse');
  }

  /// A subject opened by a click, a row, a link — not by walking history.
  /// Anything ahead of the cursor is dropped, as a browser does.
  function recordHop(subject: CrmSubject) {
    if (travellingRef.current) return;
    storeRecent(subjectSearchRow(subject));
    if (history[historyCursor]?.id === subject.id) return;
    const kept = history.slice(0, historyCursor + 1);
    setHistory([...kept, subject]);
    setHistoryCursor(kept.length);
  }

  const canGoBack = historyCursor > 0;
  const canGoForward = historyCursor >= 0 && historyCursor < history.length - 1;

  function travel(to: number) {
    const subject = history[to];
    if (!subject) return;
    setHistoryCursor(to);
    travellingRef.current = true;
    void onSelect(subject, 'talk').finally(() => { travellingRef.current = false; });
  }

  // Escape, anywhere on the page: back to Overview, as on the Mac. ⌘[ and
  // ⌘] walk the subjects opened this session; the browser keeps them when
  // there is nowhere in Work to go.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (event.metaKey && !event.shiftKey && !event.altKey && (event.key === '[' || event.key === ']')) {
        if (typing) return;
        const back = event.key === '[';
        if (back ? !canGoBack : !canGoForward) return;
        event.preventDefault();
        travel(back ? historyCursor - 1 : historyCursor + 1);
        return;
      }
      if (event.key !== 'Escape') return;
      if (typing) return;
      if (editing || subjectEditor || interactionEditor) return;
      if (selectedIssue) { closeIssue(); return; }
      if (selected || view === 'browse' || focusedMineTask) showOverview();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /**
   * The id asked for was merged into another record: open the
   * survivor in its place, so the page, the address and every later read
   * hold the survivor's id. True when it did.
   */
  function adoptSurvivor(detail: CrmSubjectDetail, pane: WorkDetailPane): boolean {
    if (!detail.merged_from || detail.merged_from === detail.id) return false;
    void onSelect({ id: detail.id, kind: detail.kind, title: detail.title, subtitle: detail.subtitle ?? null }, pane);
    return true;
  }

  async function onSelect(
    subject: CrmSubject,
    pane: WorkDetailPane = 'overview',
    taskToFocus: CrmMyTask | null = null,
  ): Promise<CrmTask[]> {
    const detailRequest = ++subjectDetailRequest.current;
    // A pane the subject has no tab for lands on Overview (`subject-panes`).
    // Talk stays: on a wide screen `pane` below folds it into Overview.
    pane = subjectPaneOrOverview(pane, subject.kind, webPaneNeeds(subject, true));
    writeWorkDestination(view, taskToFocus ? { taskID: taskToFocus.id } : { subject, pane });
    setSelectedContact(null);
    setAddingContact(null);
    setSelected(subject);
    setTalkFocus(null);
    recordHop(subject);
    setDetailPane(pane);
    setSubjectDetail(null);
    setSubjectDetailError('');
    if (isPartner(subject)) {
      // Its page reads beside its tasks; both load, and a task asked for
      // by id is read out of the partner's own list.
      void fetchSubjectDetail(subject)
        .then((detail) => { if (detailRequest === subjectDetailRequest.current && !adoptSurvivor(detail, pane)) setSubjectDetail(detail); })
        .catch((cause: unknown) => {
          if (detailRequest === subjectDetailRequest.current) {
            setSubjectDetailError(cause instanceof Error ? cause.message : t('Couldn’t load that organization.'));
          }
        });
      setFocusedMineTask(taskToFocus);
      setFocusedTaskRecord(null);
      setFocusedTaskLoading(Boolean(taskToFocus));
      setTasks([]);
      setInteractions([]);
      setInteractionsError('');
      setSubjectEvents([]);
      setSelectedInteraction(null);
      setInteractionEditor(null);
      const [subjectTasks] = await Promise.all([loadTasks(subject), loadInteractions(subject)]);
      if (taskToFocus) {
        setFocusedTaskRecord(subjectTasks.find((task) => task.id === taskToFocus.id) ?? null);
        setFocusedTaskLoading(false);
      }
      return subjectTasks;
    }
    if (isEvent(subject)) {
      // The page reads the CMS row; tasks read beside it, and there is no
      // history to ask for.
      void fetchSubjectDetail(subject)
        .then((detail) => { if (detailRequest === subjectDetailRequest.current) setSubjectDetail(detail); })
        .catch((cause: unknown) => {
          if (detailRequest === subjectDetailRequest.current) {
            setSubjectDetailError(cause instanceof Error ? cause.message : t('Couldn’t load that event.'));
          }
        });
      setFocusedMineTask(taskToFocus);
      setFocusedTaskRecord(null);
      setFocusedTaskLoading(Boolean(taskToFocus));
      setTasks([]);
      setInteractions([]);
      setInteractionsError('');
      setSubjectEvents([]);
      setSelectedInteraction(null);
      setInteractionEditor(null);
      const subjectTasks = await loadTasks(subject);
      if (taskToFocus) {
        setFocusedTaskRecord(subjectTasks.find((task) => task.id === taskToFocus.id) ?? null);
        setFocusedTaskLoading(false);
      }
      return subjectTasks;
    }
    void fetchSubjectDetail(subject)
      .then((detail) => { if (detailRequest === subjectDetailRequest.current && !adoptSurvivor(detail, pane)) setSubjectDetail(detail); })
      .catch((cause: unknown) => {
        if (detailRequest === subjectDetailRequest.current) {
          setSubjectDetailError(cause instanceof Error ? cause.message : t('Couldn’t load that subject.'));
        }
      });
    setFocusedMineTask(taskToFocus);
    setFocusedTaskRecord(null);
    setFocusedTaskLoading(Boolean(taskToFocus));
    setTasks([]);
    setInteractions([]);
    setInteractionsError('');
    setSubjectEvents([]);
    setSelectedInteraction(null);
    setInteractionEditor(null);
    setGoals([]);
    const [subjectTasks] = await Promise.all([loadTasks(subject), loadInteractions(subject), loadGoals(subject)]);
    if (taskToFocus) {
      setFocusedTaskRecord(subjectTasks.find((task) => task.id === taskToFocus.id) ?? null);
      setFocusedTaskLoading(false);
    }
    return subjectTasks;
  }

  useEffect(() => {
    if (auth !== 'ok' || destinationRestored || !initialDestination) return;
    setDestinationRestored(true);

    if (initialDestination.taskID && !initialDestination.subjectID) {
      const task = mine.find((row) => row.id === initialDestination.taskID);
      if (task) {
        openMineTask(task);
      } else {
        void (async () => {
          try {
            const record = await fetchTaskByID(initialDestination.taskID!);
            const filed = workSubjectOf(record);
            if (!filed) throw new Error(t('That task has no Work subject.'));
            const subject = await fetchSubjectDetail({ id: filed.id, kind: filed.kind, title: t('Loading subject…'), subtitle: null });
            const rows = await onSelect(subject, 'tasks');
            const opened = rows.find((row) => row.id === record.id);
            if (!opened) throw new Error(t('That task is no longer on this subject.'));
            setFocusedTaskRecord(opened);
            if (initialDestination.editTask) setEditing({ task: opened });
            writeWorkDestination(view, { subject, pane: 'tasks', taskID: opened.id }, { push: false });
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : t('Couldn’t open that task.'));
          }
        })();
      }
      return;
    }

    // A contact's page reads in the column, with no subject behind it.
    if (initialDestination.contactID) {
      setSelectedContact(initialDestination.contactID);
      return;
    }

    // A search hit or a pasted link names the issue; it reads in the
    // column the way a Mine row opens it, with no subject required
    //. The address stays on the issue while it is open.
    if (initialDestination.issue && !initialDestination.subjectID) {
      openMineIssue(initialDestination.issue);
      return;
    }

    if (!initialDestination.subjectID || !initialDestination.subjectKind) {
      setError(t('That Work link is incomplete.'));
      return;
    }

    const reference: CrmSubject = {
      id: initialDestination.subjectID,
      kind: initialDestination.subjectKind,
      title: t('Loading subject…'),
      subtitle: null,
    };
    void (async () => {
      try {
        const subject = await fetchSubjectDetail(reference);
        const subjectTasks = await onSelect(subject, initialDestination.pane);
        // The editor a palette verb asked for: the task editor
        // here, the issue composer and the document prompt through their panes.
        if (initialDestination.create === 'task') setEditing({ task: null });
        if (initialDestination.create === 'issue' || initialDestination.create === 'document') {
          createOnArrivalFor.current = subject.id;
          setCreateOnArrival(initialDestination.create);
        }
        if (initialDestination.taskID) {
          const task = subjectTasks.find((row) => row.id === initialDestination.taskID);
          if (task) {
            setFocusedTaskRecord(task);
            if (initialDestination.editTask) setEditing({ task });
            writeWorkDestination(view, { subject, pane: initialDestination.pane, taskID: task.id });
          }
          else setError(t('That task is no longer open on this subject.'));
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t('Couldn’t open that Work link.'));
      }
    })();
  }, [auth, destinationRestored, initialDestination, mine]);

  /** Move to…: the task leaves this list for the picked subject; both lists reload. */
  async function onMoveTask(task: Pick<CrmTask, 'id' | 'project_id' | 'lead_id' | 'event_id' | 'meeting_id' | 'organization_id'>, to: DocsSubject) {
    const kind = TASK_SUBJECT_KINDS.find((candidate) => candidate === to.kind);
    if (!kind) return;
    try {
      await moveTask(task, { kind, id: to.subject_id });
      setTasks((current) => current.filter((row) => row.id !== task.id));
      setFocusedTaskRecord(null);
      setFocusedMineTask(null);
      void loadMine();
      void loadInbox();
    } catch (cause) {
      failWith(cause, t('Couldn’t move that task.'));
    }
  }

  async function onDecideProposal(task: CrmTask, accepted: boolean) {
    try {
      const updated = await decideProposedTask(task.id, accepted);
      setTasks((current) => accepted
        ? current.map((row) => (row.id === task.id ? updated : row))
        : current.filter((row) => row.id !== task.id));
      if (focusedTaskRecord?.id === task.id) {
        if (accepted) {
          setFocusedTaskRecord(updated);
        } else {
          setFocusedTaskRecord(null);
          if (selected) writeWorkDestination(view, { subject: selected, pane: 'tasks' });
        }
      }
      void loadMine();
      void loadInbox();
    } catch (cause) {
      failWith(cause, t('Couldn’t update that task.'));
    }
  }

  /** A completed row exits immediately; list reads resume after the write. */
  async function completeTaskAction(taskID: string, cancel = false): Promise<boolean> {
    if (completingTaskIDsRef.current.has(taskID)) return false;
    completingTaskIDsRef.current.add(taskID);
    setCompletingTaskIDs(new Set(completingTaskIDsRef.current));
    // Any request already on the way belongs to the list before this write.
    mineLoadRequestID.current += 1;
    taskLoadRequestID.current += 1;
    inboxLoadRequestID.current += 1;

    try {
      await Promise.all([
        (cancel ? cancelTask : completeTask)(taskID),
        new Promise<void>((resolve) => window.setTimeout(resolve, TASK_ROW_EXIT_MS)),
      ]);
      setTasks((current) => current.filter((row) => row.id !== taskID));
      dropProjectTask(taskID);
      setMine((current) => current.filter((row) => row.id !== taskID));
      setUnowned((current) => current ? { ...current, tasks: current.tasks.filter((row) => row.id !== taskID) } : current);
      setInbox((current) => current
        ? { ...current, items: current.items.filter((item) => inboxTaskID(item) !== taskID) }
        : current);
      setError('');
      return true;
    } catch (cause) {
      failWith(cause, cancel ? t('Couldn’t cancel that task.') : t('Couldn’t complete that task.'));
      return false;
    } finally {
      completingTaskIDsRef.current.delete(taskID);
      setCompletingTaskIDs(new Set(completingTaskIDsRef.current));
      mineLoadRequestID.current += 1;
      taskLoadRequestID.current += 1;
      inboxLoadRequestID.current += 1;
      void loadMine();
      void loadInbox();
      if (selected) void loadTasks(selected);
    }
  }

  /** Delete…: asks first, then the row leaves every list and its reader closes. */
  async function onDeleteTask(task: { id: string; title: string }) {
    if (!await confirmDataLoss({
      title: t('Delete “{title}”?', { title: task.title }),
      body: t('This can’t be undone.'),
      action: t('Delete'),
    })) return;
    try {
      await deleteTask(task.id);
    } catch (cause) {
      failWith(cause, t('Couldn’t delete that task.'));
      return;
    }
    setTasks((current) => current.filter((row) => row.id !== task.id));
    dropProjectTask(task.id);
    setMine((current) => current.filter((row) => row.id !== task.id));
    setUnowned((current) => current ? { ...current, tasks: current.tasks.filter((row) => row.id !== task.id) } : current);
    setInbox((current) => current
      ? { ...current, items: current.items.filter((item) => inboxTaskID(item) !== task.id) }
      : current);
    setError('');
    if (focusedMineTask?.id === task.id) {
      setFocusedMineTask(null);
      setFocusedTaskRecord(null);
      setSelected(null);
      writeWorkDestination(view);
    } else if (focusedTaskRecord?.id === task.id) {
      setFocusedTaskRecord(null);
      if (selected) writeWorkDestination(view, { subject: selected, pane: 'tasks' });
    }
  }

  /** History after a write: the list as the Worker has it now. A failed read keeps what is drawn; the pane's Retry is there. */
  async function refreshInteractions(subject: CrmSubject) {
    try {
      const rows = await fetchInteractions(subject);
      setInteractions(rows);
      setInteractionsUpdatedAt(Date.now());
      setInteractionsError('');
    } catch {
      // The write landed; only the re-read failed.
    }
  }

  /** Save on the History editor: a new row, or the edit of the one in the reader. Throws so the sheet can show the refusal. */
  async function onSaveInteraction(draft: InteractionDraft) {
    if (!selected) return;
    const subject = selected;
    const original = interactionEditor?.interaction ?? null;
    const saved = original ? await updateInteraction(original, draft) : await createInteraction(draft);
    setInteractionEditor(null);
    if (original) setSelectedInteraction(saved);
    void refreshInteractions(subject);
  }

  /** Delete… on the reader: asks first; the row leaves History and the reader closes. */
  async function onDeleteInteraction(interaction: CrmInteraction) {
    if (!await confirmDataLoss({
      title: t('Delete “{title}”?', { title: interactionTitle(interaction) }),
      body: t('This can’t be undone.'),
      action: t('Delete'),
    })) return;
    try {
      await deleteInteraction(interaction);
    } catch (cause) {
      failWith(cause, t('Couldn’t delete that interaction.'));
      return;
    }
    setError('');
    setInteractions((current) => current.filter((row) => row.id !== interaction.id));
    setSelectedInteraction(null);
    if (selected) void refreshInteractions(selected);
  }

  /** Done, or cancelled from a row menu: either way the row leaves. */
  async function onComplete(task: CrmTask, cancel = false): Promise<boolean> {
    return completeTaskAction(task.id, cancel);
  }

  async function onCompleteSelectedTask(task: CrmTask) {
    const completion = onComplete(task);
    setFocusedTaskRecord(null);
    if (selected) writeWorkDestination(view, { subject: selected, pane: 'tasks' });
    await completion;
  }

  async function onCompleteMine(task: CrmMyTask, cancel = false) {
    const completion = completeTaskAction(task.id, cancel);
    if (focusedMineTask?.id === task.id) {
      setFocusedMineTask(null);
      setFocusedTaskRecord(null);
      setSelected(null);
      writeWorkDestination(view);
    }
    await completion;
  }

  /** A row's menu: the `…`, right-click, Shift+F10 or the
   * ContextMenu key (`useRowMenu`). Each row kind brings its items in the
   * Mac's groups and order; a choice closes the menu first. */
  const rowMenu = useRowMenu({ target: `[${HOME_ROW_ATTRIBUTE}]` });
  function railRowMenu(key: string, items: (act: (run: () => unknown) => () => void) => ReactNode): RowMenu {
    const act = (run: () => unknown) => () => { rowMenu.close(); void run(); };
    return { rowProps: rowMenu.rowProps(key), targetProps: { [HOME_ROW_ATTRIBUTE]: '' }, panel: rowMenu.panel(key, items(act), { className: 'mr-1.5' }) };
  }

  /** `scope` keeps the Inbox column's row and the Mine column's row of the
   * same task apart: an overdue task is in both, and only the one clicked opens. */
  function mineTaskMenu(scope: string, task: CrmMyTask, context: 'mine' | 'assigned' | 'unowned' = 'mine', seenKey?: string): RowMenu {
    return railRowMenu(`${scope}:${context}:${task.id}`, (act) => (
      <TaskMenuItems
        context={context}
        assign={context === 'unowned' ? {
          team,
          me: myEmail,
          onAssign: (member) => act(() => onAssign(() => assignTask(task.id, member), member, { taskID: task.id }))(),
        } : undefined}
        subjectTitle={task.subject_title ?? null}
        door={{ onClick: act(() => openMineTask(task)) }}
        coreDoor={coreTaskDoor(task)}
        favoriteRef={task.id}
        onFileGitHub={task.project_id && task.github_issue_number === null ? act(async () => {
          try {
            await promoteTask(task);
            setError('');
            void loadMine();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : t('Couldn’t file that task on GitHub.'));
          }
        }) : undefined}
        onDone={act(() => onCompleteMine(task).then(() => loadInbox()))}
        onCancel={act(() => onCompleteMine(task, true).then(() => loadInbox()))}
        onSeen={seenKey ? act(() => onDismissInboxItem(seenKey)) : undefined}
        onHandOff={hasAgents ? act(() => setHandingOff({ id: task.id, task, subject: workSubjectOf(task) })) : undefined}
        onDelete={act(() => onDeleteTask(task))}
      />
    ));
  }

  /** Close or reopen an issue from Mine or INBOX. Neither list is one
   * project's, so no channel line is asked for. An assigned INBOX row adds
   * Seen and the issue's door (`WorkInboxItem.rowActions`). */
  function issueRowMenu(scope: string, issue: CrmIssue, seenKey?: string, unownedRow = false): RowMenu {
    return railRowMenu(`${scope}:issue:${issue.id}`, (act) => (
      <IssueMenuItems
        issue={issue}
        assign={unownedRow ? {
          team,
          me: myEmail,
          onAssign: (member) => act(() => member.github_login ? onAssign(() => assignIssue(issue, member.github_login!), member, { issueID: issue.id }) : undefined)(),
        } : undefined}
        onChange={(change) => act(async () => {
          try {
            await setIssueState(issue, change);
            if (change !== 'reopen') leaveUnowned({ issueID: issue.id });
            setError('');
            void loadRecentlyClosed();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : t('Couldn’t update that issue.'));
          }
          void loadMine();
          void loadInbox();
        })()}
        onHandOff={hasAgents ? act(() => setHandingOff({ id: issue.id, issue, subject: null })) : undefined}
        onSeen={seenKey ? act(() => onDismissInboxItem(seenKey)) : undefined}
        door={seenKey ? { onClick: act(() => openMineIssue(issue)) } : undefined}
      />
    ));
  }

  /** A row acted on leaves UNOWNED at once; the re-read every Mine refresh makes confirms it. */
  function leaveUnowned(row: { taskID?: string; issueID?: string }) {
    setUnowned((current) => current ? {
      ...current,
      tasks: row.taskID ? current.tasks.filter((task) => task.id !== row.taskID) : current.tasks,
      issues: row.issueID ? current.issues.filter((issue) => issue.id !== row.issueID) : current.issues,
    } : current);
  }

  /** Assign to… from an UNOWNED row: the write, then Mine and UNOWNED read again — the row leaves one and may join the other. */
  async function onAssign(write: () => Promise<unknown>, member: CrmTeamMember, row: { taskID?: string; issueID?: string }) {
    try {
      await write();
      leaveUnowned(row);
      setError('');
      toast(t('Assigned to {name}', { name: member.name }));
    } catch (cause) {
      failWith(cause, t('Couldn’t assign that.'));
    }
    void loadMine();
  }

  async function onReopenRecentlyClosed(item: CrmRecentlyClosedItem) {
    setRecentlyClosedError('');
    try {
      await reopenRecentlyClosedWork(item);
      setRecentlyClosed((current) => current.filter((row) => row.kind !== item.kind || row.id !== item.id));
      void loadMine();
    } catch (cause) {
      setRecentlyClosedError(cause instanceof Error ? cause.message : t('Couldn’t reopen that work.'));
    }
  }

  /**
   * A subject row's menu, in rail and Browse: the Mac rail's
   * (`WorkSidebarRowView.subject`). Star and Mute first, about the reader;
   * then where it opens and its edit; then its panes and what can be made
   * there. A partner is read-only: Open, Open talk, Open history. Left out,
   * with no web call: Rename… and Meet about this.
   * Keep vault opens the handoff to Mac and iPhone: the web holds no vault.
   */
  /**
   * A subject row's menu: which actions, in what order, for which kind, comes from the shared
   * action table (`RowMenuItems`, `@starlings/contracts/work-actions`), as a task row's does. This
   * supplies what each one does here. Rename and Meet about this are not on the web (the
   * table says so).
   */
  function subjectMenu(subject: CrmSubject, scope: string): RowMenu {
    const state = states.get(subject.id);
    const partner = isPartner(subject);
    return railRowMenu(`${scope}:subject:${subject.id}`, (act) => {
      const open = (pane: WorkDetailPane) => act(() => onSelect(subject, pane));
      const coreDoor = coreSubjectDoor(subject.kind, subject.id);
      const toggle = (icon: MenuIconName, label: string, update: SubjectStateUpdate) => (
        <DropdownMenuItem onClick={act(() => changeSubjectState(subject, update))}>
          <MenuIcon name={icon} />{label}
        </DropdownMenuItem>
      );
      return (
        <RowMenuItems
          kind="subject"
          context={partner ? 'organization' : 'row'}
          facts={{ isPartner: partner, isEvent: isEvent(subject), isProject: subject.kind === 'project', isOpenLead: subject.kind === 'lead' && !isSubjectClosed('lead', subject.status), hasRepo: Boolean(subject.has_repo), hasCore: Boolean(coreDoor) }}
          run={{
            // A partner opens on its page; anything else on its Talk.
            open: open(partner ? 'partner' : 'talk'),
            'open-talk': open('talk'),
            'open-history': open('interactions'),
            'edit-details': act(() => openEditSubject(subject)),
            'win-lead': act(() => setWinningLead(subject)),
            'open-tasks': open('tasks'),
            'open-issues': open('issues'),
            'new-task': act(() => onSelect(subject, 'tasks').then(() => setEditing({ task: null }))),
            'new-issue': act(() => {
              createOnArrivalFor.current = subject.id;
              setCreateOnArrival('issue');
              return onSelect(subject, 'issues');
            }),
            'keep-vault': act(() => setKeepHandoff(subject)),
            'link-repository': act(() => setLinkingRepo(subject)),
          }}
          doors={{ 'open-core': coreDoor ?? undefined }}
          render={state && subjectState ? {
            star: () => toggle(state.starred ? 'unstar' : 'star', state.starred ? t('Unstar') : t('Star'), { starred: !state.starred }),
            mute: () => toggle(state.muted ? 'unmute' : 'mute', state.muted ? t('Unmute') : t('Mute'), { muted: !state.muted }),
          } : { star: () => null, mute: () => null }}
        />
      );
    });
  }

  /** An INBOX row's menu, by kind (`WorkInboxItem.rowActions`). Archive is
   * for direct conversations; these rows are subject channels. */
  function inboxMenu(item: InboxItem, scope: string): RowMenu {
    const key = `${scope}:${item.key}`;
    switch (item.source) {
      case 'talk':
      case 'mention': {
        const subject = subjectFromThread(item.thread);
        if (!subject) return undefined;
        const thread = item.thread;
        const change = (write: () => Promise<unknown>, fallback: string) => () => write()
          .then(() => refreshPoll(THREADS_POLL_KEY))
          .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : fallback));
        return railRowMenu(key, (act) => (
          <RowMenuItems kind="inbox_talk" context="row" facts={{ hasSubject: true, hasUnread: thread.unread, hasCore: true }}
            run={{
              'open-subject': act(() => onSelect(subject, 'talk')),
              'mark-read': act(change(() => markThreadRead(thread.id), t('Couldn’t mark this conversation read.'))),
              mute: act(change(() => setThreadMuted(thread.id, { until: thread.muted_until ? null : Date.now() + 7 * 24 * 3600 * 1000 }), t('Couldn’t change that.'))),
            }}
            labels={{ 'open-subject': t('Open {title}', { title: subject.title }), mute: thread.muted_until ? t('Unmute') : t('Mute') }}
            doors={{ 'open-core': coreSubjectDoor(subject.kind, subject.id) }}
          />
        ));
      }
      case 'task':
        return railRowMenu(key, (act) => (
          <TaskMenuItems
            context="inbox_proposed"
            subjectTitle={item.subject.title}
            door={{ onClick: act(() => openInboxItem(item)) }}
            coreDoor={coreSubjectDoor(item.subject.kind, item.subject.id)}
            onAccept={act(() => onDecideProposal(item.task, true))}
            onDecline={act(() => onDecideProposal(item.task, false))}
          />
        ));
      case 'followup':
        return railRowMenu(key, (act) => (
          <RowMenuItems kind="inbox_followup" context="row"
            run={{
              open: act(() => setFollowUpDialog(item)),
              dismiss: act(async () => {
                try {
                  await dismissFollowUp(item);
                  void loadInbox();
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : t('Couldn’t dismiss that follow-up.'));
                }
              }),
            }}
          />
        ));
      case 'card':
        return railRowMenu(key, (act) => (
          <RowMenuItems kind="inbox_card" context="row" facts={{ isIssue: !!item.issue }}
            run={{
              open: act(() => openInboxItem(item)),
              'open-subject': act(() => onSelect({ ...item.subject, subtitle: null })),
            }}
            labels={{ 'open-subject': t('Open {title}', { title: item.subject.title }) }}
            doors={{ 'open-github': item.issue ? { href: item.issue.url, external: true } : undefined }}
          />
        ));
      case 'note':
        return railRowMenu(key, (act) => (
          <MenuGroups
            groups={[
              [<DropdownMenuItem key="file" onClick={act(() => setNoteDialog({ note: item.note, filing: true }))}><MenuIcon name="file" />{t('File…')}</DropdownMenuItem>],
              [<DropdownMenuItem key="delete" variant="destructive" onClick={act(() => onDeleteInboxNote(item.note.id))}><MenuIcon name="delete" />{t('Delete')}</DropdownMenuItem>],
            ]}
          />
        ));
      case 'sales':
        return railRowMenu(key, (act) => (
          <MenuGroups
            groups={[
              [<DropdownMenuItem key="lead" onClick={act(() => onStartLeadFromInbox(item.touch))}><MenuIcon name="startLead" />{t('Start a lead…')}</DropdownMenuItem>],
              [
                <DropdownMenuItem key="dismiss" onClick={act(() => onDismissInboxTouch(item.touch))}><MenuIcon name="dismiss" />{t('Dismiss')}</DropdownMenuItem>,
                ...(item.touch.contact.email ? [<CopyEmailItem key="email" email={item.touch.contact.email} />] : []),
              ],
            ]}
          />
        ));
      case 'comment': {
        const subject = item.subject;
        return railRowMenu(key, (act) => (
          <MenuGroups
            groups={[
              [
                <OpenItem key="document" href={documentHref(item.document.id)} label={t('Open document')} icon="openDocument" />,
                ...(subject ? [<DropdownMenuItem key="subject" onClick={act(() => openInboxItem(item))}><MenuIcon name="open" />{t('Open {title}', { title: subject.title })}</DropdownMenuItem>] : []),
              ],
              [<DropdownMenuItem key="resolve" onClick={act(() => onResolveInboxComment(item.thread.id))}><MenuIcon name="resolve" />{t('Resolve')}</DropdownMenuItem>],
            ]}
          />
        ));
      }
      case 'booking': {
        const href = item.change === 'cancelled' ? null : bookingEventHref(item.booking);
        return railRowMenu(key, (act) => (
          <MenuGroups
            groups={[
              [
                ...(href ? [<OpenItem key="event" href={href} label={t('Open in Calendar')} icon="openCalendar" />] : []),
                <CopyEmailItem key="email" email={item.booking.guest_email} />,
              ],
              [<DropdownMenuItem key="dismiss" onClick={act(() => onDismissInboxItem(item.key))}><MenuIcon name="dismiss" />{t('Dismiss')}</DropdownMenuItem>],
            ]}
          />
        ));
      }
      case 'invitation':
        return railRowMenu(key, (act) => (
          <RowMenuItems kind="inbox_invitation" context="row"
            doors={{ 'open-calendar': { href: inboxItemHref(item), label: t('Open in Calendar') } }}
            render={{ rsvp: () => <RSVPAnswerItems onAnswer={(response) => act(() => onAnswerInboxCalendar(item, () => respondToCalendarInvitation(item.event, response)))()} /> }}
          />
        ));
      case 'forwarded':
        return railRowMenu(key, (act) => (
          <RowMenuItems kind="inbox_forwarded" context="row"
            run={{
              accept: act(() => onAnswerInboxCalendar(item, () => addPendingCalendarEvent(item.event.id))),
              decline: act(() => onAnswerInboxCalendar(item, () => discardPendingCalendarEvent(item.event.id))),
            }}
            labels={{ accept: t('Add to calendar'), decline: t('Discard') }}
          />
        ));
      case 'question':
        return railRowMenu(key, (act) => <RowMenuItems kind="inbox_question" context="row" run={{ open: act(() => setQuestionDialog(item.request)) }} labels={{ open: t('Open question') }} />);
      case 'decision':
        return railRowMenu(key, (act) => (
          <RowMenuItems kind="inbox_decision" context="row"
            run={{ open: act(() => setDecisionDialog(item.ask)) }}
            labels={{ open: t('Open decision') }}
            render={{ decide: () => <DecisionAnswerItems ask={item.ask} onAnswer={(option) => act(() => onAnswerInboxDecision(item.ask, option))()} /> }}
          />
        ));
      case 'interest':
      case 'submission':
        return railRowMenu(key, (act) => (
          <MenuGroups
            groups={[
              [<CopyEmailItem key="email" email={item.submission.email} />],
              [<DropdownMenuItem key="dismiss" onClick={act(() => onDismissInboxItem(item.key))}><MenuIcon name="dismiss" />{t('Dismiss')}</DropdownMenuItem>],
            ]}
          />
        ));
      case 'commercial':
        return railRowMenu(key, (act) => (
          <RowMenuItems kind="inbox_commercial" context="row" facts={{ isDismissed: false }}
            run={{
              'open-subject': act(() => openInboxItem(item)),
              dismiss: act(() => onDismissInboxItem(item.key)),
            }}
            labels={{ 'open-subject': t('Open {title}', { title: item.subject.title }) }}
          />
        ));
      case 'support':
        return railRowMenu(key, (act) => (
          <MenuGroups groups={[[<DropdownMenuItem key="open" onClick={act(() => openInboxItem(item))}><MenuIcon name="open" />{t('Open conversation')}</DropdownMenuItem>]]} />
        ));
      case 'guest':
        return railRowMenu(key, (act) => (
          <MenuGroups
            groups={[
              [<DropdownMenuItem key="open" onClick={act(() => openInboxItem(item))}><MenuIcon name="open" />{t('Open {title}', { title: item.subject.title })}</DropdownMenuItem>],
              ...(item.sender_email ? [[<CopyEmailItem key="email" email={item.sender_email} />] as ReactNode[]] : []),
              [<DropdownMenuItem key="dismiss" onClick={act(() => onDismissInboxItem(item.key))}><MenuIcon name="dismiss" />{t('Dismiss')}</DropdownMenuItem>],
            ]}
          />
        ));
    }
  }

  /** The read-only "Where" of the task editor, from the names already in hand. */
  function editorWhere(task: CrmTask | null): { label: string; href: string | null } {
    if (!task) {
      if (!selected) return { label: t('No subject'), href: null };
      const column = selected.kind === 'organization' ? 'organization_id' : `${selected.kind}_id`;
      const where = taskWhere({ [column]: selected.id }, subjectDisplayTitle(selected));
      return { label: where.label, href: subjectHref(selected) };
    }
    const filed = workSubjectOf(task);
    const name = filed && selected && selected.id === filed.id
      ? subjectDisplayTitle(selected)
      : focusedMineTask?.id === task.id ? focusedMineTask.subject_title : null;
    const where = taskWhere(task, name);
    return { label: where.label, href: where.subject ? subjectHref(where.subject) : null };
  }

  async function onSave(draft: TaskDraft) {
    if (!selected && !editing?.task) return;
    try {
      const saved = editing?.task
        ? await updateTask(editing.task.id, draft)
        : await createTask(selected!, draft);
      setEditing(null);
      if (editing?.task && focusedTaskRecord?.id === editing.task.id) setFocusedTaskRecord(saved);
      if (!selected) { void loadMine(); return; }
      await loadTasks(selected);
    } catch (cause) {
      failWith(cause, t('Couldn’t save that task.'));
    }
  }

  /**
   * The SALES opt-in is the Worker's, so it follows the person to every
   * client and decides what INBOX carries too.
   */
  async function setSalesEnabled(enabled: boolean) {
    try {
      const state = await setWorkPreferences({ sales_enabled: enabled });
      applySubjectState(state);
      setOverrides(new Map(state.states.map((row) => [`${row.kind}:${row.id}`, { starred: row.starred, muted: row.muted }])));
      void loadInbox();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t change Sales.'));
    }
  }

  /**
   * The Board columns this person hides, on every project and device
   *. Applied in place first, then sent whole; on failure the
   * columns come back.
   */
  async function setBoardHiddenStages(stages: WorkStage[]) {
    const before = subjectState;
    if (before) applySubjectState({ ...before, board_hidden_stages: stages });
    try {
      applySubjectState(await setWorkPreferences({ board_hidden_stages: stages }));
    } catch (cause) {
      applySubjectState(before);
      setError(cause instanceof Error ? cause.message : t('Couldn’t change the board.'));
    }
  }

  /**
   * A line from a task's Activity, in its thread: the open subject's Talk at
   * that message, or the conversation on Team when it is anywhere else.
   */
  async function openCardLine(line: ThreadMessage) {
    const subject = selected;
    if (subject) {
      try {
        const opened = await apiFetch<{ thread: ThreadSummary }>('/threads', {
          method: 'POST', body: { kind: subject.kind, subject_id: subject.id }, fallbackError: t('Couldn’t open this conversation.'),
        });
        if (opened.thread.id === line.thread_id) {
          setFocusedMineTask(null);
          setFocusedTaskRecord(null);
          setTalkFocus(line.id);
          showPane('talk');
          return;
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t('Couldn’t open this conversation.'));
        return;
      }
    }
    navigate(teamThreadHref(line.thread_id, line.id));
  }

  /** A card's last line: the project's Talk, at that message. */
  function openBoardTrace(trace: CardTrace) {
    setTalkFocus(trace.message_id);
    showPane('talk');
  }

  /** Applied in place first, then sent; on failure the row goes back. */
  async function changeSubjectState(subject: CrmSubject, update: SubjectStateUpdate) {
    const key = subjectStateKey(subject);
    const before = overrides.get(key);
    const next: SubjectStateOverride = {
      starred: update.starred ?? before?.starred ?? false,
      muted: update.muted ?? before?.muted ?? false,
    };
    setOverrides((current) => new Map(current).set(key, next));
    try {
      const stored = await setSubjectState(subject, update);
      setOverrides((current) => {
        const map = new Map(current);
        if (stored) map.set(key, { starred: stored.starred, muted: stored.muted });
        else map.delete(key);
        return map;
      });
      void loadInbox();
      if (update.starred !== undefined) void refreshFavorites().catch(() => {});
    } catch (cause) {
      setOverrides((current) => {
        const map = new Map(current);
        if (before) map.set(key, before); else map.delete(key);
        return map;
      });
      setError(cause instanceof Error ? cause.message : t('Couldn’t change that.'));
    }
  }

  function openCreateSubject(subjectKind: SubjectKind) {
    if (subjectKind === 'lead' && !salesEnabled) void setSalesEnabled(true);
    setSubjectEditor({ kind: subjectKind, detail: null, subject: null });
  }

  /** The subject's editor, in the column: the open subject's, or a row's from its menu. */
  async function openEditSubject(subject: CrmSubject | null = selected) {
    if (!subject) return;
    try {
      const detail = await fetchSubjectDetail(subject);
      setSubjectEditor({ kind: subject.kind, detail, subject });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t load that subject.'));
    }
  }

  /** An organization's fields were saved: the page and the rail read the new name. */
  function onSavedOrganization(detail: CrmSubjectDetail) {
    setEditingOrganization(null);
    setSubjectDetail((current) => current?.id === detail.id ? detail : current);
    setSelected((current) => current?.id === detail.id ? { ...current, title: detail.title, subtitle: detail.subtitle } : current);
    setSubjectsByKind((current) => ({
      ...current,
      organization: current.organization.map((row) => row.id === detail.id ? { ...row, title: detail.title, subtitle: detail.subtitle } : row),
    }));
  }

  /**
   * Two organizations were merged: the merged one leaves the
   * rail, and the one that stayed opens, read again.
   */
  function onMergedOrganization(kept: { id: string; title: string }, merged: string[]) {
    setMergingOrganization(null);
    toast(t('Merged into {name}', { name: kept.title }), 'neutral');
    setSubjectsByKind((current) => ({
      ...current,
      organization: current.organization.filter((row) => !merged.includes(row.id)),
    }));
    void loadSubjects();
    void onSelect({ id: kept.id, kind: 'organization', title: kept.title, subtitle: null }, 'partner');
  }

  /** Delete an organization. The Worker refuses while a record still points at it, and says which. */
  async function onDeleteOrganization(subject: CrmSubject) {
    if (!await confirmDataLoss({
      title: t('Delete “{name}”?', { name: subject.title }),
      body: t('The organization is deleted. This can’t be undone.'),
      action: t('Delete'),
    })) return;
    try {
      await deleteCrmOrganization(subject.id);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : t('Couldn’t delete that organization.'), 'danger');
      return;
    }
    setSubjectsByKind((current) => ({ ...current, organization: current.organization.filter((row) => row.id !== subject.id) }));
    toast(t('Deleted {name}', { name: subject.title }), 'neutral');
    showOverview();
    void loadSubjects();
  }

  /** An event from Work's own form was saved: open it, with its page read again. */
  async function onSavedWorkEvent(saved: WorkEvent) {
    const subject: CrmSubject = { id: saved.id, kind: 'event', title: saved.title, subtitle: saved.location, event_date: saved.date };
    setWorkEvent(saved);
    setSubjectsByKind((current) => ({
      ...current,
      event: [subject, ...current.event.filter((row) => row.id !== subject.id)],
    }));
    await onSelect(subject, 'event');
    void loadSubjects();
  }

  /** A CMS event was saved: read the page again and carry a new title to the rail. */
  async function onSavedCmsEvent(subject: CrmSubject, record: CmsRecord) {
    const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : subject.title;
    if (title !== subject.title) {
      setSelected((current) => current?.id === subject.id ? { ...current, title } : current);
      setSubjectsByKind((current) => ({
        ...current,
        [subject.kind]: current[subject.kind].map((row) => row.id === subject.id ? { ...row, title } : row),
      }));
    }
    try {
      const detail = await fetchSubjectDetail(subject);
      setSubjectDetail((current) => current?.id === subject.id ? detail : current);
    } catch {
      // The save landed; the page keeps what it had until the next open.
    }
  }

  /** Make a person responsible for the open subject (docs/OWNERSHIP.md). */
  async function onMakeResponsible(subject: CrmSubject, email: string) {
    try {
      const detail = await setSubjectResponsible(subject, email);
      setSelected((current) => (current && current.id === detail.id ? { ...current, ...detail } : current));
      setSubjectsByKind((current) => ({
        ...current,
        [detail.kind]: current[detail.kind].map((row) => (row.id === detail.id ? { ...row, ...detail } : row)),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t change who is responsible.'));
    }
  }

  async function onSaveSubject(draft: SubjectDraft) {
    setSubjectRefusal(null);
    try {
      const detail = subjectEditor?.subject
        ? await updateSubject(subjectEditor.subject, draft)
        : await createSubject(draft);
      const summary: CrmSubject = detail;
      setSubjectEditor(null);
      if (detail.kind === 'lead' && !salesEnabled) await setSalesEnabled(true);
      setSubjectsByKind((current) => ({
        ...current,
        [detail.kind]: [summary, ...current[detail.kind].filter((row) => row.id !== summary.id)],
      }));
      setError('');
      await onSelect(summary);
      void loadSubjects();
      if (inboxPendingTouchId) {
        const touchId = inboxPendingTouchId;
        setInboxPendingTouchId(null);
        try {
          await setSalesInboxDismissed(touchId, true);
          await loadInbox();
        } catch (cause) {
          setInboxError(cause instanceof Error ? cause.message : t('Couldn’t clear that from the inbox.'));
        }
      }
    } catch (cause) {
      // A refused field reads in the sheet, beside that field, and only there.
      if (cause instanceof ControlRequestError && cause.status === 400 && cause.code === 'invalid_request') {
        setSubjectRefusal({ message: cause.message, field: cause.field ?? null });
        return;
      }
      failWith(cause, t('Couldn’t save that subject.'));
    }
  }

  /** Win on a lead: open the project it started; a partial win says what stayed behind. */
  async function onWinLead(lead: CrmSubject, input: { title: string; task_ids: string[] }) {
    try {
      const result = await winLead(lead, input);
      const project: CrmSubject = result.project;
      setWinningLead(null);
      setSubjectsByKind((current) => ({
        ...current,
        project: [project, ...current.project.filter((row) => row.id !== project.id)],
      }));
      setError('');
      await onSelect(project);
      void loadSubjects();
      const left = [
        result.lead_closed ? '' : t('Project started. The lead is still open.'),
        result.unmoved_task_ids.length ? plural(result.unmoved_task_ids.length, { one: '{count} task stayed on the lead.', other: '{count} tasks stayed on the lead.' }) : '',
      ].filter(Boolean).join(' ');
      if (left) toast(left, 'danger');
    } catch (cause) {
      failWith(cause, t('Couldn’t win that lead.'));
    }
  }

  function onStartLeadFromInbox(touch: UntriagedTouch) {
    setInboxPendingTouchId(touch.id);
    setSubjectEditor({ kind: 'lead', detail: inboxDraftFromTouch(touch), subject: null });
  }

  async function onDismissInboxTouch(touch: UntriagedTouch) {
    try {
      await setSalesInboxDismissed(touch.id, true);
      await loadInbox();
    } catch (cause) {
      setInboxError(cause instanceof Error ? cause.message : t('Couldn’t dismiss that.'));
    }
  }

  /** Answer a decision from its row's menu, without opening it. */
  async function onAnswerInboxDecision(ask: DecisionAsk, key: string) {
    try {
      await answerDecisionAsk(ask.id, key);
      await loadInbox();
    } catch (cause) {
      setInboxError(cause instanceof Error ? cause.message : t('Couldn’t answer that decision.'));
    }
  }

  /**
   * Answer a calendar row from its menu: an invitation's RSVP, or Add or
   * Discard on an event from email. The row leaves at once; a failed write
   * puts it back where it was and says why.
   */
  async function onAnswerInboxCalendar(item: InboxInvitationItem | InboxForwardedItem, send: () => Promise<unknown>) {
    const index = inbox?.items.findIndex((row) => row.key === item.key) ?? -1;
    setInbox((current) => current && { ...current, items: current.items.filter((row) => row.key !== item.key) });
    try {
      await send();
    } catch (cause) {
      setInbox((current) => {
        if (!current || current.items.some((row) => row.key === item.key)) return current;
        const items = [...current.items];
        items.splice(index < 0 ? items.length : Math.min(index, items.length), 0, item);
        return { ...current, items };
      });
      setInboxError(cause instanceof Error ? cause.message : t('Couldn’t send your answer.'));
      return;
    }
    void loadInbox();
  }

  async function onDismissInboxItem(key: string) {
    try {
      await setInboxItemDismissed(key, true);
      await loadInbox();
    } catch (cause) {
      setInboxError(cause instanceof Error ? cause.message : t('Couldn’t dismiss that.'));
    }
  }

  /** Delete an unfiled Quick Note from its Quick Notes row menu. */
  async function onDeleteInboxNote(id: string) {
    try {
      await deleteQuickNote(id);
      await loadInbox();
    } catch (cause) {
      setInboxError(cause instanceof Error ? cause.message : t('Couldn’t delete that Quick Note.'));
    }
  }

  /** Resolve a document's comment thread from its INBOX row: the thread's opening comment carries the status. */
  async function onResolveInboxComment(rootID: string) {
    try {
      await updateDocsAnnotation(rootID, { status: 'resolved' });
      await loadInbox();
    } catch (cause) {
      setInboxError(cause instanceof Error ? cause.message : t('Couldn’t change the comment.'));
    }
  }

  if (auth === 'loading') {
    return <WorkSkeleton view={view} detail={Boolean(initialDestination?.subjectID || initialDestination?.taskID)} />;
  }

  if (auth === 'needed') {
    return (
      <SignInGate title={t('Work')} onSignedIn={loadMine} />
    );
  }

  if (auth === 'denied') {
    // Signed in, and the role stops here. A sign-in button would send the
    // person around a loop that ends on this same line.
    return (
      <SurfaceShell surface="work" title={t('Work')}>
        <p className="lede">{t('Work isn’t available to your account.')}</p>
      </SurfaceShell>
    );
  }

  function openThreadRef(ref: ThreadMessageRef) {
    if (ref.kind === 'issue') {
      const [slug, number] = ref.id.split('#');
      const [owner, repo] = (slug ?? '').split('/');
      if (!owner || !repo || !number) return;
      setSelectedIssue({ owner, repo, number: Number(number) });
      return;
    }
    // A task reads in the column, as a tap on its row does: from the list in
    // hand, else by id (a task the line names may have left the open list).
    if (ref.kind === 'task') {
      setSelectedIssue(null);
      const known = tasks.find((task) => task.id === ref.id);
      if (known) { openSubjectTask(known); return; }
      void fetchTaskByID(ref.id).then(openSubjectTask).catch(() => undefined);
      return;
    }
    // A decision reads in History, a goal on the Tasks pane (#262).
    if (ref.kind === 'decision') { showPane('interactions'); return; }
    if (ref.kind === 'goal') { showPane('tasks'); return; }
    const url = githubURLForRef(ref);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }

  function openMineTask(task: CrmMyTask) {
    const filed = workSubjectOf(task);
    const id = filed?.id;
    const kind: SubjectKind | null = filed?.kind ?? null;
    if (!id || !kind || !task.subject_title) {
      writeWorkDestination(view, { taskID: task.id });
      setSelected(null);
      setDetailPane('tasks');
      setFocusedMineTask(task);
      setFocusedTaskRecord(null);
      // A Mine row is a partial record (no assignee, no goal). With no
      // subject list to read the full task from, ask for it by id, so the
      // reader and the editor show the real responsible party and assignee.
      setFocusedTaskLoading(true);
      void fetchTaskByID(task.id)
        .then((record) => { if (mineOpenRequest.current === task.id) setFocusedTaskRecord(record); })
        .catch(() => undefined)
        .finally(() => { if (mineOpenRequest.current === task.id) setFocusedTaskLoading(false); });
      mineOpenRequest.current = task.id;
      setTasks([]);
      setInteractions([]);
      setInteractionsError('');
      setSubjectEvents([]);
      return;
    }
    mineOpenRequest.current = null;
    void onSelect(
      { id, kind, title: task.subject_title, subtitle: null },
      'tasks',
      task,
    );
  }

  function openMineIssue(issue: IssueReference) {
    setFocusedMineTask(null);
    setFocusedTaskRecord(null);
    setSelectedIssue(issue);
    // Over a subject, the address stays the subject's.
    if (!selected) writeWorkDestination(view, { issue });
  }

  /** A contact's page, in the column; over a subject, the subject stays behind it. */
  function openContact(contactID: string) {
    setAddingContact(null);
    setSelectedContact(contactID);
    writeWorkDestination(view, { contactID });
  }

  function closeContact() {
    setSelectedContact(null);
    writeWorkDestination(view, selected ? { subject: selected, pane } : undefined);
  }

  /** The issue's column closes; an address that named the issue goes back to the view. */
  function closeIssue() {
    setSelectedIssue(null);
    const record = parsePermalinkPath(window.location.pathname);
    if (record?.surface === 'work' && record.kind === 'issue') writeWorkDestination(view);
  }

  function openSubjectTask(task: CrmTask) {
    if (selected) writeWorkDestination(view, { subject: selected, pane: 'tasks', taskID: task.id });
    setFocusedMineTask(null);
    setFocusedTaskRecord(task);
    setFocusedTaskLoading(false);
  }

  /** An open task on the selected subject: its Tasks pane and its Overview draw it alike. */
  function subjectTaskRow(task: CrmTask, filedOn: CrmSubject | null = selected) {
    if (!filedOn) return null;
    return (
      <TaskRow
        key={task.id}
        favoriteTargetRef={task.id}
        active={focusedTaskRecord?.id === task.id}
        leaving={completingTaskIDs.has(task.id)}
        title={task.title}
        metadata={[
          formatDay(task.due_date) || null,
          STATUS_LABEL[task.status],
          task.assignee_name ?? RESPONSIBLE_LABEL[task.responsible_party],
          task.goal_id ? goals.find((goal) => goal.id === task.goal_id)?.title ?? null : null,
        ].filter(Boolean).join(' · ')}
        onComplete={() => { void onComplete(task); }}
        onOpen={() => openSubjectTask(task)}
        menu={railRowMenu(`task:${task.id}`, (act) => (
          <TaskMenuItems
            context="subject_open"
            subjectTitle={filedOn.title}
            coreDoor={coreSubjectDoor(filedOn.kind, filedOn.id)}
            favoriteRef={task.id}
            onDone={act(() => onComplete(task))}
            onCancel={act(() => onComplete(task, true))}
            onHandOff={hasAgents ? act(() => setHandingOff({ id: task.id, task, subject: filedOn })) : undefined}
            onDelete={act(() => onDeleteTask(task))}
          />
        ))}
      />
    );
  }

  function showPane(pane: WorkDetailPane) {
    if (!selected) return;
    setDetailPane(pane);
    if (pane !== 'interactions') { setSelectedInteraction(null); setInteractionEditor(null); }
    writeWorkDestination(view, { subject: selected, pane });
  }

  /** A History row from the Overview opens in the History pane's reader. */
  function openInteraction(interaction: CrmInteraction) {
    showPane('interactions');
    setSelectedInteraction(interaction);
  }

  function closeInteractionReader(interactionID: string) {
    setSelectedInteraction(null);
    setInteractionEditor(null);
    window.requestAnimationFrame(() => interactionButtonRefs.current[interactionID]?.focus());
  }

  /** Where a Work row goes. A note opens its dialog; a touch starts a lead. */
  function openInboxItem(item: InboxItem) {
    switch (item.source) {
      case 'question':
        setQuestionDialog(item.request);
        return;
      case 'followup':
        setFollowUpDialog(item);
        return;
      case 'decision':
        setDecisionDialog(item.ask);
        return;
      case 'talk':
      case 'mention': {
        const subject = subjectFromThread(item.thread);
        if (subject) void onSelect(subject, 'talk');
        return;
      }
      case 'task':
        void onSelect({ ...item.subject, subtitle: null }, 'tasks');
        return;
      case 'card':
        // The card itself: the issue's reader, or the task on its subject.
        if (item.issue) openMineIssue(item.issue);
        else void onSelect({ ...item.subject, subtitle: null }, 'tasks');
        return;
      case 'note':
        setNoteDialog({ note: item.note, filing: false });
        return;
      case 'sales':
        onStartLeadFromInbox(item.touch);
        return;
      case 'comment':
        if (item.subject) void onSelect({ ...item.subject, subtitle: null }, 'documents');
        return;
      case 'booking': {
        // The calendar's inspector is where the event is filed; Work only
        // says a guest booked. A cancelled booking has no event to open.
        if (item.change === 'cancelled') return;
        const href = bookingEventHref(item.booking);
        if (href) navigate(href);
        return;
      }
      case 'invitation':
      case 'forwarded':
        // The event, or the day it would land on: the answers are in the row's menu.
        navigate(inboxItemHref(item));
        return;
      case 'interest':
      case 'submission':
        // The lead it filed is where the work goes on (docs/FORMS.md). An
        // older row, or one whose lead was deleted, can only write to them.
        if (item.submission.lead) {
          void onSelect({ ...item.submission.lead, subtitle: null });
          return;
        }
        window.location.assign(`mailto:${item.submission.email}`);
        return;
      case 'commercial':
        // The lead or organization, on its Overview: its offers and licences.
        void onSelect({ ...item.subject, subtitle: null });
        return;
      case 'guest':
        // Intake has no CRM record: open its sender-private conversation.
        if (item.subject.id === 'intake') {
          navigate(teamThreadHref(item.thread_id));
          return;
        }
        // Other guest threads are on the subject's Overview (docs/SUPPORT.md).
        void onSelect({ ...item.subject, subtitle: null });
        return;
      case 'support':
        openHelp({ conversationId: item.conversation_id });
        return;
    }
  }

  /** One Work row: unread talk draws its subject's mark, bold, the way the
   * Mac's `WorkSidebarRowView.subject(hasUnread:)` does; the rest draw their
   * source's glyph in the same well. */
  function inboxRow(item: InboxItem) {
    const meta = inboxItemMeta(item);
    const taskID = inboxTaskID(item);
    const talkSubject = item.source === 'talk' || item.source === 'mention' ? subjectFromThread(item.thread) : null;
    return (
      <RailRow
        key={item.key}
        leading={talkSubject ? <SubjectMark subject={talkSubject} size={26} /> : <GlyphMark shape={meta.shape}>{meta.symbol}</GlyphMark>}
        title={meta.title}
        subtitle={meta.detail}
        leaving={taskID !== null && completingTaskIDs.has(taskID)}
        unread={talkSubject !== null}
        onSelect={() => openInboxItem(item)}
        menu={inboxMenu(item, 'inbox')}
      />
    );
  }

  function subjectRow(subject: CrmSubject, scope: string) {
    const state = states.get(subject.id);
    const unread = unreadSubjectIDs.has(subject.id) && !state?.muted;
    return (
      <RailRow
        key={subject.id}
        leading={<SubjectMark subject={subject} size={26} />}
        title={subjectDisplayTitle(subject)}
        subtitle={[subjectKindLabel(subject), subjectStanding(subject)].filter(Boolean).join(' · ')}
        unread={unread}
        active={selected?.id === subject.id}
        muted={Boolean(state?.muted)}
        starred={Boolean(state?.starred)}
        ariaLabel={[subjectDisplayTitle(subject), unread ? 'unread' : null, state?.starred ? 'starred' : null, state?.muted ? 'muted' : null].filter(Boolean).join(', ')}
        onSelect={() => { void onSelect(subject, 'talk'); }}
        menu={subjectMenu(subject, scope)}
      />
    );
  }

  /** The open subject's star control and one menu for mute/edit. */
  function subjectHeaderActions(subject: CrmSubject) {
    const state = states.get(subject.id);
    // A CMS event keeps its full editor (every website field); the form edits
    // an event the CMS does not hold.
    const editsWorkEvent = isEvent(subject) && cmsEvents === null && workEvent?.id === subject.id;
    const editsEvent = isEvent(subject) && (cmsEvents !== null || editsWorkEvent);
    const editable = (!isPartner(subject) && !isEvent(subject)) || editsEvent;
    const hasState = Boolean(state && subjectState);
    const linksRepository = subject.kind === 'project' && !subject.has_repo;
    if (!hasState && !editable && !linksRepository) return null;
    return (
      <span className={stateActionsClass}>
        {state && subjectState && (
          <StarToggle starred={state.starred} onToggle={(starred) => { void changeSubjectState(subject, { starred }); }} />
        )}
        <SubjectMoreMenu
          muted={state && subjectState ? state.muted : null}
          onMute={() => { if (state) void changeSubjectState(subject, { muted: !state.muted }); }}
          onEdit={editable ? () => {
            if (editsWorkEvent) setEventEditor({ event: workEvent });
            else if (editsEvent) setCmsEventEditing(true);
            else void openEditSubject();
          } : undefined}
          onWin={subject.kind === 'lead' && !isSubjectClosed('lead', subject.status) ? () => setWinningLead(subject) : undefined}
          onLinkRepository={linksRepository ? () => setLinkingRepo(subject) : undefined}
        />
      </span>
    );
  }

  function browseGroup(spec: typeof BROWSE_GROUPS[number]) {
    const groupKind = BROWSE_GROUP_SPECS[spec.group].subjectKind;
    if (!browseGroupShown(spec.group, salesEnabled) || !subjectKindShown(groupKind, workModules) || hiddenKinds.includes(groupKind)) return null;
    const organizations = spec.group === 'partners';
    const status = spec.sortKey ? browseStatus[spec.sortKey] : null;
    const filtered = spec.sortKey && status !== null && status !== defaultSubjectStatus(spec.sortKey);
    const sourced = spec.group === 'sales' && leadSource !== '';
    const page = organizations
      ? (organizationsCustom ? organizationPage ?? undefined : undefined)
      : sourced ? leadSourcePage ?? undefined
      : filtered ? browsePages[`${spec.sortKey === 'lead' ? 'lead' : 'project'}:${status}`] : undefined;
    const custom = organizations ? organizationsCustom : sourced || Boolean(filtered);
    const pool = custom ? page?.subjects ?? [] : allSubjects;
    const loadingStatus = Boolean(custom && !page);
    const counts = spec.sortKey === 'lead' ? browseCounts.lead?.counts
      : spec.sortKey === 'envisioning' ? browseCounts.project?.internal
        : spec.sortKey === 'project' ? browseCounts.project?.client : undefined;
    const members = pool.filter((subject) => subjectGroup({ kind: subject.kind, title: subject.title, internal: subject.internal }, workspaceProjectGroup()) === spec.group);
    const sorted = spec.sortKey
      ? sortSubjects(members, sortOptions[spec.sortKey])
      : spec.group === 'events'
        ? sortEventsByDate(members)
        : [...members].sort((a, b) => a.title.localeCompare(b.title));
    const starred = sorted.filter((subject) => states.get(subject.id)?.starred);
    const rest = sorted.filter((subject) => !states.get(subject.id)?.starred);
    // One hierarchy — group, then subject — like the rail, unfolded. No
    // organization headers: they doubled the group's own (ENVISIONING over
    // ENVISIONING) and told nothing the row's subtitle does not.
    const rows = [...starred, ...rest];
    const hasMore = page ? page.hasMore : spec.group === 'sales' ? hasMoreByKind.lead
      : spec.group === 'partners' ? hasMoreByKind.organization
        : spec.group === 'events' ? hasMoreByKind.event
          : hasMoreByKind.project;
    // Every group header folds, remembered per browser under the group's own key, as on the Mac.
    return (
      <div key={spec.group} className="mt-[18px]">
        <RailSection
          title={spec.title}
          storageKey={BROWSE_GROUP_SPECS[spec.group].preferenceKey}
          forcedOpen={organizations && organizationQuery.trim() !== ''}
          accessory={(
            <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
              {organizations && (
                <>
                  <Input
                    type="search"
                    value={organizationQuery}
                    placeholder={t('Search')}
                    aria-label={t('Search Organizations')}
                    className="h-7 w-36 text-xs"
                    onChange={(event) => setOrganizationQuery(event.target.value)}
                  />
                  <OrganizationFilterMenu filter={organizationFilter} facets={organizationFacets} onChange={changeOrganizationFilter} />
                </>
              )}
              {spec.group === 'sales' && (
                <NativeSelect
                  value={leadSource}
                  aria-label={t('Filter {title} by product', { title: spec.title })}
                  onChange={(event) => {
                    setLeadSource(event.target.value);
                    writeStored(StorageKeys.workLeadSource, event.target.value);
                  }}
                >
                  <NativeSelectOption value="">{t('All products')}</NativeSelectOption>
                  <NativeSelectOption value={SIGNALS_LEAD_SOURCE}>{t('Signals')}</NativeSelectOption>
                </NativeSelect>
              )}
              {spec.sortKey && status !== null && (
                <NativeSelect
                  value={status}
                  aria-label={t('Filter {title} by status', { title: spec.title })}
                  onChange={(event) => {
                    const list = spec.sortKey!;
                    setBrowseStatus((current) => ({ ...current, [list]: event.target.value }));
                    writeSubjectStatus(list, event.target.value);
                  }}
                >
                  {subjectStatusOptions(spec.sortKey).map((option) => (
                    <NativeSelectOption key={option} value={option}>
                      {counts && counts[option] !== undefined ? `${subjectStatusLabel(option)} · ${counts[option]}` : subjectStatusLabel(option)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              )}
              {spec.sortKey && (
                <NativeSelect
                  value={sortOptions[spec.sortKey]}
                  aria-label={t('Sort {title}', { title: spec.title })}
                  onChange={(event) => {
                    const option = event.target.value as SubjectSortOption;
                    const list = spec.sortKey!;
                    setSortOptions((current) => ({ ...current, [list]: option }));
                    writeSubjectSort(list, option);
                  }}
                >
                  <NativeSelectOption value="busiest">{t('Busiest First')}</NativeSelectOption>
                  <NativeSelectOption value="alphabetical">{t('Alphabetical')}</NativeSelectOption>
                </NativeSelect>
              )}
              <small>{sorted.length}{hasMore ? '+' : ''}</small>
            </span>
          )}
        >
          {sorted.length === 0 && (loadingStatus ? <RailRowsPlaceholder count={3} label={t('Loading…')} /> : <p className="lede">{custom && organizations ? t('Nothing matches.') : t('Nothing here.')}</p>)}
          <ul className={railListClass}>
            {rows.map((subject) => subjectRow(subject, 'browse'))}
          </ul>
        </RailSection>
      </div>
    );
  }

  const mineDoneItems = mineFilter.origin === 'all' ? recentlyClosed : recentlyClosed.filter((item) => item.kind === mineFilter.origin);
  const mineList = !mineLoaded ? <RailRowsPlaceholder count={5} mark="square" label={t('Loading…')} /> : (
    <>
      {/* One section, no date headers: the row says its date, and MINE
          reads the same on the Mac and the phone. */}
      {mineDone ? (
        <section aria-label={t('Recently finished')}>
          {recentlyClosedError && <p className="lede" role="status">{recentlyClosedError}</p>}
          {mineDoneItems.length > 0 ? (
            <ul className={railListClass}>
              {mineDoneItems.map((item) => (
                <RailRow
                  key={`${item.kind}:${item.id}`}
                  title={item.title}
                  subtitle={[item.subject_title, item.issue ? `${item.issue.repo} #${item.issue.number}` : null].filter(Boolean).join(' · ')}
                  trailing={<Button type="button" variant="outline" size="sm" aria-label={t('Reopen {title}', { title: item.title })} onClick={() => { void onReopenRecentlyClosed(item); }}>{t('Reopen')}</Button>}
                />
              ))}
            </ul>
          ) : !recentlyClosedError && <p className="lede">{t('Nothing finished this week.')}</p>}
        </section>
      ) : (
        <>
          {minePlan.openCount > 0 && (
            <ul className={railListClass} aria-label={t('Mine')}>
              {WORK_SECTIONS.flatMap((section) => minePlan.sections[section].map((row) => (
                <MineWorkRow
                  key={row.id}
                  row={row}
                  section={section}
                  activeTaskID={focusedMineTask?.id ?? null}
                  completingTaskIDs={completingTaskIDs}
                  activeIssue={selectedIssue}
                  onComplete={(task) => { void onCompleteMine(task); }}
                  onOpenTask={openMineTask}
                  onOpenIssue={openMineIssue}
                  menu={(task) => mineTaskMenu('mine', task)}
                  issueMenu={(issue) => issueRowMenu('mine', issue)}
                />
              )))}
            </ul>
          )}
          {minePlan.openCount === 0 && (
            <p className="lede">
              {mineAllPlan.openCount > 0 ? t('Nothing matches.') : t('Nothing is assigned to you.')}
            </p>
          )}
        </>
      )}
      {githubLogin === null ? (
        <p className="lede">
          {t('Issues name their assignee by GitHub username.')}{' '}
          <Button
            type="button"
            variant="outline" size="sm"
            onClick={() => {
              const wanted = window.prompt(t('Your GitHub username'), '');
              if (wanted === null) return;
              void setGithubLogin(wanted.trim() || null)
                .then((saved) => { setLogin(saved); return loadMine(); })
                .catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : t('Couldn’t save that username.'));
                });
            }}
         >
            {t('Set yours')}
          </Button>
        </p>
      ) : (
        myIssues.length === 0 && <p className="lede">{t('No issues assigned to @{login}.', { login: githubLogin })}</p>
      )}
    </>
  );

  const activityList = <WorkActivity entries={inbox?.recent ?? null} partial={inbox?.recent_partial ?? []}
    failed={Boolean(inboxError)} onRetry={() => void loadInbox()}
    onOpen={(subject) => { void onSelect({ ...subject, subtitle: null }, 'interactions'); }} />;

  const inboxList = (
    <>
      {inboxError && <ErrorNotice message={inboxError} copyText={inboxError} action={<Button type="button" variant="outline" size="xs" onClick={() => void loadInbox()}>{t('Retry')}</Button>} />}
      {inbox === null && !inboxError && <RailRowsPlaceholder count={5} label={t('Loading…')} />}
      {inbox !== null && inboxItems.length === 0 && !inboxError && (
        <p className="lede">{inboxAllItems.length > 0 ? t('Nothing matches.') : t('Nothing needs you.')}</p>
      )}
      {inboxItems.length > 0 && <ul className={railListClass} aria-label={t('Inbox')}>{inboxItems.map((item) => inboxRow(item))}</ul>}
      {inbox && inbox.partial.length > 0 && (
        <ErrorNotice inline className="mx-2 mt-2 text-xs" role="status" message={inboxPartialLine(inbox)} action={<Button type="button" variant="outline" size="xs" onClick={() => void loadInbox()}>{t('Retry')}</Button>} />
      )}
      {inbox && inboxCappedLine(inbox) && (
        <p className="mx-2 mt-2 text-xs text-muted-foreground" role="status">{inboxCappedLine(inbox)}</p>
      )}
    </>
  );

  // Every Overview header folds, remembered per browser under the shared
  // registry's key (`@starlings/contracts/rail-blocks`, `workOverview`).
  const quickNotesList = quickNoteItems.length > 0 ? (
    <div className="mt-5">
      <RailSection title={t('Quick Notes')} {...railBlockProps('workOverview', 'quickNotes')} count={quickNoteItems.length}>
        <ul className={railListClass} aria-label={t('Quick Notes')}>
          {quickNoteItems.map((item) => inboxRow(item))}
        </ul>
      </RailSection>
    </div>
  ) : null;

  // Below MINE, as Quick Notes sits below INBOX: open work nobody on our side
  // holds, on every subject. Absent when there is none — it is a nudge, not
  // a section that reads the same empty every day.
  const unownedList = unownedError || unownedAllPlan.openCount > 0 || (unowned?.partial.length ?? 0) > 0 || (unowned?.truncated?.length ?? 0) > 0 ? (
    <div className="mt-5">
    <RailSection
      title={t('Unowned')}
      storageKey={railBlockProps('workOverview', 'unowned').storageKey}
      count={unownedAllPlan.openCount}
      accessory={unownedAllPlan.openCount > 0 ? (
        <UnownedFilterMenu
          origin={unownedOrigin}
          typeCount={(value) => unownedShownPlan.order.filter((row) => value === 'all' || row.origin === value).length}
          subjects={unownedSubjects}
          hidden={unownedHidden}
          onChange={changeUnownedOrigin}
          onToggleSubject={toggleUnownedSubject}
          onShowAllSubjects={() => changeUnownedHidden(new Set())}
        />
      ) : undefined}
    >
      {unownedAllPlan.openCount > 0 && unownedPlan.openCount === 0 && <p className="lede">{t('Nothing matches.')}</p>}
      {unownedError && <ErrorNotice message={unownedError} copyText={unownedError} action={<Button type="button" variant="outline" size="xs" onClick={() => void loadUnowned()}>{t('Retry')}</Button>} />}
      {unownedPlan.openCount > 0 && (
        <ul className={railListClass} aria-label={t('Unowned')}>
          {WORK_SECTIONS.flatMap((section) => unownedPlan.sections[section].map((row) => (
            <MineWorkRow
              key={row.id}
              row={row}
              section={section}
              activeTaskID={focusedMineTask?.id ?? null}
              completingTaskIDs={completingTaskIDs}
              activeIssue={selectedIssue}
              onComplete={(task) => { void onCompleteMine(task); }}
              onOpenTask={openMineTask}
              onOpenIssue={openMineIssue}
              menu={(task) => mineTaskMenu('unowned', task, 'unowned')}
              issueMenu={(issue) => issueRowMenu('unowned', issue, undefined, true)}
            />
          )))}
        </ul>
      )}
      {unowned && readFailureLine(unowned) && (
        <ErrorNotice
          className="mx-2 mt-2 text-xs"
          role="status"
          message={readFailureLine(unowned)}
          action={<Button type="button" variant="outline" size="xs" onClick={() => void loadUnowned()}>{t('Retry')}</Button>}
        />
      )}
      {/* A cap hit is not an error (meet#1022): quiet, grey, no Retry. */}
      {unowned && truncatedLine(unowned) && (
        <p className="mx-2 mt-2 mb-0 text-xs text-muted-foreground">{truncatedLine(unowned)}</p>
      )}
    </RailSection>
    </div>
  ) : null;

  const atHome = !selected && !focusedMineTask && !selectedContact && !addingContact && !editingOrganization && !mergingOrganization;
  // The tab, most specific first: an issue over its project, a task, a
  // subject, else the view.
  const openTitle = selectedIssue
    ? [`#${selectedIssue.number}`, selected?.title].filter(Boolean).join(' · ')
    : focusedMineTask ? focusedMineTask.title
      : selectedContact || addingContact ? t('Contact')
      : selected ? selected.title
        : view === 'browse' ? 'Browse'
          : null;
  // Nothing today, nothing in INBOX, nothing in MINE: one line and the door
  // to Browse, instead of three headers over nothing.
  const overviewEmpty = inbox !== null && todayRows.length === 0 && inboxAllItems.length === 0 && quickNoteItems.length === 0 && mineAllPlan.openCount === 0 && unownedList === null && inbox.recent.length === 0 && inbox.recent_partial.length === 0;

  const rail = (
    <>
          <ul className={cn(railListClass, 'mb-3.5')} aria-label={t('Work')}>
            <RailRow title={t('Overview')} active={atHome && view === 'overview'} onSelect={showOverview} />
            {/* The service catalog (meet#1282): beside the work once the commercial group answers from D1. */}
            {offersModuleOn && !workspaceCoreGroups().has('commercial') && <RailRow title={t('Catalog')} subtitle={t('Services and prices')} onSelect={() => navigate('/work/catalog')} />}
          </ul>

          {/* SUBJECTS alone since 2026-09-23, as on the Mac (docs/WORK.md):
              INBOX and MINE are Overview's two columns, not rail blocks. */}
          <RailSection
            title={t('Subjects')}
            storageKey="work.subjects"
            count={railSubjects.length}
          >
            {railSubjects.length === 0 && (
              <RailEmpty>{allSubjects.length > 0 ? 'No active subjects yet.' : 'Follow a subject in Browse.'}</RailEmpty>
            )}
            <ul className={railListClass}>
              {railSubjects.map((subject) => subjectRow(subject, 'rail'))}
            </ul>
            <ul className={railListClass}>
              <RailRow title={t('Browse…')} subtitle={t('Every subject, by relationship')} muted active={atHome && view === 'browse'} onSelect={showBrowse} />
            </ul>
          </RailSection>
    </>
  );

  return (
    <SurfaceShell
      surface="work"
      title={t('Work')}
      openTitle={openTitle}
      open={!atHome}
      onBack={showOverview}
      backLabel="Overview"
      rail={rail}
      rightSidebar={{ open: rightSidebar.open, onToggle: rightSidebar.toggle }}
      create={(
        <SurfaceCreate
          label={t('New')}
          items={[
            { label: t('New project…'), icon: 'newProject', onSelect: () => openCreateSubject('project') },
            { label: t('New lead…'), icon: 'startLead', onSelect: () => openCreateSubject('lead') },
            ...(eventOptions?.can_create ? [{ label: t('New event…'), icon: 'addEvent' as const, onSelect: () => setEventEditor({ event: null }) }] : []),
            { label: t('New Quick Note…'), icon: 'notes', onSelect: () => setNoteDialog({ note: null, filing: false }) },
          ]}
        />
      )}
      inspector={selected && (
        <WorkSubjectContextPanel
          key={selected.id}
          subject={selected}
          detail={subjectDetail}
          detailError={subjectDetailError}
          peers={peerRoster?.peers ?? null}
          inboundAddress={inboundAddresses[selected.id] ?? null}
          onMessage={(email) => {
            const peer = peerRoster?.peers.find((candidate) => candidate.email === email);
            navigate(peerHref({ email, kind: peer?.kind ?? 'human' }));
          }}
          tasks={tasks}
          onMakeResponsible={(email) => void onMakeResponsible(selected, email)}
        />
      )}
      before={<>
      {error && (planFailure?.message === error
        ? <PlanLimitNotice code={planFailure.code} />
        : <ErrorNotice message={error} />)}
      {!error && stale && (
        <ErrorNotice
          message={stale.updatedAt ? `${stale.message} · ${updatedLabel(stale.updatedAt)}` : stale.message}
          copyText={stale.message}
          action={<Button type="button" variant="outline" size="xs" onClick={stale.retry}>{t('Retry')}</Button>}
        />
      )}
      </>}
    >
          {editing && (selected || editing.task) ? (
            // An editor reads in the column, where the task it edits reads.
            <TaskEditor
              key={editing.task?.id ?? 'new'}
              task={editing.task}
              where={editorWhere(editing.task)}
              team={team}
              teamError={teamError}
              me={myEmail}
              goals={selected?.kind === 'project' ? goals.filter((goal) => isLiveGoal(goal) || goal.id === editing.task?.goal_id) : []}
              onCancel={() => setEditing(null)}
              onSave={(draft) => { void onSave(draft); }}
            />
          ) : subjectEditor ? (
            <SubjectEditor
              key={subjectEditor.subject?.id ?? `new-${subjectEditor.kind}`}
              kind={subjectEditor.kind}
              detail={subjectEditor.detail}
              subject={subjectEditor.subject}
              refusal={subjectRefusal}
              onCancel={() => { setSubjectEditor(null); setSubjectRefusal(null); setInboxPendingTouchId(null); }}
              onSave={(draft) => { void onSaveSubject(draft); }}
            />
          ) : winningLead ? (
            <LeadWinSheet
              key={winningLead.id}
              lead={winningLead}
              onCancel={() => setWinningLead(null)}
              onWin={(input) => onWinLead(winningLead, input)}
            />
          ) : mergingOrganization ? (
            <OrganizationMerger
              key={`merge-organization:${mergingOrganization.id}`}
              detail={mergingOrganization}
              onCancel={() => setMergingOrganization(null)}
              onMerged={onMergedOrganization}
            />
          ) : editingOrganization ? (
            <OrganizationEditor
              key={`edit-organization:${editingOrganization.id}`}
              detail={editingOrganization}
              onCancel={() => setEditingOrganization(null)}
              onSaved={onSavedOrganization}
            />
          ) : addingContact ? (
            <ContactEditor
              key={`new-contact:${addingContact.id}`}
              contact={null}
              organization={addingContact}
              onCancel={() => setAddingContact(null)}
              onSaved={(contact) => {
                setAddingContact(null);
                setContactsVersion((version) => version + 1);
                if (selected && isPartner(selected)) void fetchSubjectDetail(selected).then(setSubjectDetail).catch(() => undefined);
                openContact(contact.id);
              }}
            />
          ) : selectedContact ? (
            <ContactDetail
              key={selectedContact}
              id={selectedContact}
              onMerged={(survivor) => { setContactsVersion((version) => version + 1); openContact(survivor); }}
              onChanged={() => setContactsVersion((version) => version + 1)}
              onDeleted={() => {
                toast(t('Contact deleted'), 'neutral');
                setContactsVersion((version) => version + 1);
                if (selected && isPartner(selected)) void fetchSubjectDetail(selected).then(setSubjectDetail).catch(() => undefined);
                closeContact();
              }}
              onOpenSubject={(subject) => { void onSelect(subject, subject.kind === 'organization' ? 'partner' : 'overview'); }}
              renderCall={(interaction) => {
                const filed = workSubjectOf(interaction);
                return historyRow({ kind: 'interaction', interaction, at: 0 }, () => {
                  if (filed) void onSelect({ id: filed.id, kind: filed.kind, title: t('Loading subject…'), subtitle: null }, 'interactions');
                });
              }}
              onClose={closeContact}
            />
          ) : selectedIssue ? (
            // An issue from Mine or a Talk chip reads in the column, where a
            // task reads — never over the page.
            <IssueDetail
              key={`${selectedIssue.owner}/${selectedIssue.repo}/${selectedIssue.number}`}
              issue={selectedIssue}
              projectID={selected?.kind === 'project' ? selected.id : undefined}
              onClose={closeIssue}
              onChange={() => { void loadMine(); void loadSubjects(); }}
            />
          ) : focusedMineTask ? (
            <MineTaskReader
              task={focusedMineTask}
              record={focusedTaskRecord}
              loading={focusedTaskLoading}
              subject={selected}
              onBack={() => {
                setFocusedMineTask(null);
                setFocusedTaskRecord(null);
                setSelected(null);
                writeWorkDestination(view);
              }}
              onOpenSubject={selected ? () => {
                setFocusedMineTask(null);
                setFocusedTaskRecord(null);
                setDetailPane('tasks');
                writeWorkDestination(view, { subject: selected, pane: 'tasks' });
              } : undefined}
              onComplete={() => { void onCompleteMine(focusedMineTask); }}
              onEdit={focusedTaskRecord ? () => setEditing({ task: focusedTaskRecord }) : undefined}
              onMove={(to) => { void onMoveTask(focusedMineTask, to); }}
              onDelete={() => { void onDeleteTask(focusedMineTask); }}
              onOpenLine={(line) => { void openCardLine(line); }}
            />
          ) : focusedTaskRecord && selected ? (
            <SubjectTaskReader
              task={focusedTaskRecord}
              subject={selected}
              onOpenLine={(line) => { void openCardLine(line); }}
              goalTitle={focusedTaskRecord.goal_id ? goals.find((goal) => goal.id === focusedTaskRecord.goal_id)?.title ?? null : null}
              onBack={() => {
                setFocusedTaskRecord(null);
                writeWorkDestination(view, { subject: selected, pane: 'tasks' });
              }}
              onComplete={() => { void onCompleteSelectedTask(focusedTaskRecord); }}
              onEdit={focusedTaskRecord.status === 'proposed' ? undefined : () => setEditing({ task: focusedTaskRecord })}
              onMove={focusedTaskRecord.status === 'proposed' ? undefined : (to) => { void onMoveTask(focusedTaskRecord, to); }}
              onAccept={focusedTaskRecord.status === 'proposed' ? () => { void onDecideProposal(focusedTaskRecord, true); } : undefined}
              onDecline={focusedTaskRecord.status === 'proposed' ? () => { void onDecideProposal(focusedTaskRecord, false); } : undefined}
              onDelete={focusedTaskRecord.status === 'proposed' ? undefined : () => { void onDeleteTask(focusedTaskRecord); }}
            />
          ) : selected ? (
            <>
              <DetailHead>
                {/* One line; the full title is in the rail and the tab (meet#491). */}
                <h2 className={cn(detailTitleClass, 'flex min-w-0 flex-auto items-center gap-2.5')}><SubjectMark subject={selected} size={28} /><span className="min-w-0 truncate">{selected.title}</span>{selected.kind === 'lead' && subjectDetail?.id === selected.id && <LeadQualificationSummary characteristics={subjectDetail.characteristics} />}</h2>
                <div className="flex flex-none items-center gap-2">
                  {subjectHeaderActions(selected)}
                  <Button type="button" size="sm" variant="outline" onClick={() => setSharing(true)}>{t('Share')}</Button>
                  <RightSidebarSlot />
                  <Button type="button" size="sm" onClick={() => setEditing({ task: null })}>{t('New task')}</Button>
                </div>
              </DetailHead>
              {selected.kind === 'project' && projectFrozen(workspacePlan, selected.id) && (
                <PlanLimitNotice code={PLAN_ERROR_CODES.projectFrozen} />
              )}
              {/* The subject's views are one row of tabs on every client (meet#1061, `subject-panes`). */}
              <Tabs value={pane} onValueChange={(value) => showPane(value as WorkDetailPane)}>
                <TabsList aria-label={t('Subject views')} className="h-auto max-w-full flex-wrap justify-start">
                  {subjectPanes(selected.kind, webPaneNeeds(selected, !wideSubject)).map((id) => (
                    <TabsTrigger key={id} id={`work-tab-${id}`} value={id}>{paneTitle(id)}</TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              {pane === 'overview' && (
                <SubjectOverviewLayout
                  talk={wideSubject ? <ThreadPane key={`${selected.id}:${talkFocus ?? ''}`} fill title={t('Talk')} address={{ kind: selected.kind, subject_id: selected.id }} mentionable={mentionable} onOpenRef={openThreadRef} onThreadLoaded={noteInboundAddress} focus={talkFocus ?? undefined} /> : undefined}
                >
                  {/* The groups, their order and what each needs are the registry's (`subject-overview-groups`, meet#1061). */}
                  {subjectOverviewGroups(selected.kind, { repo: selected.kind === 'project' && Boolean(selected.has_repo), docs: true, offers: offersModuleOn, licenses: licensesModuleOn }).map((group) => {
                    switch (group) {
                      case 'goals': return <SubjectGoals key={`goals:${selected.id}`} inGroup projectId={selected.id} goals={goals} error={goalsError} team={team} onReload={() => { void loadGoals(selected); }} />;
                      case 'submission': return <OverviewSubmission key={`submission:${selected.id}`} subject={selected} />;
                      case 'tasks': return (
                        <OverviewGroup
                    key={`tasks:${selected.id}`}
                    subject={selected}
                    group="tasks"
                    title={t('Tasks')}
                    rows={tasks.filter((task) => task.status !== 'proposed').map((task) => subjectTaskRow(task))}
                    onShowAll={() => showPane('tasks')}
                    onNew={() => setEditing({ task: null })}
                    newLabel={t('New task')}
                  />
                      );
                      case 'issues': return (
                        <OverviewIssues
                      key={`issues:${selected.id}`}
                      subject={selected}
                      onOpen={(issue) => openMineIssue(issue)}
                      onShowAll={() => showPane('issues')}
                      onNew={() => { createOnArrivalFor.current = selected.id; setCreateOnArrival('issue'); showPane('issues'); }}
                    />
                      );
                      // The people on it: an organization's contacts, a project's or a lead's from its detail.
                      case 'contacts': return (
                        <OverviewContacts
                      key={`contacts:${selected.id}`}
                      subject={selected}
                      contactIDs={subjectDetail?.id === selected.id
                        ? [...new Set([...(subjectDetail.contact_id ? [subjectDetail.contact_id] : []), ...(subjectDetail.contact_ids ?? [])])]
                        : null}
                      detailError={subjectDetailError}
                      version={contactsVersion}
                      onOpen={openContact}
                    />
                      );
                      // Offers and licences, behind their work modules; one read for both.
                      case 'offers': return <OverviewOffers key={`offers:${selected.id}`} subject={selected} commercial={commercial} />;
                      case 'licenses': return <OverviewLicenses key={`licenses:${selected.id}`} subject={selected} commercial={commercial} />;
                      case 'decisions': return <SubjectDecisions key={`decisions:${selected.id}`} inGroup subject={selected} goals={goals.filter(isLiveGoal)} onShowAll={() => showPane('interactions')} />;
                      case 'documents': return (
                        <OverviewDocuments
                      key={`documents:${selected.id}`}
                      subject={selected}
                      onShowAll={() => showPane('documents')}
                      onNew={selected.kind === 'organization' ? undefined : () => { createOnArrivalFor.current = selected.id; setCreateOnArrival('document'); showPane('documents'); }}
                    />
                      );
                      case 'history': return (
                        <OverviewGroup
                      key={`history:${selected.id}`}
                      subject={selected}
                      group="history"
                      title={t('History')}
                      rows={overviewHistory.map((entry) => historyRow(entry, openInteraction))}
                      loading={interactionsLoading}
                      error={interactionsError}
                      onRetry={() => { void loadInteractions(selected); }}
                      onShowAll={() => showPane('interactions')}
                      onNew={() => { showPane('interactions'); setSelectedInteraction(null); setInteractionEditor({ interaction: null }); }}
                      newLabel={t('Log')}
                    />
                      );
                      // A partner's projects and leads; a lead's projects and a project's lead are the lead-to-project edge (ADR 0008).
                      case 'related': return (
                        <OverviewGroup
                      key={`related:${selected.id}`}
                      subject={selected}
                      group="related"
                      title={selected.kind === 'lead' ? t('Projects') : selected.kind === 'project' ? t('Won from') : t('Related subjects')}
                      rows={[
                        ...(subjectDetail?.related?.projects ?? []).map((row) => ({ id: row.id, kind: 'project' as const, title: row.title, status: row.status })),
                        ...(subjectDetail?.related?.leads ?? []).map((row) => ({ id: row.id, kind: 'lead' as const, title: row.title, status: row.status })),
                      ].map((row) => {
                        const target: CrmSubject = { id: row.id, kind: row.kind, title: row.title?.trim() || t('Untitled'), subtitle: row.status };
                        return <RailRow key={`${row.kind}:${row.id}`} title={target.title} subtitle={row.status ?? undefined} onSelect={() => { void onSelect(target, 'talk'); }} />;
                      })}
                      loading={isPartner(selected) && !subjectDetail && !subjectDetailError}
                      error={isPartner(selected) ? subjectDetailError : ''}
                    />
                      );
                    }
                  })}
                  <SubjectGuestThread key={`guests:${selected.id}`} subject={selected} refreshKey={accessVersion} />
                </SubjectOverviewLayout>
              )}
              {sharing && (
                <SubjectShareDialog
                  subject={selected}
                  onClose={() => setSharing(false)}
                  onChanged={() => setAccessVersion((version) => version + 1)}
                />
              )}
              {pane === 'fields' && !isEvent(selected) && <SubjectFieldsPane key={selected.id} subject={selected} onSaved={() => { void loadSubjects(); }} />}
              {pane === 'documents' && <SubjectDocumentsPane key={selected.id} subject={selected} startCreating={createOnArrival === 'document' && createOnArrivalFor.current === selected.id} onCreateStarted={() => setCreateOnArrival(null)} />}
              {cmsEventEditing && cmsEvents && isEvent(selected) && (
                <CmsRecordEditor
                  entity={cmsEvents}
                  id={selected.id}
                  onClose={() => setCmsEventEditing(false)}
                  onSaved={(record) => { void onSavedCmsEvent(selected, record); }}
                />
              )}
              {eventEditor && eventOptions && (
                <EventEditor
                  event={eventEditor.event}
                  rooms={eventOptions.rooms}
                  onClose={() => setEventEditor(null)}
                  onSaved={(saved) => { void onSavedWorkEvent(saved); }}
                />
              )}
              {pane === 'event' && isEvent(selected) && (
                <EventDetail
                  subject={selected}
                  workEvent={workEvent?.id === selected.id ? workEvent : null}
                  detail={subjectDetail}
                  error={subjectDetailError}
                  onOpen={(related) => { void onSelect(related, 'talk'); }}
                />
              )}
              {pane === 'partner' && isPartner(selected) && (
                <PartnerDetail
                  subject={selected}
                  detail={subjectDetail}
                  error={subjectDetailError}
                  onOpen={(related) => { void onSelect(related, 'talk'); }}
                  onOpenContact={openContact}
                  onAddContact={() => setAddingContact({ id: selected.id, name: selected.title })}
                  onEdit={() => { if (subjectDetail) setEditingOrganization(subjectDetail); }}
                  onMerge={() => { if (subjectDetail) setMergingOrganization(subjectDetail); }}
                  onDelete={() => { void onDeleteOrganization(selected); }}
                />
              )}
              {pane === 'talk' && <ThreadPane key={`${selected.id}:${talkFocus ?? ''}`} title={t('Talk')} address={{ kind: selected.kind, subject_id: selected.id }} mentionable={mentionable} onOpenRef={openThreadRef} onThreadLoaded={noteInboundAddress} focus={talkFocus ?? undefined} />}
              {pane === 'tasks' && <>
              <div className="mb-2 flex items-center justify-end gap-1">
                {isPartner(selected) && (
                  <Button type="button" size="sm" variant="ghost" aria-pressed={byProject} onClick={() => changeByProject(!byProject)}>{t('By project')}</Button>
                )}
                <TaskFilterMenu filter={taskFilter} onChange={setTaskFilter} />
              </div>
              {isPartner(selected) && byProject ? (
                <OrganizationProjectTasks
                  response={projectTasks?.organizationID === selected.id ? projectTasks.response : null}
                  error={projectTasksError}
                  filter={taskFilter}
                  onRetry={() => { void loadProjectTasks(selected.id); }}
                  onOpenProject={(project) => { void onSelect(project, 'tasks'); }}
                  row={subjectTaskRow}
                />
              ) : <>
              {shownTasks.some((task) => task.status === 'proposed') && (
                <section className="mb-3" aria-labelledby="work-proposed-heading">
                  <PlanHead id="work-proposed-heading">{t('Proposed')}</PlanHead>
                  <ul className={railListClass} aria-label={t('Proposed tasks')}>
                    {shownTasks.filter((task) => task.status === 'proposed').map((task) => (
                      <RailRow
                        key={task.id}
                        leading={<GlyphMark shape="square"><TaskIcon size={14} /></GlyphMark>}
                        title={task.title}
                        subtitle={[t('Proposed'), formatDay(task.due_date) ? `due ${formatDay(task.due_date)}` : null, task.notes]
                          .filter(Boolean).join(' · ')}
                        menu={railRowMenu(`proposed:${task.id}`, (act) => (
                          <TaskMenuItems
                            context="subject_proposed"
                            subjectTitle={selected.title}
                            coreDoor={coreSubjectDoor(selected.kind, selected.id)}
                            onAccept={act(() => onDecideProposal(task, true))}
                            onDecline={act(() => onDecideProposal(task, false))}
                          />
                        ))}
                      />
                    ))}
                  </ul>
                </section>
              )}
              <ul className={railListClass} aria-label={t('Tasks')}>
                {shownTasks.filter((task) => task.status !== 'proposed').map((task) => subjectTaskRow(task))}
              </ul>
              {tasks.length === 0 && <p className="lede">{t('No open tasks for {title}.', { title: selected.title })}</p>}
              {tasks.length > 0 && shownTasks.length === 0 && <p className="lede">{t('Nothing matches.')}</p>}
              </>}
              </>}
              {pane === 'interactions' && (
                <section id="work-panel-interactions" role="tabpanel" aria-labelledby="work-tab-interactions">
                  {interactionEditor ? (
                    <InteractionEditor
                      key={interactionEditor.interaction?.id ?? 'new'}
                      interaction={interactionEditor.interaction}
                      subject={selected}
                      detail={subjectDetail}
                      onCancel={() => setInteractionEditor(null)}
                      onSave={onSaveInteraction}
                    />
                  ) : selectedInteraction ? (
                    <InteractionReader
                      interaction={selectedInteraction}
                      onBack={() => closeInteractionReader(selectedInteraction.id)}
                      onEdit={() => setInteractionEditor({ interaction: selectedInteraction })}
                      onDelete={() => { void onDeleteInteraction(selectedInteraction); }}
                    />
                  ) : (
                    <>
                      <SubjectDecisions key={selected.id} subject={selected} goals={goals.filter(isLiveGoal)} />
                      <div className="mt-[22px] flex flex-wrap items-end justify-between gap-4">
                        <div>
                          <h3 className={cn(detailTitleClass, 'text-[15px] opacity-75')}>{t('History')}</h3>
                          <p className={paneHelpClass}>{t('Meetings, notes, calls, emails, and web activity filed under this subject, with what changed here in Starlings.')}</p>
                        </div>
                        <div className="flex flex-none items-end gap-2">
                        <Label className="inline-flex flex-none items-center gap-2 text-xs text-muted-foreground font-normal leading-normal">
                          <span>{t('Filter')}</span>
                          <NativeSelect
                            className="min-w-[116px]"
                            value={interactionFilter}
                            aria-label={t('Filter interactions by type')}
                            onChange={(event) => setInteractionFilter(event.target.value as InteractionFilter)}
                          >
                            {INTERACTION_FILTERS.map((option) => (
                              <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>
                            ))}
                          </NativeSelect>
                        </Label>
                        {/* A primary create may take the accent (invariant 19). */}
                        <Button type="button" size="sm" onClick={() => setInteractionEditor({ interaction: null })}><PlusIcon />{t('Log')}</Button>
                        </div>
                      </div>
                      {interactionsError && (
                        <ErrorNotice
                          message={interactions.length > 0 && interactionsUpdatedAt ? `${interactionsError} · ${updatedLabel(interactionsUpdatedAt)}` : interactionsError}
                          copyText={interactionsError}
                          action={selected ? <Button type="button" variant="outline" size="xs" onClick={() => void loadInteractions(selected)}>{t('Retry')}</Button> : undefined}
                        />
                      )}
                      {(!interactionsError || interactions.length > 0) && (
                        <>
                          {interactionsLoading && interactions.length === 0 && (
                            <RailRowsPlaceholder count={4} mark="square" label={t('Loading interactions…')} className="mt-[18px]" />
                          )}
                          <div className="mt-[18px] flex flex-col gap-5">
                            {interactionGroups.map((group, groupIndex) => (
                              <section key={`${group.title}-${groupIndex}`} aria-labelledby={`interaction-group-${groupIndex}`}>
                                <h4 id={`interaction-group-${groupIndex}`} className="mt-0 mb-[7px] text-xs font-semibold text-muted-foreground">{group.title}</h4>
                                <ul className={railListClass} aria-label={group.title}>
                                  {group.rows.map((entry) => historyRow(
                                    entry,
                                    setSelectedInteraction,
                                    entry.kind === 'interaction' ? (button) => { interactionButtonRefs.current[entry.interaction.id] = button; } : undefined,
                                  ))}
                                </ul>
                              </section>
                            ))}
                          </div>
                          {!interactionsLoading && interactionGroups.length === 0 && (
                            <p className="lede">
                              {interactions.length === 0 && subjectEvents.length === 0
                                ? t('Nothing filed under {title} yet.', { title: selected.title })
                                : t('No {label} match this subject.', { label: INTERACTION_FILTERS.find((option) => option.value === interactionFilter)?.label.toLowerCase() ?? '' })}
                            </p>
                          )}
                        </>
                      )}
                    </>
                  )}
                </section>
              )}
              {pane === 'board' && selected.kind === 'project' && (
                <ProjectBoard
                  key={selected.id}
                  project={selected}
                  agents={(peerRoster?.peers ?? []).filter(isAgent)}
                  hiddenStages={subjectState?.board_hidden_stages ?? []}
                  onHiddenStagesChange={(stages) => { void setBoardHiddenStages(stages); }}
                  onOpenTrace={openBoardTrace}
                  onOpenTask={openSubjectTask}
                  onOpenIssue={(issue) => openMineIssue({ owner: issue.owner, repo: issue.repo, number: issue.number })}
                />
              )}
              {pane === 'issues' && selected.kind === 'project' && selected.has_repo && (
                <IssueWorkspace key={selected.id} projectID={selected.id} startCreating={createOnArrival === 'issue' && createOnArrivalFor.current === selected.id} onCreateStarted={() => setCreateOnArrival(null)} />
              )}
            </>
          ) : view === 'browse' ? (
            <section aria-labelledby="work-browse-heading">
              <DetailHead>
                <h2 id="work-browse-heading" className={detailTitleClass}>{t('Browse')}</h2>
              </DetailHead>
              <p className={paneHelpClass}>
                {t('{workspace}’s own projects, clients, organizations, events and, with Sales on, the lead pipeline. Star a subject to keep it at the top of the rail; mute it to keep it quiet.', { workspace: workspaceBrand().name })}
                {salesModuleOn && !salesEnabled && <> {tx('Sales is off for you; turn it on in {settings}.', { settings: <a href="/settings">{t('Settings')}</a> })}</>}
              </p>
              {BROWSE_GROUPS.map((spec) => (
                <Fragment key={spec.group}>
                  {browseGroup(spec)}
                  {/* Contacts are not subjects; they list after the organizations they belong to (meet#1213). */}
                  {spec.group === 'partners' && subjectKindShown('organization', workModules) && (
                    <ContactsBrowseGroup selectedContact={selectedContact} version={contactsVersion} onOpenContact={openContact} />
                  )}
                </Fragment>
              ))}
              {offersModuleOn && <OffersBrowseGroup />}
              {licensesModuleOn && <LicensesBrowseGroup />}
            </section>
          ) : (
            // Above 900px Inbox and Mine each scroll on their own and keep
            // their halves, the Mac's StarlingsHalvesSplitView; the column hands
            // its scroll to them (SurfaceShell). Narrower, one scroll.
            <section className={overviewEmpty ? 'work-overview' : OVERVIEW_SECTION} aria-label={t('Overview')}>
              {todayRows.length > 0 && (
                <>
                  <PlanHead as="h2" className="mb-2">{t('Today')}</PlanHead>
                  <ul className={railListClass} aria-label={t('Today')}>
                    {todayRows.map((row) => (
                      <RailRow
                        key={row.id}
                        leading={<GlyphMark><CalendarIcon /></GlyphMark>}
                        title={row.title}
                        subtitle={row.detail}
                        onSelect={() => { void onSelect({ id: row.subject.id, kind: row.subject.kind, title: row.subject.title, subtitle: null }, 'talk'); }}
                      />
                    ))}
                  </ul>
                </>
              )}
              {overviewEmpty ? (
                <div className="mb-[22px] flex flex-col items-start gap-2.5">
                  <p className="lede">{t('Nothing needs you.')}</p>
                  <Button type="button" variant="secondary" onClick={showBrowse}>{t('Browse subjects')}</Button>
                  {activityList}
                </div>
              ) : (
              <div className={OVERVIEW_COLUMNS}>
                <div className={overviewHalfClass}>
                  {/* Each header folds; the filter sits beside it, as on the Mac (WorkOverviewView). */}
                  <RailSection
                    title={t('Inbox')}
                    storageKey={railBlockProps('workOverview', 'inbox').storageKey}
                    count={inboxAllItems.length}
                    accessory={inboxAllItems.length > 0 ? <InboxFilterMenu filter={inboxFilter} items={inboxAllItems} onChange={changeInboxFilter} /> : undefined}
                  >
                    {inboxList}
                  </RailSection>
                  {quickNotesList}
                  {activityList}
                </div>
                <div className={overviewHalfClass}>
                  <RailSection
                    title={t('Mine')}
                    storageKey={railBlockProps('workOverview', 'mine').storageKey}
                    count={mineAllPlan.openCount}
                    accessory={<MineFilterMenu filter={mineFilter} done={mineDone} plan={mineAllPlan} closed={recentlyClosed} onChange={changeMineFilter} onDoneChange={setMineDone} />}
                  >
                    {mineList}
                  </RailSection>
                  {unownedList}
                </div>
              </div>
              )}
            </section>
          )}
          {keepHandoff && <KeepHandoffDialog projectTitle={keepHandoff.title} onClose={() => setKeepHandoff(null)} />}
          {handingOff && (
            <HandOffDialog
              card={handingOff}
              onHandedOff={(agent) => { setHandingOff(null); toast(t('Handed off to {name}', { name: peerDisplayName(agent) }), 'neutral'); }}
              onClose={() => setHandingOff(null)}
            />
          )}
          {linkingRepo && (
            <LinkRepositoryDialog
              project={linkingRepo}
              onClose={() => setLinkingRepo(null)}
              onLinked={() => {
                const project = linkingRepo;
                setLinkingRepo(null);
                toast(t('Repository linked'));
                void loadSubjects();
                // The project now has Issues: open them.
                void onSelect({ ...project, has_repo: true }, 'issues');
              }}
            />
          )}
          {followUpDialog && <FollowUpDialog key={followUpDialog.key} item={followUpDialog}
            onDone={() => { setFollowUpDialog(null); setInbox((current) => current ? { ...current, items: current.items.filter((row) => row.key !== followUpDialog.key) } : current); void loadInbox(); }}
            onClose={() => setFollowUpDialog(null)} />}
          {questionDialog && <AttentionQuestionDialog key={questionDialog.id} initial={questionDialog}
            onResolved={(request) => { setInbox((current) => current ? { ...current, items: current.items.filter((item) => item.key !== request.id) } : current); void loadInbox(); }}
            onClose={() => setQuestionDialog(null)} />}
          {decisionDialog && (
            <DecisionDialog
              key={decisionDialog.id}
              ask={decisionDialog}
              onAnswered={() => { void loadInbox(); }}
              onClose={() => setDecisionDialog(null)}
            />
          )}
          {noteDialog && (
            <QuickNoteDialog
              key={noteDialog.note?.id ?? 'new'}
              note={noteDialog.note}
              startFiling={noteDialog.filing}
              onChange={() => { void loadInbox(); }}
              onDelete={() => { void loadInbox(); }}
              onClose={() => setNoteDialog(null)}
            />
          )}
    </SurfaceShell>
  );
}

/** A column's header and its filter menu, on one line (Mac WorkOverviewView). */
const overviewHeadClass = 'mb-2 flex items-center justify-between gap-2';

/** Overview's section and its two halves (the loaded page and its skeleton). */
const OVERVIEW_SECTION = 'work-overview min-[901px]:flex min-[901px]:min-h-0 min-[901px]:flex-1 min-[901px]:flex-col';
const OVERVIEW_COLUMNS = 'work-overview-columns grid grid-cols-1 items-start gap-7 min-[901px]:min-h-0 min-[901px]:flex-1 min-[901px]:grid-cols-2 min-[901px]:grid-rows-[minmax(0,1fr)] min-[901px]:items-stretch';

/**
 * Work while the session opens, drawn in the page's own columns: the rail's
 * search, Overview and SUBJECTS, and the column the address asks for —
 * Overview's INBOX and MINE halves, Browse, or a subject's pane. The same
 * containers as the loaded page, so nothing moves when it lands.
 */
function WorkSkeleton({ view, detail }: { view: WorkView; detail: boolean }) {
  const rail = (
    <>
      <PlaceholderBar immediate className="mb-2.5 h-9 w-full rounded-md" />
      <ul className={cn(railListClass, 'mb-3.5')} aria-hidden="true">
        <RailRow title={t('Overview')} active={!detail && view === 'overview'} />
      </ul>
      <RailSection title={t('Subjects')} storageKey="work.subjects">
        <RailRowsPlaceholder count={6} immediate />
      </RailSection>
    </>
  );
  return (
    <SurfaceShell surface="work" title={t('Work')} rail={rail}>
      <PlaceholderStatus label={t('Opening…')} />
      {detail ? (
        <section>
          <DetailHead><PlaceholderBar immediate className="my-1 h-5 w-[38%] rounded-full" /></DetailHead>
          <PlaceholderBar immediate className="mt-2.5 h-3 w-[26%] rounded-full" />
          <RailRowsPlaceholder count={6} mark="square" immediate className="mt-[18px]" />
        </section>
      ) : view === 'browse' ? (
        <section>
          <DetailHead><h2 className={detailTitleClass}>{t('Browse')}</h2></DetailHead>
          {[0, 1].map((group) => (
            <section key={group} className="mt-[18px]">
              <PlaceholderBar immediate className="mb-2.5 h-2.5 w-24 rounded-full" />
              <RailRowsPlaceholder count={group === 0 ? 3 : 5} immediate />
            </section>
          ))}
        </section>
      ) : (
        <section className={OVERVIEW_SECTION}>
          <div className={OVERVIEW_COLUMNS}>
            <div className={overviewHalfClass}>
              <div className={overviewHeadClass}><PlanHead as="h2" className="mb-0">{t('Inbox')}</PlanHead></div>
              <RailRowsPlaceholder count={6} immediate />
            </div>
            <div className={overviewHalfClass}>
              <div className={overviewHeadClass}><PlanHead as="h2" className="mb-0">{t('Mine')}</PlanHead></div>
              <RailRowsPlaceholder count={6} mark="square" immediate />
            </div>
          </div>
        </section>
      )}
    </SurfaceShell>
  );
}

function InteractionReader({ interaction, onBack, onEdit, onDelete }: {
  interaction: CrmInteraction;
  onBack: () => void;
  /** Edit and Delete… show on every row; the Worker refuses what the member may not write. */
  onEdit: () => void;
  /** The caller asks first. */
  onDelete: () => void;
}) {
  const rawDate = interaction.occurred_at || interaction.created_at;
  const date = rawDate ? new Date(rawDate) : null;
  const body = interaction.summary_markdown?.trim() || interactionPreview(interaction);
  const contacts = interaction.contacts
    .map((contact) => contact.name || contact.email)
    .filter(Boolean)
    .join(', ');
  const previewLabel = interaction.summary_preview?.trim() ? t('Summary') : t('Transcript preview');
  const headingID = `interaction-reader-${interaction.id}`;

  return (
    <section className="py-1" aria-labelledby={headingID}>
      <DetailHead>
        <div>
          <h2 id={headingID} className={detailTitleClass}>{interactionTitle(interaction)}</h2>
        </div>
        <Button type="button" variant="secondary" onClick={onBack}>
          {t('Back to Interactions')}
        </Button>
      </DetailHead>

      <ReaderFacts
        facts={[
          [t('Type'), interactionTypeLabel(interaction)],
          date && !Number.isNaN(date.valueOf()) && [t('Occurred'), `${date.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short', year: 'numeric' })} at ${formatTime(date)}`],
          contacts && [t('People'), contacts],
          Boolean(interaction.duration_minutes) && [t('Duration'), `${interaction.duration_minutes} minutes`],
          interaction.status && [t('Status'), interaction.status],
        ]}
      />

      <div className="mt-6 max-w-[72ch] [&_.md]:text-foreground">
        <h3 className="mt-0 mb-2.5 text-xs tracking-[0.06em] text-muted-foreground uppercase">{previewLabel}</h3>
        {body ? <Markdown text={body} /> : <p className="lede">{t('No summary was filed for this interaction.')}</p>}
      </div>

      {interaction.url && (
        <p>
          <a className={readerLinkClass} href={interaction.url} target="_blank" rel="noreferrer">
            {t('Open source')}
          </a>
        </p>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={onEdit}>{t('Edit')}</Button>
        <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" onClick={onDelete}>{t('Delete…')}</Button>
      </div>
    </section>
  );
}

function TaskReader({
  title,
  backLabel,
  status,
  dueDate,
  subjectContent,
  responsible,
  assigneeName,
  goalTitle,
  updatedAt,
  notes,
  githubOwner,
  githubRepo,
  githubIssueNumber,
  loading,
  emptyMessage,
  onBack,
  onComplete,
  onEdit,
  onMove,
  onAccept,
  onDecline,
  onDelete,
  activity,
}: {
  title: string;
  backLabel: string;
  status: string;
  dueDate: string | null;
  subjectContent: ReactNode;
  responsible?: string | null;
  assigneeName?: string | null;
  /** The goal this task serves, when the page knows its title. */
  goalTitle?: string | null;
  updatedAt?: string | null;
  notes?: string | null;
  githubOwner?: string | null;
  githubRepo?: string | null;
  githubIssueNumber?: number | null;
  loading?: boolean;
  emptyMessage?: string | null;
  onBack: () => void;
  onComplete: () => void;
  onEdit?: () => void;
  /** Move to…: the picked project or lead becomes the task's subject. */
  onMove?: (subject: DocsSubject) => void;
  /** A proposed task's two answers; when present they replace its open-task actions. */
  onAccept?: () => void;
  onDecline?: () => void;
  /** Delete…: the caller asks first. */
  onDelete?: () => void;
  /** What was said about the task: the hand-off, the agent's work, its questions. */
  activity?: ReactNode;
}) {
  const [moving, setMoving] = useState(false);
  const githubURL = githubOwner && githubRepo && githubIssueNumber
    ? `https://github.com/${githubOwner}/${githubRepo}/issues/${githubIssueNumber}`
    : null;

  return (
    <section className="py-1" aria-label={t('Task details')}>
      <DetailHead>
        <div>
          <h2 className={detailTitleClass}>{title}</h2>
        </div>
        <Button type="button" variant="secondary" onClick={onBack}>
          {backLabel}
        </Button>
      </DetailHead>

      <ReaderFacts
        facts={[
          [t('Status'), STATUS_LABEL[status] ?? status],
          [t('Due'), formatDay(dueDate) || 'Undated'],
          [t('Subject'), subjectContent],
          responsible && [t('Responsible'), RESPONSIBLE_LABEL[responsible] ?? responsible],
          assigneeName && [t('Assigned to'), assigneeName],
          goalTitle && [t('Goal'), goalTitle],
          updatedAt && formatDay(updatedAt) && [t('Updated'), formatDay(updatedAt)],
        ]}
      />

      {loading && <PlaceholderRows count={2} glyph={false} label={t('Loading full task details…')} className="mt-5" />}
      {!loading && notes && <p className="mt-5 mb-0 max-w-[70ch] whitespace-pre-wrap [overflow-wrap:anywhere]">{notes}</p>}
      {!loading && emptyMessage && <p className="lede">{emptyMessage}</p>}
      {githubURL && (
        <p>
          <a className={readerLinkClass} href={githubURL} target="_blank" rel="noreferrer">
            Open GitHub issue #{githubIssueNumber}
          </a>
        </p>
      )}

      <div className="mt-6 flex flex-wrap gap-2">
        {onAccept && onDecline ? (
          <>
            <Button type="button" onClick={onAccept}>{t('Accept')}</Button>
            <Button type="button" variant="secondary" onClick={onDecline}>{t('Decline')}</Button>
          </>
        ) : (
          <>
            {onEdit && (
              <Button type="button" variant="secondary" onClick={onEdit}>
                {t('Edit task')}
              </Button>
            )}
            {onMove && (
              /* Move to… anchors its picker under the button. */
              <span className="relative inline-flex">
                <Button type="button" variant="secondary" onClick={() => setMoving(true)}>{t('Move to…')}</Button>
                {moving && <SubjectPicker kinds={TASK_SUBJECT_KINDS} onPick={(picked) => { setMoving(false); onMove(picked); }} onClose={() => setMoving(false)} />}
              </span>
            )}
            <Button type="button" onClick={onComplete}>{t('Done')}</Button>
            {onDelete && <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" onClick={onDelete}>{t('Delete…')}</Button>}
          </>
        )}
      </div>
      {activity && <div className="mt-8">{activity}</div>}
    </section>
  );
}

/**
 * An organization's Tasks By project: one folding section per
 * project with an open task, its title the project's door, its rows the
 * subject Tasks list's rows under the same Due and Side filters.
 */
function OrganizationProjectTasks({ response, error, filter, onRetry, onOpenProject, row }: {
  response: CrmOrganizationProjectTasksResponse | null;
  error: string;
  filter: WorkTaskFilter;
  onRetry: () => void;
  onOpenProject: (project: CrmSubject) => void;
  row: (task: CrmTask, filedOn: CrmSubject) => ReactNode;
}) {
  if (error && !response) {
    return <ErrorNotice message={error} copyText={error} action={<Button type="button" variant="outline" size="xs" onClick={onRetry}>{t('Retry')}</Button>} />;
  }
  if (!response) return <RailRowsPlaceholder count={4} mark="square" label={t('Loading…')} />;
  const partialLine = response.partial ? readFailureLine({ partial: [t('Projects')] }) : null;
  const groups = response.projects
    .map((project) => ({ project, tasks: project.tasks.filter((task) => task.status !== 'proposed' && taskPassesTaskFilter(task, filter)) }))
    .filter((group) => group.tasks.length > 0);
  return (
    <>
      {partialLine && (
        <ErrorNotice role="status" message={partialLine} action={<Button type="button" variant="outline" size="xs" onClick={onRetry}>{t('Retry')}</Button>} />
      )}
      {error && <ErrorNotice message={error} copyText={error} />}
      {groups.map(({ project, tasks }) => {
        const subject: CrmSubject = { id: project.id, kind: 'project', title: project.title?.trim() || t('Untitled'), subtitle: project.status };
        return <ProjectTaskGroup key={project.id} subject={subject} onOpen={() => onOpenProject(subject)}>{tasks.map((task) => row(task, subject))}</ProjectTaskGroup>;
      })}
      {groups.length === 0 && <p className="lede">{response.projects.length === 0 ? t('Nothing here.') : t('Nothing matches.')}</p>}
    </>
  );
}

/** One project's header and rows: the chevron folds it (remembered per project), the title opens the project. */
function ProjectTaskGroup({ subject, onOpen, children }: { subject: CrmSubject; onOpen: () => void; children: ReactNode }) {
  const [folded, toggle] = useRailFold(`work.organization.byProject.${subject.id}`);
  const id = `work-by-project-${subject.id}`;
  return (
    <Collapsible asChild open={!folded} onOpenChange={toggle}>
      <section className="mb-3" aria-labelledby={id}>
        <h3 id={id} className="m-0 mb-1 flex min-h-[30px] items-center gap-1 text-xs font-medium tracking-[0.08em] uppercase">
          <CollapsibleTrigger
            aria-label={folded ? t('Show {title}', { title: subject.title }) : t('Hide {title}', { title: subject.title })}
            className="inline-flex cursor-pointer items-center rounded-md border-0 bg-transparent p-1 text-muted-foreground hover-lift hover:text-foreground"
          >
            <span className="inline-flex transition-transform duration-100 in-data-[state=closed]:-rotate-90 motion-reduce:transition-none" aria-hidden="true"><ChevronIcon /></span>
          </CollapsibleTrigger>
          <Button variant="ghost" size="sm" onClick={onOpen} className="h-auto min-w-0 justify-start truncate px-0 py-1 pr-2.5 text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase hover:text-foreground">
            {subject.title}
          </Button>
        </h3>
        <CollapsibleContent>
          <ul className={railListClass} aria-label={subject.title}>{children}</ul>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function SubjectTaskReader({ task, subject, goalTitle, onBack, onComplete, onEdit, onMove, onAccept, onDecline, onDelete, onOpenLine }: {
  task: CrmTask;
  subject: CrmSubject;
  goalTitle?: string | null;
  onOpenLine: (line: ThreadMessage) => void;
  onBack: () => void;
  onComplete: () => void;
  onEdit?: () => void;
  onMove?: (subject: DocsSubject) => void;
  onAccept?: () => void;
  onDecline?: () => void;
  onDelete?: () => void;
}) {
  return (
    <TaskReader
      title={task.title}
      backLabel="Back to Tasks"
      status={task.status}
      dueDate={task.due_date}
      subjectContent={subjectDisplayTitle(subject)}
      responsible={task.responsible_party}
      assigneeName={task.assignee_name}
      goalTitle={goalTitle}
      updatedAt={task.updated_at}
      notes={task.notes}
      githubOwner={task.github_owner}
      githubRepo={task.github_repo}
      githubIssueNumber={task.github_issue_number}
      onBack={onBack}
      onComplete={onComplete}
      onEdit={onEdit}
      onMove={onMove}
      onAccept={onAccept}
      onDecline={onDecline}
      onDelete={onDelete}
      activity={task.status === 'proposed' ? undefined : <CardActivity refKind="task" refId={task.id} onOpenLine={onOpenLine} />}
    />
  );
}

function MineTaskReader({ task, record, loading, subject, onBack, onOpenSubject, onComplete, onEdit, onMove, onDelete, onOpenLine }: {
  onOpenLine: (line: ThreadMessage) => void;
  task: CrmMyTask;
  record: CrmTask | null;
  loading: boolean;
  subject: CrmSubject | null;
  onBack: () => void;
  onOpenSubject?: () => void;
  onComplete: () => void;
  onEdit?: () => void;
  onMove?: (subject: DocsSubject) => void;
  onDelete?: () => void;
}) {
  const subjectContent = subject && onOpenSubject ? (
    <Button type="button" variant="link" className={cn('h-auto font-normal whitespace-normal', readerLinkClass)} onClick={onOpenSubject}>
      {subjectDisplayTitle(subject)}
    </Button>
  ) : (
    subject?.title ?? task.subject_title ?? taskWhere(task).label
  );

  return (
    <TaskReader
      title={task.title}
      backLabel="Back to Mine"
      status={record?.status ?? task.status}
      dueDate={record?.due_date ?? task.due_date}
      subjectContent={subjectContent}
      responsible={record?.responsible_party}
      assigneeName={record?.assignee_name}
      updatedAt={task.updated_at}
      notes={record?.notes}
      githubOwner={record?.github_owner ?? task.github_owner}
      githubRepo={record?.github_repo ?? task.github_repo}
      githubIssueNumber={record?.github_issue_number ?? task.github_issue_number}
      loading={loading}
      emptyMessage={!loading && !record
        ? subject
          ? t('This task is no longer in the subject’s open task list.')
          : t('Showing the task summary. This task has no subject to load full details from.')
        : null}
      onBack={onBack}
      onComplete={onComplete}
      onEdit={onEdit}
      onMove={onMove}
      onDelete={onDelete}
      activity={<CardActivity refKind="task" refId={task.id} onOpenLine={onOpenLine} />}
    />
  );
}

/** The team member id of `email`, or null when the list does not hold them. */
function memberIdOf(team: CrmTeamMember[], email: string | null): string | null {
  if (!email) return null;
  const wanted = email.toLowerCase();
  return team.find((member) => member.email?.toLowerCase() === wanted)?.id ?? null;
}

/// The editors below read in the detail column, where a task and an
/// issue read — never over the page (the site has no modals). Escape
/// inside the form cancels (`cancelOnEscape`); the page's own Escape
/// stands down while an editor is up.

function TaskEditor({ task, where, team, teamError, me, goals, onCancel, onSave }: {
  task: CrmTask | null;
  /** Where the task lives, read-only; Move to… is how it changes. */
  where: { label: string; href: string | null };
  team: CrmTeamMember[];
  teamError: string;
  /** The signed-in member's address: a new task starts as theirs. */
  me: string | null;
  /** The project's live goals, and the one this task already serves. Empty off a project. */
  goals: CrmGoal[];
  onCancel: () => void;
  onSave: (draft: TaskDraft) => void;
}) {
  const [draft, setDraft] = useState<TaskDraft>(() => ({
    title: task?.title ?? '',
    notes: task?.notes ?? '',
    status: task?.status ?? 'pending',
    // Most work a meeting produces is ours, so a new task starts there — and
    // that is what puts the assignee in front of somebody.
    responsible_party: task?.responsible_party ?? 'team',
    assigned_to: task ? task.assignee_id : memberIdOf(team, me),
    due_date: dayValue(task?.due_date ?? null),
    goal_id: task?.goal_id ?? null,
  }));
  // A new task is the creator's. The team list can land after
  // the editor opens; it fills the assignee then, unless one was chosen.
  const assigneeChosen = useRef(false);
  useEffect(() => {
    if (task || assigneeChosen.current) return;
    const mine = memberIdOf(team, me);
    if (mine) setDraft((current) => (current.assigned_to === null && current.responsible_party === 'team' ? { ...current, assigned_to: mine } : current));
  }, [task, team, me]);

  const canSave = draft.title.trim().length > 0;

  return (
    <section className="mt-2" aria-label={task ? 'Edit task' : 'New task'}>
      <SheetCard
        title={task ? t('Edit task') : t('New task')}
        onSubmit={(event) => { event.preventDefault(); if (canSave) onSave(draft); }}
        onKeyDown={cancelOnEscape(onCancel)}
      >
        <p className="m-0 text-xs text-muted-foreground" data-testid="task-where">
          <span>{t('Where')}: </span>
          {where.href
            ? <a className={readerLinkClass} href={where.href}>{where.label}</a>
            : <span className="text-foreground">{where.label}</span>}
        </p>
        <SheetField label={t('Title')}>
          <Input
            value={draft.title}
            autoFocus
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
        </SheetField>
        <SheetField label={t('Notes')}>
          <Textarea
            rows={3}
            value={draft.notes}
            onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
          />
        </SheetField>
        <SheetField label={t('Due date')}>
          <DatePicker value={draft.due_date} onChange={(day) => setDraft({ ...draft, due_date: day })} />
        </SheetField>
        {goals.length > 0 && (
          <SearchablePicker
            label={t('Goal')}
            placeholder={t('None')}
            options={[
              { id: '', title: t('None') },
              ...goals.map((goal) => ({ id: goal.id, title: goal.title })),
            ]}
            value={draft.goal_id ?? ''}
            onChange={(value) => setDraft({ ...draft, goal_id: value || null })}
            emptyMessage={t('No options match that search.')}
          />
        )}
        <SheetField label={t('Status')}>
          <NativeSelect
            value={draft.status}
            onChange={(event) => setDraft({ ...draft, status: event.target.value as CrmTask['status'] })}
          >
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>
            ))}
          </NativeSelect>
        </SheetField>
        <SheetField label={t('Responsible')}>
          <NativeSelect
            value={draft.responsible_party}
            onChange={(event) => {
              const party = event.target.value as CrmTask['responsible_party'];
              // A task the client owes cannot also be owed by one of us.
              setDraft({ ...draft, responsible_party: party, assigned_to: party === 'team' ? draft.assigned_to : null });
            }}
          >
            {Object.entries(RESPONSIBLE_LABEL).map(([value, label]) => (
              <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>
            ))}
          </NativeSelect>
        </SheetField>
        {draft.responsible_party === 'team' && (
          team.length > 0 ? (
            <SearchablePicker
              label={t('Assignee')}
              placeholder={t('Nobody yet')}
              options={[
                { id: '', title: t('Nobody yet') },
                // People, then the agents that can hold work, under their own heading.
                ...team.filter((member) => member.kind !== 'agent').map((member) => ({ id: member.id, title: member.name })),
                ...team.filter((member) => member.kind === 'agent').map((member) => ({ id: member.id, title: member.name, group: t('Agents') })),
              ]}
              value={draft.assigned_to ?? ''}
              onChange={(value) => { assigneeChosen.current = true; setDraft({ ...draft, assigned_to: value || null }); }}
              emptyMessage={t('No options match that search.')}
            />
          ) : (
            <ErrorNotice message={teamError || t('Couldn’t load the team.')} />
          )
        )}
        <SheetActions>
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('Cancel')}
          </Button>
          <Button type="submit" disabled={!canSave}>{t('Save')}</Button>
        </SheetActions>
      </SheetCard>
    </section>
  );
}

/** The five checks' names, localized; the keys are Core's. */
function leadQualificationLabel(key: LeadQualificationKey): string {
  switch (key) {
    case 'budget_availability': return t('Budget Availability');
    case 'event_timeline': return t('Event Timeline');
    case 'previous_engagement': return t('Previous Engagement');
    case 'project_fit': return t('Project Fit');
    case 'stakeholder_buy_in': return t('Stakeholder Buy In');
  }
}

/** "3/5 qualified" beside a lead's name; the title says which checks are set. */
function LeadQualificationSummary({ characteristics }: { characteristics: Record<string, boolean> | null | undefined }) {
  const { done, total } = leadQualificationCount(characteristics);
  const checks = leadQualification(characteristics);
  const set = LEAD_QUALIFICATION_KEYS.filter((key) => checks[key]).map(leadQualificationLabel).join(', ');
  return (
    <span className="flex-none text-sm font-normal text-muted-foreground" title={set || undefined}>
      {t('{done}/{total} qualified', { done: String(done), total: String(total) })}
    </span>
  );
}

/** What the Worker refused in a subject form: a sentence, and the body key it is about. */
type SubjectRefusal = { message: string; field: string | null };

function SubjectEditor({ kind, detail, subject, refusal = null, onCancel, onSave }: {
  kind: SubjectKind;
  refusal?: SubjectRefusal | null;
  detail: CrmSubjectDetail | null;
  // `detail` is also non-null for a prefilled *new* lead ("Start a lead"
  // from the inbox) — `subject` is null there and only there, so it is
  // `subject`, not `detail`, that says whether this sheet is editing
  // something that already exists.
  subject: CrmSubject | null;
  onCancel: () => void;
  onSave: (draft: SubjectDraft) => void;
}) {
  const [draft, setDraft] = useState<SubjectDraft>(() => ({
    kind,
    title: detail?.title ?? '',
    status: detail?.status ?? SUBJECT_STATUS_CHOICES[kind === 'project' ? 'project' : 'lead'].defaultStatus,
    start_date: detail?.start_date?.slice(0, 10) ?? (kind === 'lead' ? new Date().toISOString().slice(0, 10) : ''),
    end_date: detail?.end_date?.slice(0, 10) ?? '',
    description: detail?.description ?? '',
    url: detail?.url ?? '',
    notes: detail?.notes ?? '',
    organization_id: detail?.organization_id ?? '',
    contact_id: detail?.contact_id ?? null,
    contact_ids: detail?.contact_ids ?? [],
    characteristics: { ...(detail?.characteristics ?? {}) },
  }));

  const [organizationOptions, setOrganizationOptions] = useState<SearchablePickerOption[]>(() => {
    const id = detail?.organization_id;
    if (!id) return [];
    return [{ id, title: detail.organization_name?.trim() || detail.subtitle?.trim() || id }];
  });
  const searchOrganizations = useCallback(async (query: string) => {
    const matches = (await searchCrmOrganizations(query)).map(({ id, name }) => ({ id, title: name }));
    setOrganizationOptions((current) => {
      const byID = new Map(current.map((option) => [option.id, option]));
      for (const option of matches) byID.set(option.id, option);
      return [...byID.values()];
    });
    return matches;
  }, []);
  const createOrganization = useCallback(async (name: string) => {
    const created = await createCrmOrganization(name);
    const option = { id: created.id, title: created.name };
    setOrganizationOptions((current) => [...current.filter((item) => item.id !== option.id), option]);
    return option;
  }, []);

  // Both take an organization; only a lead needs one. What a
  // form requires is FORM_FIELDS'; an edit keeps a blank the record had.
  const hasOrganization = kind === 'project' || kind === 'lead';
  const form = kind === 'project' ? 'project' : 'lead';
  const lacking = subject && !subject.organization_id ? ['organization'] : [];
  const canSave = !missingFormField(form, {
    title: draft.title,
    organization: draft.organization_id,
    ...(form === 'lead' ? { startDate: draft.start_date } : {}),
  }, lacking);
  const statuses = SUBJECT_STATUS_CHOICES[form].statuses;
  // The refusal reads under the field it names; one this sheet does not draw reads above Save.
  const drawn = ['title', 'status', 'startDate', ...(hasOrganization ? ['organization', 'contact', 'contacts'] : []),
    ...(kind === 'project' ? ['endDate', 'url', 'description'] : ['characteristics', 'notes'])];
  const refusedID = refusal?.field ? FORM_FIELDS[form].find((spec) => spec.wire === refusal.field && drawn.includes(spec.id))?.id ?? null : null;
  const problem = (id: string | null) => (refusal && refusedID === id
    ? <ErrorNotice inline className="text-xs" message={refusal.message} />
    : null);

  return (
    <section className="mt-2" aria-label={subject ? `Edit ${kind}` : `New ${kind}`}>
      <SheetCard
        title={subject ? t('Edit {kind}', { kind }) : t('New {kind}', { kind })}
        onSubmit={(event) => { event.preventDefault(); if (canSave) onSave(draft); }}
        onKeyDown={cancelOnEscape(onCancel)}
      >
        <SheetField label={fieldCaption(form, 'title')}>
          <Input
            value={draft.title}
            autoFocus
            {...fieldProps(form, 'title')}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
          />
        </SheetField>
        {problem('title')}
        <SheetField label={fieldCaption(form, 'status')}>
          <NativeSelect
            value={draft.status}
            onChange={(event) => setDraft({ ...draft, status: event.target.value })}
          >
            {statuses.map((value) => <NativeSelectOption key={value} value={value}>{subjectStatusLabel(value)}</NativeSelectOption>)}
          </NativeSelect>
        </SheetField>
        {problem('status')}
        {hasOrganization && (
          <SearchablePicker
            label={fieldCaption(form, 'organization')}
            placeholder={t('Search organizations')}
            options={organizationOptions}
            value={draft.organization_id}
            onChange={(organization_id) => setDraft({ ...draft, organization_id })}
            emptyMessage={t('No organizations match.')}
            onSearch={searchOrganizations}
            onCreate={createOrganization}
          />
        )}
        {problem('organization')}
        {/* Put a contact on a lead or a project (meet#307, meet#947). */}
        {hasOrganization && (
          <SubjectContactsField
            multiple={kind === 'project'}
            value={kind === 'project' ? draft.contact_ids ?? [] : draft.contact_id ? [draft.contact_id] : []}
            onChange={(ids) => setDraft(kind === 'project' ? { ...draft, contact_ids: ids } : { ...draft, contact_id: ids[0] ?? null })}
          />
        )}
        {problem(kind === 'project' ? 'contacts' : 'contact')}
        <SheetField label={fieldCaption(form, 'startDate')}>
          <DatePicker value={draft.start_date} onChange={(day) => setDraft({ ...draft, start_date: day })} />
        </SheetField>
        {problem('startDate')}
        {kind === 'project' && (
          <>
            <SheetField label={fieldCaption('project', 'endDate')}>
              <DatePicker value={draft.end_date} onChange={(day) => setDraft({ ...draft, end_date: day })} />
            </SheetField>
            {problem('endDate')}
            {/* Text, not type="url": a bare host is sent with https://, as on the Mac and the phone. */}
            <SheetField label={fieldCaption('project', 'url')}>
              <Input
                inputMode="url"
                autoCapitalize="off"
                spellCheck={false}
                value={draft.url}
                placeholder="https://…"
                onChange={(event) => setDraft({ ...draft, url: event.target.value })}
              />
            </SheetField>
            {problem('url')}
            <SheetField label={fieldCaption('project', 'description')}>
              <Textarea
                rows={4}
                value={draft.description}
                {...fieldProps('project', 'description')}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
              />
            </SheetField>
            {problem('description')}
          </>
        )}
        {kind === 'lead' && (
          <SheetField label={fieldCaption('lead', 'characteristics')}>
            <div role="group" aria-label={t('Qualification')} className="grid gap-2">
              {LEAD_QUALIFICATION_CHECKS.map((check) => (
                <Label key={check.key} className="flex items-center gap-2 text-sm text-foreground font-normal leading-normal">
                  <Checkbox
                    checked={draft.characteristics?.[check.key] === true}
                    onCheckedChange={(checked) => setDraft({
                      ...draft,
                      characteristics: mergeLeadQualification(draft.characteristics, { [check.key]: checked === true }),
                    })}
                  />
                  {leadQualificationLabel(check.key)}
                </Label>
              ))}
            </div>
          </SheetField>
        )}
        {kind === 'lead' && (
          <SheetField label={fieldCaption('lead', 'notes')}>
            <Textarea
              rows={4}
              value={draft.notes}
              {...fieldProps('lead', 'notes')}
              onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
            />
          </SheetField>
        )}
        {kind === 'lead' && problem('notes')}
        {kind === 'lead' && problem('characteristics')}
        {problem(null)}
        <SheetActions>
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('Cancel')}
          </Button>
          <Button type="submit" disabled={!canSave}>{t('Save')}</Button>
        </SheetActions>
      </SheetCard>
    </section>
  );
}

/**
 * Win on a lead (ADR 0008 decisions 6 and 7): the project's title, then the
 * lead's open tasks, each checked to move. No open tasks, no task group.
 */
function LeadWinSheet({ lead, onCancel, onWin }: {
  lead: CrmSubject;
  onCancel: () => void;
  onWin: (input: { title: string; task_ids: string[] }) => Promise<void>;
}) {
  const [title, setTitle] = useState(lead.title);
  const [tasks, setTasks] = useState<CrmTask[]>([]);
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    fetchTasks(lead)
      .then((rows) => {
        if (!live) return;
        const open = rows.filter((task) => (OPEN_TASK_STATUSES as readonly string[]).includes(task.status));
        setTasks(open);
        setChecked(new Set(open.map((task) => task.id)));
      })
      // No list: Win still starts the project; the tasks stay on the lead.
      .catch(() => undefined);
    return () => { live = false; };
  }, [lead]);

  const canWin = title.trim().length > 0 && !busy;

  return (
    <section className="mt-2" aria-label={t('Win…')}>
      <SheetCard
        title={t('Win {title}', { title: subjectDisplayTitle(lead) })}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canWin) return;
          setBusy(true);
          void onWin({ title: title.trim(), task_ids: tasks.filter((task) => checked.has(task.id)).map((task) => task.id) })
            .finally(() => setBusy(false));
        }}
        onKeyDown={cancelOnEscape(onCancel)}
      >
        <SheetField label={t('Project')}>
          <Input value={title} autoFocus onChange={(event) => setTitle(event.target.value)} />
        </SheetField>
        {tasks.length > 0 && (
          <SheetField label={t('Tasks')}>
            <div role="group" aria-label={t('Tasks')} className="grid gap-2">
              {tasks.map((task) => (
                <Label key={task.id} className="flex items-center gap-2 text-sm text-foreground font-normal leading-normal">
                  <Checkbox
                    checked={checked.has(task.id)}
                    onCheckedChange={(value) => setChecked((current) => {
                      const next = new Set(current);
                      if (value === true) next.add(task.id); else next.delete(task.id);
                      return next;
                    })}
                  />
                  {task.title}
                </Label>
              ))}
            </div>
          </SheetField>
        )}
        <SheetActions>
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('Cancel')}
          </Button>
          <Button type="submit" disabled={!canWin}>{t('Win')}</Button>
        </SheetActions>
      </SheetCard>
    </section>
  );
}

/** A partner's or an event's page: a few short blocks, each under a plan heading. */
const detailPageClass = '[&_section]:mt-[18px] [&_section_p]:mt-1.5 [&_section_p]:mb-0';
/** The page's lede, at the blocks' rhythm. */
const detailLedeClass = 'mt-1.5 mb-0 max-w-[42rem] text-lg leading-normal font-light text-foreground/70';

/** Soonest first; undated drafts last, as docs/EVENTS.md has them. */
function sortEventsByDate(rows: CrmSubject[]): CrmSubject[] {
  return [...rows].sort((a, b) => {
    const aDate = a.event_date ?? '';
    const bDate = b.event_date ?? '';
    if (aDate && bDate && aDate !== bDate) return aDate < bDate ? -1 : 1;
    if (Boolean(aDate) !== Boolean(bDate)) return aDate ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

/**
 * An event's own page (docs/EVENTS.md): when and where, who hosts
 * it, the sign-up link, and the projects that link to it. Read-only on
 * purpose; an event is a CMS row, edited under Website in Core.
 */
function EventDetail({
  subject,
  workEvent,
  detail,
  error,
  onOpen,
}: {
  subject: CrmSubject;
  /** The event as Work's own form keeps it, when this store edits it here. */
  workEvent: WorkEvent | null;
  detail: CrmSubjectDetail | null;
  error: string;
  onOpen: (subject: CrmSubject) => void;
}) {
  if (error) return <ErrorNotice message={error} />;
  if (!detail) return <PlaceholderRows glyph={false} label={t('Loading event…')} />;
  const phase = eventPhaseLabel(eventPhase(detail.event_date ?? subject.event_date, Date.now()));
  const when = detail.event_date
    ? new Date(`${detail.event_date}T12:00:00`).toLocaleDateString(dateLocale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : t('No date yet');
  const where = [detail.place?.trim(), detail.location?.trim()].filter(Boolean).join(', ');
  const projects = detail.related?.projects ?? [];
  return (
    <div className={detailPageClass}>
      <p className={detailLedeClass}>{[phase, when, where].filter(Boolean).join(' · ')}</p>
      {workEvent?.public_url && (
        <section aria-labelledby="work-event-signup">
          <PlanHead id="work-event-signup">{t('Sign-up page')}</PlanHead>
          <p className="flex flex-wrap items-center gap-2 [overflow-wrap:anywhere]">
            <a href={workEvent.public_url} target="_blank" rel="noreferrer">{workEvent.public_url}</a>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(workEvent.public_url!).then(
                  () => toast(t('Link copied')),
                  () => toast(t('Couldn’t copy the link.')),
                );
              }}
            >
              {t('Copy link')}
            </Button>
          </p>
        </section>
      )}
      {hasEventAbout(detail) && (
        <section aria-labelledby="work-event-about">
          <PlanHead id="work-event-about">{t('About')}</PlanHead>
          <EventAbout detail={detail} title={subject.title} />
        </section>
      )}
      {/* The event is the project in practice; a linked delivery project is the exception. */}
      {projects.length > 0 && (
        <section aria-labelledby="work-event-projects">
          <PlanHead id="work-event-projects">{t('Projects')}</PlanHead>
          <ul className={railListClass}>
            {projects.map((row) => {
              const target: CrmSubject = { id: row.id, kind: 'project', title: row.title?.trim() || t('Untitled'), subtitle: row.status };
              return <RailRow key={row.id} title={target.title} subtitle={row.status ?? undefined} onSelect={() => onOpen(target)} />;
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The web counterpart to the Mac subject inspector. */
function WorkSubjectContextPanel({ subject, detail, detailError, peers, inboundAddress, onMessage, tasks, onMakeResponsible }: {
  subject: CrmSubject;
  detail: CrmSubjectDetail | null;
  detailError: string;
  peers: PeersResponse['peers'] | null;
  /** The channel's forwarding address, once its conversation has been opened. */
  inboundAddress: string | null;
  onMessage: (email: string) => void;
  /** The subject's tasks, for the suggested responsible person. */
  tasks: CrmTask[];
  /** On a project or lead: choose who answers for it (docs/OWNERSHIP.md). */
  onMakeResponsible: (email: string) => void;
}) {
  const responsible = responsibleOf(subject, tasks);
  const canChoose = subject.kind === 'project' || subject.kind === 'lead';
  const workLines = [plural(subject.open_tasks ?? 0, { one: '{count} open task', other: '{count} open tasks' })];
  if ((subject.overdue_tasks ?? 0) > 0) workLines.push(t('{count} overdue', { count: subject.overdue_tasks ?? 0 }));
  if (subject.kind === 'project') {
    workLines.push(subject.has_repo ? t('Repository linked') : t('No repository linked'));
  }
  const dateRange = [detail?.start_date, detail?.end_date].map((day) => formatDay(day)).filter(Boolean).join(' – ');
  const aboutLines = detail ? [
    detail.industry?.trim(),
    detail.status?.trim(),
    dateRange,
    subject.kind === 'project' || subject.kind === 'organization' ? detail.url?.trim() : undefined,
    (subject.kind === 'project' || subject.kind === 'organization' ? detail.description : detail.notes)?.trim(),
  ].filter((line): line is string => Boolean(line)) : [];

  // An event's facts (docs/EVENTS.md): when, where, the links, and whether the website lists it.
  const eventDay = detail?.event_date ?? subject.event_date;
  const whenLines: string[] = [];
  if (eventDay) {
    whenLines.push(new Date(`${eventDay}T12:00:00`).toLocaleDateString(dateLocale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
  } else {
    whenLines.push(t('No date yet'));
  }
  const startAt = detail?.start_at ? new Date(detail.start_at) : null;
  if (startAt && !Number.isNaN(startAt.valueOf())) {
    whenLines.push([formatTime(startAt, { timeZone: detail?.timezone ?? undefined }), detail?.timezone].filter(Boolean).join(' '));
  }
  const whereLines = [detail?.place, detail?.location].map((line) => line?.trim()).filter((line): line is string => Boolean(line));
  const linkLines = [
    detail?.url?.trim(),
    detail?.partner?.trim() ? [detail.partner.trim(), detail.partner_url?.trim()].filter(Boolean).join(' · ') : undefined,
  ].filter((line): line is string => Boolean(line));
  const published = detail?.published ?? subject.published;
  // An organization's relationship is what its records say (ADR 0006); a project's or lead's is its organization.
  const relationshipLine = subject.kind === 'organization'
    ? organizationRelationshipsLine(detail?.relationships)
    : subject.organization_name;

  // One table says which blocks, and in what order (`subject-context`); this says what each draws.
  const drawn: Record<SubjectContextBlock, ReactNode> = {
    // The team block draws TEAM and AGENTS together.
    team: (
      <ConversationTeamBlock
        team={peers ? subjectTeam(subject.agent_email, peers, responsible) : null}
        now={Date.now()}
        onMessage={onMessage}
        onMakeResponsible={canChoose ? (peer) => onMakeResponsible(peer.email) : undefined}
        chosenResponsible={responsible?.source === 'chosen' ? responsible.email : null}
      />
    ),
    agents: null,
    when: <InspectorGroup title={t('WHEN')}>{whenLines.map((line) => <p key={line}>{line}</p>)}</InspectorGroup>,
    where: whereLines.length > 0 ? <InspectorGroup title={t('WHERE')}>{whereLines.map((line) => <p key={line}>{line}</p>)}</InspectorGroup> : null,
    links: linkLines.length > 0 ? <InspectorGroup title={t('LINKS')}>{linkLines.map((line) => <p key={line} className="[overflow-wrap:anywhere]">{line}</p>)}</InspectorGroup> : null,
    website: published === undefined || published === null ? null : (
      <InspectorGroup title={t('WEBSITE')}><p>{published ? t('Listed') : t('Not listed yet')}</p></InspectorGroup>
    ),
    work: (
      <InspectorGroup title={t('WORK')}>
        {workLines.map((line) => <p key={line}>{line}</p>)}
      </InspectorGroup>
    ),
    goals: null,
    relationship: relationshipLine ? (
      <InspectorGroup title={t('RELATIONSHIP')}>
        <p>{relationshipLine}</p>
      </InspectorGroup>
    ) : null,
    about: (aboutLines.length > 0 || detailError || !detail) ? (
      <InspectorGroup title={t('ABOUT')}>
        {detailError ? <ErrorNotice message={detailError} /> : detail
          ? aboutLines.map((line) => <p key={line}>{line}</p>)
          : <PlaceholderRows count={2} glyph={false} label={t('Loading details…')} />}
      </InspectorGroup>
    ) : null,
    email: inboundAddress ? (
      <InspectorGroup title={t('EMAIL')}>
        <p className="[overflow-wrap:anywhere]">{inboundAddress}</p>
      </InspectorGroup>
    ) : null,
  };

  return (
    <InspectorContext title={subject.title} subtitle={subject.subtitle ?? subjectKindLabel(subject)}>
      {subjectContextBlocks(subject.kind, 'web').map((block) => <Fragment key={block}>{drawn[block]}</Fragment>)}
    </InspectorContext>
  );
}

/**
 * A partner's own page (PARTNERS (HQ Docs)): what the relationship
 * is — industry, website, description — and what hangs off it: projects and
 * leads as rows that open their subject, contacts as names. Edit and Delete
 * write the organization on the subjects group's store.
 */
function PartnerDetail({
  subject,
  detail,
  error,
  onOpen,
  onOpenContact,
  onAddContact,
  onEdit,
  onMerge,
  onDelete,
}: {
  subject: CrmSubject;
  detail: CrmSubjectDetail | null;
  error: string;
  onOpen: (subject: CrmSubject) => void;
  onOpenContact: (contactID: string) => void;
  onAddContact: () => void;
  onEdit: () => void;
  onMerge: () => void;
  onDelete: () => void;
}) {
  if (error) return <ErrorNotice message={error} />;
  if (!detail) return <PlaceholderRows glyph={false} label={t('Loading organization…')} />;
  const industry = detail.industry?.trim() ?? '';
  const website = detail.url?.trim() ?? '';
  const description = detail.description?.trim() ?? '';
  const related = detail.related ?? { projects: [], leads: [], contacts: [] };
  const relatedRows = (rows: Array<{ id: string; title: string | null; status: string | null }>, kind: SubjectKind, empty: string) => (
    rows.length === 0
      ? <p className={detailLedeClass}>{empty}</p>
      : (
        <ul className={railListClass}>
          {rows.map((row) => {
            const target: CrmSubject = { id: row.id, kind, title: row.title?.trim() || t('Untitled'), subtitle: row.status };
            return <RailRow key={row.id} title={target.title} subtitle={row.status ?? undefined} onSelect={() => onOpen(target)} />;
          })}
        </ul>
      )
  );
  return (
    <div className={detailPageClass}>
      {subject.subtitle && <p className={detailLedeClass}>{subject.subtitle}</p>}
      <div className="flex gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onEdit}>{t('Edit organization')}</Button>
        <Button type="button" variant="secondary" size="sm" onClick={onMerge}>{t('Merge…')}</Button>
        <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={onDelete}>{t('Delete')}</Button>
      </div>
      {(industry || website || description) && (
        <section aria-labelledby="work-partner-about">
          <PlanHead id="work-partner-about">{t('About')}</PlanHead>
          {industry && <p>{industry}</p>}
          {website && <p><a href={website} target="_blank" rel="noreferrer">{website}</a></p>}
          {description && <p>{description}</p>}
        </section>
      )}
      <section aria-labelledby="work-partner-projects">
        <PlanHead id="work-partner-projects">{t('Projects')}</PlanHead>
        {relatedRows(related.projects, 'project', t('No projects with this organization yet.'))}
      </section>
      <section aria-labelledby="work-partner-leads">
        <PlanHead id="work-partner-leads">{t('Leads')}</PlanHead>
        {relatedRows(related.leads, 'lead', t('No open leads with this organization.'))}
      </section>
      {/* Its people (meet#947): each opens their page; Add contact files one here. */}
      <RailSection
        title={t('Contacts')}
        storageKey={`work.organization.${subject.id}.contacts`}
        count={related.contacts.length}
        empty={t('No contacts yet.')}
        accessory={(
          <Tip label={t('Add contact')}>
            <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label={t('Add contact')} onClick={onAddContact}><PlusIcon /></Button>
          </Tip>
        )}
      >
        <ul className={railListClass} aria-label={t('Contacts')}>
          {related.contacts.map((contact) => (
            <RailRow
              key={contact.id}
              title={contact.name?.trim() || contact.email || t('Unnamed')}
              subtitle={[contact.title, contact.email].filter(Boolean).join(' · ') || undefined}
              onSelect={() => onOpenContact(contact.id)}
            />
          ))}
        </ul>
      </RailSection>
    </div>
  );
}
