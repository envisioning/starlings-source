import { Button } from '@/ui/button';
import { ConceptShowcase } from './ConceptShowcase';
import { CallsShowcase } from './CallsShowcase';
import { t } from '@shared/i18n';
import { ProductOverview, PRODUCT_MESSAGE } from './features';
import { Arrow, SiteFooter, SiteHeader, WRAP } from './SiteChrome';
import { LinkPill, LinkTile } from './feature-tiles';
import { USE_CASES, useCaseHref } from './use-cases';
import { ProposalSim } from './sim/ProposalSim';
import { StaticSample } from './sim/sample-meeting';
import { EarlyAccess } from './EarlyAccess';

const SECTION = 'border-b border-border py-16 max-[800px]:py-10';
const TEXT_LINK = 'h-auto gap-3 px-0! text-sm font-medium text-foreground has-[>svg]:px-0';
const proposal = USE_CASES[2];

/** Prerendered page; hero.tsx mounts the call and proposal simulations near the viewport. */
export function HomePage() {
  return <>
    <SiteHeader path="/" />
    <main id="main" className={WRAP}>
      <section className="max-w-[940px] pt-[100px] pb-[40px] max-[800px]:pt-[65px]">
        <h1>Where your team and your AI agents work together.</h1>
        <p className="lede">{PRODUCT_MESSAGE}</p>
        <div className="mt-8 flex flex-wrap items-center gap-6">
          <Button asChild size="lg"><a href="/interest">Request early access <Arrow direction="next" /></a></Button>
          <Button asChild variant="outline" size="lg"><a href="/assessment">{t('Take the agent readiness assessment')} <Arrow direction="next" /></a></Button>
          <Button asChild variant="link" className={TEXT_LINK}><a href="#sim-calls">See how it works <Arrow direction="down" /></a></Button>
        </div>
      </section>

      <div id="sim-calls" className="scroll-mt-24"><CallsShowcase /></div>

      {/* Static HTML that never mounts: its samples show the default as drawn (sample-meeting.ts, StaticSample). */}
      <StaticSample><ConceptShowcase /></StaticSample>

      <section id="use-cases" className={SECTION} aria-labelledby="workflow-title">
        <h2 id="workflow-title">{proposal.title}</h2>
        <p className="m-0 mb-3 text-sm text-muted-foreground">{t('One project, from context to review.')}</p>
        <p className="max-w-[620px] text-muted-foreground">{proposal.summary}</p>
        <div id="sim-proposal" className="my-8"><ProposalSim /></div>
        <div className="flex flex-wrap items-center gap-3">
          <LinkPill href={useCaseHref(proposal)}>{t('Step through the example')}</LinkPill>
          <LinkPill href="/use-cases">{t('Explore the examples')}</LinkPill>
        </div>
      </section>

      <section id="product" className={SECTION}>
        <StaticSample><ProductOverview compact /></StaticSample>
        <LinkPill href="/workspace">{t('Explore the workspace')}</LinkPill>
      </section>

      <section className={SECTION} aria-labelledby="foundation-title">
        <h2 id="foundation-title">{t('Built for work you can trust.')}</h2>
        <div className="grid grid-cols-2 gap-3 max-[800px]:grid-cols-1">
          <LinkTile href="/security" title={t('Security and data')} text={t('Where your data lives, who can see it, and what Starlings never keeps.')} />
          <LinkTile href="/integrations" title={t('Integrations and agents')} text={t('Explore agent connections, providers and setup.')} />
        </div>
      </section>
      <EarlyAccess />
    </main>
    <SiteFooter />
  </>;
}
