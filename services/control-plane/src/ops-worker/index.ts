// The `starlings-ops` Worker on the ops host (wrangler.ops.jsonc,
// docs/OPS_CONSOLE.md). The platform operator console: the product
// dashboard (a shadcn app in web/ops, served from this Worker's static
// assets) and the JSON it reads, `GET /api/fleet`, with every workspace's
// Docs and Keep; a page of what each
// workspace costs per function (costs.ts); and the sign-up requests.
//
// Every request passes the operator check first (access.ts), whatever its
// path or method, the dashboard's files included: `run_worker_first` sends
// every request here before the assets. The Worker keeps no data. It reads
// each workspace's metadata over a service binding to that workspace's
// `OpsService`.
import type { JWTVerifyGetKey } from 'jose';
import { opsDashboardRoute, type OpsFleet } from '@starlings/contracts/ops';
import { verifyOperator } from './access';
import type { OpsEnv } from './env';
import { bindingRegistry, boundServices, type FleetService, type WorkspaceRegistry } from './fleet';
import { costLines, renderCostsPage, SHARED_PLANS, totalUSD } from './costs';
import { readService, readWorkspace, type ServiceRow, type WorkspaceRow } from './page';
import { handleRequestsPost, renderRequestsPage, sameOrigin, type InterestSourceStub, type Notice, type SignupAdminStub } from './requests';

const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  // same-origin, not no-referrer: under no-referrer a browser sends
  // `Origin: null` on the Requests forms, and requests.ts refuses a POST
  // whose Origin is not this host. Other sites still get no referrer.
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex',
};

/**
 * The dashboard's files. Its script and stylesheet come from this host only;
 * `unsafe-inline` styles are for the chart library, which sets colours and
 * sizes in `style` attributes.
 */
const DASHBOARD_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' } });
}

export interface OpsFetchOptions {
  /** Tests give local keys; production reads the team's certs. */
  keysFor?: (team: string) => JWTVerifyGetKey;
  registry?: WorkspaceRegistry;
  services?: FleetService[];
  timeoutMs?: number;
}

export async function handleOpsFetch(request: Request, env: OpsEnv, options: OpsFetchOptions = {}): Promise<Response> {
  const access = await verifyOperator(request, env, options.keysFor);
  if (!access.ok) {
    // The reason only. Never the address or the token (AGENTS.md invariant 10).
    console.warn(`ops.access_refused ${access.reason}`);
    return text('Not allowed.', 403);
  }

  const url = new URL(request.url);
  if (url.pathname === '/requests' || url.pathname.startsWith('/requests/')) return requestsPage(request, env, access.email, url.pathname);
  if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method not allowed.', 405);
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/fleet') return text('Not found.', 404);

  if (url.pathname === '/costs') {
    const workspaces = await (options.registry ?? bindingRegistry(env)).workspaces();
    const rows = await Promise.all(workspaces.map((workspace) => readWorkspace(workspace, options.timeoutMs)));
    return html(renderCostsPage(rows), request.method);
  }
  if (url.pathname === '/api/fleet') {
    const fleet = await readFleet(env, options);
    return new Response(request.method === 'HEAD' ? null : JSON.stringify(fleet), {
      status: 200,
      headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' },
    });
  }
  return dashboardAsset(request, env);
}

/** Every workspace and service at once, a failed one as an error row, with each workspace's cost per month. */
export async function readFleet(env: OpsEnv, options: OpsFetchOptions = {}, now = Date.now()): Promise<OpsFleet> {
  const workspaces = await (options.registry ?? bindingRegistry(env)).workspaces();
  const signup = env.SIGNUP_ADMIN as SignupAdminStub | undefined;
  const [rows, services, pending] = await Promise.all([
    Promise.all(workspaces.map((workspace) => readWorkspace(workspace, options.timeoutMs))),
    Promise.all((options.services ?? boundServices(env)).map((service) => readService(service, options.timeoutMs))),
    pendingRequests(signup),
  ]);
  return {
    checked_at: now,
    workspaces: rows.map(fleetWorkspace),
    services: services.map(fleetService),
    costs: rows.flatMap((row) => row.ok
      ? row.metadata.usage.map((month) => ({ slug: row.workspace.slug, month: month.month, usd: totalUSD(costLines(month)) }))
      : []),
    shared_usd: SHARED_PLANS.reduce((sum, plan) => sum + plan.usd, 0),
    pending_requests: pending,
  };
}

function fleetWorkspace(row: WorkspaceRow): OpsFleet['workspaces'][number] {
  const { slug, host } = row.workspace;
  return row.ok ? { slug, host, ok: true, metadata: row.metadata } : { slug, host, ok: false, error: row.error };
}

function fleetService(row: ServiceRow): OpsFleet['services'][number] {
  const { slug, kind } = row.service;
  return row.ok ? { slug, kind, ok: true, metadata: row.metadata } : { slug, kind, ok: false, error: row.error };
}

/** Sign-up requests that wait for an operator: submitted, approved, or failed in provisioning. Null when starlings-auth does not answer. */
async function pendingRequests(signup: SignupAdminStub | undefined): Promise<number | null> {
  if (!signup) return null;
  try {
    const { requests } = await signup.list();
    return requests.filter((request) => request.state === 'submitted' || request.state === 'approved' || request.state === 'failed').length;
  } catch {
    return null;
  }
}

/** The dashboard's files, from the static assets (web/ops/dist), under the dashboard's CSP. */
async function dashboardAsset(request: Request, env: OpsEnv): Promise<Response> {
  const assets = env.ASSETS as Fetcher | undefined;
  if (!assets) return text('The dashboard is not built.', 503);
  const url = new URL(request.url);
  // A dashboard page answers with index.html, so a link to it loads.
  const response = await assets.fetch(opsDashboardRoute(url.pathname) ? new Request(new URL('/', url), request) : request);
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  headers.set('content-security-policy', DASHBOARD_CSP);
  // The hashed bundles may stay in the browser; the page itself never does.
  if (url.pathname.startsWith('/assets/')) headers.set('cache-control', 'private, max-age=31536000, immutable');
  return new Response(response.body, { status: response.status, headers });
}

function html(body: string, method: string): Response {
  return new Response(method === 'HEAD' ? null : body, {
    status: 200,
    headers: { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' },
  });
}

/** GET /requests, and the two POSTs that act on it (requests.ts). */
async function requestsPage(request: Request, env: OpsEnv, operator: string, path: string): Promise<Response> {
  const signup = env.SIGNUP_ADMIN as SignupAdminStub | undefined;
  let notice: Notice | null = null;
  if (request.method === 'POST') {
    if (path !== '/requests/mint' && path !== '/requests/decide' && path !== '/requests/revoke') return text('Not found.', 404);
    if (!sameOrigin(request)) return text('Not allowed.', 403);
    if (!signup) return text('Signup is not bound.', 503);
    notice = await handleRequestsPost(request, signup, operator, path, interestSource(env));
  } else if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text('Method not allowed.', 405);
  } else if (path !== '/requests') {
    return text('Not found.', 404);
  }
  if (!signup) return html(renderRequestsPage({ error: 'starlings-auth is not bound (SIGNUP_ADMIN).' }, notice), request.method);
  const source = interestSource(env);
  const [data, interests] = await Promise.all([
    signup.list().catch((error: unknown) => ({ error: `No answer from starlings-auth: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) })),
    source
      ? source.interests().catch((error: unknown) => ({ error: `No answer from hq: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) }))
      : Promise.resolve({ error: 'hq is not bound (HQ_INTERESTS), so interest requests cannot be read.' }),
  ]);
  return html(renderRequestsPage(data, notice, Date.now(), interests), request.method);
}

/**
 * Where interest requests are: hq, which the product site forwards the form
 * to (services/control-plane/src/interest.ts), over its `InterestService`.
 */
function interestSource(env: OpsEnv): InterestSourceStub | null {
  return (env.HQ_INTERESTS as InterestSourceStub | undefined) ?? null;
}

export default {
  fetch: (request: Request, env: OpsEnv): Promise<Response> => handleOpsFetch(request, env),
} satisfies ExportedHandler<OpsEnv>;
