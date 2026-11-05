// Meetings owed notes (meet#315): the row is written at /finalize before the
// job is enqueued, the job closes it, and the sweep enqueues a meeting whose
// job went quiet, three times, then counts a failure.
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AmbientMeetingResponse } from '@starlings/contracts';
import { processArtifactJob } from '../src/artifacts';
import { NOTES_OWED_RETRY_MS, sweepOwedNotes } from '../src/notes-owed';

async function owner() {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
  }));
  const session = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json', origin: env.WEB_ORIGIN };
}

/** An ambient meeting over already, `minutes` long, with one line, finalized. */
async function finalizedMeeting(minutes: number): Promise<string> {
  const headers = await owner();
  const startedAt = Date.parse('2026-09-16T09:00:00.000Z');
  const created = await exports.default.fetch(new Request('http://local/api/rooms/rosa/meetings/ambient', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(startedAt + minutes * 60_000).toISOString(),
      title: 'Owed notes',
    }),
  }));
  const { meeting_id } = await created.json<AmbientMeetingResponse>();
  await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/transcript`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ segments: [{
      id: crypto.randomUUID(), meeting_id, speaker_id: 'ambient:ana', speaker_name: 'Ana', language: 'en',
      starts_at_ms: 0, ends_at_ms: 2_000, text: 'Scope first.', is_final: true,
    }] }),
  }));
  const finalized = await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/finalize`, {
    method: 'POST',
    headers: { authorization: headers.authorization },
  }));
  expect(finalized.status).toBe(202);
  return meeting_id;
}

async function owedRow(meetingId: string) {
  return env.USAGE.prepare('SELECT owed_at, attempts, done_at FROM notes_owed WHERE room_slug = ?1 AND meeting_id = ?2')
    .bind('rosa', meetingId).first<{ owed_at: number; attempts: number; done_at: number | null }>();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('notes owed', () => {
  it('is written at /finalize before the job is enqueued', async () => {
    const seen: Array<unknown> = [];
    vi.spyOn(env.ARTIFACT_JOBS, 'send').mockImplementation(async (body: unknown) => {
      const meetingId = (body as { meetingId: string }).meetingId;
      seen.push(await owedRow(meetingId));
      return undefined as never;
    });
    const meetingId = await finalizedMeeting(30);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ attempts: 0, done_at: null });
    expect(await owedRow(meetingId)).toMatchObject({ done_at: null });
  });

  it('is closed when the job writes the notes', async () => {
    vi.spyOn(env.ARTIFACT_JOBS, 'send').mockResolvedValue(undefined as never);
    const meetingId = await finalizedMeeting(30);
    await processArtifactJob({ roomSlug: 'rosa', meetingId }, env);
    expect((await owedRow(meetingId))?.done_at).toEqual(expect.any(Number));
  });

  it('is closed when the meeting is discarded as too short', async () => {
    vi.spyOn(env.ARTIFACT_JOBS, 'send').mockResolvedValue(undefined as never);
    const meetingId = await finalizedMeeting(1);
    await processArtifactJob({ roomSlug: 'rosa', meetingId }, env);
    expect((await owedRow(meetingId))?.done_at).toEqual(expect.any(Number));
  });

  it('stays open when the job throws; the sweep enqueues it after 15 minutes, three times, then counts a failure', async () => {
    const send = vi.spyOn(env.ARTIFACT_JOBS, 'send').mockResolvedValue(undefined as never);
    const meetingId = await finalizedMeeting(30);
    send.mockClear();

    // A job that dies before the summary: the room cannot be read.
    const broken = { ...env, ROOMS: { getByName: () => ({ artifactForProcessing: async () => { throw new Error('DO down'); } }) } } as unknown as Env;
    await expect(processArtifactJob({ roomSlug: 'rosa', meetingId }, broken)).rejects.toThrow('DO down');
    const owed = await owedRow(meetingId);
    expect(owed?.done_at).toBeNull();
    const at = (minutes: number) => owed!.owed_at + minutes * 60_000;
    // Rows from the other tests in this file are swept too; count this one.
    const sent = () => send.mock.calls.filter(([body]) => (body as { meetingId?: string }).meetingId === meetingId).length;

    // Not yet at 10 minutes.
    await sweepOwedNotes(env, at(10));
    expect(sent()).toBe(0);

    // Attempt 1 after 15 minutes, and not again on the next tick.
    await sweepOwedNotes(env, at(16));
    await sweepOwedNotes(env, at(21));
    expect(sent()).toBe(1);
    expect(send).toHaveBeenCalledWith({ roomSlug: 'rosa', meetingId });
    expect((await owedRow(meetingId))?.attempts).toBe(1);

    // Attempts 2 and 3.
    await sweepOwedNotes(env, at(31));
    await sweepOwedNotes(env, at(46));
    expect(sent()).toBe(3);

    // After three attempts: no fourth job, one counted failure.
    const report = await sweepOwedNotes(env, at(61));
    expect(report.given_up).toBeGreaterThanOrEqual(1);
    await sweepOwedNotes(env, at(120));
    expect(sent()).toBe(3);
    const day = new Date(at(61)).toISOString().slice(0, 10);
    const failure = await env.USAGE.prepare(`SELECT count FROM ops_failures WHERE kind = 'notes_owed' AND day = ?1`)
      .bind(day).first<{ count: number }>();
    // One per given-up meeting; the first test's meeting is given up too.
    expect(failure?.count).toBe(report.given_up);
    expect((await owedRow(meetingId))?.attempts).toBe(4);

    // Admin lists it, and Retry sends it round again.
    const headers = await owner();
    const listed = await (await exports.default.fetch(new Request('http://local/api/admin/notes-owed', { headers }))).json<{ stuck: Array<{ meeting_id: string }> }>();
    expect(listed.stuck.map((row) => row.meeting_id)).toContain(meetingId);
    const retried = await exports.default.fetch(new Request('http://local/api/admin/notes-owed/retry', {
      method: 'POST', headers, body: JSON.stringify({ room_slug: 'rosa', meeting_id: meetingId }),
    }));
    expect(await retried.json()).toEqual({ reset: true });
    await sweepOwedNotes(env, at(121));
    expect(sent()).toBe(4);

    // The job that finally runs closes the row.
    await processArtifactJob({ roomSlug: 'rosa', meetingId }, env);
    expect((await owedRow(meetingId))?.done_at).toEqual(expect.any(Number));
    await sweepOwedNotes(env, at(24 * 60));
    expect(sent()).toBe(4);
    expect(NOTES_OWED_RETRY_MS).toBe(15 * 60_000);
  });

  it('refuses the list and the retry to a member', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', email: 'owed-member@example.com' }),
    }));
    const { access_token } = await response.json<{ access_token: string }>();
    const headers = { authorization: `Bearer ${access_token}`, 'content-type': 'application/json', origin: env.WEB_ORIGIN };
    expect((await exports.default.fetch(new Request('http://local/api/admin/notes-owed', { headers }))).status).toBe(403);
    expect((await exports.default.fetch(new Request('http://local/api/admin/notes-owed/retry', {
      method: 'POST', headers, body: JSON.stringify({ room_slug: 'rosa', meeting_id: crypto.randomUUID() }),
    }))).status).toBe(403);
  });
});
