import { cn } from '@/lib/utils';
import { t } from '@shared/i18n';
import { Card } from '@/ui/card';
import { AppShell } from './SiteChrome';
import { useDocumentTitle } from './document-title';
import { GRID, HERO, PAGE, SECTION_HERO, TILE } from './bento';
import { Ext, LinkTile } from './feature-tiles';
import { PageCrumb } from './PageCrumb';
import { EarlyAccess } from './EarlyAccess';
import { AGENT_ECOSYSTEM } from './AgentEcosystem';
import { AGENT_PAGES, agentPage, type AgentPage as Page } from './agent-pages';

/**
 * /integrations/<id>: one agent product, sold by the work it does. The words
 * are data in `agent-pages.ts`; the name, role and source come from the
 * agent's row in AGENT_ECOSYSTEM.
 */

export function AgentPage({ slug }: { slug: string }) {
  const page = agentPage(slug);
  const agent = AGENT_ECOSYSTEM.find((row) => row.id === slug);
  useDocumentTitle(agent ? t('{name} with Starlings', { name: agent.name }) : t('Integrations'));
  return (
    <AppShell variant="wide" product="integrations">
      <div className={PAGE}>
        {page && agent ? <Detail page={page} agent={agent} /> : (
          <header className={HERO}>
            <h1>{t('No such agent page.')}</h1>
            <p className="lede"><a href="/integrations#agent-ecosystem">{t('See every agent')}</a></p>
          </header>
        )}
      </div>
    </AppShell>
  );
}

function Detail({ page, agent }: { page: Page; agent: (typeof AGENT_ECOSYSTEM)[number] }) {
  const others = AGENT_PAGES.filter((other) => other.id !== page.id);
  return (
    <>
      <PageCrumb href="/integrations#agent-ecosystem" parent={t('Integrations')} page={agent.name} />
      <header className={cn(HERO, 'mt-6')}>
        <p className="mb-4 flex items-center gap-3 text-[15px] font-medium text-muted-foreground">
          <span aria-hidden="true" className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-primary text-[17px] font-semibold text-primary-foreground">{agent.name.charAt(0)}</span>
          {t('Starlings + {name}', { name: agent.name })}
        </p>
        <h1>{page.title}</h1>
        <p className="lede">{page.lede}</p>
      </header>

      <header className={SECTION_HERO}>
        <h2>{t('What your team hands to {name}.', { name: agent.name })}</h2>
      </header>
      <ol className={cn(GRID, 'm-0 list-none p-0')}>
        {page.jobs.map((job) => (
          <Card asChild key={job.title} className={cn(TILE, 'col-span-6 max-[640px]:col-span-12')}>
            <li>
              <h2>{job.title}</h2>
              <p>{job.body}</p>
            </li>
          </Card>
        ))}
      </ol>

      <header className={SECTION_HERO}>
        <h2>{page.connect.heading}</h2>
      </header>
      <ol className={cn(GRID, 'm-0 list-none p-0')}>
        {page.connect.steps.map((step, index) => (
          <Card asChild key={step.title} className={cn(TILE, 'col-span-4 max-[960px]:col-span-12')}>
            <li>
              <span className="mb-3 text-[12px] font-semibold text-muted-foreground tabular-nums">{String(index + 1).padStart(2, '0')}</span>
              <h2>{step.title}</h2>
              <p>{step.body}</p>
            </li>
          </Card>
        ))}
      </ol>
      {page.id === 'claude' && (
        <p className="mt-4 text-[15px]"><a href="/help/howto/connect-claude">{t('How to connect Claude')}</a></p>
      )}

      <header className={SECTION_HERO}>
        <h2>{t('Your team stays in charge.')}</h2>
      </header>
      <ul className="m-0 grid max-w-[44rem] gap-2 pl-5 text-[16px] leading-[1.55]">
        {page.control.map((line) => <li key={line}>{line}</li>)}
      </ul>
      <p className="mt-6 text-[13px] text-muted-foreground"><Ext href={agent.source}>{t('About {name}', { name: agent.name })}</Ext></p>

      <EarlyAccess
        text={page.ask}
        links={<>
          {others.map((other) => {
            const row = AGENT_ECOSYSTEM.find((candidate) => candidate.id === other.id)!;
            return <LinkTile key={other.id} href={`/integrations/${other.id}`} title={t('{name} with Starlings', { name: row.name })} text={other.title} />;
          })}
          <LinkTile href="/integrations#agent-ecosystem" title={t('Every agent')} text={t('The agents teams bring to Starlings.')} />
        </>}
      />
    </>
  );
}
