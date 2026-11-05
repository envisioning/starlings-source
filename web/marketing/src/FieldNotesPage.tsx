import { fieldNotes } from 'virtual:meet-field-notes';
import { DocumentMarkdown } from '@shared/document-markdown';
import { DocArticle } from '@shared/DocArticle';
import { t } from '@shared/i18n';
import { AppShell } from './SiteChrome';
import { useDocumentTitle } from './document-title';

export function FieldNotesPage({ slug = null }: { slug?: string | null }) {
  const note = fieldNotes.find((entry) => entry.slug === slug);
  useDocumentTitle(note?.title ?? t('Field notes'));
  return <AppShell variant="document">
    <DocArticle wide>
      {note ? <>
        <p><a href="/field-notes">{t('All field notes')}</a></p>
        <h1>{note.title}</h1>
        <p className="lede">{note.description}</p>
        <p className="text-sm text-muted-foreground">
          {t('By {author}', { author: note.author })} · {t('Published')} <time dateTime={note.published}>{note.published}</time>
          {note.updated !== note.published && <> · {t('Updated')} <time dateTime={note.updated}>{note.updated}</time></>}
        </p>
        <DocumentMarkdown text={note.body} />
        {note.related.length > 0 && <section className="mt-10 border-t border-border pt-5">
          <h2>{t('Related field notes')}</h2>
          <ul>{note.related.map((relatedSlug) => {
            const related = fieldNotes.find((entry) => entry.slug === relatedSlug)!;
            return <li key={relatedSlug}><a href={`/field-notes/${relatedSlug}`}>{related.title}</a></li>;
          })}</ul>
        </section>}
      </> : slug ? <>
        <p><a href="/field-notes">{t('All field notes')}</a></p>
        <h1>{t('Field note not found')}</h1>
        <p className="lede">{t('This field note is not published.')}</p>
      </> : <>
        <h1>{t('Field notes')}</h1>
        <p className="lede">{t('Practical notes on working with AI agents in project teams: what to start with, where shared context helps, and how to keep people in control.')}</p>
        {fieldNotes.length ? <ul className="m-0 list-none p-0">
          {fieldNotes.map((entry) => <li key={entry.slug} className="border-t border-border py-5 first:border-t-0">
            <h2 className="mt-0"><a href={`/field-notes/${entry.slug}`}>{entry.title}</a></h2>
            <p>{entry.description}</p>
            <p className="text-sm text-muted-foreground">{t('By {author}', { author: entry.author })} · {t('Published')} <time dateTime={entry.published}>{entry.published}</time></p>
          </li>)}
        </ul> : <p>{t('Field notes are being prepared. Check back soon.')}</p>}
      </>}
    </DocArticle>
  </AppShell>;
}
