import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HOME_LAYOUT,
  HOME_MODULE_WORK_MODULES,
  HOME_MODULES,
  homeModuleDraws,
  homeModuleRows,
  mergeHomeRecentRows,
  orderHomeInbox,
  homeColumnsLopsided,
  packHomeColumns,
  moveHomeModule,
  offeredHomeModules,
  resolveHomeLayout,
  visibleHomeModules,
  type HomeModuleID,
  type HomeModuleSetting,
  type HomePreferencesResponse,
} from '@starlings/contracts/home-layout';
import type { SearchRow } from '@starlings/contracts/search';
import type { WorkModule } from '@starlings/contracts/work-modules';
import { resetRoleCache } from '../src/capabilities';
import { resetPeerRosterCache } from '../src/peers';
import fixture from '../../../fixtures/home-layout.json';

/**
 * The shared table, run against the TypeScript implementation. The Swift port
 * runs the same file (Tests/HomeLayoutFixtureTests.swift), which is the whole
 * point: three surfaces drawing Home in three orders is the drift this table
 * exists to prevent.
 *
 * A failure here is a question about `fixtures/home-layout.json` first — the
 * rules live there, and both implementations answer to it.
 */

interface FixtureCase {
  name: string;
  stored: Array<{ id: string; enabled: boolean }> | null;
  expect: HomeModuleSetting[];
}

const cases = fixture.cases as FixtureCase[];
interface FixtureSearchKey { kind: string; id: string }
interface FixtureInboxOrderCase {
  name: string;
  rows: { id: string; pinned: boolean; at: number }[];
  expect: string[];
}
interface FixtureRecentMergeCase {
  name: string;
  starred: FixtureSearchKey[];
  recent: FixtureSearchKey[];
  expect: FixtureSearchKey[];
}
interface FixturePackCase {
  name: string;
  gap: number;
  modules: HomeModuleID[];
  heights: Partial<Record<HomeModuleID, number>>;
  expectRight: HomeModuleID[];
}
interface FixtureLopsidedCase {
  name: string;
  gap: number;
  heights: Partial<Record<HomeModuleID, number>>;
  left: HomeModuleID[];
  right: HomeModuleID[];
  expect: boolean;
}
const packCases = fixture.packCases as FixturePackCase[];
const lopsidedCases = fixture.lopsidedCases as FixtureLopsidedCase[];
const recentMergeCases = fixture.recentMergeCases as FixtureRecentMergeCase[];
const inboxOrderCases = fixture.inboxOrderCases as FixtureInboxOrderCase[];

function fixtureRows(keys: FixtureSearchKey[]): SearchRow[] {
  return keys.map(({ kind, id }) => ({ kind, id, title: id, subtitle: '', door: `${kind}:${id}` }) as SearchRow);
}

describe('home-layout fixture', () => {
  it('is the version this implementation was written against', () => {
    expect(fixture.version).toBe(1);
    expect(cases.length).toBeGreaterThan(0);
  });

  it('hides a module whose work modules are all off (meet#990)', () => {
    expect(fixture.workModules).toEqual(HOME_MODULE_WORK_MODULES);
    for (const testCase of fixture.visibleCases) {
      const modules = testCase.workModules === null ? undefined : (testCase.workModules as WorkModule[]);
      expect(visibleHomeModules(DEFAULT_HOME_LAYOUT, modules), testCase.name).toEqual(testCase.expect);
    }
  });

  for (const testCase of fixture.offeredCases) {
    it(`offers Home settings: ${testCase.name}`, () => {
      const modules = testCase.workModules === null ? undefined : testCase.workModules as WorkModule[];
      expect(offeredHomeModules(resolveHomeLayout(testCase.stored), modules).map((row) => row.id)).toEqual(testCase.expect);
    });
  }

  for (const testCase of fixture.moveCases) {
    it(`moves offered Home settings: ${testCase.name}`, () => {
      const modules = testCase.workModules === null ? undefined : testCase.workModules as WorkModule[];
      const layout = resolveHomeLayout(testCase.layout);
      const next = moveHomeModule(layout, testCase.id as HomeModuleID, testCase.direction as 'up' | 'down', modules);
      expect(next.map((row) => row.id)).toEqual(testCase.expect);
      for (const row of next) expect(row.enabled).toBe(layout.find((before) => before.id === row.id)?.enabled);
    });
  }

  it('draws an empty module only when the table says it shows empty (meet#1033)', () => {
    for (const testCase of fixture.showCases) {
      const content = new Set(testCase.content);
      const drawn = visibleHomeModules(DEFAULT_HOME_LAYOUT).filter((id) => homeModuleDraws(id, content.has(id)));
      expect(drawn, testCase.name).toEqual(testCase.expect);
    }
  });

  it('declares the same modules, in the same order, as the code', () => {
    expect(fixture.modules).toEqual(HOME_MODULES);
    expect(homeModuleRows('work')).toBe(5);
    expect(() => homeModuleRows('notes')).toThrow();
    expect(DEFAULT_HOME_LAYOUT).toEqual(HOME_MODULES.map((m) => ({ id: m.id, enabled: m.enabledByDefault })));
  });

  for (const testCase of packCases) {
    it(`packs columns: ${testCase.name}`, () => {
      const packed = packHomeColumns(testCase.modules, testCase.heights, testCase.gap);
      expect(testCase.modules.filter((id) => packed[id])).toEqual(testCase.expectRight);
      expect(homeColumnsLopsided(testCase.modules, testCase.heights, packed, testCase.gap)).toBe(false);
    });
  }

  for (const testCase of lopsidedCases) {
    it(`lopsided columns: ${testCase.name}`, () => {
      const assignment: Partial<Record<HomeModuleID, boolean>> = {};
      for (const id of testCase.left) assignment[id] = false;
      for (const id of testCase.right) assignment[id] = true;
      const modules = Object.keys(testCase.heights) as HomeModuleID[];
      expect(homeColumnsLopsided(modules, testCase.heights, assignment, testCase.gap)).toBe(testCase.expect);
    });
  }

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(resolveHomeLayout(testCase.stored)).toEqual(testCase.expect);
    });
  }

  for (const testCase of recentMergeCases) {
    it(testCase.name, () => {
      const rows = mergeHomeRecentRows(fixtureRows(testCase.recent), fixtureRows(testCase.starred));
      expect(rows.map(({ kind, id }) => `${kind}:${id}`)).toEqual(testCase.expect.map(({ kind, id }) => `${kind}:${id}`));
    });
  }

  for (const testCase of inboxOrderCases) {
    it(`orders the Inbox card: ${testCase.name}`, () => {
      const rows = orderHomeInbox(testCase.rows, (row) => row.pinned, (row) => row.at);
      expect(rows.map((row) => row.id)).toEqual(testCase.expect);
    });
  }

  it('resolving a resolved list changes nothing', () => {
    for (const testCase of cases) {
      expect(resolveHomeLayout(testCase.expect), testCase.name).toEqual(testCase.expect);
    }
  });

  it('draws the enabled modules in order, and moves one a place at a time', () => {
    const layout = resolveHomeLayout([{ id: 'agenda', enabled: true }, { id: 'notes', enabled: false }]);
    expect(visibleHomeModules(layout)).toEqual(['messages', 'work', 'commercial', 'agenda', 'events', 'room', 'recent']);
    expect(layout.map((r) => r.id)).toEqual(['messages', 'work', 'commercial', 'agenda', 'events', 'room', 'notes', 'recent']);
    expect(moveHomeModule(layout, 'agenda', 'up').map((r) => r.id)).toEqual(['messages', 'work', 'agenda', 'commercial', 'events', 'room', 'notes', 'recent']);
    expect(moveHomeModule(layout, 'messages', 'up').map((r) => r.id)).toEqual(layout.map((r) => r.id));
    expect(moveHomeModule(layout, 'notes', 'down').map((r) => r.id)).toEqual(layout.map((r) => r.id));
    expect(moveHomeModule(layout, 'recent', 'up').map((r) => r.id)).toEqual(layout.map((r) => r.id));
  });
});

const rosa = { email: 'homelayout-rosa@example.com', name: 'Rosa' };

async function session() {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rosa),
  }));
  const body = await response.json<{ access_token: string }>();
  const headers = { authorization: `Bearer ${body.access_token}` };
  await exports.default.fetch(new Request('http://local/api/peers', { headers }));
  return headers;
}

async function hit(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return exports.default.fetch(new Request(`http://local${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  }));
}

afterEach(async () => {
  await env.USAGE.prepare("DELETE FROM home_preferences WHERE sub IN (SELECT sub FROM people WHERE email LIKE 'homelayout-%')").run();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'homelayout-%'").run();
  resetRoleCache();
  resetPeerRosterCache();
});

describe('/api/home/preferences', () => {
  it('needs a session', async () => {
    const response = await hit('GET', '/api/home/preferences', {});
    expect(response.status).toBe(401);
  });

  it('starts as the default, unsaved', async () => {
    const headers = await session();
    const response = await hit('GET', '/api/home/preferences', headers);
    expect(response.status).toBe(200);
    const body = await response.json<HomePreferencesResponse>();
    expect(body.modules).toEqual(DEFAULT_HOME_LAYOUT);
    expect(body.updated_at).toBeNull();
  });

  it('stores the list resolved, and reads it back the same on every device', async () => {
    const headers = await session();
    const response = await hit('PUT', '/api/home/preferences', headers, {
      modules: [
        { id: 'agenda', enabled: true },
        { id: 'weather', enabled: true },
        { id: 'room', enabled: false },
        { id: 'notes', enabled: false },
      ],
    });
    expect(response.status).toBe(200);
    const saved = await response.json<HomePreferencesResponse>();
    expect(saved.modules).toEqual([
      { id: 'messages', enabled: true },
      { id: 'work', enabled: true },
      { id: 'commercial', enabled: true },
      { id: 'agenda', enabled: true },
      { id: 'events', enabled: true },
      { id: 'room', enabled: true },
      { id: 'notes', enabled: false },
      { id: 'recent', enabled: true },
    ]);
    expect(saved.updated_at).toBeTypeOf('number');

    const read = await (await hit('GET', '/api/home/preferences', headers)).json<HomePreferencesResponse>();
    expect(read).toEqual(saved);
  });

  it('refuses a body that is not a module list', async () => {
    const headers = await session();
    const response = await hit('PUT', '/api/home/preferences', headers, { modules: [{ id: 'agenda' }] });
    expect(response.status).toBe(400);
  });
});
