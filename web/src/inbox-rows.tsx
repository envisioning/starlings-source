import type { ReactNode } from 'react';
import type { InboxBooking, InboxBookingChange, InboxCommercialItem, InboxFormSubmission, InboxInterestSubmission, InboxItem, InboxResponse } from '@starlings/contracts/inbox';
import type { CrmMyTask } from '@starlings/contracts';
import { DropdownMenuItem } from '@/ui/dropdown-menu';
import { CalendarIcon, DecisionIcon, InboxCardIcon, InteractionIcon, ProposedTaskIcon, TeamIcon } from './action-icons';
import { SALES_INBOX_SOURCE_LABEL, inboxTouchMeta } from './crm-work';
import { formatDay, formatTime, parseDay } from './meeting-time';
import { licenseAmount, offerAmount } from './SubjectOverview';
import { CALENDAR_RSVP_CHOICES, calendarDay, dayHeading, parseCalendarDay, type CalendarRSVP } from './owner-agenda';
import { MenuIcon, RSVP_MENU_ICONS } from './menu-icons';
import { dateLocale, t } from './i18n';
import type { GlyphMarkShape } from './SubjectMark';
import { eventHref, issueHref, subjectHref, subjectTaskHref, taskHref, teamThreadHref } from './work-hrefs';
import { plainPreview } from './markdown-parse';
import { decisionDefaultByLabel, decisionDetail } from './decision-labels';

/*
 * One INBOX row, the way every glance surface draws it: Work's INBOX list
 * and Home's INBOX card. Mac: `WorkInboxItem.glanceTitle` and friends.
 */

export function inboxItemMeta(item: InboxItem): { title: string; detail: string; symbol: ReactNode; shape: GlyphMarkShape } {
  switch (item.source) {
    case 'question':
      return { title: item.request.prompt, detail: [t('Question'), t('Asked by {who}', { who: item.request.asked_by }), item.request.subject?.title ?? item.request.context].filter(Boolean).join(' · '), symbol: <InteractionIcon type="note" size={14} />, shape: 'square' };
    case 'decision':
      return { title: item.ask.question, detail: decisionDetail(item.ask), symbol: <DecisionIcon size={14} />, shape: 'square' };
    case 'talk':
    case 'mention':
      return {
        title: item.thread.title ?? t('Subject conversation'),
        detail: (item.source === 'mention' ? t('Mentions you · ') : '') + (item.thread.last_message_preview ? plainPreview(item.thread.last_message_preview) : t('Unread')),
        symbol: <InteractionIcon type="note" size={14} />,
        shape: 'round',
      };
    case 'task':
      return { title: item.task.title, detail: item.subject.kind === 'organization'
        ? t('Proposed · Partner · {title}', { title: item.subject.title })
        : t('Proposed · {title}', { title: item.subject.title }), symbol: <ProposedTaskIcon size={14} />, shape: 'square' };
    case 'card':
      return { title: inboxCardTitle(item), detail: inboxCardDetail(item), symbol: <InboxCardIcon blocked={item.stage === 'blocked'} size={14} />, shape: 'square' };
    case 'followup':
      return {
        title: item.draft.subject,
        detail: t('Follow-up · {people} · {subject}', { people: item.recipients.map((person) => person.name).join(', '), subject: item.subject.title }),
        symbol: <InteractionIcon type="email" size={14} />,
        shape: 'square',
      };
    case 'note':
      return { title: item.note.body.split('\n')[0] ?? t('Quick Note'), detail: t('Quick Note to file'), symbol: <InteractionIcon type="note" size={14} />, shape: 'square' };
    case 'sales':
      return { title: item.touch.preview || SALES_INBOX_SOURCE_LABEL[item.touch.source], detail: t('Sales · {touch}', { touch: inboxTouchMeta(item.touch) }), symbol: <InteractionIcon type="email" size={14} />, shape: 'round' };
    case 'comment':
      return { title: item.document.title, detail: t('Comment · {subject}', { subject: item.subject?.title ?? t('Docs') }), symbol: <InteractionIcon type="note" size={14} />, shape: 'square' };
    case 'booking':
      return { title: item.booking.guest_name, detail: bookingDetail(item.booking, item.change), symbol: <CalendarIcon />, shape: 'round' };
    case 'invitation':
      return {
        title: item.event.title || t('Calendar invitation'),
        detail: [t('Invitation'), calendarWhen(item.event.start, item.event.allDay), item.event.calendarSummary || null].filter(Boolean).join(' · '),
        symbol: <CalendarIcon />,
        shape: 'round',
      };
    case 'forwarded':
      return {
        title: item.event.title,
        detail: [t('From email'), calendarWhen(item.event.start, item.event.all_day)].filter(Boolean).join(' · '),
        symbol: <CalendarIcon />,
        shape: 'round',
      };
    case 'interest':
      return { title: item.submission.company, detail: interestDetail(item.submission), symbol: <TeamIcon />, shape: 'round' };
    case 'submission':
      return { title: item.submission.organization || item.submission.name, detail: submissionDetail(item.submission), symbol: <TeamIcon />, shape: 'round' };
    case 'commercial':
      return { title: commercialTitle(item), detail: commercialDetail(item), symbol: <CalendarIcon />, shape: 'round' };
    case 'support':
      return { title: t('Starlings support replied'), detail: item.preview, symbol: <InteractionIcon type="note" size={14} />, shape: 'round' };
    case 'guest':
      return {
        title: item.subject.title,
        detail: [item.origin === 'app' ? t('App user') : item.subject.id === 'intake' ? t('Public contact') : item.origin === 'peer' ? t('Organization') : t('Guest'), item.preview ? plainPreview(item.preview) : null].filter(Boolean).join(' · '),
        symbol: <TeamIcon />,
        shape: 'round',
      };
  }
}

/** The task represented by a work inbox row, where that row is actionable as task work. */
export function inboxTaskID(item: InboxItem): string | null {
  switch (item.source) {
    case 'task':
      return item.task.id;
    default:
      return null;
  }
}

export { decisionDefaultByLabel, decisionDetail };

type InboxCardRow = Extract<InboxItem, { source: 'card' }>;

export function inboxCardTitle(item: InboxCardRow): string {
  return item.task?.title ?? item.issue?.title ?? '';
}

/** "Review · Vocab · Acme rollout": what waits, who stopped, where. Mac: `WorkInboxCard.detail`. */
export function inboxCardDetail(item: InboxCardRow): string {
  return item.stage === 'blocked'
    ? t('Blocked · {agent} · {subject}', { agent: item.agent.name, subject: item.subject.title })
    : t('Review · {agent} · {subject}', { agent: item.agent.name, subject: item.subject.title });
}

/** The card itself: the issue's reader, or the task on its subject. */
export function inboxCardHref(item: InboxCardRow): string {
  if (item.issue) return issueHref(item.issue.id);
  if (item.task) return subjectTaskHref(item.task.id, item.subject);
  return subjectHref(item.subject);
}

/** "Interest · Peer firm · Ada · 2 to 10 · 6 to 20 agents · On our own servers" — its lane, who wrote, how many, how they would run it. */
export function interestDetail(submission: InboxInterestSubmission): string {
  const agents = submission.agents ? t('{count} agents', { count: submission.agents }) : '';
  return [t('Interest'), submission.lane ?? '', submission.name, submission.team_size, agents, submission.deployment].filter(Boolean).join(' · ');
}

/**
 * "Offer expires 6 Nov", "License renews 20 Nov", or "License renewal passed
 * 28 Oct" when the renewal day is before today.
 */
export function commercialTitle(item: InboxCommercialItem, now: Date = new Date()): string {
  const date = formatDay(item.due, now) || item.due;
  if (item.event === 'offer_expiring') return t('Offer expires {date}', { date });
  const due = parseDay(item.due);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return due && due.getTime() < today.getTime()
    ? t('License renewal passed {date}', { date })
    : t('License renews {date}', { date });
}

/** "Acme · Pilot proposal · €12,000": the subject, the offer or the licence's product, the amount as Overview draws it. */
export function commercialDetail(item: InboxCommercialItem): string {
  const offer = item.offer;
  const license = item.license;
  const what = offer ? offer.title || t('Untitled offer') : license ? license.product || t('License') : null;
  const amount = offer ? offerAmount(offer) : license ? licenseAmount(license) : null;
  return [item.subject.title, what, amount].filter(Boolean).join(' · ');
}

/** "Organisation request · Ana · Company · 1,000 to 10,000 · SMS" — the form, who wrote, the picks that sort it. */
export function submissionDetail(submission: InboxFormSubmission): string {
  return [submission.title, submission.name, submission.summary].filter(Boolean).join(' · ');
}

/**
 * "Booked · Tomorrow 14:00 · Acme" — when, then who they are from.
 * "Rescheduled · was Tue 10:00 · Tomorrow 14:00", "Cancelled · was Tue 10:00".
 */
export function bookingDetail(booking: InboxBooking, change: InboxBookingChange = 'booked'): string {
  const when = (iso: string) => {
    const date = new Date(iso);
    return `${dayHeading(date).primary} ${formatTime(date)}`;
  };
  switch (change) {
    case 'booked':
      return [t('Booked'), when(booking.start_time), booking.guest_organization].filter(Boolean).join(' · ');
    case 'rescheduled':
      return [t('Rescheduled'), booking.previous_start_time ? `was ${when(booking.previous_start_time)}` : null, when(booking.start_time), booking.guest_organization].filter(Boolean).join(' · ');
    case 'cancelled':
      return [t('Cancelled'), `was ${when(booking.start_time)}`, booking.guest_organization].filter(Boolean).join(' · ');
  }
}

/** "6 Oct", or "6 Oct 2027" when it is not this year: the Mac and iOS card line. */
function cardDate(date: Date, now: number): string {
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(dateLocale, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * A calendar row's start as a local time. An all-day start is a civil day
 * (`2026-10-08`), read in this browser's zone so it does not move a day
 * west of UTC. Null when the wire holds no date.
 */
export function calendarStart(start: string, allDay: boolean): Date | null {
  if (allDay) return parseCalendarDay(start.slice(0, 10));
  const at = Date.parse(start);
  return Number.isNaN(at) ? null : new Date(at);
}

/**
 * When a calendar row is: "Tomorrow 14:00", "Friday 09:30" inside the coming
 * week, "6 Oct 09:30" past it. An all-day row shows its day and no time.
 */
export function calendarWhen(start: string, allDay: boolean, now = Date.now()): string | null {
  const date = calendarStart(start, allDay);
  if (!date) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  const ahead = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  const heading = ahead >= 0 && ahead < 7 ? dayHeading(date, now).primary : cardDate(date, now);
  return allDay ? heading : `${heading} ${formatTime(date)}`;
}

/**
 * The registry's `rsvp` on an invitation row: one item per answer, as
 * `decide` draws one per option. Work's INBOX menu and Home's Inbox card.
 */
export function RSVPAnswerItems({ onAnswer }: { onAnswer: (response: CalendarRSVP) => void }) {
  return <>
    {CALENDAR_RSVP_CHOICES.map((choice) => (
      <DropdownMenuItem key={choice.response} onSelect={() => onAnswer(choice.response)}>
        <MenuIcon name={RSVP_MENU_ICONS[choice.response]} />
        {choice.title}
      </DropdownMenuItem>
    ))}
  </>;
}

/** Where a task opens: its details reader in Work. */
export function myTaskHref(task: Pick<CrmMyTask, 'id'>): string {
  return taskHref(task.id);
}

/** The calendar's door to the booked event, or null when Core holds no event. */
export function bookingEventHref(booking: InboxBooking): string | null {
  if (!booking.google_event_id) return null;
  const day = booking.start_time.slice(0, 10);
  return eventHref(`primary:${booking.google_event_id}`, day);
}

/** Where a Home row lands: the subject's pane that resolves the item, or Work itself. */
export function inboxItemHref(item: InboxItem): string {
  switch (item.source) {
    // A proposal on a partner is not the caller's task yet, so Mine cannot open it: its subject's Tasks pane does.
    case 'task': return item.subject.kind === 'organization' ? subjectHref(item.subject, { pane: 'tasks' }) : myTaskHref(item.task);
    case 'card': return inboxCardHref(item);
    case 'followup': return `/work?followup=${encodeURIComponent(item.meeting.id)}`;
    case 'comment': return item.subject ? subjectHref(item.subject, { pane: 'documents' }) : '/work';
    case 'booking': return item.change === 'cancelled' ? '/work' : bookingEventHref(item.booking) ?? '/work';
    case 'invitation': {
      const start = calendarStart(item.event.start, item.event.allDay);
      return eventHref(item.event.id, start ? calendarDay(start) : undefined);
    }
    // Not on a calendar yet: the day it would land on, to see what else is there.
    case 'forwarded': {
      const start = calendarStart(item.event.start, item.event.all_day);
      return start ? `/calendar?day=${calendarDay(start)}` : '/calendar';
    }
    case 'interest':
    case 'submission': return item.submission.lead ? subjectHref(item.submission.lead) : '/work';
    // The lead or organization, on its Overview: where its offers and licences are.
    case 'commercial': return subjectHref(item.subject);
    // A touch is triaged from Work's INBOX (Start a lead / Dismiss); a note
    // never reaches the card (it has its own module).
    // A decision opens its dialog in Work.
    case 'question': return `/work?question=${encodeURIComponent(item.request.id)}`;
    case 'decision': return `/work?decision=${encodeURIComponent(item.ask.id)}`;
    case 'sales':
    case 'note':
    case 'talk':
    case 'mention':
      return '/work';
    case 'guest':
      return item.subject.id === 'intake' ? teamThreadHref(item.thread_id) : subjectHref(item.subject);
    case 'support':
      return `/work?help=${encodeURIComponent(item.conversation_id)}`;
  }
}

/**
 * The INBOX items Home's Inbox card lists beside the unread conversations:
 * the inbox minus unread talk (the thread poll draws it live), minus unfiled
 * Quick Notes (their own module).
 * Mac: `WorkInboxResponse.itemsForHomeCard`.
 */
export function inboxItemsForHomeCard(items: InboxItem[]): InboxItem[] {
  return items.filter((item) => item.source !== 'talk' && item.source !== 'mention' && item.source !== 'note');
}

/** A partial question read is unknown state, so retain the last known queue until a successful read. */
export function retainQuestionInbox(previous: readonly InboxItem[], next: InboxResponse): InboxResponse {
  if (!next.partial.includes('question')) return next;
  const decisions = next.items.filter((item) => item.source === 'decision');
  const questions = previous.filter((item) => item.source === 'question');
  const rest = next.items.filter((item) => item.source !== 'decision' && item.source !== 'question');
  return { ...next, items: [...decisions, ...questions, ...rest] };
}
