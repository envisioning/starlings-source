import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FavoriteRow, FavoritesResponse, FavoriteMigrationStatusResponse } from '@starlings/contracts/favorites';
import worker from '../src/index';
import { drainFavoriteSyncQueue, enqueueFavoriteSync } from '../src/favorite-sync';
import { resetCorePatCache } from '../src/crm';
import { purgeAllCoreCache } from '../src/core-cache';
import { resetDocsTokenCache } from '../src/docs';
import { resetPeerRosterCache } from '../src/peers';
import { starredFavoriteRows, starredSubjectRows } from '../src/search';
import { coreTask } from './core-rows';

const SECRET = 'meet-core-shared-secret-at-least-32-chars';
const configured = {
  ...env,
  INTERNAL_REQUEST_SECRET: SECRET,
  CORE_API_ORIGIN: 'https://core.test',
  DOCS_INTERNAL_SECRET: 'meet-docs-shared-secret-at-least-32-chars',
  DOCS_ORIGIN: 'https://docs.test',
  DOCS: undefined,
  FAVORITES_READS_FROM_CORE: 'false',
} as unknown as Env;
const ownerExchange = {
  ok: true,
  token: 'core_pat_favorites_worker',
  scopes: ['favorites:read', 'favorites:write'],
  expires_at: '2026-12-07T09:00:00.000Z',
  email: 'owner@example.com',
};
const projectID = 'c0ffee00-0000-4000-8000-000000000001';
const eventID = 'c0ffee00-0000-4000-8000-000000000002';
const documentID = 'c0ffee00-0000-4000-8000-000000000003';
const folderID = 'c0ffee00-0000-4000-8000-000000000004';
const taskID = 'c0ffee00-0000-4000-8000-000000000005';
const favoriteTime = '2026-09-01T10:00:00.000Z';

function coreAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function member(email: string): Promise<{ headers: Record<string, string>; sub: string }> {
  const session = await invoke(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, name: 'Favorites test' }),
  }));
  const accessToken = (await session.json<{ access_token: string }>()).access_token;
  const headers = { authorization: `Bearer ${accessToken}` };
  await invoke(new Request('http://local/api/peers', { headers }));
  const row = await env.USAGE.prepare('SELECT sub FROM people WHERE email = ?1').bind(email).first<{ sub: string }>();
  return { headers, sub: row!.sub };
}

async function invoke(request: Request, apiEnv: Env = configured): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, apiEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

async function hit(method: string, path: string, headers: Record<string, string>, body?: unknown, apiEnv: Env = configured): Promise<Response> {
  return invoke(new Request(`http://local${path}`, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  }), apiEnv);
}

beforeEach(() => resetCorePatCache());

afterEach(async () => {
  await resetCorePatCache();
  resetDocsTokenCache();
  resetPeerRosterCache();
  await purgeAllCoreCache();
  vi.restoreAllMocks();
  await env.USAGE.prepare("DELETE FROM favorite_sync_queue WHERE sub IN (SELECT sub FROM people WHERE email LIKE 'favorites-%')").run();
  await env.USAGE.prepare("DELETE FROM subject_state WHERE sub IN (SELECT sub FROM people WHERE email LIKE 'favorites-%')").run();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'favorites-%'").run();
});

describe('shared favorites routes', () => {
  it('accepts CMS events through their Work kind but rejects Calendar event favorites', async () => {
    const { headers } = await member('favorites-event-kinds@example.com');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === '/api/public/meet-owner-exchange') return coreAnswer(ownerExchange);
      if (url.pathname === '/api/agent/favorites') {
        const favorite = JSON.parse(String(init?.body)) as { kind: string; target_ref: string };
        return coreAnswer({ data: { ...favorite, created_at: favoriteTime } });
      }
      return coreAnswer({}, 404);
    });

    const cmsEvent = await hit('POST', '/api/crm/favorites', headers, { kind: 'cms.event', target_ref: eventID });
    const calendarEvent = await hit('POST', '/api/crm/favorites', headers, {
      kind: 'calendar.google_event',
      target_ref: 'event:primary:meeting-123',
    });

    expect(cmsEvent.status).toBe(200);
    expect(calendarEvent.status).toBe(400);
  });

  it('replays a legacy import after a lost Core response without duplicating or reordering it', async () => {
    const { sub } = await member('favorites-idempotent-import@example.com');
    const coreRows = new Map<string, FavoriteRow>();
    let writes = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === '/api/public/meet-owner-exchange') {
        // The queue is keyed by sub; Core signs in by the member's email.
        const body = JSON.parse(String(init?.body)) as { email: string };
        expect(body.email).toBe('favorites-idempotent-import@example.com');
        return coreAnswer({ ...ownerExchange, email: body.email });
      }
      if (url.pathname !== '/api/agent/favorites') return coreAnswer({}, 404);
      const target = JSON.parse(String(init?.body)) as { kind: string; target_ref: string };
      const identity = `${target.kind}:${target.target_ref}`;
      let row = coreRows.get(identity);
      if (!row) {
        row = { ...target, created_at: favoriteTime };
        coreRows.set(identity, row);
      }
      writes += 1;
      // Core has committed, but the reply is lost. The outbox must retry the
      // idempotent API without changing created_at or losing the favorite.
      if (writes === 1) throw new TypeError('response lost after commit');
      return coreAnswer({ data: row });
    });

    await enqueueFavoriteSync(configured, sub, 'cms.event', eventID, true, Date.parse(favoriteTime));
    const now = Date.now();
    expect(await drainFavoriteSyncQueue(configured, now)).toEqual({ attempted: 1, synced: 0, deferred: 1 });
    expect(await drainFavoriteSyncQueue(configured, now + 30_000)).toEqual({ attempted: 1, synced: 1, deferred: 0 });

    expect(writes).toBe(2);
    expect([...coreRows.values()]).toEqual([{ kind: 'cms.event', target_ref: eventID, created_at: favoriteTime }]);
    const left = await env.USAGE.prepare('SELECT id FROM favorite_sync_queue WHERE sub = ?1').bind(sub).first();
    expect(left).toBeNull();
  });

  it('resolves a closed event by its stored id and uses its current title', async () => {
    const lookedUp: URL[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname !== '/api/public/meet-crm-subjects') return coreAnswer({}, 404);
      if (url.searchParams.has('id')) {
        lookedUp.push(url);
        return coreAnswer({ subject: {
          id: eventID,
          kind: 'event',
          title: 'Rebranded past event',
          subtitle: null,
          event_date: '2026-08-01',
          published: false,
        } });
      }
      return coreAnswer({ subjects: [], has_more: false });
    });

    const result = await starredSubjectRows(configured, 'favorites-closed-event', [{ kind: 'event', id: eventID }]);
    expect(result.partial).toEqual([]);
    expect(result.rows).toMatchObject([{ id: eventID, title: 'Rebranded past event', door: `subject:event:${eventID}` }]);
    expect(lookedUp).toHaveLength(1);
    expect(lookedUp[0]!.searchParams.get('kind')).toBe('event');
    expect(lookedUp[0]!.searchParams.get('id')).toBe(eventID);
  });

  it('projects mixed Home favorites through Core, Docs, and the current directory', async () => {
    const { headers } = await member('favorites-home@example.com');
    const person = await env.USAGE.prepare('SELECT sub FROM people WHERE email = ?1')
      .bind('favorites-home@example.com').first<{ sub: string }>();
    const times = [
      '2026-09-04T10:00:00.000Z',
      '2026-09-03T10:00:00.000Z',
      '2026-09-02T10:00:00.000Z',
      '2026-09-01T10:00:00.000Z',
      '2026-08-31T10:00:00.000Z',
    ];
    const directoryRows = [{ kind: 'meet.person', target_ref: person!.sub, created_at: times[2]! }];
    const subject = {
      id: projectID,
      kind: 'project',
      title: 'Current project name',
      subtitle: 'Strategy',
      organization_logo_url: null,
    };
    const document = {
      id: documentID,
      path: '/work/current-plan.md',
      slug: 'current-plan',
      title: 'Current plan title',
      kind: 'markdown',
      folder_id: folderID,
      visibility: 'internal',
      status: 'active',
      source_system: 'native',
      source_kind: null,
      source_url: null,
      editable: true,
      version: 1,
      byte_size: 0,
      content_hash: '',
      tags: [],
      category: 'brief',
      subjects: [],
      created_at: times[0],
      updated_at: times[0],
      updated_by: null,
      body_md: '',
      links: [],
      backlinks: [],
      open_annotations: 0,
    };
    const received: string[] = [];
    const docsEnv = {
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        received.push(url.pathname);
        if (url.pathname === '/api/tokens/meet-exchange') {
          const body = await request.json<{ email: string }>();
          return coreAnswer({ token: 'docs_favorites_test', scopes: [], expires_at: '2026-12-01T00:00:00.000Z', email: body.email });
        }
        if (url.pathname === `/api/docs/${documentID}`) return coreAnswer(document);
        if (url.pathname === '/api/categories') return coreAnswer({ categories: [{ id: 'brief', label: 'Brief', position: 0, count: 1 }] });
        if (url.pathname === '/api/tree') {
          return coreAnswer({ folders: [{ id: folderID, path: '/work/renamed-folder', slug: 'renamed-folder', title: 'Renamed folder', parent_id: null, depth: 0, icon: null, description: null, source_key: null }] });
        }
        return coreAnswer({}, 404);
      },
    };
    const docsConfigured = { ...configured, DOCS: docsEnv } as Env;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      received.push(url.pathname);
      if (url.pathname === '/api/public/meet-owner-exchange') {
        const body = JSON.parse(String(init?.body)) as { email: string };
        return coreAnswer({ ...ownerExchange, email: body.email });
      }
      if (url.pathname === '/api/agent/favorites') {
        return coreAnswer({ data: [
          { kind: 'docs.document', target_ref: documentID, created_at: times[0] },
          { kind: 'docs.folder', target_ref: folderID, created_at: times[1] },
          ...directoryRows,
          { kind: 'crm.task', target_ref: taskID, created_at: times[3] },
          { kind: 'crm.project', target_ref: projectID, created_at: times[4] },
        ] });
      }
      if (url.pathname === '/api/public/meet-crm-subjects') return coreAnswer({ subject });
      if (url.pathname === `/api/public/meet-crm-tasks/${taskID}`) return coreAnswer({ task: coreTask({ id: taskID, title: 'Current task title', project_id: projectID }) });
      return coreAnswer({}, 404);
    });

    const response = await hit('GET', '/api/crm/starred', headers, undefined, docsConfigured);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      rows: [
        { kind: 'document', id: documentID, title: 'Current plan title', subtitle: 'Brief', door: `document:${documentID}` },
        { kind: 'folder', id: folderID, title: 'Renamed folder', subtitle: '/work/renamed-folder', door: `folder:${folderID}` },
        { kind: 'person', id: 'favorites-home@example.com', title: 'Favorites test', subtitle: 'favorites-home@example.com', door: 'person:favorites-home@example.com' },
        { kind: 'task', id: taskID, title: 'Current task title', subtitle: 'Project task', door: `task:${taskID}` },
        { kind: 'subject', id: projectID, title: 'Current project name', subtitle: 'Project · Strategy', door: `subject:project:${projectID}` },
      ],
      partial: [],
    });
    expect(received).toContain('/api/docs/' + documentID);
    expect(received).toContain('/api/tree');
    expect(received).toContain(`/api/public/meet-crm-tasks/${taskID}`);
  });

  it('uses the verified owner exchange and keeps old CRM stars visible beside closed-event refs', async () => {
    const { headers } = await member('favorites-list@example.com');
    await hit('PUT', `/api/crm/subject-state/project/${projectID}`, headers, { starred: true });
    const requests: Array<{ path: string; method: string; body: string; authorization: string | null }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      requests.push({
        path: url.pathname,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : '',
        authorization: new Headers(init?.headers).get('authorization'),
      });
      if (url.pathname === '/api/public/meet-owner-exchange') {
        const body = JSON.parse(String(init?.body)) as { email: string; device_name?: string };
        expect(body.email).toBe('favorites-list@example.com');
        expect(body.device_name).toBe('Favorites (Worker)');
        return coreAnswer({ ...ownerExchange, email: body.email });
      }
      if (url.pathname === '/api/agent/favorites') {
        return coreAnswer({ data: [
          { kind: 'cms.event', target_ref: eventID, created_at: favoriteTime },
          { kind: 'docs.document', target_ref: documentID, created_at: favoriteTime },
        ] satisfies { kind: string; target_ref: string; created_at: string }[] });
      }
      return coreAnswer({}, 404);
    });

    const response = await hit('GET', '/api/crm/favorites', headers);
    expect(response.status).toBe(200);
    const body = await response.json<FavoritesResponse>();
    expect(body.synced).toBe(true);
    expect(body.favorites.map(({ kind, target_ref }) => [kind, target_ref])).toEqual([
      ['crm.project', projectID],
      ['cms.event', eventID],
      ['docs.document', documentID],
    ]);
    expect(requests.map(({ path }) => path)).toEqual([
      '/api/public/meet-owner-exchange',
      '/api/agent/favorites',
    ]);
    expect(requests[1]!.authorization).toBe(`Bearer ${ownerExchange.token}`);
    expect(requests[1]!.body).toBe('');
  });

  it('adds and removes through Core while mirroring legacy CRM kinds for old clients', async () => {
    const { headers, sub } = await member('favorites-write@example.com');
    const received: Array<{ path: string; method: string; body: string }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const method = init?.method ?? 'GET';
      const requestBody = typeof init?.body === 'string' ? init.body : '';
      received.push({ path: url.pathname + url.search, method, body: requestBody });
      if (url.pathname === '/api/public/meet-owner-exchange') return coreAnswer(ownerExchange);
      if (url.pathname !== '/api/agent/favorites') return coreAnswer({}, 404);
      if (method === 'POST') {
        const input = JSON.parse(requestBody) as { kind: string; target_ref: string };
        const favorite = { ...input, created_at: favoriteTime } satisfies FavoriteRow;
        return coreAnswer({ data: favorite });
      }
      if (method === 'DELETE') return coreAnswer({ data: { removed: true } });
      return coreAnswer({ data: [] });
    });

    const upperLead = 'C0FFEE00-0000-4000-8000-000000000010';
    const add = await hit('POST', '/api/crm/favorites', headers, { kind: 'crm.lead', target_ref: upperLead });
    expect(add.status).toBe(200);
    expect(await add.json()).toMatchObject({ synced: true, favorite: { kind: 'crm.lead', target_ref: upperLead.toLowerCase() } });

    const remove = await hit('DELETE', `/api/crm/favorites?kind=crm.lead&target_ref=${upperLead}`, headers);
    expect(remove.status).toBe(200);
    expect(await remove.json()).toEqual({ removed: true, synced: true });
    expect(received.map(({ method }) => method)).toEqual(['POST', 'POST', 'DELETE']);
    expect(JSON.parse(received[1]!.body)).toEqual({ kind: 'crm.lead', target_ref: upperLead.toLowerCase() });
    expect(received[2]!.path).toContain(`target_ref=${upperLead.toLowerCase()}`);

    const local = await env.USAGE.prepare(
      'SELECT starred FROM subject_state WHERE sub = ?1 AND kind = ?2 AND subject_id = ?3',
    ).bind(sub, 'lead', upperLead.toLowerCase()).first<{ starred: number }>();
    expect(local).toBeNull();
    const outbox = await env.USAGE.prepare(
      'SELECT starred FROM favorite_sync_queue WHERE sub = ?1 AND kind = ?2 AND target_ref = ?3 ORDER BY id',
    ).bind(sub, 'crm.lead', upperLead.toLowerCase()).all<{ starred: number }>();
    // The latest change replaces the older one; a star cannot replay after the unstar.
    expect(outbox.results?.map((row) => row.starred)).toEqual([0]);
  });

  it('keeps a pending favorite visible through a Core outage and backs it off for retry', async () => {
    const { headers, sub } = await member('favorites-offline@example.com');
    const target = { kind: 'meet.agent', target_ref: 'agent_roster_stable_sub' };
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === '/api/public/meet-owner-exchange') return coreAnswer(ownerExchange);
      throw new TypeError('network unavailable');
    });

    const add = await hit('POST', '/api/crm/favorites', headers, target);
    expect(add.status).toBe(202);
    expect(await add.json()).toMatchObject({ synced: false, favorite: target });

    const read = await hit('GET', '/api/crm/favorites', headers);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ synced: false, favorites: [target] });

    const drained = await drainFavoriteSyncQueue(configured, Date.now());
    expect(drained).toEqual({ attempted: 1, synced: 0, deferred: 1 });
    const status = await hit('GET', '/api/crm/favorites/migration-status', headers);
    const report = await status.json<FavoriteMigrationStatusResponse>();
    expect(report.shared_available).toBe(false);
    expect(report.unresolved).toEqual([{
      kind: 'meet.agent',
      target_ref: target.target_ref,
      code: 'upstream_unavailable',
      attempts: 1,
    }]);
    const stored = await env.USAGE.prepare('SELECT sub FROM favorite_sync_queue WHERE sub = ?1').bind(sub).first<{ sub: string }>();
    expect(stored?.sub).toBe(sub);
  });

  it('lets the latest queued change win and drops a stale one after a direct write', async () => {
    const { headers, sub } = await member('favorites-latest@example.com');
    const target = { kind: 'meet.agent', target_ref: 'agent_roster_latest' };
    const received: string[] = [];
    let coreUp = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === '/api/public/meet-owner-exchange') return coreAnswer(ownerExchange);
      if (!coreUp) throw new TypeError('network unavailable');
      received.push(init?.method ?? 'GET');
      if (init?.method === 'DELETE') return coreAnswer({ data: { removed: true } });
      return coreAnswer({ data: { ...target, created_at: favoriteTime } });
    });

    // Two queued changes for one target keep only the newer.
    await enqueueFavoriteSync(configured, sub, target.kind, target.target_ref, true);
    await enqueueFavoriteSync(configured, sub, target.kind, target.target_ref, false);
    const queued = await env.USAGE.prepare('SELECT starred FROM favorite_sync_queue WHERE sub = ?1')
      .bind(sub).all<{ starred: number }>();
    expect(queued.results?.map((row) => row.starred)).toEqual([0]);

    // A star queued in an outage, then a direct unstar once Core is back:
    // the queued star must not replay over it.
    expect((await hit('POST', '/api/crm/favorites', headers, target)).status).toBe(202);
    coreUp = true;
    expect((await hit('DELETE', `/api/crm/favorites?kind=${target.kind}&target_ref=${target.target_ref}`, headers)).status).toBe(200);
    expect(await drainFavoriteSyncQueue(configured, Date.now())).toMatchObject({ synced: 0 });
    expect(received).toEqual(['DELETE']);
    const left = await env.USAGE.prepare('SELECT id FROM favorite_sync_queue WHERE sub = ?1').bind(sub).first();
    expect(left).toBeNull();
  });

  it('drops a queued target that Core keeps refusing', async () => {
    const { sub } = await member('favorites-rejected@example.com');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === '/api/public/meet-owner-exchange') return coreAnswer(ownerExchange);
      return coreAnswer({ error: 'not_found' }, 404);
    });
    await enqueueFavoriteSync(configured, sub, 'docs.folder', 'c0ffee00-0000-4000-8000-000000000021', true);

    let now = Date.now();
    for (let attempt = 1; attempt < 5; attempt += 1) {
      await drainFavoriteSyncQueue(configured, now);
      now += 86_400_000;
    }
    const kept = await env.USAGE.prepare('SELECT attempts FROM favorite_sync_queue WHERE sub = ?1').bind(sub).first<{ attempts: number }>();
    expect(kept?.attempts).toBe(4);

    await drainFavoriteSyncQueue(configured, now);
    const left = await env.USAGE.prepare('SELECT id FROM favorite_sync_queue WHERE sub = ?1').bind(sub).first();
    expect(left).toBeNull();
  });

  it('reports an unmapped Core identity and retains the queued target for recovery', async () => {
    const { headers, sub } = await member('favorites-unmapped@example.com');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === '/api/public/meet-owner-exchange') {
        return coreAnswer({ ok: false, error: 'no_core_account' }, 404);
      }
      return coreAnswer({}, 404);
    });
    const target = { kind: 'docs.folder', target_ref: 'c0ffee00-0000-4000-8000-000000000020' };

    const add = await hit('POST', '/api/crm/favorites', headers, target);
    expect(add.status).toBe(202);
    await drainFavoriteSyncQueue(configured, Date.now());
    const report = await (await hit('GET', '/api/crm/favorites/migration-status', headers)).json<FavoriteMigrationStatusResponse>();
    expect(report.shared_available).toBe(false);
    expect(report.unresolved).toEqual([{
      kind: target.kind,
      target_ref: target.target_ref,
      code: 'core_account_missing',
      attempts: 1,
    }]);
    const pending = await env.USAGE.prepare('SELECT target_ref FROM favorite_sync_queue WHERE sub = ?1').bind(sub).first<{ target_ref: string }>();
    expect(pending?.target_ref).toBe(target.target_ref);
  });
});
