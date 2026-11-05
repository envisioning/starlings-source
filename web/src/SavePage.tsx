import { useEffect, useRef, useState } from 'react';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { LoadingIndicator } from '@/ui/spinner';
import type { DocsDocumentDetail } from '@starlings/contracts';
import { createDocsDocument } from './docs';
import { useDocumentTitle } from './document-title';
import { ErrorNotice } from './ErrorNotice';
import { GuestCard } from './GuestCard';
import { t } from './i18n';
import { useOwnerSession } from './owner-session';
import { bookmarkletHref, PAGE_READY, readPageMessage, slimPageHTML, type CapturedPage } from './page-capture';
import { SectionCard } from './SectionCard';
import { SignInGate } from './SignInGate';
import { AppShell } from './SiteChrome';
import { documentHref } from './work-hrefs';
import { workspaceBrand } from './workspace-brand';

/**
 * `/save` — the popup the bookmarklet opens (page-capture.ts). It asks the
 * page that opened it for the page, shows what will be saved, and saves it
 * to Docs as a link save with the page's HTML: the Worker reads the article
 * from what the person's browser drew. Opened on its own, it offers the
 * bookmarklet instead.
 */
export function SavePage() {
  const session = useOwnerSession();
  useDocumentTitle(t('Save to Docs'));

  if (session.kind === 'loading') return <LoadingIndicator placement="full-page" />;
  if (session.kind === 'visitor') return <SignInGate title={t('Save to Docs')} />;
  return (
    <AppShell variant="centered">
      <GuestCard>
        {window.opener ? <SaveFromOpener /> : <BookmarkletInstall />}
      </GuestCard>
    </AppShell>
  );
}

/** How long the page has to answer before the popup says it did not. */
const PAGE_WAIT_MS = 5_000;

function SaveFromOpener() {
  const [page, setPage] = useState<CapturedPage | undefined>();
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<DocsDocumentDetail | undefined>();

  useEffect(() => {
    const opener: unknown = window.opener;
    const receive = (event: MessageEvent) => {
      const captured = readPageMessage(event, opener);
      if (!captured) return;
      setPage(captured);
      setTitle(captured.title);
      setError(undefined);
    };
    window.addEventListener('message', receive);
    // The page cannot know where this popup is until it says so; the
    // message carries nothing, so any origin may hear it.
    (opener as Window).postMessage({ type: PAGE_READY }, '*');
    const late = window.setTimeout(() => {
      setPage((current) => {
        if (!current) setError(t('The page didn’t answer. Click the bookmarklet on the page again.'));
        return current;
      });
    }, PAGE_WAIT_MS);
    return () => {
      window.removeEventListener('message', receive);
      window.clearTimeout(late);
    };
  }, []);

  async function save() {
    if (!page) return;
    setBusy(true);
    setError(undefined);
    try {
      // A page too long to send whole still saves: the Worker reads it from the web.
      const html = slimPageHTML(page.html);
      setSaved(await createDocsDocument({
        url: page.url,
        ...(html ? { page_html: html } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        body_md: note.trim(),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t save the page.'));
    } finally {
      setBusy(false);
    }
  }

  if (saved) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="m-0 text-lg font-semibold">{t('Saved')}</h1>
        <p className="m-0 text-sm text-muted-foreground">{saved.title}</p>
        <div className="flex flex-wrap gap-2.5">
          <Button asChild>
            <a href={documentHref(saved.id)} target="_blank" rel="noopener">{t('Open in Docs')}</a>
          </Button>
          <Button type="button" variant="secondary" onClick={() => window.close()}>{t('Close')}</Button>
        </div>
      </div>
    );
  }

  if (!page) {
    return error
      ? <ErrorNotice message={error} />
      : <LoadingIndicator label={t('Reading the page…')} labelVisibility="visible" />;
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => { event.preventDefault(); void save(); }}
    >
      <h1 className="m-0 text-lg font-semibold">{t('Save to Docs')}</h1>
      <p className="m-0 truncate text-sm text-muted-foreground">{new URL(page.url).hostname.replace(/^www\./u, '')}</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="save-title">{t('Title')}</Label>
        <Input id="save-title" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="save-note">{t('Note')}</Label>
        <Textarea id="save-note" value={note} rows={4} autoFocus onChange={(event) => setNote(event.target.value)} />
      </div>
      {error && <ErrorNotice message={error} />}
      <div className="flex flex-wrap gap-2.5">
        <Button type="submit" disabled={busy}>{busy ? t('Saving…') : t('Save')}</Button>
        <Button type="button" variant="secondary" onClick={() => window.close()}>{t('Cancel')}</Button>
      </div>
    </form>
  );
}

/**
 * The bookmarklet as a link to drag to the bookmarks bar. React refuses a
 * `javascript:` href, so the address is set on the element after it mounts.
 */
function BookmarkletLink() {
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    link.current?.setAttribute('href', bookmarkletHref(window.location.origin));
  }, []);
  return (
    <Button asChild variant="secondary">
      <a ref={link} onClick={(event) => event.preventDefault()} draggable>
        {t('Save to {name}', { name: workspaceBrand().name })}
      </a>
    </Button>
  );
}

function BookmarkletInstall() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="m-0 text-lg font-semibold">{t('Save to Docs')}</h1>
      <p className="m-0 text-sm text-muted-foreground">{t('Drag the button to your bookmarks bar, then click it on any page to save it to Docs.')}</p>
      <div><BookmarkletLink /></div>
    </div>
  );
}

/** Settings › Account: the same bookmarklet, where people look for it. */
export function BrowserSaveSection() {
  return (
    <SectionCard id="settings-browser-save" title={t('Save from your browser')}>
      <p className="m-0 text-[13px] leading-normal text-muted-foreground">
        {t('Drag the button to your bookmarks bar, then click it on any page to save it to Docs.')}
      </p>
      <div className="flex flex-wrap gap-2.5"><BookmarkletLink /></div>
    </SectionCard>
  );
}
