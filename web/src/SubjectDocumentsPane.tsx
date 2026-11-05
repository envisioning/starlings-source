import { Tip } from './Tip';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { ErrorNotice } from './ErrorNotice';
import { PlusIcon } from './action-icons';
import type { CrmSubject } from './crm-work';
import { loadSnapshot } from './snapshot-store';
import {
  categoryLabel,
  createDocsDocument,
  documentsSnapshotKey,
  fetchDocsDocuments,
  subjectFolderPath,
  rowDatesLabel,
  useDocsCategories,
  type DocsCategory,
  type DocsDocumentSummary,
} from './docs';
import { ControlRequestError } from './config';
import { DocumentMenuItems, DocumentRow, DocumentRows, DocumentRowsPlaceholder, docsListHeadClass, docsMutedClass, NewDocumentForm, useDocumentActions } from './docs-list';
import { useRowMenu } from './use-row-menu';
import { t } from './i18n';
import { navigate } from './navigation';
import { PlanHead } from './work-parts';

/**
 * Every document about a subject, on the subject page in Work — the pane
 * the Mac shows beside Fields and the phone shows on the subject
 * (docs/DOCS.md). New writes one about this subject, filed at
 * `/work/<kind>/<slug>`, and opens it on the Docs page; a row opens there
 * too, with the subject's own list beside it.
 */
export function SubjectDocumentsPane({ subject, startCreating = false, onCreateStarted }: { subject: CrmSubject; startCreating?: boolean; onCreateStarted?: () => void }) {
  const selection = { kind: 'subject', subjectKind: subject.kind, subjectID: subject.id, title: subject.title } as const;
  // Last known first (docs/CACHING.md): the subject's last list paints
  // before Docs answers.
  const [documents, setDocuments] = useState<DocsDocumentSummary[]>(() => (
    loadSnapshot<DocsDocumentSummary[]>(documentsSnapshotKey(selection))?.value ?? []
  ));
  const [loaded, setLoaded] = useState(documents.length > 0);
  const [error, setError] = useState('');
  const [configured, setConfigured] = useState(true);
  // Open on the title prompt when a palette verb asked for it.
  const [creating, setCreating] = useState(startCreating);
  // The request can arrive after mount (a Work link resolves its subject
  // first, or the pane is already open), so follow it, then hand it back.
  useEffect(() => {
    if (!startCreating) return;
    setCreating(true);
    onCreateStarted?.();
  }, [startCreating]); // eslint-disable-line react-hooks/exhaustive-deps
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<DocsCategory | ''>('');
  const categories = useDocsCategories();
  const [busy, setBusy] = useState(false);

  const view = `subject:${subject.kind}:${subject.id}`;
  const href = (id: string) => `/docs?view=${encodeURIComponent(view)}&doc=${encodeURIComponent(id)}`;

  const load = useCallback(async () => {
    // The same pane on another subject: its last list, or nothing — the
    // previous subject's documents are not this one's.
    const cached = loadSnapshot<DocsDocumentSummary[]>(documentsSnapshotKey({ kind: 'subject', subjectKind: subject.kind, subjectID: subject.id, title: subject.title }))?.value;
    setDocuments(cached ?? []);
    setLoaded(cached !== undefined);
    try {
      setDocuments(await fetchDocsDocuments({ kind: 'subject', subjectKind: subject.kind, subjectID: subject.id, title: subject.title }));
      setError('');
    } catch (cause) {
      if (cause instanceof ControlRequestError && cause.code === 'not_configured') {
        setConfigured(false);
      } else {
        setError(cause instanceof Error ? cause.message : t('Couldn’t load documents.'));
      }
    }
    setLoaded(true);
  }, [subject.kind, subject.id, subject.title]);

  useEffect(() => { void load(); }, [load]);

  // Each row's menu: the Docs row menu, with Open going to Docs.
  const rowMenu = useRowMenu();
  const actions = useDocumentActions({
    onChanged: () => {
      setError('');
      void load();
    },
    onError: setError,
  });

  async function create(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || busy || subject.kind === 'organization') return;
    setBusy(true);
    try {
      const created = await createDocsDocument({
        title: trimmed,
        body_md: '',
        folder_path: subjectFolderPath(subject.kind, subject.title),
        ...(category ? { category } : {}),
        subjects: [{ system: 'core', kind: subject.kind as 'project' | 'lead', subject_id: subject.id }],
        message: t('Created from Starlings'),
      });
      navigate(href(created.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t create the document.'));
      setBusy(false);
    }
  }

  if (!configured) {
    return <p className={docsMutedClass}>{t('Docs is not connected to this workspace.')}</p>;
  }

  return (
    <section className="mt-2" aria-labelledby="work-documents-heading">
      <div className={docsListHeadClass}>
        <PlanHead id="work-documents-heading">{t('Documents')}</PlanHead>
        {subject.kind !== 'organization' && !creating && (
          <Tip label={t('New document')}>
            <Button type="button" variant="outline" size="icon-sm" className="text-muted-foreground" onClick={() => setCreating(true)} aria-label={t('New document')}>
              <PlusIcon />
            </Button>
          </Tip>
        )}
      </div>
      {creating && (
        <NewDocumentForm
          title={title}
          onTitle={setTitle}
          category={category}
          categories={categories}
          onCategory={setCategory}
          busy={busy}
          onSubmit={(event) => void create(event)}
          onCancel={() => { setCreating(false); setTitle(''); }}
        />
      )}
      {error && <ErrorNotice message={error} action={<Button type="button" variant="outline" size="xs" onClick={() => void load()}>{t('Retry')}</Button>} />}
      {!error && !loaded && <DocumentRowsPlaceholder count={3} label="" />}
      {loaded && !error && documents.length === 0 && <p className={docsMutedClass}>{t('Nothing written about this yet.')}</p>}
      {documents.length > 0 && (
        <DocumentRows>
          {documents.map((document) => (
            <DocumentRow
              key={document.id}
              title={document.title}
              meta={[document.category ? categoryLabel(categories, document.category) : null, rowDatesLabel(document)].filter(Boolean).join(' · ')}
              excerpt={document.excerpt}
              href={href(document.id)}
              menu={{
                rowProps: rowMenu.rowProps(document.id),
                panel: rowMenu.panel(document.id, (
                  <DocumentMenuItems
                    document={document}
                    openHref={href(document.id)}
                    onRename={() => actions.rename(document)}
                    onMove={() => actions.move(document)}
                    onArchive={() => actions.archive(document)}
                  />
                )),
              }}
            />
          ))}
        </DocumentRows>
      )}
      {actions.dialogs}
    </section>
  );
}
