// Marketing only. Workspace traffic continues to use the existing Meet hosts.
import { ANALYTICS_BODY_MAX_BYTES, ANALYTICS_EVENT_PATH, parseAnalyticsEvent, plausibleRequest } from '../../../packages/contracts/src/analytics.ts';
import { NATIVE_MAC_ZIP } from '../../../packages/contracts/src/native-app.ts';
import { PLATFORM_WORKSPACE_ORIGIN, PRODUCT_SITE_ORIGIN, WORKSPACE_HOST_SUFFIX } from '../../../packages/contracts/src/deployment-values.ts';

/** The hq workspace's web origin: the enquiry handler checks it, and the row lands in hq's D1. */
const HQ_ORIGIN = PLATFORM_WORKSPACE_ORIGIN;

/** Hosts that only redirect to the product apex: www, and the app domain's bare and www hosts (ADR 0004 decision 2). */
const PRODUCT_HOST = new URL(PRODUCT_SITE_ORIGIN).hostname;
const REDIRECT_HOSTS = new Set([`www.${PRODUCT_HOST}`, WORKSPACE_HOST_SUFFIX, `www.${WORKSPACE_HOST_SUFFIX}`]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (REDIRECT_HOSTS.has(url.hostname)) {
      url.hostname = PRODUCT_HOST;
      return Response.redirect(url.toString(), 301);
    }
    // The app downloads and the update feed (docs/UPDATER.md): before the /api/ refusal and the asset path.
    if (request.method === 'GET' || request.method === 'HEAD') {
      const download = await serveDownload(url.pathname, request, env);
      if (download) return download;
    }
    const forward = INTEREST_FORWARDS.get(url.pathname);
    if (forward && request.method === 'POST') {
      // An agent posts from no page, so its route takes any origin; the form and the confirm page only from this site.
      if (forward.sameOrigin && request.headers.get('origin') !== url.origin) return new Response('Untrusted origin', { status: 403 });
      const headers = new Headers({ 'content-type': request.headers.get('content-type') ?? '', origin: HQ_ORIGIN });
      const ip = request.headers.get('cf-connecting-ip');
      if (ip) headers.set('cf-connecting-ip', ip);
      const response = await env.HQ.fetch(new Request(`${HQ_ORIGIN}${url.pathname}`, { method: 'POST', headers, body: request.body, duplex: 'half' }));
      if (response.ok && forward.counts) count({ name: 'Interest sent', path: forward.counts }, request, env, ctx);
      return response;
    }
    if (SIGNUP_ROUTES.has(url.pathname) && request.method === 'POST') {
      if (request.headers.get('origin') !== url.origin) return new Response('Untrusted origin', { status: 403 });
      return signup(url.pathname, request, env, ctx);
    }
    // A page view or a click from /analytics.js (docs/ANALYTICS.md).
    if (url.pathname === ANALYTICS_EVENT_PATH && request.method === 'POST') {
      if (request.headers.get('origin') !== url.origin) return new Response('Untrusted origin', { status: 403 });
      const event = parseAnalyticsEvent(await readJson(request, ANALYTICS_BODY_MAX_BYTES));
      if (!event) return new Response('Not an event', { status: 400 });
      count(event, request, env, ctx);
      return new Response(null, { status: 202 });
    }
    // The site is English only: an old /pt-BR link lands on the English page.
    if (url.pathname === '/pt-BR' || url.pathname.startsWith('/pt-BR/')) {
      url.pathname = url.pathname.slice('/pt-BR'.length) || '/';
      return Response.redirect(url.toString(), 302);
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/room/') || url.pathname === '/mcp') return new Response('Not found', { status: 404 });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    // An agent that asks for markdown gets the page's twin (`<path>.md`, `/index.md` for the home page) where one exists.
    const twinPath = url.pathname === '/' ? '/index.md' : `${url.pathname.replace(/\/$/u, '')}.md`;
    const twin = /text\/markdown/u.test(request.headers.get('accept') ?? '') && !/\.[a-z]+$/u.test(url.pathname)
      ? await env.ASSETS.fetch(new Request(new URL(twinPath, url.origin), request))
      : null;
    const response = twin?.ok ? twin : await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.append('Vary', 'Accept');
    // A twin, asked for by Accept or by its `.md` address, is markdown (web/marketing/_headers says the same for the asset layer).
    if (twin?.ok || (response.ok && /\.md$/u.test(url.pathname))) headers.set('content-type', 'text/markdown; charset=utf-8');
    // The workers.dev deployment is a preview; the product domain is canonical. /start and /interest/confirm mean nothing without their token.
    if (url.hostname !== PRODUCT_HOST || url.pathname === '/start' || url.pathname === '/interest/confirm') headers.set('X-Robots-Tag', 'noindex');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};

/**
 * The update feed the Mac app polls. cut-release.sh writes it to the gh-pages
 * branch; this site serves it at /updates/starlings.json so the app names a
 * host the product owns, not the repository's Pages address.
 */
const UPDATE_FEED_UPSTREAM = 'https://envisioning.github.io/starlings/updates/starlings.json';
const UPDATE_FEED_PATH = '/updates/starlings.json';

/** `/download/mac/<version>/Starlings-macOS.zip`: a release number or `latest`, nothing else. */
const MAC_ZIP_PATH = new RegExp(`^/download/mac/(\\d+\\.\\d+\\.\\d+|latest)/${NATIVE_MAC_ZIP.replace('.', '\\.')}$`, 'u');

/**
 * The signed Android APK (scripts/android-release.sh --publish), versioned as
 * the Mac zip is: `/download/android/<version>/Starlings-android.apk`.
 */
const ANDROID_APK = 'Starlings-android.apk';
const APK_TYPE = 'application/vnd.android.package-archive';
const ANDROID_APK_PATH = new RegExp(`^/download/android/(\\d+\\.\\d+\\.\\d+|latest)/${ANDROID_APK.replace('.', '\\.')}$`, 'u');

/**
 * The Mac zip, the Android APK, the TestFlight door and the update feed, or
 * null for any other path. The zips and the APK stream from R2
 * (`meet-downloads`), where the releases upload them. Nothing here is a trust
 * boundary: the installer checks notarization, signature, team and version on
 * the bundle it downloaded (scripts/update-app.sh), and Android checks the
 * APK's signature.
 */
async function serveDownload(pathname, request, env) {
  if (pathname === '/download/mac') return serveRelease(request, env, 'mac', 'latest', NATIVE_MAC_ZIP, 'application/zip');
  const zip = MAC_ZIP_PATH.exec(pathname);
  if (zip) return serveRelease(request, env, 'mac', zip[1], NATIVE_MAC_ZIP, 'application/zip');
  if (pathname === '/download/android') return serveRelease(request, env, 'android', 'latest', ANDROID_APK, APK_TYPE);
  const apk = ANDROID_APK_PATH.exec(pathname);
  if (apk) return serveRelease(request, env, 'android', apk[1], ANDROID_APK, APK_TYPE);
  if (pathname === '/download/ios' && request.method === 'GET') return testFlightRedirect(env);
  if (pathname === UPDATE_FEED_PATH && request.method === 'GET') return updateFeed();
  return null;
}

async function serveRelease(request, env, platform, version, filename, contentType) {
  const bucket = env.DOWNLOADS;
  if (!bucket) return new Response('Not found', { status: 404 });
  const key = `${platform}/${version}/${filename}`;
  const object = request.method === 'HEAD' ? await bucket.head(key) : await bucket.get(key);
  if (!object) return new Response('Not found', { status: 404 });
  const headers = new Headers({
    'content-type': contentType,
    'content-length': String(object.size),
    'content-disposition': `attachment; filename="${filename}"`,
    etag: object.httpEtag,
    // A version is forever; `latest` is whatever shipped this morning.
    'cache-control': version === 'latest' ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}

/** The public TestFlight invite. Only an https URL: a bad var never makes this an open redirect. */
function testFlightRedirect(env) {
  let destination;
  try {
    destination = new URL(env.IOS_TESTFLIGHT_URL ?? '');
  } catch {
    return new Response('Not found', { status: 404 });
  }
  if (destination.protocol !== 'https:') return new Response('Not found', { status: 404 });
  return new Response(null, { status: 302, headers: { location: destination.toString(), 'cache-control': 'no-store' } });
}

async function updateFeed() {
  let upstream;
  try {
    upstream = await fetch(UPDATE_FEED_UPSTREAM, { headers: { accept: 'application/json' } });
  } catch {
    return new Response('Update feed unavailable', { status: 502 });
  }
  if (upstream.status !== 200) return new Response('Update feed unavailable', { status: 502 });
  return new Response(upstream.body, {
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60' },
  });
}

/**
 * The enquiry routes carried to hq (docs/FORMS.md): the form, an agent's
 * request, and the person's confirm of it. `counts` is the page an accepted
 * request is counted on; an agent's request counts once confirmed.
 */
const INTEREST_FORWARDS = new Map([
  ['/api/interest', { sameOrigin: true, counts: '/interest' }],
  ['/api/interest/agent', { sameOrigin: false, counts: null }],
  ['/api/interest/confirm', { sameOrigin: true, counts: '/interest/confirm' }],
]);

/*
 * The signup page's three calls (docs/ONBOARDING.md §The signup page). The
 * site Worker only carries them: `SIGNUP` is an RPC binding to starlings-auth's
 * `SignupService`, which owns links, requests and held slugs and answers each
 * call with a shape from `@starlings/contracts/signup`.
 */
const SIGNUP_ROUTES = new Set(['/api/signup/view', '/api/signup/slug', '/api/signup/submit']);
const SIGNUP_BODY_MAX = 32 * 1024;

/**
 * Count one event in Plausible (docs/ANALYTICS.md), after the response and
 * never in its way. Only the product domain counts: the workers.dev preview
 * and a test with no `ctx` send nothing.
 */
function count(event, request, env, ctx) {
  const domain = env.PLAUSIBLE_DOMAIN?.trim();
  if (!domain || !ctx || new URL(request.url).hostname !== PRODUCT_HOST) return;
  ctx.waitUntil(fetch(plausibleRequest(event, request, domain)).catch(() => undefined));
}
const NOT_OPEN = { ok: false, field: null, message: 'Signup is not open yet.' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

/** The request's JSON object, or null when it is not one or is over the limit. */
async function readJson(request, max = SIGNUP_BODY_MAX) {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > max) return null;
  const text = await request.text();
  if (new TextEncoder().encode(text).length > max) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function signup(pathname, request, env, ctx) {
  const view = pathname === '/api/signup/view';
  if (!env.SIGNUP) return json(view ? { state: 'closed' } : NOT_OPEN, 503);
  const body = await readJson(request);
  if (!body) return json(view ? { state: 'closed' } : { ok: false, field: null, message: 'The request was not valid JSON.' }, 400);
  const token = typeof body.token === 'string' ? body.token : '';
  try {
    if (view) return json(await env.SIGNUP.view(token));
    if (pathname === '/api/signup/slug') return json(await env.SIGNUP.checkSlug(token, typeof body.slug === 'string' ? body.slug : ''));
    const result = await env.SIGNUP.submit(body, { ip: request.headers.get('cf-connecting-ip') });
    if (result?.ok === true) count({ name: 'Signup sent', path: '/start' }, request, env, ctx);
    return json(result);
  } catch {
    // starlings-auth failed. The page reads this as a failure it can retry, never as a closed link.
    return json({ ok: false, field: null, message: 'Couldn’t reach signup. Try again.' }, 502);
  }
}
