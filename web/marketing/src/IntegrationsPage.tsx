import { AppShell } from './SiteChrome';
import { useDocumentTitle } from './document-title';
import { HERO, PAGE, SECTION_HERO } from './bento';
import { StatusGlyph, LinkTile, Callout } from './feature-tiles';
import { SampleAgentFace } from './bento-figures';
import { FeatureBento, ThemeHead } from './features';
import { AgentTable } from './AgentEcosystem';
import { EarlyAccess } from './EarlyAccess';
import { t } from '@shared/i18n';

/**
 * /integrations — what Starlings connects to: the agents that work in it
 * (Claude over MCP, shared agents on a runtime) and the tools whose history it
 * files (connectors, Google Workspace). /agents is the open agent standard
 * (ADR 0005), not this page; the two link to each other.
 *
 * The agent and connector tiles, and their section heads, are the feature
 * library's themes `agents` and `connectors` (`features.tsx`). The page adds
 * what is its own: the hero, the ecosystem, the open standard and the close.
 * The ecosystem table moved here from /why: it marks which agents work today
 * and which still need validation, so the claim stays honest where the
 * detail lives.
 */
export function IntegrationsPage() {
  useDocumentTitle('Integrations');

  return (
    <AppShell variant="wide" product="integrations">
      <div className={PAGE}>
        <header className={HERO}>
          <h1>Integrations.</h1>
          <p className="lede">
            Starlings connects to the agents and tools your team already uses.
            Claude works inside your workspace as you, shared agents sit in your
            team list, and connectors file your history on the right project.
          </p>
        </header>

        <ThemeHead id="agents" className="mt-0 border-t-0 pt-0" />
        <FeatureBento theme="agents" depth="detail" />

        <header className={SECTION_HERO} id="agent-ecosystem">
          <h2>Bring the agents you already use.</h2>
          <p className="lede">
            Starlings speaks MCP, the open standard agents use to reach tools.
            Your agents read the same calls, tasks and documents as your team,
            and file their work on the project.
          </p>
        </header>

        <AgentTable />
        <div className="mt-6"><LinkTile href="/use-cases" title={t('Start with a job for your agent')} text={t('Inspect live sample examples, then choose the connection that fits your workflow.')} /></div>
        <Callout className="mt-4 max-w-[44rem] text-[15px] leading-[1.55]">
          <strong>{t('Next: agents working together')}</strong>
          <ul className="mt-2 mb-0 grid gap-1.5 pl-5">
            <li>{t('One agent researches a brief and hands its sources to an agent from another provider.')}</li>
            <li>{t('The second agent writes the draft.')}</li>
            <li>{t('The draft comes back to the project for a person to review.')}</li>
            <li>{t('Each handoff names who is accountable and what each agent can access.')}</li>
          </ul>
        </Callout>

        <ThemeHead id="connectors" />
        <FeatureBento theme="connectors" depth="detail" />

        <header className={SECTION_HERO} id="open-standard">
          <h2>An open standard for agents.</h2>
          <p className="lede">
            The instructions and skills an agent follows in Starlings are
            published under the Apache 2.0 license, so any agent can learn how
            to file its work on the right project.
          </p>
        </header>

        <EarlyAccess
          text={t('Tell us which agents and tools your team uses today.')}
          links={<>
            <LinkTile href="/agents" icon={<SampleAgentFace className="size-6 [&_svg]:size-full!" />} title={t('Agent instructions')} text={t('What an agent reads before it works in a Starlings workspace.')} />
            <LinkTile href="/skills" icon={<StatusGlyph />} title={t('Skills')} text={t('Portable skills in the Agent Skills format, ready for any agent’s skills folder.')} />
          </>}
        />
      </div>
    </AppShell>
  );
}
