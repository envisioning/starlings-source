import { cn } from '@/lib/utils';
import { Card } from '@/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { AppShell } from './SiteChrome';
import { useDocumentTitle } from './document-title';
import { GRID, HERO, PAGE, SECTION_HERO, TABLE_FRAME, TILE } from './bento';
import { Ext, LinkTile } from './feature-tiles';
import { COMPARISON_PAGES, TEAM_PAGES, comparisonPage, teamPage, type ComparisonPage, type TeamPage as Team } from './solutions';
import { EarlyAccess } from './EarlyAccess';
import { t } from '@shared/i18n';

/**
 * /for/<slug> and /compare/<slug>, with an index at /for and /compare. The
 * words are data in `solutions.ts`; these components only lay them out, so
 * every team page and every comparison reads the same way.
 */

export function TeamPage({ slug }: { slug: string | null }) {
  const team = slug ? teamPage(slug) : undefined;
  useDocumentTitle(team ? `Starlings for ${team.name.toLowerCase()}` : 'Who Starlings is for');
  return (
    <AppShell variant="wide" product="for">
      <div className={PAGE}>{team ? <TeamDetail team={team} /> : slug ? <Missing kind="team page" back="/for" /> : <TeamIndex />}</div>
    </AppShell>
  );
}

export function ComparePage({ slug }: { slug: string | null }) {
  const page = slug ? comparisonPage(slug) : undefined;
  useDocumentTitle(page ? `Starlings vs. ${page.name}` : 'Compare Starlings');
  return (
    <AppShell variant="wide" product="compare">
      <div className={PAGE}>{page ? <ComparisonDetail page={page} /> : slug ? <Missing kind="comparison" back="/compare" /> : <CompareIndex />}</div>
    </AppShell>
  );
}

function TeamIndex() {
  return (
    <>
      <header className={HERO}>
        <h1>Who Starlings is for.</h1>
        <p className="lede">Small teams running several projects at once, who already hand some of the work to AI agents.</p>
      </header>
      <LinkGrid links={TEAM_PAGES.map((team) => ({ href: `/for/${team.slug}`, title: team.name, body: team.title }))} />
    </>
  );
}

function CompareIndex() {
  return (
    <>
      <header className={HERO}>
        <h1>Compare Starlings.</h1>
        <p className="lede">How Starlings compares with the tools teams use today, and where each one is the better choice.</p>
      </header>
      <LinkGrid links={COMPARISON_PAGES.map((page) => ({ href: `/compare/${page.slug}`, title: `Starlings vs. ${page.name}`, body: page.title }))} />
    </>
  );
}

function TeamDetail({ team }: { team: Team }) {
  return (
    <>
      <header className={HERO}>
        <p className="mb-3 text-[15px] font-medium text-muted-foreground">Starlings for {team.name.toLowerCase()}</p>
        <h1>{team.title}</h1>
        <p className="lede">{team.lede}</p>
      </header>

      <section aria-labelledby="today">
        <h2 id="today" className="mb-4">Your week today</h2>
        <List items={team.today} />
      </section>

      <header className={SECTION_HERO}>
        <h2>How the work runs in Starlings.</h2>
      </header>
      <ol className={cn(GRID, 'm-0 list-none p-0')}>
        {team.steps.map((step, index) => (
          <Card asChild key={step.title} className={cn(TILE, 'col-span-3 max-[960px]:col-span-6 max-[640px]:col-span-12')}>
            <li>
              <span className="mb-3 text-[12px] font-semibold text-muted-foreground tabular-nums">{String(index + 1).padStart(2, '0')}</span>
              <h2>{step.title}</h2>
              <p>{step.body}</p>
            </li>
          </Card>
        ))}
      </ol>

      <header className={SECTION_HERO}>
        <h2>Jobs your agents can take.</h2>
        <p className="lede">Connect Claude, or hand a task to a shared agent. It works from the same project as your team, and Starlings logs each action under the name of the person who asked.</p>
      </header>
      <List items={team.agentJobs} />

      <header className={SECTION_HERO}>
        <h2>What you can stop paying for.</h2>
      </header>
      <List items={team.replaces} />

      <NextSteps />
    </>
  );
}

function ComparisonDetail({ page }: { page: ComparisonPage }) {
  return (
    <>
      <header className={HERO}>
        <p className="mb-3 text-[15px] font-medium text-muted-foreground">Starlings vs. {page.name}</p>
        <h1>{page.title}</h1>
        <p className="lede">{page.lede}</p>
      </header>

      <div className={TABLE_FRAME}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="min-w-[140px]"> </TableHead>
            <TableHead scope="col" className="min-w-[220px]">Starlings</TableHead>
            <TableHead scope="col" className="min-w-[220px]">{page.name}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {page.rows.map((row) => (
            <TableRow key={row.topic}>
              <TableHead scope="row" className="align-top whitespace-normal font-semibold">{row.topic}</TableHead>
              <TableCell className="align-top whitespace-normal leading-relaxed">{row.starlings}</TableCell>
              <TableCell className="align-top whitespace-normal leading-relaxed text-muted-foreground">{row.them}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      </div>

      <div className="mt-10 grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
        <Card className={TILE}>
          <h2>Choose {page.name} if</h2>
          <List items={page.theyWin} />
        </Card>
        <Card className={TILE}>
          <h2>Choose Starlings if</h2>
          <List items={page.weWin} />
        </Card>
      </div>

      <p className="mt-6 max-w-[44rem] text-[13px] leading-[1.55] text-muted-foreground">
        Facts about {page.name} checked on {page.checked} from {page.sources.map((source, index) => (
          <span key={source.href}>{index > 0 && (index === page.sources.length - 1 ? ' and ' : ', ')}<Ext href={source.href}>{source.label}</Ext></span>
        ))}. Products change. If something here is out of date, <a href="/interest">tell us</a>.
      </p>

      <NextSteps />
    </>
  );
}

function List({ items }: { items: readonly string[] }) {
  return (
    <ul className="m-0 grid max-w-[44rem] gap-2 pl-5 text-[16px] leading-[1.55]">
      {items.map((item) => <li key={item}>{item}</li>)}
    </ul>
  );
}

function LinkGrid({ links }: { links: ReadonlyArray<{ href: string; title: string; body: string }> }) {
  return (
    <div className="grid grid-cols-3 gap-3 max-[960px]:grid-cols-1">
      {links.map((link) => (
        <LinkTile key={link.href} href={link.href} title={link.title} text={link.body} />
      ))}
    </div>
  );
}

/** How every page in this family ends: the features, then the early-access band. */
export function NextSteps() {
  return (
    <EarlyAccess
      text={t('Tell us how your team works today, and we’ll set up a workspace for your team.')}
      links={<LinkTile href="/workspace" title={t('See every feature')} text={t('What each part of Starlings does today.')} />}
    />
  );
}

function Missing({ kind, back }: { kind: string; back: string }) {
  return (
    <header className={HERO}>
      <h1>No such {kind}.</h1>
      <p className="lede"><a href={back}>See them all</a>.</p>
    </header>
  );
}
