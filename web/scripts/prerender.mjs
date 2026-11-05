// The public pages, rendered to HTML at build time so an agent that reads the
// raw response, with no JavaScript, gets the words a person sees. Runs after
// `vite build`: each page's React tree is rendered on the server into a copy
// of the built index.html, written next to it as `<path>.html`, which the
// Worker's assets serve at `<path>`. The browser still boots the SPA, which
// replaces the markup with the same page.
//
// Alongside: a markdown twin for every page that is markdown at source
// (`/changelog.md`, `/help/<slug>.md`), `robots.txt`, `sitemap.xml`, and the
// shell's own fallback for every other address. The words are in
// web/agent-surface.ts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changelogWithNext } from '../../scripts/changelog-updates.mjs';

process.env.NODE_ENV = 'production';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(webDir, '..');
const distDir = path.join(webDir, 'dist');

const { createServer } = await import('vite');
const { createElement } = await import('react');
const { renderToString } = await import('react-dom/server');

const server = await createServer({
  root: webDir,
  configFile: path.join(webDir, 'vite.config.ts'),
  mode: 'production',
  server: { middlewareMode: true, hmr: false, watch: null },
  appType: 'custom',
  logLevel: 'error',
});

const { PUBLIC_PAGES, ROBOTS_TXT, pageHeadHtml, pageTitle, shellFallbackHtml, shellHeadHtml, sitemapXml } = await server.ssrLoadModule('/agent-surface.ts');
const load = (file) => server.ssrLoadModule(`/src/${file}`);
const { helpDocs } = await server.ssrLoadModule('virtual:meet-help');

const helpTitle = (doc) => /^#\s+(.+)\n/u.exec(doc.body)?.[1]?.trim() || doc.slug.slice(doc.slug.lastIndexOf('/') + 1);

const pages = [];

const shell = readFileSync(path.join(distDir, 'index.html'), 'utf8');
if (!shell.includes('<div id="root"></div>') || shell.includes('<noscript>')) throw new Error('prerender: run it on a fresh `vite build`; dist/index.html is not the bare shell');

function write(relPath, contents) {
  const file = path.join(distDir, relPath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

try {
  for (const page of pages) {
    const mod = await load(page.file);
    const body = renderToString(createElement(mod[page.name], page.props ?? {}));
    if (body.length < 200) throw new Error(`prerender: ${page.path} rendered ${body.length} characters`);
    const html = shell
      .replace(/<title>[^<]*<\/title>/u, `<title>${pageTitle(page)}</title>\n    ${pageHeadHtml(page)}`)
      .replace('<div id="root"></div>', `<div id="root">${body}</div>`);
    write(`${page.path.slice(1)}.html`, html);
    if (page.markdown) write(`${page.path.slice(1)}.md`, page.markdown);
  }

  write('robots.txt', ROBOTS_TXT);
  write('sitemap.xml', sitemapXml(['/', ...pages.map((page) => page.path)]));
  // Last, because every page above was built from the bare shell.
  write('index.html', shell
    .replace(/(<title>[^<]*<\/title>)/u, `$1\n    ${shellHeadHtml()}`)
    .replace('<div id="root"></div>', `<div id="root"></div>\n    ${shellFallbackHtml()}`));

  console.log(`prerendered ${pages.length} public pages`);
} finally {
  await server.close();
}
