import { t } from '../../src/i18n';
import { USE_CASES, DEMO_PROJECTS, DEMO_NOTICE, SETUP_NOTICE, AUDIENCES, QUESTION, setupFor, draftRows, sourceRecords, useCaseHref } from './use-cases';
import { capabilityById, SURFACE_STATUS_LABEL } from '@starlings/contracts/capabilities';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { capabilityRegistryMarkdown, glossaryMarkdown, PUBLIC_PAGES } from '../../agent-surface';
import { ABILITIES, AGENT_ECOSYSTEM, AGENT_TABLE_NOTE, PATHS, PATH_LABEL, agentHref } from './AgentEcosystem';
import { FAQ_GROUPS } from './faq';
import { TENTPOLES, TENTPOLES_TITLE, PRODUCT_AREAS, PRODUCT_AREAS_TITLE, PRODUCT_MESSAGE, PRODUCT_AGENT_MESSAGE, PRODUCT_ATTENTION_MESSAGE, productAreaHref, THEMES, feature, surfacesOf, theme, type FeatureId, type ThemeId } from './features';
import { inlineMarkdown } from './markdown';
import { interestGuideMarkdown } from '@starlings/contracts/interest-agent';

/*
 * The markdown twins (`<path>.md`) of the pages that draw a registry. The
 * HTML of these pages tells part of a fact in a drawing (a tile's figure, a
 * check mark in a table); the twin tells it from the registry the drawing
 * is made from, so the two cannot disagree. Every other page's twin is its
 * own HTML, converted (`markdown.ts`). marketing/prerender.mjs frames the
 * body with the page's title, description and address (`markdownTwin`).
 */

type Context = { origin: string; path: string };

/** A ReactNode from a registry (a row's text, a lede) as one line of markdown, links kept. */
function nodeMarkdown(node: ReactNode, context: Context): string {
  return inlineMarkdown(renderToStaticMarkup(<>{node}</>), { base: `${context.origin}${context.path}` });
}

/** A line that links one public page with its own description. */
function pageLink(pagePath: string, context: Context): string {
  const page = PUBLIC_PAGES.find((entry) => entry.path === pagePath);
  if (!page) throw new Error(`No public page at ${pagePath}`);
  return `- [${page.title}](${context.origin}${page.path}): ${page.description}`;
}

/** One feature: its name, its sentence, its facts, and where it works. */
function featureMarkdown(id: FeatureId, context: Context): string {
  const entry = feature(id);
  const surfaces = surfacesOf(entry);
  const rows = [
    ...(entry.rows ?? []).map(([label, text]) => `- **${label}**: ${nodeMarkdown(text, context)}`),
    ...(surfaces.length ? [`- **Works on**: ${surfaces.join(', ')}`] : []),
  ];
  const more = entry.more ? `More: [${entry.more.label}](${new URL(entry.more.href, `${context.origin}${context.path}`).toString()})` : '';
  return [`### ${entry.title}`, entry.fact, rows.join('\n'), more].filter(Boolean).join('\n\n');
}

/** One theme: its title and lede as a section, then its features. `head: false` when the twin's own title is the theme's. */
function themeMarkdown(id: ThemeId, context: Context, head = true): string {
  const entry = theme(id);
  return [head ? `## ${entry.title}` : '', nodeMarkdown(entry.lede, context), ...entry.features.map((featureId) => featureMarkdown(featureId, context))].filter(Boolean).join('\n\n');
}

function capabilitiesBody(context: Context): string {
  return [t('The full feature library, grouped by topic.'), ...THEMES.filter((entry) => entry.page === '/workspace/capabilities').map((entry) => themeMarkdown(entry.id, context))].join('\n\n');
}

function featuresBody(context: Context): string {
  const areas = [
    `## ${PRODUCT_AREAS_TITLE}`,
    ...PRODUCT_AREAS.map((area) => `- **[${area.name}](${context.origin}${productAreaHref(area)})**: ${area.outcome}`),
    PRODUCT_AGENT_MESSAGE,
    `${PRODUCT_ATTENTION_MESSAGE} [${feature('attention').title}](${context.origin}/integrations#feature-attention).`,
  ].join('\n\n');
  const tentpoles = [`## ${TENTPOLES_TITLE}`, ...TENTPOLES.map((entry) => [`### ${entry.title}`, entry.headline, entry.summary, ...entry.steps.map((step, index) => `- **${step}**: ${entry.captions[index]}`), entry.scope].join('\n\n'))].join('\n\n');
  return [PRODUCT_MESSAGE, tentpoles, areas, pageLink('/workspace/capabilities', context), '## More', [pageLink('/security', context), pageLink('/integrations', context)].join('\n')].join('\n\n');
}

/** The agent table: how each product works with Starlings, then what its own source lists. */
function agentTable(context: Context): string {
  const header = ['Agent', 'Type', ...PATHS.map(([, label]) => label), ...ABILITIES.map(([, label]) => label)];
  const cell = (text: string) => text.replace(/\|/gu, '\\|');
  const rows = AGENT_ECOSYSTEM.map((agent) => {
    const link = agentHref(agent);
    const href = link.external ? link.href : `${context.origin}${link.href}`;
    return [
      `[${agent.name}](${href})`,
      agent.kind,
      ...PATHS.map(([path]) => (agent.starlings[path] === 'no' ? '—' : PATH_LABEL[agent.starlings[path]])),
      ...ABILITIES.map(([ability]) => ((agent.brings as readonly string[]).includes(ability) ? 'Listed' : '—')),
    ].map(cell);
  });
  const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

function integrationsBody(context: Context): string {
  const agentPages = PUBLIC_PAGES.filter((page) => page.path.startsWith('/integrations/')).map((page) => pageLink(page.path, context));
  return [
    themeMarkdown('agents', context),
    '## Agents that work with Starlings',
    agentTable(context),
    AGENT_TABLE_NOTE,
    '### One page per agent',
    agentPages.join('\n'),
    themeMarkdown('connectors', context),
    '## The open standard',
    [
      `- [Agent instructions](${context.origin}/agents): what an agent reads before it works in a Starlings workspace. Markdown: ${context.origin}/agents.md`,
      `- [Skills](${context.origin}/skills): portable skills in the Agent Skills format. Markdown: ${context.origin}/skills.md`,
    ].join('\n'),
  ].join('\n\n');
}

/**
 * What /integrations/<id> says about the agent in the table on /integrations:
 * its row as facts. The rest of that page's twin is its own HTML.
 */
export function agentFactsMarkdown(id: string): string {
  const agent = AGENT_ECOSYSTEM.find((row) => row.id === id);
  if (!agent) throw new Error(`No agent ${id} in AGENT_ECOSYSTEM`);
  const brings = ABILITIES.filter(([ability]) => (agent.brings as readonly string[]).includes(ability)).map(([, label]) => label);
  return [
    `## ${agent.name} at a glance`,
    [
      `- **Type**: ${agent.kind}`,
      ...PATHS.map(([path, label]) => `- **${label}**: ${agent.starlings[path] === 'no' ? 'No' : PATH_LABEL[agent.starlings[path]]}`),
      `- **What its source lists**: ${brings.length ? brings.join(', ') : 'none of the abilities the table tracks'}`,
      `- **What it does**: ${agent.capabilities}`,
      `- **With Starlings**: ${agent.relationship}`,
      `- **Source**: ${agent.source}`,
    ].join('\n'),
    AGENT_TABLE_NOTE,
  ].join('\n\n');
}

function securityBody(context: Context): string {
  return [themeMarkdown('data', context, false), '## More', [pageLink('/privacy', context)].join('\n')].join('\n\n');
}

function faqBody(context: Context): string {
  return FAQ_GROUPS.map((group) => [
    `## ${group.title}`,
    ...group.entries.map((entry) => {
      const more = entry.more ? ` [${entry.more.label}](${new URL(entry.more.href, `${context.origin}${context.path}`).toString()}).` : '';
      return `### ${entry.question}\n\n${entry.answer}${more}`;
    }),
  ].join('\n\n')).join('\n\n');
}

const REGISTRY_PAGES: Record<string, (context: Context) => string> = {
  '/workspace': featuresBody,
  '/workspace/capabilities': capabilitiesBody,
  '/workspace/status': (context) => capabilityRegistryMarkdown(context.origin),
  '/integrations': integrationsBody,
  '/security': securityBody,
  '/faq': faqBody,
  '/help/glossary': () => glossaryMarkdown(),
  // The form's twin is the guide an agent follows to fill it in (docs/FORMS.md §Agents).
  '/interest': (context) => interestGuideMarkdown(context.origin),
};

/** The twin's body for a page drawn from a registry, or undefined when the page's HTML is its source. */
export function registryMarkdown(path: string, origin: string): string | undefined {
  if (path === '/use-cases') return [DEMO_NOTICE, ...USE_CASES.map((job) => `## [${job.title}](${origin}${useCaseHref(job)})\n\n${job.summary}`), SETUP_NOTICE].join('\n\n') + '\n';
  const job = USE_CASES.find((entry) => useCaseHref(entry) === path);
  if (job) return [job.summary, DEMO_NOTICE,
    `## ${t('A request to adapt')}\n\n${job.prompt}`,
    ...DEMO_PROJECTS.map((project) => [
      `## ${project.name}`,
      ...sourceRecords(project).map((source) => `### ${source.title}\n\n${source.body}`),
      `### ${job.output}`,
      ...draftRows(job, project).map((row) => `- **${row.label}**: ${row.text}${row.source ? ` (${sourceRecords(project).find((source) => source.id === row.source)!.title})` : ''}`),
      ...(job.slug === 'agent-needs-an-answer' ? [`${QUESTION} ${AUDIENCES.join(' / ')}. ${t('One answer resolves the same question in chat and Inbox. It does not authorize publication.')}`] : []),
    ].join('\n\n')),
    `## ${t('Review')}\n\n${job.review}`,
    `## ${t('Try it in your workspace')}\n\n${setupFor(job)}`,
    `## ${t('What is available today')}`,
    ...job.capabilities.map((id) => { const row = capabilityById(id)!; return `- **${row.name}**: Mac: ${SURFACE_STATUS_LABEL[row.surfaces!['mac-host']]}; iOS: ${SURFACE_STATUS_LABEL[row.surfaces!.ios]}; Web: ${SURFACE_STATUS_LABEL[row.surfaces!.web]}.`; }),
    `[${t('Read the product instructions')}](${origin}${job.help}) · [${job.slug === 'agent-needs-an-answer' ? t('Connect an agent as a team member') : t('Connect Claude over MCP')}](${origin}${job.slug === 'agent-needs-an-answer' ? '/help/howto/connect-an-agent-as-a-team-member' : '/help/howto/connect-claude'}) · [${t('Full capability and agent access status')}](${origin}/workspace/status)`,
  ].join('\n\n') + '\n';
  const render = REGISTRY_PAGES[path];
  return render ? `${render({ origin, path }).trim()}\n` : undefined;
}
