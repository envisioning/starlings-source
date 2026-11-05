import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';
import { calendarEventsResponseSchema } from '@starlings/contracts/calendar';
import { workspaceDescriptorSchema } from '@starlings/contracts/workspace-descriptor';
import { crmBoardResponseSchema, crmMyWorkResponseSchema, crmSubjectDetailResponseSchema, crmSubjectsResponseSchema } from '@starlings/contracts/crm';
import {
  decisionAsksResponseSchema,
  favoritesResponseSchema,
  inboxResponseSchema,
  meetingCategoryResponseSchema,
  ownerRoomResponseSchema,
  peersResponseSchema,
  searchResponseSchema,
  threadMessagesResponseSchema,
  threadsResponseSchema,
} from '@starlings/contracts';
import { purgeAllCoreCache } from '../src/core-cache';
import { resetPeerRosterCache } from '../src/peers';
import { resetRoleCache } from '../src/capabilities';
import { recordOwnerSignIn } from '../src/usage';

/*
 * Recorded responses (meet#593).
 *
 * `fixtures/responses/<name>.json` is the body the Worker answers for one read
 * the clients make, recorded here from the real route with Core and the clock
 * pinned. Three suites read the same files: this one compares the live answer
 * to the file (so a response cannot change without its fixture), the web suite
 * parses each with the route's zod schema (`web/src/response-fixtures.test.ts`),
 * and the Swift suites decode each through the generated wire type and the
 * app's own model (`Tests/ResponseFixtureTests.swift`, built into both apps).
 *
 *   node scripts/record-response-fixtures.mjs --write    re-record every file
 *   node scripts/record-response-fixtures.mjs --check    compare (what `pnpm test:api` does)
 *
 * Every case names a file and every file is claimed by a case, so a read
 * cannot be dropped from the set unseen. Rows are invented (Core's side comes
 * from `fixtures/core/`, which Core's own tests record).
 */

declare const __RECORD_RESPONSES__: boolean;

const fixtures = import.meta.glob('../../../fixtures/responses/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const fixtureNames = Object.keys(fixtures).map((file) => file.replace(/^.*\//u, '').replace(/\.json$/u, '')).sort();

const core = import.meta.glob('../../../fixtures/core/*.json', { eager: true, import: 'default' }) as Record<string, any>;
function coreFixture(name: string): any {
  const hit = core[`../../../fixtures/core/${name}.json`];
  if (hit === undefined) throw new Error(`fixtures/core/${name}.json is missing`);
  return hit;
}

/** The instant every recorded answer is read at. */
const NOW = '2026-10-01T09:00:00.000Z';
const CORE_SECRET = 'core-test-secret-with-at-least-32-characters';

const PROJECT_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const LEAD_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000004';
const people = {
  rosa: { sub: 'rf-rosa', email: 'rf-rosa@example.com', name: 'Rosa Example' },
  ada: { sub: 'rf-ada', email: 'rf-ada@example.com', name: 'Ada Example' },
};

async function signIn(person: { email: string; name: string }, mac = true): Promise<Record<string, string>> {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: person.name, email: person.email }),
  }));
  const body = await response.json<{ access_token: string }>();
  if (mac) await recordOwnerSignIn(env as Env, { sub: `dev:${person.email}`, ...person }, 'mac');
  return { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json', origin: env.WEB_ORIGIN };
}

/** Core answers each read from the file Core's own tests recorded for it. */
function stubCore(): void {
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const route = url.pathname.split('/').pop() ?? '';
    const kind = url.searchParams.get('kind');
    const status = url.searchParams.get('status');
    if (route === 'meet-crm-subjects') {
      if (url.searchParams.get('id')) return json(coreFixture(`meet-crm-subjects-${kind}-id.get`));
      // A board asks per status: answer the first open one only, so a card is dealt once.
      if (url.searchParams.has('status') && status !== 'Active' && status !== 'Proposal Out') return json({ ok: true, subjects: [], has_more: false });
      return json(coreFixture(`meet-crm-subjects-${kind}.get`));
    }
    if (url.pathname.includes('/meet-crm-tasks/')) {
      const task = coreFixture('meet-crm-tasks.get').tasks.find((row: { id: string }) => row.id === route);
      return task ? json({ ok: true, task }) : new Response('{}', { status: 404 });
    }
    if (route === 'meet-crm-tasks') return json(coreFixture('meet-crm-tasks.get'));
    if (route === 'meet-my-work') return json(coreFixture('meet-my-work.get'));
    if (route === 'meet-github-issues') return json(coreFixture(url.searchParams.has('number') ? 'meet-github-issues-detail.get' : 'meet-github-issues.get'));
    if (route === 'meet-crm-interactions') return json(coreFixture('meet-crm-interactions.get'));
    if (route === 'meet-crm-goals') return json(coreFixture('meet-crm-goals.get'));
    if (route === 'meet-crm-decisions') return json(coreFixture('meet-crm-decisions.get'));
    if (url.hostname === 'calendar.example.test') return new Response(FEED, { headers: { 'content-type': 'text/calendar' } });
    if (route === 'meet-owner-exchange') return json(coreFixture('meet-owner-exchange.post'));
    // Search asks Core's contacts by the query (meet#947); none match here.
    if (url.pathname === '/api/agent/contacts') return json({ data: [], meta: { count: 0 } });
    if (url.pathname === '/api/agent/favorites') {
      return json({ data: [
        { kind: 'crm.project', target_ref: PROJECT_ID, created_at: NOW },
        { kind: 'crm.lead', target_ref: LEAD_ID, created_at: NOW },
        { kind: 'crm.task', target_ref: TASK_ID, created_at: NOW },
        { kind: 'github.issue', target_ref: 'example-org/pilot#12', created_at: NOW },
      ] });
    }
    return new Response('{}', { status: 404 });
  });
}

/** A published feed with one event tomorrow, on a meet link. */
const FEED = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Pilot calendar',
  'BEGIN:VEVENT', 'UID:pilot-open-house', 'SUMMARY:Pilot open house', 'LOCATION:Example Hall\\, Lisbon',
  'DTSTART:20261002T150000Z', 'DTEND:20261002T160000Z', 'URL:https://envisioning.starlings.example/room/example-room', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');

/** What a case sets up before its read. `headers` is the signed-in person. */
interface Context {
  headers: Record<string, string>;
  /** Where one step leaves what a later one needs (an id the Worker minted). */
  state: Record<string, string>;
}

interface Case {
  /** The file: `fixtures/responses/<name>.json`. */
  name: string;
  /** The read, as the clients make it. */
  path: string | ((state: Record<string, string>) => string);
  /** The contract the clients decode it with. */
  schema: ZodType;
  /** Rows to seed before the read. */
  prepare?: (context: Context) => Promise<void>;
  /** Values that move with the clock or a random id, pinned so the file is stable. */
  pin?: (body: any, state: Record<string, string>) => any;
  /** Mint-time ids (random uuids) renamed in order of appearance, so the file is stable. */
  stable?: boolean;
  /** Sign in as this person (default: the first). */
  as?: keyof typeof people;
}

/**
 * Ids the Worker mints at random (uuids, `msg_…` tokens), renamed in order of
 * first appearance so the file is the same on every run. Ids Core's fixtures
 * carry (`aaaaaaaa-…`) and ids derived from their inputs (`dm_…`) are kept.
 */
function renameIds<T>(body: T): T {
  const seen = new Map<string, string>();
  const name = (id: string, make: (n: number) => string) => {
    let hit = seen.get(id);
    if (!hit) {
      hit = make(seen.size + 1);
      seen.set(id, hit);
    }
    return hit;
  };
  const text = JSON.stringify(body)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, (id) => (id.startsWith('aaaaaaaa-') ? id : name(id, (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`)))
    .replace(/msg_[A-Za-z0-9_-]{16}/gu, (id) => name(id, (n) => `msg_${String(n).padStart(16, '0')}`));
  return JSON.parse(text) as T;
}

/** The thread's two messages are sent once per run: the thread's own storage outlives a test. */
let threadSeeded = false;

/** A person-to-person thread with two messages a minute apart. */
async function directThread({ headers, state }: Context): Promise<void> {
  const ada = await signIn(people.ada);
  const post = async (as: Record<string, string>, path: string, body: unknown) => {
    const response = await exports.default.fetch(new Request(`http://local${path}`, { method: 'POST', headers: as, body: JSON.stringify(body) }));
    expect(response.status).toBeLessThan(300);
    return response.json<any>();
  };
  const opened = await post(headers, '/api/threads', { peer_email: people.ada.email });
  state.thread = opened.thread.id;
  if (threadSeeded) return;
  threadSeeded = true;
  await post(headers, `/api/threads/${state.thread}/messages`, { text: 'Did the pilot scope go out?' });
  vi.setSystemTime(new Date(Date.parse(NOW) + 60_000));
  await post(ada, `/api/threads/${state.thread}/messages`, { text: 'Yes, this morning.' });
  vi.setSystemTime(new Date(NOW));
}

/** A finished ambient meeting filed on the pilot project. */
async function filedMeeting({ headers, state }: Context): Promise<void> {
  await exports.default.fetch(new Request('http://local/api/owner/room', { headers }));
  const created = await exports.default.fetch(new Request('http://local/api/rooms/example-room/meetings/ambient', {
    method: 'POST',
    headers,
    body: JSON.stringify({ started_at: '2026-09-30T09:00:00.000Z', ended_at: '2026-09-30T09:30:00.000Z', title: 'Pilot check-in', attendees: [{ name: 'Cleo Example', email: 'cleo@client.test' }] }),
  }));
  expect(created.status).toBeLessThan(300);
  state.meeting = (await created.json<{ meeting_id: string }>()).meeting_id;
  await env.ROOMS.getByName('example-room').setMeetingCategory(`dev:${people.rosa.email}`, state.meeting, {
    meetingKind: 'project', leadId: null, projectId: PROJECT_ID, partnerOrganizationId: null, subjectTitle: 'Pilot programme', categorizedBy: people.rosa.email,
  });
}

/** One open decision waiting on the signed-in person, about the pilot project. */
async function openDecision({ headers }: Context): Promise<void> {
  const response = await exports.default.fetch(new Request('http://local/api/decision-asks', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      question: 'Ship the pilot scope this week?',
      context: 'The scope is two pages.',
      options: [{ key: 'ship', label: 'Ship it' }, { key: 'wait', label: 'Wait for Cleo' }],
      recommendation: 'ship',
      default_by: '2026-10-07',
      subject: { kind: 'project', id: PROJECT_ID, title: 'Pilot programme' },
      links: [{ url: 'https://pilot.example.test/scope', title: 'Scope' }],
    }),
  }));
  expect(response.status).toBe(201);
}

/** One subscribed feed. The feed's id is minted at random, so the body is told its name. */
async function subscribedFeed({ headers, state }: Context): Promise<void> {
  stubCore();
  const response = await exports.default.fetch(new Request('http://local/api/calendar/subscriptions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: 'https://calendar.example.test/pilot.ics' }),
  }));
  expect(response.status).toBe(200);
  state.feed = (await response.json<{ subscription: { id: string } }>()).subscription.id;
}

const cases: Case[] = [
  {
    name: 'owner-room',
    path: '/api/owner/room',
    schema: ownerRoomResponseSchema,
    as: 'rosa',
  },
  { name: 'crm-subjects', path: '/api/crm/subjects?kind=project&q=', schema: crmSubjectsResponseSchema },
  { name: 'crm-subject-project', path: `/api/crm/subjects/project/${PROJECT_ID}`, schema: crmSubjectDetailResponseSchema },
  { name: 'crm-mine', path: '/api/crm/mine', schema: crmMyWorkResponseSchema },
  { name: 'crm-board', path: '/api/crm/board', schema: crmBoardResponseSchema },
  { name: 'threads', path: '/api/threads', schema: threadsResponseSchema, prepare: directThread, stable: true },
  { name: 'thread-messages', path: (state) => `/api/threads/${state.thread}/messages`, schema: threadMessagesResponseSchema, prepare: directThread, stable: true },
  {
    name: 'peers',
    path: '/api/peers',
    schema: peersResponseSchema,
    prepare: async () => { await signIn(people.ada); },
    // The agent's drawn face is 6 KB of path data; the clients decode it as a string.
    pin: (body) => {
      for (const peer of body.peers) if (peer.agent_avatar) peer.agent_avatar = { ...peer.agent_avatar, body_path: 'M0 0Z', eyes_path: 'M0 0Z' };
    },
  },
  {
    name: 'calendar-upcoming',
    path: '/api/calendar/upcoming',
    schema: calendarEventsResponseSchema,
    prepare: subscribedFeed,
    pin: (body, state) => JSON.parse(JSON.stringify(body).replaceAll(state.feed!, 'example-feed')),
  },
  { name: 'crm-inbox', path: '/api/crm/inbox', schema: inboxResponseSchema, prepare: openDecision, stable: true },
  { name: 'search', path: '/api/search?q=pilot', schema: searchResponseSchema, prepare: directThread, stable: true },
  { name: 'favorites', path: '/api/crm/favorites', schema: favoritesResponseSchema },
  { name: 'crm-starred', path: '/api/crm/starred', schema: searchResponseSchema },
  { name: 'decision-asks', path: '/api/decision-asks', schema: decisionAsksResponseSchema, prepare: openDecision, stable: true },
  {
    name: 'meeting-category',
    path: (state) => `/api/rooms/example-room/meetings/${state.meeting}/category`,
    schema: meetingCategoryResponseSchema,
    prepare: filedMeeting,
  },
  // What a client reads first, before anyone signs in (meet#717).
  { name: 'workspace-descriptor', path: '/.well-known/meet', schema: workspaceDescriptorSchema },
];

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  (env as Env).INTERNAL_REQUEST_SECRET = CORE_SECRET;
  // An invented person owns the invented room, so no real address is recorded.
  (env as { OWNER_ROOM_MAP: string }).OWNER_ROOM_MAP = JSON.stringify({ [people.rosa.email]: 'example-room' });
  await purgeAllCoreCache();
  resetPeerRosterCache();
  resetRoleCache();
});

const configured = { ownerRooms: env.OWNER_ROOM_MAP as string, coreSecret: (env as Env).INTERNAL_REQUEST_SECRET ?? '' };

afterEach(async () => {
  (env as { OWNER_ROOM_MAP: string }).OWNER_ROOM_MAP = configured.ownerRooms;
  (env as Env).INTERNAL_REQUEST_SECRET = configured.coreSecret;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await purgeAllCoreCache();
  await env.USAGE.prepare("DELETE FROM attention_requests WHERE recipient_email LIKE 'rf-%'").run();
  await env.USAGE.prepare("DELETE FROM decision_asks WHERE waits_on_email LIKE 'rf-%'").run();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'rf-%'").run();
});

describe('recorded responses', () => {
  it.skipIf(__RECORD_RESPONSES__)('has a case for every file and a file for every case', () => {
    expect(cases.map((c) => c.name).sort()).toEqual(fixtureNames);
  });

  for (const c of cases) {
    it(`${c.name}: ${c.path}`, async () => {
      stubCore();
      const headers = await signIn(people[c.as ?? 'rosa'], true);
      const state: Record<string, string> = {};
      await c.prepare?.({ headers, state });
      const path = typeof c.path === 'function' ? c.path(state) : c.path;
      const response = await exports.default.fetch(new Request(`http://local${path}`, { headers }));
      expect(response.status).toBe(200);
      let body = await response.json<any>();
      if (c.stable) body = renameIds(body);
      body = c.pin?.(body, state) ?? body;
      // A body the contract refuses is never recorded: the clients decode it with that contract.
      const parsed = c.schema.safeParse(body);
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2)).toBe(true);
      await expect(`${JSON.stringify(body, null, 2)}\n`).toMatchFileSnapshot(`../../../fixtures/responses/${c.name}.json`);
    });
  }
});
