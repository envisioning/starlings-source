import { useId } from 'react';
import { ArrowUpRight, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { t } from '@shared/i18n';
import { AGENT_PRODUCTS, type AgentProductID } from '@starlings/contracts/agent-products';
import { agentPage } from './agent-pages';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';

/** Where each product stands with Starlings: research, not shown as marketing. Only `live` is a supported connection. */
type AgentStatus = 'live' | 'building' | 'research';

/**
 * The ways an agent works with Starlings, one table column each: over MCP as
 * the member, as a Team agent beside people, and holding a Work card. The
 * ids match the feature library (`mcp`, `shared-agents`, `stages`).
 */
type StarlingsPath = 'mcp' | 'team' | 'cards';
/** One path for one product. `works` is shipped; the rest are research, not commitments. */
type PathState = 'works' | 'building' | 'research' | 'no';

/** What a product's own source says it can do, one column each. Unlisted is not the same as absent. */
type Ability = 'browser' | 'terminal' | 'files' | 'mcp' | 'memory' | 'schedules' | 'skills' | 'delegation';

/**
 * The research behind the integrations page's agent table, one row per
 * product. `starlings` is how it works with Starlings; only `works` is
 * built. `brings` is what the product's own `source` lists, split out of
 * `capabilities`; a missing ability means unlisted, not absent. Keyed by
 * product id, so a product added to the registry fails the build here
 * until it has its row.
 */
const RESEARCH = {
  eve: {
    kind: 'Custom agent runtime',
    source: 'https://vercel.com/blog/introducing-eve',
    capabilities: 'Durable sessions, sandboxed code, typed tools, Markdown skills, connections, schedules, subagents and traces. Browser work can be added through tools.',
    relationship: 'Runs Envisioning’s agents outside Starlings. Signed handoffs carry the assignment; replies return to the conversation.',
    status: 'live',
    starlings: { mcp: 'no', team: 'works', cards: 'works' },
    brings: ['terminal', 'schedules', 'skills', 'delegation'],
  },
  claude: {
    kind: 'Assistant and connector client',
    source: 'https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile',
    capabilities: 'Chat, Code and Cowork; connectors, skills, files, scheduled tasks and browser or computer use. Capabilities depend on the client and plan.',
    relationship: 'Claude connects to Starlings over MCP as you. Read company records, prepare work and make writes you have allowed.',
    status: 'live',
    starlings: { mcp: 'works', team: 'no', cards: 'no' },
    brings: ['browser', 'terminal', 'files', 'mcp', 'schedules', 'skills'],
  },
  'grok-bot': {
    kind: 'Personal and team agents',
    source: 'https://docs.x.ai/grok-bot/overview',
    capabilities: 'Persistent cloud computer, browser and terminal; connectors, reusable skills, routines, memory and coordination between bots.',
    relationship: 'A candidate MCP client for a member’s assistant. A bot participating in Team would need a separate signed adapter.',
    status: 'building',
    starlings: { mcp: 'building', team: 'research', cards: 'no' },
    brings: ['browser', 'terminal', 'memory', 'schedules', 'skills', 'delegation'],
  },
  openclaw: {
    kind: 'Agent runtime you operate',
    source: 'https://docs.openclaw.ai/tools',
    capabilities: 'Messaging channels, shell, files, browser, search, skills and plugins; background automation and coordination across agents.',
    relationship: 'A candidate runtime for a Team agent, with an adapter for Starlings identity, handoffs and replies.',
    status: 'building',
    starlings: { mcp: 'no', team: 'building', cards: 'building' },
    brings: ['browser', 'terminal', 'files', 'schedules', 'skills', 'delegation'],
  },
  hermes: {
    kind: 'Agent runtime with procedural learning',
    source: 'https://hermes-agent.nousresearch.com/docs/',
    capabilities: 'Terminal, files, browser automation, MCP, memory, session recall, agent-created skills, scheduled work and delegation.',
    relationship: 'Joins a workspace’s Team through the open-source Starlings adapter: an admin approves it, and it reads Starlings for the person who asked.',
    status: 'live',
    starlings: { mcp: 'building', team: 'works', cards: 'building' },
    brings: ['browser', 'terminal', 'files', 'mcp', 'memory', 'schedules', 'skills', 'delegation'],
  },
  'openai-dots': {
    kind: 'Always-on personal assistant',
    source: 'https://learn.chatgpt.com/docs/dots',
    capabilities: 'Cloud computer and browser, connected apps, ongoing tasks and memory; background agents and delegation to Work or Codex tasks.',
    relationship: 'A candidate personal connector for reading context and returning work as the member who asked.',
    status: 'building',
    starlings: { mcp: 'building', team: 'no', cards: 'no' },
    brings: ['browser', 'memory', 'delegation'],
  },
  'meta-muse': {
    kind: 'Personal and small-business assistant',
    source: 'https://introducing.muse.ai/',
    capabilities: 'Computer, browser, terminal, files and connectors; proactive work, parallel tasks and documents, PDFs, websites and interactive outputs.',
    relationship: 'A candidate custom connector. We still need to test how it signs in to Starlings and how its returned work gets reviewed.',
    status: 'building',
    starlings: { mcp: 'building', team: 'no', cards: 'no' },
    brings: ['browser', 'terminal', 'files'],
  },
  instinct: {
    kind: 'Personal assistant by text and calls',
    source: 'https://instinct.com/',
    capabilities: 'Phone and computer operation, connected applications and devices, personal context and proactive follow-up. Public developer details are limited.',
    relationship: 'An integration to research. A public Starlings-compatible connector or developer contract has not been established.',
    status: 'research',
    starlings: { mcp: 'research', team: 'no', cards: 'no' },
    brings: [],
  },
  manus: {
    kind: 'Agent for delegated tasks',
    source: 'https://help.manus.im/en/articles/12231777-how-can-i-use-manus-connectors',
    capabilities: 'Cloud sandbox and browser work, files, research and generated deliverables; connectors including MCP, plus an API for external workflows.',
    relationship: 'A candidate connector or task adapter for assignments and completion notifications.',
    status: 'building',
    starlings: { mcp: 'building', team: 'no', cards: 'building' },
    brings: ['browser', 'terminal', 'files', 'mcp'],
  },
  'gemini-enterprise': {
    kind: 'Enterprise agent platform',
    source: 'https://docs.cloud.google.com/gemini/enterprise/docs/agents-overview',
    capabilities: 'Enterprise knowledge, research and multi-step workflows; custom ADK and A2A agents, with centralized management.',
    relationship: 'A candidate enterprise integration. Mapping company access and the agent’s acting identity comes first.',
    status: 'building',
    starlings: { mcp: 'research', team: 'no', cards: 'no' },
    brings: ['delegation'],
  },
  'copilot-studio': {
    kind: 'Enterprise agent builder',
    source: 'https://learn.microsoft.com/en-us/microsoft-copilot-studio/agents-overview',
    capabilities: 'Knowledge-grounded conversations, workflows, connectors, REST and MCP tools; agent handoffs and file work depending on the harness.',
    relationship: 'A candidate MCP or workflow integration for teams using Microsoft 365.',
    status: 'building',
    starlings: { mcp: 'building', team: 'no', cards: 'no' },
    brings: ['files', 'mcp', 'delegation'],
  },
} as const satisfies Record<AgentProductID, {
  kind: string;
  source: string;
  capabilities: string;
  relationship: string;
  status: AgentStatus;
  starlings: Record<StarlingsPath, PathState>;
  brings: readonly Ability[];
}>;

/** One row per product in `@starlings/contracts/agent-products`, in its order, named as it names them. */
export const AGENT_ECOSYSTEM = AGENT_PRODUCTS.map((product) => ({ id: product.id, name: product.label, ...RESEARCH[product.id] }));

/** Where an agent's name links: its page on this site when it has one, else its provider's page. */
export function agentHref(agent: (typeof AGENT_ECOSYSTEM)[number]): { href: string; external: boolean } {
  return agentPage(agent.id) ? { href: `/integrations/${agent.id}`, external: false } : { href: agent.source, external: true };
}

/** The table's columns, read by the page and its markdown twin (`page-markdown.tsx`). */
export const PATHS: ReadonlyArray<[StarlingsPath, string]> = [
  ['mcp', t('MCP, as you')],
  ['team', t('Team agent')],
  ['cards', t('Work cards')],
];

export const PATH_LABEL: Record<PathState, string> = {
  works: t('Works'),
  building: t('Building'),
  research: t('Research'),
  no: '—',
};

export const ABILITIES: ReadonlyArray<[Ability, string]> = [
  ['browser', t('Browser')],
  ['terminal', t('Terminal')],
  ['files', t('Files')],
  ['mcp', t('MCP')],
  ['memory', t('Memory')],
  ['schedules', t('Schedules')],
  ['skills', t('Skills')],
  ['delegation', t('Delegation')],
];

/** The note under the table: where its facts come from and what a mark means. */
export const AGENT_TABLE_NOTE = t('Researched on 3 October 2026 from each product’s linked source. A dash means the source does not list it. Only Works is a supported connection; Building and Research are not commitments.');

const HEAD = 'h-auto px-2.5 py-2 text-center text-[12px] font-medium whitespace-nowrap text-muted-foreground';
const CELL = 'px-2.5 py-3.5 text-center text-[13px]';

/**
 * Every agent product as a row: how it works with Starlings, then what its
 * own source says it can do. Rows follow `@starlings/contracts/agent-products`;
 * a product's name links to that source. On a narrow screen the table
 * scrolls inside its card.
 */
export function AgentTable() {
  const noteId = useId();
  return (
    <>
      <div className="overflow-hidden rounded-(--radius-card) border border-border">
        <Table className="min-w-[960px]" aria-describedby={noteId}>
          <TableHeader className="bg-muted/40">
            <TableRow className="border-border">
              <TableHead scope="col" rowSpan={2} className="pl-4 align-bottom text-[12px] font-medium text-muted-foreground">{t('Agent')}</TableHead>
              <TableHead scope="colgroup" colSpan={PATHS.length} className={cn(HEAD, 'border-l border-border text-foreground')}>{t('With Starlings')}</TableHead>
              <TableHead scope="colgroup" colSpan={ABILITIES.length} className={cn(HEAD, 'border-l border-border text-foreground')}>{t('What it brings')}</TableHead>
            </TableRow>
            <TableRow className="border-border">
              {PATHS.map(([id, label], index) => <TableHead key={id} scope="col" className={cn(HEAD, index === 0 && 'border-l border-border')}>{label}</TableHead>)}
              {ABILITIES.map(([id, label], index) => <TableHead key={id} scope="col" className={cn(HEAD, index === 0 && 'border-l border-border')}>{label}</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {AGENT_ECOSYSTEM.map((agent) => {
              const link = agentHref(agent);
              return (
              <TableRow key={agent.name} className="hover-lift border-border last:border-b-0">
                <TableCell className="min-w-[200px] py-3.5 pl-4 whitespace-normal">
                  <a href={link.href} {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})} className="inline-flex items-center gap-1 font-medium text-foreground no-underline hover:underline">
                    {agent.name}
                    {link.external && <ArrowUpRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.7} />}
                  </a>
                  <span className="block text-[12px] text-muted-foreground">{agent.kind}</span>
                </TableCell>
                {PATHS.map(([id], index) => {
                  const state = agent.starlings[id];
                  return (
                    <TableCell key={id} className={cn(CELL, index === 0 && 'border-l border-border', state === 'works' ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                      {state === 'works' && <span aria-hidden="true" className="mr-1.5 inline-block size-2 rounded-full bg-(--accent-mark) align-middle" />}
                      {state === 'no' ? <span aria-label={t('No')}>—</span> : PATH_LABEL[state]}
                    </TableCell>
                  );
                })}
                {ABILITIES.map(([id], index) => (
                  <TableCell key={id} className={cn(CELL, index === 0 && 'border-l border-border')}>
                    {(agent.brings as readonly Ability[]).includes(id)
                      ? <Check aria-label={t('Listed')} className="mx-auto size-4 text-foreground" strokeWidth={2} />
                      : <span aria-label={t('Not listed')} className="text-muted-foreground">—</span>}
                  </TableCell>
                ))}
              </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {/* The note sits under the frame, not in a caption, so it wraps to the page width while the table scrolls. */}
      <p id={noteId} className="mt-3 mb-0 max-w-[48rem] text-[13px] leading-relaxed text-muted-foreground">
        {AGENT_TABLE_NOTE}
      </p>
    </>
  );
}
