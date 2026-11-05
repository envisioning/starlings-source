import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useChat, useMaybeLayoutContext } from '@livekit/components-react';
import type { ReceivedChatMessage } from '@livekit/components-react';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';
import { cn } from '@/lib/utils';
import { CloseIcon, SendIcon } from './action-icons';
import { composerFieldPadding, composerSendClass } from './composer-send';
import { ChatMessageReactions } from './meeting-chat-reactions';
import { isMeetingDebugReport } from './meeting-debug-report';
import { formatTime } from './meeting-time';
import { t } from './i18n';

/**
 * In-meeting chat: our own message list and a shadcn Textarea composer
 *, on LiveKit's `useChat`. It replaces LiveKit's `<Chat>` prefab,
 * which could not take a row with reactions under it except by cloning.
 *
 * The panel stays mounted while it is hidden. `useChat` only hears messages
 * while something subscribes, and the unread count on the Chat button is
 * worked out here, the same way the prefab did it.
 */
export function MeetingChat({ open, formatMessage }: {
  open: boolean;
  /** How a message body renders: Markdown plus link previews. */
  formatMessage: (text: string) => ReactNode;
}) {
  const { chatMessages, send, isSending } = useChat();
  const layout = useMaybeLayoutContext();
  const list = useRef<HTMLUListElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  const lastReadAt = useRef(0);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [chatMessages, open]);

  // Unread count on the Chat button. While the panel is open every message
  // is read; while it is shut, the count is what arrived after the last read.
  const widget = layout?.widget;
  useEffect(() => {
    if (!widget || chatMessages.length === 0) return;
    const newest = chatMessages[chatMessages.length - 1].timestamp;
    if (widget.state?.showChat && lastReadAt.current !== newest) {
      lastReadAt.current = newest;
      return;
    }
    const unread = chatMessages.filter((message) => !lastReadAt.current || message.timestamp > lastReadAt.current).length;
    if (unread > 0 && widget.state?.unreadMessages !== unread) {
      widget.dispatch?.({ msg: 'unread_msg', count: unread });
    }
  }, [chatMessages, widget]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || isSending) return;
    await send(text);
    setDraft('');
    field.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Meeting shortcuts listen on the document; typed text is not a shortcut.
    event.stopPropagation();
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <aside
      // Floats over the stage, pinned to its bottom-right corner, so the
      // video underneath never moves. A sheet over the stage on a phone.
      className="absolute right-4 bottom-4 z-4 grid h-[min(560px,calc(100%-32px))] min-h-0 w-[min(360px,calc(100%-32px))] grid-rows-[52px_1fr_auto] overflow-hidden rounded-[14px] border border-border bg-[color-mix(in_srgb,var(--surface-sunken)_92%,transparent)] shadow-[0_18px_40px_rgba(0,0,0,0.45)] backdrop-blur-[18px] duration-150 animate-in fade-in-0 slide-in-from-bottom-2 motion-reduce:animate-none max-[600px]:inset-2 max-[600px]:h-auto max-[600px]:w-auto max-[600px]:max-w-none"
      style={{ display: open ? undefined : 'none' }}
      aria-label={t('Messages')}
    >
      <header className="relative flex items-center justify-center border-b px-3 text-sm font-medium">
        {t('Messages')}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute right-2 text-muted-foreground"
          aria-label={t('Close')}
          onClick={() => widget?.dispatch?.({ msg: 'toggle_chat' })}
        >
          <CloseIcon />
        </Button>
      </header>
      <ul ref={list} className="m-0 flex min-h-0 list-none flex-col gap-1 overflow-y-auto p-1">
        {chatMessages.map((message) => (
          <MeetingChatEntry key={message.id} entry={message} formatMessage={formatMessage} />
        ))}
      </ul>
      <form className="flex items-end gap-2 border-t p-3" onSubmit={(event) => void submit(event)}>
        <div className="relative min-w-0 flex-1">
        <Textarea
          ref={field}
          rows={1}
          value={draft}
          disabled={isSending}
          placeholder={t('Message')}
          aria-label={t('Message')}
          className={cn('max-h-32 min-h-9 w-full resize-none rounded-[1.125rem] py-1.5 pl-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', composerFieldPadding)}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onKeyUp={(event) => event.stopPropagation()}
        />
        <Button type="submit" size="icon" className={composerSendClass} aria-label={t('Send')} disabled={isSending || !draft.trim()}>
          <SendIcon />
        </Button>
        </div>
      </form>
    </aside>
  );
}

/**
 * One chat message: who and when, the body as a bubble, and the reaction
 * pills under it. A debug report stays plain text, exactly as sent.
 */
function MeetingChatEntry({ entry, formatMessage }: {
  entry: ReceivedChatMessage;
  formatMessage: (text: string) => ReactNode;
}) {
  const local = entry.from?.isLocal ?? false;
  const who = entry.from?.name ?? entry.from?.identity ?? '';
  const isDebugReport = isMeetingDebugReport(entry.message);
  return (
    <li className="group/entry mx-1 flex flex-col gap-1 last:mb-1">
      <span className="mt-2 flex px-1 text-xs whitespace-nowrap text-muted-foreground">
        <strong className="min-w-0 truncate font-medium">{who}</strong>
        <span className="ml-auto self-end pl-2 tabular-nums">
          {entry.editTimestamp ? `${t('edited')} ` : ''}
          {formatTime(new Date(entry.timestamp))}
        </span>
      </span>
      <div
        className={cn(
          'meeting-chat-body w-fit max-w-[calc(100%-32px)] rounded-[15px] px-3 py-1 break-words text-foreground',
          local ? 'bg-[color-mix(in_srgb,var(--surface-raised)_60%,var(--ink)_40%)]' : 'bg-[var(--surface-raised)]',
        )}
      >
        {isDebugReport
          ? <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.message}</span>
          : formatMessage(entry.message)}
      </div>
      <ChatMessageReactions messageID={entry.id} />
    </li>
  );
}
