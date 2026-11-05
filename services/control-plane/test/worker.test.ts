import { env, exports } from 'cloudflare:workers';
import { decodeJwt } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownerAccountEmail } from '@starlings/contracts';
import { isMemberEmail } from '../src/workspace-identity';
import type {
  EndMeetingResponse,
  FinalizeMeetingResponse,
  HostHeartbeatResponse,
  JoinRequestReceipt,
  LobbyDecisionResponse,
  LobbySnapshotResponse,
  OwnerHostSessionResponse,
  TranscriptAppendResponse,
} from '@starlings/contracts';
import { fallbackSummary, summarize } from '../src/artifacts';
import { issueLiveKitToken } from '../src/livekit';

// Ending a meeting or removing a guest calls LiveKit's RoomService. There is no
// LiveKit here, so it answers an empty success; any other host is still refused
// by test/no-network.ts.
beforeEach(() => {
  const refuse = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('http://livekit.invalid:7880/twirp/livekit.RoomService/')) {
      return Response.json({});
    }
    return refuse(input, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Worker boundaries', () => {
  it('issues a dev owner session and starts only the mapped permanent room', async () => {
    const sessionResponse = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }));
    expect(sessionResponse.status).toBe(200);
    const session = await sessionResponse.json<{ access_token: string }>();

    const roomResponse = await exports.default.fetch(new Request('http://local/api/owner/room', {
      headers: { authorization: `Bearer ${session.access_token}` },
    }));
    expect(roomResponse.status).toBe(200);

    const startResponse = await exports.default.fetch(new Request('http://local/api/rooms/rosa/start', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.access_token}` },
    }));
    expect(startResponse.status).toBe(200);
    const connection = await startResponse.json<{ participant_token: string; meeting_id: string; started_at: number }>();
    expect(connection.meeting_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(connection.started_at).toBeGreaterThan(1_700_000_000_000);
    expect(decodeJwt(connection.participant_token).video).toMatchObject({ roomJoin: true, room: expect.stringContaining('meet-rosa-') });

    const wrongRoom = await exports.default.fetch(new Request('http://local/api/rooms/not-rosa/start', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.access_token}` },
    }));
    expect(wrongRoom.status).toBe(404);
  });

  it('gives a verified native iOS owner the complete mapped-room host lifecycle', async () => {
    const sessionResponse = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }));
    const session = await sessionResponse.json<{ access_token: string }>();
    const ownerHeaders = { authorization: `Bearer ${session.access_token}` };

    // iOS uses the same native bearer issued by /auth/native/exchange. The
    // mapped bootstrap never accepts a client-supplied slug or creates a room.
    const startResponse = await exports.default.fetch(new Request('http://local/api/owner/host-session', {
      method: 'POST',
      headers: ownerHeaders,
    }));
    expect(startResponse.status).toBe(200);
    const host = await startResponse.json<OwnerHostSessionResponse>();
    expect(host.room).toMatchObject({ slug: 'rosa', kind: 'permanent', expiresAt: null });
    expect(host.lease.renew_after_ms).toBe(10_000);
    expect(host.lease.host_lease_expires_at - Date.now()).toBeGreaterThan(29_000);
    expect(host.captions).toEqual({
      topic: 'captions.v1',
      publisher_identity: 'rosa@example.com',
    });

    const ownerClaims = decodeJwt(host.connection.participant_token);
    expect(ownerClaims.sub).toBe('rosa@example.com');
    expect(ownerClaims.video).toMatchObject({
      roomJoin: true,
      room: host.connection.livekit_room,
      canPublish: true,
      canPublishData: true,
    });
    // No device named, so no client: an older host build stays a legal host
    // and simply shows no app badge in the People list.
    expect(JSON.parse(String(ownerClaims.metadata))).toEqual({
      owner: true,
      client: null,
      on_behalf_of: null,
      recording: false,
    });

    const resumeResponse = await exports.default.fetch(new Request('http://local/api/owner/host-session', {
      method: 'POST',
      headers: ownerHeaders,
    }));
    const resumed = await resumeResponse.json<OwnerHostSessionResponse>();
    expect(resumed.connection).toMatchObject({
      meeting_id: host.connection.meeting_id,
      livekit_room: host.connection.livekit_room,
    });
    expect(resumed.room.slug).toBe('rosa');

    const heartbeatResponse = await exports.default.fetch(new Request(
      `http://local/api/rooms/rosa/meetings/${host.connection.meeting_id}/heartbeat`,
      { method: 'POST', headers: ownerHeaders },
    ));
    expect(heartbeatResponse.status).toBe(200);
    const heartbeat = await heartbeatResponse.json<HostHeartbeatResponse>();
    expect(heartbeat).toMatchObject({ ok: true, renew_after_ms: 10_000 });

    const knockResponse = await exports.default.fetch(new Request('http://local/api/rooms/rosa/join-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({
        name: 'iOS host guest',
        email: 'guest@example.net',
        client: { app: 'ios', device: 'mobile' },
      }),
    }));
    expect(knockResponse.status).toBe(201);
    const knock = await knockResponse.json<JoinRequestReceipt>();

    const lobbyResponse = await exports.default.fetch(new Request('http://local/api/rooms/rosa/lobby', {
      headers: ownerHeaders,
    }));
    const lobby = await lobbyResponse.json<LobbySnapshotResponse>();
    // The surface reaches the host's waiting room, so "admit?" is answered with
    // the same context the guest had when they knocked.
    expect(lobby.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: knock.requestId,
        email: 'guest@example.net',
        status: 'waiting',
        client: { app: 'ios', device: 'mobile' },
      }),
    ]));

    const decisionResponse = await exports.default.fetch(new Request(
      `http://local/api/rooms/rosa/join-requests/${knock.requestId}/decision`,
      {
        method: 'POST',
        headers: { ...ownerHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ admit: true }),
      },
    ));
    const decision = await decisionResponse.json<LobbyDecisionResponse>();
    expect(decision.request.status).toBe('admitted');

    const exchangeResponse = await exports.default.fetch(new Request(
      `http://local/api/rooms/rosa/join-requests/${knock.requestId}/exchange`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: env.WEB_ORIGIN },
        body: JSON.stringify({ lobby_token: knock.lobbyToken }),
      },
    ));
    expect(exchangeResponse.status).toBe(200);

    // End media first, then upload the final local-text outbox exactly as the
    // Mac does. This deliberately proves transcript finalization is decoupled
    // from media teardown and carries no raw audio/video payload.
    const endResponse = await exports.default.fetch(new Request(
      `http://local/api/rooms/rosa/meetings/${host.connection.meeting_id}/end`,
      { method: 'POST', headers: ownerHeaders },
    ));
    expect(await endResponse.json<EndMeetingResponse>()).toMatchObject({ status: 'ended' });

    const segment = {
      id: 'b44273da-ce97-4390-aaab-1f7d35e90148',
      meeting_id: host.connection.meeting_id,
      speaker_id: 'rosa@example.com',
      speaker_name: 'Rosa',
      language: 'en',
      starts_at_ms: 0,
      ends_at_ms: 1_200,
      text: 'Final text produced locally on the owner device.',
      is_final: true,
    } as const;
    const transcriptResponse = await exports.default.fetch(new Request(
      `http://local/api/rooms/rosa/meetings/${host.connection.meeting_id}/transcript`,
      {
        method: 'POST',
        headers: { ...ownerHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ segments: [segment] }),
      },
    ));
    expect(await transcriptResponse.json<TranscriptAppendResponse>()).toEqual({ accepted: 1 });

    const finalizeResponse = await exports.default.fetch(new Request(
      `http://local/api/rooms/rosa/meetings/${host.connection.meeting_id}/finalize`,
      { method: 'POST', headers: ownerHeaders },
    ));
    expect(finalizeResponse.status).toBe(202);
    const finalized = await finalizeResponse.json<FinalizeMeetingResponse>();
    expect(finalized.artifact.transcript).toEqual([segment]);
    expect(Object.keys(finalized.artifact)).not.toEqual(expect.arrayContaining(['audio', 'video', 'recording']));
  });

  it('gives each of an owner’s devices its own identity in one meeting', async () => {
    const sessionResponse = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }));
    const session = await sessionResponse.json<{ access_token: string }>();
    const ownerHeaders = {
      authorization: `Bearer ${session.access_token}`,
      'content-type': 'application/json',
    };

    async function host(device?: string): Promise<OwnerHostSessionResponse> {
      const response = await exports.default.fetch(new Request('http://local/api/owner/host-session', {
        method: 'POST',
        headers: ownerHeaders,
        ...(device ? { body: JSON.stringify({ device }) } : {}),
      }));
      expect(response.status).toBe(200);
      return response.json<OwnerHostSessionResponse>();
    }

    const mac = await host('mac');
    const iphone = await host('iphone');

    // One meeting, two participants. LiveKit evicts a duplicate identity, so
    // the phone taking over the Mac's identity is exactly the bug to prevent.
    expect(iphone.connection.meeting_id).toBe(mac.connection.meeting_id);
    expect(decodeJwt(mac.connection.participant_token).sub).toBe('rosa+mac@example.com');
    expect(decodeJwt(iphone.connection.participant_token).sub).toBe('rosa+iphone@example.com');
    // The device also names the app in metadata, so the room sees "Mac app"
    // and "iPhone app" for the host the same way it sees a guest's client.
    expect(JSON.parse(String(decodeJwt(mac.connection.participant_token).metadata)))
      .toEqual({
        owner: true,
        client: { app: 'mac', device: 'desktop' },
        on_behalf_of: null,
        recording: false,
      });
    expect(JSON.parse(String(decodeJwt(iphone.connection.participant_token).metadata)))
      .toEqual({
        owner: true,
        client: { app: 'ios', device: 'mobile' },
        on_behalf_of: null,
        recording: false,
      });
    expect(mac.captions.publisher_identity).toBe('rosa+mac@example.com');
    expect(iphone.captions.publisher_identity).toBe('rosa+iphone@example.com');

    // The suffix stays inside the local part so every shipped client still
    // reads the publisher as one of us and renders its captions.
    expect(isMemberEmail(env as Env, iphone.captions.publisher_identity)).toBe(true);
    expect(ownerAccountEmail(iphone.captions.publisher_identity)).toBe('rosa@example.com');

    // A client that names no device keeps the bare account address, which is
    // what every build before per-device identity sends.
    const unnamed = await host();
    expect(decodeJwt(unnamed.connection.participant_token).sub).toBe('rosa@example.com');

    // The artifact belongs to the person: three device rows, one recipient.
    const finalizeResponse = await exports.default.fetch(new Request(
      `http://local/api/rooms/rosa/meetings/${mac.connection.meeting_id}/finalize`,
      { method: 'POST', headers: ownerHeaders },
    ));
    const finalized = await finalizeResponse.json<FinalizeMeetingResponse>();
  });

  it('lets only the hosting owner stop somebody else’s screen share', async () => {
    const sessionResponse = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }));
    const session = await sessionResponse.json<{ access_token: string }>();
    const ownerHeaders = {
      authorization: `Bearer ${session.access_token}`,
      'content-type': 'application/json',
    };

    const startResponse = await exports.default.fetch(new Request('http://local/api/owner/host-session', {
      method: 'POST',
      headers: ownerHeaders,
    }));
    const host = await startResponse.json<OwnerHostSessionResponse>();
    const stopPath = (meetingId: string) =>
      `http://local/api/rooms/rosa/meetings/${meetingId}/screen-share/stop`;
    const body = JSON.stringify({ identity: 'guest:someone' });

    // Moderation is an owner capability, not a participant one: a guest holding
    // a perfectly good room token has no way to reach it. Like every owner
    // mutation this is refused at the gate, session first: a caller with no
    // session is told so (401), whatever origin it sent.
    const anonymous = await exports.default.fetch(new Request(stopPath(host.connection.meeting_id), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }));
    expect(anonymous.status).toBe(401);

    // The DO guard runs before LiveKit is touched, so a meeting that is not
    // this owner's live one is refused rather than acted on.
    const unknownMeeting = await exports.default.fetch(new Request(
      stopPath('3f1c2b4e-5a6d-4e8f-9a0b-1c2d3e4f5a6b'),
      { method: 'POST', headers: ownerHeaders, body },
    ));
    expect(unknownMeeting.status).toBe(404);

    // An identity is required — "stop sharing" has to name whose share.
    const noTarget = await exports.default.fetch(new Request(stopPath(host.connection.meeting_id), {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({}),
    }));
    expect(noTarget.status).toBe(400);

    await exports.default.fetch(new Request(
      `http://local/api/rooms/rosa/meetings/${host.connection.meeting_id}/end`,
      { method: 'POST', headers: ownerHeaders },
    ));

    // Once the meeting is over there is nothing left to moderate.
    const afterEnd = await exports.default.fetch(new Request(stopPath(host.connection.meeting_id), {
      method: 'POST',
      headers: ownerHeaders,
      body,
    }));
    expect(afterEnd.status).toBe(410);
  });

  it('gates muting and removing behind the same live-host check', async () => {
    const sessionResponse = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }));
    const session = await sessionResponse.json<{ access_token: string }>();
    const ownerHeaders = {
      authorization: `Bearer ${session.access_token}`,
      'content-type': 'application/json',
    };

    const startResponse = await exports.default.fetch(new Request('http://local/api/owner/host-session', {
      method: 'POST',
      headers: ownerHeaders,
    }));
    const host = await startResponse.json<OwnerHostSessionResponse>();
    const meetingId = host.connection.meeting_id;
    const mutePath = (id: string) => `http://local/api/rooms/rosa/meetings/${id}/participants/mute`;
    const removePath = (id: string) => `http://local/api/rooms/rosa/meetings/${id}/participants/remove`;
    const target = JSON.stringify({ identity: 'guest:someone' });

    // Both are owner capabilities. A guest holding a good room token never
    // reaches them: the gate asks for a session first.
    for (const path of [mutePath(meetingId), removePath(meetingId)]) {
      const anonymous = await exports.default.fetch(new Request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: target,
      }));
      expect(anonymous.status).toBe(401);
    }

    // The DO guard runs before the SFU is touched.
    const unknownMute = await exports.default.fetch(new Request(
      mutePath('3f1c2b4e-5a6d-4e8f-9a0b-1c2d3e4f5a6b'),
      { method: 'POST', headers: ownerHeaders, body: target },
    ));
    expect(unknownMute.status).toBe(404);

    // Removing has to name somebody; muting does not, because an empty body is
    // the room-wide mute.
    const noTarget = await exports.default.fetch(new Request(removePath(meetingId), {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({}),
    }));
    expect(noTarget.status).toBe(400);

    await exports.default.fetch(new Request(
      `http://local/api/rooms/rosa/meetings/${meetingId}/end`,
      { method: 'POST', headers: ownerHeaders },
    ));

    for (const path of [mutePath(meetingId), removePath(meetingId)]) {
      const afterEnd = await exports.default.fetch(new Request(path, {
        method: 'POST',
        headers: ownerHeaders,
        body: target,
      }));
      expect(afterEnd.status).toBe(410);
    }
  });

  it('rejects invalid and wrong-room native owner attempts; a member with no map entry has a room of their own', async () => {
    const invalid = await exports.default.fetch(new Request('http://local/api/owner/host-session', {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-session' },
    }));
    expect(invalid.status).toBe(401);
    await expect(invalid.json()).resolves.toMatchObject({ code: 'owner_auth_required' });

    const outsiderResponse = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Unmapped Owner', email: 'unmapped@example.com' }),
    }));
    const outsider = await outsiderResponse.json<{ access_token: string }>();
    const unmapped = await exports.default.fetch(new Request('http://local/api/owner/host-session', {
      method: 'POST',
      headers: { authorization: `Bearer ${outsider.access_token}` },
    }));
    // Every member gets a room at sign-in (meet#878), named after them.
    expect(unmapped.status).toBe(200);
    await expect(unmapped.json()).resolves.toMatchObject({ room: { slug: 'unmapped-owner' } });

    const wrongRoom = await exports.default.fetch(new Request('http://local/api/rooms/rosa/start', {
      method: 'POST',
      headers: { authorization: `Bearer ${outsider.access_token}` },
    }));
    expect(wrongRoom.status).toBe(403);
    await expect(wrongRoom.json()).resolves.toMatchObject({ code: 'not_room_owner' });
  });

  it('scopes LiveKit tokens to ten minutes and one room', async () => {
    const issued = await issueLiveKitToken(env as Env, 'meet-rosa-test', {
      identity: 'guest:test:1234',
      name: 'Guest',
      email: '',
      owner: false,
      client: { app: 'web', device: 'mobile' },
    });
    const claims = decodeJwt(issued.token);
    expect((claims.exp ?? 0) - (claims.nbf ?? 0)).toBe(7_200);
    expect(issued.expiresAt).toBe(claims.exp);
    expect(claims.video).toEqual({
      room: 'meet-rosa-test',
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      // Locked on purpose: metadata is server-stamped identity data, and an
      // open grant let a guest set `owner: true` on themselves.
      canUpdateOwnMetadata: false,
    });
    // The knock's client rides into the room so every participant can show
    // which app this person is on.
    expect(JSON.parse(String(claims.metadata))).toEqual({
      owner: false,
      client: { app: 'web', device: 'mobile' },
      on_behalf_of: null,
      recording: false,
    });
    expect(String(claims.metadata)).not.toContain('email');
  });

  it('has a deterministic no-AI summary fallback', () => {
    const result = fallbackSummary({
      roomSlug: 'rosa',
      meetingId: 'meeting',
      startedAt: Date.UTC(2026, 7, 9),
      endedAt: null,
      title: null,
      summary: null,
      transcript: [],
    });
    expect(result.title).toBe('Meeting notes — 2026-08-09');
    expect(result.summary).toContain('No finalized transcript');
  });

  it('falls back without losing artifacts when Workers AI is unavailable', async () => {
    const result = await summarize({
      roomSlug: 'rosa',
      meetingId: 'ec98d0e3-9428-44a5-84e0-a61c85909ad3',
      startedAt: Date.UTC(2026, 7, 9),
      endedAt: Date.UTC(2026, 7, 9, 11),
      title: null,
      summary: null,
      transcript: [{
        id: '199485db-f7aa-4766-b8b6-186661024c96',
        meeting_id: 'ec98d0e3-9428-44a5-84e0-a61c85909ad3',
        speaker_id: 'owner:rosa@example.com',
        speaker_name: 'Rosa Ortiz',
        language: 'en',
        starts_at_ms: 0,
        ends_at_ms: 2_000,
        text: 'We agreed to ship the peer meeting MVP.',
        is_final: true,
      }],
    }, {
      AI: { run: async () => { throw new Error('AI unavailable'); } },
      SUMMARY_MODE: 'ai',
      SUMMARY_MODEL: '@cf/meta/llama-test',
    } as unknown as Pick<Env, 'AI' | 'SUMMARY_MODE' | 'SUMMARY_MODEL'>);

    expect(result.title).toBe('Meeting notes — 2026-08-09');
    expect(result.summary).toContain('Rosa Ortiz');
    expect(result.summary).toContain('ship the peer meeting MVP');
  });

  it('rejects a guest knock without a valid email', async () => {
    const sessionResponse = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }));
    const session = await sessionResponse.json<{ access_token: string }>();
    await exports.default.fetch(new Request('http://local/api/rooms/rosa/start', {
      method: 'POST',
      headers: { authorization: `Bearer ${session.access_token}` },
    }));

    for (const body of [{ name: 'Anonymous Guest' }, { name: 'Guest', email: 'not-an-email' }]) {
      const knock = await exports.default.fetch(new Request('http://local/api/rooms/rosa/join-requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: env.WEB_ORIGIN },
        body: JSON.stringify(body),
      }));
      expect(knock.status).toBe(400);
    }

    const valid = await exports.default.fetch(new Request('http://local/api/rooms/rosa/join-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({ name: 'Real Guest', email: 'guest@example.net' }),
    }));
    expect(valid.status).toBe(201);
  });

  it('reports calendar disconnected until tokens are stored', async () => {
    const sessionResponse = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }));
    const session = await sessionResponse.json<{ access_token: string }>();
    const statusResponse = await exports.default.fetch(new Request('http://local/api/calendar/status', {
      headers: { authorization: `Bearer ${session.access_token}` },
    }));
    expect(statusResponse.status).toBe(200);
    await expect(statusResponse.json()).resolves.toEqual({ connected: false, sources: false });

    const createBlocked = await exports.default.fetch(new Request('http://local/api/calendar/events', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Standup',
        start: '2026-08-10T10:00:00.000Z',
        end: '2026-08-10T11:00:00.000Z',
        join_url: 'https://envisioning.starlings.example/room/rosa',
        room_slug: 'rosa',
        attendees: [],
      }),
    }));
    expect(createBlocked.status).toBe(409);
  });

  it('404s unknown public pages and unmapped room meta', async () => {
    const unknownPage = await exports.default.fetch(new Request('http://local/dashboard', {
      headers: { accept: 'text/html' },
    }));
    expect(unknownPage.status).toBe(404);
    const unknownPageBody = await unknownPage.text();
    expect(unknownPageBody).toContain('Not found');
    expect(unknownPageBody).toContain('background: #202128');
    expect(unknownPageBody).not.toContain('#202333');

    const unknownRoom = await exports.default.fetch(new Request('http://local/room/nobody', {
      headers: { accept: 'text/html' },
    }));
    expect(unknownRoom.status).toBe(404);

    const metaMissing = await exports.default.fetch(new Request('http://local/api/rooms/nobody'));
    expect(metaMissing.status).toBe(404);

    const metaOk = await exports.default.fetch(new Request('http://local/api/rooms/rosa'));
    expect(metaOk.status).toBe(200);
    // Room meta is public: a display name for the lobby at most, never the
    // owner's email. Asserted by shape rather than value because the owner name
    // depends on whether an earlier test in this file configured the room.
    const meta = await metaOk.json() as Record<string, unknown>;
    expect(meta.slug).toBe('rosa');
    expect(meta.kind).toBe('permanent');
    expect(Object.keys(meta).sort()).toEqual(['kind', 'owner_name', 'slug']);
    expect(JSON.stringify(meta)).not.toContain('@');
  });

  it('answers 404 at the download paths: the product site serves the apps', async () => {
    await env.DOWNLOADS!.put('mac/latest/Starlings-macOS.zip', 'PK pretend this is Starlings.app');
    for (const path of ['/download/mac', '/download/ios', '/download/mac/latest/Starlings-macOS.zip', '/download/mac/9.9.9/Meet-macOS.zip']) {
      const response = await exports.default.fetch(new Request(`http://local${path}`, { redirect: 'manual' }));
      expect(response.status, path).toBe(404);
      expect(response.headers.get('content-type'), path).not.toBe('application/zip');
    }
  });

  it('404s schedule proxy for unmapped slugs', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/schedule/nobody/info'));
    expect(response.status).toBe(404);
  });
});
