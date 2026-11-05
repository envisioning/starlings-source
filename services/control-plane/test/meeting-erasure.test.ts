// Erasing one meeting (meet#1161, docs/DATA_REQUESTS.md): every row of the
// meeting goes from its room and from D1 in one request, a retry answers the
// same receipt, only an org admin erases, and a restore from a backup taken
// before the erasure does not bring the meeting back.
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { AmbientMeetingResponse, EraseMeetingResponse } from '@starlings/contracts';
import type { RoomCoordinator } from '../src/room-coordinator';
import { eraseMeeting } from '../src/meeting-erasure';

async function session(email: string, name = 'Ada') {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email }),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json', origin: env.WEB_ORIGIN };
}

async function endedMeeting(): Promise<string> {
  const headers = await session('rosa@example.com', 'Rosa');
  const created = await exports.default.fetch(new Request('http://local/api/rooms/rosa/meetings/ambient', {
    method: 'POST',
    headers,
    body: JSON.stringify({ started_at: '2026-09-16T09:00:00.000Z', ended_at: '2026-09-16T09:40:00.000Z', title: 'Erasure test' }),
  }));
  const { meeting_id } = await created.json<AmbientMeetingResponse>();
  await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/transcript`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ segments: [{
      id: crypto.randomUUID(), meeting_id, speaker_id: 'ambient:ana', speaker_name: 'Ana', language: 'en',
      starts_at_ms: 1000, ends_at_ms: 1900, text: 'A line to erase.', is_final: true,
    }] }),
  }));
  await env.USAGE.prepare(`INSERT OR IGNORE INTO meetings_ledger (meeting_id, room_slug, host_email, started_at) VALUES (?1, 'rosa', 'rosa@example.com', 1)`)
    .bind(meeting_id).run();
  return meeting_id;
}

const erase = async (body: unknown, email = 'rosa@example.com') => exports.default.fetch(new Request('http://local/api/admin/erase-meeting', {
  method: 'POST',
  headers: await session(email, 'Rosa'),
  body: JSON.stringify(body),
}));

const room = () => env.ROOMS.getByName('rosa') as DurableObjectStub<RoomCoordinator>;
const rowsNaming = async (meetingId: string) => {
  const snapshot = await room().exportState();
  return Object.entries(snapshot.tables)
    .filter(([table]) => table !== 'erased_meetings')
    .flatMap(([, rows]) => rows as Array<Record<string, unknown>>)
    .filter((row) => row.meeting_id === meetingId || row.id === meetingId).length;
};

describe('POST /api/admin/erase-meeting', () => {
  it('erases every row of the meeting, keeps a marker with no content, and answers a retry with the same receipt', async () => {
    const meetingId = await endedMeeting();
    expect(await rowsNaming(meetingId)).toBeGreaterThan(0);
    const response = await erase({ room_slug: 'rosa', meeting_id: meetingId, request_id: 'dr-20261014-1' });
    expect(response.status).toBe(200);
    const receipt = await response.json<EraseMeetingResponse>();
    expect(receipt.steps.find((step) => step.store === 'room')?.result).toBe('erased');
    expect(receipt.backups_end_at - receipt.erased_at).toBe(30 * 24 * 60 * 60_000);
    expect(await rowsNaming(meetingId)).toBe(0);
    expect(await env.USAGE.prepare('SELECT 1 FROM meetings_ledger WHERE meeting_id = ?1').bind(meetingId).first()).toBeNull();
    const marker = (await room().exportState()).tables.erased_meetings as Array<Record<string, unknown>>;
    expect(marker.find((row) => row.meeting_id === meetingId)).toMatchObject({ request_id: 'dr-20261014-1' });

    const again = await (await erase({ room_slug: 'rosa', meeting_id: meetingId, request_id: 'dr-20261014-2' })).json<EraseMeetingResponse>();
    expect(again.erased_at).toBe(receipt.erased_at);
    expect(again.request_id).toBe('dr-20261014-1');
    const audit = await env.USAGE.prepare(`SELECT detail FROM admin_audit WHERE action = 'meeting.erase' AND subject = ?1`)
      .bind(`rosa/${meetingId}`).first<{ detail: string }>();
    expect(audit?.detail).toBe('dr-20261014-1');
  });

  it('does not bring an erased meeting back with a restore from before the erasure', async () => {
    const meetingId = await endedMeeting();
    const before = await room().exportState();
    expect((await erase({ room_slug: 'rosa', meeting_id: meetingId, request_id: 'dr-20261014-3' })).status).toBe(200);
    await room().importState(JSON.parse(JSON.stringify(before)));
    expect(await rowsNaming(meetingId)).toBe(0);
  });

  it('reports a failed downstream step, and the same request again finishes it', async () => {
    const meetingId = await endedMeeting();
    const actor = { sub: 'rosa@example.com', email: 'rosa@example.com', name: 'Rosa' };
    // D1 down for the first batch only: the ledger step fails, the room is already erased.
    let failures = 1;
    const flaky = new Proxy(env.USAGE, {
      get(target, key) {
        if (key === 'batch') {
          return (statements: D1PreparedStatement[]) => failures-- > 0
            ? Promise.reject(new Error('D1 unavailable'))
            : target.batch(statements);
        }
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const first = await eraseMeeting({ ...env, USAGE: flaky }, actor, { room_slug: 'rosa', meeting_id: meetingId, request_id: 'dr-20261015-1' });
    expect(first.steps.find((step) => step.store === 'ledger')?.result).toBe('failed');
    expect(first.steps.find((step) => step.store === 'room')?.result).toBe('erased');
    expect(await rowsNaming(meetingId)).toBe(0);
    expect(await env.USAGE.prepare('SELECT 1 FROM meetings_ledger WHERE meeting_id = ?1').bind(meetingId).first()).not.toBeNull();

    const retry = await (await erase({ room_slug: 'rosa', meeting_id: meetingId, request_id: 'dr-20261015-2' })).json<EraseMeetingResponse>();
    expect(retry.steps.find((step) => step.store === 'ledger')?.result).toBe('erased');
    expect(retry.erased_at).toBe(first.erased_at);
    expect(await env.USAGE.prepare('SELECT 1 FROM meetings_ledger WHERE meeting_id = ?1').bind(meetingId).first()).toBeNull();
    expect(await rowsNaming(meetingId)).toBe(0);
  });

  it('refuses a member, a malformed request id and a meeting that does not exist', async () => {
    const meetingId = await endedMeeting();
    expect((await erase({ room_slug: 'rosa', meeting_id: meetingId, request_id: 'dr-20261014-4' }, 'erase-member@example.com')).status).toBe(403);
    expect((await erase({ room_slug: 'rosa', meeting_id: meetingId, request_id: 'please' })).status).toBe(400);
    expect((await erase({ room_slug: 'rosa', meeting_id: crypto.randomUUID(), request_id: 'dr-20261014-5' })).status).toBe(404);
    expect(await rowsNaming(meetingId)).toBeGreaterThan(0);
  });
});

describe('POST /api/rooms/:slug/meetings/:id/erase', () => {
  const ownerErase = async (meetingId: string, email: string) => exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${meetingId}/erase`, {
    method: 'POST',
    headers: await session(email, 'Ada'),
    body: '{}',
  }));

  it('lets the room owner erase their own ended meeting, with the receipt', async () => {
    const meetingId = await endedMeeting();
    const response = await ownerErase(meetingId, 'rosa@example.com');
    expect(response.status).toBe(200);
    const receipt = await response.json<EraseMeetingResponse>();
    expect(receipt.request_id).toMatch(/^dr-\d{8}-\d{1,4}$/u);
    expect(receipt.steps.find((step) => step.store === 'room')?.result).toBe('erased');
    expect(await rowsNaming(meetingId)).toBe(0);
  });

  it('refuses a member who does not own the room, and leaves the meeting', async () => {
    const meetingId = await endedMeeting();
    expect((await ownerErase(meetingId, 'erase-member@example.com')).status).toBe(403);
    expect(await rowsNaming(meetingId)).toBeGreaterThan(0);
  });
});
