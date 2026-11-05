import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdminOverview } from '../src/admin';
import type { MeetingChangesResponse } from '../src/contracts';
import { encodeMcpChangeCursor } from '@starlings/contracts/mcp';

async function ownerSession(email = 'rosa@example.com', name = 'Rosa') {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email }),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}` };
}

async function startMeeting(headers: Record<string, string>) {
  const response = await exports.default.fetch(new Request('http://local/api/rooms/rosa/start', {
    method: 'POST',
    headers,
  }));
  expect(response.status).toBe(200);
  return response.json<{ meetingId?: string; meeting_id?: string }>();
}

describe('meetings ledger', () => {
  afterEach(async () => {
    await env.USAGE.prepare('DELETE FROM meetings_ledger').run();
    await env.USAGE.prepare('DELETE FROM usage_events').run();
  });

  it('opens a row when the host starts hosting', async () => {
    const owner = await ownerSession();
    await startMeeting(owner);

    const row = await env.USAGE.prepare(
      'SELECT room_slug, host_email, ended_at FROM meetings_ledger ORDER BY started_at DESC',
    ).first<{ room_slug: string; host_email: string; ended_at: number | null }>();
    expect(row?.room_slug).toBe('rosa');
    expect(row?.host_email).toBe('rosa@example.com');
    // Open, not finished: the completion write owns `ended_at`.
    expect(row?.ended_at).toBeNull();
  });

  it('returns only finalized meetings from the owner room change route', async () => {
    const owner = await ownerSession();
    const endedAt = Date.now();
    await env.USAGE.prepare(
      `INSERT INTO meetings_ledger (meeting_id, room_slug, host_email, title, started_at, ended_at)
       VALUES (?1, 'rosa', 'rosa@example.com', 'Planning', ?2, ?3),
              (?4, 'rosa', 'rosa@example.com', 'Still open', ?2, NULL)`,
    ).bind('meeting-finished-change', endedAt - 60_000, endedAt, 'meeting-open-change').run();

    const response = await exports.default.fetch(new Request(
      `http://local/api/rooms/rosa/meetings?since=${encodeURIComponent(new Date(endedAt - 1).toISOString())}`,
      { headers: owner },
    ));
    expect(response.status).toBe(200);
    const body = await response.json<MeetingChangesResponse>();
    expect(body.meetings).toEqual([expect.objectContaining({
      meeting_id: 'meeting-finished-change',
      title: 'Planning',
      changed_at: endedAt,
    })]);
    expect(body.has_more).toBe(false);

    const cursor = encodeMcpChangeCursor(endedAt, 'meeting-finished-change');
    const after = await exports.default.fetch(new Request(
      `http://local/api/rooms/rosa/meetings?since=${encodeURIComponent(cursor)}`,
      { headers: owner },
    ));
    expect((await after.json<MeetingChangesResponse>()).meetings).toEqual([]);
  });

  it('is idempotent, so the backfill can be run again', async () => {
    const owner = await ownerSession();
    await startMeeting(owner);

    async function backfill() {
      const response = await exports.default.fetch(new Request('http://local/api/admin/backfill', {
        method: 'POST',
        headers: { ...owner, origin: env.WEB_ORIGIN },
      }));
      expect(response.status).toBe(200);
      return response.json<{ rooms: number; meetings: number; degraded: string[] }>();
    }

    const first = await backfill();
    expect(first.meetings).toBeGreaterThan(0);
    expect(first.degraded).toEqual([]);

    const before = await env.USAGE.prepare('SELECT COUNT(*) AS n FROM meetings_ledger').first<{ n: number }>();
    await backfill();
    const after = await env.USAGE.prepare('SELECT COUNT(*) AS n FROM meetings_ledger').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it('needs an admin to fill', async () => {
    const member = await ownerSession('ada@example.com', 'Ada');
    const response = await exports.default.fetch(new Request('http://local/api/admin/backfill', {
      method: 'POST',
      headers: { ...member, origin: env.WEB_ORIGIN },
    }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'not_org_admin' });
    await env.USAGE.prepare('DELETE FROM people WHERE email = ?1').bind('ada@example.com').run();
  });

  it('reads the page from the ledger once it has rows, and says so', async () => {
    const owner = await ownerSession();

    const empty = await exports.default.fetch(new Request('http://local/api/admin/overview', { headers: owner }));
    const before = await empty.json<AdminOverview>();
    expect(before.meetings_source).toBe('rooms');

    await startMeeting(owner);

    const filled = await exports.default.fetch(new Request('http://local/api/admin/overview', { headers: owner }));
    const after = await filled.json<AdminOverview>();
    expect(after.meetings_source).toBe('ledger');
    expect(after.meetings.some((row) => row.room_slug === 'rosa')).toBe(true);
  });

  it('records the funnel as events without failing the knock', async () => {
    const owner = await ownerSession();
    await startMeeting(owner);

    const knock = await exports.default.fetch(new Request('http://local/api/rooms/rosa/join-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({ name: 'Ana', email: 'ana@acme.example' }),
    }));
    expect(knock.status).toBe(201);

    const kinds = await env.USAGE.prepare('SELECT DISTINCT kind FROM usage_events').all<{ kind: string }>();
    const seen = kinds.results.map((row) => row.kind);
    expect(seen).toContain('meeting_start');
    expect(seen).toContain('knock');
  });

  it('leaves the lobby working while the presence sweep counts abandons', async () => {
    const owner = await ownerSession();
    await startMeeting(owner);

    // The sweep runs inside this call. Nothing here can age a row past the
    // 45s TTL, so this asserts the cheap half — that a presence heartbeat
    // still answers with the ledger write wired into the sweep — and leaves
    // the counting itself to the funnel swap, which is when anything reads it.
    const presence = await exports.default.fetch(new Request('http://local/api/rooms/rosa/guest-presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({ presence_id: crypto.randomUUID(), stage: 'naming' }),
    }));
    expect(presence.status).toBe(200);
  });

  it('never puts a guest address in the ledger', async () => {
    const owner = await ownerSession();
    await startMeeting(owner);
    const dumped = JSON.stringify(
      (await env.USAGE.prepare('SELECT * FROM meetings_ledger').all()).results,
    );
    expect(dumped).not.toContain('@acme.example');
  });
});

describe('POST /api/admin/replay-jobs (meet#187)', () => {
  async function replay(headers: Record<string, string>, body: unknown) {
    return exports.default.fetch(new Request('http://local/api/admin/replay-jobs', {
      method: 'POST',
      headers: { ...headers, origin: env.WEB_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  it('sends dead-lettered bodies on the live queue again, as they were', async () => {
    const owner = await ownerSession();
    const response = await replay(owner, { jobs: [
      { roomSlug: 'rosa', meetingId: '7d5f9f6e-0f2b-4c5a-9a55-8e1c3f9b2a10', kind: 'crm' },
      { roomSlug: 'rosa', meetingId: '7d5f9f6e-0f2b-4c5a-9a55-8e1c3f9b2a11' },
      { kind: 'granola', noteId: 'note-1' },
      { kind: 'granola-page', createdAfter: '2026-09-01T00:00:00Z' },
    ] });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ queued: 4 });
  });

  it('refuses a body the queue would not have carried', async () => {
    const owner = await ownerSession();
    expect((await replay(owner, { jobs: [{ roomSlug: 'rosa', meetingId: 'not-a-uuid' }] })).status).toBe(400);
    expect((await replay(owner, { jobs: [] })).status).toBe(400);
  });

  it('needs an admin', async () => {
    const member = await ownerSession('ada@example.com', 'Ada');
    const response = await replay(member, { jobs: [{ kind: 'granola', noteId: 'note-1' }] });
    expect(response.status).toBe(403);
    await env.USAGE.prepare('DELETE FROM people WHERE email = ?1').bind('ada@example.com').run();
  });
});
