import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SEARCH_DESTINATIONS,
  SEARCH_DOOR_KINDS,
  SEARCH_HIT_KINDS,
  SEARCH_KINDS,
  SEARCH_PERSON_VERBS,
  SEARCH_SCOPES,
  SEARCH_SETTINGS_PAGES,
  SEARCH_VERBS,
  parseSearchDoor,
  rememberSearchRecent,
  search,
  searchDoorString,
  searchPersonVerbs,
  searchRowKey,
  searchRowSchema,
  type SearchDoor,
  type SearchKind,
  type SearchResponse,
  type SearchRow,
  SEARCH_SUBJECT_KINDS,
  SEARCH_SUBJECT_VERBS,
  searchRowVerbs,
  searchSubjectVerbs,
} from '@starlings/contracts/search';
import { resetRoleCache } from '../src/capabilities';
import { purgeAllCoreCache } from '../src/core-cache';
import { resetPeerRosterCache } from '../src/peers';
import fixture from '../../../fixtures/search-rows.json';

/**
 * The shared table, run against the TypeScript implementation. The Swift port
 * runs the same file (Tests/SearchFixtureTests.swift), which is the whole
 * point: five search fields on three surfaces matching on five rules is the
 * drift this table exists to prevent.
 *
 * A failure here is a question about `fixtures/search-rows.json` first — the
 * rules live there, and both implementations answer to it.
 */

interface FixtureCase {
  name: string;
  query: string;
  scope: keyof typeof SEARCH_SCOPES;
  order: 'list' | 'rank';
  recents: string[];
  expect: string[];
}

const rows = fixture.rows as SearchRow[];
const cases = fixture.cases as FixtureCase[];

describe('search-rows fixture', () => {
  it('is the version this implementation was written against', () => {
    expect(fixture.version).toBe(1);
    expect(cases.length).toBeGreaterThan(0);
  });

  it('declares the same kinds, doors and scopes as the code', () => {
    expect(fixture.kinds).toEqual(SEARCH_KINDS);
    expect(fixture.hitKinds).toEqual(SEARCH_HIT_KINDS);
    expect(fixture.doorKinds).toEqual(SEARCH_DOOR_KINDS);
    expect(fixture.destinations).toEqual(SEARCH_DESTINATIONS);
    expect(fixture.settingsPages).toEqual(SEARCH_SETTINGS_PAGES);
    expect(fixture.verbs).toEqual(SEARCH_VERBS);
    expect(fixture.personVerbs.person).toEqual(SEARCH_PERSON_VERBS);
    expect(fixture.scopes).toEqual(SEARCH_SCOPES);
    for (const kind of SEARCH_KINDS) {
      const expected = (fixture.personVerbs as Record<string, string[]>)[kind] ?? [];
      expect(searchPersonVerbs(kind as SearchKind), kind).toEqual(expected);
    }
    expect(fixture.subjectVerbs.project).toEqual(SEARCH_SUBJECT_VERBS);
    for (const subjectKind of SEARCH_SUBJECT_KINDS) {
      expect(searchSubjectVerbs(subjectKind), subjectKind).toEqual((fixture.subjectVerbs as Record<string, string[]>)[subjectKind]);
    }
    // A row's verbs follow its door: a subject row by the kind in it, a person row by its kind.
    expect(searchRowVerbs({ kind: 'subject', door: 'subject:lead:globex-2026' })).toEqual(SEARCH_SUBJECT_VERBS);
    expect(searchRowVerbs({ kind: 'subject', door: 'subject:partner:acme' })).toEqual(['new-task']);
    expect(searchRowVerbs({ kind: 'person', door: 'person:nadia@example.com' })).toEqual(SEARCH_PERSON_VERBS);
    expect(searchRowVerbs({ kind: 'document', door: 'document:doc_42' })).toEqual([]);
  });

  it('every row in the corpus is a row on the wire', () => {
    for (const row of rows) {
      expect(searchRowSchema.safeParse(row).success, searchRowKey(row)).toBe(true);
    }
    expect(new Set(rows.map(searchRowKey)).size).toBe(rows.length);
  });

  it('reads and writes every door in the table, and refuses every bad one', () => {
    for (const entry of fixture.doors as Array<{ door: string; parsed: SearchDoor }>) {
      expect(parseSearchDoor(entry.door), entry.door).toEqual(entry.parsed);
      expect(searchDoorString(entry.parsed), entry.door).toBe(entry.door);
    }
    for (const bad of fixture.badDoors as string[]) {
      expect(parseSearchDoor(bad), JSON.stringify(bad)).toBeNull();
      expect(searchRowSchema.safeParse({ kind: 'verb', id: 'x', title: 'x', subtitle: '', door: bad }).success).toBe(false);
    }
  });

  for (const testCase of cases) {
    it(testCase.name, () => {
      const found = search(rows, testCase.query, {
        scope: SEARCH_SCOPES[testCase.scope],
        order: testCase.order,
        recents: testCase.recents,
      });
      expect(found.map(searchRowKey)).toEqual(testCase.expect);
    });
  }

  it('a recent is remembered once, newest first, and a door is never a recent', () => {
    const nadia = rows.find((row) => row.id === 'nadia@example.com')!;
    const doc = rows.find((row) => row.id === 'doc_42')!;
    const door = rows.find((row) => row.kind === 'destination')!;
    let recents = rememberSearchRecent([], doc);
    recents = rememberSearchRecent(recents, nadia);
    recents = rememberSearchRecent(recents, doc);
    recents = rememberSearchRecent(recents, door);
    expect(recents).toEqual(['document:doc_42', 'person:nadia@example.com']);
    expect(rememberSearchRecent(['a:1', 'b:2'], doc, 2)).toEqual(['document:doc_42', 'a:1']);
  });
});

async function session(person: { email: string; name: string }) {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(person),
  }));
  const body = await response.json<{ access_token: string }>();
  const headers = { authorization: `Bearer ${body.access_token}` };
  await exports.default.fetch(new Request('http://local/api/peers', { headers }));
  return headers;
}

async function hit(path: string, headers: Record<string, string>) {
  return exports.default.fetch(new Request(`http://local${path}`, { headers }));
}

afterEach(async () => {
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'searchroute-%'").run();
  // An earlier case's subject list would otherwise answer for a Core the
  // next case has taken down (core-cache.ts).
  await purgeAllCoreCache();
  resetRoleCache();
  resetPeerRosterCache();
});

describe('/api/search', () => {
  it('needs a session', async () => {
    const response = await hit('/api/search?q=x', {});
    expect(response.status).toBe(401);
  });

  it('answers an empty query empty, without the fan-out', async () => {
    const headers = await session({ email: 'searchroute-rosa@example.com', name: 'Rosa' });
    const response = await hit('/api/search?q=%20', headers);
    expect(response.status).toBe(200);
    expect(await response.json<SearchResponse>()).toEqual({ rows: [], partial: [] });
  });

  it('finds a colleague by name, as a person row with a person door, and never the caller', async () => {
    await session({ email: 'searchroute-zelda@example.com', name: 'Zelda Quintessence' });
    const headers = await session({ email: 'searchroute-rosa@example.com', name: 'Rosa' });
    const response = await hit('/api/search?q=quintess&tz=Europe%2FLisbon', headers);
    expect(response.status).toBe(200);
    const body = await response.json<SearchResponse>();
    for (const row of body.rows) expect(searchRowSchema.safeParse(row).success, row.door).toBe(true);
    const zelda = body.rows.find((row) => row.id === 'searchroute-zelda@example.com');
    expect(zelda).toEqual({
      kind: 'person',
      id: 'searchroute-zelda@example.com',
      title: 'Zelda Quintessence',
      subtitle: 'searchroute-zelda@example.com',
      door: 'person:searchroute-zelda@example.com',
    });
    const me = await hit('/api/search?q=rosa', headers);
    expect((await me.json<SearchResponse>()).rows.find((row) => row.id === 'searchroute-rosa@example.com')).toBeUndefined();
  });

  it('names a source that did not answer instead of waiting for it or hiding it (meet#191)', async () => {
    const headers = await session({ email: 'searchroute-rosa@example.com', name: 'Rosa' });
    const configured = (env as Env).INTERNAL_REQUEST_SECRET;
    (env as Env).INTERNAL_REQUEST_SECRET = 'core-test-secret-with-at-least-32-characters';
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 500 }));
    try {
      const response = await hit('/api/search?q=anything', headers);
      expect(response.status).toBe(200);
      const body = await response.json<SearchResponse>();
      expect(body.partial).toEqual(expect.arrayContaining(['subjects', 'partners', 'mine']));
      expect(body.partial).not.toContain('people');
      expect(body.partial).not.toContain('conversations');
    } finally {
      (env as Env).INTERNAL_REQUEST_SECRET = configured ?? '';
      vi.unstubAllGlobals();
    }
  });

  it('finds an organization that is not a partner once the subjects group answers from D1 (meet#1221)', async () => {
    const headers = await session({ email: 'searchroute-rosa@example.com', name: 'Rosa' });
    const live = env as Env;
    const configured = { secret: live.INTERNAL_REQUEST_SECRET, subjects: live.WORK_STORE_SUBJECTS };
    live.INTERNAL_REQUEST_SECRET = 'core-test-secret-with-at-least-32-characters';
    live.WORK_STORE_SUBJECTS = 'd1';
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 500 }));
    const id = 'aaaaaaaa-0000-4000-8000-00000000a221';
    await live.USAGE.prepare("INSERT INTO organizations (id, name, is_partner, created_at, updated_at) VALUES (?1, 'Zorblax Holdings', 0, 1, 1)").bind(id).run();
    try {
      const response = await hit('/api/search?q=zorblax', headers);
      expect(response.status).toBe(200);
      const body = await response.json<SearchResponse>();
      const row = body.rows.find((candidate) => candidate.id === id);
      expect(row).toMatchObject({ kind: 'subject', title: 'Zorblax Holdings' });
      expect(row?.door).toContain('organization');
      expect(body.partial).not.toContain('organizations');
    } finally {
      await live.USAGE.prepare('DELETE FROM organizations WHERE id = ?1').bind(id).run();
      live.INTERNAL_REQUEST_SECRET = configured.secret ?? '';
      if (configured.subjects === undefined) delete (live as { WORK_STORE_SUBJECTS?: string }).WORK_STORE_SUBJECTS;
      else live.WORK_STORE_SUBJECTS = configured.subjects;
      vi.unstubAllGlobals();
    }
  });

  it('refuses a query it cannot read', async () => {
    const headers = await session({ email: 'searchroute-rosa@example.com', name: 'Rosa' });
    const response = await hit(`/api/search?q=${'x'.repeat(300)}`, headers);
    expect(response.status).toBe(400);
  });
});

// MARK: - Message bodies (meet#176): asked of each conversation's Durable
// Object, never indexed. A hit is a `thread` row whose subtitle is the line.

async function openDM(headers: Record<string, string>, peerEmail: string): Promise<string> {
  const response = await exports.default.fetch(new Request('http://local/api/threads', {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ peer_email: peerEmail }),
  }));
  return (await response.json<{ thread: { id: string } }>()).thread.id;
}

async function say(headers: Record<string, string>, threadId: string, text: string): Promise<string> {
  const response = await exports.default.fetch(new Request(`http://local/api/threads/${threadId}/messages`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ text }),
  }));
  expect(response.status).toBe(201);
  return (await response.json<{ message: { id: string } }>()).message.id;
}

describe('/api/search over message bodies', () => {
  afterEach(async () => {
    await env.USAGE.prepare('DELETE FROM thread_members').run();
    await env.USAGE.prepare('DELETE FROM threads').run();
  });

  it('finds a line in your own conversation, folded, and not one that was withdrawn or is not yours', async () => {
    const zelda = await session({ email: 'searchroute-zelda@example.com', name: 'Zelda' });
    const me = await session({ email: 'searchroute-rosa@example.com', name: 'Rosa' });
    const outsider = await session({ email: 'searchroute-ada@example.com', name: 'Ada' });
    const dm = await openDM(me, 'searchroute-zelda@example.com');
    const kept = await say(me, dm, 'The Café Brasília kickoff moved to the 29th.');
    const withdrawn = await say(zelda, dm, 'Café Brasília: scrap that.');
    await exports.default.fetch(new Request(`http://local/api/threads/${dm}/messages/${withdrawn}`, { method: 'DELETE', headers: zelda }));

    const response = await hit('/api/search?q=cafe%20brasilia', me);
    expect(response.status).toBe(200);
    const body = await response.json<SearchResponse>();
    const hits = body.rows.filter((row) => row.kind === 'thread' && row.door === searchDoorString({ to: 'thread', id: dm }));
    expect(hits.map((row) => row.id)).toEqual([kept]);
    expect(hits[0]!.subtitle).toBe('Rosa: The Café Brasília kickoff moved to the 29th.');
    expect(hits[0]!.title).toBe('Zelda');
    expect(body.partial).not.toContain('messages');

    // Not a member: nothing, and no sign the conversation exists.
    const theirs = await hit('/api/search?q=cafe%20brasilia', outsider);
    const stranger = await theirs.json<SearchResponse>();
    expect(stranger.rows.some((row) => row.id === kept)).toBe(false);
  });

  it('needs every token in the line, and keeps the matched part of a long one', async () => {
    await session({ email: 'searchroute-zelda@example.com', name: 'Zelda' });
    const me = await session({ email: 'searchroute-rosa@example.com', name: 'Rosa' });
    const dm = await openDM(me, 'searchroute-zelda@example.com');
    const filler = 'lorem ipsum dolor sit amet '.repeat(20);
    const long = await say(me, dm, `${filler}the quarterly budget review is on Thursday ${filler}`);
    await say(me, dm, 'budget only, nothing to look at here');

    const response = await hit('/api/search?q=budget%20review', me);
    const body = await response.json<SearchResponse>();
    const hits = body.rows.filter((row) => row.kind === 'thread' && row.id === long);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.subtitle).toContain('budget review');
    expect(hits[0]!.subtitle.length).toBeLessThan(220);
    expect(body.rows.some((row) => row.subtitle === 'Rosa: budget only, nothing to look at here')).toBe(false);
  });
});
