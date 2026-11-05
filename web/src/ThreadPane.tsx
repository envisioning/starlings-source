import type { AttentionRequest } from '@starlings/contracts/attention';
import { attentionStatus, fetchAttention, resolveAttention } from './attention';
import { useOwnerSession } from './owner-session';
import { composerFieldClass, composerSendClass } from './composer-send';
import { Tip } from './Tip';
import { confirmDataLoss } from './ConfirmDataLoss';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Type } from 'lucide-react';
import { Textarea } from '@/ui/textarea';
import { Button } from '@/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Badge } from '@/ui/badge';
import { Card } from '@/ui/card';
import { homeRowClass } from './HomeModule';
import { Separator } from '@/ui/separator';
import { ScrollArea } from '@/ui/scroll-area';
import { cn } from '@/lib/utils';
import type {
  AttachmentStagedResponse,
  MessageReactionsResponse,
  ThreadCreateInput,
  ThreadMessage,
  ThreadMessageAttachment,
  ThreadMessageRef,
  ThreadMessagesResponse,
  ThreadQuestion,
  ThreadQuestionAnswerResponse,
  ThreadSummary,
} from '@starlings/contracts';
import { AGENT_ACCEPT_GRACE_SECONDS, AGENT_TURN_POLL_SECONDS, MESSAGE_TEXT_MAX_CHARS, THREAD_BACKGROUND_POLL_SECONDS, THREAD_POLL_SECONDS } from '@starlings/contracts/limits';
import { apiFetch, apiObjectURL, apiUpload } from './api';
import { createSupportRequest, fetchSupportRequests } from './support-requests';
import type { SupportRequest } from '@starlings/contracts';
import { track } from './analytics';
import { apiBase } from './config';
import { plainText } from './markdown';
import { MessageLinkPreview, ownerPreviewLoader } from './link-preview';
import { markThreadRead, setThreadArchived, setThreadMuted, threadTitle } from './messages';
import { FavoriteToggle } from './FavoriteToggle';
import { agentActivityLines, agentManifestLinks, agentToolEntry, peerDisplayName, peerShortName, refreshPeers, type Peer } from './team-presence';
import { mentionsIn as mentionsInText } from './mentions';
import { quickReactionsFor, dayTitle, elapsedLabel, mergeMessages, transcriptRows } from './conversation-model';
import { formatTime } from './meeting-time';
import { ReactionSymbol, reactionLabel, CloseIcon, CopyLinkIcon, MailIcon, PlusIcon, PasteIcon, ArchiveIcon, MuteIcon, SendIcon, ReplyIcon, ChevronIcon as SharedChevronIcon } from './action-icons';
import { ErrorNotice } from './ErrorNotice';
import { storeRecent } from './search-doors';
import { threadRecentRow } from '@starlings/contracts/search-rows';
import { plural, t } from './i18n';
import { createDecision } from './crm-work';
import { invalidateFor } from './snapshot-store';
import { createQuickNote } from './quick-notes';
import { toast } from './Toast';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { CopyTextItem, RowMenuItems } from './row-menu-items';
import { RightSidebarSlot } from './SurfaceShell';
import { useRowMenu } from './use-row-menu';
import { PlaceholderRows } from '@/ui/placeholder-rows';
import { formatMessage, type MessageFormatAction } from './message-formatting';
import { AgentWorkingRow, MessageBubble, MessageHead, MessageTurn, QuestionCard, ReleaseRequestCard, ThreadAvatarFace, ThreadEventRow } from './thread-parts';

/** Somebody `@` can name here. Supplied by whoever already holds the roster. */
export interface Mentionable {
  email: string;
}

const SUBJECT_TALK_KINDS = new Set(['project', 'lead', 'organization', 'event']);

/** A day heading or the unread mark: a label beside a Separator. */
const DIVIDER = 'flex items-center gap-2.5 pt-[1.1rem] pb-1 text-xs tracking-[.04em] text-muted-foreground uppercase';

function messageSenderName(message: ThreadMessage): string {
  return message.sender_name?.trim() || message.sender_email.split('@')[0] || message.sender_email;
}

/** A short text-only quote. Withdrawn content and attachment names never enter a reply preview. */
function replyExcerpt(message: ThreadMessage | null): string {
  if (!message) return t('Message preview is not loaded.');
  if (message.deleted_at) return t('Message withdrawn');
  const text = message.text.replace(/\s+/gu, ' ').trim();
  if (text) return text.length > 120 ? `${text.slice(0, 117).trimEnd()}…` : text;
  if (message.attachments?.length) return t('Attachment');
  return t('Earlier message');
}

/** The quoted line above a reply: a ghost Button that jumps to it. */
function ReplyPreview({ message, onJump, className }: { message: ThreadMessage | null; onJump: () => void; className?: string }) {
  const name = message ? messageSenderName(message) : t('Earlier message');
  return <Button
    type="button"
    variant="ghost"
    className={cn(
      'h-auto max-w-[min(100%,32rem)] min-w-0 justify-start gap-1.5 rounded-md border border-border border-s-[3px] border-s-primary/55 bg-muted px-2 py-1 text-start font-normal whitespace-normal text-muted-foreground',
      className,
    )}
    aria-label={message ? t('Jump to {name}’s message', { name }) : t('Jump to earlier message')}
    onClick={onJump}
  >
    <ReplyIcon />
    <span className="grid min-w-0 gap-0.5 text-[.76rem]">
      <b className="font-semibold text-foreground">{name}</b>
      <span className="truncate">{replyExcerpt(message)}</span>
    </span>
  </Button>;
}

/** Mounted only for the conversation being read. Hidden tabs never mark it read. */
/**
 * What a ref chip says. The number is what somebody scanning a channel is
 * looking for, so an issue shows as `#142` rather than as the repository path
 * it is qualified with — the sentence beside it already names the work.
 */
/**
 * Whether a chip leads anywhere — Swift's `ThreadMessageRef.isOpenable`. Work
 * opens a task, an issue, a decision or a goal in place, and a GitHub ref
 * whose id names its repository opens github.com. A meeting has no door from
 * a channel yet, so its chip stays a label rather than a link that does nothing.
 */
function refOpens(ref: ThreadMessageRef): boolean {
  switch (ref.kind) {
    case 'task': case 'issue': case 'decision': case 'goal': return true;
    case 'pull': return /^[^/#]+\/[^/#]+#./u.test(ref.id);
    case 'run': return /^[^/!]+\/[^/!]+!./u.test(ref.id);
    case 'commit': case 'release': return /^[^/@]+\/[^/@]+@./u.test(ref.id);
    default: return false;
  }
}

/** The chip's tooltip and accessible name: what pressing it does. */
function refOpenLabel(ref: ThreadMessageRef): string {
  const title = refTitle(ref);
  switch (ref.kind) {
    case 'task': return t('Open task');
    case 'issue': return t('Open issue {title}', { title });
    case 'pull': return t('Open pull request {title} on GitHub', { title });
    case 'commit': return t('Open commit {title} on GitHub', { title });
    case 'run': return t('Open CI run on GitHub');
    case 'release': return t('Open release {title} on GitHub', { title });
    case 'decision': return t('Show decisions');
    case 'goal': return t('Show goals');
    default: return title;
  }
}

function refTitle(ref: ThreadMessageRef): string {
  switch (ref.kind) {
    case 'issue':
    case 'pull':
      return `#${ref.id.split('#').at(-1) ?? ref.id}`;
    case 'commit':
      return (ref.id.split('@').at(-1) ?? ref.id).slice(0, 7);
    case 'run':
      return 'CI';
    case 'release':
      return ref.id.split('@').at(-1) ?? t('Release');
    case 'task':
      return t('Task');
    case 'meeting':
      return t('Meeting');
    case 'decision':
      return t('Decision');
    case 'goal':
      return t('Goal');
  }
}

export function ThreadPane({ address, threadID, title, mentionable = [], agent, agents = [], onOpenRef, fill = false, onClose, onOpenPerson, onThreadLoaded, sidebarToggle = false, focus }: {
  address?: ThreadCreateInput; threadID?: string; title?: string; mentionable?: Mentionable[];
  /**
   * The roster's agents, for a channel: an agent hears nothing there unless
   * named, so the one my latest line @mentions is the one whose turn is open
   * — and whose working row belongs at the bottom.
   */
  agents?: Peer[];
  /**
   * The agent this conversation is with, when it is one. Drawn as a manifest
   * card when it has one, and read for its working state, which drives the
   * transient "working…" row — the roster the page already polls, never a
   * second signal.
   */
  agent?: Peer;
  /**
   * Somebody pressed the chip on an event line. Wired only where the page
   * around this pane has somewhere to go: an event that reports an issue in a
   * pane with no issue sheet draws its ref as plain text rather than as a
   * button that does nothing.
   */
  onOpenRef?: (ref: ThreadMessageRef) => void;
  /**
   * The pane is the column (Team): it stands the height of the viewport, the
   * transcript scrolls inside it and the composer stays put. Off, it reads in
   * the page's flow, as on a subject's Talk pane.
   */
  fill?: boolean;
  onClose?: () => void;
  /**
   * The head's title is a way back to the person this conversation is with.
   * Team wires it on the phone only, where the inspector is a Sheet that
   * closes; above the phone the inspector is a column that stays.
   */
  onOpenPerson?: () => void;
  /**
   * The summary the server answered for the conversation just opened. Work reads
   * the channel's forwarding address off it for the subject's EMAIL block, as
   * the Mac does (`ThreadPaneView.onThreadLoaded`).
   */
  onThreadLoaded?: (thread: ThreadSummary) => void;
  /** Draw the page's right-sidebar toggle in this head, beside the star and mute (Team). */
  sidebarToggle?: boolean;
  /**
   * Where a permalink asked to land: `'latest'`, the line Home's
   * Messages row previewed, or a message id. Scrolled to and flashed once,
   * when the first page has landed.
   */
  focus?: string;
}) {
  const threadLoaded = useRef(onThreadLoaded);
  threadLoaded.current = onThreadLoaded;
  const addressKey = JSON.stringify(address);
  const [thread, setThread] = useState<ThreadSummary | null>(null);
  // A guest thread's lines that already became a card (docs/SUPPORT.md), by line id.
  const [supportRequests, setSupportRequests] = useState<Map<string, SupportRequest>>(new Map());
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [replyingToID, setReplyingToID] = useState<string | null>(null);
  const [jumpTargetID, setJumpTargetID] = useState<string | null>(null);
  const [flashID, setFlashID] = useState<string | null>(null);
  const pendingFocus = useRef(focus);
  const ownerSession = useOwnerSession();
  const [questionRequests, setQuestionRequests] = useState<Record<string, AttentionRequest>>({});
  const [questionsLoaded, setQuestionsLoaded] = useState(false);
  const hasQuestions = useRef(false);
  const [questionSelections, setQuestionSelections] = useState<Record<string, string[]>>({});
  const [questionSubmitting, setQuestionSubmitting] = useState<ReadonlySet<string>>(() => new Set());
  const [questionErrors, setQuestionErrors] = useState<Record<string, string>>({});
  const composer = useRef<HTMLTextAreaElement>(null);
  const composerSelection = useRef({ start: 0, end: 0 });
  const returnToComposer = useRef(false);
  // The field is one line until the text needs another, and never a scrolling
  // box: its height follows the draft, up to the cap the stylesheet sets.
  useEffect(() => {
    const field = composer.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  }, [draft]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [savingQuickNoteIDs, setSavingQuickNoteIDs] = useState<ReadonlySet<string>>(() => new Set());
  /** Message id → the Quick Note id its save was sent with, until it lands: a retry cannot make two. */
  const quickNoteCaptures = useRef(new Map<string, { id: string; captured_at: number }>());
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ThreadMessage | null>(null);
  /**
   * Each line's menu: the `…` under the bubble, right-click,
   * Shift+F10 and the ContextMenu key. Focus goes back to the bubble after
   * a right-click or a key, and to the `…` after a click on it.
   */
  const messageMenu = useRowMenu({ target: '[data-bubble]' });
  const [pending, setPending] = useState<ThreadMessageAttachment[]>([]);
  const [uploading, setUploading] = useState(0);
  /**
   * Where the reader left off, captured when the conversation opens and held
   * still afterwards. Re-deriving it from each poll would move the mark every
   * few seconds, which is a mark that has never once been where somebody
   * stopped reading.
   */
  const [unreadBoundary, setUnreadBoundary] = useState<number | null>(null);
  /** Trails the reader unfolded. Collapsed is the default; a click is a choice. */
  const [openTrails, setOpenTrails] = useState<ReadonlySet<string>>(() => new Set());
  /** Read by the poll between ticks, so the cadence can change without restarting it. */
  const turnOpen = useRef(false);
  const generation = useRef(0);
  /** The ScrollArea's viewport: the element that scrolls. */
  const scroll = useRef<HTMLElement | null>(null);
  const bindScroll = useCallback((root: HTMLDivElement | null) => {
    scroll.current = root?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;
  }, []);
  const followLatest = useRef(true);
  const merge = (rows: ThreadMessage[]) => {
    if (rows.some((message) => message.question)) hasQuestions.current = true;
    setMessages(current => mergeMessages(current, rows));
  };
  useEffect(() => {
    if (followLatest.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!onClose) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    const version = ++generation.current;
    let stopped = false;
    let pendingRefresh = false;
    let id = threadID;
    let first = true;
    followLatest.current = true;
    setThread(null); setMessages([]); setCursor(null); setDraft(''); setError('');
    setLoading(true); setBusy(false); setEditing(null); setPending([]); setUploading(0);
    setReplyingToID(null); setJumpTargetID(null);
    setQuestionSelections({}); setQuestionSubmitting(new Set()); setQuestionErrors({});
    setQuestionRequests({}); setQuestionsLoaded(false); hasQuestions.current = false;
    setUnreadBoundary(null);
    async function refresh() {
      // Visible is enough: a window behind another one reads on the slower
      // beat below. Requiring focus left it reading nothing.
      if (stopped || pendingRefresh || document.visibilityState !== 'visible') return;
      pendingRefresh = true;
      try {
        if (!id) {
          const opened = await apiFetch<{ thread: ThreadSummary }>('/threads', {
            method: 'POST', body: JSON.parse(addressKey!), fallbackError: t('Couldn’t open this conversation.'),
          });
          id = opened.thread.id;
          // Captured once, before the first page lands.
          setUnreadBoundary(opened.thread.unread ? opened.thread.last_read_at : null);
        }
        const page = await apiFetch<ThreadMessagesResponse>(`/threads/${encodeURIComponent(id)}/messages`, {
          noStore: true, fallbackError: t('Couldn’t load this conversation.'),
        });
        if (stopped) return;
        if (first && !threadID) { /* boundary already captured above */ }
        if (first && threadID) setUnreadBoundary(page.thread.unread ? page.thread.last_read_at : null);
        setThread(page.thread); merge(page.messages); setError('');
        if (hasQuestions.current) {
          const attention = await fetchAttention({ thread_id: id, state: 'all' });
          if (stopped) return;
          setQuestionRequests((current) => {
            const next = { ...current };
            for (const request of attention.requests ?? []) if (request.origin.type === 'thread_question') {
              const previous = next[request.origin.message_id];
              if (!previous || request.revision >= previous.revision) next[request.origin.message_id] = request;
            }
            return next;
          });
          setQuestionsLoaded(true);
        }
        if (first) threadLoaded.current?.(page.thread);
        if (first) {
          setCursor(page.older_cursor); first = false;
          // Opened by hand: into the device's recents, the list Home's
          // RECENT and the ⌘K palette share.
          storeRecent(threadRecentRow(page.thread));
        }
        // A bounded receipt cannot accidentally clear messages that arrived after this page.
        // The page's own last_message_at counts as read too: a streamed agent
        // reply keeps its first post's sent_at but indexes the final post's
        // time, and a bound below it left the open thread unread.
        const at = Math.max(0, page.thread.last_message_at ?? 0, ...page.messages.map(row => row.sent_at));
        if (page.thread.unread && at && document.visibilityState === 'visible') {
          await markThreadRead(id, { at });
          invalidateFor('thread.state');
        }
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : t('Couldn’t load this conversation.'));
      } finally {
        pendingRefresh = false;
        if (!stopped) setLoading(false);
      }
    }
    void refresh();
    // One timeout rearmed after each read rather than an interval: the cadence
    // is a second while a turn with an agent is open, four while the tab is
    // focused, thirty while it is visible behind another window, and the ref
    // lets it change between ticks without restarting this effect. A hidden
    // tab does not read at all; the visibilitychange listener below reads
    // once the moment it is shown again.
    const cadenceSeconds = () => {
      if (turnOpen.current) return AGENT_TURN_POLL_SECONDS;
      return document.hasFocus() ? THREAD_POLL_SECONDS : THREAD_BACKGROUND_POLL_SECONDS;
    };
    let timer = 0;
    const arm = () => {
      timer = window.setTimeout(async () => {
        if (document.visibilityState === 'visible') await refresh();
        if (!stopped) arm();
      }, cadenceSeconds() * 1_000);
    };
    arm();
    const attended = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', attended);
    window.addEventListener('focus', attended);
    return () => {
      stopped = true;
      if (generation.current === version) generation.current++;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', attended);
      window.removeEventListener('focus', attended);
    };
  }, [addressKey, threadID]);

  useEffect(() => {
    if (!jumpTargetID) return;
    const target = document.getElementById(`thread-message-${jumpTargetID}`);
    if (!target) return;
    target.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    setJumpTargetID(null);
  }, [jumpTargetID, messages]);

  useEffect(() => {
    const wanted = pendingFocus.current;
    if (!wanted || !thread || messages.length === 0) return;
    pendingFocus.current = undefined;
    if (wanted === 'latest') {
      const last = [...messages].reverse().find(message => !message.partial) ?? messages[messages.length - 1]!;
      setFlashID(last.id);
    } else {
      void jumpToParent(wanted).then(() => setFlashID(wanted));
    }
  }, [thread, messages]);

  useEffect(() => {
    if (!flashID) return;
    const timer = window.setTimeout(() => setFlashID(null), 2400);
    return () => window.clearTimeout(timer);
  }, [flashID]);

  async function older() {
    if (!thread || !cursor || busy) return;
    const version = generation.current;
    setBusy(true);
    try {
      const page = await apiFetch<ThreadMessagesResponse>(`/threads/${encodeURIComponent(thread.id)}/messages?before=${encodeURIComponent(cursor)}`, {
        noStore: true, fallbackError: t('Couldn’t load older messages.'),
      });
      if (version !== generation.current) return;
      merge(page.messages); setCursor(page.older_cursor); setError('');
    } catch (cause) { if (version === generation.current) setError(String(cause instanceof Error ? cause.message : cause)); }
    finally { if (version === generation.current) setBusy(false); }
  }

  async function jumpToParent(messageID: string) {
    if (!thread || busy) return;
    if (messages.some(message => message.id === messageID)) {
      followLatest.current = false;
      setJumpTargetID(messageID);
      return;
    }
    let before = cursor;
    if (!before) {
      setError(t('Couldn’t find that message.'));
      return;
    }
    const version = generation.current;
    setBusy(true);
    try {
      while (before) {
        const page: ThreadMessagesResponse = await apiFetch<ThreadMessagesResponse>(`/threads/${encodeURIComponent(thread.id)}/messages?before=${encodeURIComponent(before)}`, {
          noStore: true, fallbackError: t('Couldn’t load older messages.'),
        });
        if (version !== generation.current) return;
        before = page.older_cursor;
        setCursor(before);
        followLatest.current = false;
        merge(page.messages);
        if (page.messages.some((message: ThreadMessage) => message.id === messageID)) {
          setError('');
          setJumpTargetID(messageID);
          return;
        }
      }
      setError(t('Couldn’t find that message.'));
    } catch (cause) {
      if (version === generation.current) setError(cause instanceof Error ? cause.message : t('Couldn’t load older messages.'));
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }

  /**
   * Who this text still names — by the email's local part (`ana.silva`) or
   * the whole address, never by a display name. Read back off the finished
   * message rather than remembered as somebody types: a handle completed and
   * then deleted is not a mention. Mirrors `MentionMatching` on Mac/iOS.
   */
  function mentionsIn(text: string): string[] {
    return mentionsInText(text, mentionable);
  }

  function rememberComposerSelection(event: SyntheticEvent<HTMLTextAreaElement>) {
    composerSelection.current = {
      start: event.currentTarget.selectionStart,
      end: event.currentTarget.selectionEnd,
    };
  }

  function applyFormat(action: MessageFormatAction) {
    const field = composer.current;
    if (!field) return;
    const start = field.selectionStart;
    const end = field.selectionEnd;
    const edit = formatMessage(draft, start, end, action);
    setDraft(edit.text);
    composerSelection.current = { start: edit.selectionStart, end: edit.selectionEnd };
    returnToComposer.current = true;
  }

  function restoreComposerAfterFormat() {
    if (!returnToComposer.current) return;
    returnToComposer.current = false;
    const field = composer.current;
    if (!field) return;
    const { start, end } = composerSelection.current;
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(start, end);
    });
  }

  async function send() {
    const text = draft.trim();
    if (!thread || busy || (supportsReplies && !editing && !replyParentIsLive)) return;
    if (!text && pending.length === 0) return;
    const version = generation.current;
    setBusy(true);
    try {
      if (editing) {
        await apiFetch(`/threads/${encodeURIComponent(thread.id)}/messages/${encodeURIComponent(editing.id)}`, {
          method: 'PATCH', body: { text }, fallbackError: t('Couldn’t edit that message.'),
        });
        if (version !== generation.current) return;
        setEditing(null); setReplyingToID(null); setDraft(''); setError('');
        composerSelection.current = { start: 0, end: 0 };
        return;
      }
      const result = await apiFetch<{ message: ThreadMessage }>(`/threads/${encodeURIComponent(thread.id)}/messages`, {
        method: 'POST',
        body: {
          text,
          mentions: mentionsIn(text),
          attachments: pending.map(file => file.id),
          ...(supportsReplies && replyingToID ? { reply_to_message_id: replyingToID } : {}),
        },
        fallbackError: t('Couldn’t send. Your message is still here; try again.'),
      });
      track('Message sent');
      if (version !== generation.current) return;
      followLatest.current = true;
      merge([result.message]); setDraft(''); setPending([]); setReplyingToID(null); setError('');
      composerSelection.current = { start: 0, end: 0 };
    } catch (cause) { if (version === generation.current) setError(cause instanceof Error ? cause.message : t('Couldn’t send your message.')); }
    finally { if (version === generation.current) setBusy(false); }
  }

  function selectQuestionOption(questionID: string, question: ThreadQuestion, optionID: string, checked: boolean) {
    setQuestionSelections((current) => {
      const selected = current[questionID] ?? [];
      const next = question.mode === 'single'
        ? [optionID]
        : checked ? [...selected.filter((id) => id !== optionID), optionID] : selected.filter((id) => id !== optionID);
      return { ...current, [questionID]: next };
    });
    setQuestionErrors((current) => ({ ...current, [questionID]: '' }));
    if (question.mode === 'single' && checked) void submitQuestionAnswer(questionID, [optionID]);
  }

  async function submitQuestionAnswer(questionID: string, submittedOptionIDs?: readonly string[]) {
    if (!thread || questionSubmitting.has(questionID)) return;
    const optionIDs = submittedOptionIDs ?? questionSelections[questionID] ?? [];
    if (optionIDs.length === 0) {
      setQuestionErrors((current) => ({ ...current, [questionID]: t('Choose at least one option.') }));
      return;
    }
    const version = generation.current;
    const canonical = questionRequests[questionID];
    setQuestionSubmitting((current) => new Set(current).add(questionID));
    setQuestionErrors((current) => ({ ...current, [questionID]: '' }));
    try {
      if (canonical) {
        const result = await resolveAttention(canonical.id, { action: 'answer', option_ids: [...optionIDs] });
        if (version !== generation.current) return;
        setQuestionRequests((current) => ({ ...current, [questionID]: result.request }));
        setQuestionSelections((current) => ({ ...current, [questionID]: [] }));
        return;
      }
      const result = await apiFetch<ThreadQuestionAnswerResponse>(
        `/threads/${encodeURIComponent(thread.id)}/questions/${encodeURIComponent(questionID)}/answer`,
        { method: 'POST', body: { option_ids: optionIDs }, fallbackError: t('Couldn’t submit this answer.') },
      );
      if (version !== generation.current) return;
      merge([result.message]);
      setQuestionSelections((current) => ({ ...current, [questionID]: [] }));
    } catch (cause) {
      if (version !== generation.current) return;
      setQuestionErrors((current) => ({ ...current, [questionID]: cause instanceof Error ? cause.message : t('Couldn’t submit this answer.') }));
    } finally {
      if (version === generation.current) setQuestionSubmitting((current) => { const next = new Set(current); next.delete(questionID); return next; });
    }
  }

  /**
   * What is on the clipboard goes straight to the agent, without a stop in
   * the composer. The draft and any staged files stay where they are: this is
   * a separate message, not a paste into the one being written. A hand-off
   * carries text only, so over the limit there is nothing to send.
   */
  async function pasteAndSend() {
    if (!thread || busy) return;
    let text = '';
    try { text = (await navigator.clipboard.readText()).trim(); } catch { setError(t('Couldn’t read the clipboard.')); return; }
    if (!text) { setError(t('Nothing to paste.')); return; }
    if (text.length > MESSAGE_TEXT_MAX_CHARS) { setError(t('That is {text} characters; the limit is {MESSAGE_TEXT_MAX_CHARS}.', { text: text.length, MESSAGE_TEXT_MAX_CHARS })); return; }
    const version = generation.current;
    setBusy(true);
    try {
      const result = await apiFetch<{ message: ThreadMessage }>(`/threads/${encodeURIComponent(thread.id)}/messages`, {
        method: 'POST',
        body: { text, mentions: mentionsIn(text), attachments: [] },
        fallbackError: t('Couldn’t send.'),
      });
      track('Message sent');
      if (version !== generation.current) return;
      followLatest.current = true;
      merge([result.message]); setError('');
    } catch (cause) { if (version === generation.current) setError(cause instanceof Error ? cause.message : t('Couldn’t send.')); }
    finally { if (version === generation.current) setBusy(false); }
  }

  /** Add or remove one emoji — the same call either way. */
  async function react(message: ThreadMessage, emoji: string) {
    if (!thread) return;
    try {
      const result = await apiFetch<MessageReactionsResponse>(
        `/threads/${encodeURIComponent(thread.id)}/messages/${encodeURIComponent(message.id)}/reactions`,
        { method: 'POST', body: { emoji }, fallbackError: t('Couldn’t react to that message.') },
      );
      setMessages(current => current.map(row => (
        row.id === result.message_id ? { ...row, reactions: result.reactions } : row
      )));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('Couldn’t react to that message.')); }
  }

  async function saveAsQuickNote(message: ThreadMessage) {
    if (!message.is_mine || message.deleted_at || message.origin || !message.text.trim() || savingQuickNoteIDs.has(message.id)) return;
    setSavingQuickNoteIDs((current) => new Set(current).add(message.id));
    let capture = quickNoteCaptures.current.get(message.id);
    if (!capture) {
      capture = { id: crypto.randomUUID(), captured_at: Date.now() };
      quickNoteCaptures.current.set(message.id, capture);
    }
    try {
      await createQuickNote(message.text, 'work', null, capture);
      quickNoteCaptures.current.delete(message.id);
      toast(t('Saved to Quick Notes.'));
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : t('Couldn’t save as Quick Note'), 'danger');
    } finally {
      setSavingQuickNoteIDs((current) => { const next = new Set(current); next.delete(message.id); return next; });
    }
  }

  async function withdraw(message: ThreadMessage) {
    if (!thread) return;
    if (!await confirmDataLoss({
      title: t('Withdraw this message?'),
      body: t('The text and any files are gone. This can’t be undone.'),
      action: t('Withdraw'),
    })) return;
    try {
      await apiFetch(`/threads/${encodeURIComponent(thread.id)}/messages/${encodeURIComponent(message.id)}`, {
        method: 'DELETE', fallbackError: t('Couldn’t withdraw that message.'),
      });
      setMessages(current => current.map(row => (
        row.id === message.id ? { ...row, text: '', deleted_at: Date.now(), attachments: undefined, reactions: undefined } : row
      )));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('Couldn’t withdraw that message.')); }
  }

  /**
   * Muted for a week rather than forever: a mute with no end is a mute nobody
   * remembers setting. Same reasoning as do-not-disturb.
   */
  async function toggleMute() {
    if (!thread) return;
    const until = thread.muted_until ? null : Date.now() + 7 * 24 * 3600 * 1000;
    try {
      await setThreadMuted(thread.id, { until });
      invalidateFor('thread.state');
      setThread(current => (current ? { ...current, muted_until: until } : current));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('Couldn’t change that.')); }
  }

  /**
   * Put it away, or take it back. No confirmation and no archive to visit:
   * the conversation reopens by clicking the person, and anything said in it
   * from now on puts the row back by itself.
   */
  async function toggleArchive() {
    if (!thread) return;
    const archived = thread.archived_at === null;
    try {
      const body = await setThreadArchived(thread.id, { archived });
      invalidateFor('thread.state');
      setThread(current => (current ? { ...current, archived_at: body.archived_at } : current));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('Couldn’t change that.')); }
  }

  /**
   * Upload, then hold until a message carries it. Uploading is not sending:
   * an abandoned composer leaves rows nobody but the uploader can see.
   */
  async function attach(files: FileList | null) {
    if (!thread || !files?.length) return;
    for (const file of Array.from(files).slice(0, 10)) {
      setUploading(count => count + 1);
      try {
        const staged = await apiFetch<AttachmentStagedResponse>(`/threads/${encodeURIComponent(thread.id)}/attachments`, {
          method: 'POST',
          body: { name: file.name, content_type: file.type || 'application/octet-stream', bytes: file.size },
          fallbackError: t('Couldn’t prepare that file.'),
        });
        // The Worker hands back a path; this client already knows its origin.
        await apiUpload(staged.upload_path.replace(/^\/api/u, ''), file, 'Couldn’t upload that file.');
        setPending(current => [...current, staged.attachment]);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t('Couldn’t attach that file.'));
      } finally {
        setUploading(count => count - 1);
      }
    }
  }

  // An event signed by any roster agent folds into a trail; the set is the
  // addressed agent plus every agent a channel could name.
  const agentEmails = useMemo(
    () => new Set([...agents, ...(agent ? [agent] : [])].map((peer) => peer.email)),
    [agents, agent],
  );
  const questionAnswers = useMemo(() => new Map(
    messages.flatMap((message) => message.question_answer ? [[message.question_answer.question_message_id, message] as const] : []),
  ), [messages]);
  const rows = useMemo(() => transcriptRows(messages, unreadBoundary, agentEmails), [messages, unreadBoundary, agentEmails]);
  const addressKind = address && 'kind' in address ? address.kind : null;
  const replyThreadKind = threadID ? thread?.kind : thread?.kind ?? addressKind;
  const supportsReplies = SUBJECT_TALK_KINDS.has(replyThreadKind ?? '');
  const composerReplyID = editing?.reply_to_message_id ?? replyingToID;
  const composerReply = composerReplyID ? messages.find(message => message.id === composerReplyID) ?? null : null;
  const replyParentIsLive = !replyingToID || (composerReply?.type === 'text' && !composerReply.deleted_at && !composerReply.partial);
  const canSend = !busy && !!thread && (draft.trim().length > 0 || pending.length > 0)
    && (!supportsReplies || !!editing || replyParentIsLive);

  /** From the message menu: the menu traps focus until it closes, so the composer takes it after. */
  function selectReply(message: ThreadMessage) {
    setReplyingToID(message.id);
    messageMenu.focusAfterClose(composer.current);
  }

  /**
   * A turn in flight reads as a typing state, not a message: a transient row
   * pinned to the bottom of the transcript while the agent is working. Driven
   * entirely by the agent's presence — `busy` with a `busy_until` still in the
   * future; an elapsed TTL reads as not working, so a run that died silently
   * can never leave it stuck. It clears the moment the agent's own reply lands
   * (which lands here before the next roster poll clears `busy_until`), because
   * a text answer means the turn is over. An `event` line never ends a turn.
   */
  const lastReal = [...messages].reverse().find((message) => message.type !== 'event');
  // The agent a turn is open with: the addressed one in its DM, else the
  // roster agent my latest channel line names — or, once its answer has
  // started streaming in, the agent whose row is still being written.
  const mentionedAgent = lastReal && lastReal.is_mine
    ? agents.find((peer) => (lastReal.mentions ?? []).includes(peer.email))
    : lastReal?.partial
      ? agents.find((peer) => peer.email === lastReal.sender_email)
      : undefined;
  const awaited: Peer | undefined = agent ?? mentionedAgent;
  const agentWorking = !!awaited && awaited.status === 'busy'
    && !!awaited.busy_until && awaited.busy_until > Date.now();
  const hideSingleReactionCount = thread?.kind === 'dm';
  // Mark as decision: the line becomes a decision on the
  // channel's subject, verbatim, with the message as its source. Only a
  // subject channel has a subject to record it on.
  const decisionSubject = address && 'subject_id' in address ? { kind: address.kind, id: address.subject_id } : null;
  const isGuestThread = thread?.kind === 'guest';
  useEffect(() => {
    if (!isGuestThread || !thread) { setSupportRequests(new Map()); return; }
    let cancelled = false;
    fetchSupportRequests(thread.id).then(
      (requests) => { if (!cancelled) setSupportRequests(requests); },
      // A member who cannot see the subject's cards still reads the thread.
      () => { if (!cancelled) setSupportRequests(new Map()); },
    );
    return () => { cancelled = true; };
  }, [isGuestThread, thread?.id]);

  async function makeCard(message: ThreadMessage) {
    if (!thread) return;
    try {
      const { request } = await createSupportRequest(thread.id, message.id);
      setSupportRequests((current) => new Map(current).set(request.message_id, request));
      toast(t('Card made'));
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : t('Couldn’t make a card from that message.'), 'danger');
    }
  }

  async function markAsDecision(message: ThreadMessage) {
    if (!decisionSubject) return;
    try {
      await createDecision({ subject_kind: decisionSubject.kind, subject_id: decisionSubject.id, body: message.text, source: 'message', source_ref: message.id });
      toast(t('Recorded as a decision'));
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : t('Couldn’t record that decision.'), 'danger');
    }
  }
  /**
   * A line's menu, the Mac's (`ThreadTranscriptViews`): the reactions on
   * the line / Copy, Reply, Decide, Save as Quick Note, Edit, Withdraw. Each only
   * where the line and this conversation allow it.
   */
  function messageMenuItems(message: ThreadMessage): ReactNode {
    const reactions = quickReactionsFor(!!agent && message.sender_email === agent.email).map((emoji) => (
      <DropdownMenuItem
        key={emoji}
        aria-label={t('React with {emoji}', { emoji: reactionLabel(emoji) })}
        onSelect={() => { void react(message, emoji); }}
      ><ReactionSymbol emoji={emoji} size={14} filled />{reactionLabel(emoji)}</DropdownMenuItem>
    ));
    return <RowMenuItems kind="message" context="row" facts={{
      isMine: message.is_mine,
      isWithdrawn: !!message.deleted_at,
      isPartial: !!message.partial,
      isEvent: !!message.origin,
      hasText: !!message.text,
      isReplyable: supportsReplies && !editing,
      canDecide: !!message.text && !!decisionSubject && !message.refs?.length,
      // A line from outside on a guest thread, once: a card is the member's work.
      canMakeCard: isGuestThread && (message.origin === 'guest' || message.origin === 'peer' || message.origin === 'app')
        && !message.deleted_at && !!message.text && !supportRequests.has(message.id),
    }} run={{
      reply: () => selectReply(message),
      decide: () => { void markAsDecision(message); },
      'make-card': () => { void makeCard(message); },
      'save-note': () => { void saveAsQuickNote(message); },
      edit: () => { setReplyingToID(null); setEditing(message); setDraft(message.text); messageMenu.focusAfterClose(composer.current); },
      withdraw: () => { void withdraw(message); },
    }} render={{
      react: () => message.deleted_at || message.partial ? null : reactions,
      copy: () => message.text ? <CopyTextItem text={message.text} label={t('Copy')} copied={t('Copied')} icon={<CopyLinkIcon copied={false} />} /> : null,
    }} />;
  }
  // An agent's latest answer is the one place where acknowledgement is a
  // standing affordance. Keep its compact menu trigger visible; older rows
  // reveal the same menu on hover, focus, or touch.
  const persistentActionsMessageID = agent && lastReal
    && !lastReal.deleted_at
    && !lastReal.partial
    && lastReal.sender_email === agent.email
    && !lastReal.reactions?.some(reaction => reaction.is_mine)
    ? lastReal.id
    : null;
  // Just sent: the row shows on trust until the roster has had time to say
  // whether the runtime accepted.
  const justSent = !!lastReal && lastReal.is_mine
    && Date.now() - lastReal.sent_at < AGENT_ACCEPT_GRACE_SECONDS * 1_000;
  // A turn is open with an agent: either my line is the last real one, or the
  // agent's answer to it is still streaming. Both keep the working row, the
  // one-second poll and the roster refresh; the final answer ends all three.
  const awaitingAgent = !!awaited && !!lastReal && (lastReal.is_mine || lastReal.partial === true);
  turnOpen.current = awaitingAgent;
  const showWorking = !!awaited && (lastReal ? awaitingAgent : true) && (agentWorking || justSent);
  // The trail still being written: the agent's steps since my line, with
  // nothing final from it after them. Drawn as the working row's second line
  // rather than as a folded row of its own; it folds when the answer lands.
  const liveTrail = (() => {
    if (!showWorking) return null;
    const last = rows[rows.length - 1];
    if (last?.kind === 'trail') return last;
    // The answer may already be streaming under the steps.
    const beforeLast = rows[rows.length - 2];
    return lastReal?.partial && beforeLast?.kind === 'trail' ? beforeLast : null;
  })();
  // The clock: from acceptance once the roster has said so, from the send on
  // trust before that. One state tick a second keeps it moving.
  const workingSince = showWorking ? (awaited?.since ?? lastReal?.sent_at ?? null) : null;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (workingSince === null) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [workingSince]);
  // The row is the last line while it shows; a reader at the bottom lands on
  // it — and stays on it as steps and streamed text lengthen the page.
  const liveStep = liveTrail ? plainText(liveTrail.steps[liveTrail.steps.length - 1]!.text) : null;
  useEffect(() => {
    if (showWorking && followLatest.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [showWorking, liveStep, lastReal?.partial && lastReal.text]);
  // The roster's 30s poll is too slow to catch an agent's turn: a reply that
  // lands in a few seconds falls between two ticks and the working row never
  // shows. While a turn with an agent is open, re-read the roster on the
  // thread's own cadence; the interval ends when the agent answers.
  useEffect(() => {
    if (!awaitingAgent) return;
    void refreshPeers();
    const timer = window.setInterval(() => void refreshPeers(), THREAD_POLL_SECONDS * 1_000);
    return () => window.clearInterval(timer);
  }, [awaitingAgent]);

  // The pane as the column (Team, `fill`) stands the column's height: the
  // transcript scrolls inside it and the composer stays put. Off, it reads in
  // the page's flow, as on a subject's Talk pane. `data-thread-pane` is the
  // shell's hook (SurfaceShell, `.surface-column`).
  const headTitle = thread ? threadTitle(thread) : title ?? t('Conversation');
  return <section
    className={cn('bg-card', fill
      ? 'm-0 flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border max-[761px]:h-[min(42rem,calc(100dvh-7rem))] max-[761px]:min-h-72'
      : 'my-6 rounded-md p-4')}
    data-thread-pane={fill ? 'fill' : 'flow'}
    aria-label={title ?? 'Conversation'}
  >
    <header className={cn('flex items-baseline justify-between gap-3', fill && 'flex-none border-b border-border bg-popover px-4 py-[.9rem]')}>
      <h2 className="m-0 min-w-0">{onOpenPerson
        ? <Button
          type="button"
          variant="link"
          className="h-auto max-w-full justify-start p-0 text-left text-[length:inherit] font-[number:inherit] whitespace-normal text-foreground"
          aria-label={t('About {name}', { name: headTitle })}
          onClick={onOpenPerson}
        >{headTitle}</Button>
        : headTitle}</h2>
      <div className="inline-flex flex-none items-center gap-[.35rem]">
        {thread && <FavoriteToggle kind="meet.thread" targetRef={thread.id} />}
        {thread?.inbound_address && <InboundAddressButton address={thread.inbound_address} />}
        {/* Only a private conversation can be put away. A channel is a place,
            and leaving one is a different verb than filing one. */}
        {thread?.kind === 'dm' && <Tip label={thread.archived_at ? t('Keep in chat') : t('Archive')}><Button
          type="button"
          variant="ghost" size="icon-sm" className="aria-pressed:bg-accent"
          aria-label={thread.archived_at ? t('Keep in chat') : t('Archive')}
          aria-pressed={Boolean(thread.archived_at)}
          onClick={() => void toggleArchive()}
        >
          <ArchiveIcon />
        </Button></Tip>}
        {thread && <Tip label={thread.muted_until ? t('Unmute') : t('Mute')}><Button
          type="button"
          variant="ghost" size="icon-sm" className="aria-pressed:bg-accent"
          aria-label={thread.muted_until ? t('Unmute') : t('Mute')}
          aria-pressed={Boolean(thread.muted_until)}
          onClick={() => void toggleMute()}
        >
          <MuteIcon muted={Boolean(thread.muted_until)} />
        </Button></Tip>}
        {sidebarToggle && <RightSidebarSlot />}
        {onClose && <Tip label={t('Close conversation')}><Button
          type="button"
          variant="ghost" size="icon-sm" className="aria-pressed:bg-accent"
          aria-label={t('Close conversation')}
          onClick={onClose}
        >
          <CloseIcon />
        </Button></Tip>}
      </div>
    </header>
    {agent?.manifest && !fill && <AgentManifestCard peer={agent} />}
    {error && <ErrorNotice className={cn(fill && 'mx-4 flex-none')} message={error} />}
    {loading && <PlaceholderRows label={t('Opening…')} className={cn(fill && 'mx-4 flex-none')} />}
    {cursor && <Button variant="secondary" disabled={busy} onClick={() => void older()}>{t('Older messages')}</Button>}
    {/* shadcn ScrollArea (meet#446). Following the latest line and loading
        older pages stay ours: `scroll` is the viewport, and a scroll event
        is caught on the way down to it. In the column a short conversation
        sits at the composer: the viewport's content box is a flex column at
        least as tall as the viewport (Radix draws it `display: table`, hence
        the `!`), and the list takes the slack above it. */}
    <ScrollArea
      ref={bindScroll}
      onScrollCapture={() => { const el = scroll.current; if (el) followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
      className={cn('my-[1em]', fill
        ? 'min-h-0 flex-1 [&>[data-slot=scroll-area-viewport]]:overscroll-contain [&>[data-slot=scroll-area-viewport]>div]:flex! [&>[data-slot=scroll-area-viewport]>div]:min-h-full [&>[data-slot=scroll-area-viewport]>div]:flex-col'
        : '[&>[data-slot=scroll-area-viewport]]:max-h-[55vh]')}
    >
    {/* In the column the card is the conversation's first item: it stays at
        the top of the transcript and scrolls with it (MZ, 2026-10-06: keep it
        after the first message). Pinned above the scroll, a long manifest took
        the whole column and clipped the messages and the composer (meet#489).
        Drawn once the oldest page is loaded, so it never sits above a gap. */}
    {agent?.manifest && fill && !loading && !cursor && <AgentManifestCard peer={agent} className="mx-4" />}
    <ol
      className={cn('m-0 list-none p-0', fill && 'mt-auto flex flex-col px-4 pt-1 pb-4')}
      aria-label={t('Messages')}
    >
      {rows.map((row, index) => {
        // Dividers are a labelled Separator. The unread rule is
        // deliberately loud: it is the line somebody scrolls to find.
        if (row.kind === 'day') {
          return <li key={`day-${row.at}`} className={DIVIDER}>
            <span>{dayTitle(row.at)}</span>
            <Separator className="flex-1 data-[orientation=horizontal]:w-auto" />
          </li>;
        }
        if (row.kind === 'unread') {
          return <li key={`unread-${index}`} className={cn(DIVIDER, 'text-foreground')}>
            <Separator className="flex-1 bg-current data-[orientation=horizontal]:w-auto" />
            <span>{t('New')}</span>
          </li>;
        }
        if (row.kind === 'trail') {
          // The live trail is the working row's own line, not a row here.
          if (row === liveTrail) return null;
          const id = row.steps[0]!.id;
          const open = openTrails.has(id);
          const count = row.steps.length;
          const toggle = () => setOpenTrails((current) => {
            const next = new Set(current);
            if (open) next.delete(id); else next.add(id);
            return next;
          });
          // shadcn Collapsible; the chevron is the shared glyph, not a text triangle.
          return <Collapsible asChild key={`trail-${id}`} open={open} onOpenChange={toggle}>
            <li className="py-1 text-[.8rem] text-muted-foreground">
              <CollapsibleTrigger className="inline-flex cursor-pointer appearance-none items-center gap-1.5 border-0 bg-transparent px-0 py-0.5 text-inherit hover:text-foreground">
                <span className="inline-flex transition-transform duration-100 in-data-[state=closed]:-rotate-90 motion-reduce:transition-none" aria-hidden="true"><SharedChevronIcon /></span>
                {plural(count, { one: '{count} step', other: '{count} steps' })}
              </CollapsibleTrigger>
              <CollapsibleContent asChild>
                <ol className="mt-0.5 mb-1 flex list-none flex-col gap-1 ps-[1.15rem]">
                  {row.steps.map((step) => <li key={step.id} className="flex justify-between gap-3">
                    <span>{step.text}</span>
                    <time className="flex-none text-xs tabular-nums opacity-70" dateTime={new Date(step.sent_at).toISOString()}>{formatTime(new Date(step.sent_at))}</time>
                  </li>)}
                </ol>
              </CollapsibleContent>
            </li>
          </Collapsible>;
        }
        if (row.kind === 'event') {
          // A muted Item row; each ref is a chip, not a second sentence. One
          // that opens something reads as a link (accent ink, a tooltip naming
          // where it goes): a grey chip was not read as pressable.
          const refs = onOpenRef ? row.message.refs ?? [] : [];
          return <ThreadEventRow key={row.message.id} text={row.message.text} actions={refs.length > 0 ? <>
                {refs.map((ref) => refOpens(ref) ? (
                  <Button
                    key={`${ref.kind}:${ref.id}`}
                    type="button"
                    variant="outline" size="xs"
                    className="rounded-full text-(--accent-mark) underline-offset-2 hover:text-(--accent-mark) hover:underline"
                    title={refOpenLabel(ref)}
                    aria-label={refOpenLabel(ref)}
                    onClick={() => onOpenRef!(ref)}
                  >{refTitle(ref)}</Button>
                ) : (
                  <Badge key={`${ref.kind}:${ref.id}`} variant="outline" className="h-6 rounded-full font-normal text-muted-foreground">{refTitle(ref)}</Badge>
                ))}
              </> : undefined} />;
        }
        const { message, grouped } = row;
        // Theirs on the left behind a face, yours on the right with none — you
        // know who you are. Grouped lines keep the avatar's indent so the text
        // stays under the text above it rather than under the picture.
        // A turn, not a row: a new turn gets a clear gap above it and a
        // following line from the same person a small one.
        // Still being written (partial): the bubble is dashed, and nothing on
        // it — no Copy, no reaction, no "edited" — pretends it is finished.
        const parent = message.reply_to_message_id
          ? messages.find(candidate => candidate.id === message.reply_to_message_id) ?? null
          : null;
        const canShowMessageMenu = !message.deleted_at && !message.partial;
        const menuItems = canShowMessageMenu ? messageMenuItems(message) : null;
        const menuRow = menuItems ? messageMenu.rowProps(message.id) : null;
        return <MessageTurn
          key={message.id}
          id={`thread-message-${message.id}`}
          data-message=""
          data-flash={message.id === flashID ? '' : undefined}
          {...menuRow}
          mine={message.is_mine}
          grouped={grouped}
          avatar={<ThreadAvatar email={message.sender_email} name={message.sender_name ?? message.sender_email} />}
        >
            {!grouped && <MessageHead
              sender={message.is_mine ? null : message.sender_name ?? message.sender_email.split('@')[0]!}
              sentAt={message.sent_at}
              notes={[
                message.edited_at !== undefined && !message.deleted_at && 'edited',
                message.origin === 'slack' && t('from Slack'),
                message.origin === 'guest' && t('guest'),
                message.origin === 'peer' && t('outside organization'),
                message.origin === 'app' && t('from the app'),
                supportRequests.has(message.id) && t('card made'),
                message.via && t('via {client}', { client: message.via }),
              ]}
            />}
            {supportsReplies && message.reply_to_message_id && <ReplyPreview
              message={parent}
              onJump={() => void jumpToParent(message.reply_to_message_id!)}
            />}
            <MessageBubble
              mine={message.is_mine}
              partial={message.partial}
              withdrawn={Boolean(message.deleted_at)}
              text={message.text}
              mentions={message.mentions ?? []}
              focusable={canShowMessageMenu}
            />
            {message.question && !message.deleted_at && (() => {
              const answer = questionAnswers.get(message.id);
              const request = questionRequests[message.id];
              const recipient = ownerSession.kind === 'owner' ? ownerSession.owner.email.toLowerCase() : null;
              return <QuestionCard
                askedBy={messageSenderName(message)}
                mode={message.question.mode}
                options={message.question.options}
                status={request ? attentionStatus(request) : null}
                waitingFor={request?.state === 'open' && recipient !== request.recipient_email.toLowerCase() ? request.recipient_email : null}
                disabled={!questionsLoaded}
                answer={request ? (request.answer ? { by: request.answer.answered_by_email, labels: request.answer.option_labels, withdrawn: false } : null)
                  : answer?.question_answer ? { by: messageSenderName(answer), labels: answer.question_answer.option_labels, withdrawn: Boolean(answer.deleted_at) } : null}
                selected={questionSelections[message.id] ?? []}
                submitting={questionSubmitting.has(message.id)}
                error={questionErrors[message.id] ?? ''}
                onSelect={(optionID, checked) => selectQuestionOption(message.id, message.question!, optionID, checked)}
                onSubmit={() => void submitQuestionAnswer(message.id)}
              />;
            })()}
            {message.release_request && !message.deleted_at && <ReleaseRequestCard
              askedBy={messageSenderName(message)}
              request={message.release_request}
              state={message.release_state ?? null}
              now={Date.now()}
            />}
            {!message.deleted_at && (
              <MessageLinkPreview text={message.text} loader={ownerPreviewLoader} />
            )}
            {!message.deleted_at && message.attachments?.map(file => (
              <ThreadAttachment key={file.id} threadID={thread?.id ?? ''} file={file} />
            ))}
            {(message.reactions?.length ?? 0) > 0 && <ul className="my-1 flex list-none flex-wrap gap-1 p-0">
              {message.reactions!.map(reaction => (
                <li key={reaction.emoji}>
                  <Button
                    type="button"
                    variant={reaction.is_mine ? 'secondary' : 'outline'} size="xs" className="rounded-full"
                    onClick={() => void react(message, reaction.emoji)}
                  ><ReactionSymbol emoji={reaction.emoji} size={14} filled />{(!hideSingleReactionCount || reaction.count > 1) && ` ${reaction.count}`}</Button>
                </li>
              ))}
            </ul>}
            {/* The `…` hides until the row is hovered or focused: a transcript
                where every line carries buttons is a toolbar with sentences in
                it. An agent's latest answer keeps it, in the accent. */}
            {menuItems && <div className="mt-1 flex">
              {messageMenu.panel(message.id, menuItems, {
                className: message.id === persistentActionsMessageID ? 'opacity-100 text-[var(--accent-mark,var(--accent))]' : undefined,
              })}
            </div>}
        </MessageTurn>;
      })}
      {/* An agent's turn in flight: a muted Item pinned to the bottom,
          replaced the moment the real reply lands. Not a bubble. */}
      {showWorking && awaited && <AgentWorkingRow
        name={peerShortName(awaited)}
        elapsed={workingSince !== null ? elapsedLabel(workingSince) : null}
        step={liveStep}
      />}
    </ol>
    </ScrollArea>
    {!loading && thread && !messages.length && <p className={cn(fill && 'mx-4 text-muted-foreground')}>{t('No messages yet.')}</p>}
    {(pending.length > 0 || uploading > 0) && <ul className={cn('my-1 flex list-none flex-wrap items-center gap-1 p-0', fill && 'mx-4')} aria-label={t('Files to send')}>
      {pending.map(file => (
        <li key={file.id}>
          <Badge variant="outline" className="gap-0.5 py-0 pe-0">
            {file.name}
            <Button
              type="button" variant="ghost" size="icon-xs" className="rounded-full"
              aria-label={t('Remove {name}', { name: file.name })}
              onClick={() => setPending(current => current.filter(row => row.id !== file.id))}
            ><CloseIcon /></Button>
          </Badge>
        </li>
      ))}
      {uploading > 0 && <li><span className="text-xs text-muted-foreground">{t('Uploading…')}</span></li>}
    </ul>}
    {/* Attach, the field as a pill, send: one row, bottom-aligned so the
        buttons stay by the last line while the field grows. */}
    <form className={cn('flex flex-wrap items-end gap-2', fill && 'mt-auto flex-none border-t border-border bg-popover px-3 py-[.6rem]')} onSubmit={event => { event.preventDefault(); void send(); }}>
      {supportsReplies && composerReplyID && <div className="flex min-w-0 flex-[1_0_100%] items-center gap-2">
        <span className="flex-none text-[.78rem] text-muted-foreground">{t('Replying to {name}', {
          name: composerReply ? messageSenderName(composerReply) : t('Earlier message'),
        })}</span>
        <ReplyPreview className="flex-[1_1_auto]" message={composerReply} onJump={() => void jumpToParent(composerReplyID)} />
        {editing
          ? <span className="flex-[1_0_100%] text-[.78rem] text-muted-foreground">{t('Editing keeps this reply attached.')}</span>
          : <Tip label={t('Cancel reply')}><Button
            type="button"
            variant="ghost" size="icon-sm" className="flex-none"
            aria-label={t('Cancel reply')}
            onClick={() => setReplyingToID(null)}
          ><CloseIcon /></Button></Tip>}
        {replyingToID && !replyParentIsLive && <span className="flex-[1_0_100%] text-[.78rem] text-muted-foreground" role="status">{t('This message can no longer be replied to.')}</span>}
      </div>}
      {/* The icons are 32px on a 36px field and the form aligns bottoms: mb-0.5
          puts their centre on the field's, with the placeholder and send (meet#1170). */}
      {/* shadcn: the attach Button is this label, so it opens the hidden file input */}
      <Tip label={t('Attach')}><Button asChild variant="ghost" size="icon-sm" className="mb-0.5 flex-none cursor-pointer"><label aria-label={t('Attach')}>
        <PlusIcon />
        <input type="file" multiple hidden onChange={event => { void attach(event.target.files); event.target.value = ''; }} />
      </label></Button></Tip>
      {/* An agent is the one correspondent that is mostly handed things: a
          log, a draft, a link. One press, no stop in the composer. */}
      {agent && !editing && <Tip label={t('Paste and send')}><Button
        type="button"
        variant="ghost" size="icon-sm" className="mb-0.5 flex-none cursor-pointer aria-pressed:bg-accent"
        aria-label={t('Paste and send')}
        disabled={busy || !thread}
        onClick={() => void pasteAndSend()}
      ><PasteIcon /></Button></Tip>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="mb-0.5 h-8 min-w-8 flex-none px-1 text-xs font-semibold text-muted-foreground aria-expanded:text-foreground"
            aria-label={t('Format message')}
            title={t('Format message')}
            disabled={busy || !thread}
          ><Type aria-hidden="true" size={16} strokeWidth={1.8} /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="top"
          onCloseAutoFocus={event => {
            if (!returnToComposer.current) return;
            event.preventDefault();
            restoreComposerAfterFormat();
          }}
        >
          <DropdownMenuItem onSelect={() => applyFormat('bold')}>{t('Bold')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => applyFormat('italic')}>{t('Italic')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => applyFormat('strikethrough')}>{t('Strikethrough')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => applyFormat('inlineCode')}>{t('Inline code')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => applyFormat('link')}>{t('Link')}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => applyFormat('bulletedList')}>{t('Bulleted list')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => applyFormat('numberedList')}>{t('Numbered list')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => applyFormat('quote')}>{t('Quote')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => applyFormat('codeBlock')}>{t('Code block')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* The send button lives inside the pill, on its right edge, at any
          width (meet#621): it rides the textarea's corner rather than
          sitting beside it where a narrow row can wrap it. */}
      <div className="relative min-w-0 flex-1">
      <Textarea
        className={composerFieldClass}
        aria-label={editing ? t('Edit message') : t('Message')}
        placeholder={editing ? t('Edit message') : `Message ${thread ? threadTitle(thread) : title ?? ''}`.trimEnd()}
        value={draft}
        onChange={event => { setDraft(event.target.value); rememberComposerSelection(event); }}
        onSelect={rememberComposerSelection}
        onKeyUp={rememberComposerSelection}
        onClick={rememberComposerSelection}
        onFocus={rememberComposerSelection}
        onKeyDown={event => {
          // Enter sends, Shift-Enter is a newline — the convention every other
          // message box already taught people.
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
          if (event.key === 'Escape' && editing) { setEditing(null); setDraft(''); }
        }}
        maxLength={MESSAGE_TEXT_MAX_CHARS}
        disabled={busy || !thread}
        // One line until the draft needs more: the box grows with the text
        // and `rows` is only where it starts.
        rows={1}
        ref={composer}
      />
      <Tip label={editing ? t('Save') : t('Send')}><Button
        size="icon"
        className={composerSendClass}
        disabled={!canSend}
        type="submit"
        aria-label={busy ? t('Working') : editing ? t('Save') : t('Send')}
      >
        <SendIcon />
      </Button></Tip>
      </div>
      {editing && <Button type="button" variant="ghost" size="sm" onClick={() => { setEditing(null); setReplyingToID(null); setDraft(''); }}>{t('Cancel')}</Button>}
    </form>
  </section>;
}

/**
 * An agent's self-reported manifest, drawn read-only at the top of the
 * conversation with it — the web analogue of the Mac empty-state card and the
 * inspector ABOUT block. Every string is the runtime's own words rendered as a
 * text node, so React escapes it: it is data from a sandbox, never markup and
 * never an instruction. The links are the clamped http(s) URLs from the
 * contract, opened in a new tab with `noopener`.
 */
function AgentManifestCard({ peer, className }: { peer: Peer; className?: string }) {
  const manifest = peer.manifest;
  if (!manifest) return null;
  const links = agentManifestLinks(manifest);
  // The front door says what it can do and what it reaches for. Connections
  // and schedules stay on the Team page — a card is not a datasheet.
  return (
    <Card role="region" className={cn('my-3 gap-0 rounded-[10px] px-4 py-[.85rem] shadow-none', className)} aria-label={`About ${peerDisplayName(peer)}`}>
      {peer.activity && (
        <ul className="m-0 mb-[.6rem] grid list-none gap-0.5 p-0 text-[.9rem]">
          {agentActivityLines(peer.activity).map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
      <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{manifest.description}</p>
      {manifest.model && <p className="mt-[.3rem] mb-0 text-[.85rem] text-muted-foreground">{t('Runs on {model}', { model: manifest.model })}</p>}
      <AgentManifestList title={t('What it can do')} entries={(manifest.skills ?? []).map((skill) => ({ name: skill.name, detail: skill.description }))} />
      <AgentManifestList title={t('Tools')} entries={(manifest.tools ?? []).map(agentToolEntry)} />
      {links.length > 0 && (
        // The accent as ink, the Mac's `accentMark`: `a` takes it from here.
        <p className="mt-[.6rem] mb-0 flex gap-4 text-[.85rem] text-[var(--accent-mark,var(--text))]">
          {links.map((link) => <a key={link.title} href={link.url} target="_blank" rel="noreferrer noopener">{link.title}</a>)}
        </p>
      )}
    </Card>
  );
}

/** A list of agent tiles: skills, tools, docs. */
export const agentTilesClass = 'm-0 grid list-none gap-1.5 p-0';

/**
 * An agent tile: the Home row's shell (`homeRowClass`) with a name over its
 * description. The row's one-line ellipsis is for a list you scan; a
 * description is read whole, so the tile lets both wrap.
 */
export const agentTileClass = cn(homeRowClass, 'block border');

/** A tile's quiet line: the description, where a doc lives. */
export const agentTileDetailClass = 'mt-1 block text-xs text-muted-foreground [overflow-wrap:anywhere]';

/**
 * One skill or tool: the name with a chevron, unfolding to its description.
 * A shadcn Collapsible, as the agent card's other folds are: the trigger
 * carries aria-expanded, and the chevron turns with its state.
 */
export function AgentTile({ entry }: { entry: { name: string; detail?: string } }) {
  if (!entry.detail) {
    return <div className={agentTileClass}><strong className="text-sm font-[560] text-foreground [overflow-wrap:anywhere]">{entry.name}</strong></div>;
  }
  return (
    <Collapsible className={cn(agentTileClass, 'group/tile')}>
      <CollapsibleTrigger className="-m-3 flex w-[calc(100%+1.5rem)] cursor-pointer items-baseline gap-2 rounded-md border-0 bg-transparent p-3 text-left text-sm font-[560] hover-lift text-foreground [overflow-wrap:anywhere]">
        <strong className="min-w-0 flex-1 font-[inherit]">{entry.name}</strong>
        <ChevronIcon />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <small className={agentTileDetailClass}>{entry.detail}</small>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ChevronIcon() {
  return (
    <svg className="flex-none text-muted-foreground transition-transform duration-[160ms] group-open/tile:rotate-90 motion-reduce:transition-none" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** One eyebrow and its entries on the agent card. Nothing when the list is empty. */
function AgentManifestList({ title, entries }: { title: string; entries: { name: string; detail?: string }[] }) {
  if (entries.length === 0) return null;
  return (
    <>
      <h3 className="mt-3 mb-[.35rem] text-[.72rem] tracking-[.06em] text-muted-foreground uppercase">{title}</h3>
      <ul className={agentTilesClass}>
        {entries.map((entry) => (
          <li key={entry.name}>
            <AgentTile entry={entry} />
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Somebody's face beside their first line, or their initials.
 *
 * The initials are not a placeholder: they are what a person without a picture
 * looks like, so they stay underneath and a picture that never arrives changes
 * nothing. An ordinary same-origin `<img>` rather than a fetch into a blob —
 * the member cookie rides along and the browser caches it. No `v` here: the
 * transcript knows a sender's address, not the roster's version for it, so the
 * Worker's own short cache window is what keeps this cheap.
 */
function ThreadAvatar({ email, name }: { email: string; name: string }) {
  return <ThreadAvatarFace name={name.trim() || email} src={`${apiBase}/avatar?email=${encodeURIComponent(email)}`} />;
}

/**
 * One attachment. A picture is drawn; anything else is a link that downloads.
 *
 * The bytes are an authenticated read, so a plain `<img src>` would be refused
 * — which is the point: an attachment is private to the members of its
 * conversation and its URL can never be passed on. The object URL is revoked
 * when the row goes.
 */
function ThreadAttachment({ threadID, file }: { threadID: string; file: ThreadMessageAttachment }) {
  const [source, setSource] = useState<string | null>(null);
  const isImage = file.content_type.startsWith('image/');

  useEffect(() => {
    if (!isImage || !threadID) return;
    let url: string | null = null;
    let stopped = false;
    void apiObjectURL(`/threads/${encodeURIComponent(threadID)}/attachments/${encodeURIComponent(file.id)}`)
      .then(created => {
        if (stopped) { if (created) URL.revokeObjectURL(created); return; }
        url = created;
        setSource(created);
      });
    return () => { stopped = true; if (url) URL.revokeObjectURL(url); };
  }, [threadID, file.id, isImage]);

  if (!isImage) {
    return <Card className="my-1 w-fit max-w-full flex-row items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground shadow-none [overflow-wrap:anywhere]">
      {file.name} · {Math.max(1, Math.round(file.bytes / 1024))} KB
    </Card>;
  }
  // The box is reserved from the size the uploader measured, so the transcript
  // does not reflow — and throw away the scroll position — as pictures land.
  return <Card className="my-1 w-fit max-w-[min(320px,100%)] gap-0 overflow-hidden rounded-lg p-0 shadow-none">
    <img
      className="block h-auto max-w-full"
      src={source ?? undefined}
      alt={file.name}
      width={file.width}
      height={file.height}
      style={file.width && file.height ? { aspectRatio: `${file.width} / ${file.height}` } : undefined}
    />
  </Card>;
}

/**
 * The channel's forwarding address, one tap to copy. The address
 * is the tooltip, so it can be read without copying; the check is the only
 * confirmation, a toast for a clipboard write is noise.
 */
function InboundAddressButton({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1_600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <Tip label={copied ? t('Copied') : t('Forward email to {address}', { address })}><Button
    type="button"
    variant="ghost" size="icon-sm" className="aria-pressed:bg-accent"
    aria-label={t('Copy forwarding address {address}', { address })}
    onClick={() => {
      void navigator.clipboard?.writeText(address).then(() => setCopied(true));
    }}
  >
    {copied ? <CopyLinkIcon copied /> : <MailIcon />}
  </Button></Tip>;
}
