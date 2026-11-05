// Pages move; the old host keeps serving everything else (ADR 0004 decisions
// 9 and 14, §What does not move; step 6).
//
// A browser that opens a page on PAGE_REDIRECT_FROM (Envisioning:
// the legacy workers.dev host) gets a 301 to the same path on
// PAGE_REDIRECT_TO (the built-in workspace's host). Nothing else redirects:
// installed apps and registered Claude connectors call /api, /mcp and the
// OAuth endpoints on the old host, and none of them reliably follow a
// redirect. The downloads and the update feed are the product site's
// (the product site), not a workspace's. The connector consent page (/connect) stays
// too, so an OAuth flow begun on the old host ends there.
//
// "A page" is a top-level navigation: `Sec-Fetch-Mode: navigate`, or, from a
// client that sends no fetch metadata, an Accept that asks for HTML. A fetch,
// an image, a WebSocket or a curl call is served where it is.

const KEPT = /^\/(?:api|mcp|oauth|\.well-known|connect)(?:\/|$)/u;

interface RedirectEnv {
  PAGE_REDIRECT_FROM?: string;
  PAGE_REDIRECT_TO?: string;
}

function exactOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value ? value : null;
  } catch {
    return null;
  }
}

function isNavigation(request: Request): boolean {
  const mode = request.headers.get('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  return (request.headers.get('accept') ?? '').includes('text/html');
}

/** The 301 for a page on the old host, or null to serve the request as it is. */
export function pageRedirect(request: Request, env: RedirectEnv): Response | null {
  const from = exactOrigin(env.PAGE_REDIRECT_FROM);
  const to = exactOrigin(env.PAGE_REDIRECT_TO);
  if (!from || !to || from === to) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);
  if (url.origin !== from || KEPT.test(url.pathname) || !isNavigation(request)) return null;
  return new Response(null, {
    status: 301,
    headers: { location: `${to}${url.pathname}${url.search}`, 'cache-control': 'no-store' },
  });
}
