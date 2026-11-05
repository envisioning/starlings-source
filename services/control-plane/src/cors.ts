import { WORKSPACE_HOST_SUFFIX } from '@starlings/contracts/workspace-slug';
import { isWorkspaceOrigin } from './workspace-origins';
import { recommendedUpgradeHeaders } from './client-version';
import { formFor } from '@starlings/contracts/forms';
import { formAllowsOrigin } from './forms';
import { workspaceSlug } from './workspace-origins';

const FORM_PATH = /^\/api\/forms\/([a-z][a-z0-9-]{1,40})$/u;

/**
 * An outside page a form lists may post that form and read the answer
 *: `POST` with `content-type`, never credentials. Every other
 * outside origin gets no CORS headers, so its browser blocks the request.
 */
function outsideFormOrigin(request: Request, env: Env, origin: string | null): string | null {
  const match = FORM_PATH.exec(new URL(request.url).pathname);
  if (!match) return null;
  const form = formFor(workspaceSlug(env), match[1]!);
  return form && formAllowsOrigin(form, origin) ? origin : null;
}

// The cross-origin and client-upgrade headers every answer gets. Moved out of
// `index.ts` with the CRM routes: one CRM route wraps its own answer.

export function addCORS(response: Response, request: Request, env: Env): Response {
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  const origin = request.headers.get('origin');
  const formOrigin = isWorkspaceOrigin(origin, env) ? null : outsideFormOrigin(request, env, origin);
  if (formOrigin) {
    headers.set('access-control-allow-origin', formOrigin);
    headers.set('access-control-allow-methods', 'POST, OPTIONS');
    headers.set('access-control-allow-headers', 'content-type');
    headers.set('access-control-max-age', '600');
  } else {
    if (isWorkspaceOrigin(origin, env)) {
      headers.set('access-control-allow-origin', origin);
      headers.set('access-control-allow-credentials', 'true');
    }
    headers.set('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    headers.set('access-control-allow-headers', 'authorization, content-type, x-meet-client');
  }
  headers.append('vary', 'Origin');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('permissions-policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()');
  // Turnstile needs a script and an iframe from Cloudflare's challenge origin,
  // which nothing else here is allowed. Granted only while the secret is set,
  // so the policy stays tight on every deploy that has no widget — and so
  // turning bot checking on can never be half-done: the same switch that makes
  // the Worker enforce is the one that lets the browser load the challenge.
  const turnstileOrigin = env.TURNSTILE_SECRET_KEY?.trim() ? ' https://challenges.cloudflare.com' : '';
  // A handler that set its own policy meant it, and this one is written for
  // the app's own pages. The issue-image route is the case: it serves bytes
  // somebody uploaded, from this origin, to anyone — so it asks for
  // `default-src 'none'; sandbox`, which is stricter than anything sensible
  // here, and replacing it with the page policy would quietly undo that.
  if (!headers.has('content-security-policy')) {
    headers.set(
      'content-security-policy',
      "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; "
        // `blob:` on scripts: Krisp (web/src/noise-filter.ts) loads its
        // AudioWorklet from a blob URL it builds from its own bundle, and a
        // worklet module answers to script-src, not worker-src. Without it
        // the filter never starts and the guest gets browser suppression only.
        + `script-src 'self' 'wasm-unsafe-eval' blob:${turnstileOrigin}; frame-src 'self'${turnstileOrigin}; `
        // `https:` on images only: a subject's `organization_logo_url` is a
        // curated URL on the organization's own host, which the Mac and the
        // phone fetch directly. Without it the browser blocks every logo and
        // the web draws the kind glyph instead. `referrer-policy: no-referrer`
        // above keeps the page out of the request.
        + "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob:; "
        // MediaPipe's wasm and segmenter model are staged into the SPA bundle
        // by web/vite.config.ts, so background effects need no third-party
        // origin. `*.<suffix>`: Settings › Workspaces reads another
        // workspace's public descriptor to add it; no
        // credentials go with it.
        + `worker-src 'self' blob:; connect-src 'self' wss: https://*.${WORKSPACE_HOST_SUFFIX}`,
    );
  }
  if (new URL(request.url).protocol === 'https:') {
    headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Add advisory update headers without reading or buffering the response body. */
export function addUpgradeHeaders(response: Response, request: Request, env: Env): Response {
  const upgrade = recommendedUpgradeHeaders(request.headers.get('x-meet-client'), env);
  if (response.status === 101 || Object.keys(upgrade).length === 0) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(upgrade)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
