import { AttentionQuestionDialog } from './AttentionQuestionDialog';
import type { AttentionRequest } from '@starlings/contracts/attention';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/ui/button';
import { CalendarPlusIcon, CheckIcon, CircleQuestionMarkIcon, XIcon } from 'lucide-react';
import { CALENDAR_REFRESH_SECONDS } from '@starlings/contracts/limits';
import { homeModuleDraws, homeModuleRows, orderHomeInbox } from '@starlings/contracts/home-layout-values';
import { CalendarIcon, IssueStateIcon, MegaphoneIcon, TaskIcon } from './action-icons';
import { GlyphMark } from './SubjectMark';
import { TASK_ROW_EXIT_MS } from './WorkRows';
import { documentHref, issueHref, subjectHref, workSubjectOf } from './work-hrefs';
import { answerDecisionAsk, cancelTask, completeTask, decideProposedTask, dismissFollowUp, fetchInbox, promoteTask, fetchMyWork, planMine, setInboxItemDismissed, setIssueState, setSalesInboxDismissed, SNAPSHOT, type CrmIssue, type CrmMyTask, type MyWork, type PlannedRow } from './crm-work';
import { DropdownMenuItem } from '@/ui/dropdown-menu';
import { useRowMenu } from './use-row-menu';
import type { InboxForwardedItem, InboxInvitationItem, InboxItem, InboxResponse } from '@starlings/contracts/inbox';
import { inboxItemHref, inboxItemMeta, inboxItemsForHomeCard, retainQuestionInbox, myTaskHref, RSVPAnswerItems } from './inbox-rows';
import { markThreadRead, setThreadArchived, setThreadMuted, threadHref, threadLastSenderName, threadTitle, useUnreadMessages, type ThreadSummary } from './messages';
import { relativeTime, subscribePeers } from './team-presence';
import { plainPreview } from './markdown-parse';
import { refreshPoll, THREADS_POLL_KEY } from './shared-poll';
import { toast } from './Toast';
import { formatTime, formatDay } from './meeting-time';
import { loadSnapshot, saveSnapshot } from './snapshot-store';
import { HOME_SNAPSHOT } from './home-snapshots';
import {
  addPendingCalendarEvent,
  discardPendingCalendarEvent,
  fetchPublicEvents,
  respondToCalendarInvitation,
  CALENDAR_RSVP_CHOICES,
  type CalendarRSVP,
  type PublicCalendarEvent,
} from './owner-agenda';
import { MenuIcon } from './menu-icons';
import { plural, t, dateLocale } from './i18n';
import { HomeCard, HomeCardHead, HomeList, HomeMenuItem, HomeMore, HomeRow, HomeRowActions, HomeRowMark, HomeRowText, HomeRowUnreadMark, HomeRowWhen, homeRowMenuOptions } from './HomeModule';
import { CopyEmailItem, CopyLinkItem, coreSubjectDoor, coreTaskDoor, MenuGroups, OpenItem, RowMenuItems, StarItem } from './row-menu-items';
import { updateDocsAnnotation } from './docs';
import { DecisionAnswerItems } from './decision-menu';
import { useForegroundPoll } from './use-foreground-poll';
import { ErrorNotice } from './ErrorNotice';
import { dateSection, stageOf, type WorkStage } from '@starlings/contracts/work-items';
import { CRM_TASK_STATUS_LABELS, type CrmTaskStatusId } from '@starlings/contracts/task-values';
import { IssueMenuItems } from './task-row-menu';

/**
 * Home's published events, Inbox and Work modules. Same rows, same order
 * and the same words as the Mac launch card and the iOS Home tab, so the
 * three surfaces draw one Home (`fixtures/home-layout.json`). Each hides itself when it has nothing to
 * say — an empty "all clear" card is furniture.
 */

const REFRESH_MS = CALENDAR_REFRESH_SECONDS * 1_000;
function waitForTaskRowExit(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, TASK_ROW_EXIT_MS));
}

// MARK: Published events

function publicEventSchedule(event: PublicCalendarEvent): string {
  const day = new Date(`${event.date}T12:00:00`).toLocaleDateString(dateLocale, {
    month: 'short',
    day: 'numeric',
  });
  const time = event.is_all_day || !event.starts_at ? null : formatTime(new Date(event.starts_at));
  return [day, time, event.location?.trim() || null].filter(Boolean).join(' · ');
}

/** Company-wide CMS events, kept separate from the owner's Google agenda. */
export function OwnerHomeEvents() {
  // Last known first (docs/CACHING.md): the fetchers keep each answer, and
  // every card here starts from it rather than from nothing.
  const [events, setEvents] = useState(() => (loadSnapshot<PublicCalendarEvent[]>(HOME_SNAPSHOT.publicEvents)?.value ?? [])
    // A saved list can be days old: an event whose day has passed is not shown.
    .filter((event) => Date.parse(`${event.date}T23:59:59`) >= Date.now()));
  // A published event's door is its sign-up page; one without has no menu.
  const menu = useRowMenu(homeRowMenuOptions);

  useForegroundPoll(async () => {
    try {
      const next = await fetchPublicEvents();
      saveSnapshot(HOME_SNAPSHOT.publicEvents, next);
      setEvents(next);
    } catch {
      // A public-feed outage folds the optional card; it must not turn Home
      // into an error surface or erase the owner's calendar cards.
    }
  });

  if (!homeModuleDraws('events', events.length > 0)) return null;
  const listed = events.slice(0, homeModuleRows('events'));

  return (
    <HomeCard aria-label={t('Events')}>
      <HomeCardHead title={t('Events')} />
      <HomeList>
        {listed.map((event) => {
          const content = (
            <>
              <HomeRowMark aria-hidden="true"><GlyphMark size={24} shape="round"><MegaphoneIcon /></GlyphMark></HomeRowMark>
              <HomeRowText title={event.title || t('Event')} detail={publicEventSchedule(event)} />
            </>
          );
          const items = event.signup_url
            ? <MenuGroups groups={[[<OpenItem key="open" href={event.signup_url} external />, <CopyLinkItem key="copy" href={event.signup_url} />]]} />
            : null;
          return (
            <HomeMenuItem key={event.id} menu={menu} id={event.id} items={items}>
              {event.signup_url ? (
                <HomeRow asChild>
                  <a data-home-row href={event.signup_url} target="_blank" rel="noreferrer noopener">
                    {content}
                  </a>
                </HomeRow>
              ) : (
                <HomeRow>{content}</HomeRow>
              )}
            </HomeMenuItem>
          );
        })}
      </HomeList>
      {events.length > listed.length && (
        <HomeMore>and {events.length - listed.length} more</HomeMore>
      )}
    </HomeCard>
  );
}

// MARK: Work

// A task Core kept without a subject opens on Mine, which is the one list
// that holds it — same rule the native launch cards follow.
const taskHref = myTaskHref;

function overdueLabel(task: CrmMyTask): string {
  const day = formatDay(task.due_date);
  return day ? `Overdue · ${day}` : t('Overdue');
}

/** Rows on the Work card: `rows` in fixtures/home-layout.json. */
const HOME_CARD_ROW_LIMIT = homeModuleRows('work');
/** Rows on the Inbox card. */
const HOME_INBOX_ROW_LIMIT = homeModuleRows('messages');

/** The RSVP buttons' icons, the same three the Mac and the phone draw. */
const RSVP_BUTTON_ICONS = { accepted: CheckIcon, tentative: CircleQuestionMarkIcon, declined: XIcon } as const satisfies Record<CalendarRSVP, unknown>;

/** A calendar row: answered in place, with buttons as well as the menu. */
type HomeCalendarItem = InboxInvitationItem | InboxForwardedItem;

/** One Inbox card row: an unread conversation, or an INBOX item. */
type HomeInboxRow =
  | { kind: 'thread'; key: string; at: number; thread: ThreadSummary }
  | { kind: 'item'; key: string; at: number; item: InboxItem };

/**
 * Home's INBOX card (module `messages`): what is new. Unread conversations
 * from the thread poll and every INBOX item but Quick Notes (their own
 * module). A calendar invitation, or an event from email, carries its
 * answers on the row: they are why it is here. Invitations, decisions and questions lead, in INBOX's
 * order (invitations first, the soonest event first); the rest is newest first
 * (`orderHomeInbox`, fixtures/home-layout.json). What you already own is the
 * Work card's. Mac: `renderInbox`; phone: `MobileHomeInboxCard`.
 */
export function OwnerHomeInbox() {
  const threads = useUnreadMessages(true);
  // A channel's row names who wrote its last line.
  const [roster, setRoster] = useState<ReadonlyArray<{ email: string; name: string | null }>>([]);
  useEffect(() => subscribePeers({ onValue: ({ peers }) => setRoster(peers) }), []);
  const senderLine = (thread: ThreadSummary, preview: string) => {
    const sender = threadLastSenderName(thread, roster);
    return sender ? `${sender}: ${preview}` : preview;
  };
  const [questionDialog, setQuestionDialog] = useState<AttentionRequest | null>(null);
  const [inbox, setInbox] = useState(() => {
    const saved = loadSnapshot<InboxResponse>(SNAPSHOT.inbox)?.value;
    return saved ? inboxItemsForHomeCard(saved.items) : [];
  });
  const [error, setError] = useState('');
  const loadRequestID = useRef(0);
  // The row's menu: the same decisions the Mac and the phone put on a Home
  // row (`WorkRowAction`), as far as the browser can carry them.
  const menu = useRowMenu(homeRowMenuOptions);

  const load = useCallback(async () => {
    const requestID = ++loadRequestID.current;
    try {
      const items = await fetchInbox();
      if (requestID !== loadRequestID.current) return;
      setInbox((current) => inboxItemsForHomeCard(retainQuestionInbox(current, items).items));
      if (items.partial.includes('question')) setError(t('Couldn’t load this question.'));
      else setError('');
    } catch {
      // A blip: the last known rows stand.
    }
  }, []);
  useForegroundPoll(load);

  // Re-render on a slow tick so "just now" becomes "1 minute ago" while the
  // page sits open — the same tick Today's countdowns run on.
  const hasThreads = threads.length > 0;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!hasThreads) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 30_000);
    return () => window.clearInterval(timer);
  }, [hasThreads]);

  /** One menu decision: close, do it, then re-read. */
  async function decide(run: () => Promise<unknown>, fallback: string) {
    menu.close();
    try {
      await run();
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
    }
    void load();
  }

  /**
   * Answer a calendar row. The row leaves at once; a failed write puts it
   * back and says why.
   */
  async function answerCalendar(item: HomeCalendarItem, send: () => Promise<unknown>) {
    menu.close();
    setInbox((current) => current.filter((row) => row.key !== item.key));
    try {
      await send();
      setError('');
    } catch (cause) {
      setInbox((current) => current.some((row) => row.key === item.key) ? current : [...current, item]);
      setError(cause instanceof Error ? cause.message : t('Couldn’t send your answer.'));
      return;
    }
    void load();
  }
  const rsvp = (item: InboxInvitationItem, response: CalendarRSVP) => { void answerCalendar(item, () => respondToCalendarInvitation(item.event, response)); };
  const addForwarded = (item: InboxForwardedItem) => { void answerCalendar(item, () => addPendingCalendarEvent(item.event.id)); };
  const discardForwarded = (item: InboxForwardedItem) => { void answerCalendar(item, () => discardPendingCalendarEvent(item.event.id)); };

  /** The row's answers as buttons. The first is the row for the arrow keys; Tab reaches the rest. */
  function calendarAnswers(item: HomeCalendarItem): ReactNode {
    if (item.source === 'forwarded') {
      return <>
        <Button type="button" variant="default" data-home-row onClick={() => addForwarded(item)}>
          <CalendarPlusIcon aria-hidden="true" />
          {t('Add')}
        </Button>
        <Button type="button" variant="secondary" onClick={() => discardForwarded(item)}>
          <XIcon aria-hidden="true" />
          {t('Discard')}
        </Button>
      </>;
    }
    return CALENDAR_RSVP_CHOICES.map((choice, index) => {
      const Icon = RSVP_BUTTON_ICONS[choice.response];
      return (
        <Button
          key={choice.response}
          type="button"
          variant={choice.response === 'accepted' ? 'default' : 'secondary'}
          data-home-row={index === 0 ? '' : undefined}
          onClick={() => rsvp(item, choice.response)}
        >
          <Icon aria-hidden="true" />
          {choice.title}
        </Button>
      );
    });
  }

  /** What an INBOX row can decide here; the rest opens Work. */
  function inboxMenu(item: InboxItem): ReactNode {
    const href = inboxItemHref(item);
    switch (item.source) {
      case 'task':
        return <RowMenuItems kind="task" context="inbox_proposed" preferDoor facts={{ hasSubject: true, hasCore: true }}
          run={{
            accept: () => { void decide(() => decideProposedTask(item.task.id, true), t('Couldn’t accept that task.')); },
            decline: () => { void decide(() => decideProposedTask(item.task.id, false), t('Couldn’t decline that task.')); },
          }} doors={{
            'open-subject': { href, label: t('Open {title}', { title: item.subject.title }) },
            'open-core': coreSubjectDoor(item.subject.kind, item.subject.id),
          }} />;
      case 'followup':
        return <RowMenuItems kind="inbox_followup" context="row" preferDoor
          run={{ dismiss: () => { void decide(() => dismissFollowUp(item), t('Couldn’t dismiss that follow-up.')); } }}
          doors={{ open: { href, label: t('Open') } }} />;
      case 'card':
        return <RowMenuItems kind="inbox_card" context="row" preferDoor facts={{ isIssue: !!item.issue }}
          doors={{
            open: { href, label: t('Open') },
            'open-subject': { href: subjectHref(item.subject), label: t('Open {title}', { title: item.subject.title }) },
            'open-github': item.issue ? { href: item.issue.url, external: true } : undefined,
          }} />;
      case 'sales':
        return <RowMenuItems kind="inbox_sales" context="row" facts={{ isDismissed: false, hasEmail: !!item.touch.contact.email }}
          run={{ dismiss: () => { void decide(() => setSalesInboxDismissed(item.touch.id, true), t('Couldn’t dismiss that.')); } }}
          render={{ 'copy-email': item.touch.contact.email ? () => <CopyEmailItem email={item.touch.contact.email!} /> : undefined }} />;
      case 'comment': {
        const subject = item.subject;
        return <RowMenuItems kind="inbox_comment" context="row" preferDoor facts={{ hasSubject: !!subject, hasCore: !!subject }}
          run={{
            resolve: () => { void decide(() => updateDocsAnnotation(item.thread.id, { status: 'resolved' }), t('Couldn’t change the comment.')); },
          }} doors={{
            'open-subject': subject ? { href, label: t('Open {title}', { title: subject.title }) } : undefined,
            'open-document': { href: documentHref(item.document.id), label: t('Open document') },
            'open-core': subject ? coreSubjectDoor(subject.kind, subject.id) : undefined,
          }} />;
      }
      case 'booking':
        return <RowMenuItems kind="inbox_booking" context="row" facts={{ hasEvent: item.change !== 'cancelled' && !!item.booking.google_event_id, hasEmail: !!item.booking.guest_email }}
          run={{ dismiss: () => { void decide(() => setInboxItemDismissed(item.key, true), t('Couldn’t dismiss that.')); } }} doors={{ 'open-calendar': item.change !== 'cancelled' && item.booking.google_event_id ? { href, label: t('Open in Calendar') } : undefined }}
          render={{ 'copy-email': () => <CopyEmailItem email={item.booking.guest_email} /> }} />;
      case 'invitation':
        return <RowMenuItems kind="inbox_invitation" context="row"
          doors={{ 'open-calendar': { href, label: t('Open in Calendar') } }}
          render={{ rsvp: () => <RSVPAnswerItems onAnswer={(response) => rsvp(item, response)} /> }} />;
      case 'forwarded':
        return <RowMenuItems kind="inbox_forwarded" context="row"
          run={{ accept: () => addForwarded(item), decline: () => discardForwarded(item) }}
          labels={{ accept: t('Add to calendar'), decline: t('Discard') }} />;
      case 'question':
        return <RowMenuItems kind="inbox_question" context="row" run={{ open: () => { menu.close(); setQuestionDialog(item.request); } }} labels={{ open: t('Open question') }} />;
      case 'decision':
        return <RowMenuItems kind="inbox_decision" context="row" preferDoor
          doors={{ open: { href, label: t('Open decision') } }}
          render={{ decide: () => <DecisionAnswerItems ask={item.ask} onAnswer={(option) => { void decide(() => answerDecisionAsk(item.ask.id, option), t('Couldn’t answer that decision.')); }} /> }} />;
      case 'interest':
      case 'submission':
        return <RowMenuItems kind="inbox_interest" context="row" facts={{ hasEmail: !!item.submission.email }}
          run={{ dismiss: () => { void decide(() => setInboxItemDismissed(item.key, true), t('Couldn’t dismiss that.')); } }}
          render={{ 'copy-email': () => <CopyEmailItem email={item.submission.email} /> }} />;
      case 'commercial':
        return <RowMenuItems kind="inbox_commercial" context="row" preferDoor facts={{ isDismissed: false }}
          run={{ dismiss: () => { void decide(() => setInboxItemDismissed(item.key, true), t('Couldn’t dismiss that.')); } }}
          doors={{ 'open-subject': { href, label: t('Open {title}', { title: item.subject.title }) } }} />;
      default:
        return <DropdownMenuItem asChild><a href={href}><MenuIcon name="open" />{t('Open Work')}</a></DropdownMenuItem>;
    }
  }

  const rows = orderHomeInbox<HomeInboxRow>([
    ...threads.map((thread) => ({ kind: 'thread' as const, key: `thread:${thread.id}`, at: thread.last_message_at ?? 0, thread })),
    ...inbox.map((item) => ({ kind: 'item' as const, key: item.key, at: item.at, item })),
  ], (row) => row.kind === 'item' && (row.item.source === 'invitation' || row.item.source === 'decision' || row.item.source === 'question'), (row) => row.at);
  if (!homeModuleDraws('messages', rows.length > 0) && !questionDialog) return null;
  // Three, then a count. A card that grows without limit stops being a signal
  // and becomes the list Work's INBOX already is.
  const listed = rows.slice(0, HOME_INBOX_ROW_LIMIT);

  return (
    <HomeCard aria-label={t('Inbox')}>
      <HomeCardHead title={t('Inbox')} count={plural(rows.length, { one: '{count} new', other: '{count} new' })} />
      <HomeList>
        {listed.map((row) => {
          if (row.kind === 'thread') {
            const thread = row.thread;
            return (
              <HomeMenuItem key={row.key} menu={menu} id={row.key} items={<HomeMessageMenuItems thread={thread} />}>
                <HomeRow asChild>
                  <a data-home-row href={threadHref(thread)}>
                    <HomeRowUnreadMark />
                    <HomeRowText
                      title={threadTitle(thread)}
                      detail={thread.last_message_preview ? senderLine(thread, plainPreview(thread.last_message_preview)) : undefined}
                      wrap="detail-2"
                    />
                    {thread.last_message_at !== null && (
                      <HomeRowWhen>{relativeTime(thread.last_message_at)}</HomeRowWhen>
                    )}
                  </a>
                </HomeRow>
              </HomeMenuItem>
            );
          }
          const item = row.item;
          const meta = inboxItemMeta(item);
          if (item.source === 'invitation' || item.source === 'forwarded') {
            return (
              <HomeMenuItem key={row.key} menu={menu} id={row.key} items={inboxMenu(item)}>
                <HomeRow>
                  <HomeRowMark aria-hidden="true"><GlyphMark size={24} shape={meta.shape}>{meta.symbol}</GlyphMark></HomeRowMark>
                  <HomeRowText title={meta.title} detail={meta.detail} />
                  <HomeRowActions>{calendarAnswers(item)}</HomeRowActions>
                </HomeRow>
              </HomeMenuItem>
            );
          }
          return (
            <HomeMenuItem key={row.key} menu={menu} id={row.key} items={inboxMenu(item)}>
              <HomeRow asChild>
                <a data-home-row href={inboxItemHref(item)} onClick={(event) => {
                  if (item.source === 'question' && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                    event.preventDefault(); setQuestionDialog(item.request);
                  }
                }}>
                  <HomeRowMark aria-hidden="true"><GlyphMark size={24} shape={meta.shape}>{meta.symbol}</GlyphMark></HomeRowMark>
                  <HomeRowText title={meta.title} detail={meta.detail} />
                </a>
              </HomeRow>
            </HomeMenuItem>
          );
        })}
      </HomeList>
      {rows.length > listed.length && (
        <HomeMore href="/work">{t('and {count} more in Work', { count: rows.length - listed.length })}</HomeMore>
      )}
      {error && <ErrorNotice message={error} />}
      {questionDialog && <AttentionQuestionDialog key={questionDialog.id} initial={questionDialog}
        onResolved={(request) => { setInbox((current) => current.filter((item) => item.key !== request.id)); void load(); }}
        onClose={() => setQuestionDialog(null)} />}
    </HomeCard>
  );
}

/** A conversation row's menu: each write refreshes the unread list the card reads. */
function HomeMessageMenuItems({ thread }: { thread: ThreadSummary }) {
  const href = threadHref(thread);
  const write = (request: Promise<unknown>, failure: string) => {
    void request.then(() => refreshPoll(THREADS_POLL_KEY)).catch((cause: unknown) => toast(cause instanceof Error ? cause.message : failure, 'danger'));
  };
  const core = thread.kind === 'project' || thread.kind === 'lead' || thread.kind === 'organization' || thread.kind === 'event'
    ? coreSubjectDoor(thread.kind, thread.parent_id)
    : undefined;
  return (
    <RowMenuItems
      kind="conversation"
      context="home"
      facts={{ hasUnread: thread.unread, isDirect: thread.kind === 'dm', hasCore: !!core }}
      doors={{ open: { href }, ...(core ? { 'open-core': core } : {}) }}
      run={{
        'mark-read': () => write(markThreadRead(thread.id), t('Couldn’t mark this conversation read.')),
        mute: () => write(setThreadMuted(thread.id, { until: thread.muted_until ? null : Date.now() + 7 * 24 * 3600 * 1000 }), t('Couldn’t change that.')),
        archive: () => write(setThreadArchived(thread.id, { archived: true }), t('Couldn’t change that.')),
      }}
      labels={{ mute: thread.muted_until ? t('Unmute') : t('Mute') }}
      render={{
        'copy-link': () => <CopyLinkItem href={href} />,
        star: () => <StarItem target={{ kind: 'meet.thread', target_ref: thread.id }} />,
      }}
    />
  );
}

/**
 * Home's Mine card: all of Mine, in Mine's order (`planMine`,
 * fixtures/work-items.json), the first rows and a count of the rest. Tasks
 * and issues in one list, as Mine draws them. Nothing new lands here; that
 * is the Inbox card's.
 */
export function OwnerHomeWork() {
  const [work, setWork] = useState<Pick<MyWork, 'tasks' | 'issues'>>(() => {
    const value = loadSnapshot<MyWork>(SNAPSHOT.mine)?.value;
    return { tasks: value?.tasks ?? [], issues: value?.issues ?? [] };
  });
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState('');
  const [completingTaskIDs, setCompletingTaskIDs] = useState<Set<string>>(() => new Set());
  const completingTaskIDsRef = useRef(new Set<string>());
  const loadRequestID = useRef(0);
  const menu = useRowMenu(homeRowMenuOptions);

  const load = useCallback(async () => {
    if (completingTaskIDsRef.current.size > 0) return;
    const requestID = ++loadRequestID.current;
    try {
      const next = await fetchMyWork();
      if (requestID !== loadRequestID.current) return;
      setWork({ tasks: next.tasks, issues: next.issues });
    } catch {
      // A Core blip: the last known work stands.
    }
    setNow(Date.now());
  }, []);
  useForegroundPoll(load);

  /** One menu decision: close, do it, then re-read. */
  async function decide(run: () => Promise<unknown>, fallback: string) {
    menu.close();
    try {
      await run();
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
    }
    void load();
  }

  /** Let the row leave first; reconcile after the write. */
  async function finishTask(task: CrmMyTask, cancel = false) {
    if (completingTaskIDsRef.current.has(task.id)) return;
    completingTaskIDsRef.current.add(task.id);
    setCompletingTaskIDs(new Set(completingTaskIDsRef.current));
    // A poll already in flight belongs to the list before this action.
    loadRequestID.current += 1;
    try {
      await Promise.all([
        (cancel ? cancelTask : completeTask)(task.id),
        waitForTaskRowExit(),
      ]);
      setWork((current) => ({ ...current, tasks: current.tasks.filter((row) => row.id !== task.id) }));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : cancel ? t('Couldn’t cancel that task.') : t('Couldn’t complete that task.'));
    } finally {
      completingTaskIDsRef.current.delete(task.id);
      setCompletingTaskIDs(new Set(completingTaskIDsRef.current));
      loadRequestID.current += 1;
      void load();
    }
  }

  /** Your own task, from the shared registry: Done and Cancel task first,
   * then its door (`CrmMyTask.rowActions`). */
  function taskMenu(task: CrmMyTask): ReactNode {
    const href = taskHref(task);
    const hasSubject = workSubjectOf(task) !== null;
    return <RowMenuItems kind="task" context="mine" preferDoor facts={{
      hasSubject, hasCore: hasSubject, canFileOnGitHub: !!task.project_id && task.github_issue_number === null, isStarable: true,
    }} run={{
      complete: () => { void finishTask(task); },
      cancel: () => { void finishTask(task, true); },
      'file-github': () => { void decide(async () => { await promoteTask(task); }, t('Couldn’t file that task on GitHub.')); },
    }} doors={{
      'open-subject': { href, label: t('Open {title}', { title: task.subject_title ?? '' }) },
      'open-mine': { href },
      'open-core': coreTaskDoor(task),
    }} render={{ star: () => <StarItem target={{ kind: 'crm.task', target_ref: task.id }} /> }} />;
  }

  /** An issue assigned to you: its door first, then close or reopen. */
  function issueMenu(issue: CrmIssue): ReactNode {
    return <IssueMenuItems issue={issue} preferDoor door={{ href: issueHref(issue.id) }} onChange={(change) => {
      void decide(() => setIssueState(issue, change), t('Couldn’t update that issue.'));
    }} />;
  }

  const rows = useMemo(() => planMine(work.tasks, work.issues).order, [work]);
  // Each row's due date against today, filing left out: an unfiled late task reads as late.
  const dueSection = useMemo(() => new Map(rows.map((row) => [row.id, dateSection(row.dueDate, now)])), [rows, now]);
  if (!homeModuleDraws('work', rows.length > 0)) return null;
  const listed = rows.slice(0, HOME_CARD_ROW_LIMIT);
  const hidden = rows.length - listed.length;
  const lateCount = rows.filter((row) => dueSection.get(row.id) === 'late').length;
  const todayCount = rows.filter((row) => dueSection.get(row.id) === 'today').length;
  const summary = [
    lateCount > 0 ? t('{count} overdue', { count: lateCount }) : null,
    todayCount > 0 ? t('{dueToday} due today', { dueToday: todayCount }) : null,
  ].filter(Boolean).join(' · ');

  /** The row's date: overdue, today or its day; with no date, its stage once started. */
  function when(row: PlannedRow): string {
    switch (dueSection.get(row.id)) {
      case 'late': return row.myTask ? overdueLabel(row.myTask) : t('Overdue');
      case 'today': return t('Today');
      case 'soon': return formatDay(row.dueDate ?? undefined) ?? '';
      default: {
        const status = FOCUS_STAGE_STATUS[stageOf(row)];
        return status ? CRM_TASK_STATUS_LABELS[status] : '';
      }
    }
  }

  return (
    <HomeCard aria-label={t('Mine')}>
      {/* The word "overdue" is already in the string — no tint on top of it (docs/DESIGN.md, the accent budget). */}
      <HomeCardHead title={t('Mine')} count={summary} />
      <HomeList>
        {listed.map((row) => {
          const isLate = dueSection.get(row.id) === 'late';
          if (row.issue) {
            const issue = row.issue;
            return (
              <HomeMenuItem key={row.id} menu={menu} id={`issue:${issue.id}`} items={issueMenu(issue)}>
                <HomeRow asChild>
                  <a data-home-row href={issueHref(issue.id)}>
                    <HomeRowMark aria-hidden="true" ink="muted"><GlyphMark size={24} shape="square"><IssueStateIcon open={issue.state === 'open'} size={14} /></GlyphMark></HomeRowMark>
                    <HomeRowText title={issue.title} detail={`${issue.repo}#${issue.number}`} />
                    <HomeRowWhen late={false}>{when(row)}</HomeRowWhen>
                  </a>
                </HomeRow>
              </HomeMenuItem>
            );
          }
          const task = row.myTask!;
          return (
            <HomeMenuItem key={row.id} menu={menu} id={`task:${task.id}`} items={taskMenu(task)} leaving={completingTaskIDs.has(task.id)}>
              <HomeRow asChild>
                <a data-home-row href={taskHref(task)}>
                  <HomeRowMark aria-hidden="true" ink={isLate ? 'primary' : 'muted'}><GlyphMark size={24} shape="square"><TaskIcon size={14} /></GlyphMark></HomeRowMark>
                  <HomeRowText title={task.title} detail={task.subject_title || undefined} />
                  <HomeRowWhen late={isLate}>{when(row)}</HomeRowWhen>
                </a>
              </HomeRow>
            </HomeMenuItem>
          );
        })}
      </HomeList>
      {hidden > 0 && (
        <HomeMore href="/work/mine">{t('and {count} more in Work', { count: hidden })}</HomeMore>
      )}
      {error && <ErrorNotice message={error} />}
    </HomeCard>
  );
}

/** The status word an undated started row shows, by stage, for a task or an issue alike. */
const FOCUS_STAGE_STATUS: Partial<Record<WorkStage, CrmTaskStatusId>> = {
  doing: 'in_progress',
  review: 'review',
  blocked: 'blocked',
};
