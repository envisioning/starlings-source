import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { changelogWithNext } from '../../scripts/changelog-updates.mjs';
import { ORG_WEB_ORIGIN, PRODUCT_SITE_ORIGIN } from '../../packages/contracts/src/deployment-values.ts';
const root = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(root, '..');
const repo = path.resolve(web, '..');
const output = path.join(root, 'dist');
const origin = PRODUCT_SITE_ORIGIN;
process.env.NODE_ENV = 'production';

async function openServer() {
  globalThis.MEET_PAGE_LANGUAGE = 'en';
  const opened = await createServer({ root, configFile: path.join(root, 'vite.config.ts'), mode: 'production', server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom', logLevel: 'error' });
  return { server: opened };
}

/**
 * A help doc's summary as a sentence for a meta description: a shortcut
 * that ends a clause (`⌘3`) and a clause that is only a path (`` `/work` ``) go, the rest loses
 * its backticks, and it ends with a period.
 */
function helpDescription(summary) {
  const clauses = summary.replace(/\s*⌘[^\s;]+(?=\s*(?:;|$))/gu, '').split(';').map((clause) => clause.trim()).filter((clause) => clause && !/^`[^`]*`$/u.test(clause));
  const text = clauses.reduce((sentence, clause) => !sentence ? clause : /\.$/u.test(sentence) ? `${sentence} ${clause.charAt(0).toUpperCase()}${clause.slice(1)}` : `${sentence}; ${clause}`, '');
  const plain = text.replace(/`/gu, '').replace(/\s+/gu, ' ').trim();
  return /[.!?]$/u.test(plain) ? plain : `${plain}.`;
}

/** Render one page's body, with the page's path where the site chrome reads it. */
function renderPage(Component, props, pagePath) {
  globalThis.MEET_PAGE_PATH = pagePath;
  return renderToString(createElement(Component, props ?? {}));
}

const { server } = await openServer();
let pages;
let jsonLdFor;
try {
  const { PUBLIC_PAGES, SITE_FORM_PAGES, pageHeadHtml, pageTitle, shareHeadHtml, absoluteStandardLinks, agentsMarkdown, markdownTwin, markdownTwinPath, llmsProductPart } = await server.ssrLoadModule(path.join(web, 'agent-surface.ts'));
  const { fieldNotes } = await server.ssrLoadModule('virtual:meet-field-notes');
  const { fieldNoteMarkdown } = await server.ssrLoadModule(path.join(root, 'field-notes.ts'));
  const fieldNotePages = fieldNotes.map(note => ({ path: `/field-notes/${note.slug}`, file: 'marketing/src/FieldNotesPage.tsx', name: 'FieldNotesPage', props: { slug: note.slug }, title: note.title, description: note.description }));
  const publicPages = [...PUBLIC_PAGES, ...fieldNotePages];
  // The markdown twin of a page with no markdown source: its registry where it draws one, else its own HTML converted.
  const { htmlToMarkdown, mainOf } = await server.ssrLoadModule(path.join(root, 'src/markdown.ts'));
  const { registryMarkdown, agentFactsMarkdown } = await server.ssrLoadModule(path.join(root, 'src/page-markdown.tsx'));
  const publicPaths = new Set(publicPages.map(page => page.path));
  /** Every twin written, by page path, for llms-full.txt and the guard below. */
  const twins = new Map();
  function productTwin(page, body) {
    const url = `${origin}${page.path}`;
    let content = registryMarkdown(page.path, origin) ?? htmlToMarkdown(mainOf(body), { base: url, headingShift: 1 });
    if (page.name === 'AgentPage') content = `${content.trim()}\n\n${agentFactsMarkdown(page.props.slug)}`;
    return markdownTwin({ title: page.title, description: page.description, url, body: content });
  }
  const { FAQ_ENTRIES } = await server.ssrLoadModule(path.join(root, 'src/faq.ts'));
  // The share cards (og/card.tsx): the house wallpaper and the app's dark window.
  const { familyOf, ogImagePath, ogImagePng } = await server.ssrLoadModule(path.join(root, 'og/card.tsx'));
  // Structured data for search engines, by page: the FAQ as FAQPage, written from the same entries the page draws.
  const faqJsonLd = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQ_ENTRIES.map(entry => ({ '@type': 'Question', name: entry.question, acceptedAnswer: { '@type': 'Answer', text: entry.answer } })) };
  jsonLdFor = { '/faq': faqJsonLd };
  const fieldNotesByPath = new Map(fieldNotes.map(note => [`/field-notes/${note.slug}`, note]));
  for (const [pagePath, note] of fieldNotesByPath) {
    jsonLdFor[pagePath] = {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: note.title,
      description: note.description,
      datePublished: note.published,
      dateModified: note.updated,
      inLanguage: note.locale,
      articleSection: 'Field notes',
      author: { '@type': 'Organization', name: note.author },
      publisher: { '@type': 'Organization', name: 'Envisioning', url: ORG_WEB_ORIGIN },
      mainEntityOfPage: { '@type': 'WebPage', '@id': `${origin}${pagePath}` },
      image: `${origin}${ogImagePath(pagePath)}`,
    };
  }
  // Each page's link preview, at /og/<path>.png.
  async function writeOgImage(page) {
    const file = path.join(output, ogImagePath(page.path).slice(1));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, await ogImagePng(page));
  }
  const { helpDocs } = await server.ssrLoadModule('virtual:meet-help');
  const { standard } = await server.ssrLoadModule('virtual:meet-standard');
  // The open standard (ADR 0005): /agents and /skills only on the product site, each with a markdown twin.
  const standardPages = [
    { path: '/agents', file: 'marketing/src/StandardPages.tsx', name: 'AgentsPage', title: standard.agents.title, description: 'How an agent works on subjects: the model, authority, approval, errors and the MCP tools.', markdown: agentsMarkdown(standard.agents.body, standard.tools, origin) },
    { path: '/spec', file: 'marketing/src/StandardPages.tsx', name: 'SpecPage', title: standard.spec.title, description: `The Starlings Subject Spec, version ${standard.spec.version}: subject kinds, doors and records.`, markdown: `${standard.spec.body.trim()}\n\nJSON Schema: ${origin}/spec/schema.json\n` },
    { path: '/skills', file: 'marketing/src/StandardPages.tsx', name: 'SkillsPage', props: { name: null }, title: 'Skills', description: 'How an agent works on a subject, as skills it can install.', markdown: ['# Skills', '', ...standard.skills.map(skill => `- [${skill.name}](${origin}/skills/${skill.name}): ${skill.description} Install: ${origin}/skills/${skill.name}/SKILL.md`), ''].join('\n') },
    ...standard.skills.map(skill => ({ path: `/skills/${skill.name}`, file: 'marketing/src/StandardPages.tsx', name: 'SkillsPage', props: { name: skill.name }, title: skill.title, description: skill.description, markdown: absoluteStandardLinks(skill.body, origin) })),
  ];
  pages = [...publicPages, ...SITE_FORM_PAGES,
    ...standardPages,
    ...helpDocs.map(doc => ({ path: `/help/${doc.slug}`, file: 'marketing/src/HelpPage.tsx', name: 'HelpPage', props: { slug: doc.slug }, title: /^#\s+(.+)\n/u.exec(doc.body)?.[1] ?? doc.slug, description: helpDescription(doc.summary), markdown: doc.body }))];
  // analytics.js counts the visit (docs/ANALYTICS.md); deferred, it never holds the page.
  const appearanceScript = '<script src="/appearance.js"></script><script src="/analytics.js" defer></script>';
  const shell = (await readFile(path.join(output, 'pages.html'), 'utf8')).replace('<head>', `<head>${appearanceScript}`);
  for (const entry of pages) {
    const mod = await server.ssrLoadModule(path.join(web, entry.file));
    const body = renderPage(mod[entry.name], entry.props, entry.path);
    if (body.length < 200) throw new Error(`Empty marketing page: ${entry.path}`);
    // The twin is known before the head is written, so the head can link it.
    const fieldNote = fieldNotesByPath.get(entry.path);
    const markdown = entry.markdown ?? (fieldNote ? markdownTwin({ title: fieldNote.title, description: fieldNote.description, url: `${origin}${entry.path}`, body: fieldNoteMarkdown(fieldNote, fieldNotes, origin) }) : entry.markdownSource ? await changelogWithNext(repo) : publicPaths.has(entry.path) || registryMarkdown(entry.path, origin) ? productTwin(entry, body) : undefined);
    const page = { ...entry, markdown };
    const html = shell.replace(/<title>[^<]*<\/title>/u, `<title>${pageTitle(page)}</title>${pageHeadHtml(page, origin, { image: ogImagePath(page.path), jsonLd: jsonLdFor[page.path], ogType: fieldNote ? 'article' : 'website' })}`).replace('<div id="root"></div>', `<div id="root">${body}</div>`);
    await writeOgImage(page);
    const file = path.join(output, page.path.slice(1) + '.html');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, html);
    if (markdown) {
      await writeFile(file.replace(/\.html$/, '.md'), markdown);
      twins.set(page.path, markdown);
    }
  }
  // The early access request an agent sends, as JSON Schema (docs/FORMS.md §Agents).
  const { interestAgentJsonSchema } = await server.ssrLoadModule(path.join(repo, 'packages/contracts/src/interest-agent.ts'));
  await writeFile(path.join(output, 'interest.schema.json'), `${JSON.stringify(interestAgentJsonSchema(origin), null, 2)}\n`);
  // The spec's JSON Schema, generated from standard/src/schema.ts at build time.
  await mkdir(path.join(output, 'spec'), { recursive: true });
  await writeFile(path.join(output, 'spec', 'schema.json'), `${JSON.stringify(standard.spec.schema, null, 2)}\n`);
  // The conformance suite, byte for byte from standard/conformance/.
  await mkdir(path.join(output, 'spec', 'conformance'), { recursive: true });
  for (const [name, text] of [['cases.json', standard.spec.conformance.cases], ['run.mjs', standard.spec.conformance.runner], ['reference-adapter.mjs', standard.spec.conformance.adapter]]) await writeFile(path.join(output, 'spec', 'conformance', name), text);
  // The installable file, byte for byte, beside each skill's page.
  for (const skill of standard.skills) {
    await mkdir(path.join(output, 'skills', skill.name), { recursive: true });
    await writeFile(path.join(output, 'skills', skill.name, 'SKILL.md'), skill.source);
  }
  // The home page is a React component rendered to static HTML here; it ships no
  // script of its own. Its header and footer are the same components as every other page.
  const { HomePage } = await server.ssrLoadModule(path.join(root, 'src/HomePage.tsx'));
  const homeTemplate = await readFile(path.join(root, 'index.html'), 'utf8');
  const homeTitle = /<title>([^<]*)<\/title>/u.exec(homeTemplate)[1];
  const homeHeadline = homeTitle.replace(/^Starlings: /u, '');
  // The preview image shows the headline as a sentence; the tags carry the title as written.
  const homePage = { path: '/', title: homeHeadline.charAt(0).toUpperCase() + homeHeadline.slice(1), description: /<meta name="description" content="([^"]*)"/u.exec(homeTemplate)[1] };
  // The home page says what Starlings is to a search engine: the product, and who makes it.
  const homeJsonLd = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'Organization', '@id': `${origin}/#envisioning`, name: 'Envisioning', url: ORG_WEB_ORIGIN },
    { '@type': 'WebSite', '@id': `${origin}/#website`, name: 'Starlings', url: `${origin}/`, publisher: { '@id': `${origin}/#envisioning` } },
    { '@type': 'SoftwareApplication', name: 'Starlings', url: `${origin}/`, applicationCategory: 'BusinessApplication', operatingSystem: 'macOS, iOS, Web', description: homePage.description, publisher: { '@id': `${origin}/#envisioning` } },
  ] };
  await writeOgImage(homePage);
  const homeBody = renderPage(HomePage, {}, '/');
  const homeTwin = markdownTwin({ title: homePage.title, description: homePage.description, url: `${origin}/`, body: htmlToMarkdown(mainOf(homeBody), { base: `${origin}/`, headingShift: 1 }) });
  await writeFile(path.join(output, markdownTwinPath('/').slice(1)), homeTwin);
  twins.set('/', homeTwin);
  const home = homeTemplate
    .replace('<head>', `<head>${appearanceScript}`)
    .replace('<!--share-->', `<link rel="alternate" type="text/markdown" href="${markdownTwinPath('/')}" />\n    ${shareHeadHtml({ title: homeTitle, description: homePage.description, url: `${origin}/`, image: `${origin}${ogImagePath('/')}`, jsonLd: homeJsonLd })}`)
    .replace('<!--home-->', homeBody);
  if (home.includes('<!--home-->') || home.includes('<!--share-->') || !home.includes('id="sim-calls"')) throw new Error('Home page not rendered');
  // The call simulation renders above as its first frame, for a reader without JS;
  // then the script and stylesheet Vite built from hero.html take over #sim-calls. The
  // stylesheet goes before house.css so the house tokens and element rules win, as on
  // the React pages.
  const heroShell = await readFile(path.join(output, 'hero.html'), 'utf8');
  const heroHead = [...heroShell.matchAll(/<(?:script|link)\b[^>]*>(?:<\/script>)?/gu)].map(([tag]) => tag);
  if (!heroHead.some(tag => tag.startsWith('<script'))) throw new Error('Hero script missing from the built hero.html');
  const withHero = home
    .replace('<link rel="stylesheet" href="/house.css">', `${heroHead.filter(tag => tag.startsWith('<link')).join('\n  ')}\n  <link rel="stylesheet" href="/house.css">`)
    .replace('</body>', `${heroHead.filter(tag => tag.startsWith('<script')).join('\n')}\n</body>`);
  await writeFile(path.join(output, 'index.html'), withHero);
  await rm(path.join(output, 'hero.html'));
  // /brand/og: every share card on one page, for us. Static HTML with no client
  // route, noindex, and not in the sitemap.
  const { OgGalleryPage } = await server.ssrLoadModule(path.join(root, 'src/OgGalleryPage.tsx'));
  const galleryCards = [homePage, ...pages].map(page => ({ path: page.path, title: page.title, image: ogImagePath(page.path), family: familyOf(page.path) ?? 'Home' }));
  const gallery = shell
    .replace(/<title>[^<]*<\/title>/u, '<title>Share cards · Starlings</title><meta name="robots" content="noindex" />')
    .replace('<div id="root"></div>', `<div id="root">${renderToString(createElement(OgGalleryPage, { cards: galleryCards }))}</div>`);
  await mkdir(path.join(output, 'brand'), { recursive: true });
  await writeFile(path.join(output, 'brand', 'og.html'), gallery);
  // /start: the signup page (docs/ONBOARDING.md). Its words depend on the token in
  // the address fragment, so it renders in the browser only: an empty shell,
  // noindex, not in PUBLIC_PAGES or the sitemap.
  await writeFile(path.join(output, 'start.html'), shell
    .replace(/<title>[^<]*<\/title>/u, '<title>Start your workspace · Starlings</title><meta name="robots" content="noindex" />'));
  // /interest/confirm: the same kind of page, for the token an agent's request mails (docs/FORMS.md §Agents).
  await mkdir(path.join(output, 'interest'), { recursive: true });
  await writeFile(path.join(output, 'interest', 'confirm.html'), shell
    .replace(/<title>[^<]*<\/title>/u, '<title>Send your request · Starlings</title><meta name="robots" content="noindex" />'));
  for (const name of ['house.css', 'appearance.js', 'analytics.js', '_headers']) await cp(path.join(root, name), path.join(output, name));
  // The icons and the manifest the page heads link, from the app's public folder.
  for (const name of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png']) await cp(path.join(web, 'public', name), path.join(output, name));
  await cp(path.join(web, 'public/fonts'), path.join(output, 'fonts'), { recursive: true });
  await cp(path.join(web, 'public/icons'), path.join(output, 'icons'), { recursive: true });
  await cp(path.join(root, 'wallpapers'), path.join(output, 'wallpapers'), { recursive: true });
  await cp(path.join(root, 'faces'), path.join(output, 'faces'), { recursive: true });
  await cp(path.join(web, 'public/openapi.json'), path.join(output, 'openapi.json'));
  await writeFile(path.join(output, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
  const sitemapUrls = ['/', ...pages.map(p => p.path)].map((pagePath) => `<url><loc>${origin}${pagePath}</loc></url>`);
  await writeFile(path.join(output, 'sitemap.xml'), `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemapUrls.join('')}</urlset>`);
  /*
   * The guard: every public page, and the home page, has a markdown twin
   * with a body. A page added to PUBLIC_PAGES gets one with nothing else to
   * edit; a page whose twin comes out empty fails the build here.
   */
  const thin = ['/', ...publicPaths].filter(pagePath => (twins.get(pagePath) ?? '').replace(/^# .*\n\n> .*\n/u, '').replace(/---\n\nCanonical page: .*\n$/u, '').trim().length < 80);
  if (thin.length) throw new Error(`Public pages with no markdown twin, or an empty one: ${thin.join(', ')}`);
  /*
   * llms-full.txt (written by the Vite build, help pages first) gets the
   * product pages in front, in llms.txt order: the home page, then
   * PUBLIC_PAGES. Feature status is already there as the capability
   * registry, and the changelog is its own file (/changelog.md).
   */
  const productPaths = ['/', ...publicPages.map(page => page.path).filter(pagePath => !pagePath.startsWith('/help') && pagePath !== '/workspace/status' && pagePath !== '/changelog')];
  const llmsFullFile = path.join(output, 'llms-full.txt');
  const helpPart = await readFile(llmsFullFile, 'utf8');
  await writeFile(llmsFullFile, `${llmsProductPart(productPaths.map(pagePath => ({ url: `${origin}${pagePath}`, markdown: twins.get(pagePath) })))}\n---\n\n${helpPart}`);
  console.log(`Prerendered ${pages.length} marketing pages, ${twins.size} markdown twins`);
} finally { await server.close(); }
