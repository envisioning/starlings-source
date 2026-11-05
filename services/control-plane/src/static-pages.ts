import { identityDomains } from './workspace-identity';
import { workspaceDefaults } from './workspace-defaults';
import { workspaceClientDefaultsSchema } from '@starlings/contracts/workspace-defaults';
import { MCP_CONNECT_PATH, MCP_PATH } from '@starlings/contracts/mcp';
import { HELP_PAGES, helpPath } from '@starlings/contracts/help';
import { isProductSitePath } from '@starlings/contracts/paths';
import { parsePermalinkPath } from '@starlings/contracts/permalinks';
import { parsePublicBookPath, parsePublicEventPath, parsePublicRoomPath } from './contracts';
import { isPublicRoom } from './member-rooms';
import { publicNotFound } from './public-pages';
import { pageShareHead } from './event-page';
import { accentPalette, accentStylesheet } from '@starlings/contracts/workspace-accent';
import { serveWorkspaceIcon, serveWorkspaceMark, WORKSPACE_ICON_PATH, WORKSPACE_MARK_PATH, workspaceAccent, workspaceIconPath, workspaceMarkPath, workspaceName } from './workspace-profile';
import { workspaceSuite } from './workspace-suite';
import { workspaceServices } from './workspace-descriptor';
import { docsEnabled } from './docs';
import { workspacePublicOrigin } from './workspace-origins';
import { SERVED_WEB_ORIGIN } from '@starlings/contracts/deployment';

/**
 * Everything that is not `/api/`: the web app's pages and files, served from
 * the assets binding, and a 404 for what is neither.
 */
export async function serveStatic(request: Request, env: Env, path: string): Promise<Response> {
  if (path === WORKSPACE_MARK_PATH) return serveWorkspaceMark(request, env);
  if (path === WORKSPACE_ICON_PATH) return serveWorkspaceIcon(request, env);
  if (!isStaticAssetPath(path) && !(await isAllowedPublicDocument(path, env))) {
    return publicNotFound(request);
  }
  if ('ASSETS' in env && env.ASSETS) {
    // An agent that asks for markdown gets the page's source, where it has
    // one (web/scripts/prerender.mjs writes `<path>.md` beside `<path>.html`).
    const twin = markdownTwinFor(request, path);
    if (twin) {
      const markdown = await env.ASSETS.fetch(new Request(twin, request));
      if (markdown.ok) {
        const response = new Response(markdown.body, markdown);
        response.headers.set('vary', 'Accept');
        return response;
      }
    }
    const page = await env.ASSETS.fetch(request);
    if (page.ok && AGENT_TEXT_PATHS.has(path)) return agentTextOnOwnOrigin(request, page, env);
    const html = page.headers.get('content-type')?.startsWith('text/html') ?? false;
    // A missing file with an extension (`/.well-known/mcp.json`, `/x.json`)
    // gets the SPA shell from `not_found_handling`. An agent that probes a
    // path reads that 200 as "exists", so it answers 404 here.
    if (html && isStaticAssetPath(path) && !/\.html?$/iu.test(path)) return publicNotFound(request);
    if (!html && !hasMarkdownTwin(path)) return page;
    const response = new Response(page.body, page);
    if (hasMarkdownTwin(path)) response.headers.set('vary', 'Accept');
    // Every page points an agent at the index and the MCP door without
    // parsing HTML (RFC 8288).
    if (html) response.headers.set('link', `</llms.txt>; rel="describedby"; type="text/plain", <${MCP_PATH}>; rel="service"`);
    const brand = html ? await workspaceHead(env) : '';
    const icon = html ? await workspaceIconPath(env) : null;
    // Every page answers a link preview: an event shows the event,
    // a room whose room it is, the rest the workspace (event-page.ts). Its
    // title and description replace the shell's; they never add a second set.
    const share = html ? await pageShareHead(env, new URL(request.url)) : null;
    const describes = share?.meta.includes('name="description"') ?? false;
    if (brand || share) {
      const rewriter = new HTMLRewriter();
      // The workspace's favicon replaces the product's; the home screen icon stays.
      if (icon) rewriter.on('link[rel="icon"], link[rel="shortcut icon"]', { element: (link) => { link.remove(); } });
      if (share?.title) rewriter.on('title', { element: (title) => { title.setInnerContent(share.title ?? ''); } });
      if (describes) rewriter.on('meta[name="description"]', { element: (meta) => { meta.remove(); } });
      // A prerendered page that carries its own card keeps it.
      let ownCard = false;
      rewriter.on('meta[property="og:title"]', { element: () => { ownCard = true; } });
      const head = `${brand}${icon ? `<link rel="icon" href="${escapeAttribute(icon)}" type="image/svg+xml">` : ''}`;
      return rewriter
        .on('head', { element: (element) => { element.onEndTag((end) => { end.before(`${head}${ownCard ? '' : share?.meta ?? ''}`, { html: true }); }); } })
        .transform(response);
    }
    return response;
  }
  return publicNotFound(request);
}

/**
 * The files that send an agent somewhere by absolute URL. Every workspace
 * serves the same build, written with the build's origin; each one answers
 * with its own `WEB_ORIGIN` instead, so no agent on one workspace is sent to
 * another's MCP. On the build's own workspace this changes nothing.
 */
const AGENT_TEXT_PATHS: ReadonlySet<string> = new Set(['/llms.txt', '/llms-full.txt', '/sitemap.xml']);

async function agentTextOnOwnOrigin(request: Request, page: Response, env: Env): Promise<Response> {
  const own = new URL(env.WEB_ORIGIN).origin;
  const headers = new Headers(page.headers);
  headers.delete('content-length');
  headers.delete('etag');
  if (request.method === 'HEAD') return new Response(null, { status: page.status, headers });
  const text = await page.text();
  return new Response(own === SERVED_WEB_ORIGIN ? text : text.replaceAll(SERVED_WEB_ORIGIN, own), { status: page.status, headers });
}

/**
 * The workspace's accent as CSS (; contracts/workspace-accent.ts),
 * appended last in `<head>` so it replaces the fixed profile's tokens. Null
 * when the workspace sets no usable accent (workspace-profile.ts), as on
 * Envisioning. Derived once per isolate.
 */
let accentCache: { value: string | null; css: string | null } | null = null;
async function workspaceAccentStyle(env: Env): Promise<string | null> {
  const value = await workspaceAccent(env);
  if (!accentCache || accentCache.value !== value) {
    const palette = value ? accentPalette(value) : null;
    accentCache = { value, css: palette ? accentStylesheet(palette) : null };
  }
  return accentCache.css;
}

const escapeAttribute = (value: string) => value.replace(/[&"<>]/gu, (char) => `&#${char.charCodeAt(0)};`);

/**
 * What the page's `<head>` learns about the workspace: its name and mark
 * (web/src/workspace-brand.ts), its accent, its identity domains
 * (web/src/workspace-identity.ts), where its mail and calendar live
 * and whether it has Docs (web/src/workspace-brand.ts), and whether it counts usage. Name, mark and accent are empty on
 * Envisioning, the fixed profile; the domains are always written.
 */
async function workspaceHead(env: Env): Promise<string> {
  const parts: string[] = [];
  parts.push(`<meta name="identity-domains" content="${escapeAttribute(identityDomains(env).join(','))}">`);
  // web/src/config.ts builds room, booking and meeting links on it.
  parts.push(`<meta name="public-web-origin" content="${escapeAttribute(workspacePublicOrigin(env))}">`);
  parts.push(`<meta name="workspace-suite" content="${await workspaceSuite(env)}">`);
  const defaults = await workspaceDefaults(env);
  const clientDefaults = { ...workspaceClientDefaultsSchema.strip().parse(defaults), contact_email: defaults.contact_email, privacy_email: defaults.privacy_email };
  parts.push(`<meta name="workspace-defaults" content="${escapeAttribute(JSON.stringify(clientDefaults))}">`);
  // web/src/workspace-brand.ts lists Docs only when this workspace has it.
  parts.push(`<meta name="workspace-docs" content="${docsEnabled(env) ? 'on' : 'off'}">`);
  // The same service origin the descriptor names; null offers no Core links.
  const services = workspaceServices(env);
  parts.push(`<meta name="workspace-core" content="${escapeAttribute(services.core ?? 'off')}">`);
  // The groups Core still holds; a record of a moved group has no Core link.
  parts.push(`<meta name="workspace-core-groups" content="${escapeAttribute((services.core_groups ?? []).join(','))}">`);
  const name = await workspaceName(env);
  if (name) parts.push(`<meta name="workspace-name" content="${escapeAttribute(name)}">`);
  const mark = await workspaceMarkPath(env);
  if (mark) parts.push(`<meta name="workspace-mark" content="${escapeAttribute(mark)}">`);
  const accent = await workspaceAccentStyle(env);
  if (accent) parts.push(`<style id="workspace-accent">${accent}</style>`);
  // web/src/analytics.ts counts use only when this is here (docs/ANALYTICS.md).
  if (env.PLAUSIBLE_DOMAIN?.trim()) parts.push('<meta name="analytics" content="on">');
  return parts.join('');
}

/**
 * `/changelog` and every `/help` page are markdown at source, and the build
 * writes that source beside the page. A request that prefers `text/markdown`
 * over HTML is sent to it.
 */
function markdownTwinFor(request: Request, path: string): string | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const accept = request.headers.get('accept') ?? '';
  if (!/text\/markdown/iu.test(accept) || /text\/html/iu.test(accept)) return null;
  if (!hasMarkdownTwin(path)) return null;
  return new URL(`${path.replace(/\/$/u, '')}.md`, request.url).toString();
}

function hasMarkdownTwin(path: string): boolean {
  const clean = path.replace(/\/$/u, '');
  return clean === '/changelog' || (isHelpPath(clean) && clean !== '/help' && clean !== '/help/glossary');
}

/** `/help`, `/help/glossary`, and one path per page in the generated help index. */
function isHelpPath(path: string): boolean {
  const clean = path.replace(/\/$/u, '');
  if (clean === '/help' || clean === '/help/glossary') return true;
  return HELP_PAGES.some((page) => clean === helpPath(page.slug));
}

function isStaticAssetPath(path: string): boolean {
  if (path === '/favicon.ico' || path === '/glyph.svg') return true;
  if (path.startsWith('/assets/')) return true;
  return /\.[a-z0-9]{2,8}$/iu.test(path);
}

/**
 * Which paths get the SPA shell. Exported for the test that pins the member
 * destinations. Only canonical documents qualify; a root `/<slug>` is not a
 * room and 404s. A syntactically valid room path gets the shell even when its
 * slug is unmapped, so the SPA can render a useful room-not-found state. The
 * API remains authoritative about whether that room exists.
 */
export async function isAllowedPublicDocument(path: string, env: Env): Promise<boolean> {
  if (
    path === '/'
    // The product site — why, features, pricing, changelog, interest, and
    // the legal documents — is one list in the contracts package, shared
    // with the SPA router and the web's ProductNav.
    || isProductSitePath(path)
    // The product docs (docs/help/), the pages llms.txt links to.
    || isHelpPath(path)
    || path === '/support' || path === '/support/'
    // SPA shell only — not visitor IA. The API still 403s the unauthenticated.
    // Admin's sections by verb, plus a page per connector (docs/ADMIN.md
    // §10). `/admin/org` and `/connectors*` stay served so the SPA can redirect
    // an old link to its new address.
    || path === '/admin' || path === '/admin/'
    || path === '/admin/agents' || path === '/admin/agents/'
    || path === '/admin/people' || path === '/admin/people/'
    || path === '/admin/operations' || path === '/admin/operations/'
    || path === '/admin/connectors' || path === '/admin/connectors/'
    || path === '/admin/connectors/granola' || path === '/admin/connectors/granola/'
    || path === '/admin/connectors/github' || path === '/admin/connectors/github/'
    || path === '/admin/connectors/slack' || path === '/admin/connectors/slack/'
    || path === '/admin/records' || path === '/admin/records/'
    || path === '/admin/activity' || path === '/admin/activity/'
    || path === '/admin/jobs' || path === '/admin/jobs/'
    || path === '/admin/org' || path === '/admin/org/'
    // Member workspace destinations. Serving the shell is not authorization:
    // /api/peers and the calendar routes still refuse anyone without a
    // verified Envisioning session, and the pages show the sign-in door.
    || path === '/team' || path === '/team/'
    || path === '/agents' || path === '/agents/'
    || path === '/join' || path === '/join/'
    || path === '/calendar' || path === '/calendar/'
    || path === '/work' || path === '/work/'
    // Work's in-place sections are browser destinations too (App.tsx owns
    // this route grammar); allow the SPA shell on a refresh or shared link.
    || /^\/work\/(mine|internal|envisioning|projects|leads|partners|browse|signals|licenses|catalog)\/?$/iu.test(path)
    || /^\/work\/offers\/[0-9a-f-]{36}\/?$/iu.test(path)
    || path === '/docs' || path === '/docs/'
    // A guest's page (docs/ACCESS.md slice 4): `/guest` once signed in,
    // `/guest/<link secret>` to open a link. The page reads /api/guest/*.
    || path === '/guest' || path === '/guest/'
    || /^\/guest\/[A-Za-z0-9_-]{20,200}\/?$/u.test(path)
    // A record's permalink: `/team/agent/<sub>`, `/work/task/<id>`.
    // The contract that parses it is the one the SPA routes with.
    || parsePermalinkPath(path) !== null
    || path === '/meetings' || path === '/meetings/'
    || path === '/connectors' || path === '/connectors/'
    || path === '/connectors/granola' || path === '/connectors/granola/'
    || path === '/connectors/github' || path === '/connectors/github/'
    || path === '/connectors/slack' || path === '/connectors/slack/'
    // One meeting's transcript: /meetings/<room>/<meeting id>.
    || /^\/meetings\/[a-z0-9-]{2,40}\/[0-9a-f-]{36}\/?$/u.test(path)
    || path === '/settings' || path === '/settings/'
    // The MCP consent page (docs/MCP.md decision 12). Shell only; the
    // authorize POST still needs a session.
    || path === MCP_CONNECT_PATH || path === `${MCP_CONNECT_PATH}/`
  ) {
    return true;
  }
  // A room document is only a public UI shell: it is safe to serve for any
  // syntactically valid slug, including an unmapped one. The API still 404s
  // the lookup, and the SPA turns that into the same designed state as the
  // other room entry screens. A *booking* document is public rooms only — the
  // internal room has no booking door.
  const parsedRoom = parsePublicRoomPath(path);
  if (parsedRoom) return true;
  // An event's sign-up page (docs/SESSIONS.md §0): a public shell for any
  // valid slug, as a room is. The API 404s a slug with no event.
  if (parsePublicEventPath(path)) return true;
  const parsedBook = parsePublicBookPath(path);
  if (parsedBook) return isPublicRoom(env, parsedBook.slug);
  return false;
}
