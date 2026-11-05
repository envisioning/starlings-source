/**
 * The work model on a D1 workspace (WORK_STORE=d1, docs/WORKSPACE_STORE.md,
 * meet#776, meet#824). Every other Worker test runs as Envisioning, a Core
 * workspace. This file runs the same Worker as a D1 workspace and tests it
 * through the HTTP routes and MCP, the contract the clients use.
 *
 * The setup: each request goes to `worker.fetch` with an env that sets
 * `WORK_STORE=d1`, the pattern the other files use for their own
 * configuration. The pool, the migrations and the bindings stay the same.
 * A second D1 binding, `USAGE_OTHER` in wrangler.test.jsonc, is a second
 * workspace's database, for the isolation case.
 *
 * Limits of the setup: Durable Objects and the KV namespaces take the pool's
 * env, not the env of the request. Room, thread and quick-note state is
 * therefore shared between the two workspaces here. In production each
 * workspace is its own Worker with its own objects.
 *
 * `test/no-network.ts` fails any case that sends a request out, so every
 * case below also proves that a D1 workspace does not reach Core.
 */
import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext, type D1Migration } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { connectedGithub } from './github-broker-fake';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CrmLeadWinResponse,
  CrmMyWorkResponse,
  CrmContactResponse,
  CrmContactDeleteResponse,
  CrmContactOptionsResponse,
  CrmContactsResponse,
  CrmOrganizationResponse,
  CrmOrganizationsResponse,
  CrmRecentlyClosedWorkResponse,
  CrmSubjectCountsResponse,
  CrmSubjectDetailResponse,
  CrmSubjectMutationResponse,
  CrmSubjectsResponse,
  CrmTeamResponse,
  CrmUnownedWorkResponse,
  CrmInteractionsResponse,
  CrmGithubReposResponse,
  CrmProjectRepoResponse,
  SearchResponse,
} from '@starlings/contracts';
import type { CalendarWorkItemsResponse, CrmBoardResponse, CrmTask } from '@starlings/contracts/crm';
import type { ZodType } from 'zod';
import {
  calendarWorkItemsResponseSchema,
  crmBoardResponseSchema,
  crmContactResponseSchema,
  crmContactsResponseSchema,
  crmContactOptionsResponseSchema,
  crmGithubReposResponseSchema,
  crmInteractionsResponseSchema,
  crmMyWorkResponseSchema,
  crmProjectRepoResponseSchema,
  crmRecentlyClosedWorkResponseSchema,
  crmSubjectCountsResponseSchema,
  crmSubjectDetailResponseSchema,
  crmSubjectsResponseSchema,
  crmOrganizationProjectTasksResponseSchema,
  crmTaskResponseSchema,
  crmTasksResponseSchema,
  crmTeamResponseSchema,
  crmUnownedWorkResponseSchema,
  recentFeedResponseSchema,
} from '@starlings/contracts/crm';
import { crmOrganizationResponseSchema, crmOrganizationsResponseSchema } from '@starlings/contracts';
import { crmDecisionResponseSchema, crmDecisionsResponseSchema, crmGoalResponseSchema, crmGoalsResponseSchema } from '@starlings/contracts/goals-decisions';
import { favoriteMutationResponseSchema, favoritesResponseSchema } from '@starlings/contracts/favorites';
import { inboxResponseSchema } from '@starlings/contracts/inbox';
import { searchResponseSchema } from '@starlings/contracts/search';
import { subjectStateUpdateResponseSchema } from '@starlings/contracts/subject-state';
import type { CrmDecisionResponse, CrmDecisionsResponse, CrmGoalResponse, CrmGoalsResponse } from '@starlings/contracts/goals-decisions';
import type { FavoriteMutationResponse, FavoritesResponse } from '@starlings/contracts/favorites';
import type { InboxResponse } from '@starlings/contracts/inbox';
import worker from '../src/index';
import { purgeAllCoreCache } from '../src/core-cache';
import { postMeetingLog, type MeetingLogPayload } from '../src/crm';
import { d1UpdateOrganization } from '../src/work-d1';
import { signingKey } from '../src/crypto';
import { resetRoleCache } from '../src/capabilities';
import { resetPeerRosterCache } from '../src/peers';
import { clearResponsibleFor } from '../src/responsible';
import { ensureAgentPeople } from '../src/agents';
import { forgetRoster } from '../src/agent-roster';
import { agentSub } from '@starlings/contracts';

type Bindings = Env & { USAGE_OTHER: D1Database; TEST_MIGRATIONS: D1Migration[] };
const bindings = env as Bindings;

/** The D1 workspace under test. */
const d1 = { ...env, WORK_STORE: 'd1' } as Env;
/** A second D1 workspace: the same Worker with its own database. */
const other = { ...env, WORK_STORE: 'd1', USAGE: bindings.USAGE_OTHER } as Env;

const WORK_TABLES = [
  'interaction_contacts', 'contact_emails', 'interaction_subjects', 'interactions', 'favorites', 'project_github_repos', 'decisions', 'goals',
  'tasks', 'milestones', 'project_contacts', 'projects', 'leads', 'contacts', 'organizations',
];

const DAY = 24 * 60 * 60 * 1000;
const EMAIL = 'd1store-ana@example.com';
const COLLEAGUE = 'd1store-bo@example.com';

async function invoke(request: Request, apiEnv: Env = d1): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, apiEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

async function hit(method: string, path: string, headers: Record<string, string>, body?: unknown, apiEnv: Env = d1): Promise<Response> {
  return invoke(new Request(`http://local${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  }), apiEnv);
}

/**
 * The contract each route the suite reads or writes answers in: the zod
 * schema the clients decode it with. `read` and `write` parse every 2xx body
 * with it, so a D1 path that drops a field, renames one or changes its type
 * fails here, not on a client (meet#824). A route with no row fails too: a
 * new read in this file names its schema first.
 */
const WIRE: ReadonlyArray<readonly [method: string, path: RegExp, schema: ZodType]> = [
  ['GET', /^\/api\/crm\/subjects$/u, crmSubjectsResponseSchema],
  ['GET', /^\/api\/crm\/subjects\/(project|lead|partner|organization)\/[^/]+$/u, crmSubjectDetailResponseSchema],
  ['POST', /^\/api\/crm\/subjects$/u, crmSubjectDetailResponseSchema],
  ['PATCH', /^\/api\/crm\/subjects\/(project|lead)\/[^/]+$/u, crmSubjectDetailResponseSchema],
  ['GET', /^\/api\/crm\/subject-counts$/u, crmSubjectCountsResponseSchema],
  ['GET', /^\/api\/crm\/organizations$/u, crmOrganizationsResponseSchema],
  ['POST', /^\/api\/crm\/organizations$/u, crmOrganizationResponseSchema],
  ['GET', /^\/api\/crm\/team$/u, crmTeamResponseSchema],
  ['GET', /^\/api\/crm\/tasks$/u, crmTasksResponseSchema],
  ['GET', /^\/api\/crm\/tasks\/[^/]+$/u, crmTaskResponseSchema],
  ['POST', /^\/api\/crm\/tasks$/u, crmTaskResponseSchema],
  ['PATCH', /^\/api\/crm\/tasks\/[^/]+$/u, crmTaskResponseSchema],
  ['GET', /^\/api\/crm\/(mine|work)$/u, crmMyWorkResponseSchema],
  ['GET', /^\/api\/crm\/unowned$/u, crmUnownedWorkResponseSchema],
  ['GET', /^\/api\/crm\/recently-closed$/u, crmRecentlyClosedWorkResponseSchema],
  ['GET', /^\/api\/crm\/board$/u, crmBoardResponseSchema],
  ['GET', /^\/api\/crm\/feed$/u, recentFeedResponseSchema],
  ['PUT', /^\/api\/crm\/subject-state\/(lead|project|organization|partner|event)\/[^/]+$/u, subjectStateUpdateResponseSchema],
  ['GET', /^\/api\/calendar\/work-items$/u, calendarWorkItemsResponseSchema],
  ['GET', /^\/api\/crm\/goals$/u, crmGoalsResponseSchema],
  ['POST', /^\/api\/crm\/goals$/u, crmGoalResponseSchema],
  ['PATCH', /^\/api\/crm\/goals\/[^/]+$/u, crmGoalResponseSchema],
  ['GET', /^\/api\/crm\/decisions$/u, crmDecisionsResponseSchema],
  ['POST', /^\/api\/crm\/decisions$/u, crmDecisionResponseSchema],
  ['GET', /^\/api\/crm\/favorites$/u, favoritesResponseSchema],
  ['POST', /^\/api\/crm\/favorites$/u, favoriteMutationResponseSchema],
  ['GET', /^\/api\/crm\/starred$/u, searchResponseSchema],
  ['GET', /^\/api\/search$/u, searchResponseSchema],
  ['GET', /^\/api\/crm\/inbox$/u, inboxResponseSchema],
  ['GET', /^\/api\/crm\/interactions$/u, crmInteractionsResponseSchema],
  ['GET', /^\/api\/crm\/(project-repos|github-repos)$/u, crmGithubReposResponseSchema],
  ['POST', /^\/api\/crm\/project-repos$/u, crmProjectRepoResponseSchema],
  ['GET', /^\/api\/crm\/contacts$/u, crmContactsResponseSchema],
  ['GET', /^\/api\/crm\/contacts\/[^/]+$/u, crmContactResponseSchema],
  ['POST', /^\/api\/crm\/contacts$/u, crmContactResponseSchema],
  ['PATCH', /^\/api\/crm\/contacts\/[^/]+$/u, crmContactResponseSchema],
  ['GET', /^\/api\/crm\/contact-options$/u, crmContactOptionsResponseSchema],
  ['GET', /^\/api\/crm\/subjects\/organization\/[^/]+\/project-tasks$/u, crmOrganizationProjectTasksResponseSchema],
];

/** The body, checked against the route's contract. */
function onTheWire<T>(method: string, path: string, body: unknown): T {
  const pathname = new URL(path, 'http://local').pathname;
  const row = WIRE.find(([m, re]) => m === method && re.test(pathname));
  expect(row, `${method} ${pathname} has no schema in WIRE`).toBeDefined();
  const parsed = row![2].safeParse(body);
  expect(parsed.success, `${method} ${pathname} left its contract: ${parsed.error?.message ?? ''}`).toBe(true);
  return body as T;
}

/** Read a route that must answer 2xx, and its body. */
async function read<T>(path: string, headers: Record<string, string>, apiEnv: Env = d1): Promise<T> {
  const response = await hit('GET', path, headers, undefined, apiEnv);
  expect(response.status, `GET ${path}: ${await response.clone().text()}`).toBe(200);
  return onTheWire<T>('GET', path, await response.json());
}

/** Write through a route that must answer 2xx, and its body. */
async function write<T>(method: string, path: string, headers: Record<string, string>, body: unknown, apiEnv: Env = d1): Promise<T> {
  const response = await hit(method, path, headers, body, apiEnv);
  expect(response.status, `${method} ${path}: ${await response.clone().text()}`).toBeLessThan(300);
  return onTheWire<T>(method, path, await response.json());
}

/** Sign in as a member on one workspace: a dev session, as the other files do. */
async function member(email: string, apiEnv: Env = d1): Promise<{ headers: Record<string, string>; sub: string }> {
  const session = await invoke(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, name: email.split('@')[0] }),
  }), apiEnv);
  expect(session.status).toBe(200);
  const accessToken = (await session.json<{ access_token: string }>()).access_token;
  return { headers: { authorization: `Bearer ${accessToken}` }, sub: `dev:${email}` };
}

async function personId(email: string, apiEnv: Env = d1): Promise<string | null> {
  const row = await apiEnv.USAGE.prepare('SELECT person_id FROM people WHERE email = ?1').bind(email).first<{ person_id: string | null }>();
  return row?.person_id ?? null;
}

async function wipe(db: D1Database): Promise<void> {
  await db.batch(WORK_TABLES.map((table) => db.prepare(`DELETE FROM ${table}`)));
  await db.prepare("DELETE FROM people WHERE email LIKE 'd1store-%'").run();
  // An agent a test put on the roster (meet#1106) stays in `agents` otherwise,
  // and a later roster read on a stale cache fetches its manifest.
  await db.prepare("DELETE FROM agents WHERE email LIKE 'd1store-%'").run();
}

/** An organization, a lead and a project on it, made through the routes. */
async function seedSubjects(headers: Record<string, string>, apiEnv: Env = d1) {
  const { organization } = await write<CrmOrganizationResponse>('POST', '/api/crm/organizations', headers, { name: 'Northwind Labs' }, apiEnv);
  const lead = (await write<CrmSubjectMutationResponse>('POST', '/api/crm/subjects', headers, {
    kind: 'lead', title: 'Northwind pilot', organization_id: organization.id, start_date: '2026-10-01', notes: 'First call went well.',
  }, apiEnv)).subject;
  const project = (await write<CrmSubjectMutationResponse>('POST', '/api/crm/subjects', headers, {
    kind: 'project', title: 'Northwind rollout', organization_id: organization.id, description: 'Phase one.',
  }, apiEnv)).subject;
  return { organization, lead, project };
}

/** Mark an organization a partner. No route does this on a D1 workspace yet. */
async function makePartner(id: string, apiEnv: Env = d1): Promise<void> {
  await apiEnv.USAGE.prepare('UPDATE organizations SET is_partner = 1, industry = ?2 WHERE id = ?1').bind(id, 'Logistics').run();
}

beforeAll(async () => {
  await applyD1Migrations(bindings.USAGE_OTHER, bindings.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await purgeAllCoreCache();
  resetRoleCache();
  resetPeerRosterCache();
  await wipe(d1.USAGE);
  await wipe(other.USAGE);
  // Each env caches its agent list for ten seconds; a list read during an
  // earlier test would still name an agent the wipe removed.
  forgetRoster(d1);
  forgetRoster(other);
  // These tests exercise leads and partners on D1: a D1 workspace starts with
  // the base only, so they turn Sales and Partners on (docs/WORK_MODEL.md).
  for (const db of [d1.USAGE, other.USAGE]) {
    await db.prepare(
      "INSERT OR REPLACE INTO workspace_settings (key, value, updated_by, updated_at) VALUES ('work_modules', ?1, 'test', 0)",
    ).bind(JSON.stringify({ on: ['sales', 'partners'] })).run();
  }
});

afterEach(async () => {
  for (const db of [d1.USAGE, other.USAGE]) await db.prepare("DELETE FROM workspace_settings WHERE key = 'work_modules'").run();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await wipe(d1.USAGE);
  await purgeAllCoreCache();
});

describe('fail closed', () => {
  it('sends no request to a Core or CMS host, even with Core configured by mistake', async () => {
    // A misconfiguration the deploy check refuses: a D1 workspace with Core's
    // origin and secret set. The Worker must still not call out.
    const misconfigured = {
      ...d1,
      CORE_API_ORIGIN: 'https://core.test',
      CORE_WEB_ORIGIN: 'https://core.test',
      INTERNAL_REQUEST_SECRET: 'meet-core-shared-secret-at-least-32-chars',
      CRM_SYNC_MODE: 'on',
    } as Env;
    const outbound: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      outbound.push(input instanceof Request ? input.url : String(input));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const { headers } = await member(EMAIL, misconfigured);
    const { project } = await seedSubjects(headers, misconfigured);

    const reads = [
      '/api/crm/team', '/api/crm/subjects?kind=project', '/api/crm/subjects?kind=lead', '/api/crm/subjects?kind=partner',
      '/api/crm/subjects?kind=event', '/api/crm/subject-counts?kind=project', '/api/crm/organizations?q=north',
      `/api/crm/subjects/project/${project.id}`, `/api/crm/tasks?project_id=${project.id}`, '/api/crm/mine',
      '/api/crm/board', '/api/crm/feed', '/api/crm/unowned', '/api/crm/recently-closed', '/api/crm/inbox',
      '/api/crm/favorites', '/api/crm/starred', '/api/search?q=north', '/api/crm/contacts?q=north', `/api/crm/goals?project_id=${project.id}`,
      `/api/crm/decisions?subject_kind=project&subject_id=${project.id}`, `/api/crm/interactions?project_id=${project.id}`,
      `/api/crm/project-repos?project_id=${project.id}`, '/api/crm/github-repos',
      '/api/calendar/work-items?start=2026-10-01&end=2026-10-31',
    ];
    for (const path of reads) {
      const response = await hit('GET', path, headers, undefined, misconfigured);
      expect(response.status, `GET ${path}`).toBe(200);
    }

    // Envisioning's profile: Core and the CMS only. Each one says so.
    const coreOnly = [
      '/api/crm/sales-inbox', '/api/crm/commercial-summary',
      '/api/cms/registry', '/api/core/registry', '/api/core/search?q=north', `/api/crm/issues?project_id=${project.id}`,
    ];
    for (const path of coreOnly) {
      const response = await hit('GET', path, headers, undefined, misconfigured);
      expect(response.status, `GET ${path}`).toBe(503);
      expect((await response.json<{ code: string }>()).code, path).toBe('not_configured');
    }
    expect((await hit('POST', '/api/core/token', headers, { device_name: 'Test' }, misconfigured)).status).toBe(503);

    // The booking page answers from D1 (CORE_FOLD_PLAN Phase 3d), never Core.
    // A room nobody here owns is not found. A mapped member who has never
    // signed in here is not taking bookings. The member's own room answers, and
    // with no hours set there is nothing to offer and no reason to ask Google.
    expect((await hit('GET', '/api/schedule/nobody-here/info', {}, undefined, misconfigured)).status).toBe(404);
    expect((await hit('GET', '/api/schedule/rosa/info', {}, undefined, misconfigured)).status).toBe(503);
    const withRoom = { ...misconfigured, OWNER_ROOM_MAP: JSON.stringify({ [EMAIL]: 'd1store-ana' }) } as Env;
    expect((await hit('GET', '/api/schedule/d1store-ana/info', {}, undefined, withRoom)).status).toBe(200);
    expect((await hit('GET', '/api/schedule/d1store-ana/events', {}, undefined, withRoom)).status).toBe(200);
    const day = await hit('GET', '/api/schedule/d1store-ana/availability?date=2026-10-20&timezone=UTC', {}, undefined, withRoom);
    expect(day.status).toBe(200);
    expect((await day.json<{ slots: unknown[] }>()).slots).toEqual([]);
    expect((await hit('GET', '/api/schedule/d1store-ana/availability-blocks', {}, undefined, withRoom)).status).toBe(404);
    // The room comes from the member's `people` row, not the map (meet#1076):
    // a member with a room and no map entry has a page; revoked, they do not.
    await env.USAGE.prepare("UPDATE people SET room_slug = 'd1store-own' WHERE lower(email) = lower(?1)").bind(EMAIL).run();
    expect((await hit('GET', '/api/schedule/d1store-own/info', {}, undefined, misconfigured)).status).toBe(200);
    await env.USAGE.prepare('UPDATE people SET revoked_at = ?2 WHERE lower(email) = lower(?1)').bind(EMAIL, Date.now()).run();
    expect((await hit('GET', '/api/schedule/d1store-own/info', {}, undefined, misconfigured)).status).toBe(404);
    await env.USAGE.prepare('UPDATE people SET room_slug = NULL, revoked_at = NULL WHERE lower(email) = lower(?1)').bind(EMAIL).run();
    expect((await hit('GET', '/api/public/events', {}, undefined, misconfigured)).status).toBe(404);
    expect((await hit('GET', '/api/bookings/unknown-token-0001/room', {}, undefined, misconfigured)).status).toBe(404);
    expect((await hit('GET', '/api/rooms/rosa/bookings/unknown-token-0001', {}, undefined, misconfigured)).status).toBe(404);

    expect(outbound).toEqual([]);
  });

  it('answers a booking Meet minted itself from its own store', async () => {
    const token = 'd1store-minted-booking-0001';
    await env.CALENDAR_TOKENS.put(`calendar:booking:${token}`, JSON.stringify({
      v: 1, slug: 'rosa', status: 'scheduled', title: 'Intro call', starts_at: '2026-10-20T10:00:00.000Z', ends_at: '2026-10-20T10:30:00.000Z',
      guest_name: 'Rui', guest_email: 'rui@example.net',
    }));
    try {
      const room = await hit('GET', `/api/bookings/${token}/room`, {});
      expect(room.status).toBe(200);
      expect(await room.json()).toEqual({ slug: 'rosa' });
      const card = await hit('GET', `/api/rooms/rosa/bookings/${token}`, {});
      expect(card.status).toBe(200);
      expect(await card.json()).toMatchObject({ title: 'Intro call', status: 'scheduled', guest_name: 'Rui', reschedule_url: null });
    } finally {
      await env.CALENDAR_TOKENS.delete(`calendar:booking:${token}`);
    }
  });
});

describe('people', () => {
  it('mints a person id at the first sign-in, keeps it at the next, and lists the person in the team', async () => {
    const { headers } = await member(EMAIL);
    const first = await personId(EMAIL);
    expect(first).toMatch(/^[0-9a-f-]{36}$/u);
    await member(EMAIL);
    expect(await personId(EMAIL)).toBe(first);
    await member(COLLEAGUE);

    const { members } = await read<CrmTeamResponse>('/api/crm/team', headers);
    expect(members).toContainEqual({ id: first, name: 'd1store-ana', email: EMAIL, kind: 'person' });
    expect(members.map((row) => row.email)).toContain(COLLEAGUE);
  });

  it('mints no person id on a Core workspace', async () => {
    await member('d1store-core@example.com', env as Env);
    expect(await personId('d1store-core@example.com')).toBeNull();
  });
});

describe('subjects', () => {
  it('searches and creates organizations; the same name twice is one organization', async () => {
    const { headers } = await member(EMAIL);
    const made = await hit('POST', '/api/crm/organizations', headers, { name: 'Contoso Freight' });
    expect(made.status).toBe(201);
    const { organization } = await made.json<CrmOrganizationResponse>();
    const again = await write<CrmOrganizationResponse>('POST', '/api/crm/organizations', headers, { name: 'contoso freight' });
    expect(again.organization).toEqual(organization);

    expect((await read<CrmOrganizationsResponse>('/api/crm/organizations?q=freight', headers)).organizations).toEqual([organization]);
    expect((await read<CrmOrganizationsResponse>('/api/crm/organizations?q=nothing-like-it', headers)).organizations).toEqual([]);
    // A LIKE wildcard in the query is a plain character.
    expect((await read<CrmOrganizationsResponse>('/api/crm/organizations?q=%25', headers)).organizations).toEqual([]);
  });

  it('creates, reads and updates a lead and a project in the wire shapes', async () => {
    const { headers } = await member(EMAIL);
    const { organization, lead, project } = await seedSubjects(headers);

    expect(lead).toMatchObject({
      kind: 'lead', title: 'Northwind pilot', organization_id: organization.id, organization_name: 'Northwind Labs',
      subtitle: 'Northwind Labs', status: 'Conversations', start_date: '2026-10-01', notes: 'First call went well.', contact_id: null,
    });
    expect(project).toMatchObject({
      kind: 'project', title: 'Northwind rollout', organization_id: organization.id, status: 'Active', description: 'Phase one.',
      internal: false, has_repo: false, agent_email: null, contact_ids: [], lead_id: null,
    });

    const detail = await read<CrmSubjectDetailResponse>(`/api/crm/subjects/project/${project.id}`, headers);
    expect(detail.subject).toMatchObject({ id: project.id, kind: 'project', title: 'Northwind rollout', status: 'Active' });

    const renamed = await write<CrmSubjectMutationResponse>('PATCH', `/api/crm/subjects/project/${project.id}`, headers, {
      title: 'Northwind rollout, phase one', status: 'Paused', end_date: '2026-12-31',
    });
    expect(renamed.subject).toMatchObject({ title: 'Northwind rollout, phase one', status: 'Paused', end_date: '2026-12-31', description: 'Phase one.' });

    const moved = await write<CrmSubjectMutationResponse>('PATCH', `/api/crm/subjects/lead/${lead.id}`, headers, { status: 'Proposal Out', notes: null });
    expect(moved.subject).toMatchObject({ status: 'Proposal Out', notes: null, title: 'Northwind pilot' });

    expect((await hit('GET', `/api/crm/subjects/lead/${crypto.randomUUID()}`, headers)).status).toBe(404);
    expect((await hit('PATCH', `/api/crm/subjects/project/${crypto.randomUUID()}`, headers, { title: 'x' })).status).toBe(404);
    // A subject on an organization that does not exist is refused.
    expect((await hit('POST', '/api/crm/subjects', headers, { kind: 'project', title: 'Orphan', organization_id: crypto.randomUUID() })).status).toBe(400);
    // A project needs no organization at all (meet#1046); a lead still does.
    const alone = await write<CrmSubjectMutationResponse>('POST', '/api/crm/subjects', headers, { kind: 'project', title: 'Alpha' });
    expect(alone.subject).toMatchObject({ title: 'Alpha', organization_id: null });
    expect((await hit('POST', '/api/crm/subjects', headers, { kind: 'lead', title: 'No org', start_date: '2026-10-10' })).status).toBe(400);
  });

  it('links a project to its lead, and refuses a lead or contact that is not on the workspace', async () => {
    const { headers } = await member(EMAIL);
    const { organization, lead, project } = await seedSubjects(headers);
    const nowhere = crypto.randomUUID();

    // Each one names a row this workspace does not hold: a 400, never the foreign key's 500.
    const refused: Array<[string, string, Record<string, unknown>]> = [
      ['POST', '/api/crm/subjects', { kind: 'project', title: 'Stray', organization_id: organization.id, lead_id: nowhere }],
      ['POST', '/api/crm/subjects', { kind: 'lead', title: 'Stray', organization_id: organization.id, contact_id: nowhere, start_date: '2026-10-01' }],
      ['PATCH', `/api/crm/subjects/project/${project.id}`, { lead_id: nowhere }],
      ['PATCH', `/api/crm/subjects/lead/${lead.id}`, { contact_id: nowhere }],
    ];
    for (const [method, path, body] of refused) {
      const response = await hit(method, path, headers, body);
      expect(response.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(400);
      expect((await response.json<{ code: string }>()).code).toBe('invalid_request');
    }
    const projects = await read<CrmSubjectsResponse>('/api/crm/subjects?kind=project&status=all', headers);
    expect(projects.subjects.map((row) => row.id)).toEqual([project.id]);
    expect((await read<CrmSubjectsResponse>('/api/crm/subjects?kind=lead&status=all', headers)).subjects.map((row) => row.id)).toEqual([lead.id]);

    // A real lead links both ways (ADR 0008).
    const linked = await write<CrmSubjectMutationResponse>('PATCH', `/api/crm/subjects/project/${project.id}`, headers, { lead_id: lead.id });
    expect(linked.subject).toMatchObject({ lead_id: lead.id, related: { leads: [{ id: lead.id, title: 'Northwind pilot', status: 'Conversations' }] } });
    const leadDetail = await read<CrmSubjectDetailResponse>(`/api/crm/subjects/lead/${lead.id}`, headers);
    expect(leadDetail.subject.related?.projects).toEqual([{ id: project.id, title: 'Northwind rollout', status: 'Active' }]);
    const unlinked = await write<CrmSubjectMutationResponse>('PATCH', `/api/crm/subjects/project/${project.id}`, headers, { lead_id: null });
    expect(unlinked.subject).toMatchObject({ lead_id: null, related: { leads: [] } });
  });

  it('wins a lead: a project from it, its open tasks moved, the lead closed (ADR 0008)', async () => {
    const { headers } = await member(EMAIL);
    const { organization, lead } = await seedSubjects(headers);
    const open = (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, { title: 'Send the contract', lead_id: lead.id })).task;
    const done = (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, { title: 'First call', lead_id: lead.id, status: 'completed' })).task;
    const stranger = crypto.randomUUID();

    const response = await hit('POST', `/api/crm/subjects/lead/${lead.id}/win`, headers, { task_ids: [open.id, done.id, stranger] });
    expect(response.status).toBe(201);
    const won = await response.json<CrmLeadWinResponse>();
    expect(won.project).toMatchObject({
      kind: 'project', title: 'Northwind pilot', status: 'Active', organization_id: organization.id, lead_id: lead.id,
      related: { leads: [{ id: lead.id, title: 'Northwind pilot', status: 'Closed Won' }] },
    });
    expect(won).toMatchObject({ moved_task_ids: [open.id], unmoved_task_ids: [done.id, stranger], lead_closed: true });

    expect((await read<{ task: CrmTask }>(`/api/crm/tasks/${open.id}`, headers)).task).toMatchObject({ project_id: won.project.id, lead_id: null });
    expect((await read<{ task: CrmTask }>(`/api/crm/tasks/${done.id}`, headers)).task).toMatchObject({ project_id: null, lead_id: lead.id });
    // A won lead is closed: off the open list, counted under its status, and not won twice.
    expect((await read<CrmSubjectsResponse>('/api/crm/subjects?kind=lead', headers)).subjects).toEqual([]);
    expect((await read<CrmSubjectCountsResponse>('/api/crm/subject-counts?kind=lead', headers)).counts).toEqual({ 'Closed Won': 1, all: 1 });
    expect((await hit('POST', `/api/crm/subjects/lead/${lead.id}/win`, headers, {})).status).toBe(409);
  });

  it('pages a long subject list and says there is more', async () => {
    const { headers } = await member(EMAIL);
    const now = Date.now();
    // 51 projects, one over the page, written straight to D1: 51 creates through the route only slow the file.
    await d1.USAGE.batch(Array.from({ length: 51 }, (_, index) => d1.USAGE.prepare(
      "INSERT INTO projects (id, title, status, created_at, updated_at) VALUES (?1, ?2, 'Active', ?3, ?3)",
    ).bind(crypto.randomUUID(), `Bulk ${String(index).padStart(2, '0')}`, now - index)));

    const page = await read<CrmSubjectsResponse>('/api/crm/subjects?kind=project', headers);
    expect(page.subjects).toHaveLength(50);
    expect(page.has_more).toBe(true);
    // Newest change first: the oldest one is the one left over.
    expect(page.subjects.map((row) => row.title)).not.toContain('Bulk 50');
    expect((await read<CrmSubjectsResponse>('/api/crm/subjects?kind=project&q=Bulk%2050', headers)).subjects.map((row) => row.title)).toEqual(['Bulk 50']);
    expect((await read<CrmSubjectCountsResponse>('/api/crm/subject-counts?kind=project', headers)).counts).toEqual({ Active: 51, all: 51, open: 51 });
  });

  it('chooses who is responsible, refuses anyone not on the workspace, and clears it on departure (core#155)', async () => {
    const { headers } = await member(EMAIL);
    const colleague = 'd1store-bo@example.com';
    await member(colleague);
    const { lead, project } = await seedSubjects(headers);
    expect(project).toMatchObject({ responsible_email: null, responsible_set_by: null, responsible_set_at: null });

    const chosen = await write<CrmSubjectMutationResponse>('PATCH', `/api/crm/subjects/project/${project.id}`, headers, { responsible_email: 'D1store-Bo@example.com' });
    expect(chosen.subject).toMatchObject({ responsible_email: colleague, responsible_set_by: EMAIL, title: 'Northwind rollout' });
    expect(typeof chosen.subject.responsible_set_at).toBe('string');

    // Nobody by that address here: refused, nothing written.
    expect((await hit('PATCH', `/api/crm/subjects/lead/${lead.id}`, headers, { responsible_email: 'd1store-nobody@example.com' })).status).toBe(400);

    // Null clears the choice, and says who cleared it.
    await write('PATCH', `/api/crm/subjects/lead/${lead.id}`, headers, { responsible_email: colleague });
    const cleared = await write<CrmSubjectMutationResponse>('PATCH', `/api/crm/subjects/lead/${lead.id}`, headers, { responsible_email: null });
    expect(cleared.subject).toMatchObject({ responsible_email: null, responsible_set_by: EMAIL });

    // A departure clears the person's choices (docs/OWNERSHIP.md decision 9).
    await purgeAllCoreCache();
    expect(await clearResponsibleFor(d1, colleague, EMAIL)).toBe(1);
    const after = await read<CrmSubjectDetailResponse>(`/api/crm/subjects/project/${project.id}`, headers);
    expect(after.subject).toMatchObject({ responsible_email: null, responsible_set_by: EMAIL });
  });

  it('finds no lead in search or Inbox once Sales is off, and keeps it (meet#976)', async () => {
    const { headers } = await member(EMAIL);
    const { lead, project } = await seedSubjects(headers);
    const found = async () => (await read<{ rows: Array<{ id: string }> }>('/api/search?q=northwind', headers)).rows.map((row) => row.id);
    expect(await found()).toEqual(expect.arrayContaining([lead.id, project.id]));

    await d1.USAGE.prepare("UPDATE workspace_settings SET value = ?1 WHERE key = 'work_modules'").bind(JSON.stringify({ on: ['partners'] })).run();
    await purgeAllCoreCache();
    const after = await found();
    expect(after).toContain(project.id);
    expect(after).not.toContain(lead.id);

    // Back on, the record is there again.
    await d1.USAGE.prepare("UPDATE workspace_settings SET value = ?1 WHERE key = 'work_modules'").bind(JSON.stringify({ on: ['sales', 'partners'] })).run();
    await purgeAllCoreCache();
    expect(await found()).toContain(lead.id);
  });

  it('lists subjects by the open and status filters and counts them', async () => {
    const { headers } = await member(EMAIL);
    const { organization, lead, project } = await seedSubjects(headers);
    const archived = (await write<CrmSubjectMutationResponse>('POST', '/api/crm/subjects', headers, {
      kind: 'project', title: 'Old migration', organization_id: organization.id, status: 'Archived',
    })).subject;

    const open = await read<CrmSubjectsResponse>('/api/crm/subjects?kind=project', headers);
    expect(open.subjects.map((row) => row.id)).toEqual([project.id]);
    expect(open.has_more).toBe(false);
    expect((await read<CrmSubjectsResponse>('/api/crm/subjects?kind=project&status=Archived', headers)).subjects.map((row) => row.id)).toEqual([archived.id]);
    expect((await read<CrmSubjectsResponse>('/api/crm/subjects?kind=project&status=all', headers)).subjects.map((row) => row.id).sort())
      .toEqual([project.id, archived.id].sort());
    expect((await read<CrmSubjectsResponse>('/api/crm/subjects?kind=project&q=migration&status=all', headers)).subjects.map((row) => row.id)).toEqual([archived.id]);
    expect((await read<CrmSubjectsResponse>('/api/crm/subjects?kind=lead', headers)).subjects.map((row) => row.id)).toEqual([lead.id]);
    expect((await read<CrmSubjectsResponse>('/api/crm/subjects?kind=event', headers)).subjects).toEqual([]);

    const projects = await read<CrmSubjectCountsResponse>('/api/crm/subject-counts?kind=project', headers);
    expect(projects.counts).toEqual({ Active: 1, Archived: 1, all: 2, open: 1 });
    expect(projects.client).toEqual({ Active: 1, Archived: 1, all: 2, open: 1 });
    expect(projects.internal).toEqual({});
    expect(projects).not.toHaveProperty('envisioning');
    const leads = await read<CrmSubjectCountsResponse>('/api/crm/subject-counts?kind=lead', headers);
    expect(leads.counts).toEqual({ Conversations: 1, all: 1, open: 1 });
    expect((await read<CrmSubjectCountsResponse>('/api/crm/subject-counts?kind=project&q=migration', headers)).counts)
      .toEqual({ Archived: 1, all: 1 });
  });

  it('shows a partner with its related projects, leads and own tasks', async () => {
    const { headers } = await member(EMAIL);
    const { organization, lead, project } = await seedSubjects(headers);
    await makePartner(organization.id);
    await write('POST', '/api/crm/tasks', headers, { title: 'Send the partner deck', organization_id: organization.id });

    const partners = await read<CrmSubjectsResponse>('/api/crm/subjects?kind=partner', headers);
    expect(partners.subjects).toHaveLength(1);
    expect(partners.subjects[0]).toMatchObject({ id: organization.id, kind: 'organization', title: 'Northwind Labs', subtitle: 'Logistics', open_tasks: 1, overdue_tasks: 0 });

    const detail = await read<CrmSubjectDetailResponse>(`/api/crm/subjects/partner/${organization.id}`, headers);
    expect(detail.subject).toMatchObject({
      kind: 'organization', status: 'Active', industry: 'Logistics', related_projects: 1, related_leads: 1,
      related: {
        projects: [{ id: project.id, title: 'Northwind rollout', status: 'Active' }],
        leads: [{ id: lead.id, title: 'Northwind pilot', status: 'Conversations' }],
        contacts: [],
      },
    });
    // Every organization is a subject (ADR 0006), a partner or not; the old
    // `partner` door still reads as the organization.
    const plain = (await write<CrmOrganizationResponse>('POST', '/api/crm/organizations', headers, { name: 'Plain Org' })).organization;
    expect((await hit('GET', `/api/crm/subjects/organization/${plain.id}`, headers)).status).toBe(200);
    expect((await hit('GET', `/api/crm/subjects/partner/${plain.id}`, headers)).status).toBe(200);
  });
});

describe('tasks', () => {
  it('creates a task on each place, reads it back and refuses a place D1 does not hold', async () => {
    const { headers } = await member(EMAIL);
    const { organization, lead, project } = await seedSubjects(headers);
    await makePartner(organization.id);
    const meetingId = crypto.randomUUID();

    const places = [
      { project_id: project.id }, { lead_id: lead.id }, { organization_id: organization.id }, { meeting_id: meetingId },
    ];
    const made: CrmTask[] = [];
    for (const place of places) {
      const response = await hit('POST', '/api/crm/tasks', headers, { title: `Task on ${Object.keys(place)[0]}`, ...place });
      expect(response.status, JSON.stringify(place)).toBe(201);
      made.push((await response.json<{ task: CrmTask }>()).task);
    }
    expect(made[0]).toMatchObject({ project_id: project.id, lead_id: null, organization_id: null, status: 'pending', responsible_party: 'team', event_id: null, signals_account_id: null });
    expect(made[3]).toMatchObject({ meeting_id: meetingId, project_id: null });

    expect((await read<{ tasks: CrmTask[] }>(`/api/crm/tasks?project_id=${project.id}`, headers)).tasks.map((task) => task.id)).toEqual([made[0]!.id]);
    expect((await read<{ tasks: CrmTask[] }>(`/api/crm/tasks?lead_id=${lead.id}`, headers)).tasks.map((task) => task.id)).toEqual([made[1]!.id]);
    expect((await read<{ tasks: CrmTask[] }>(`/api/crm/tasks?organization_id=${organization.id}`, headers)).tasks.map((task) => task.id)).toEqual([made[2]!.id]);
    expect((await read<{ tasks: CrmTask[] }>(`/api/crm/tasks?meeting_id=${meetingId}`, headers)).tasks.map((task) => task.id)).toEqual([made[3]!.id]);
    expect((await read<{ task: CrmTask }>(`/api/crm/tasks/${made[0]!.id}`, headers)).task).toEqual(made[0]);
    expect((await hit('GET', `/api/crm/tasks/${crypto.randomUUID()}`, headers)).status).toBe(404);

    // Events and Signals accounts are Envisioning's; a subject that is not here is refused.
    expect((await hit('POST', '/api/crm/tasks', headers, { title: 'x', event_id: crypto.randomUUID() })).status).toBe(400);
    expect((await hit('POST', '/api/crm/tasks', headers, { title: 'x', project_id: crypto.randomUUID() })).status).toBe(400);
    expect((await hit('POST', '/api/crm/tasks', headers, { title: 'x' })).status).toBe(400);
  });

  it('updates a task, moves it between places and keeps the counts on the subjects', async () => {
    const { headers } = await member(EMAIL);
    const ana = await personId(EMAIL);
    const { lead, project } = await seedSubjects(headers);
    const yesterday = new Date(Date.now() - DAY).toISOString();
    const task = (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, {
      title: 'Draft the plan', project_id: project.id, due_date: yesterday, assigned_to: ana,
    })).task;
    expect(task).toMatchObject({ assignee_id: ana, assignee_email: EMAIL, assignee_name: 'd1store-ana', due_date: yesterday });

    const projects = await read<CrmSubjectsResponse>('/api/crm/subjects?kind=project', headers);
    expect(projects.subjects[0]).toMatchObject({ open_tasks: 1, overdue_tasks: 1 });

    const edited = await write<{ task: CrmTask }>('PATCH', `/api/crm/tasks/${task.id}`, headers, {
      title: 'Draft the plan, v2', notes: 'Two pages.', status: 'in_progress', due_date: null,
    });
    expect(edited.task).toMatchObject({ title: 'Draft the plan, v2', notes: 'Two pages.', status: 'in_progress', due_date: null, project_id: project.id });

    const moved = await write<{ task: CrmTask }>('PATCH', `/api/crm/tasks/${task.id}`, headers, {
      lead_id: lead.id, moved_from: { project_id: project.id },
    });
    expect(moved.task).toMatchObject({ lead_id: lead.id, project_id: null, organization_id: null, meeting_id: null });
    expect((await read<{ tasks: CrmTask[] }>(`/api/crm/tasks?project_id=${project.id}`, headers)).tasks).toEqual([]);
    expect((await read<{ tasks: CrmTask[] }>(`/api/crm/tasks?lead_id=${lead.id}`, headers)).tasks.map((row) => row.id)).toEqual([task.id]);
    expect((await read<CrmSubjectsResponse>('/api/crm/subjects?kind=project', headers)).subjects[0]).toMatchObject({ open_tasks: 0, overdue_tasks: 0 });
    expect((await read<CrmSubjectsResponse>('/api/crm/subjects?kind=lead', headers)).subjects[0]).toMatchObject({ open_tasks: 1, overdue_tasks: 0 });

    // An assignee who is not on this workspace is refused, and so is a task that is not there.
    expect((await hit('PATCH', `/api/crm/tasks/${task.id}`, headers, { assigned_to: crypto.randomUUID() })).status).toBe(400);
    expect((await hit('PATCH', `/api/crm/tasks/${crypto.randomUUID()}`, headers, { title: 'x' })).status).toBe(404);
  });

  it('deletes a task after the subject check, and the trail records it (meet#1222)', async () => {
    const { headers } = await member(EMAIL);
    const { project } = await seedSubjects(headers);
    const task = (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, { title: 'Throw away', project_id: project.id })).task;
    const deleted = await hit('DELETE', `/api/crm/tasks/${task.id}`, headers);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ id: task.id, deleted: true });
    expect((await hit('GET', `/api/crm/tasks/${task.id}`, headers)).status).toBe(404);
    expect((await read<{ tasks: CrmTask[] }>(`/api/crm/tasks?project_id=${project.id}`, headers)).tasks).toEqual([]);
    expect(await d1.USAGE.prepare(`SELECT action, actor, label FROM work_activity WHERE row_id = ?1 AND action = 'delete'`).bind(task.id).first())
      .toEqual({ action: 'delete', actor: EMAIL, label: 'Throw away' });
    expect((await hit('DELETE', `/api/crm/tasks/${task.id}`, headers)).status).toBe(404);
  });

  it('groups an organization\'s open tasks by project, leaving out projects with none (meet#1222)', async () => {
    const { headers } = await member(EMAIL);
    const { organization, project } = await seedSubjects(headers);
    const empty = (await write<{ subject: { id: string } }>('POST', '/api/crm/subjects', headers, { kind: 'project', title: 'Quiet project', organization_id: organization.id })).subject;
    const task = (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, { title: 'Draft the brief', project_id: project.id })).task;
    const answer = await read<{ projects: Array<{ id: string; tasks: CrmTask[] }>; partial: boolean }>(`/api/crm/subjects/organization/${organization.id}/project-tasks`, headers);
    expect(answer.partial).toBe(false);
    expect(answer.projects.map((group) => [group.id, group.tasks.map((row) => row.id)])).toEqual([[project.id, [task.id]]]);
    expect(answer.projects.some((group) => group.id === empty.id)).toBe(false);
  });

  it('finds every task, milestone and call in search, not only the member\'s own (meet#1222)', async () => {
    const { headers } = await member(EMAIL);
    await member(COLLEAGUE);
    const colleague = await personId(COLLEAGUE);
    const { project } = await seedSubjects(headers);
    await write('POST', '/api/crm/tasks', headers, { title: 'Quokka survey', project_id: project.id, assigned_to: colleague });
    const now = Date.now();
    await d1.USAGE.batch([
      d1.USAGE.prepare(`INSERT INTO milestones (id, project_id, title, status, notes, created_at, updated_at) VALUES ('m-quokka', ?1, 'Quokka launch', 'planned', NULL, ?2, ?2)`).bind(project.id, now),
      d1.USAGE.prepare(`INSERT INTO interactions (id, type, title, source, external_id, occurred_at, summary_markdown, created_at, updated_at)
        VALUES ('i-quokka', 'call', 'Weekly sync', 'manual', 'x-1', ?1, 'We talked about the quokka study.', ?1, ?1)`).bind(now),
      d1.USAGE.prepare(`INSERT INTO interaction_subjects (interaction_id, subject_kind, subject_id) VALUES ('i-quokka', 'project', ?1)`).bind(project.id),
    ]);
    const { rows } = await read<{ rows: Array<{ kind: string; title: string; door: string }> }>('/api/search?q=quokka', headers);
    expect(rows.map((row) => [row.kind, row.title])).toEqual(expect.arrayContaining([
      ['task', 'Quokka survey'], ['milestone', 'Quokka launch'], ['call', 'Weekly sync'],
    ]));
    expect(rows.find((row) => row.kind === 'milestone')?.door).toBe(`subject:project:${project.id}`);
    expect(rows.find((row) => row.kind === 'call')?.door).toBe(`subject:project:${project.id}`);
  });

  it('serves My work, Unowned and Recently closed from D1', async () => {
    const { headers } = await member(EMAIL);
    await member(COLLEAGUE);
    const ana = await personId(EMAIL);
    const bo = await personId(COLLEAGUE);
    const { project } = await seedSubjects(headers);
    const create = async (body: Record<string, unknown>) =>
      (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, { project_id: project.id, ...body })).task;

    const mine = await create({ title: 'Mine', assigned_to: ana });
    const theirs = await create({ title: 'Theirs', assigned_to: bo });
    const nobody = await create({ title: 'Nobody', assigned_to: null });
    const client = await create({ title: 'Client owes', responsible_party: 'client' });
    const closed = await create({ title: 'Closed', assigned_to: ana });
    await write('PATCH', `/api/crm/tasks/${closed.id}`, headers, { status: 'completed' });

    const work = await read<CrmMyWorkResponse>('/api/crm/mine', headers);
    expect(work.tasks.map((task) => task.id)).toEqual([mine.id]);
    expect(work.tasks[0]).toMatchObject({ subject_title: 'Northwind rollout', github_owner: null });
    expect(work).toMatchObject({ issues: [], matched: false, github_login: null });
    const colleague = await read<CrmMyWorkResponse>(`/api/crm/work?assignee_email=${encodeURIComponent(COLLEAGUE)}`, headers);
    expect(colleague.tasks.map((task) => task.id)).toEqual([theirs.id]);

    const unowned = await read<CrmUnownedWorkResponse>('/api/crm/unowned', headers);
    expect(unowned.tasks.map((task) => task.id)).toContain(nobody.id);
    expect(unowned.tasks.map((task) => task.id)).not.toContain(mine.id);
    expect(unowned.tasks.map((task) => task.id)).not.toContain(client.id);
    expect(unowned.partial).toEqual([]);

    const recent = await read<CrmRecentlyClosedWorkResponse>('/api/crm/recently-closed', headers);
    expect(recent.items.map((item) => item.id)).toEqual([closed.id]);
    expect(recent.partial).toEqual([]);
  });

  it('ties a task to a goal on the workspace and refuses one that is not', async () => {
    const { headers } = await member(EMAIL);
    const { project } = await seedSubjects(headers);
    const { goal } = await write<CrmGoalResponse>('POST', '/api/crm/goals', headers, { project_id: project.id, title: 'Ship phase one' });

    const task = (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, { title: 'Toward the goal', project_id: project.id, goal_id: goal.id })).task;
    expect(task.goal_id).toBe(goal.id);
    expect((await write<{ task: CrmTask }>('PATCH', `/api/crm/tasks/${task.id}`, headers, { goal_id: null })).task.goal_id).toBeNull();

    // A goal id from nowhere would leave the task pointing at nothing.
    const created = await hit('POST', '/api/crm/tasks', headers, { title: 'Stray', project_id: project.id, goal_id: crypto.randomUUID() });
    expect(created.status).toBe(400);
    expect((await hit('PATCH', `/api/crm/tasks/${task.id}`, headers, { goal_id: crypto.randomUUID() })).status).toBe(400);
    expect((await read<{ tasks: CrmTask[] }>(`/api/crm/tasks?project_id=${project.id}`, headers)).tasks.map((row) => [row.id, row.goal_id]))
      .toEqual([[task.id, null]]);
  });

  it('closes and reopens a task: Recently closed, the open list and the counts follow', async () => {
    const { headers } = await member(EMAIL);
    const { project } = await seedSubjects(headers);
    const task = (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, { title: 'Close me', project_id: project.id })).task;

    await write('PATCH', `/api/crm/tasks/${task.id}`, headers, { status: 'completed' });
    expect((await read<CrmRecentlyClosedWorkResponse>('/api/crm/recently-closed', headers)).items.map((item) => item.id)).toEqual([task.id]);
    expect((await read<{ tasks: CrmTask[] }>(`/api/crm/tasks?project_id=${project.id}`, headers)).tasks).toEqual([]);
    expect((await read<{ task: CrmTask }>(`/api/crm/tasks/${task.id}`, headers)).task.status).toBe('completed');
    expect((await read<CrmSubjectsResponse>('/api/crm/subjects?kind=project', headers)).subjects[0]).toMatchObject({ open_tasks: 0 });

    await write('PATCH', `/api/crm/tasks/${task.id}`, headers, { status: 'pending' });
    expect((await read<CrmRecentlyClosedWorkResponse>('/api/crm/recently-closed', headers)).items).toEqual([]);
    expect((await read<{ tasks: CrmTask[] }>(`/api/crm/tasks?project_id=${project.id}`, headers)).tasks.map((row) => row.id)).toEqual([task.id]);
    expect((await read<CrmSubjectsResponse>('/api/crm/subjects?kind=project', headers)).subjects[0]).toMatchObject({ open_tasks: 1 });
  });

  it('puts dated tasks and milestones on the calendar', async () => {
    const { headers } = await member(EMAIL);
    const { project } = await seedSubjects(headers);
    const due = '2026-10-15T09:00:00.000Z';
    const task = (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, { title: 'Dated', project_id: project.id, due_date: due })).task;
    await write('POST', '/api/crm/tasks', headers, { title: 'Undated', project_id: project.id });
    // No route writes a milestone on a D1 workspace yet.
    const milestone = crypto.randomUUID();
    await d1.USAGE.prepare(
      `INSERT INTO milestones (id, project_id, title, status, due_at, created_at, updated_at) VALUES (?1, ?2, 'Launch', 'pending', ?3, ?4, ?4)`,
    ).bind(milestone, project.id, Date.parse('2026-10-20T00:00:00Z'), Date.now()).run();

    const { items } = await read<CalendarWorkItemsResponse>('/api/calendar/work-items?start=2026-10-01&end=2026-10-31', headers);
    expect(items.map((item) => [item.kind, item.id]).sort()).toEqual([['milestone', milestone], ['task', task.id]].sort());
    expect(items.find((item) => item.id === task.id)).toMatchObject({ due_at: due, project_title: 'Northwind rollout', status: 'pending' });
    expect(items.find((item) => item.id === milestone)).toMatchObject({ title: 'Launch', project_title: 'Northwind rollout', responsible_party: 'team' });
    expect((await read<CalendarWorkItemsResponse>('/api/calendar/work-items?start=2026-12-01&end=2026-12-31', headers)).items).toEqual([]);
  });

  it('shows a new subject and its tasks on the board at once', async () => {
    const { headers } = await member(EMAIL);
    // The board reads first, so its lists are in the minute cache.
    expect((await read<CrmBoardResponse>('/api/crm/board', headers)).subjects).toEqual([]);
    const { project } = await seedSubjects(headers);
    const board = await read<CrmBoardResponse>('/api/crm/board', headers);
    expect(board.subjects.map((subject) => subject.id)).toContain(project.id);

    const task = (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, { title: 'On the board', project_id: project.id })).task;
    expect((await read<CrmBoardResponse>('/api/crm/board', headers)).tasks.map((row) => row.id)).toContain(task.id);

    await write('PATCH', `/api/crm/subjects/project/${project.id}`, headers, { title: 'Renamed rollout' });
    const renamed = await read<CrmBoardResponse>('/api/crm/board', headers);
    expect(renamed.subjects.find((subject) => subject.id === project.id)?.title).toBe('Renamed rollout');
  });
});

describe('goals, decisions, favorites and repositories', () => {
  it('creates, lists and updates goals', async () => {
    const { headers } = await member(EMAIL);
    const ana = await personId(EMAIL);
    const { project } = await seedSubjects(headers);
    const made = await hit('POST', '/api/crm/goals', headers, { project_id: project.id, title: 'Ship phase one', target_date: '2026-12-01', owner: ana });
    expect(made.status).toBe(201);
    const { goal } = await made.json<CrmGoalResponse>();
    expect(goal).toMatchObject({
      project_id: project.id, title: 'Ship phase one', status: 'open', target_date: '2026-12-01',
      owner: ana, owner_email: EMAIL, owner_name: 'd1store-ana', created_by: ana, created_by_email: EMAIL,
    });
    expect((await read<CrmGoalsResponse>(`/api/crm/goals?project_id=${project.id}`, headers)).goals).toEqual([goal]);

    const met = await write<CrmGoalResponse>('PATCH', `/api/crm/goals/${goal.id}`, headers, { status: 'met', owner: null });
    expect(met.goal).toMatchObject({ status: 'met', owner: null, owner_name: null });
    expect((await read<CrmGoalsResponse>(`/api/crm/goals?project_id=${project.id}`, headers)).goals).toEqual([]);
    expect((await read<CrmGoalsResponse>(`/api/crm/goals?project_id=${project.id}&include_closed=true`, headers)).goals.map((row) => row.id)).toEqual([goal.id]);

    expect((await hit('POST', '/api/crm/goals', headers, { project_id: crypto.randomUUID(), title: 'x' })).status).toBe(400);
    expect((await hit('PATCH', `/api/crm/goals/${crypto.randomUUID()}`, headers, { title: 'x' })).status).toBe(404);
  });

  it('records decisions on a subject and reads them back', async () => {
    const { headers } = await member(EMAIL);
    const ana = await personId(EMAIL);
    const { lead, project } = await seedSubjects(headers);
    const { goal } = await write<CrmGoalResponse>('POST', '/api/crm/goals', headers, { project_id: project.id, title: 'Ship phase one' });
    const made = await hit('POST', '/api/crm/decisions', headers, {
      subject_kind: 'project', subject_id: project.id, body: 'We ship in two waves.', goal_id: goal.id,
    });
    expect(made.status).toBe(201);
    const { decision } = await made.json<CrmDecisionResponse>();
    expect(decision).toMatchObject({
      subject_kind: 'project', subject_id: project.id, body: 'We ship in two waves.', source: 'manual', goal_id: goal.id,
      decided_by: ana, decided_by_email: EMAIL, decided_by_name: 'd1store-ana',
    });
    await write('POST', '/api/crm/decisions', headers, { subject_kind: 'lead', subject_id: lead.id, body: 'We quote in euros.' });

    expect((await read<CrmDecisionsResponse>(`/api/crm/decisions?subject_kind=project&subject_id=${project.id}`, headers)).decisions).toEqual([decision]);
    expect((await read<CrmDecisionsResponse>(`/api/crm/decisions?subject_kind=lead&subject_id=${lead.id}`, headers)).decisions.map((row) => row.body))
      .toEqual(['We quote in euros.']);
    expect((await hit('POST', '/api/crm/decisions', headers, { subject_kind: 'project', subject_id: crypto.randomUUID(), body: 'x' })).status).toBe(400);
    expect((await hit('POST', '/api/crm/decisions', headers, { subject_kind: 'project', subject_id: project.id, body: 'x', goal_id: crypto.randomUUID() })).status).toBe(400);
  });

  it('keeps favorites in D1 with no Core queue, and the starred strip draws them', async () => {
    const { headers, sub } = await member(EMAIL);
    const { project } = await seedSubjects(headers);
    const added = await hit('POST', '/api/crm/favorites', headers, { kind: 'crm.project', target_ref: project.id });
    expect(added.status).toBe(200);
    const body = await added.json<FavoriteMutationResponse>();
    expect(body).toMatchObject({ synced: true, favorite: { kind: 'crm.project', target_ref: project.id } });
    // Adding it again answers the one that exists.
    expect((await write<FavoriteMutationResponse>('POST', '/api/crm/favorites', headers, { kind: 'crm.project', target_ref: project.id })).favorite)
      .toEqual(body.favorite);

    const listed = await read<FavoritesResponse>('/api/crm/favorites', headers);
    expect(listed).toEqual({ favorites: [body.favorite], synced: true });
    const starred = await read<SearchResponse>('/api/crm/starred', headers);
    expect(starred.rows.map((row) => row.door)).toEqual([`subject:project:${project.id}`]);

    const queued = await d1.USAGE.prepare('SELECT COUNT(*) AS n FROM favorite_sync_queue WHERE sub = ?1').bind(sub).first<{ n: number }>();
    expect(queued?.n).toBe(0);

    // The old subject-star route writes the same row.
    await write('PUT', `/api/crm/subject-state/project/${project.id}`, headers, { starred: false });
    expect((await read<FavoritesResponse>('/api/crm/favorites', headers)).favorites).toEqual([]);
    await write('PUT', `/api/crm/subject-state/project/${project.id}`, headers, { starred: true });
    expect((await read<FavoritesResponse>('/api/crm/favorites', headers)).favorites.map((row) => row.target_ref)).toEqual([project.id]);

    const removed = await hit('DELETE', `/api/crm/favorites?kind=crm.project&target_ref=${project.id}`, headers);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ removed: true, synced: true });
    expect((await read<FavoritesResponse>('/api/crm/favorites', headers)).favorites).toEqual([]);
  });

  it('links repositories to a project without the GitHub App', async () => {
    const { headers } = await member(EMAIL);
    const { project } = await seedSubjects(headers);
    const first = await hit('POST', '/api/crm/project-repos', headers, { project_id: project.id, owner: 'northwind', repo: 'web', label: 'Site' });
    expect(first.status).toBe(201);
    expect((await first.json<CrmProjectRepoResponse>()).repo).toEqual({ id: 'northwind/web', owner: 'northwind', repo: 'web', label: 'Site', milestone: null, is_primary: true });
    await write('POST', '/api/crm/project-repos', headers, { project_id: project.id, owner: 'northwind', repo: 'api' });
    const primary = await write<CrmProjectRepoResponse>('POST', '/api/crm/project-repos', headers, { project_id: project.id, owner: 'northwind', repo: 'api', is_primary: true });
    expect(primary.repo.is_primary).toBe(true);

    const linked = await read<CrmGithubReposResponse>(`/api/crm/project-repos?project_id=${project.id}`, headers);
    expect(linked.repos.map((repo) => [repo.id, repo.is_primary])).toEqual([['northwind/api', true], ['northwind/web', false]]);
    const picker = await read<CrmGithubReposResponse>('/api/crm/github-repos?q=web', headers);
    expect(picker.repos.map((repo) => repo.id)).toEqual(['northwind/web']);
    // Issues need Meet's GitHub App on a D1 workspace.
    expect((await hit('GET', `/api/crm/issues?project_id=${project.id}`, headers)).status).toBe(503);
    expect((await hit('POST', '/api/crm/project-repos', headers, { project_id: crypto.randomUUID(), owner: 'a', repo: 'b' })).status).toBe(400);
  });

  it('lets an enrolled agent hold a task, and refuses a frozen one (meet#1106)', async () => {
    const agentEmail = 'd1store-helper@example.com';
    const withAgent = { ...d1, AGENT_ROSTER: JSON.stringify({ [agentEmail]: { name: 'Helper', endpoint: 'https://helper.example.com/meet/handoff' } }) } as Env;
    await ensureAgentPeople(withAgent, Date.now());
    const { headers } = await member(EMAIL, withAgent);
    const { project } = await seedSubjects(headers, withAgent);
    const team = await read<CrmTeamResponse>('/api/crm/team', headers, withAgent);
    const agent = team.members.find((row) => row.email === agentEmail);
    expect(agent).toMatchObject({ kind: 'agent', name: 'Helper' });
    expect(team.members.find((row) => row.email === EMAIL)?.kind).toBe('person');
    const task = (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, { project_id: project.id, title: 'Draft the glossary', assigned_to: agent!.id }, withAgent)).task;
    expect(task).toMatchObject({ assignee_id: agent!.id, assignee_email: agentEmail, assignee_kind: 'agent' });
    await bindings.USAGE.prepare("INSERT INTO agent_freezes (agent_sub, agent_email, frozen_at, frozen_by_email) VALUES (?1, ?2, ?3, ?4)")
      .bind(agentSub(agentEmail), agentEmail, Date.now(), EMAIL).run();
    try {
      expect((await hit('POST', '/api/crm/tasks', headers, { project_id: project.id, title: 'Another', assigned_to: agent!.id }, withAgent)).status).toBe(400);
      const frozenTeam = await read<CrmTeamResponse>('/api/crm/team', headers, withAgent);
      expect(frozenTeam.members.some((row) => row.email === agentEmail)).toBe(false);
    } finally {
      await bindings.USAGE.prepare('DELETE FROM agent_freezes WHERE agent_sub = ?1').bind(agentSub(agentEmail)).run();
    }
  });

  it('gives a new task to its creator unless the create says nobody (meet#1102)', async () => {
    const { headers } = await member(EMAIL);
    const { project } = await seedSubjects(headers);
    const team = await read<CrmTeamResponse>('/api/crm/team', headers);
    const me = team.members.find((row) => row.email === EMAIL);
    expect(me).toBeTruthy();
    const mine = (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, { project_id: project.id, title: 'Draft the brief' })).task;
    expect(mine).toMatchObject({ assignee_id: me?.id, responsible_party: 'team' });
    const nobody = (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, { project_id: project.id, title: 'Someone, sometime', assigned_to: null })).task;
    expect(nobody.assignee_id).toBeNull();
    const client = (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, { project_id: project.id, title: 'Client sends logo', responsible_party: 'client' })).task;
    expect(client).toMatchObject({ assignee_id: null, responsible_party: 'client' });
  });

  it('files a task on GitHub as one card: the task keeps its issue (meet#1109)', async () => {
    const withApp = connectedGithub(d1);
    const filed: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === '/repos/northwind/web' && request.method === 'GET') return Response.json({ name: 'web', full_name: 'northwind/web', owner: { login: 'northwind' }, private: true });
      if (url.pathname === '/repos/northwind/web/issues' && request.method === 'POST') {
        filed.push(url.pathname);
        return Response.json({ number: 41, title: 'Send the deck', state: 'open', html_url: 'https://github.com/northwind/web/issues/41' }, { status: 201 });
      }
      return Response.json({ message: 'Not Found' }, { status: 404 });
    });

    const { headers } = await member(EMAIL, withApp);
    const { project } = await seedSubjects(headers, withApp);
    await write('POST', '/api/crm/project-repos', headers, { project_id: project.id, owner: 'northwind', repo: 'web' }, withApp);
    const task = (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, { project_id: project.id, title: 'Send the deck' }, withApp)).task;

    const response = await hit('POST', '/api/crm/issue', headers, { project_id: project.id, task_id: task.id, title: task.title }, withApp);
    expect(response.status).toBe(201);
    expect(filed).toHaveLength(1);
    const linked = (await read<{ tasks: CrmTask[] }>(`/api/crm/tasks?project_id=${project.id}`, headers, withApp)).tasks.find((row) => row.id === task.id);
    expect(linked).toMatchObject({ github_owner: 'northwind', github_repo: 'web', github_issue_number: 41 });

    // A second filing of the same task is refused before GitHub hears of it.
    expect((await hit('POST', '/api/crm/issue', headers, { project_id: project.id, task_id: task.id, title: task.title }, withApp)).status).toBe(409);
    expect(filed).toHaveLength(1);
  });
});

describe('the meeting log', () => {
  function payload(meetingId: string, phase: 'started' | 'ended', projectId: string): MeetingLogPayload {
    return {
      phase,
      meeting_id: meetingId,
      room_slug: 'rosa',
      host_email: EMAIL,
      started_at: '2026-10-02T09:00:00.000Z',
      ended_at: phase === 'ended' ? '2026-10-02T09:45:00.000Z' : null,
      title: phase === 'ended' ? 'Rollout kickoff' : null,
      summary_markdown: phase === 'ended' ? '## Summary\n- We agreed the scope.' : null,
      transcript: phase === 'ended'
        ? [{ speaker_name: 'Ana', speaker_id: 'ana', starts_at_ms: 0, ends_at_ms: 900, text: 'Hello all.', language: 'en' }]
        : [],
      participants: [],
      booking_token: null,
      permalink: 'https://envisioning.starlings.example/room/rosa',
      meeting_kind: 'project',
      lead_id: null,
      project_id: projectId,
      partner_organization_id: null,
      categorized_by: EMAIL,
      transcript_document_id: phase === 'ended' ? 'doc-1' : null,
      transcript_url: phase === 'ended' ? 'https://docs.invalid/doc-1' : null,
    };
  }

  it('writes a filed call in place and the subject, the feed and INBOX read it back', async () => {
    const { headers } = await member(EMAIL);
    const { organization, project } = await seedSubjects(headers);
    const meetingId = crypto.randomUUID();

    await postMeetingLog(d1, payload(meetingId, 'started', project.id));
    let { interactions } = await read<CrmInteractionsResponse>(`/api/crm/interactions?project_id=${project.id}`, headers);
    expect(interactions).toHaveLength(1);
    expect(interactions[0]).toMatchObject({ status: 'in_progress', title: 'Untitled meeting', project_id: project.id, duration_minutes: null });

    await postMeetingLog(d1, payload(meetingId, 'ended', project.id));
    // A redelivery writes the same row again.
    await postMeetingLog(d1, payload(meetingId, 'ended', project.id));
    ({ interactions } = await read<CrmInteractionsResponse>(`/api/crm/interactions?project_id=${project.id}`, headers));
    expect(interactions).toHaveLength(1);
    expect(interactions[0]).toMatchObject({
      type: 'meeting', title: 'Rollout kickoff', status: 'logged', channel: 'meet', source: 'meet_envisioning',
      summary_preview: 'Summary', transcript_preview: 'Hello all.', duration_minutes: 45, occurred_at: '2026-10-02T09:00:00.000Z',
      project_id: project.id, lead_id: null, organization_id: organization.id, url: 'https://envisioning.starlings.example/room/rosa', contacts: [],
    });
    // A partner's history holds what is filed under its projects.
    await makePartner(organization.id);
    expect((await read<CrmInteractionsResponse>(`/api/crm/interactions?organization_id=${organization.id}`, headers)).interactions.map((row) => row.id))
      .toEqual([interactions[0]!.id]);

    const feed = await read<{ entries: Array<{ interaction: { id: string }; subject: { id: string } }> }>('/api/crm/feed', headers);
    expect(feed.entries.map((entry) => [entry.subject.id, entry.interaction.id])).toContainEqual([project.id, interactions[0]!.id]);
  });

  it('moves a call to another subject, keeps what the end wrote, and files a partner call under the organization', async () => {
    const { headers } = await member(EMAIL);
    const { organization, lead, project } = await seedSubjects(headers);
    await makePartner(organization.id);
    const meetingId = crypto.randomUUID();
    const interactionsOf = async (query: string) =>
      (await read<CrmInteractionsResponse>(`/api/crm/interactions?${query}`, headers)).interactions;

    await postMeetingLog(d1, payload(meetingId, 'ended', project.id));
    const [logged] = await interactionsOf(`project_id=${project.id}`);
    expect(logged).toMatchObject({ title: 'Rollout kickoff', status: 'logged' });

    // A late `started` refiles the call on the lead. It does not reopen it or drop its title.
    await postMeetingLog(d1, { ...payload(meetingId, 'started', project.id), meeting_kind: 'lead', lead_id: lead.id, project_id: null });
    expect(await interactionsOf(`project_id=${project.id}`)).toEqual([]);
    expect(await interactionsOf(`lead_id=${lead.id}`)).toMatchObject([
      { id: logged!.id, title: 'Rollout kickoff', status: 'logged', lead_id: lead.id, project_id: null, organization_id: organization.id },
    ]);

    // An absent kind leaves the filing where it is.
    const { meeting_kind: _kind, ...unfiled } = payload(meetingId, 'ended', project.id);
    await postMeetingLog(d1, unfiled as MeetingLogPayload);
    expect((await interactionsOf(`lead_id=${lead.id}`)).map((row) => row.id)).toEqual([logged!.id]);

    // A partner call is filed on the organization itself.
    const partnerCall = crypto.randomUUID();
    await postMeetingLog(d1, {
      ...payload(partnerCall, 'ended', project.id), meeting_kind: 'partner', project_id: null, partner_organization_id: organization.id,
    });
    // The partner's history holds its own call and the one on its lead.
    const partner = await interactionsOf(`organization_id=${organization.id}`);
    expect(partner).toHaveLength(2);
    expect(partner.map((row) => row.id)).toContain(logged!.id);
    expect(partner.find((row) => row.id !== logged!.id)).toMatchObject({ organization_id: organization.id, project_id: null, lead_id: null });

    // A subject that is not on this workspace: the call is logged and filed nowhere.
    const stray = crypto.randomUUID();
    await postMeetingLog(d1, payload(stray, 'ended', crypto.randomUUID()));
    const row = await d1.USAGE.prepare('SELECT id FROM interactions WHERE external_id = ?1').bind(stray).first<{ id: string }>();
    expect(row).not.toBeNull();
    const links = await d1.USAGE.prepare('SELECT COUNT(*) AS n FROM interaction_subjects WHERE interaction_id = ?1').bind(row!.id).first<{ n: number }>();
    expect(links?.n).toBe(0);
  });
});

describe('search and INBOX', () => {
  it('finds subjects, partners, tasks, goals and decisions from D1', async () => {
    const { headers } = await member(EMAIL);
    const ana = await personId(EMAIL);
    const { organization, project } = await seedSubjects(headers);
    await makePartner(organization.id);
    const task = (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, { title: 'Northwind contract review', project_id: project.id, assigned_to: ana })).task;
    const { goal } = await write<CrmGoalResponse>('POST', '/api/crm/goals', headers, { project_id: project.id, title: 'Northwind live in December' });
    const { decision } = await write<CrmDecisionResponse>('POST', '/api/crm/decisions', headers, { subject_kind: 'project', subject_id: project.id, body: 'Northwind hosts the data.' });

    const found = await read<SearchResponse>('/api/search?q=northwind', headers);
    const rows = found.rows.map((row) => [row.kind, row.id, row.door]);
    expect(rows).toContainEqual(['subject', project.id, `subject:project:${project.id}`]);
    expect(rows).toContainEqual(['subject', organization.id, `subject:organization:${organization.id}`]);
    expect(rows).toContainEqual(['task', task.id, `task:${task.id}`]);
    // A goal and a decision open the subject they live on.
    expect(rows).toContainEqual(['goal', goal.id, `subject:project:${project.id}`]);
    expect(rows).toContainEqual(['decision', decision.id, `subject:project:${project.id}`]);
    expect(found.partial ?? []).not.toContain('subjects');
  });

  it('lists proposed work and the recent feed, never your own overdue or assigned work', async () => {
    const { headers } = await member(EMAIL);
    const ana = await personId(EMAIL);
    const { project } = await seedSubjects(headers);
    const proposed = (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, { title: 'Proposed', project_id: project.id, status: 'proposed' })).task;
    const overdue = (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, {
      title: 'Late', project_id: project.id, assigned_to: ana, due_date: new Date(Date.now() - 2 * DAY).toISOString(),
    })).task;
    await postMeetingLog(d1, {
      phase: 'ended', meeting_id: crypto.randomUUID(), room_slug: 'rosa', host_email: EMAIL,
      started_at: new Date(Date.now() - DAY).toISOString(), ended_at: new Date(Date.now() - DAY + 1_800_000).toISOString(),
      title: 'Weekly sync', summary_markdown: 'Fine.', transcript: [], participants: [], booking_token: null, permalink: null,
      meeting_kind: 'project', lead_id: null, project_id: project.id, partner_organization_id: null, categorized_by: EMAIL,
      transcript_document_id: null, transcript_url: null,
    });

    // Your own work is MINE's: a late task is never an INBOX row.
    const inbox = await read<InboxResponse>('/api/crm/inbox', headers);
    const rows = inbox.items.map((item) => `${item.source} ${item.key}`);
    expect(rows).toContain(`task task:${proposed.id}`);
    expect(rows.some((row) => row.includes(overdue.id)), rows.join('\n')).toBe(false);
    expect(inbox.items.some((item) => item.source === 'sales' || item.source === 'booking')).toBe(false);
    expect(inbox.recent.map((entry) => entry.title)).toContain('Weekly sync');
    expect(inbox.partial).toEqual([]);
  });
});

describe('MCP', () => {
  async function bearer(email: string): Promise<string> {
    const now = Date.now();
    await d1.USAGE.prepare(
      `INSERT OR REPLACE INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at) VALUES ('client-d1', 'claude.ai', NULL, '["https://claude.ai/api/mcp/auth_callback"]', ?1)`,
    ).bind(now).run();
    await d1.USAGE.prepare(
      `INSERT OR REPLACE INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at)
       VALUES ('grant-d1', 'client-d1', ?1, ?2, 'read write', 'jti', NULL, ?3, ?3, NULL, NULL)`,
    ).bind(`dev:${email}`, email, now).run();
    return new SignJWT({ email, name: 'Ana', scope: 'read write', grant: 'grant-d1', client: 'client-d1' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('starlings.example')
      .setAudience('meet-mcp')
      .setSubject(`dev:${email}`)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(signingKey(d1.SESSION_SIGNING_SECRET));
  }

  async function rpc<T>(token: string, method: string, params?: unknown): Promise<{ result?: T; error?: { code: number; message: string } }> {
    const response = await invoke(new Request('http://local/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
    }));
    return response.json();
  }

  afterEach(async () => {
    await d1.USAGE.prepare("DELETE FROM mcp_grants WHERE id = 'grant-d1'").run();
    await d1.USAGE.prepare("DELETE FROM mcp_clients WHERE client_id = 'client-d1'").run();
  });

  it('lists no tool or resource for what only Core holds, and refuses them as unknown', async () => {
    await member(EMAIL);
    const token = await bearer(EMAIL);
    const tools = (await rpc<{ tools: Array<{ name: string }> }>(token, 'tools/list')).result!.tools.map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(['search', 'open', 'now', 'task', 'record_decision', 'set_goal']));
    expect(tools).not.toContain('create_issue');

    const templates = (await rpc<{ resourceTemplates: Array<{ uriTemplate: string }> }>(token, 'resources/templates/list')).result!.resourceTemplates
      .map((template) => template.uriTemplate);
    expect(templates).toContain('starlings://subjects/{kind}');
    expect(templates).not.toContain('starlings://core/registry');
    expect(templates).not.toContain('starlings://cms/registry');

    // `cms` answers the CRM records from D1 (meet#1212); website content is Core's.
    const cms = await rpc<{ isError?: boolean; content?: Array<{ text: string }> }>(token, 'tools/call', { name: 'cms', arguments: { entity: 'events' } });
    expect(JSON.stringify(cms)).toMatch(/no website content/u);
    const registry = await rpc(token, 'resources/read', { uri: 'starlings://core/registry' });
    expect(registry.error?.message).toMatch(/^No resource at that URI\./u);
    expect(registry.error?.message).not.toContain('starlings://core/registry');
  });

  it('reads and writes CRM records through `cms` on D1 (meet#1212)', async () => {
    const { headers } = await member(EMAIL);
    const { organization } = await seedSubjects(headers);
    const token = await bearer(EMAIL);
    const tool = async (args: Record<string, unknown>) => {
      const answer = await rpc<{ isError?: boolean; content?: Array<{ text: string }> }>(token, 'tools/call', { name: 'cms', arguments: args });
      expect(answer.result?.isError, JSON.stringify(answer)).toBeFalsy();
      return JSON.parse(answer.result!.content![0]!.text) as { data: Record<string, unknown> & Array<Record<string, unknown>> };
    };
    const created = await tool({ entity: 'organizations', body: { name: 'Cms Org', website: 'https://cms.example', city: 'Lisbon', is_agency: true } });
    expect(created.data).toMatchObject({ name: 'Cms Org', website: 'https://cms.example', city: 'Lisbon', is_agency: true });
    const id = created.data.id as string;
    expect((await tool({ entity: 'organizations', id, body: { city: 'Porto' } })).data).toMatchObject({ city: 'Porto', website: 'https://cms.example' });
    expect((await tool({ entity: 'organizations', id })).data).toMatchObject({ city: 'Porto' });
    expect((await tool({ entity: 'organizations', q: 'cms' })).data.map((row) => row.id)).toEqual([id]);

    const contact = await tool({ entity: 'contacts', body: { first_name: 'Ada', last_name: 'Rossi', organization_id: organization.id, company_role: 'CTO', phone: '+351 000' } });
    expect(contact.data).toMatchObject({ name: 'Ada Rossi', company_role: 'CTO', phone: '+351 000', organization_id: organization.id });

    // A field D1 does not keep is refused, never dropped.
    const unknown = await rpc<{ isError?: boolean }>(token, 'tools/call', { name: 'cms', arguments: { entity: 'organizations', id, body: { billing_iban: 'x' } } });
    expect(JSON.stringify(unknown)).toMatch(/keep no billing_iban/u);

    // The guarded delete: refused while a contact points at it, then done.
    const busy = await rpc(token, 'tools/call', { name: 'cms', arguments: { entity: 'organizations', id: organization.id, delete: true } });
    expect(JSON.stringify(busy)).toMatch(/Organization is in use \(contacts 1/u);
    expect((await tool({ entity: 'organizations', id, delete: true })).data).toEqual({ id, deleted: true });
    expect((await hit('GET', `/api/core/fields/organizations/${id}`, headers)).status).toBe(404);
  });

  it('creates a task and records a decision on a D1 project', async () => {
    const { headers } = await member(EMAIL);
    const { project } = await seedSubjects(headers);
    const token = await bearer(EMAIL);

    const task = await rpc<{ isError?: boolean; structuredContent: { task: { id: string } } }>(token, 'tools/call', {
      name: 'task', arguments: { subject: `subject:project:${project.id}`, title: 'Agent task', assign_to_me: true },
    });
    expect(task.error).toBeUndefined();
    expect(task.result?.isError).toBeFalsy();
    const taskId = task.result!.structuredContent.task.id;
    expect((await read<{ task: CrmTask }>(`/api/crm/tasks/${taskId}`, headers)).task).toMatchObject({
      title: 'Agent task', project_id: project.id, assignee_id: await personId(EMAIL),
    });

    const decided = await rpc<{ isError?: boolean }>(token, 'tools/call', {
      name: 'record_decision', arguments: { subject: `subject:project:${project.id}`, body: 'The agent settled it.' },
    });
    expect(decided.result?.isError).toBeFalsy();
    const decisions = await read<CrmDecisionsResponse>(`/api/crm/decisions?subject_kind=project&subject_id=${project.id}`, headers);
    expect(decisions.decisions).toMatchObject([{ body: 'The agent settled it.', source: 'agent', source_ref: 'claude.ai' }]);

    const subjects = await rpc<{ contents: Array<{ text: string }> }>(token, 'resources/read', { uri: 'starlings://subjects/project' });
    expect(subjects.result?.contents[0]?.text).toContain(project.id);
  });
});

describe('contacts (meet#947)', () => {
  function call(meetingId: string, projectId: string, guests: string[]): MeetingLogPayload {
    return {
      phase: 'ended',
      meeting_id: meetingId,
      room_slug: 'mz',
      host_email: EMAIL,
      started_at: '2026-10-03T09:00:00.000Z',
      ended_at: '2026-10-03T09:30:00.000Z',
      title: 'Scope review',
      summary_markdown: 'We agreed the scope.',
      transcript: [],
      participants: [
        { identity: 'host', name: 'Ana', email: EMAIL, role: 'owner', booking_token: null },
        ...guests.map((email, index) => ({ identity: `guest-${index}`, name: email, email, role: 'guest' as const, booking_token: null })),
      ],
      booking_token: null,
      permalink: null,
      meeting_kind: 'project',
      lead_id: null,
      project_id: projectId,
      partner_organization_id: null,
      categorized_by: EMAIL,
      transcript_document_id: null,
      transcript_url: null,
    };
  }

  it('creates a contact on an organization with several addresses, lists it there and edits it', async () => {
    const { headers } = await member(EMAIL);
    const { organization } = await seedSubjects(headers);
    const created = await write<CrmContactResponse>('POST', '/api/crm/contacts', headers, {
      name: 'Grace Hopper', title: 'Head of research', organization_id: organization.id,
      emails: ['Grace@Northwind.example', 'grace.h@gmail.example'],
    });
    expect(created.contact).toMatchObject({
      name: 'Grace Hopper', title: 'Head of research', organization_id: organization.id, organization_name: 'Northwind Labs',
      email: 'grace@northwind.example', emails: ['grace@northwind.example', 'grace.h@gmail.example'],
      projects: [], leads: [], interactions: [], met_by: [],
    });
    const id = created.contact.id;

    // The organization page lists its contacts, and so does the list by organization.
    const detail = await read<CrmSubjectDetailResponse>(`/api/crm/subjects/organization/${organization.id}`, headers);
    expect(detail.subject.related?.contacts).toEqual([{ id, name: 'Grace Hopper', email: 'grace@northwind.example', title: 'Head of research' }]);
    const onOrganization = await read<CrmContactsResponse>(`/api/crm/contacts?organization_id=${organization.id}`, headers);
    expect(onOrganization.contacts.map((row) => row.id)).toEqual([id]);

    // Found by name, by any address and by the organization's name; named by id.
    for (const q of ['hopper', 'gmail', 'northwind']) {
      expect((await read<CrmContactsResponse>(`/api/crm/contacts?q=${q}`, headers)).contacts.map((row) => row.id), q).toEqual([id]);
    }
    expect((await read<CrmContactsResponse>(`/api/crm/contacts?ids=${id},not-an-id`, headers)).contacts.map((row) => row.id)).toEqual([id]);

    // An edit changes only what it names; the address list is replaced whole.
    const edited = await write<CrmContactResponse>('PATCH', `/api/crm/contacts/${id}`, headers, {
      title: null, emails: ['grace.h@gmail.example'],
    });
    expect(edited.contact).toMatchObject({ name: 'Grace Hopper', title: null, email: 'grace.h@gmail.example', emails: ['grace.h@gmail.example'] });
    // The address it dropped is free again; the one it kept is not.
    expect((await read<CrmContactsResponse>('/api/crm/contacts?q=northwind.example', headers)).contacts).toEqual([]);
  });

  it('keeps every Core profile field through a write and a read (meet#1209)', async () => {
    const { headers } = await member(EMAIL);
    const { organization } = await seedSubjects(headers);
    const profile = {
      notes: 'Met at the summit.', linkedin_url: 'https://linkedin.example/in/ada', phone: '+31 20 000 0000',
      headline: 'Research lead', location: 'Amsterdam', connection_count: '500+', country: 'NL',
      corporate_email: 'ada@corp.example', profile_image_url: 'https://img.example/ada.png',
      characteristics: { newsletter_subscriber: true, speaker: false }, preferred_language: 'pt',
      signals_outreach_status: 'contacted', signals_notified_at: '2026-10-01T09:00:00.000Z',
      birthday_month: 12, birthday_day: 10, birthday_year: 1990,
      futurist: true, corporate: false, academic: true, independent: false, government: false, ngo: true, media: false, intelligence: true,
    };
    const created = await write<CrmContactResponse>('POST', '/api/crm/contacts', headers, {
      name: 'Ada Lovelace', organization_id: organization.id, emails: ['ada@northwind.example'], ...profile,
    });
    expect(created.contact).toMatchObject(profile);
    const id = created.contact.id;
    expect((await read<CrmContactResponse>(`/api/crm/contacts/${id}`, headers)).contact).toMatchObject(profile);

    // An edit changes only what it names; null clears; a cleared language goes back to `en`.
    const edited = await write<CrmContactResponse>('PATCH', `/api/crm/contacts/${id}`, headers, {
      phone: null, futurist: false, birthday_year: null, characteristics: null,
    });
    expect(edited.contact).toMatchObject({ ...profile, phone: null, futurist: false, birthday_year: null, characteristics: null });

    // An organization keeps its profile the same way (the route is the edit issue's).
    const fields = {
      legal_name: 'Northwind Labs BV', address: 'Dam 1', postcode: '1012 JS', city: 'Amsterdam', country: 'NL',
      vat_id: 'NL000', tax_id: 'T-1', size: '11-50', owner_id: null, founded: '2010', hq_location: 'Amsterdam',
      company_type: 'Private', linkedin_url: 'https://linkedin.example/company/northwind', logo_url: 'https://img.example/logo.png',
      logo_image_url: 'https://img.example/logo-image.png', profile_image_url: 'https://img.example/curated.png',
      entity: 'EU', domain: 'northwind.example', is_agency: true, is_existing_client: true, is_partner: false,
      url: 'https://northwind.example', notes: 'Key account.',
    };
    const organizationDetail = await d1UpdateOrganization(d1, organization.id, { ...fields, name: '  ' });
    expect(organizationDetail).toMatchObject({ ...fields, title: 'Northwind Labs', organization_logo_url: 'https://img.example/curated.png' });
    expect((await read<CrmSubjectDetailResponse>(`/api/crm/subjects/organization/${organization.id}`, headers)).subject).toMatchObject(fields);
  });

  it('filters the contact list as Core does, and answers the facets only when asked (meet#1213)', async () => {
    const { headers } = await member(EMAIL);
    const { organization } = await seedSubjects(headers);
    await d1.USAGE.prepare('UPDATE organizations SET is_partner = 1, is_existing_client = 0 WHERE id = ?1').bind(organization.id).run();
    const partnerContact = (await write<CrmContactResponse>('POST', '/api/crm/contacts', headers, {
      name: 'Filter Partner', title: 'Curator', organization_id: organization.id, emails: ['partner@filter.example'],
      country: 'nl', preferred_language: 'pt', signals_outreach_status: 'replied',
    })).contact;
    const loose = (await write<CrmContactResponse>('POST', '/api/crm/contacts', headers, {
      name: 'Filter Loose', emails: ['loose@filter.example'], country: 'BR',
    })).contact;
    const ids = async (query: string) => (await read<CrmContactsResponse>(`/api/crm/contacts?q=filter&${query}`, headers)).contacts.map((row) => row.id);

    expect(await ids('')).toEqual([loose.id, partnerContact.id]);
    // By title and by organization name too.
    expect((await read<CrmContactsResponse>('/api/crm/contacts?q=curator', headers)).contacts.map((row) => row.id)).toEqual([partnerContact.id]);
    expect(await ids('partner=true')).toEqual([partnerContact.id]);
    expect(await ids('partner=false')).toEqual([loose.id, partnerContact.id]);
    expect(await ids('existing_client=true')).toEqual([]);
    expect(await ids('country=NL')).toEqual([partnerContact.id]);
    expect(await ids('country=br')).toEqual([loose.id]);
    expect(await ids('preferred_language=en')).toEqual([loose.id]);
    expect(await ids('signals_outreach_status=replied')).toEqual([partnerContact.id]);
    expect(await ids(`organization_id=${organization.id}&preferred_language=pt`)).toEqual([partnerContact.id]);
    expect((await hit('GET', '/api/crm/contacts?signals_outreach_status=contacted', headers)).status).toBe(400);

    expect((await read<CrmContactsResponse>('/api/crm/contacts?q=filter', headers)).facets).toBeUndefined();
    const { facets } = await read<CrmContactsResponse>('/api/crm/contacts?q=nothing-matches&facets=true', headers);
    expect(facets?.countries).toEqual(expect.arrayContaining(['BR', 'NL']));
    expect(facets?.languages).toEqual(expect.arrayContaining(['en', 'pt']));
  });

  it('deletes a contact, refused while a task references it; its lead and project lose the link (meet#1214)', async () => {
    const { headers } = await member(EMAIL);
    const { organization, lead, project } = await seedSubjects(headers);
    const contact = (await write<CrmContactResponse>('POST', '/api/crm/contacts', headers, {
      name: 'Delete Me', organization_id: organization.id, emails: ['delete.me@northwind.example', 'dm@home.example'],
    })).contact;
    await d1.USAGE.prepare('UPDATE leads SET contact_id = ?1 WHERE id = ?2').bind(contact.id, lead.id).run();
    await d1.USAGE.prepare('INSERT INTO project_contacts (project_id, contact_id) VALUES (?1, ?2)').bind(project.id, contact.id).run();
    const task = (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, { title: 'Call Delete Me', lead_id: lead.id })).task;
    await d1.USAGE.prepare('UPDATE tasks SET contact_id = ?1 WHERE id = ?2').bind(contact.id, task.id).run();

    const refused = await hit('DELETE', `/api/crm/contacts/${contact.id}`, headers);
    expect(refused.status).toBe(409);
    expect((await refused.json<{ error: string }>()).error).toContain('tasks 1');
    expect((await hit('GET', `/api/crm/contacts/${contact.id}`, headers)).status).toBe(200);

    await d1.USAGE.prepare('UPDATE tasks SET contact_id = NULL WHERE id = ?1').bind(task.id).run();
    const deleted = await hit('DELETE', `/api/crm/contacts/${contact.id}`, headers);
    expect(deleted.status).toBe(200);
    expect(await deleted.json<CrmContactDeleteResponse>()).toEqual({ id: contact.id, deleted: true });
    expect((await hit('GET', `/api/crm/contacts/${contact.id}`, headers)).status).toBe(404);
    expect(await d1.USAGE.prepare('SELECT contact_id FROM leads WHERE id = ?1').bind(lead.id).first('contact_id')).toBeNull();
    expect(await d1.USAGE.prepare('SELECT COUNT(*) AS n FROM project_contacts WHERE contact_id = ?1').bind(contact.id).first('n')).toBe(0);
    // Its addresses are free for another contact.
    expect((await hit('POST', '/api/crm/contacts', headers, { name: 'Again', emails: ['dm@home.example'] })).status).toBe(201);
    expect((await hit('DELETE', `/api/crm/contacts/${contact.id}`, headers)).status).toBe(404);
  });

  it('offers the characteristic names and languages its contacts carry, Core\'s languages first (meet#1214)', async () => {
    const { headers } = await member(EMAIL);
    expect(await read<CrmContactOptionsResponse>('/api/crm/contact-options', headers)).toEqual({ characteristics: [], languages: ['en', 'pt'] });
    await d1.USAGE.prepare("INSERT INTO contact_characteristics_config (id, name, created_at) VALUES ('cc-1', 'board_member', 1)").run();
    await write<CrmContactResponse>('POST', '/api/crm/contacts', headers, {
      name: 'Option One', emails: ['one@options.example'], characteristics: { speaker: true, newsletter_subscriber: false }, preferred_language: 'nl',
    });
    await write<CrmContactResponse>('POST', '/api/crm/contacts', headers, { name: 'Option Two', emails: ['two@options.example'], characteristics: { speaker: false } });
    expect(await read<CrmContactOptionsResponse>('/api/crm/contact-options', headers)).toEqual({
      characteristics: ['board_member', 'newsletter_subscriber', 'speaker'],
      languages: ['en', 'pt', 'nl'],
    });
  });

  it('opens a merged organization or contact as its survivor, and says so (meet#1216)', async () => {
    const { headers } = await member(EMAIL);
    const older = (await write<CrmOrganizationResponse>('POST', '/api/crm/organizations', headers, { name: 'Merge Keeper' })).organization;
    const newer = (await write<CrmOrganizationResponse>('POST', '/api/crm/organizations', headers, { name: 'Merge Duplicate' })).organization;
    await d1.USAGE.prepare('UPDATE organizations SET created_at = 1 WHERE id = ?1').bind(older.id).run();
    const keep = (await write<CrmContactResponse>('POST', '/api/crm/contacts', headers, { name: 'Keeper', emails: ['keeper@merge.example'] })).contact;
    const dup = (await write<CrmContactResponse>('POST', '/api/crm/contacts', headers, { name: 'Duplicate', emails: ['dup@merge.example'] })).contact;
    await d1.USAGE.prepare('UPDATE contacts SET created_at = 1 WHERE id = ?1').bind(keep.id).run();
    for (const [entity, ids] of [['organizations', [older.id, newer.id]], ['contacts', [keep.id, dup.id]]] as const) {
      expect((await hit('POST', `/api/core/merge/${entity}`, headers, { ids })).status).toBe(200);
    }

    const organization = await read<CrmSubjectDetailResponse>(`/api/crm/subjects/organization/${newer.id}`, headers);
    expect(organization.subject).toMatchObject({ id: older.id, title: 'Merge Keeper', merged_from: newer.id });
    expect((await read<CrmSubjectDetailResponse>(`/api/crm/subjects/organization/${older.id}`, headers)).subject.merged_from).toBeUndefined();
    const contact = await read<CrmContactResponse>(`/api/crm/contacts/${dup.id}`, headers);
    expect(contact.contact).toMatchObject({ id: keep.id, name: 'Keeper', merged_from: dup.id });
    // An id that was never a record is still not found.
    expect((await hit('GET', `/api/crm/contacts/${crypto.randomUUID()}`, headers)).status).toBe(404);
  });

  it('keeps one record per address, and refuses an organization or a contact the workspace does not hold', async () => {
    const { headers } = await member(EMAIL);
    const { organization } = await seedSubjects(headers);
    await write<CrmContactResponse>('POST', '/api/crm/contacts', headers, { name: 'Ada', emails: ['ada@example.test'] });
    const taken = await hit('POST', '/api/crm/contacts', headers, { name: 'Ada again', organization_id: organization.id, emails: ['ADA@example.test'] });
    expect(taken.status).toBe(409);
    expect((await taken.json<{ code: string }>()).code).toBe('contact_email_taken');
    expect((await hit('POST', '/api/crm/contacts', headers, { name: 'X', organization_id: crypto.randomUUID() })).status).toBe(400);
    expect((await hit('POST', '/api/crm/contacts', headers, { name: '', emails: [] })).status).toBe(400);
    expect((await hit('POST', '/api/crm/contacts', headers, { name: 'X', emails: ['not an address'] })).status).toBe(400);
    expect((await hit('GET', `/api/crm/contacts/${crypto.randomUUID()}`, headers)).status).toBe(404);
    expect((await hit('PATCH', `/api/crm/contacts/${crypto.randomUUID()}`, headers, { name: 'Y' })).status).toBe(404);
  });

  it('puts a contact on a project and a lead, and the page lists them with the calls they were in and who met them', async () => {
    const { headers } = await member(EMAIL);
    const { organization, lead, project } = await seedSubjects(headers);
    const { contact } = await write<CrmContactResponse>('POST', '/api/crm/contacts', headers, {
      name: 'Linus', organization_id: organization.id, emails: ['linus@northwind.example', 'l@home.example'],
    });
    await write('PATCH', `/api/crm/subjects/project/${project.id}`, headers, { contact_ids: [contact.id] });
    await write('PATCH', `/api/crm/subjects/lead/${lead.id}`, headers, { contact_id: contact.id });

    // A call with the contact's second address links it; a stranger is not filed.
    const meetingId = crypto.randomUUID();
    await postMeetingLog(d1, call(meetingId, project.id, ['L@home.example', 'stranger@elsewhere.example']));
    // A redelivery does not link it twice.
    await postMeetingLog(d1, call(meetingId, project.id, ['l@home.example']));

    const page = (await read<CrmContactResponse>(`/api/crm/contacts/${contact.id}`, headers)).contact;
    expect(page.projects).toEqual([{ id: project.id, title: 'Northwind rollout', status: 'Active' }]);
    expect(page.leads).toEqual([{ id: lead.id, title: 'Northwind pilot', status: 'Conversations' }]);
    expect(page.interactions.map((row) => row.title)).toEqual(['Scope review']);
    expect(page.interactions[0]).toMatchObject({ project_id: project.id, type: 'meeting' });
    expect(page.met_by).toEqual([{ email: EMAIL, name: 'd1store-ana', calls: 1 }]);
  });

  it('finds a contact in search and opens it through MCP', async () => {
    const { headers } = await member(EMAIL);
    const { organization, project } = await seedSubjects(headers);
    const { contact } = await write<CrmContactResponse>('POST', '/api/crm/contacts', headers, {
      name: 'Margaret Hamilton', title: 'Director', organization_id: organization.id, emails: ['margaret@northwind.example'],
    });
    await write('PATCH', `/api/crm/subjects/project/${project.id}`, headers, { contact_ids: [contact.id] });

    const found = await read<SearchResponse>('/api/search?q=hamilton', headers);
    expect(found.rows.filter((row) => row.kind === 'contact')).toEqual([{
      kind: 'contact', id: contact.id, title: 'Margaret Hamilton',
      subtitle: 'Director · Northwind Labs · margaret@northwind.example', door: `contact:${contact.id}`,
    }]);
    // By address too, every word of it.
    expect((await read<SearchResponse>('/api/search?q=margaret%40northwind.example', headers)).rows.map((row) => row.door)).toContain(`contact:${contact.id}`);

    const now = Date.now();
    await d1.USAGE.prepare(
      `INSERT OR REPLACE INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at) VALUES ('client-contacts', 'claude.ai', NULL, '["https://claude.ai/api/mcp/auth_callback"]', ?1)`,
    ).bind(now).run();
    await d1.USAGE.prepare(
      `INSERT OR REPLACE INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at)
       VALUES ('grant-contacts', 'client-contacts', ?1, ?2, 'read', 'jti-contacts', NULL, ?3, ?3, NULL, NULL)`,
    ).bind(`dev:${EMAIL}`, EMAIL, now).run();
    const token = await new SignJWT({ email: EMAIL, name: 'Ana', scope: 'read', grant: 'grant-contacts', client: 'client-contacts' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('starlings.example')
      .setAudience('meet-mcp')
      .setSubject(`dev:${EMAIL}`)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(signingKey(d1.SESSION_SIGNING_SECRET));
    try {
      const response = await invoke(new Request('http://local/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'open', arguments: { door: `contact:${contact.id}` } } }),
      }));
      const opened = await response.json<{ result?: { isError?: boolean; structuredContent: Record<string, unknown> } }>();
      expect(opened.result?.isError).toBeFalsy();
      expect(opened.result?.structuredContent).toMatchObject({
        contact: {
          id: contact.id, name: 'Margaret Hamilton', emails: ['margaret@northwind.example'],
          organization: { door: `subject:organization:${organization.id}`, name: 'Northwind Labs' },
        },
        projects: [{ door: `subject:project:${project.id}`, title: 'Northwind rollout', status: 'Active' }],
        leads: [],
      });
    } finally {
      await d1.USAGE.prepare("DELETE FROM mcp_grants WHERE id = 'grant-contacts'").run();
      await d1.USAGE.prepare("DELETE FROM mcp_clients WHERE client_id = 'client-contacts'").run();
    }
  });

  it('hides the contacts of an organization the member cannot see', async () => {
    const { headers } = await member(EMAIL);
    const colleague = await member(COLLEAGUE);
    const { organization } = await seedSubjects(headers);
    const { contact } = await write<CrmContactResponse>('POST', '/api/crm/contacts', headers, {
      name: 'Barbara Liskov', organization_id: organization.id, emails: ['barbara@northwind.example'],
    });
    expect((await read<CrmContactsResponse>('/api/crm/contacts?q=liskov', colleague.headers)).contacts.map((row) => row.id)).toEqual([contact.id]);
    await d1.USAGE.prepare(
      `INSERT OR REPLACE INTO subject_visibility (kind, subject_id, visibility, updated_by, updated_at) VALUES ('organization', ?1, 'restricted', 'test', ?2)`,
    ).bind(organization.id, Date.now()).run();
    try {
      expect((await read<CrmContactsResponse>('/api/crm/contacts?q=liskov', colleague.headers)).contacts).toEqual([]);
      expect((await hit('GET', `/api/crm/contacts/${contact.id}`, colleague.headers)).status).toBe(404);
      expect((await hit('PATCH', `/api/crm/contacts/${contact.id}`, colleague.headers, { name: 'B' })).status).toBe(404);
      expect((await read<SearchResponse>('/api/search?q=liskov', colleague.headers)).rows.filter((row) => row.kind === 'contact')).toEqual([]);
    } finally {
      await d1.USAGE.prepare('DELETE FROM subject_visibility WHERE subject_id = ?1').bind(organization.id).run();
    }
  });
});

describe('isolation', () => {
  it('never shows one workspace the rows of another', async () => {
    const one = await member(EMAIL);
    const two = await member(EMAIL, other);
    // The same person signs in to both, and gets a different id in each.
    expect(await personId(EMAIL, other)).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await personId(EMAIL, other)).not.toBe(await personId(EMAIL));

    const mine = await seedSubjects(one.headers);
    const task = (await write<{ task: CrmTask }>('POST', '/api/crm/tasks', one.headers, { title: 'Only here', project_id: mine.project.id })).task;

    expect((await read<CrmSubjectsResponse>('/api/crm/subjects?kind=project&status=all', two.headers, other)).subjects).toEqual([]);
    expect((await read<CrmOrganizationsResponse>('/api/crm/organizations?q=north', two.headers, other)).organizations).toEqual([]);
    expect((await hit('GET', `/api/crm/subjects/project/${mine.project.id}`, two.headers, undefined, other)).status).toBe(404);
    expect((await hit('GET', `/api/crm/tasks/${task.id}`, two.headers, undefined, other)).status).toBe(404);
    // A task on the other workspace's project is refused, not filed.
    expect((await hit('POST', '/api/crm/tasks', two.headers, { title: 'x', project_id: mine.project.id }, other)).status).toBe(400);

    // The same organization name on the second workspace is its own row.
    const theirs = await seedSubjects(two.headers, other);
    expect(theirs.organization.id).not.toBe(mine.organization.id);
    expect((await read<CrmSubjectsResponse>('/api/crm/subjects?kind=project', one.headers)).subjects.map((row) => row.id)).toEqual([mine.project.id]);
    expect((await read<CrmSubjectsResponse>('/api/crm/subjects?kind=project', two.headers, other)).subjects.map((row) => row.id)).toEqual([theirs.project.id]);
    expect((await read<CrmTeamResponse>('/api/crm/team', two.headers, other)).members.map((row) => row.id)).toEqual([await personId(EMAIL, other)]);
  });
});

describe('project update schema', () => {
  it('leaves contact_ids out of a PATCH that does not name them, so an edit keeps the contacts', async () => {
    const { crmProjectUpdateSchema } = await import('@starlings/contracts');
    expect(crmProjectUpdateSchema.parse({ title: 'Renamed' })).toEqual({ title: 'Renamed' });
    expect(crmProjectUpdateSchema.parse({ contact_ids: [] })).toEqual({ contact_ids: [] });
  });
});
