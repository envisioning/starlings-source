import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { t } from '@shared/i18n';
import { AppShell } from './SiteChrome';
import { useDocumentTitle } from './document-title';
import { EarlyAccess } from './EarlyAccess';
import { LinkTile } from './feature-tiles';
import { HERO, SECTION_HERO } from './bento';
import { UseCaseSim } from './sim/UseCaseSim';
import { USE_CASES, DEMO_NOTICE, setupFor, useCaseHref, type UseCase } from './use-cases';
import { capabilityById, SURFACE_LABEL, SURFACE_STATUS_LABEL, type CapabilitySurface } from '@starlings/contracts/capabilities';

export function UseCasesPage({ slug = null }: { slug?: string | null }) {
  const job = USE_CASES.find((entry) => entry.slug === slug);
  useDocumentTitle(job?.title ?? t('Agent use cases'));
  return <AppShell variant="wide" product="use-cases"><header className={HERO}>
    {job && <a href="/use-cases">{t('All use cases')}</a>}
    <h1>{job?.title ?? t('What will you hand to your agent next?')}</h1>
    <p className="lede">{job?.summary ?? t('Examples of people and agents working from the same project record. Explore a client brief, follow-up work, a proposal, research, onboarding and a question that needs a person’s answer.')}</p>
  </header>
    {job ? <JobPage key={job.slug} job={job} /> : <>
      <p>{t('Start with the job, then inspect the sources and the draft. Change the sample project to see the example use a different record.')}</p>
      <p className="text-sm text-muted-foreground">{DEMO_NOTICE}</p>
      <Gallery />
      <section className={SECTION_HERO}><h2>{t('For teams doing client work with agents')}</h2>
        <p>{t('Consultancies, studios and research teams are the first audience: several projects, outside collaborators, and agents already helping with the work. New companies can start with the same habits from day one.')}</p>
        <p><a href="/for">{t('Find your team')}</a> · <a href="/integrations">{t('Choose an agent connection')}</a></p>
      </section>
    </>}
    <EarlyAccess />
  </AppShell>;
}
function Gallery({ except }: { except?: string }) {
  return <div className="grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">{USE_CASES.filter((job) => job.slug !== except).map((job) => <LinkTile key={job.slug} href={useCaseHref(job)} title={job.title} text={job.summary} />)}</div>;
}
function JobPage({ job }: { job: UseCase }) {
  return <>
    <p className="text-sm text-muted-foreground">{DEMO_NOTICE}</p>
    <UseCaseSim job={job} />
    <section className={SECTION_HERO}><h2>{t('Try it in your workspace')}</h2><p>{setupFor(job)}</p>
      <p>{job.slug === 'agent-needs-an-answer' ? <a href="/help/howto/connect-an-agent-as-a-team-member">{t('Connect an agent as a team member')}</a> : <a href="/help/howto/connect-claude">{t('Connect Claude over MCP')}</a>} · <a href="/integrations">{t('Other agents and connection paths')}</a></p>
      <h3>{t('A request to adapt')}</h3><blockquote className="border-l-2 border-border pl-4">{job.prompt}</blockquote>
      <p>{job.review}</p>
      <p><a href={job.help}>{t('Read the product instructions')}</a> · <a href={job.audience}>{t('See this in your team’s work')}</a></p>
    </section>
    <section className={SECTION_HERO}><h2>{t('What is available today')}</h2>
      <p>{t('These are sample agent workflows built from existing capabilities, not built-in one-click automations. Agent output depends on the client, model, instructions and records it can access.')}</p>
      <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>{t('Capability')}</TableHead><TableHead>{t('Mac')}</TableHead><TableHead>{t('iOS')}</TableHead><TableHead>{t('Web')}</TableHead></TableRow></TableHeader><TableBody>{job.capabilities.map((id) => {
        const capability = capabilityById(id)!;
        return <TableRow key={id}><TableCell className="py-3 pr-4 font-normal"><a href="/workspace/status">{t(capability.name)}</a></TableCell>{(['mac-host', 'ios', 'web'] as CapabilitySurface[]).map((surface) => <TableCell key={surface} className="py-3 pr-4" aria-label={`${SURFACE_LABEL[surface]}: ${SURFACE_STATUS_LABEL[capability.surfaces![surface]]}`}>{t(SURFACE_STATUS_LABEL[capability.surfaces![surface]])}</TableCell>)}</TableRow>;
      })}</TableBody></Table></div>
      <p><a href="/workspace/status">{t('Full capability and agent access status')}</a></p>
    </section>
    <section className={SECTION_HERO}><h2>{t('Explore another job')}</h2><Gallery except={job.slug} /></section>
  </>;
}
