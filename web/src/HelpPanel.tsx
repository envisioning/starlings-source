import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HelpConversation, HelpResponse, HelpStatusResponse, SupportConversationState } from '@starlings/contracts';
import { HELP_PAGES, helpPath } from '@starlings/contracts/help';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/sheet';
import { Textarea } from '@/ui/textarea';
import { meetBuild, meetVersion } from 'virtual:meet-version';
import { apiFetch } from './api';
import { ErrorNotice } from './ErrorNotice';
import { recentRequestId } from './help-bus';
import { formatTime } from './meeting-time';
import { t } from './i18n';

/*
 * Help (#995, #996): one panel on every member page. Help for the
 * page you are on, search of /help, your conversations with Starlings
 * support and what is new. The conversations travel to hq over the support
 * line; this panel only reads and writes `/api/help`.
 */

const STATE_LABEL: Record<SupportConversationState, () => string> = {
  open: () => t('Open'),
  waiting: () => t('Waiting on you'),
  resolved: () => t('Resolved'),
};

export default function HelpPanel({ pageHelpHref, open, conversationId, onOpenChange, onChanged }: {
  pageHelpHref: string;
  open: boolean;
  /** The conversation to show when the panel opens; null shows the list. */
  conversationId: string | null;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [openConversation, setOpenConversation] = useState<string | null>(conversationId);
  useEffect(() => { if (open) setOpenConversation(conversationId); }, [open, conversationId]);
  const [help, setHelp] = useState<HelpResponse | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    apiFetch<HelpResponse>('/help', { fallbackError: t('Couldn’t reach Starlings support.') }).then(
      (answer) => { setHelp(answer); setError(''); },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : t('Couldn’t reach Starlings support.')),
    );
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);

  const conversation = help?.conversations.find((row) => row.id === openConversation) ?? null;

  // Reading a conversation clears its unread reply, here and in INBOX.
  useEffect(() => {
    if (!conversation?.unread) return;
    apiFetch<HelpStatusResponse>(`/help/${encodeURIComponent(conversation.id)}/seen`, { method: 'POST', body: {}, fallbackError: '' })
      .then(() => { onChanged(); load(); }, () => {});
  }, [conversation?.id, conversation?.unread, onChanged, load]);

  return (
    <Sheet open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) onChanged(); }}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b border-border">
          <SheetTitle>{t('Help')}</SheetTitle>
          <SheetDescription className="sr-only">{t('Help for this page, and your conversations with Starlings support.')}</SheetDescription>
        </SheetHeader>
        <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto p-4">
          {error && <ErrorNotice message={error} inline />}
          {conversation
            ? <ConversationView conversation={conversation} onBack={() => setOpenConversation(null)} onSent={(answer) => { setHelp(answer); onChanged(); }} />
            : <>
              <HelpSearch pageHelpHref={pageHelpHref} />
              {help?.available !== false && (
                <section className="grid gap-2" aria-label={t('Starlings support')}>
                  <h3 className="m-0 text-sm font-semibold">{t('Starlings support')}</h3>
                  <NewConversation disabled={!help} onSent={(answer, id) => { setHelp(answer); onChanged(); if (id) setOpenConversation(id); }} />
                  {help && help.conversations.length > 0 && (
                    <ul className="m-0 grid list-none gap-1 p-0">
                      {help.conversations.map((row) => <ConversationRow key={row.id} conversation={row} onOpen={() => setOpenConversation(row.id)} />)}
                    </ul>
                  )}
                </section>
              )}
              <section className="grid gap-1.5" aria-label={t('What’s new')}>
                <h3 className="m-0 text-sm font-semibold">{t('What’s new')}</h3>
                <a className="text-[13px] text-(--accent-ink) underline-offset-2 hover:underline" href="/changelog">{t('See what changed in Starlings')}</a>
              </section>
            </>}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function firstWords(text: string): string {
  const line = text.split('\n')[0]!.trim();
  return line.length > 80 ? `${line.slice(0, 80).trimEnd()}…` : line;
}

function ConversationRow({ conversation, onOpen }: { conversation: HelpConversation; onOpen: () => void }) {
  const first = conversation.lines[0]!;
  return (
    <li>
      <Button type="button" variant="ghost" onClick={onOpen} className="grid h-auto w-full justify-items-stretch gap-0.5 rounded-md px-2 py-1.5 text-left font-normal whitespace-normal hover-lift">
        <span className="flex items-center gap-2 text-[13px] font-medium">
          {conversation.unread && <span className="size-2 flex-none rounded-full bg-(--accent)" aria-label={t('New reply')} />}
          <span className="min-w-0 flex-1 truncate">{firstWords(first.text)}</span>
          <Badge variant={conversation.state === 'resolved' ? 'secondary' : 'outline'}>{STATE_LABEL[conversation.state]()}</Badge>
        </span>
        <span className="text-xs text-muted-foreground">
          {conversation.started_by_me ? '' : `${first.sender_name} · `}{formatTime(new Date(conversation.last_at))}
        </span>
      </Button>
    </li>
  );
}

function ConversationView({ conversation, onBack, onSent }: {
  conversation: HelpConversation;
  onBack: () => void;
  onSent: (answer: HelpResponse) => void;
}) {
  return (
    <div className="grid gap-3">
      <Button type="button" variant="ghost" size="sm" className="justify-self-start" onClick={onBack}>{t('All conversations')}</Button>
      <Badge variant="outline" className="justify-self-start">{STATE_LABEL[conversation.state]()}</Badge>
      <ol className="m-0 grid list-none gap-3 p-0" aria-label={t('Messages with Starlings support')}>
        {conversation.lines.map((line) => (
          <li key={line.id} className="grid gap-0.5">
            <span className="text-xs text-muted-foreground">
              {line.mine ? line.sender_name : t('Starlings support')} · {formatTime(new Date(line.sent_at))}
            </span>
            <span className="whitespace-pre-wrap text-[13px] leading-normal">{line.text}</span>
          </li>
        ))}
      </ol>
      <Composer conversationId={conversation.id} placeholder={t('Reply')} onSent={(answer) => onSent(answer)} />
    </div>
  );
}

function NewConversation({ disabled, onSent }: { disabled: boolean; onSent: (answer: HelpResponse, id: string | null) => void }) {
  return <Composer placeholder={t('What do you need?')} disabled={disabled} withDetails onSent={(answer) => {
    const newest = [...answer.conversations].filter((row) => row.started_by_me).sort((a, b) => b.last_at - a.last_at)[0];
    onSent(answer, newest?.id ?? null);
  }} />;
}

function Composer({ conversationId, placeholder, disabled = false, withDetails = false, onSent }: {
  conversationId?: string;
  placeholder: string;
  disabled?: boolean;
  withDetails?: boolean;
  onSent: (answer: HelpResponse) => void;
}) {
  const [draft, setDraft] = useState('');
  const [includeDebug, setIncludeDebug] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestId = withDetails ? recentRequestId() : undefined;

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError('');
    try {
      const answer = await apiFetch<HelpResponse>('/help', {
        method: 'POST',
        fallbackError: t('Couldn’t send that to Starlings support.'),
        body: {
          text,
          ...(conversationId ? { conversation_id: conversationId } : {
            app_version: meetBuild === '0' ? `web ${meetVersion}` : `web ${meetVersion} (${meetBuild})`,
            ...(requestId ? { request_id: requestId } : {}),
            ...(includeDebug ? { debug: debugDetails() } : {}),
          }),
        },
      });
      setDraft('');
      setIncludeDebug(false);
      onSent(answer);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t send that to Starlings support.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      {error && <ErrorNotice message={error} inline />}
      <Textarea aria-label={placeholder} placeholder={placeholder} value={draft} disabled={disabled || busy} onChange={(event) => setDraft(event.target.value)} />
      {withDetails && requestId && <span className="text-xs text-muted-foreground">{t('Includes the last error: {id}', { id: requestId })}</span>}
      {withDetails && (
        <Label className="flex cursor-pointer items-center gap-3 font-normal leading-normal">
          <Checkbox checked={includeDebug} disabled={busy} onCheckedChange={(value) => setIncludeDebug(value === true)} />
          {t('Include debug details')}
        </Label>
      )}
      <Button type="button" className="justify-self-start" disabled={disabled || busy || !draft.trim()} onClick={() => void send()}>{t('Send')}</Button>
    </div>
  );
}

function HelpSearch({ pageHelpHref }: { pageHelpHref: string }) {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/u).filter((word) => word.length > 2);
    if (words.length === 0) return [];
    return HELP_PAGES
      .map((page) => ({ page, score: words.filter((word) => `${page.slug} ${page.summary}`.toLowerCase().includes(word)).length }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((row) => row.page);
  }, [query]);
  return (
    <section className="grid gap-2" aria-label={t('Help pages')}>
      <a className="text-[13px] text-(--accent-ink) underline-offset-2 hover:underline" href={pageHelpHref}>{t('Help for this page')}</a>
      <Input type="search" aria-label={t('Search help')} placeholder={t('Search help')} value={query} onChange={(event) => setQuery(event.target.value)} />
      {matches.length > 0 && (
        <ul className="m-0 grid list-none gap-1 p-0">
          {matches.map((page) => (
            <li key={page.slug}>
              <a className="block rounded-md px-2 py-1 text-[13px] hover-lift" href={helpPath(page.slug)}>{page.summary}</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What a member agreed to send: the browser and the page, no content. */
function debugDetails(): string {
  return [
    `Browser: ${navigator.userAgent}`,
    `Page: ${window.location.pathname}`,
    `Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    `Language: ${navigator.language}`,
  ].join('\n');
}
