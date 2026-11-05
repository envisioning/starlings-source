import type { ThreadMessage, ThreadSummary } from '@starlings/contracts';
import { THREAD_GROUPING_WINDOW_MS } from '@starlings/contracts/limits';
import { REACTION_EMOJI } from '@starlings/contracts/reactions';
import { t, dateLocale } from './i18n';
import { subjectHref, teamThreadHref } from './work-hrefs';

export function mergeMessages(current: ThreadMessage[], incoming: ThreadMessage[]): ThreadMessage[] {
  const found = new Map(current.map(row => [row.id, row]));
  incoming.forEach(row => found.set(row.id, row));
  return [...found.values()].sort((a, b) => a.sent_at - b.sent_at || a.id.localeCompare(b.id));
}

/**
 * What a conversation is called.
 *
 * A channel has a title. A private conversation does not, so the people in it
 * are the title — the person's full display name for a DM, and everybody's
 * first names for a group, which is what makes two groups with the same three
 * people impossible to confuse. Alphabetical, because the Worker orders the
 * roster by address and every member of a group has to read the same name for
 * it.
 */
export function threadTitle(thread: ThreadSummary): string {
  if (thread.title) return thread.title;
  if (thread.kind === 'team') return 'Everyone';
  const peers = thread.peers ?? [];
  if (peers.length > 1) return peers.map(peerShortName).join(', ');
  return peerDisplayName(peers[0] ?? { email: thread.peer_email ?? '', name: thread.peer_name })
    || t('Conversation');
}

function peerDisplayName(peer: { email: string; name: string | null }): string {
  const name = peer.name?.trim();
  return name || peer.email.split('@')[0] || '';
}

/**
 * One person, as short as a list row can afford. A first name where there is a
 * name, and the local part of the address where there is not — never the whole
 * address, which turns a three-person group into a line of ellipsis.
 */
function peerShortName(peer: { email: string; name: string | null }): string {
  return peerDisplayName(peer).split(/\s+/u)[0] ?? peerDisplayName(peer);
}

/**
 * Who wrote a conversation's last line, by first name, when the title does
 * not already say so: a channel's or a group's title is the place, not the
 * person. Null for a DM, whose title is the person, and when the
 * sender is nobody the roster or the thread knows. The Mac and iPhone ask
 * the same question with `ThreadSummary.lastSenderShortName`.
 */
export function threadLastSenderName(
  thread: ThreadSummary,
  roster: ReadonlyArray<{ email: string; name: string | null }>,
): string | null {
  const email = thread.last_sender_email?.toLowerCase();
  if (!email) return null;
  if (thread.kind === 'dm' && (thread.peers?.length ?? 0) <= 1) return null;
  const known = [...roster, ...(thread.peers ?? [])].find((peer) => peer.email.toLowerCase() === email);
  return known ? peerShortName(known) : null;
}

/** A thread's permalink: a subject's Talk in Work, any other conversation on Team. */
export function threadHref(thread: ThreadSummary): string {
  const onSubject = thread.kind === 'project' || thread.kind === 'lead' || thread.kind === 'organization' || thread.kind === 'event';
  if (!onSubject) return teamThreadHref(thread.id);
  return thread.parent_id ? subjectHref({ kind: thread.kind, id: thread.parent_id }, { pane: 'talk' }) : '/work';
}

/** How close two lines from one person have to be to read as one turn (`THREAD_GROUPING_WINDOW_MS`). */
export const GROUPING_WINDOW_MS = THREAD_GROUPING_WINDOW_MS;

/** The emoji offered on the quick-reaction menu: the meeting palette. Stored reactions outside it still render. */
export const QUICK_REACTIONS = REACTION_EMOJI;
/**
 * The emoji offered on an agent's line: thumbs up alone. A member reads an
 * agent's answer to accept it or not; a heart or a laugh at a runtime is noise
 * the agent cannot use, and one button is one less choice.
 */
export const AGENT_QUICK_REACTIONS = ['👍'] as const;

/** The palette for one message: the full row for a person, one button for an agent. */
export function quickReactionsFor(fromAgent: boolean): readonly string[] {
  return fromAgent ? AGENT_QUICK_REACTIONS : QUICK_REACTIONS;
}

export type TranscriptRow =
  /** A day boundary. A heading in the reading order. */
  | { kind: 'day'; at: number }
  /** Where the reader left off. Drawn once, and only when there is something to point at. */
  | { kind: 'unread' }
  /** Somebody talking. `grouped` drops the avatar, the name and the timestamp. */
  | { kind: 'message'; message: ThreadMessage; grouped: boolean }
  /** The work graph reporting itself. Never grouped, never attributed. */
  | { kind: 'event'; message: ThreadMessage }
  /**
   * An agent narrating its own turn: the run of event lines it posted on its
   * way to an answer — "Reading the board", "Searching for Acme" — folded
   * into one row, oldest first. Drawn collapsed once the answer is in, and as
   * the working row's own second line while the turn is still open. A
   * transcript that kept every step at full height would be a log with a
   * conversation buried in it.
   */
  | { kind: 'trail'; steps: ThreadMessage[] };

function sameDay(a: number, b: number): boolean {
  const left = new Date(a);
  const right = new Date(b);
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

/**
 * One turn, or a new one. A withdrawn message breaks the group on either side:
 * a tombstone folded silently into somebody's paragraph reads as a blank line
 * they typed. So does a change of hand: the "via" tag lives in the header, and
 * a line their Claude sent must not fold under one the person typed.
 */
function isGrouped(message: ThreadMessage, previous: ThreadMessage | null): boolean {
  if (!previous) return false;
  if (previous.deleted_at !== undefined || message.deleted_at !== undefined) return false;
  if (previous.sender_email !== message.sender_email) return false;
  if (previous.via !== message.via) return false;
  return message.sent_at - previous.sent_at <= GROUPING_WINDOW_MS;
}

/**
 * Arrange messages for reading. The TypeScript twin of `ThreadTranscript.rows`.
 *
 * `unreadBoundary` is captured when the conversation opens and held still
 * afterwards — deliberately not re-derived from the newest page. A marker that
 * moves every poll is a marker that has never once been where you stopped
 * reading.
 */
export function transcriptRows(
  messages: ThreadMessage[],
  unreadBoundary: number | null,
  /**
   * The agents in this roster. An event one of them signed is a step of its
   * turn and folds into a trail; an event from Meet itself — a meeting filed,
   * an issue closed — stays its own line. Without the roster nothing folds,
   * which is exactly what a pane with no agent should draw.
   */
  agentEmails: ReadonlySet<string> = new Set(),
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  // Two pieces of state, deliberately separate: "no day drawn yet" and
  // "nothing to group with" are not the same absence, and one variable doing
  // both emits a second day heading after every event line.
  let lastDay: number | null = null;
  let previous: ThreadMessage | null = null;
  let markPlaced = false;

  for (const message of messages) {
    if (lastDay === null || !sameDay(lastDay, message.sent_at)) {
      rows.push({ kind: 'day', at: message.sent_at });
      lastDay = message.sent_at;
      previous = null;
    }
    // Your own message is never something you came back to read.
    if (!markPlaced && unreadBoundary !== null && message.sent_at > unreadBoundary && !message.is_mine) {
      rows.push({ kind: 'unread' });
      markPlaced = true;
      previous = null;
    }
    if (message.type === 'event') {
      previous = null;
      const last = rows[rows.length - 1];
      if (agentEmails.has(message.sender_email)) {
        // Consecutive steps from the same agent are one trail. A day heading
        // or the unread mark between two steps starts a second one, because
        // both are already breaks in the page.
        if (last?.kind === 'trail' && last.steps[0]!.sender_email === message.sender_email) {
          last.steps.push(message);
        } else {
          rows.push({ kind: 'trail', steps: [message] });
        }
        continue;
      }
      rows.push({ kind: 'event', message });
      continue;
    }
    rows.push({ kind: 'message', message, grouped: isGrouped(message, previous) });
    previous = message;
  }
  return rows;
}

/**
 * m:ss since a moment, for the working row's clock. Minutes are not padded
 * — "0:07", "1:42", "12:05" — the way a stopwatch reads, and never hours: a
 * turn that long has already been reset by the watchdog.
 */
export function elapsedLabel(since: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** "Today", "Yesterday", a weekday inside the last week, then the date. */
export function dayTitle(at: number, now = Date.now()): string {
  const date = new Date(at);
  if (sameDay(at, now)) return t('Today');
  if (sameDay(at, now - 86_400_000)) return t('Yesterday');
  if (now - at < 6 * 86_400_000) return date.toLocaleDateString(dateLocale, { weekday: 'long' });
  return date.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short', year: 'numeric' });
}
