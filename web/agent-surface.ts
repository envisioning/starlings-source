import { ROBOTS_TXT } from '@starlings/contracts/agent-discovery';
import { SERVED_WEB_ORIGIN, PRODUCT_SITE_ORIGIN } from '@starlings/contracts/deployment';
import { COMPARISON_PAGES, TEAM_PAGES } from './marketing/src/solutions';
import { USE_CASES, useCaseHref } from './marketing/src/use-cases';
import { AGENT_PAGE_LIST } from './marketing/src/agent-page-list';
import { AGENT_PRODUCTS } from '@starlings/contracts/agent-products';
import { withSiteName } from './marketing/src/document-title';
import {
  CAPABILITY_INTENT_BLURB,
  CAPABILITY_INTENT_LABEL,
  CAPABILITY_SURFACES,
  SURFACE_LABEL,
  SURFACE_STATUS_LABEL,
  SURFACE_SUMMARY,
  capabilitySections,
  type Capability,
} from '@starlings/contracts/capabilities';
import { GLOSSARY } from '@starlings/contracts/glossary';

// Every word Meet says to a bot, crawler or language model, in one place.
//
// The rule (AGENTS.md invariant 30): every URL answers a reader that does not
// run JavaScript. Public pages are prerendered to full HTML; every other
// page's shell carries the <noscript> below. On the product site every
// public page also has a markdown twin at `<path>.md` (the home page's is
// `/index.md`): the source where the page is markdown, a registry rendering
// where the page draws a registry (marketing/src/page-markdown.tsx), and the
// page's own HTML converted (marketing/src/markdown.ts) for the rest. What an
// agent reads is written here and nowhere else: web/scripts/prerender.mjs and
// web/marketing/prerender.mjs write the pages, robots.txt, sitemap.xml, the
// twins and the shell's fallback from it, and web/vite.config.ts writes
// llms.txt with it.

export const ORIGIN = SERVED_WEB_ORIGIN;

/** One line on what Meet is, for an agent: llms.txt's blockquote and the shell's no-JavaScript fallback. */
export const PRODUCT_SUMMARY = 'Meetings, calendar, work and team in one workspace, on Mac, iOS and the web. A member’s own agent (Claude, Hermes or any MCP client) reaches it over MCP at `/mcp`, acting as that member.';

/** The shell's description, for a person: what a link preview (Slack, iMessage) shows under a workspace link. */
export const SHELL_DESCRIPTION = 'Calls, chat, work and docs for a team and its agents.';

/** The MCP pairing facts included in llms.txt, with links for the active origin. */
export function mcpPairingLines(origin: string): string[] {
  return [
    `- MCP endpoint: ${origin}/mcp`,
    `- Workspace descriptor: ${origin}/.well-known/meet (name, hosts, sign-in domains, brand)`,
    `- Pairing: Any MCP client that does OAuth 2.1 with dynamic client registration and PKCE pairs as the member who allows it. Only a member of this workspace can pair one. Starlings has no self-serve workspace yet. [How to connect an agent over MCP](${origin}/help/howto/connect-an-agent-over-mcp); [How to connect Claude](${origin}/help/howto/connect-claude).`,
  ];
}

/** The public pages that are not help docs, with the line a reader sees before opening one. */
export type PublicPage = {
  path: string;
  /** The component that draws it, under web/src/. */
  file: string;
  name: string;
  props?: Record<string, unknown>;
  title: string;
  description: string;
  /** Repo-relative markdown the page is rendered from; served beside it as `<path>.md`. */
  markdownSource?: string;
  markdown?: string;
};

export const PUBLIC_PAGES: PublicPage[] = [
  { path: '/assessment', file: 'marketing/src/AssessmentPage.tsx', name: 'AssessmentPage', title: 'Agentic readiness assessment', description: 'Answer ten questions about your team’s work with AI agents. See a score and a practical next step before sharing contact details.' },
  { path: '/field-notes', file: 'marketing/src/FieldNotesPage.tsx', name: 'FieldNotesPage', props: { slug: null }, title: 'Field notes', description: 'Practical notes on working with AI agents in project teams: what to start with, where shared context helps, and how to keep people in control.' },
  { path: '/use-cases', file: 'marketing/src/UseCasesPage.tsx', name: 'UseCasesPage', title: 'Agent use cases', description: 'Interactive examples of client briefs, follow-up work, proposals, research, onboarding and human answers in Starlings, with sources, setup and review.' },
  ...USE_CASES.map((job) => ({ path: useCaseHref(job), file: 'marketing/src/UseCasesPage.tsx', name: 'UseCasesPage', props: { slug: job.slug }, title: job.title, description: job.summary })),
  { path: '/why', file: 'marketing/src/WhyPage.tsx', name: 'WhyPage', title: 'Why Starlings', description: 'Shared project context, company memory in Docs, and an attention queue for human answers: why teams and agents work in Starlings.' },
  { path: '/workspace', file: 'marketing/src/FeaturesPage.tsx', name: 'FeaturesPage', title: 'Workspace', description: 'Work, messages, calls and docs on one project record, supported by Calendar and Keep. See what Starlings does today and where it works.' },
  { path: '/workspace/capabilities', file: 'marketing/src/CapabilitiesPage.tsx', name: 'CapabilitiesPage', title: 'All capabilities', description: 'The full feature library, grouped by topic: calls, messages, work, docs, calendar and the agent connections around them.' },
  { path: '/workspace/status', file: 'marketing/src/FeatureStatusPage.tsx', name: 'FeatureStatusPage', title: 'Feature status', description: 'Every capability in Starlings, where it works, and the door an agent has into it.' },
  { path: '/integrations', file: 'marketing/src/IntegrationsPage.tsx', name: 'IntegrationsPage', title: 'Integrations', description: 'The agents and tools Starlings connects to: Claude over MCP, shared agents, GitHub, Slack, Granola and Google Workspace.' },
  ...AGENT_PAGE_LIST.map((page) => {
    const name = AGENT_PRODUCTS.find((product) => product.id === page.id)!.label;
    return { path: `/integrations/${page.id}`, file: 'marketing/src/AgentPage.tsx', name: 'AgentPage', props: { slug: page.id }, title: `${name} with Starlings`, description: page.description };
  }),
  { path: '/security', file: 'marketing/src/SecurityPage.tsx', name: 'SecurityPage', title: 'Security and data', description: 'Where a Starlings workspace keeps its data, who can see it, and what Starlings never keeps.' },
  { path: '/download', file: 'marketing/src/DownloadPage.tsx', name: 'DownloadPage', title: 'Download', description: 'The Starlings apps for Mac, iPhone and iPad. Whoever hosts a call runs it from an app; everyone else joins from a browser.' },
  { path: '/for', file: 'marketing/src/SolutionPages.tsx', name: 'TeamPage', props: { slug: null }, title: 'Who Starlings is for', description: 'Starlings for consultancies, studios and agencies, research and advisory teams, new companies, and small crews shipping a product.' },
  ...TEAM_PAGES.map((team) => ({ path: `/for/${team.slug}`, file: 'marketing/src/SolutionPages.tsx', name: 'TeamPage', props: { slug: team.slug }, title: `Starlings for ${team.name.toLowerCase()}`, description: team.description })),
  { path: '/compare', file: 'marketing/src/SolutionPages.tsx', name: 'ComparePage', props: { slug: null }, title: 'Compare Starlings', description: 'How Starlings compares with the tools teams use today, and where each one is the better choice.' },
  ...COMPARISON_PAGES.map((page) => ({ path: `/compare/${page.slug}`, file: 'marketing/src/SolutionPages.tsx', name: 'ComparePage', props: { slug: page.slug }, title: `Starlings vs. ${page.name}`, description: page.description })),
  { path: '/customers/envisioning', file: 'marketing/src/CompanyPages.tsx', name: 'CustomerPage', title: 'How Envisioning runs on Starlings', description: 'How Envisioning, a research institute, runs its client calls, chat, tasks, documents and AI agents on Starlings, and which tools it retired.' },
  { path: '/faq', file: 'marketing/src/CompanyPages.tsx', name: 'FaqPage', title: 'Questions and answers', description: 'What teams ask before they try Starlings: data, privacy, AI agents, pricing and early access.' },
  { path: '/about', file: 'marketing/src/CompanyPages.tsx', name: 'AboutPage', title: 'About', description: 'Starlings is built by Envisioning, a research institute that studies how institutions adapt to technological change.' },
  { path: '/pricing', file: 'marketing/src/PricingPage.tsx', name: 'PricingPage', title: 'What Starlings costs', description: 'Proposed Starlings plans, priced per workspace, not per person. Free, Starter, Team and Pro, each step about twice the last.' },
  { path: '/changelog', file: 'marketing/src/ChangelogPage.tsx', name: 'ChangelogPage', title: 'Changelog', description: 'Every Starlings release, newest first. The same notes ship with the Mac and iOS updates.', markdownSource: 'CHANGELOG.md' },
  { path: '/privacy', file: 'marketing/src/PrivacyPage.tsx', name: 'PrivacyPage', title: 'Privacy', description: 'What Starlings collects, where it is stored, who processes it and how long it is kept. Starlings does not record the audio, video or screen share of a call.' },
  { path: '/terms', file: 'marketing/src/PrivacyPage.tsx', name: 'TermsPage', title: 'Terms', description: 'Terms of use for Starlings: early access, acceptable use, your content, and what happens to data when a workspace closes.' },
  { path: '/help', file: 'marketing/src/HelpPage.tsx', name: 'HelpPage', props: { slug: null }, title: 'Help', description: 'How Starlings works: one page per surface, one page per task.' },
  { path: '/help/glossary', file: 'marketing/src/HelpPage.tsx', name: 'HelpPage', props: { slug: 'glossary' }, title: 'Glossary', description: 'What each word means in Starlings, with its source.' },
];

/**
 * Product-site pages that are forms, not reading: prerendered like the rest,
 * but not in the reading list above (the shell's fallback and llms.txt).
 */
export const SITE_FORM_PAGES: PublicPage[] = [
  { path: '/interest', file: 'marketing/src/InterestPage.tsx', name: 'InterestPage', title: 'Request early access', description: 'Request early access to Starlings, open to a few small teams. Tell us how you work today, and we’ll set up a workspace for your team.' },
  { path: '/sign-in', file: 'marketing/src/SignInPage.tsx', name: 'SignInPage', title: 'Sign in', description: 'Sign in to your Starlings workspace: type the workspace name, and Starlings opens the workspace at its own address.' },
];

export { ROBOTS_TXT };

/**
 * A link in `standard/` (ADR 0005) to a skill, written as a file
 * (`../name/SKILL.md`) or a site path (`/skills/name`), rewritten by `to`.
 * The site page turns it into a wikilink; a markdown twin into an absolute
 * URL. The raw SKILL.md download keeps the file link, which is right once
 * the skills sit side by side in an agent's skills folder.
 */
export function standardLinks(body: string, to: (name: string, label: string) => string): string {
  return body.replace(/\[([^\]]+)\]\((?:\.\.\/([a-z0-9-]+)\/SKILL\.md|\/skills\/([a-z0-9-]+))\)/gu, (_, label: string, a?: string, b?: string) => to((a ?? b)!, label));
}

/** A skill link as an absolute URL on `origin`, for the markdown an agent reads. */
export const absoluteStandardLinks = (body: string, origin: string) => standardLinks(body, (name, label) => `[${label}](${origin}/skills/${name})`);

/** The /agents page as markdown: AGENTS.md, then the MCP tool list the build read from mcp.ts. */
export function agentsMarkdown(agentsBody: string, tools: Array<{ name: string; summary: string }>, origin: string): string {
  return [absoluteStandardLinks(agentsBody.trim(), origin), '', '### MCP tools', '', ...tools.map(({ name, summary }) => `- \`${name}\`: ${summary}`), ''].join('\n');
}

/** The product site's twin of a page: `<path>.md`, and `/index.md` for the home page. */
export const markdownTwinPath = (pagePath: string) => (pagePath === '/' ? '/index.md' : `${pagePath}.md`);

/**
 * A product-site page as markdown, framed the same way every time: its title,
 * its description as a blockquote, the body, and the page's address last.
 */
export function markdownTwin({ title, description, url, body }: { title: string; description: string; url: string; body: string }): string {
  // A page whose own headline is its title says it once.
  const text = body.trim().replace(/^##\s+(.+)\n+/u, (line, headline: string) => (headline.replace(/\.$/u, '') === title.replace(/\.$/u, '') ? '' : line));
  return [`# ${title}`, '', `> ${description}`, '', text, '', '---', '', `Canonical page: ${url}`, ''].join('\n');
}

/** The glossary as markdown: /help/glossary's twin and the glossary part of llms-full.txt. */
export function glossaryMarkdown(): string {
  return [
    ...GLOSSARY.map((term) => `- **${term.term}**${term.aliases ? ` (${term.aliases.join(', ')})` : ''}: ${term.meaning} [${term.sources.join(', ')}]`),
    '',
  ].join('\n');
}

/** The doors an agent has into a capability, as one line. "none" when it has no door. */
export function capabilityDoors(row: Capability): string {
  return [
    ...(row.agent?.mcpTools ?? []).map((name) => `MCP tool ${name}`),
    ...(row.agent?.mcpResources ?? []).map((uri) => `MCP resource ${uri}`),
    ...(row.agent?.cli ?? []),
    ...(row.agent?.routes ?? []),
    ...(row.agent?.signedRoutes ?? []).map((route) => `HMAC callback ${route}`),
  ].join(', ')
    // The other three answers. A gap's issue is internal: public text says only "planned".
    || (row.agent?.humanOnly ? `human only (${row.agent.humanOnly})`
      : row.agent?.rule ? `built in (${row.agent.rule})`
      : row.agent?.gap ? 'planned'
      : 'none');
}

/**
 * The capability registry as markdown: /workspace/status's twin and the
 * registry part of llms-full.txt. One row per capability, under the page's
 * own section headings: its stance, where it works, and its agent doors.
 */
export function capabilityRegistryMarkdown(origin: string): string {
  const docLink = (doc: string) => (/^docs\/help\/.+\.md$/u.test(doc) ? `${origin}/help/${doc.replace(/^docs\/help\//u, '').replace(/\.md$/u, '')}` : doc);
  return [
    `One row per capability: its stance (${Object.values(CAPABILITY_INTENT_LABEL).join(', ')}), where it works, and how an agent reaches it: its doors, "human only" or "built in" with the reason, or "planned" when the door is not built yet.`,
    '',
    '## Surfaces',
    '',
    ...CAPABILITY_SURFACES.map((surface) => `- **${SURFACE_LABEL[surface]}** (\`${surface}\`): ${SURFACE_SUMMARY[surface]}`),
    '',
    '## Stances',
    '',
    ...Object.entries(CAPABILITY_INTENT_BLURB).map(([intent, blurb]) => `- **${CAPABILITY_INTENT_LABEL[intent as Capability['intent']]}** (\`${intent}\`): ${blurb}`),
    ...capabilitySections().flatMap((section) => [
      '',
      `## ${section.title}`,
      '',
      ...section.rows.map((row) => {
        const where = row.surfaces ? CAPABILITY_SURFACES.map((surface) => `${SURFACE_LABEL[surface]} ${SURFACE_STATUS_LABEL[row.surfaces?.[surface] ?? 'not-available'].toLowerCase()}`).join(', ') : 'not built';
        const facts = [`${CAPABILITY_INTENT_LABEL[row.intent]}`, where, `agent: ${capabilityDoors(row)}`, ...(row.doc ? [`doc: ${docLink(row.doc)}`] : [])];
        return `- **${row.name}** (\`${row.id}\`): ${facts.join(' · ')}\n  ${row.description}`;
      }),
    ]),
    '',
  ].join('\n');
}

/**
 * The product part of llms-full.txt: each product page's twin, in llms.txt
 * order, marked with its address the way the help pages are.
 */
export function llmsProductPart(twins: Array<{ url: string; markdown: string }>): string {
  return twins.map(({ url, markdown }) => `<!-- ${url} · product -->\n${markdown.trim()}\n`).join('\n---\n\n');
}

const escapeHtml = (text: string) => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

/**
 * What the app shell says to a reader without JavaScript: the shell answers
 * every address that is not a public page — a room, a booking link, a member
 * surface — so it says what those are and where the words are.
 */
export function shellFallbackHtml(): string {
  const links = PUBLIC_PAGES.map((page) => `<li><a href="${page.path}">${escapeHtml(page.title)}</a>: ${escapeHtml(page.description)}</li>`);
  return `<noscript>
      <h1>Starlings</h1>
      <p>${escapeHtml(PRODUCT_SUMMARY.replace(/`/gu, ''))}</p>
      <p>This address is part of the app: a meeting room, a booking page, or a member's workspace. It needs a browser with JavaScript, and a member's sign-in for anything private. Nothing on it is readable without one.</p>
      <p>Readable without JavaScript:</p>
      <ul>
        ${links.join('\n        ')}
        <li><a href="/llms.txt">/llms.txt</a>: the index for language models</li>
        <li><a href="/llms-full.txt">/llms-full.txt</a>: every help page in one file</li>
        <li><a href="/openapi.json">/openapi.json</a>: the internal routes wrapped by MCP</li>
        <li><a href="/connect">/connect</a>: an MCP client opens it to pair with Starlings; see <a href="/help/howto/connect-an-agent-over-mcp">how to connect an agent over MCP</a> and <a href="/help/howto/connect-claude">how to connect Claude</a>.</li>
        <li><a href="/changelog.md">/changelog.md</a>: the changelog as markdown</li>
      </ul>
      <p>An agent acting for a member connects over MCP at <code>/mcp</code> on this address.</p>
    </noscript>`;
}

export function shellHeadHtml(): string {
  return [
    `<meta name="description" content="${escapeHtml(SHELL_DESCRIPTION)}" />`,
    '<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt" />',
  ].join('\n    ');
}

export function pageHeadHtml(page: PublicPage, origin = PRODUCT_SITE_ORIGIN, share?: PageShare): string {
  return [
    `<meta name="description" content="${escapeHtml(page.description)}" />`,
    `<link rel="canonical" href="${origin}${page.path}" />`,
    ...alternateLinks(origin, share?.languages),
    page.markdown ? `<link rel="alternate" type="text/markdown" href="${markdownTwinPath(page.path)}" />` : '',
    '<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt" />',
    share ? shareHeadHtml({ title: page.title, description: page.description, url: `${origin}${page.path}`, image: `${origin}${share.image}`, jsonLd: share.jsonLd, languages: share.languages, ogType: share.ogType }) : '',
  ].filter(Boolean).join('\n    ');
}

/**
 * A page that exists in more than one language: the language it is
 * in, and every version's address, English first. English is x-default.
 */
export type PageLanguages = { current: { hreflang: string; ogLocale: string }; versions: Array<{ hreflang: string; ogLocale: string; path: string }> };

/** What a product-site page adds for link previews and search: its preview image, structured data where it has some, and its languages. */
export type PageShare = { image: string; jsonLd?: object; languages?: PageLanguages; ogType?: 'website' | 'article' };

/** hreflang links, one per version and x-default for the English one. */
export function alternateLinks(origin: string, languages?: PageLanguages): string[] {
  if (!languages) return [];
  const [english] = languages.versions;
  return [
    ...languages.versions.map(({ hreflang, path }) => `<link rel="alternate" hreflang="${hreflang}" href="${origin}${path}" />`),
    `<link rel="alternate" hreflang="x-default" href="${origin}${english.path}" />`,
  ];
}

/**
 * Open Graph and Twitter tags for a link preview, and schema.org JSON-LD. One
 * source for every product-site page and the home page (marketing/prerender.mjs).
 */
export function shareHeadHtml({ title, description, url, image, jsonLd, languages, ogType = 'website' }: { title: string; description: string; url: string; image: string; jsonLd?: object; languages?: PageLanguages; ogType?: 'website' | 'article' }): string {
  return [
    `<meta property="og:site_name" content="Starlings" />`,
    `<meta property="og:type" content="${ogType}" />`,
    languages ? `<meta property="og:locale" content="${languages.current.ogLocale}" />` : '',
    ...(languages?.versions ?? []).filter(({ ogLocale }) => ogLocale !== languages?.current.ogLocale).map(({ ogLocale }) => `<meta property="og:locale:alternate" content="${ogLocale}" />`),
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${escapeHtml(url)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
    // `<` inside a string would end the script element early; JSON allows it escaped.
    jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</gu, '\\u003c')}</script>` : '',
  ].filter(Boolean).join('\n    ');
}

export function pageTitle(page: PublicPage): string {
  return escapeHtml(withSiteName(page.title));
}

export function sitemapXml(paths: string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...paths.map((p) => `  <url><loc>${ORIGIN}${p}</loc></url>`),
    '</urlset>',
    '',
  ].join('\n');
}
