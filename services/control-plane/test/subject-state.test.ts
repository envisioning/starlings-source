import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveSubjectState,
  resolveWorkList,
  sortByWorkList,
  subjectGroup,
  type SubjectGroup,
  type SubjectGroupShape,
  type SubjectStateOverride,
  type SubjectStateResponse,
  type SubjectStateUpdateResponse,
  type WorkListPreferences,
  type WorkListRowShape,
  type WorkListSort,
} from '@starlings/contracts/subject-state';
import { resetRoleCache } from '../src/capabilities';
import { resetPeerRosterCache } from '../src/peers';
import fixture from '../../../fixtures/subject-state.json';

// Per-user subject state (meet#147 decision 5, slice 2; follow removed
// 2026-09-15). Two halves: the shared rule — grouping, resolution — run
// against fixtures/subject-state.json, which the Swift port reads too; and
// the Worker's storage of overrides behind /api/crm/subject-state.

interface GroupCase { name: string; subject: SubjectGroupShape; expect: SubjectGroup }
interface WorkListCase { name: string; stored: unknown; expect: WorkListPreferences }
interface ResolveCase {
  name: string;
  sales_enabled: boolean;
  hidden_kinds?: SubjectGroupShape['kind'][];
  subject: SubjectGroupShape;
  override: SubjectStateOverride | null;
  expect: { listed: boolean; starred: boolean; muted: boolean };
}

describe('subject-state fixture', () => {
  it('groups', () => {
    for (const c of fixture.groups as GroupCase[]) {
      expect(subjectGroup(c.subject), c.name).toBe(c.expect);
    }
  });

  it('resolves an override', () => {
    for (const c of fixture.resolve as ResolveCase[]) {
      expect(resolveSubjectState(c.subject, { sales_enabled: c.sales_enabled, hidden_kinds: c.hidden_kinds }, c.override), c.name).toEqual(c.expect);
    }
  });

  it('resolves the stored work list', () => {
    for (const c of fixture.work_list as WorkListCase[]) {
      expect(resolveWorkList(c.stored), c.name).toEqual(c.expect);
    }
  });
});

const rosa = { email: 'substate-rosa@example.com', name: 'Rosa' };
const project = 'c0ffee00-0000-4000-8000-000000000001';
const lead = 'c0ffee00-0000-4000-8000-000000000002';

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
  await env.USAGE.prepare("DELETE FROM favorite_sync_queue WHERE sub IN (SELECT sub FROM people WHERE email LIKE 'substate-%')").run();
  await env.USAGE.prepare("DELETE FROM subject_state WHERE sub IN (SELECT sub FROM people WHERE email LIKE 'substate-%')").run();
  await env.USAGE.prepare("DELETE FROM work_preferences WHERE sub IN (SELECT sub FROM people WHERE email LIKE 'substate-%')").run();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'substate-%'").run();
  resetRoleCache();
  resetPeerRosterCache();
});

describe('/api/crm/subject-state', () => {
  it('starts with no overrides and Sales off', async () => {
    const headers = await session();
    const response = await hit('GET', '/api/crm/subject-state', headers);
    expect(response.status).toBe(200);
    const body = await response.json<SubjectStateResponse>();
    expect(body.role).toBe('member');
    expect(body.sales_enabled).toBe(false);
    expect(body.inbox_available_sources).not.toContain('interest');
    expect(body.states).toEqual([]);
  });

  it('stores an override, only the keys sent move, and a row saying nothing is deleted', async () => {
    const headers = await session();
    let response = await hit('PUT', `/api/crm/subject-state/project/${project}`, headers, { muted: true });
    expect(response.status).toBe(200);
    let body = await response.json<SubjectStateUpdateResponse>();
    expect(body.state).toMatchObject({ kind: 'project', id: project, starred: false, muted: true });

    // Star without touching mute.
    response = await hit('PUT', `/api/crm/subject-state/project/${project}`, headers, { starred: true });
    body = await response.json<SubjectStateUpdateResponse>();
    expect(body.state).toMatchObject({ starred: true, muted: true });

    // Unmute; the star keeps the row alive.
    response = await hit('PUT', `/api/crm/subject-state/project/${project}`, headers, { muted: false });
    body = await response.json<SubjectStateUpdateResponse>();
    expect(body.state).toMatchObject({ starred: true, muted: false });

    // Unstar: nothing left to say, so the row goes.
    response = await hit('PUT', `/api/crm/subject-state/project/${project}`, headers, { starred: false });
    body = await response.json<SubjectStateUpdateResponse>();
    expect(body.state).toBeNull();
    const read = await (await hit('GET', '/api/crm/subject-state', headers)).json<SubjectStateResponse>();
    expect(read.states).toEqual([]);

    const owner = await env.USAGE.prepare('SELECT sub FROM people WHERE email = ?1').bind(rosa.email).first<{ sub: string }>();
    const queued = await env.USAGE.prepare(
      `SELECT kind, target_ref, starred FROM favorite_sync_queue
       WHERE sub = ?1 AND target_ref = ?2 ORDER BY id`,
    ).bind(owner!.sub, project).all<{ kind: string; target_ref: string; starred: number }>();
    // The unstar replaces the queued star: only the latest change goes to Core.
    expect(queued.results).toEqual([
      { kind: 'crm.project', target_ref: project, starred: 0 },
    ]);
  });

  it('lists every override for the reader, newest first', async () => {
    const headers = await session();
    await hit('PUT', `/api/crm/subject-state/project/${project}`, headers, { muted: true });
    await hit('PUT', `/api/crm/subject-state/lead/${lead}`, headers, { starred: true });
    const read = await (await hit('GET', '/api/crm/subject-state', headers)).json<SubjectStateResponse>();
    expect(read.states.map((row) => [row.kind, row.id, row.starred, row.muted])).toEqual([
      ['lead', lead, true, false],
      ['project', project, false, true],
    ]);
  });

  it('the SALES opt-in is stored per person', async () => {
    const headers = await session();
    const response = await hit('PATCH', '/api/crm/subject-state', headers, { sales_enabled: true });
    expect(response.status).toBe(200);
    const body = await response.json<SubjectStateResponse>();
    expect(body.sales_enabled).toBe(true);
    const off = await (await hit('PATCH', '/api/crm/subject-state', headers, { sales_enabled: false })).json<SubjectStateResponse>();
    expect(off.sales_enabled).toBe(false);
  });

  it('hides kinds per person, leads through the Sales switch both ways (meet#975)', async () => {
    const headers = await session();
    const fresh = await (await hit('GET', '/api/crm/subject-state', headers)).json<SubjectStateResponse>();
    // Nobody's view moves: no row is Sales off, so leads hidden, as before.
    expect(fresh.hidden_kinds).toEqual(['lead']);
    const hidden = await (await hit('PATCH', '/api/crm/subject-state', headers, { hidden_kinds: ['project', 'event'] })).json<SubjectStateResponse>();
    expect(hidden.hidden_kinds).toEqual(['project', 'event']);
    expect(hidden.sales_enabled).toBe(true);
    // An older app's Sales switch moves leads only.
    const salesOff = await (await hit('PATCH', '/api/crm/subject-state', headers, { sales_enabled: false })).json<SubjectStateResponse>();
    expect(salesOff.hidden_kinds).toEqual(['lead', 'project', 'event']);
  });

  it('an installed client that still sends a retired INBOX source keeps its other switches', async () => {
    const headers = await session();
    const response = await hit('PATCH', '/api/crm/subject-state', headers, { inbox_sources: { talk: false, assigned: true, overdue: true } });
    expect(response.status).toBe(200);
    const body = await response.json<SubjectStateResponse>();
    expect(body.inbox_sources.talk).toBe(false);
    expect(body.inbox_sources).not.toHaveProperty('assigned');
    expect(body.inbox_sources).not.toHaveProperty('overdue');
  });

  it('the work list is stored per person and only the keys sent move', async () => {
    const headers = await session();
    const fresh = await (await hit('GET', '/api/crm/subject-state', headers)).json<SubjectStateResponse>();
    expect(fresh.work_list).toEqual({ sort: 'activity', group: 'none', starred_only: false });
    expect(fresh.inbox_sources).not.toHaveProperty('overdue');
    expect(fresh.inbox_sources).not.toHaveProperty('assigned');

    const list: WorkListPreferences = { sort: 'alphabetical', group: 'relationship', starred_only: true };
    const response = await hit('PATCH', '/api/crm/subject-state', headers, { work_list: list });
    expect(response.status).toBe(200);
    expect((await response.json<SubjectStateResponse>()).work_list).toEqual(list);

    // Sales on from another device leaves the list alone, and back.
    const sales = await (await hit('PATCH', '/api/crm/subject-state', headers, { sales_enabled: true })).json<SubjectStateResponse>();
    expect(sales.sales_enabled).toBe(true);
    expect(sales.work_list).toEqual(list);
    const again = await (await hit('PATCH', '/api/crm/subject-state', headers, { work_list: { ...list, starred_only: false } })).json<SubjectStateResponse>();
    expect(again.sales_enabled).toBe(true);
    expect(again.work_list.starred_only).toBe(false);

    expect((await hit('PATCH', '/api/crm/subject-state', headers, {})).status).toBe(400);
    expect((await hit('PATCH', '/api/crm/subject-state', headers, { work_list: { sort: 'newest', group: 'none', starred_only: false } })).status).toBe(400);
  });

  it('refuses an unknown kind, a malformed id and an unknown key', async () => {
    const headers = await session();
    expect((await hit('PUT', `/api/crm/subject-state/task/${project}`, headers, { starred: true })).status).toBe(404);
    expect((await hit('PUT', '/api/crm/subject-state/project/not-a-uuid', headers, { starred: true })).status).toBe(404);
    expect((await hit('PUT', `/api/crm/subject-state/project/${project}`, headers, { pinned: true })).status).toBe(400);
    expect((await hit('PUT', `/api/crm/subject-state/project/${project}`, headers, { followed: true })).status).toBe(400);
  });
});

interface OrderCase {
  name: string;
  now: string;
  sort: WorkListSort;
  rows: WorkListRowShape[];
  expect: string[];
}

describe('subject-state fixture: work_list_order', () => {
  for (const c of fixture.work_list_order as OrderCase[]) {
    it(c.name, () => {
      expect(sortByWorkList(c.rows, c.sort, Date.parse(c.now)).map((row) => row.id)).toEqual(c.expect);
    });
  }
});
