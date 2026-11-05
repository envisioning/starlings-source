import { helpDocs } from 'virtual:meet-help';
import { CAPABILITY_INTENT_LABEL, capabilityById, type Capability } from '@starlings/contracts/capabilities';
import { GLOSSARY } from '@starlings/contracts/glossary';
import { DocumentMarkdown } from '@shared/document-markdown';
import { Button } from '@/ui/button';
import { PageCrumb } from './PageCrumb';
import { AppShell } from './SiteChrome';
import { DocArticle, DocNote } from '@shared/DocArticle';
import { SurfaceTable } from '@shared/SurfaceTable';
import { AgentAccess } from './AgentAccess';
import { useDocumentTitle } from './document-title';
import { t } from '@shared/i18n';

/**
 * /help — the product docs, rendered from `docs/help/` and
 * `docs/help/howto/` (docs/DOCUMENTATION.md decision 5). The same
 * pages an agent reads at /llms.txt. A surface page also shows, from the
 * capability registry, where each thing on it works and which doors an
 * agent has into it — the two facts a person and a Claude ask first.
 *
 * `/docs` is the Docs product; this lives at `/help` on purpose.
 */
export function HelpPage({ slug }: { slug: string | null }) {
  if (slug === null) return <HelpIndex />;
  if (slug === 'glossary') return <HelpGlossary />;
  const doc = helpDocs.find((row) => row.slug === slug);
  if (!doc) return <HelpMissing slug={slug} />;
  return <HelpDoc doc={doc} />;
}

type HelpDocRow = (typeof helpDocs)[number];

/** The page's own `# Title` line, and the body without it. */
function splitTitle(body: string): { title: string; rest: string } {
  const match = /^#\s+(.+)\n/u.exec(body);
  if (!match) return { title: '', rest: body };
  return { title: match[1]!.trim(), rest: body.slice(match[0].length) };
}

/**
 * `[team](team.md)` in a page points at its sibling. The markdown parser
 * only follows absolute URLs, so the link becomes a wikilink,
 * `[[surfaces/team|team]]`, which `resolveWikilink` sends to
 * `/help/<slug>` in this tab.
 */
function siteLinks(body: string, slug: string): string {
  const dir = slug.slice(0, slug.lastIndexOf('/'));
  return body.replace(/\[([^\]]+)\]\(([a-z0-9-]+)\.md\)/gu, (_, label: string, name: string) => `[[${dir}/${name}|${label}]]`);
}

const resolveHelpLink = (target: string) => `/help/${target}`;

function titleOf(doc: HelpDocRow): string {
  return splitTitle(doc.body).title || doc.slug.slice(doc.slug.lastIndexOf('/') + 1);
}

function HelpIndex() {
  useDocumentTitle(t('Help'));
  const surfaces = helpDocs.filter((doc) => doc.kind === 'reference' && doc.surface);
  const reference = helpDocs.filter((doc) => doc.kind === 'reference' && !doc.surface);
  const howtos = helpDocs.filter((doc) => doc.kind === 'howto');
  return (
    <AppShell variant="document" current="help">
      <DocArticle>
        <h1>{t('How Starlings works')}</h1>
        <p className="lede">One page per surface and one page per task. Agents read the same pages.</p>
        <HelpList title={t('Surfaces')} docs={surfaces} />
        {reference.length > 0 && <HelpList title={t('Reference')} docs={reference} />}
        <HelpList title={t('How to')} docs={howtos} />
        <section>
          <h2>{t('Words')}</h2>
          <p><a href="/help/glossary">{t('Glossary')}</a>: what each word means in Starlings, with its source.</p>
        </section>
        <section>
          <h2>{t('For agents')}</h2>
          <p><a href="/llms.txt">/llms.txt</a> is this index; <a href="/llms-full.txt">/llms-full.txt</a> is every page. A member's Claude connects at <code>/mcp</code> on their workspace host.</p>
        </section>
      </DocArticle>
    </AppShell>
  );
}

/** The quiet line under a title: a page's summary, a term's other names. */
const SUMMARY = 'block font-light text-foreground/70';

function HelpList({ title, docs }: { title: string; docs: HelpDocRow[] }) {
  return (
    <section>
      <h2>{title}</h2>
      <ul className="m-0 list-none ps-0">
        {docs.map((doc) => (
          <li key={doc.slug} className="mt-0 grid grid-cols-[minmax(8rem,14rem)_1fr] gap-x-4 gap-y-1 border-t border-foreground/8 py-2 first:border-t-0 max-sm:grid-cols-1">
            <a href={`/help/${doc.slug}`}>{titleOf(doc)}</a>
            <span className={SUMMARY}>{doc.summary}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HelpDoc({ doc }: { doc: HelpDocRow }) {
  const { title, rest } = splitTitle(doc.body);
  useDocumentTitle(title);
  const siblings = helpDocs.filter((row) => row.kind === doc.kind && row.slug !== doc.slug);
  const rows = doc.capabilities.map(capabilityById).filter((row): row is Capability => row !== undefined);
  return (
    <AppShell variant="document" current="help">
      <DocArticle>
        <HelpCrumb page={title} />
        <h1>{title}</h1>
        <DocumentMarkdown text={siteLinks(rest, doc.slug)} resolveWikilink={resolveHelpLink} />
        {rows.length > 0 && <CapabilityTable rows={rows} />}
        <DocNote>
          {t('Verified')} <time dateTime={doc.verified}>{doc.verified}</time> · <code>{doc.path}</code>
        </DocNote>
        {siblings.length > 0 && (
          <nav className="mt-6 flex flex-wrap gap-x-3.5 gap-y-1 border-t border-border pt-4 max-sm:gap-x-5" aria-label={t('More')}>
            {siblings.map((row) => (
              <Button key={row.slug} asChild variant="link" size="sm" className="h-auto min-h-10 px-0 text-sm font-normal text-foreground underline">
                <a href={`/help/${row.slug}`}>{titleOf(row)}</a>
              </Button>
            ))}
          </nav>
        )}
      </DocArticle>
    </AppShell>
  );
}

/** Where each capability on the page works, and how an agent reaches it. From the registry, never typed here. */
function CapabilityTable({ rows }: { rows: Capability[] }) {
  return (
    <section>
      <h2>{t('Where it works')}</h2>
      <SurfaceTable
        rows={rows}
        marks="label"
        name={(row) => (
          <>
            {row.name}
            {!row.surfaces && <span className="block text-xs font-normal text-muted-foreground/55">{CAPABILITY_INTENT_LABEL[row.intent]}</span>}
          </>
        )}
        last={{ title: t('Agent access'), cell: (row) => <AgentAccess row={row} /> }}
      />
    </section>
  );
}

function HelpGlossary() {
  useDocumentTitle(t('Glossary'));
  return (
    <AppShell variant="document" current="help">
      <DocArticle>
        <HelpCrumb page={t('Glossary')} />
        <h1>{t('Glossary')}</h1>
        <p className="lede">What each word means in Starlings. Each term lists the document that decided it.</p>
        <dl className="m-0">
          {GLOSSARY.map((term) => (
            <div key={term.term} id={term.term.toLowerCase().replace(/[^a-z0-9]+/gu, '-')} className="border-t border-foreground/8 py-2.5">
              <dt className="font-medium text-foreground">
                {term.term}
                {term.aliases && <span className="ml-2 inline text-[13px] font-light text-foreground/70">{term.aliases.join(', ')}</span>}
              </dt>
              <dd className="ms-0 mt-1 font-light text-foreground/80">
                {term.meaning}
                <span className="mt-0.5 block font-mono text-xs text-muted-foreground/70">{term.sources.join(', ')}</span>
              </dd>
            </div>
          ))}
        </dl>
      </DocArticle>
    </AppShell>
  );
}

/** The way back to the Help index, above a Help page's title. */
function HelpCrumb({ page }: { page: string }) {
  return <PageCrumb href="/help" parent={t('Help')} page={page} />;
}

function HelpMissing({ slug }: { slug: string }) {
  useDocumentTitle(t('Help'));
  return (
    <AppShell variant="document" current="help">
      <DocArticle>
        <HelpCrumb page={t('No page here.')} />
        <h1>{t('No page here.')}</h1>
        <p className="lede"><code>{slug}</code> is not a help page. <a href="/help">{t('Back to Help')}</a>.</p>
      </DocArticle>
    </AppShell>
  );
}
