import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { CAPABILITIES, PEOPLE_ROLES, resetRoleCache, roleAllows, roleOf, type Capability } from '../src/capabilities';
import { resetPeerRosterCache } from '../src/peers';

// docs/ENROLLMENT.md step 2: a hypothetical `community` row is refused at every
// internal route, before such a row can exist. Two layers: the table itself,
// and the routes as a client would hit them.

const rosa = { sub: 'caps-rosa', email: 'rosa@example.com', name: 'Rosa' };

async function session(email = rosa.email, name = rosa.name) {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email }),
  }));
  const body = await response.json<{ access_token: string }>();
  const headers = { authorization: `Bearer ${body.access_token}` };
  // The `people` row is written by the first authenticated read, not by the
  // dev session itself; `setRole` needs it to exist.
  await exports.default.fetch(new Request('http://local/api/peers', { headers }));
  return headers;
}

async function setRole(email: string, role: string) {
  await env.USAGE.prepare('UPDATE people SET role = ?2 WHERE email = ?1').bind(email, role).run();
  resetRoleCache();
  resetPeerRosterCache();
}

async function hit(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return exports.default.fetch(new Request(`http://local${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json', origin: 'http://local' },
    body: body === undefined ? null : JSON.stringify(body),
  }));
}

describe('capability table', () => {
  it('lists every role it names, and denies by default', () => {
    for (const capability of Object.keys(CAPABILITIES) as Capability[]) {
      for (const role of CAPABILITIES[capability]) {
        expect(PEOPLE_ROLES).toContain(role);
      }
    }
    // An unlisted pairing is a refusal, not an exception.
    expect(roleAllows('community', 'roster')).toBe(false);
  });

  it('admin holds everything; member everything but Admin; community holds only its own profile', () => {
    for (const capability of Object.keys(CAPABILITIES) as Capability[]) {
      expect(roleAllows('member', capability)).toBe(capability !== 'adminOverview');
      expect(roleAllows('admin', capability)).toBe(true);
      expect(roleAllows('community', capability)).toBe(capability === 'ownProfile');
    }
  });
});

describe('a community session at the routes', () => {
  afterEach(async () => {
    await setRole(rosa.email, 'member');
  });

  // One representative route per capability the table refuses `community`.
  // Adding a capability without a line here is the review flag this test
  // exists to raise.
  const refused: Array<{ capability: Capability; method: string; path: string; body?: unknown }> = [
    { capability: 'roster', method: 'GET', path: '/api/peers' },
    { capability: 'roster', method: 'POST', path: '/api/peers/intent', body: { intent: 'available' } },
    { capability: 'reachColleague', method: 'POST', path: '/api/peers/ring', body: { peer_email: 'ada@example.com' } },
    { capability: 'conversations', method: 'GET', path: '/api/threads' },
    { capability: 'conversations', method: 'POST', path: '/api/threads', body: { kind: 'team' } },
    { capability: 'crmWork', method: 'GET', path: '/api/crm/board' },
    { capability: 'crmWork', method: 'GET', path: '/api/crm/feed' },
    { capability: 'crmWork', method: 'GET', path: '/api/crm/work?assignee_email=rosa%40example.com' },
    { capability: 'crmWork', method: 'GET', path: '/api/crm/subject-state' },
    { capability: 'crmWork', method: 'PUT', path: '/api/crm/subject-state/project/c0ffee00-0000-4000-8000-000000000001', body: { starred: true } },
    { capability: 'crmWork', method: 'POST', path: '/api/crm/favorites', body: {} },
    { capability: 'crmWork', method: 'DELETE', path: '/api/crm/favorites' },
    { capability: 'crmWork', method: 'GET', path: '/api/core/registry' },
    { capability: 'crmWork', method: 'GET', path: '/api/core/search?q=acme' },
    { capability: 'crmWork', method: 'GET', path: '/api/core/records/organizations' },
    { capability: 'crmWork', method: 'POST', path: '/api/core/records/organizations', body: { name: 'x' } },
    { capability: 'crmWork', method: 'DELETE', path: '/api/core/fields/organizations/c0ffee00-0000-4000-8000-000000000001' },
    { capability: 'crmWork', method: 'PATCH', path: '/api/core/fields/projects/c0ffee00-0000-4000-8000-000000000001', body: { name: 'x' } },
    { capability: 'issueImages', method: 'POST', path: '/api/issue-images', body: {} },
    { capability: 'adminOverview', method: 'GET', path: '/api/admin/overview' },
    { capability: 'agents', method: 'POST', path: '/api/agents/cancel', body: {} },
    { capability: 'cmsContent', method: 'GET', path: '/api/cms/registry' },
    { capability: 'cmsContent', method: 'GET', path: '/api/cms/events' },
    { capability: 'cmsContent', method: 'POST', path: '/api/cms/events', body: { title: 'x' } },
    { capability: 'cmsContent', method: 'DELETE', path: '/api/cms/technology_tags/c0ffee00-0000-4000-8000-000000000001' },
  ];

  // One test per route, not one loop: about 25 requests in one test took
  // longer than its 30s budget on a loaded gate (meet#1232).
  it.each(refused)('$method $path is refused with capability_denied, not owner_auth_required', async (route) => {
    const headers = await session();
    await setRole(rosa.email, 'community');
    const response = await hit(route.method, route.path, headers, route.body);
    expect(response.status).toBe(403);
    const body = await response.json<{ code?: string }>();
    expect(body.code).toBe('capability_denied');
  });

  it('keeps its own profile', async () => {
    const headers = await session();
    await setRole(rosa.email, 'community');
    const response = await hit('GET', '/api/profile/avatar', headers);
    // Whatever the avatar route answers for a person with no picture, it is
    // not a capability refusal.
    expect(response.status).not.toBe(403);
  });

  it.each(refused)('$method $path is unchanged for a member', async (route) => {
    const headers = await session();
    // This test checks the capability gate, not the live Core integration.
    // CRM routes fan out over many subjects, so point those reads at a reserved
    // host instead of making a rate-limited production request from the suite.
    const mutableEnv = env as unknown as { CORE_API_ORIGIN: string };
    const coreApiOrigin = mutableEnv.CORE_API_ORIGIN;
    mutableEnv.CORE_API_ORIGIN = 'https://core.test';
    try {
      const response = await hit(route.method, route.path, headers, route.body);
      expect(response.status).not.toBe(403);
    } finally {
      mutableEnv.CORE_API_ORIGIN = coreApiOrigin;
    }
  });

  it('a role change bites on the next request', async () => {
    const headers = await session();
    expect((await hit('GET', '/api/peers', headers)).status).toBe(200);
    await setRole(rosa.email, 'community');
    expect((await hit('GET', '/api/peers', headers)).status).toBe(403);
    await setRole(rosa.email, 'member');
    expect((await hit('GET', '/api/peers', headers)).status).toBe(200);
  });
});

describe('roleOf when the store cannot answer (meet#188)', () => {
  afterEach(() => resetRoleCache());

  it('no row reads as member, for now', async () => {
    expect(await roleOf(env, 'caps-nobody')).toBe('member');
  });

  it('a role string the table does not name reads as member', async () => {
    const headers = await session('caps-odd@example.com', 'Odd');
    await setRole('caps-odd@example.com', 'wizard');
    expect((await hit('GET', '/api/peers', headers)).status).toBe(200);
  });

  it('an unreadable D1 is a 503, and is not cached', async () => {
    const broken = {
      ...env,
      USAGE: { prepare: () => { throw new Error('D1 is down'); } },
    } as unknown as typeof env;
    await expect(roleOf(broken, 'caps-rosa')).rejects.toMatchObject({ status: 503 });
    // The next read asks the real store instead of serving a cached answer.
    expect(await roleOf(env, 'caps-rosa')).toBe('member');
  });
});
