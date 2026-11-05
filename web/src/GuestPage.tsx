import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { GuestHomeResponse, GuestMessage, GuestMessagesResponse, GuestSubject } from '@starlings/contracts/subject-access';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';
import { apiFetch } from './api';
import { useDocumentTitle } from './document-title';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';

const POLL_MS = 10_000;

/**
 * A guest's page (docs/ACCESS.md slice 4): somebody outside the workspace,
 * on the subjects a member granted them. `/guest/<secret>` spends the link
 * for a guest session and moves to `/guest`, so the secret leaves the
 * address bar and the history. Reads and posts text in each subject's guest
 * thread, through /api/guest/* only.
 */
export function GuestPage() {
  const [home, setHome] = useState<GuestHomeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useDocumentTitle(home?.subjects.find((subject) => subject.thread_id === selected)?.title ?? t('Guest'), home?.workspace ?? '');

  useEffect(() => {
    const secret = /^\/guest\/([A-Za-z0-9_-]{20,200})\/?$/u.exec(window.location.pathname)?.[1];
    const load = secret
      ? apiFetch<GuestHomeResponse>('/guest/session', { method: 'POST', body: { token: secret }, fallbackError: t('This link no longer opens anything.') })
      : apiFetch<GuestHomeResponse>('/guest/home', { noStore: true, fallbackError: t('Open your link again.') });
    load.then((answer) => {
      if (secret) window.history.replaceState(null, '', '/guest');
      setHome(answer);
      setSelected(answer.subjects[0]?.thread_id ?? null);
    }, (cause: unknown) => setError(cause instanceof Error ? cause.message : t('Open your link again.')));
  }, []);

  const signOut = useCallback(async () => {
    await apiFetch('/guest/session', { method: 'DELETE', fallbackError: t('Couldn’t sign out.') }).catch(() => undefined);
    setHome(null);
    setError(t('Signed out.'));
  }, []);

  if (error) return <main className="mx-auto max-w-xl px-4 py-16"><ErrorNotice message={error} /></main>;
  if (!home) return <main className="mx-auto max-w-xl px-4 py-16 text-sm text-muted-foreground">{t('Opening…')}</main>;
  const subject = home.subjects.find((row) => row.thread_id === selected) ?? null;

  return (
    <main className="mx-auto flex min-h-[100dvh] max-w-2xl flex-col gap-4 px-4 py-6">
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{home.workspace}</p>
          <h1 className="truncate text-xl font-semibold">{subject?.title ?? t('Nothing shared with you yet.')}</h1>
        </div>
        <Button variant="outline" size="sm" onClick={() => void signOut()}>{t('Sign out')}</Button>
      </header>
      {home.subjects.length > 1 && (
        <nav aria-label={t('Shared with you')} className="flex flex-wrap gap-2">
          {home.subjects.map((row) => (
            <Button
              key={row.thread_id}
              size="sm"
              variant={row.thread_id === selected ? 'default' : 'outline'}
              onClick={() => setSelected(row.thread_id)}
            >
              {row.title}
            </Button>
          ))}
        </nav>
      )}
      {subject && <GuestThread key={subject.thread_id} subject={subject} />}
      <p className="text-xs text-muted-foreground">{t('Signed in as {email}', { email: home.email })}</p>
    </main>
  );
}

function GuestThread({ subject }: { subject: GuestSubject }) {
  const [messages, setMessages] = useState<GuestMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const page = await apiFetch<GuestMessagesResponse>(`/guest/threads/${subject.thread_id}/messages`, {
        noStore: true,
        fallbackError: t('Couldn’t load the conversation.'),
      });
      setMessages(page.messages);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t load the conversation.'));
    }
  }, [subject.thread_id]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages?.length]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await apiFetch(`/guest/threads/${subject.thread_id}/messages`, { method: 'POST', body: { text }, fallbackError: t('Couldn’t send.') });
      setDraft('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t send.'));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="flex flex-1 flex-col gap-3">
      {error && <ErrorNotice message={error} action={<Button variant="outline" size="sm" onClick={() => void refresh()}>{t('Retry')}</Button>} />}
      <ol className="flex flex-1 flex-col gap-3">
        {messages?.length === 0 && <li className="text-sm text-muted-foreground">{t('No messages yet.')}</li>}
        {messages?.map((message) => (
          <li key={message.id} className={message.mine ? 'self-end max-w-[85%]' : 'self-start max-w-[85%]'}>
            <p className="text-xs text-muted-foreground">{message.mine ? t('You') : message.sender_name}</p>
            <p className="whitespace-pre-wrap rounded-md border border-border px-3 py-2 text-sm">{message.text}</p>
          </li>
        ))}
        <div ref={end} />
      </ol>
      {subject.can_post
        ? (
          <form onSubmit={(event) => void send(event)} className="flex flex-col gap-2">
            <Textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={4000}
              aria-label={t('Message')}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send(event);
              }}
            />
            <Button type="submit" className="self-end" disabled={sending || !draft.trim()}>{t('Send')}</Button>
          </form>
        )
        : <p className="text-sm text-muted-foreground">{t('You can read this conversation.')}</p>}
    </section>
  );
}
