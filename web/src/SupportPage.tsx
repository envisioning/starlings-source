import { useMemo, useRef, useState, type FormEvent } from 'react';
import { HELP_PAGES, helpPath } from '@starlings/contracts/help';
import { workspaceContact } from './workspace-defaults';
import type { SupportIntakeResponse } from '@starlings/contracts/support-intake';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { apiFetch } from './api';
import { useDocumentTitle } from './document-title';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { withTurnstileToken } from './turnstile';

export function SupportPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const requestID = useRef<string | null>(null);
  useDocumentTitle(t('Contact Starlings'));

  const matches = useMemo(() => matchingHelpPages(message), [message]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    setError(null);
    requestID.current ??= crypto.randomUUID();
    try {
      await apiFetch<SupportIntakeResponse>('/support/intake', {
        method: 'POST',
        body: await withTurnstileToken('support', {
          name,
          email,
          message,
          request_id: requestID.current,
        }),
        fallbackError: t('Couldn’t send your message. Please try again.'),
      });
      requestID.current = null;
      setSent(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t send your message. Please try again.'));
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-[calc(100dvh-8rem)] max-w-2xl flex-col gap-6 px-5 py-10">
      <header className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{t('Starlings support')}</p>
        <h1 className="m-0 text-3xl font-semibold">{t('Contact Starlings')}</h1>
        <p className="m-0 text-muted-foreground">{t('Send a message. We’ll email you a private link to continue the conversation.')}</p>
      </header>

      {sent ? (
        <section aria-live="polite" className="rounded-lg border border-border p-5">
          <h2 className="m-0 text-lg font-semibold">{t('Message received')}</h2>
          <p className="mb-0 text-sm text-muted-foreground">{t('Check your email for a private link to continue the conversation.')}</p>
        </section>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <Label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor="support-name">
            {t('Name')}
            <Input id="support-name" autoComplete="name" maxLength={120} required value={name} onChange={(event) => setName(event.target.value)} />
          </Label>
          <Label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor="support-email">
            {t('Email')}
            <Input id="support-email" type="email" autoComplete="email" maxLength={320} required value={email} onChange={(event) => setEmail(event.target.value)} />
          </Label>
          <Label className="flex flex-col gap-1.5 text-sm font-medium" htmlFor="support-message">
            {t('Message')}
            <Textarea id="support-message" maxLength={4000} required rows={7} value={message} onChange={(event) => setMessage(event.target.value)} />
          </Label>

          {matches.length > 0 && (
            <aside className="rounded-lg border border-border bg-muted/40 p-4">
              <h2 className="m-0 text-sm font-semibold">{t('These help pages may answer your question')}</h2>
              <ul className="mb-0 mt-2 flex list-disc flex-col gap-1 pl-5 text-sm">
                {matches.map((page) => <li key={page.slug}><a href={helpPath(page.slug)}>{page.summary}</a></li>)}
              </ul>
            </aside>
          )}

          {error && <ErrorNotice message={error} />}
          <Button type="submit" className="self-start" disabled={sending || !name.trim() || !email.trim() || !message.trim()}>
            {sending ? t('Sending…') : t('Send message')}
          </Button>
          <p className="m-0 text-xs text-muted-foreground"><a href={`mailto:${workspaceContact()}`}>{t('You can also email {email}.', { email: workspaceContact() })}</a></p>
        </form>
      )}
    </main>
  );
}

function matchingHelpPages(message: string) {
  const words = message.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').match(/[a-z0-9]{3,}/gu) ?? [];
  if (words.length === 0) return [];
  const unique = [...new Set(words)];
  return HELP_PAGES
    .map((page) => {
      const searchable = `${page.slug.replace(/-/gu, ' ')} ${page.summary}`.toLocaleLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/gu, '');
      return { page, score: unique.reduce((score, word) => score + Number(searchable.includes(word)), 0) };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.page.slug.localeCompare(b.page.slug))
    .slice(0, 3)
    .map(({ page }) => page);
}
