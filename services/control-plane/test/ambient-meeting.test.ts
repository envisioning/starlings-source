// A meeting captured outside any room (docs/AMBIENT_CAPTURE.md slice 2):
// created already over with its roster, then the transcript and finalize
// as a hosted meeting's — and never `open`, so the room's own life is untouched.
import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { AmbientMeetingResponse, FinalizeMeetingResponse, TranscriptAppendResponse } from '@starlings/contracts';

async function owner() {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
  }));
  const session = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' };
}

describe('ambient meeting', () => {
  it('is created over, takes a transcript, and finalizes without a room to close', async () => {
    const headers = await owner();
    const created = await exports.default.fetch(new Request('http://local/api/rooms/rosa/meetings/ambient', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        started_at: '2026-09-16T09:00:00.000Z',
        ended_at: '2026-09-16T09:45:00.000Z',
        title: 'Zoom with Acme',
        attendees: [{ name: 'Ana Silva', email: 'ana@acme.example' }, { name: 'Rosa' }],
      }),
    }));
    expect(created.status).toBe(201);
    const { meeting_id } = await created.json<AmbientMeetingResponse>();
    expect(meeting_id).toMatch(/^[0-9a-f-]{36}$/u);

    const segment = {
      id: '4c7d2a0e-1111-4c8f-9a13-8a9d0e2f0001',
      meeting_id,
      speaker_id: 'ambient:ana-silva',
      speaker_name: 'Ana Silva',
      language: 'en',
      starts_at_ms: 0,
      ends_at_ms: 2_000,
      text: 'Let us start with the scope.',
      is_final: true,
    } as const;
    const appended = await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/transcript`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ segments: [segment] }),
    }));
    expect(await appended.json<TranscriptAppendResponse>()).toEqual({ accepted: 1 });

    const finalized = await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/finalize`, {
      method: 'POST',
      headers: { authorization: headers.authorization },
    }));
    expect(finalized.status).toBe(202);
    const body = await finalized.json<FinalizeMeetingResponse>();
    expect(body.artifact.title).toBe('Zoom with Acme');
    expect(body.artifact.transcript).toEqual([segment]);
    expect(body.artifact.endedAt).toBe(Date.parse('2026-09-16T09:45:00.000Z'));
  });

  it('refuses a body without both ends', async () => {
    const headers = await owner();
    const response = await exports.default.fetch(new Request('http://local/api/rooms/rosa/meetings/ambient', {
      method: 'POST',
      headers,
      body: JSON.stringify({ started_at: '2026-09-16T09:00:00.000Z' }),
    }));
    expect(response.status).toBe(400);
  });
});

describe('transcript view and strike-out', () => {
  it('the owner reads the record and strikes lines from it', async () => {
    const headers = await owner();
    const created = await exports.default.fetch(new Request('http://local/api/rooms/rosa/meetings/ambient', {
      method: 'POST',
      headers,
      body: JSON.stringify({ started_at: '2026-09-16T09:00:00.000Z', ended_at: '2026-09-16T09:30:00.000Z', title: 'Strike test' }),
    }));
    const { meeting_id } = await created.json<AmbientMeetingResponse>();
    const line = (n: number, text: string) => ({
      id: `5d8e3b1f-2222-4c8f-9a13-8a9d0e2f000${n}`, meeting_id, speaker_id: 'ambient:ana', speaker_name: 'Ana',
      language: 'en', starts_at_ms: n * 1000, ends_at_ms: n * 1000 + 900, text, is_final: true,
    });
    await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/transcript`, {
      method: 'POST', headers, body: JSON.stringify({ segments: [line(1, 'keep'), line(2, 'strike'), line(3, 'keep too')] }),
    }));

    const view = await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/transcript`, { headers: { authorization: headers.authorization } }));
    expect(view.status).toBe(200);
    expect((await view.json<{ artifact: { transcript: Array<{ text: string }> } }>()).artifact.transcript.map((s) => s.text)).toEqual(['keep', 'strike', 'keep too']);

    const renamed = await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/transcript`, {
      method: 'PATCH', headers, body: JSON.stringify({ speaker_id: 'ambient:ana', speaker_name: 'Ana Silva' }),
    }));
    expect(await renamed.json()).toEqual({ renamed: 3 });
    const named = await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/transcript`, { headers: { authorization: headers.authorization } }));
    expect(new Set((await named.json<{ artifact: { transcript: Array<{ speaker_name: string }> } }>()).artifact.transcript.map((s) => s.speaker_name))).toEqual(new Set(['Ana Silva']));

    const struck = await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/transcript`, {
      method: 'DELETE', headers, body: JSON.stringify({ segment_ids: [line(2, '').id, '5d8e3b1f-2222-4c8f-9a13-8a9d0e2f0099'] }),
    }));
    expect(await struck.json()).toEqual({ removed: 1 });
    const after = await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/transcript`, { headers: { authorization: headers.authorization } }));
    expect((await after.json<{ artifact: { transcript: Array<{ text: string }> } }>()).artifact.transcript.map((s) => s.text)).toEqual(['keep', 'keep too']);
  });
});
