import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_LEASE_MILLISECONDS,
  STALE_MEETING_MILLISECONDS,
  deviceScopedOwnerIdentity,
  type HostHeartbeatResponse,
  type HostMutationResponse,
  type JoinRequestReceipt,
  type JoinStatusResponse,
  type LobbySnapshotResponse,
} from '@starlings/contracts';
import worker from '../src/index';
import { issueNativeSession } from '../src/auth';

/**
 * The host lease and the guest reconnect rule, through the HTTP routes
 * (meet#958). `room-coordinator.test.ts` and `host-handover.test.ts` prove the
 * same invariants on the Durable Object. Here every step goes through the
 * route table: the session and room gates, the web-origin and lobby-token
 * checks on the guest doors, and the LiveKit credential the exchange mints.
 *
 * Time is the test clock (`Date` only): the Worker and the room's Durable
 * Object run in this isolate and read it. Each case has its own room, so no
 * case sees another case's meeting.
 */

/** Who LiveKit says is in the call, for the claim and release routes. */
let inCall: string[] = [];

beforeEach(() => {
  inCall = [];
  // The claim and release routes read the SFU roster; the heartbeat moves the
  // Host badge. There is no LiveKit here: the roster is `inCall`, and every
  // other RoomService call answers an empty success. Any other host is still
  // refused by test/no-network.ts.
  const refuse = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'http://livekit.invalid:7880/twirp/livekit.RoomService/ListParticipants') {
      return Response.json({ participants: inCall.map((identity) => ({ identity })) });
    }
    if (url.startsWith('http://livekit.invalid:7880/twirp/livekit.RoomService/')) return Response.json({});
    return refuse(input, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const T0 = Date.parse('2026-10-10T09:00:00.000Z');

function at(offset: number): void {
  vi.setSystemTime(T0 + offset);
}

/** One request through the route table, with its `waitUntil` work finished. */
async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`http://local${path}`, init), env, context);
  await waitOnExecutionContext(context);
  return response;
}

async function body<T>(response: Response): Promise<T> {
  return response.json<T>();
}

/** The error code a refusal carries. */
async function code(response: Response): Promise<string | undefined> {
  return (await body<{ code?: string }>(response)).code;
}

interface Host {
  slug: string;
  ownerSub: string;
  /** One signed-in Mac: its bearer and its LiveKit identity. */
  device: (name: string) => Promise<Device>;
}

interface Device {
  identity: string;
  headers: Record<string, string>;
}

/**
 * A room of its own, owned by one member. The room row is the only thing set
 * up directly: the route table serves any slug its owner holds, and a fresh
 * slug per case is what keeps the cases apart.
 */
async function hostRoom(slug: string): Promise<Host> {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(0);
  const owner = { sub: `lease-${slug}`, email: `${slug}@example.com`, name: 'Lease Host' };
  await env.ROOMS.getByName(slug).configureRoom({
    slug,
    ownerSub: owner.sub,
    ownerEmail: owner.email,
    kind: 'permanent',
    expiresAt: null,
  });
  return {
    slug,
    ownerSub: owner.sub,
    device: async (name: string) => {
      const context = createExecutionContext();
      const session = await issueNativeSession(owner, env, { lastClient: 'mac', deviceID: name, ctx: context });
      await waitOnExecutionContext(context);
      return {
        identity: deviceScopedOwnerIdentity(owner.email, 'mac', session.deviceID),
        headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
      };
    },
  };
}

async function start(host: Host, device: Device): Promise<string> {
  const response = await call(`/api/rooms/${host.slug}/start`, {
    method: 'POST',
    headers: device.headers,
    body: JSON.stringify({ device: 'mac' }),
  });
  expect(response.status).toBe(200);
  return (await body<{ meeting_id: string }>(response)).meeting_id;
}

function heartbeat(host: Host, meetingId: string, headers: Record<string, string>): Promise<Response> {
  return call(`/api/rooms/${host.slug}/meetings/${meetingId}/heartbeat`, { method: 'POST', headers });
}

async function lobby(host: Host, device: Device): Promise<LobbySnapshotResponse> {
  const response = await call(`/api/rooms/${host.slug}/lobby`, { headers: device.headers });
  expect(response.status).toBe(200);
  return body<LobbySnapshotResponse>(response);
}

const guestHeaders = { 'content-type': 'application/json', origin: env.WEB_ORIGIN };

async function knock(host: Host, name: string): Promise<JoinRequestReceipt> {
  const response = await call(`/api/rooms/${host.slug}/join-requests`, {
    method: 'POST',
    headers: guestHeaders,
    body: JSON.stringify({ name, email: `${name.toLowerCase()}@example.net` }),
  });
  expect(response.status).toBe(201);
  return body<JoinRequestReceipt>(response);
}

function decide(host: Host, device: Device, requestId: string, admit = true): Promise<Response> {
  return call(`/api/rooms/${host.slug}/join-requests/${requestId}/decision`, {
    method: 'POST',
    headers: device.headers,
    body: JSON.stringify({ admit }),
  });
}

function exchange(host: Host, receipt: JoinRequestReceipt, headers: Record<string, string> = guestHeaders, token = receipt.lobbyToken): Promise<Response> {
  return call(`/api/rooms/${host.slug}/join-requests/${receipt.requestId}/exchange`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ lobby_token: token }),
  });
}

/**
 * An exchange's outcome: the status, the error code, and whether a LiveKit
 * credential came back. The token itself is never read or printed.
 */
async function outcome(response: Response): Promise<{ status: number; code: string | null; credential: boolean }> {
  const answer = await body<{ code?: string; participant_token?: unknown }>(response);
  return {
    status: response.status,
    code: answer.code ?? null,
    credential: typeof answer.participant_token === 'string' && answer.participant_token.length > 0,
  };
}

const ADMITTED = { status: 200, code: null, credential: true };

async function joinStatus(host: Host, receipt: JoinRequestReceipt): Promise<JoinStatusResponse['status']> {
  const response = await call(`/api/rooms/${host.slug}/join-requests/${receipt.requestId}`, {
    headers: { authorization: `Bearer ${receipt.lobbyToken}` },
  });
  expect(response.status).toBe(200);
  return (await body<JoinStatusResponse>(response)).status;
}

describe('host lease and guest reconnect through the routes', () => {
  it('(a) refuses a waiting guest a credential until the host admits them', async () => {
    const host = await hostRoom('lease-waiting');
    const mac = await host.device('mac-a');
    const meetingId = await start(host, mac);
    const guest = await knock(host, 'Waiting');

    // The exchange door's own gates come first. Fails if the route stops
    // checking the web origin (`untrusted_origin`) or the lobby token
    // (`lobby_credentials_invalid`) before it reaches the room.
    expect(await outcome(await exchange(host, guest, { 'content-type': 'application/json' })))
      .toEqual({ status: 403, code: 'untrusted_origin', credential: false });
    expect(await outcome(await exchange(host, guest, guestHeaders, 'not-the-lobby-token')))
      .toEqual({ status: 401, code: 'lobby_credentials_invalid', credential: false });

    // Fails if the exchange mints a credential for a knock nobody admitted:
    // the 403 `guest_not_admitted` becomes a 200 with a LiveKit token.
    expect(await outcome(await exchange(host, guest)))
      .toEqual({ status: 403, code: 'guest_not_admitted', credential: false });
    expect(await joinStatus(host, guest)).toBe('waiting');

    // The same knock, once admitted under a live lease, gets its credential:
    // the refusal above was the admission rule, not a broken door.
    expect((await decide(host, mac, guest.requestId)).status).toBe(200);
    expect(await outcome(await exchange(host, guest))).toEqual(ADMITTED);
    expect((await lobby(host, mac)).requests).toEqual([
      expect.objectContaining({ id: guest.requestId, meetingId, status: 'joined' }),
    ]);
  });

  it('(b) refuses a first credential once the lease lapses, at HOST_LEASE_MILLISECONDS + 1', async () => {
    const host = await hostRoom('lease-first-join');
    const mac = await host.device('mac-a');
    const meetingId = await start(host, mac);
    const onTime = await knock(host, 'Ontime');
    const late = await knock(host, 'Late');
    const waiting = await knock(host, 'Queued');
    expect((await decide(host, mac, onTime.requestId)).status).toBe(200);
    expect((await decide(host, mac, late.requestId)).status).toBe(200);

    // The lease holds through its last millisecond. Fails if the boundary
    // moves to `>=`: this exchange would be refused `host_not_active`.
    at(HOST_LEASE_MILLISECONDS);
    expect(await outcome(await exchange(host, onTime))).toEqual(ADMITTED);

    // One millisecond later the host is gone. An admitted guest who never
    // joined gets no credential: fails if the route or the room lets the
    // reconnect exception cover a first join (a 200 with a token here).
    at(HOST_LEASE_MILLISECONDS + 1);
    expect(await outcome(await exchange(host, late)))
      .toEqual({ status: 409, code: 'host_not_active', credential: false });
    // Nor may a stale host screen admit anyone. Fails if `decide` stops
    // demanding the live lease.
    const lapsedDecision = await decide(host, mac, waiting.requestId);
    expect(lapsedDecision.status).toBe(409);
    expect(await code(lapsedDecision)).toBe('host_not_active');

    // The admission itself survives the lapse, and the host's heartbeat makes
    // it usable on the same meeting. Fails if a lapse expires an admission.
    expect(await joinStatus(host, late)).toBe('admitted');
    const renewed = await heartbeat(host, meetingId, mac.headers);
    expect(renewed.status).toBe(200);
    expect((await body<HostHeartbeatResponse>(renewed)).host_lease_expires_at).toBe(T0 + 2 * HOST_LEASE_MILLISECONDS + 1);
    expect(await outcome(await exchange(host, late))).toEqual(ADMITTED);

    const final = await lobby(host, mac);
    expect(final.meeting?.id).toBe(meetingId);
    expect(final.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: onTime.requestId, status: 'joined' }),
      expect.objectContaining({ id: late.requestId, status: 'joined' }),
      expect.objectContaining({ id: waiting.requestId, status: 'waiting' }),
    ]));
  });

  it('(c) lets a joined guest re-exchange through a lapse up to STALE_MEETING_MILLISECONDS, and not after', async () => {
    const host = await hostRoom('lease-reconnect');
    const mac = await host.device('mac-a');
    const meetingId = await start(host, mac);
    const guest = await knock(host, 'Reconnect');
    expect((await decide(host, mac, guest.requestId)).status).toBe(200);
    expect(await outcome(await exchange(host, guest))).toEqual(ADMITTED);

    // Lease long gone, meeting not yet stale: the reload gets back in. Fails
    // if the route drops the reconnect exception (409 `host_not_active`).
    at(HOST_LEASE_MILLISECONDS + 1);
    expect(await outcome(await exchange(host, guest))).toEqual(ADMITTED);

    // The last millisecond of the stale window still counts, for the
    // reconnect and for the sweep. Fails if either boundary moves to `>=`.
    at(STALE_MEETING_MILLISECONDS);
    expect(await outcome(await exchange(host, guest))).toEqual(ADMITTED);
    expect((await lobby(host, mac)).meeting?.id).toBe(meetingId);

    // One millisecond past it the meeting is over for the guest. Fails if
    // the reconnect exception outlives the stale window.
    at(STALE_MEETING_MILLISECONDS + 1);
    expect(await outcome(await exchange(host, guest)))
      .toEqual({ status: 409, code: 'host_not_active', credential: false });

    // The host's next read sweeps it, and the guest is told it ended. Fails
    // if the sweep leaves the meeting open.
    expect((await lobby(host, mac)).meeting).toBeNull();
    expect(await outcome(await exchange(host, guest)))
      .toEqual({ status: 410, code: 'meeting_ended', credential: false });
  });

  it('(d) never revives a swept meeting with a late heartbeat', async () => {
    const host = await hostRoom('lease-swept');
    const mac = await host.device('mac-a');
    const meetingId = await start(host, mac);
    const guest = await knock(host, 'Swept');
    expect((await decide(host, mac, guest.requestId)).status).toBe(200);
    expect(await outcome(await exchange(host, guest))).toEqual(ADMITTED);

    at(STALE_MEETING_MILLISECONDS + 1);
    expect((await lobby(host, mac)).meeting).toBeNull();

    // The Mac wakes and renews. Fails if a heartbeat can reopen an ended
    // meeting: a 200 here, then a credential for the guest below.
    const late = await heartbeat(host, meetingId, mac.headers);
    expect(late.status).toBe(410);
    expect(await code(late)).toBe('meeting_inactive');
    expect(await outcome(await exchange(host, guest)))
      .toEqual({ status: 410, code: 'meeting_ended', credential: false });

    // The next Start is a new meeting, not the swept one.
    const fresh = await start(host, mac);
    expect(fresh).not.toBe(meetingId);
    expect((await lobby(host, mac)).meeting?.id).toBe(fresh);
  });

  it('(d) never revives a stale meeting with a heartbeat that arrives before any sweep', async () => {
    const host = await hostRoom('lease-unswept');
    const mac = await host.device('mac-a');
    const meetingId = await start(host, mac);
    const guest = await knock(host, 'Unswept');
    expect((await decide(host, mac, guest.requestId)).status).toBe(200);
    expect(await outcome(await exchange(host, guest))).toEqual(ADMITTED);

    // Adversarial order: past the stale window the guest is refused first,
    // and the host's late heartbeat lands before anything read the meeting.
    at(STALE_MEETING_MILLISECONDS + 1);
    expect(await outcome(await exchange(host, guest)))
      .toEqual({ status: 409, code: 'host_not_active', credential: false });

    // Fails if the heartbeat renews a meeting that is already past the stale
    // window: the guest refused above would then get back in.
    const late = await heartbeat(host, meetingId, mac.headers);
    expect(late.status).toBe(410);
    expect(await code(late)).toBe('meeting_inactive');
    expect(await outcome(await exchange(host, guest)))
      .toEqual({ status: 410, code: 'meeting_ended', credential: false });
    expect((await lobby(host, mac)).meeting).toBeNull();
  });

  it('(e) refuses a heartbeat from the device the host moved away from', async () => {
    const host = await hostRoom('lease-handover');
    const macA = await host.device('mac-a');
    const macB = await host.device('mac-b');
    const meetingId = await start(host, macA);
    expect(await start(host, macB)).toBe(meetingId);
    inCall = [macA.identity, macB.identity];

    // The heartbeat door's own gates. Fails if the room-host gate lets a
    // caller with no session, or a member who does not own the room, renew.
    const anonymous = await heartbeat(host, meetingId, { 'content-type': 'application/json' });
    expect(anonymous.status).toBe(401);
    expect(await code(anonymous)).toBe('owner_auth_required');
    const stranger = await (await hostRoom('lease-handover-other')).device('mac-x');
    const foreign = await heartbeat(host, meetingId, stranger.headers);
    expect(foreign.status).toBe(403);
    expect(await code(foreign)).toBe('not_room_owner');

    // A companion cannot renew the host it does not hold.
    const companion = await heartbeat(host, meetingId, macB.headers);
    expect(companion.status).toBe(409);
    expect(await code(companion)).toBe('host_not_active');

    // B asks, A hands over.
    at(5_000);
    const claim = await call(`/api/rooms/${host.slug}/meetings/${meetingId}/host/claim`, {
      method: 'POST',
      headers: macB.headers,
      body: JSON.stringify({ device: 'mac' }),
    });
    expect(claim.status).toBe(200);
    expect(await body<HostMutationResponse>(claim)).toMatchObject({
      status: 'release_requested',
      host_identity: macA.identity,
      pending_identity: macB.identity,
    });
    const release = await call(`/api/rooms/${host.slug}/meetings/${meetingId}/host/release`, {
      method: 'POST',
      headers: macA.headers,
    });
    expect(release.status).toBe(200);
    expect(await body<HostMutationResponse>(release)).toMatchObject({
      status: 'released',
      host_identity: macB.identity,
      pending_identity: null,
    });

    // Adversarial order: A's heartbeat was in flight when it handed over.
    // Fails if the old device's renewal restores its authority: a 200, and
    // the lobby naming A as the host again.
    const stale = await heartbeat(host, meetingId, macA.headers);
    expect(stale.status).toBe(409);
    expect(await code(stale)).toBe('host_not_active');
    // A's Start does not take the host back while B's lease is live.
    expect(await start(host, macA)).toBe(meetingId);
    const renewed = await heartbeat(host, meetingId, macB.headers);
    expect(renewed.status).toBe(200);
    expect((await lobby(host, macB)).meeting).toMatchObject({
      id: meetingId,
      hostIdentity: macB.identity,
      pendingHostIdentity: null,
    });
  });

  it('(e) lets a Start take a lapsed host only past HOST_LEASE_MILLISECONDS, and the old device stays out', async () => {
    const host = await hostRoom('lease-takeover');
    const macA = await host.device('mac-a');
    const macB = await host.device('mac-b');
    const meetingId = await start(host, macA);

    // At the lease's last millisecond A still holds the host. Fails if the
    // takeover boundary moves to `>=`: B would take it here.
    at(HOST_LEASE_MILLISECONDS);
    expect(await start(host, macB)).toBe(meetingId);
    expect((await lobby(host, macB)).meeting?.hostIdentity).toBe(macA.identity);

    // One millisecond later the lease lapsed, and B's Start takes it.
    at(HOST_LEASE_MILLISECONDS + 1);
    expect(await start(host, macB)).toBe(meetingId);
    expect((await lobby(host, macB)).meeting?.hostIdentity).toBe(macB.identity);

    // A comes back from a dropped network and renews. Fails if a lapsed
    // host's heartbeat takes the meeting back from the device that took over.
    const late = await heartbeat(host, meetingId, macA.headers);
    expect(late.status).toBe(409);
    expect(await code(late)).toBe('host_not_active');
    expect((await heartbeat(host, meetingId, macB.headers)).status).toBe(200);
    expect((await lobby(host, macA)).meeting).toMatchObject({ id: meetingId, hostIdentity: macB.identity });
  });
});
