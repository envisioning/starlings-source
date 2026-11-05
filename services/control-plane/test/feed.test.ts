// The cross-subject feed read: the most recent interactions across every
// open subject, merged and sorted — docs/TIMELINE.md Phase 3.
import { coreInteraction } from './core-rows';
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { purgeAllCoreCache } from '../src/core-cache';
import { recordOwnerSignIn } from '../src/usage';
import { recordSubjectActivity, readSubjectActivity } from '../src/subject-activity';
import { ensureSubjectThread, threadStub, postSubjectEvent } from '../src/threads';
import { THREAD_EVENT_SENDER } from '@starlings/contracts';
import { fetchRecentFeed, type RecentFeedResponse } from '../src/feed';

const rosa = { sub: 'feed-rosa', email: 'feed-rosa@example.com', name: 'Rosa' };
const CORE_SECRET = 'core-test-secret-with-at-least-32-characters';
const project = { id: 'c0ffee00-0000-4000-8000-0000000000f0', kind: 'project', title: 'Acme rollout', subtitle: 'Acme', has_repo: true, open_tasks: 1 };
const lead = { id: 'c0ffee00-0000-4000-8000-0000000000f1', kind: 'lead', title: 'Beta talks', subtitle: null, open_tasks: 1 };

async function session(person: { email: string; name: string }) {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(person),
  }));
  const body = await response.json<{ access_token: string }>();
  await recordOwnerSignIn(env as Env, { sub: `dev:${person.email}`, ...person }, 'mac');
  return { authorization: `Bearer ${body.access_token}` };
}

/** Core scripted: one project, one lead, and one interaction each. */
function withCore(options: { failInteractionsFor?: string; failSince?: boolean } = {}) {
  const configured = (env as Env).INTERNAL_REQUEST_SECRET;
  (env as Env).INTERNAL_REQUEST_SECRET = CORE_SECRET;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('meet-crm-subjects')) {
      const kind = url.searchParams.get('kind');
      const status = url.searchParams.get('status');
      if (url.searchParams.get('id')) return json({ ok: true, subjects: [project], has_more: false });
      if (kind === 'project' && status === 'Active') return json({ ok: true, subjects: [project], has_more: false });
      if (kind === 'lead' && status === 'Proposal Out') return json({ ok: true, subjects: [lead], has_more: false });
      return json({ ok: true, subjects: [], has_more: false });
    }
    if (url.pathname.endsWith('meet-crm-interactions')) {
      if (options.failSince && url.searchParams.has('since')) return new Response('{}', { status: 503 });
      const subjectId = url.searchParams.get('project_id') || url.searchParams.get('lead_id');
      if (options.failInteractionsFor === subjectId) return new Response('{}', { status: 500 });
      const older = subjectId === project.id;
      return json({ ok: true, interactions: [coreInteraction({
        id: `interaction-${subjectId}`,
        title: older ? 'Kickoff notes' : 'Discovery call',
        type: older ? 'note' : 'call',
        occurred_at: older ? '2026-09-01T00:00:00Z' : '2026-09-04T00:00:00Z',
        created_at: null, summary_preview: null, transcript_preview: null, duration_minutes: null,
        project_id: subjectId === project.id ? subjectId : null,
        lead_id: subjectId === lead.id ? subjectId : null,
        organization_id: null, source: null, channel: null, status: null, url: null, contacts: [],
      })] });
    }
    return new Response('{}', { status: 404 });
  });
  return { restore: () => { (env as Env).INTERNAL_REQUEST_SECRET = configured ?? ''; } };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await purgeAllCoreCache();
  await env.USAGE.prepare('DELETE FROM subject_activity').run();
  await env.USAGE.prepare('DELETE FROM subject_activity_index').run();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'feed-%'").run();
});

describe('GET /api/crm/feed', () => {
  it('needs a member', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/crm/feed'));
    expect(response.status).toBe(401);
  });

  it('merges every open subject’s interactions, newest first', async () => {
    const headers = await session(rosa);
    const core = withCore();
    try {
      const response = await exports.default.fetch(new Request('http://local/api/crm/feed', { headers }));
      expect(response.status).toBe(200);
      const body = await response.json<RecentFeedResponse>();
      expect(body.partial).toEqual([]);
      expect(body.entries.map((entry) => entry.interaction.title)).toEqual(['Discovery call', 'Kickoff notes']);
      expect(body.entries[0]!.subject).toEqual({ kind: 'lead', id: lead.id, title: 'Beta talks' });
      expect(body.entries[1]!.subject).toEqual({ kind: 'project', id: project.id, title: 'Acme rollout' });
    } finally {
      core.restore();
    }
  });

  it('answers 304 to a matching If-None-Match and 200 to a stale one', async () => {
    const headers = await session(rosa);
    const core = withCore();
    try {
      const first = await exports.default.fetch(new Request('http://local/api/crm/feed', { headers }));
      const etag = first.headers.get('etag');
      expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/u);
      expect(first.headers.get('cache-control')).toBe('no-store');

      const unchanged = await exports.default.fetch(new Request('http://local/api/crm/feed', {
        headers: { ...headers, 'if-none-match': etag! },
      }));
      expect(unchanged.status).toBe(304);
      expect(unchanged.headers.get('etag')).toBe(etag);
      expect(await unchanged.text()).toBe('');

      const stale = await exports.default.fetch(new Request('http://local/api/crm/feed', {
        headers: { ...headers, 'if-none-match': 'W/"00000000000000000000000000000000"' },
      }));
      expect(stale.status).toBe(200);
      expect(stale.headers.get('etag')).toBe(etag);
      expect((await stale.json<RecentFeedResponse>()).entries).toHaveLength(2);
    } finally {
      core.restore();
    }
  });

  it('caps at the requested limit', async () => {
    const headers = await session(rosa);
    const core = withCore();
    try {
      const response = await exports.default.fetch(new Request('http://local/api/crm/feed?limit=1', { headers }));
      const body = await response.json<RecentFeedResponse>();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]!.interaction.title).toBe('Discovery call');
    } finally {
      core.restore();
    }
  });

  it('names the subject it could not read instead of dropping it silently', async () => {
    const headers = await session(rosa);
    const core = withCore({ failInteractionsFor: lead.id });
    try {
      const response = await exports.default.fetch(new Request('http://local/api/crm/feed', { headers }));
      const body = await response.json<RecentFeedResponse>();
      expect(body.partial).toEqual(['Beta talks']);
      expect(body.entries.map((entry) => entry.interaction.title)).toEqual(['Kickoff notes']);
    } finally {
      core.restore();
    }
  });

  it('applies subject access before the global ceiling', async () => {
    const headers = await session(rosa);
    const core = withCore();
    try {
      await env.USAGE.prepare(`INSERT INTO subject_visibility (kind, subject_id, visibility, updated_by, updated_at)
        VALUES ('lead', ?1, 'restricted', 'test', ?2)`).bind(lead.id, Date.now()).run();
      const response = await exports.default.fetch(new Request('http://local/api/crm/feed?limit=1', { headers }));
      const body = await response.json<RecentFeedResponse>();
      expect(body.entries.map((row) => row.subject.id)).toEqual([project.id]);
      expect(body.partial).not.toContain(lead.title);
    } finally {
      await env.USAGE.prepare('DELETE FROM subject_visibility WHERE subject_id = ?1').bind(lead.id).run();
      core.restore();
    }
  });

  it('answers 503 while the bridge is off', async () => {
    const headers = await session(rosa);
    const configured = (env as Env).INTERNAL_REQUEST_SECRET;
    (env as Env).INTERNAL_REQUEST_SECRET = '';
    try {
      const response = await exports.default.fetch(new Request('http://local/api/crm/feed', { headers }));
      expect(response.status).toBe(503);
    } finally {
      (env as Env).INTERNAL_REQUEST_SECRET = configured ?? '';
    }
  });
});


describe('subject activity index', () => {
  it('merges event lines with interactions before applying the ceiling, with stable retry identity', async () => {
    const headers = await session(rosa);
    const core = withCore();
    try {
      await postSubjectEvent(env as Env, { kind: 'project', id: project.id }, 'Task finished', [], { dedupeKey: 'feed-completed' });
      await postSubjectEvent(env as Env, { kind: 'project', id: project.id }, 'Different retry text', [], { dedupeKey: 'feed-completed' });
      const response = await exports.default.fetch(new Request('http://local/api/crm/feed?limit=1', { headers }));
      const body = await response.json<RecentFeedResponse>();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]!.interaction.title).toBe('Task finished');
      expect(body.entries[0]!.interaction.type).toBe('event');
      expect(body.entries[0]!.subject.id).toBe(project.id);
      const count = await env.USAGE.prepare('SELECT COUNT(*) AS n FROM subject_activity').first<{ n: number }>();
      expect(count?.n).toBe(1);
    } finally { core.restore(); }
  });

  it('reconstructs historical event lines once, excluding human Talk and old events', async () => {
    const core = withCore();
    try {
      const historySubject = { ...project, id: 'c0ffee00-0000-4000-8000-0000000000f2' };
      const { id } = await ensureSubjectThread(env as Env, 'project', historySubject.id, historySubject.title);
      const thread = threadStub(env as Env, id);
      const now = Date.now();
      await thread.append(THREAD_EVENT_SENDER, 'Old event', 'feed-old-event', now - 10_000, 'event', []);
      await thread.append(THREAD_EVENT_SENDER, 'Recent event', 'feed-recent-event', now, 'event', []);
      await thread.append(THREAD_EVENT_SENDER, 'Private typed content', 'feed-human-text', now, 'text', []);
      const partial: string[] = [];
      const subjects = [historySubject] as Parameters<typeof readSubjectActivity>[1];
      const first = await readSubjectActivity(env as Env, subjects, partial, 30, now - 1000);
      expect(partial).toEqual([]);
      expect(first.map((row) => row.interaction.title)).toEqual(['Recent event']);
      // Once seeded, a feed read never opens this DO again.
      await thread.append(THREAD_EVENT_SENDER, 'Unindexed event', 'feed-unindexed-event', now + 1, 'event', []);
      expect((await readSubjectActivity(env as Env, subjects, [], 30, now - 1000)).map((row) => row.interaction.title)).toEqual(['Recent event']);
    } finally { core.restore(); }
  });

  it('scopes before limiting and excludes removed subjects', async () => {
    const visibleSubject = { ...project, id: 'c0ffee00-0000-4000-8000-0000000000f3' };
    for (const [id, kind, parent] of [['feed-visible', 'project', visibleSubject.id], ['feed-hidden', 'lead', lead.id]]) {
      await env.USAGE.prepare('INSERT INTO threads (id, kind, parent_id, created_at) VALUES (?1, ?2, ?3, ?4)').bind(id, kind, parent, Date.now()).run();
      await env.USAGE.prepare('INSERT INTO subject_activity_index (thread_id, since) VALUES (?1, 0)').bind(id).run();
    }
    await recordSubjectActivity(env as Env, { thread_id: 'feed-hidden', message_id: 'hidden', text: 'Hidden', at: Date.now() + 1000 });
    await recordSubjectActivity(env as Env, { thread_id: 'feed-visible', message_id: 'visible', text: 'Visible', at: Date.now() });
    const subjects = [visibleSubject] as Parameters<typeof readSubjectActivity>[1];
    const partial: string[] = [];
    expect((await readSubjectActivity(env as Env, subjects, partial, 1)).map((row) => row.interaction.title)).toEqual(['Visible']);
    expect(partial).toEqual([]);
    await env.USAGE.prepare("UPDATE threads SET removed_at = ?1 WHERE id = 'feed-visible'").bind(Date.now()).run();
    expect(await readSubjectActivity(env as Env, subjects, [], 1)).toEqual([]);
  });
  it('keeps indexed events when the interaction source fails', async () => {
    const core = withCore({ failSince: true });
    try {
      await env.USAGE.prepare(`INSERT INTO threads (id, kind, parent_id, created_at) VALUES ('feed-outage', 'project', ?1, ?2)`).bind(project.id, Date.now()).run();
      await env.USAGE.prepare(`INSERT INTO subject_activity_index (thread_id, since) VALUES ('feed-outage', 0)`).run();
      await recordSubjectActivity(env as Env, { thread_id: 'feed-outage', message_id: 'outage-event', text: 'Calendar filed', at: Date.now() });
      const body = await fetchRecentFeed(env as Env, { since: Date.now() - 1000 });
      expect(body.entries.map((row) => row.interaction.title)).toContain('Calendar filed');
      expect(body.partial).toContain(project.title);
    } finally { core.restore(); }
  });

  it('bounds reconstruction and reports unfinished subjects until the next read', async () => {
    const subjects = Array.from({ length: 6 }, (_, i) => ({ ...project, id: `backfill-${i}`, title: `Backfill ${i}` })) as Parameters<typeof readSubjectActivity>[1];
    for (const subject of subjects) {
      await env.USAGE.prepare(`INSERT INTO threads (id, kind, parent_id, created_at) VALUES (?1, 'project', ?2, ?3)`)
        .bind(`feed-backfill-${subject.id}`, subject.id, Date.now()).run();
    }
    const partial: string[] = [];
    const since = Date.now() - 1000;
    await readSubjectActivity(env as Env, subjects, partial, 30, since);
    expect(partial).toEqual(['Backfill 5']);
    const checkpoints = await env.USAGE.prepare('SELECT COUNT(*) AS n FROM subject_activity_index').first<{ n: number }>();
    expect(checkpoints?.n).toBe(5);
    const next: string[] = [];
    await readSubjectActivity(env as Env, subjects, next, 30, since);
    expect(next).toEqual([]);
  });

});
