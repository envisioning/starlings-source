import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { CAPABILITIES, resetRoleCache } from '../src/capabilities';
import { resetPeerRosterCache } from '../src/peers';
import { MCP_OAUTH_PATHS, MCP_PATH } from '@starlings/contracts/mcp';
import { ROUTES, matchRoute, methodsOf, inventoryPaths, samplePath } from '../src/routes';
import inventory from '../../../fixtures/routes.json';

/**
 * Every `/api/` route names its gate, in the route table (`src/routes.ts`).
 * A row cannot be written without a gate and the router applies it before the
 * handler, so this test iterates the rows and proves each gate does what it
 * says: a session gate refuses a call with no session, an admin row refuses a
 * member, a service door refuses an unsigned call, a guest door refuses a call
 * with no proof, an `origin` row refuses a foreign origin. Nothing is read out
 * of the source: a route that is not a row is a 404 (meet#339).
 */

type Route = { method: string; path: string };

// Each of these sweeps sends one request to every route, a few seconds each.
// The margin is for a busy Mac and for Workers Builds.
const ROUTE_SWEEP_TIMEOUT = 120_000;

/**
 * One request into the Worker, called directly. Not `exports.default.fetch`:
 * in the test pool every call through that binding is slower than the one
 * before it, so a file of sweeps (about 1,500 requests) went from 4 s to over
 * 120 s per sweep and turned `Workers Builds: meet` red on main.
 */
async function dispatch(request: Request): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, env, context);
  await waitOnExecutionContext(context);
  return response;
}

/** The table's rows, one per method a client can call (HEAD rides with GET), at a path each `:name` of which is satisfied. */
function tableRoutes(): Array<Route & { gate: (typeof ROUTES)[number]['gate'] }> {
  return ROUTES.flatMap((route) => methodsOf(route)
    .filter((method) => method !== 'HEAD' && method !== 'OPTIONS')
    .map((method) => ({ method, path: samplePath(route), gate: route.gate })));
}

const SESSION_GATES = new Set(['capability', 'admin', 'room-owner', 'room-host']);

/** The table's session-gated `/api/` rows, one per method, at a path each `:name` of which is satisfied. */
function literalRoutes(): Route[] {
  const routes = new Map<string, Route>();
  for (const row of tableRoutes()) {
    if (!row.path.startsWith('/api/') || !SESSION_GATES.has(row.gate.kind)) continue;
    routes.set(`${row.method} ${row.path}`, { method: row.method, path: row.path });
  }
  return [...routes.values()];
}

/** What a refusal looks like: no session, or a session whose role does not reach. */
function refused(status: number): boolean {
  return status === 401 || status === 403;
}

async function call(route: Route, headers: Record<string, string> = {}): Promise<Response> {
  const write = route.method !== 'GET';
  // A write carries the web origin, so `assertTrustedMutation` lets it through
  // to the gate this test is about.
  return dispatch(new Request(`http://local${route.path}`, {
    method: route.method,
    headers: {
      origin: env.WEB_ORIGIN,
      ...(write ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(write ? { body: '{}' } : {}),
  }));
}

async function memberSession(email: string): Promise<Record<string, string>> {
  const response = await dispatch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ada', email }),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}` };
}

describe('route gates', () => {
  it('finds the routes it guards', () => {
    // A table that silently held nothing would pass everything below.
    expect(literalRoutes().length).toBeGreaterThan(200);
  });

  it('refuses every session-gated route without a session', async () => {
    const open: string[] = [];
    for (const route of literalRoutes()) {
      const response = await call(route);
      if (!refused(response.status)) open.push(`${route.method} ${route.path} → ${response.status}`);
    }
    expect(open).toEqual([]);
  }, ROUTE_SWEEP_TIMEOUT);
});

describe('the route table', () => {
  it('has the rows it guards', () => {
    expect(ROUTES.length).toBeGreaterThan(10);
  });

  it('answers each row from that row, so no row hides another', () => {
    const wrong: string[] = [];
    for (const route of ROUTES) {
      for (const method of methodsOf(route)) {
        const found = matchRoute(method, samplePath(route));
        if (found?.route !== route) wrong.push(`${method} ${route.path} → ${found ? found.route.path : 'no row'}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('declares no (method, path) twice', () => {
    const seen = new Set<string>();
    const twice: string[] = [];
    for (const route of ROUTES) {
      for (const method of methodsOf(route)) {
        for (const path of inventoryPaths(route)) {
          const key = `${method} ${path}`;
          if (seen.has(key)) twice.push(key);
          seen.add(key);
        }
      }
    }
    expect(twice).toEqual([]);
  });

  it('gives every public, service and guest door the reason it is open, or the proof it asks for', () => {
    const bare = ROUTES
      .filter((route) => route.gate.kind === 'public' || route.gate.kind === 'internal-hmac' || route.gate.kind === 'guest')
      .filter((route) => {
        const said = route.gate.kind === 'guest' ? route.gate.proof : 'reason' in route.gate ? route.gate.reason : '';
        return said.trim().length < 10;
      })
      .map((route) => route.path);
    expect(bare).toEqual([]);
  });

  it('refuses a call with no proof on a guest door', async () => {
    const open: string[] = [];
    for (const row of tableRoutes().filter((candidate) => candidate.gate.kind === 'guest')) {
      const response = await call(row);
      // Not a 2xx: no token, no answer. The lobby socket answers 426 to a call that is not an upgrade.
      if (response.status < 400) open.push(`${row.method} ${row.path} → ${response.status}`);
    }
    expect(open).toEqual([]);
  }, ROUTE_SWEEP_TIMEOUT);

  it('is what fixtures/routes.json records for it (node scripts/check-client-routes.mjs --write)', () => {
    const recorded = new Set((inventory as { routes: string[] }).routes);
    const missing = ROUTES
      .flatMap((route) => methodsOf(route).filter((method) => method !== 'HEAD' && method !== 'OPTIONS').flatMap((method) => inventoryPaths(route).map((path) => `${method} ${path}`)))
      .filter((key) => !recorded.has(key));
    expect(missing).toEqual([]);
  });

  it('holds the MCP door and its OAuth paths to the contract', () => {
    // The rows spell the paths as literals so the route inventory can read them.
    const taken = (method: string, path: string) => matchRoute(method, path)?.route.path === path;
    expect(taken('POST', MCP_PATH)).toBe(true);
    expect(taken('GET', MCP_OAUTH_PATHS.protectedResource)).toBe(true);
    expect(taken('GET', `${MCP_OAUTH_PATHS.protectedResource}${MCP_PATH}`)).toBe(true);
    expect(taken('GET', MCP_OAUTH_PATHS.authorizationServer)).toBe(true);
    expect(taken('POST', MCP_OAUTH_PATHS.register)).toBe(true);
    expect(taken('GET', MCP_OAUTH_PATHS.authorize)).toBe(true);
    expect(taken('POST', MCP_OAUTH_PATHS.token)).toBe(true);
    expect(taken('POST', MCP_OAUTH_PATHS.revoke)).toBe(true);
  });

  it('names a capability that exists on every capability gate', () => {
    const bad = ROUTES
      .filter((route) => route.gate.kind === 'capability' && !(route.gate.capability in CAPABILITIES))
      .map((route) => route.path);
    expect(bad).toEqual([]);
  });

  it('refuses a member on an admin row', async () => {
    const headers = await memberSession('member-gates@example.com');
    const open: string[] = [];
    for (const row of tableRoutes().filter((candidate) => candidate.gate.kind === 'admin')) {
      const response = await call(row, headers);
      const body = await response.json<{ code?: string }>().catch(() => ({ code: undefined }));
      if (response.status !== 403 || body.code !== 'not_org_admin') open.push(`${row.method} ${row.path} → ${response.status} ${body.code ?? ''}`);
    }
    expect(open).toEqual([]);
  }, ROUTE_SWEEP_TIMEOUT);

  it('refuses an unsigned call on a service door', async () => {
    const open: string[] = [];
    for (const row of tableRoutes().filter((candidate) => candidate.gate.kind === 'internal-hmac')) {
      const response = await call(row);
      // 401 or 403: bad or missing signature. 404: the door is shut while its secret is unset.
      if (![401, 403, 404].includes(response.status)) open.push(`${row.method} ${row.path} → ${response.status}`);
    }
    expect(open).toEqual([]);
  }, ROUTE_SWEEP_TIMEOUT);

  it('refuses a cross-origin write on a row that asks for the origin check', async () => {
    // A cookie session: a bearer token is trusted whatever origin it carries.
    const login = await dispatch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A root admin holds every capability, so the session gate passes and the origin is what is left.
      body: JSON.stringify({ name: 'Ada', email: 'rosa@example.com' }),
    }));
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(cookie).not.toBe('');
    const open: string[] = [];
    for (const route of ROUTES) {
      const gate = route.gate;
      if (!('origin' in gate) || !gate.origin) continue;
      for (const method of methodsOf(route)) {
        const response = await dispatch(new Request(`http://local${samplePath(route)}`, {
          method,
          headers: {
            origin: 'https://elsewhere.example',
            'content-type': 'application/json',
            ...(gate.kind === 'public' || gate.kind === 'guest' ? {} : { cookie }),
          },
          ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
        }));
        const body = await response.json<{ code?: string }>().catch(() => ({ code: undefined }));
        if (response.status !== 403 || body.code !== 'untrusted_origin') open.push(`${method} ${route.path} → ${response.status} ${body.code ?? ''}`);
      }
    }
    expect(open).toEqual([]);
  }, ROUTE_SWEEP_TIMEOUT);

  it('tells a caller with no session so, whatever its origin', async () => {
    const open: string[] = [];
    for (const row of tableRoutes().filter((candidate) => SESSION_GATES.has(candidate.gate.kind) && 'origin' in candidate.gate && candidate.gate.origin !== undefined)) {
      const response = await dispatch(new Request(`http://local${row.path}`, {
        method: row.method,
        headers: { origin: 'https://elsewhere.example', 'content-type': 'application/json' },
        ...(row.method === 'GET' ? {} : { body: '{}' }),
      }));
      if (response.status !== 401) open.push(`${row.method} ${row.path} → ${response.status}`);
    }
    expect(open).toEqual([]);
  }, ROUTE_SWEEP_TIMEOUT);
});


/**
 * Admin acts: a member without the admin role is refused. The Granola key is
 * one person's and reaches their private notes; a connector mapping or a
 * reverse changes what the whole company sees (docs/ADMIN.md §11). The table
 * test above calls every admin row as a member; these are the `/api/admin/`
 * writes and the one health read a member may make.
 */
describe('admin gates', () => {
  it('refuses a member on every /api/admin/ write', async () => {
    const headers = await memberSession('member-gates@example.com');
    const open: string[] = [];
    for (const route of literalRoutes().filter((candidate) => candidate.path.startsWith('/api/admin/') && candidate.method !== 'GET')) {
      const response = await call(route, headers);
      if (response.status === 404 || response.status === 405) continue;
      if (response.status !== 403) open.push(`${route.method} ${route.path} → ${response.status}`);
    }
    expect(open).toEqual([]);
  }, ROUTE_SWEEP_TIMEOUT);

  it('refuses a member connector health: Admin is for admins only', async () => {
    const headers = await memberSession('member-gates@example.com');
    const response = await call({ method: 'GET', path: '/api/admin/connectors' }, headers);
    expect(response.status).toBe(403);
  });
});


// ---------------------------------------------------------------------------
// The session is not the gate (meet#600)
//
// A valid signature and an `@example.com` address prove who somebody was
// when they signed in. They say nothing about whether that person has since
// been revoked, or what their role reaches. Until meet#600, 59 routes behind
// `requireOwner` read neither. These tests keep that from coming back in two
// ways: by reading the source for a guard that is only a session check, and by
// calling every route as a revoked person and as a `community` person.
// ---------------------------------------------------------------------------

const sources = import.meta.glob(['../src/*.ts', '../src/routes/*.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('no guard is only a session check', () => {
  it('finds the guards it reads', () => {
    // A scan that matched nothing would pass everything below.
    expect(ROUTES.filter((route) => SESSION_GATES.has(route.gate.kind)).length).toBeGreaterThan(150);
    expect(Object.keys(sources).length).toBeGreaterThan(40);
  });

  it('every requireOwner( call names a capability that exists', () => {
    const calls = Object.values(sources)
      .flatMap((text) => [...text.matchAll(/requireOwner\(([^)]*)\)/gu)])
      .filter((match) => !/^request: Request/u.test(match[1]!));
    const bad = calls
      .map((match) => match[1]!)
      .filter((args) => {
        const named = /^request, env, '(\w+)'$/u.exec(args.trim());
        return !named || !(named[1]! in CAPABILITIES);
      });
    expect(bad).toEqual([]);
  });

  it('every requireCapability( call in the Worker names a capability that exists', () => {
    const bad: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      for (const match of text.matchAll(/requireCapability\((request[^)]*)\)/gu)) {
        if (/^request: Request/u.test(match[1]!)) continue; // the definition
        if (match[1]!.trim() === 'request, env, capability') continue; // `requireOwner` forwarding its argument
        if (match[1]!.trim() === 'request, env, gate.capability') continue; // the route table's gate, checked against CAPABILITIES below
        const named = /^request, env, '(\w+)'$/u.exec(match[1]!.trim());
        if (!named || !(named[1]! in CAPABILITIES)) bad.push(`${file}: requireCapability(${match[1]})`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('only auth.ts and capabilities.ts read a session without the capability check', () => {
    const readers = Object.entries(sources)
      .filter(([, text]) => /\bgetOwnerSession\(/u.test(text))
      .map(([file]) => file.replace('../src/', ''))
      .sort();
    expect(readers).toEqual(['auth.ts', 'capabilities.ts']);
  });
});

/** Every route a person's session opens, at a path each `:name` of which is satisfied. */
function everyOwnerRoute(): Route[] {
  return literalRoutes();
}

async function personSession(email: string, name = 'Gates'): Promise<Record<string, string>> {
  const headers = await memberSession(email);
  // The `people` row is written by the first authenticated read; revoking and
  // re-roling both need it to exist.
  await dispatch(new Request('http://local/api/peers', { headers }));
  return headers;
}

async function setPerson(email: string, columns: { role?: string; revokedAt?: number | null }): Promise<void> {
  if (columns.role !== undefined) {
    await env.USAGE.prepare('UPDATE people SET role = ?2 WHERE email = ?1').bind(email, columns.role).run();
  }
  if (columns.revokedAt !== undefined) {
    await env.USAGE.prepare('UPDATE people SET revoked_at = ?2 WHERE email = ?1').bind(email, columns.revokedAt).run();
  }
  resetRoleCache();
  resetPeerRosterCache();
}

describe('a revoked person', () => {
  const email = 'revoked-gates@example.com';

  it('is refused at every route, with the session still validly signed', async () => {
    const headers = await personSession(email);
    expect((await call({ method: 'GET', path: '/api/peers' }, headers)).status).toBe(200);
    await setPerson(email, { revokedAt: Date.now() });
    try {
      const open: string[] = [];
      for (const route of everyOwnerRoute()) {
        const response = await call(route, headers);
        if (response.status === 404 || response.status === 405) continue;
        if (response.status !== 401) open.push(`${route.method} ${route.path} → ${response.status}`);
      }
      expect(open).toEqual([]);
    } finally {
      await setPerson(email, { revokedAt: null });
    }
  }, ROUTE_SWEEP_TIMEOUT);

  it('is told to sign in, not that the route is not theirs', async () => {
    const headers = await personSession(email);
    await setPerson(email, { revokedAt: Date.now() });
    try {
      const response = await call({ method: 'GET', path: '/api/search?q=anything' }, headers);
      expect(response.status).toBe(401);
      expect((await response.json<{ code?: string }>()).code).toBe('owner_auth_required');
      expect((await call({ method: 'GET', path: '/api/auth/me' }, headers)).status).toBe(401);
    } finally {
      await setPerson(email, { revokedAt: null });
    }
  });

  it('is let back in on the next request once restored', async () => {
    const headers = await personSession(email);
    await setPerson(email, { revokedAt: Date.now() });
    expect((await call({ method: 'GET', path: '/api/peers' }, headers)).status).toBe(401);
    await setPerson(email, { revokedAt: null });
    expect((await call({ method: 'GET', path: '/api/peers' }, headers)).status).toBe(200);
  });
});

describe('a community person', () => {
  const email = 'community-gates@example.com';

  /**
   * The only routes that hold `ownProfile`, the one capability the table gives
   * `community`. Everything else is `capability_denied`. A line added here is
   * a decision about what an outsider may reach: take it to review.
   */
  const REACHABLE = new Set([
    'GET /api/auth/me',
    'GET /api/auth/devices',
    'POST /api/auth/devices/revoke',
    'GET /api/home/preferences',
    'PUT /api/home/preferences',
    'GET /api/avatar',
    'POST /api/profile/avatar',
    'PUT /api/profile/avatar',
    'DELETE /api/profile/avatar',
    'GET /api/profile/language',
    'PUT /api/profile/language',
    'PATCH /api/peers/profile',
    // Their own setup steps: none are for the community role, so the list is empty.
    'GET /api/setup',
    // Skip is refused for a step the viewer does not have, so for them every step.
    'PUT /api/setup/skip',
  ]);

  it('is refused at every owner route except the ones that are their own', async () => {
    const headers = await personSession(email);
    await setPerson(email, { role: 'community' });
    try {
      const open: string[] = [];
      const reached: string[] = [];
      for (const route of everyOwnerRoute()) {
        const key = `${route.method} ${route.path}`;
        const response = await call(route, headers);
        if (response.status === 404 || response.status === 405) continue;
        const code = await response.json<{ code?: string }>().then((body) => body.code).catch(() => undefined);
        if (response.status === 403 && code === 'capability_denied') continue;
        // Past the capability gate: whatever the route says next (a 400 for an
        // empty body) is its own business.
        if (REACHABLE.has(key)) { reached.push(key); continue; }
        open.push(`${key} → ${response.status} ${code ?? ''}`);
      }
      expect(open).toEqual([]);
      expect(reached.sort()).toEqual([...REACHABLE].sort());
    } finally {
      await setPerson(email, { role: 'member' });
    }
  }, ROUTE_SWEEP_TIMEOUT);
});
