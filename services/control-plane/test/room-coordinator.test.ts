import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Each test fakes Date only. Faking setTimeout too froze the room's first
// start on a cold run and timed out at 30 s (cf:build, 2026-10-15).
afterEach(() => vi.useRealTimers());

describe('RoomCoordinator', () => {
  it('keeps one device on the host until the successor is ready', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T08:00:00Z'));
    const room = env.ROOMS.getByName('host-handoff-room');
    const owner = {
      sub: 'host-owner',
      email: 'host@example.com',
      name: 'Host Owner',
    };
    await room.configureRoom({
      slug: 'host-handoff-room',
      ownerSub: owner.sub,
      ownerEmail: owner.email,
      kind: 'permanent',
      expiresAt: null,
    });

    const hostA = await room.startMeeting(owner, 'host+mac-a@example.com', 'device-a');
    const companionB = await room.startMeeting(owner, 'host+mac-b@example.com', 'device-b');
    expect(companionB).toMatchObject({
      id: hostA.id,
      hostIdentity: 'host+mac-a@example.com',
      hostLeaseExpiresAt: hostA.hostLeaseExpiresAt,
    });

    let companionHeartbeat: unknown;
    try {
      await room.heartbeat(owner.sub, hostA.id, 'device-b');
    } catch (error) {
      companionHeartbeat = error;
    }
    expect(companionHeartbeat).toMatchObject({ code: 'host_not_active', status: 409 });

    const request = await room.claimHost(
      owner.sub,
      hostA.id,
      {
        deviceID: 'device-b',
        identity: 'host+mac-b@example.com',
        expected: 'host+mac-a@example.com',
        currentConnected: true,
        pendingConnected: false,
        ifVacant: false,
      },
    );
    expect(request).toMatchObject({
      status: 'release_requested',
      hostIdentity: 'host+mac-a@example.com',
      pendingIdentity: 'host+mac-b@example.com',
    });

    vi.setSystemTime(new Date('2026-09-29T08:00:12Z'));
    const transferred = await room.releaseHost(owner.sub, hostA.id, 'device-a', owner.email, true);
    expect(transferred).toMatchObject({
      hostIdentity: 'host+mac-b@example.com',
      pendingHostIdentity: null,
    });
    expect(transferred.hostLeaseExpiresAt).toBe(Date.now() + 30_000);

    let oldHostHeartbeat: unknown;
    try {
      await room.heartbeat(owner.sub, hostA.id, 'device-a');
    } catch (error) {
      oldHostHeartbeat = error;
    }
    expect(oldHostHeartbeat).toMatchObject({ code: 'host_not_active', status: 409 });
    await expect(room.heartbeat(owner.sub, hostA.id, 'device-b')).resolves.toBe(Date.now() + 30_000);

    const returningA = await room.startMeeting(owner, 'host+mac-a@example.com', 'device-a');
    expect(returningA).toMatchObject({
      id: hostA.id,
      hostIdentity: 'host+mac-b@example.com',
      hostLeaseExpiresAt: Date.now() + 30_000,
    });
  });

  it('lets a connected companion take an abandoned host without ending the meeting', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T09:00:00Z'));
    const room = env.ROOMS.getByName('host-crash-failover-room');
    const owner = {
      sub: 'host-crash-owner',
      email: 'host-crash@example.com',
      name: 'Host Crash Owner',
    };
    await room.configureRoom({
      slug: 'host-crash-failover-room',
      ownerSub: owner.sub,
      ownerEmail: owner.email,
      kind: 'permanent',
      expiresAt: null,
    });

    const hostA = await room.startMeeting(owner, 'host-crash+mac-a@example.com', 'device-a');
    await room.startMeeting(owner, 'host-crash+mac-b@example.com', 'device-b');
    vi.setSystemTime(new Date('2026-09-29T09:00:05Z'));
    const takeover = await room.claimHost(
      owner.sub,
      hostA.id,
      {
        deviceID: 'device-b',
        identity: 'host-crash+mac-b@example.com',
        expected: 'host-crash+mac-a@example.com',
        currentConnected: false,
        pendingConnected: false,
        ifVacant: false,
      },
    );
    expect(takeover).toMatchObject({
      status: 'host',
      hostIdentity: 'host-crash+mac-b@example.com',
      pendingIdentity: null,
    });
    expect((await room.lobbySnapshot(owner.sub)).meeting).toMatchObject({
      id: hostA.id,
      hostIdentity: 'host-crash+mac-b@example.com',
    });
    await expect(room.heartbeat(owner.sub, hostA.id, 'device-b')).resolves.toBe(Date.now() + 30_000);
  });

  it('remembers a graceful host release so the connected companion can claim after it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T10:00:00Z'));
    const room = env.ROOMS.getByName('host-release-room');
    const owner = {
      sub: 'host-release-owner',
      email: 'host-release@example.com',
      name: 'Host Release Owner',
    };
    await room.configureRoom({
      slug: 'host-release-room',
      ownerSub: owner.sub,
      ownerEmail: owner.email,
      kind: 'permanent',
      expiresAt: null,
    });

    const hostA = await room.startMeeting(owner, 'host-release+mac-a@example.com', 'device-a');
    await room.startMeeting(owner, 'host-release+mac-b@example.com', 'device-b');
    const released = await room.releaseHost(owner.sub, hostA.id, 'device-a', owner.email, false);
    expect(released.hostIdentity).toBeNull();
    await expect(room.hostState(owner.sub, hostA.id)).resolves.toMatchObject({ hostReleased: true });

    let oldHostHeartbeat: unknown;
    try {
      await room.heartbeat(owner.sub, hostA.id, 'device-a');
    } catch (error) {
      oldHostHeartbeat = error;
    }
    expect(oldHostHeartbeat).toMatchObject({ code: 'host_not_active', status: 409 });
    const takeover = await room.claimHost(
      owner.sub,
      hostA.id,
      {
        deviceID: 'device-b',
        identity: 'host-release+mac-b@example.com',
        expected: null,
        currentConnected: false,
        pendingConnected: false,
        ifVacant: false,
      },
    );
    expect(takeover).toMatchObject({
      status: 'host',
      hostIdentity: 'host-release+mac-b@example.com',
    });
  });

  it('coordinates owner start, guest admission, transcript, and final artifact', async () => {
    const room = env.ROOMS.getByName('integration-room');
    await room.configureRoom({
      slug: 'integration-room',
      ownerSub: 'google-owner-1',
      ownerEmail: 'owner@example.com',
      kind: 'permanent',
      expiresAt: null,
    });

    const meeting = await room.startMeeting({
      sub: 'google-owner-1',
      email: 'owner@example.com',
      name: 'Owner',
    });
    const receipt = await room.requestJoin({
      name: 'Ana',
      email: 'ana@example.net',
    });
    expect((await room.joinStatus(receipt.requestId, receipt.lobbyToken))).toMatchObject({
      status: 'waiting',
      waitingCount: 1,
    });

    const lobby = await room.lobbySnapshot('google-owner-1');
    expect(lobby.requests).toHaveLength(1);
    expect(lobby.requests[0]?.email).toBe('ana@example.net');
    await room.decide('google-owner-1', receipt.requestId, true);

    const admission = await room.exchangeAdmission(receipt.requestId, receipt.lobbyToken);
    expect(admission.livekitRoom).toBe(meeting.livekitRoom);
    expect(admission.identity).toMatch(/^guest:[A-Za-z0-9_-]+$/u);
    expect(admission.identity).not.toContain('ana@example.net');

    const accepted = await room.appendTranscript('google-owner-1', meeting.id, [{
      id: '75b3fae1-5154-4a6b-8d2d-9175067deab7',
      meeting_id: meeting.id,
      speaker_id: admission.identity,
      speaker_name: 'Ana',
      language: 'pt',
      starts_at_ms: 500,
      ends_at_ms: 1800,
      text: 'Olá, vamos começar.',
      is_final: true,
    }]);
    expect(accepted).toBe(1);

    const artifact = await room.finalizeMeeting('google-owner-1', meeting.id);
    expect(artifact.transcript).toHaveLength(1);
    expect((await room.artifactForViewer(meeting.id, admission.identity, 'guest')).transcript[0]?.language).toBe('pt');

    // A guest who reconnects after the owner ended the meeting must not be let
    // back into a room nobody is hosting. Caught directly, per the note below.
    let reentry: unknown;
    try {
      await room.exchangeAdmission(receipt.requestId, receipt.lobbyToken);
    } catch (error) {
      reentry = error;
    }
    expect(String(reentry)).toMatch(/has ended/iu);
  });

  it('ends a meeting without waiting on finalize, and stays idempotent', async () => {
    const room = env.ROOMS.getByName('end-room');
    await room.configureRoom({
      slug: 'end-room',
      ownerSub: 'end-owner',
      ownerEmail: 'end@example.com',
      kind: 'permanent',
      expiresAt: null,
    });
    const meeting = await room.startMeeting({
      sub: 'end-owner',
      email: 'end@example.com',
      name: 'End Owner',
    });

    const first = await room.endMeeting('end-owner', meeting.id);
    expect(first.alreadyEnded).toBe(false);
    expect(first.livekitRoom).toBeTruthy();

    const second = await room.endMeeting('end-owner', meeting.id);
    expect(second.alreadyEnded).toBe(true);
    expect(second.livekitRoom).toBe(first.livekitRoom);

    // Finalize after end still produces an artifact (notes email path).
    const artifact = await room.finalizeMeeting('end-owner', meeting.id);
    expect(artifact.meetingId).toBe(meeting.id);
  });
  it('keeps per-participant quality cumulative and owner-only', async () => {
    const room = env.ROOMS.getByName('quality-room');
    await room.configureRoom({
      slug: 'quality-room',
      ownerSub: 'quality-owner',
      ownerEmail: 'quality@example.com',
      kind: 'permanent',
      expiresAt: null,
    });
    const meeting = await room.startMeeting({
      sub: 'quality-owner',
      email: 'quality@example.com',
      name: 'Quality Owner',
    });

    await room.recordQuality(meeting.id, 'guest:abc', 'guest', {
      client: 'web',
      connected_ms: 60_000,
      excellent_ms: 50_000,
      good_ms: 10_000,
      poor_ms: 0,
      lost_ms: 0,
      reconnect_count: 0,
      worst_quality: 'good',
    });
    // A later flush replaces rather than adds, so a retried or duplicated
    // report can never inflate the totals.
    await room.recordQuality(meeting.id, 'guest:abc', 'guest', {
      client: 'web',
      connected_ms: 120_000,
      excellent_ms: 50_000,
      good_ms: 60_000,
      poor_ms: 10_000,
      lost_ms: 0,
      reconnect_count: 1,
      worst_quality: 'poor',
    });
    await room.recordQuality(meeting.id, 'quality@example.com', 'owner', {
      client: 'mac',
      connected_ms: 120_000,
      excellent_ms: 120_000,
      good_ms: 0,
      poor_ms: 0,
      lost_ms: 0,
      reconnect_count: 0,
      worst_quality: 'excellent',
    });

    const report = await room.meetingQuality('quality-owner', meeting.id);
    expect(report).toHaveLength(2);
    expect(report.find((row) => row.identity === 'guest:abc')).toMatchObject({
      client: 'web',
      role: 'guest',
      connectedMs: 120_000,
      goodMs: 60_000,
      poorMs: 10_000,
      reconnectCount: 1,
      worstQuality: 'poor',
    });

    // Caught directly rather than via `.rejects` so the RPC stub's promise is
    // settled exactly once and vitest sees no stray unhandled rejection.
    let denial: unknown;
    try {
      await room.meetingQuality('someone-else', meeting.id);
    } catch (error) {
      denial = error;
    }
    expect(String(denial)).toMatch(/room owner/iu);

    // Quality never rides along with the artifact that guests get emailed.
    const artifact = await room.finalizeMeeting('quality-owner', meeting.id);
    expect(JSON.stringify(artifact)).not.toContain('worstQuality');
  });

  it('persists a rejection so the guest never reaches admitted state', async () => {
    const room = env.ROOMS.getByName('closed-lobby');
    await room.configureRoom({
      slug: 'closed-lobby',
      ownerSub: 'owner-2',
      ownerEmail: 'owner2@example.com',
      kind: 'permanent',
      expiresAt: null,
    });
    await room.startMeeting({ sub: 'owner-2', email: 'owner2@example.com', name: 'Owner 2' });
    const receipt = await room.requestJoin({ name: 'Guest', email: '' });
    await room.decide('owner-2', receipt.requestId, false);
    expect((await room.joinStatus(receipt.requestId, receipt.lobbyToken)).status).toBe('rejected');
  });

  it('spends a removed participant’s admission and re-queues their next knock', async () => {
    const room = env.ROOMS.getByName('removal-room');
    await room.configureRoom({
      slug: 'removal-room',
      ownerSub: 'owner-remove',
      ownerEmail: 'owner-remove@example.com',
      kind: 'permanent',
      expiresAt: null,
    });
    const meeting = await room.startMeeting({
      sub: 'owner-remove',
      email: 'owner-remove@example.com',
      name: 'Owner',
    });

    // A colleague who walked straight in — the strongest case, because auto
    // admission is exactly what would undo the removal a second later.
    const receipt = await room.requestJoin(
      { name: 'Ada', email: 'ada@example.com' },
      'ada@example.com',
    );
    expect(receipt.status).toBe('admitted');
    const admission = await room.exchangeAdmission(receipt.requestId, receipt.lobbyToken);

    const removed = await room.removeParticipant('owner-remove', meeting.id, admission.identity);
    expect(removed).toMatchObject({ status: 'removed', email: 'ada@example.com' });

    // The credentials they still hold no longer buy a room token: without this
    // a removal would last only until the browser reconnected. Caught directly
    // rather than via `.rejects`, so the RPC stub's promise settles once.
    let denial: unknown;
    try {
      await room.exchangeAdmission(receipt.requestId, receipt.lobbyToken);
    } catch (error) {
      denial = error;
    }
    expect(denial).toMatchObject({ code: 'guest_removed', status: 403 });
    expect((await room.joinStatus(receipt.requestId, receipt.lobbyToken)).status).toBe('removed');

    // Knocking again is allowed — and is a knock, not a walk-in, even for a
    // verified member. The host decides a second time.
    const second = await room.requestJoin(
      { name: 'Ada', email: 'ada@example.com' },
      'ada@example.com',
    );
    expect(second.status).toBe('waiting');

    // Somebody who never came through the lobby — the owner's own Mac — has no
    // admission to spend, and that is not an error.
    expect(await room.removeParticipant('owner-remove', meeting.id, 'owner-remove@example.com'))
      .toBeNull();
  });

  it('admits guests only while the native owner host lease is alive', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-09T10:00:00Z'));
    const room = env.ROOMS.getByName('host-lease-room');
    await room.configureRoom({
      slug: 'host-lease-room',
      ownerSub: 'lease-owner',
      ownerEmail: 'lease@example.com',
      kind: 'permanent',
      expiresAt: null,
    });
    const meeting = await room.startMeeting({
      sub: 'lease-owner',
      email: 'lease@example.com',
      name: 'Lease Owner',
    });
    const waiting = await room.requestJoin({ name: 'Waiting guest', email: '' });

    // One missed heartbeat window is a lapse, not an ending: the knock rides
    // out the grace period before it expires, but it cannot be admitted.
    vi.setSystemTime(new Date('2026-08-09T10:00:31Z'));
    expect((await room.joinStatus(waiting.requestId, waiting.lobbyToken)).status).toBe('waiting');
    let staleAdmission: unknown;
    try {
      await room.decide('lease-owner', waiting.requestId, true);
    } catch (error) {
      staleAdmission = error;
    }
    expect(String(staleAdmission)).toMatch(/no longer actively hosting/iu);

    // Renewing the same existing lease makes the decision valid; no new room or
    // meeting is created for a returning iOS/macOS host.
    await room.heartbeat('lease-owner', meeting.id, null, 'lease@example.com');
    await expect(room.decide('lease-owner', waiting.requestId, true))
      .resolves.toMatchObject({ status: 'admitted', meetingId: meeting.id });

    const expiring = await room.requestJoin({ name: 'Expiring guest', email: '' });
    vi.setSystemTime(new Date('2026-08-09T10:01:31Z'));
    expect((await room.joinStatus(expiring.requestId, expiring.lobbyToken)).status).toBe('waiting');
    vi.setSystemTime(new Date('2026-08-09T10:02:02Z'));
    expect((await room.joinStatus(expiring.requestId, expiring.lobbyToken)).status).toBe('expired');

    await room.heartbeat('lease-owner', meeting.id, null, 'lease@example.com');
    await expect(room.requestJoin({ name: 'Active guest', email: '' }))
      .resolves.toMatchObject({ status: 'waiting' });
  });

  it('keeps live-meeting knocks on the open meeting when only soft presence is fresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-10T08:00:00Z'));
    const room = env.ROOMS.getByName('soft-while-live-room');
    await room.configureRoom({
      slug: 'soft-while-live-room',
      ownerSub: 'soft-live-owner',
      ownerEmail: 'soft-live@example.com',
      kind: 'permanent',
      expiresAt: null,
    });
    const meeting = await room.startMeeting({
      sub: 'soft-live-owner',
      email: 'soft-live@example.com',
      name: 'Soft Live',
    });

    // Meeting lease is stale, but the Mac is still on the clock (soft presence).
    // Knocks must not park on __prelive__ or the in-meeting lobby stays empty.
    vi.setSystemTime(new Date('2026-08-10T08:00:31Z'));
    await room.touchPresence('soft-live-owner');
    const receipt = await room.requestJoin({
      name: 'Orphan risk',
      email: 'guest@example.net',
    });
    const snapshot = await room.lobbySnapshot('soft-live-owner');
    expect(snapshot.meeting?.id).toBe(meeting.id);
    expect(snapshot.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: receipt.requestId, meetingId: meeting.id, status: 'waiting' }),
    ]));
  });

  it('closes a meeting the host abandoned, and starts a fresh one on the next Start', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-11T09:00:00Z'));
    const room = env.ROOMS.getByName('abandoned-room');
    await room.configureRoom({
      slug: 'abandoned-room',
      ownerSub: 'abandoned-owner',
      ownerEmail: 'abandoned@example.com',
      kind: 'permanent',
      expiresAt: null,
    });
    const crashed = await room.startMeeting({
      sub: 'abandoned-owner',
      email: 'abandoned@example.com',
      name: 'Abandoned Owner',
    });

    // Nine minutes of silence is still a lapse — Start reclaims the same
    // meeting, so a host who quit and reopened the app keeps their room.
    vi.setSystemTime(new Date('2026-08-11T09:09:00Z'));
    expect((await room.lobbySnapshot('abandoned-owner')).meeting?.id).toBe(crashed.id);
    await expect(room.startMeeting({
      sub: 'abandoned-owner',
      email: 'abandoned@example.com',
      name: 'Abandoned Owner',
    })).resolves.toMatchObject({ id: crashed.id });

    // Past the stale window the launch screen must stop offering to reclaim it.
    vi.setSystemTime(new Date('2026-08-11T09:20:00Z'));
    expect((await room.lobbySnapshot('abandoned-owner')).meeting).toBeNull();

    const fresh = await room.startMeeting({
      sub: 'abandoned-owner',
      email: 'abandoned@example.com',
      name: 'Abandoned Owner',
    });
    expect(fresh.id).not.toBe(crashed.id);
    // The swept meeting is ended for good — a late heartbeat cannot revive it.
    let lateHeartbeat: unknown;
    try {
      await room.heartbeat('abandoned-owner', crashed.id);
    } catch (error) {
      lateHeartbeat = error;
    }
    expect(String(lateHeartbeat)).toMatch(/no longer active/iu);
  });

  it('never expires an admitted guest during a host-lease lapse', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const room = env.ROOMS.getByName('lease-lapse-room');
    await room.configureRoom({
      slug: 'lease-lapse-room',
      ownerSub: 'lapse-owner',
      ownerEmail: 'lapse@example.com',
      kind: 'permanent',
      expiresAt: null,
    });
    const meeting = await room.startMeeting({
      sub: 'lapse-owner',
      email: 'lapse@example.com',
      name: 'Lapse Owner',
    });
    const receipt = await room.requestJoin({ name: 'Admitted guest', email: '' });
    await room.decide('lapse-owner', receipt.requestId, true);

    // Host silent far past the knock grace window: the admission must survive,
    // even though a fresh exchange is refused while the lease is stale.
    vi.setSystemTime(new Date('2026-08-09T12:05:00Z'));
    expect((await room.joinStatus(receipt.requestId, receipt.lobbyToken)).status).toBe('admitted');
    let refusal: unknown;
    try {
      await room.exchangeAdmission(receipt.requestId, receipt.lobbyToken);
    } catch (error) {
      refusal = error;
    }
    expect(String(refusal)).toMatch(/no longer actively hosting/iu);

    // The host coming back makes the same admission usable again.
    await room.heartbeat('lapse-owner', meeting.id, null, 'lapse@example.com');
    await expect(room.exchangeAdmission(receipt.requestId, receipt.lobbyToken))
      .resolves.toMatchObject({ meetingId: meeting.id });
  });

  it('lets a guest who already joined reconnect through a host-lease lapse', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-09T13:00:00Z'));
    const room = env.ROOMS.getByName('reconnect-lapse-room');
    await room.configureRoom({
      slug: 'reconnect-lapse-room',
      ownerSub: 'reconnect-owner',
      ownerEmail: 'reconnect@example.com',
      kind: 'permanent',
      expiresAt: null,
    });
    const meeting = await room.startMeeting({
      sub: 'reconnect-owner',
      email: 'reconnect@example.com',
      name: 'Reconnect Owner',
    });
    const receipt = await room.requestJoin({ name: 'Joined guest', email: '' });
    await room.decide('reconnect-owner', receipt.requestId, true);
    await expect(room.exchangeAdmission(receipt.requestId, receipt.lobbyToken))
      .resolves.toMatchObject({ meetingId: meeting.id });

    // Host Mac crashed: the lease is stale, but the guest reloading the tab
    // was already in the room and gets back in.
    vi.setSystemTime(new Date('2026-08-09T13:05:00Z'));
    await expect(room.exchangeAdmission(receipt.requestId, receipt.lobbyToken))
      .resolves.toMatchObject({ meetingId: meeting.id });

    // Past the stale window the meeting is over for everyone.
    vi.setSystemTime(new Date('2026-08-09T13:10:01Z'));
    let refusal: unknown;
    try {
      await room.exchangeAdmission(receipt.requestId, receipt.lobbyToken);
    } catch (error) {
      refusal = error;
    }
    expect(String(refusal)).toMatch(/no longer actively hosting/iu);
  });

  it('accepts pre-live knocks while soft presence is active and attaches them on Start', async () => {
    const room = env.ROOMS.getByName('prelive-room');
    await room.configureRoom({
      slug: 'prelive-room',
      ownerSub: 'prelive-owner',
      ownerEmail: 'prelive@example.com',
      kind: 'permanent',
      expiresAt: null,
    });

    let early: unknown;
    try {
      await room.requestJoin({ name: 'Too early', email: '' });
    } catch (error) {
      early = error;
    }
    expect(String(early)).toMatch(/Couldn’t reach this room/iu);

    await room.touchPresence('prelive-owner');
    const receipt = await room.requestJoin({
      name: 'Knocker',
      email: 'knock@example.net',
    });
    expect(receipt.status).toBe('waiting');
    expect((await room.lobbySnapshot('prelive-owner')).requests).toHaveLength(1);

    let prematureAdmit: unknown;
    try {
      await room.decide('prelive-owner', receipt.requestId, true);
    } catch (error) {
      prematureAdmit = error;
    }
    expect(String(prematureAdmit)).toMatch(/Start the room/iu);

    const meeting = await room.startMeeting({
      sub: 'prelive-owner',
      email: 'prelive@example.com',
      name: 'Prelive Owner',
    });
    const snapshot = await room.lobbySnapshot('prelive-owner');
    expect(snapshot.meeting?.id).toBe(meeting.id);
    expect(snapshot.requests.find((row) => row.id === receipt.requestId)?.meetingId).toBe(meeting.id);

    await room.decide('prelive-owner', receipt.requestId, true);
    expect((await room.joinStatus(receipt.requestId, receipt.lobbyToken)).status).toBe('admitted');
  });

  it('adopts a new Google subject for the same owner, but never a different one', async () => {
    const room = env.ROOMS.getByName('two-macs-room');
    await room.configureRoom({
      slug: 'two-macs-room',
      ownerSub: 'dev:owner@example.com',
      ownerEmail: 'owner@example.com',
      kind: 'permanent',
      expiresAt: null,
    });

    // Second Mac signs in with real Google: same human, different subject.
    const adopted = await room.adoptOwner({ sub: 'google-115', email: 'Owner@example.com' });
    expect(adopted.ownerSub).toBe('google-115');
    await expect(room.startMeeting({
      sub: 'google-115',
      email: 'owner@example.com',
      name: 'Owner',
    })).resolves.toMatchObject({ livekitRoom: expect.stringContaining('meet-two-macs-room-') });

    // The same person on the other identity domain is still the owner, and
    // the row now carries the address that is signed in.
    const crossed = await room.adoptOwner({ sub: 'google-io', email: 'Owner@example.org' });
    expect(crossed.ownerSub).toBe('google-io');
    expect(crossed.ownerEmail).toBe('owner@example.org');
    await room.adoptOwner({ sub: 'google-115', email: 'owner@example.com' });

    // The old subject is now a stranger, and so is anyone else.
    let stale: unknown;
    try {
      await room.lobbySnapshot('dev:owner@example.com');
    } catch (error) {
      stale = error;
    }
    expect(String(stale)).toMatch(/room owner/iu);

    let intruder: unknown;
    try {
      await room.adoptOwner({ sub: 'google-999', email: 'someone-else@example.com' });
    } catch (error) {
      intruder = error;
    }
    expect(String(intruder)).toMatch(/room owner/iu);
  });

  it('stores optional booking tokens as lobby context only', async () => {
    const room = env.ROOMS.getByName('booking-token-room');
    await room.configureRoom({
      slug: 'booking-token-room',
      ownerSub: 'booking-owner',
      ownerEmail: 'booking@example.com',
      kind: 'permanent',
      expiresAt: null,
    });
    await room.startMeeting({
      sub: 'booking-owner',
      email: 'booking@example.com',
      name: 'Booking Owner',
    });
    const receipt = await room.requestJoin({
      name: 'Scheduled Guest',
      email: 'scheduled@example.net',
      booking_token: 'crm-token-abc',
    });
    const snapshot = await room.lobbySnapshot('booking-owner');
    expect(snapshot.requests.find((row) => row.id === receipt.requestId)?.bookingToken).toBe('crm-token-abc');
  });

  it('exposes a live waiting count to every lobby visitor', async () => {
    const room = env.ROOMS.getByName('lobby-count-room');
    await room.configureRoom({
      slug: 'lobby-count-room',
      ownerSub: 'count-owner',
      ownerEmail: 'count@example.com',
      kind: 'permanent',
      expiresAt: null,
    });
    await room.startMeeting({
      sub: 'count-owner',
      email: 'count@example.com',
      name: 'Count Owner',
    });

    const first = await room.requestJoin({ name: 'Ana', email: '' });
    expect(first.waitingCount).toBe(1);
    expect((await room.joinStatus(first.requestId, first.lobbyToken)).waitingCount).toBe(1);

    const second = await room.requestJoin({ name: 'Bruno', email: '' });
    expect(second.waitingCount).toBe(2);
    expect((await room.joinStatus(first.requestId, first.lobbyToken)).waitingCount).toBe(2);
    expect((await room.joinStatus(second.requestId, second.lobbyToken)).waitingCount).toBe(2);

    await room.decide('count-owner', first.requestId, true);
    expect((await room.joinStatus(second.requestId, second.lobbyToken))).toMatchObject({
      status: 'waiting',
      waitingCount: 1,
    });
  });

  it('exports a CRM roster that keeps opted-out and email-less guests', async () => {
    const room = env.ROOMS.getByName('crm-roster-room');
    await room.configureRoom({
      slug: 'crm-roster-room',
      ownerSub: 'crm-owner',
      ownerEmail: 'crm@example.com',
      kind: 'permanent',
      expiresAt: null,
    });
    const meeting = await room.startMeeting({
      sub: 'crm-owner',
      email: 'crm@example.com',
      name: 'CRM Owner',
    });

    const booked = await room.requestJoin({
      name: 'Ana',
      email: 'ana@acme.com',
      booking_token: 'crm-token-abc',
    });
    await room.decide('crm-owner', booked.requestId, true);
    await room.exchangeAdmission(booked.requestId, booked.lobbyToken);

    const anonymous = await room.requestJoin({ name: 'Bruno', email: '' });
    await room.decide('crm-owner', anonymous.requestId, true);
    await room.exchangeAdmission(anonymous.requestId, anonymous.lobbyToken);

    const material = await room.meetingLogMaterial(meeting.id);
    expect(material).toMatchObject({
      roomSlug: 'crm-roster-room',
      ownerEmail: 'crm@example.com',
      meetingId: meeting.id,
      bookingToken: 'crm-token-abc',
    });
    expect(material.participants).toHaveLength(3);
    expect(material.participants[0]).toMatchObject({ role: 'owner', email: 'crm@example.com' });

    const ana = material.participants.find((row) => row.email === 'ana@acme.com');
    expect(ana).toMatchObject({ role: 'guest', bookingToken: 'crm-token-abc' });

    // The meeting log is a record of the room: Bruno belongs in it with no
    // email at all.
    const bruno = material.participants.find((row) => row.name === 'Bruno');
    expect(bruno).toMatchObject({ role: 'guest', email: '', bookingToken: null });
  });

  it('reports a lurker booking token without persisting it', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-08-10T12:00:00.000Z'), toFake: ['Date'] });
    const room = env.ROOMS.getByName('booked-lurker-room');
    await room.configureRoom({
      slug: 'booked-lurker-room',
      ownerSub: 'booked-owner',
      ownerEmail: 'booked@example.com',
      kind: 'permanent',
      expiresAt: null,
    });

    const presenceId = '22222222-2222-4222-8222-222222222222';
    await room.upsertGuestPresence({
      presenceId,
      stage: 'visit',
      bookingToken: 'crm-booking-7f3a',
    });
    let snapshot = await room.lobbySnapshot('booked-owner');
    expect(snapshot.lurkers[0]?.bookingToken).toBe('crm-booking-7f3a');

    // Held in memory, so every heartbeat carries it — the browser re-sends it
    // roughly every 8s for as long as the visit lasts.
    await room.upsertGuestPresence({
      presenceId,
      stage: 'preview',
      name: 'Ana',
      bookingToken: 'crm-booking-7f3a',
    });
    snapshot = await room.lobbySnapshot('booked-owner');
    expect(snapshot.lurkers[0]).toMatchObject({
      stage: 'preview',
      name: 'Ana',
      bookingToken: 'crm-booking-7f3a',
    });

    // Nothing about the booking link outlives the visit. Non-persistence is
    // structural — there is no column to read — so what is asserted here is the
    // consequence: once the row TTLs out, a fresh visit under the same presence
    // id comes back with no booking, rather than resurrecting the old one.
    vi.setSystemTime(Date.parse('2026-08-10T12:05:00.000Z'));
    snapshot = await room.lobbySnapshot('booked-owner');
    expect(snapshot.lurkers).toHaveLength(0);

    await room.upsertGuestPresence({ presenceId, stage: 'visit' });
    snapshot = await room.lobbySnapshot('booked-owner');
    expect(snapshot.lurkers[0]?.bookingToken).toBeNull();
  });

  it('tracks pre-knock lurkers with geo and clears them on knock', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-08-10T12:00:00.000Z'), toFake: ['Date'] });
    const room = env.ROOMS.getByName('lurker-room');
    await room.configureRoom({
      slug: 'lurker-room',
      ownerSub: 'lurker-owner',
      ownerEmail: 'lurker@example.com',
      kind: 'permanent',
      expiresAt: null,
    });

    const presenceId = '11111111-1111-4111-8111-111111111111';
    await room.upsertGuestPresence({
      presenceId,
      stage: 'visit',
      city: 'Lisbon',
      country: 'PT',
    });
    let snapshot = await room.lobbySnapshot('lurker-owner');
    expect(snapshot.lurkers).toHaveLength(1);
    expect(snapshot.lurkers[0]).toMatchObject({
      id: presenceId,
      stage: 'visit',
      city: 'Lisbon',
      country: 'PT',
      name: null,
      bookingToken: null,
    });

    await room.upsertGuestPresence({
      presenceId,
      stage: 'naming',
      name: 'Ana',
      city: 'Lisbon',
      country: 'PT',
    });
    snapshot = await room.lobbySnapshot('lurker-owner');
    expect(snapshot.lurkers[0]).toMatchObject({ stage: 'naming', name: 'Ana' });

    await room.upsertGuestPresence({
      presenceId,
      stage: 'preview',
      name: 'Ana',
    });
    snapshot = await room.lobbySnapshot('lurker-owner');
    expect(snapshot.lurkers[0]?.stage).toBe('preview');

    // Stale rows drop after the TTL without a fresh heartbeat.
    vi.setSystemTime(Date.parse('2026-08-10T12:01:00.000Z'));
    snapshot = await room.lobbySnapshot('lurker-owner');
    expect(snapshot.lurkers).toHaveLength(0);

    vi.setSystemTime(Date.parse('2026-08-10T12:02:00.000Z'));
    await room.upsertGuestPresence({
      presenceId,
      stage: 'preview',
      name: 'Ana',
      city: 'Porto',
      country: 'PT',
    });
    await room.touchPresence('lurker-owner');
    const receipt = await room.requestJoin({
      name: 'Ana',
      email: 'ana@example.net',
      presence_id: presenceId,
    });
    expect(receipt.status).toBe('waiting');
    snapshot = await room.lobbySnapshot('lurker-owner');
    expect(snapshot.lurkers).toHaveLength(0);
    expect(snapshot.requests).toHaveLength(1);
  });

  it("closes a lurker's connection: drops the row and blocks the tab from reappearing", async () => {
    vi.useFakeTimers({ now: Date.parse('2026-08-10T12:00:00.000Z'), toFake: ['Date'] });
    const room = env.ROOMS.getByName('remove-lurker-room');
    await room.configureRoom({
      slug: 'remove-lurker-room',
      ownerSub: 'remove-owner',
      ownerEmail: 'remove@example.com',
      kind: 'permanent',
      expiresAt: null,
    });

    const presenceId = '22222222-2222-4222-8222-222222222222';
    await room.upsertGuestPresence({ presenceId, stage: 'visit', city: 'Porto', country: 'PT' });
    let snapshot = await room.lobbySnapshot('remove-owner');
    expect(snapshot.lurkers).toHaveLength(1);

    // Only the room owner may close a connection.
    let ownerError: unknown;
    try {
      await room.removeGuestPresence('somebody-else', presenceId);
    } catch (error) {
      ownerError = error;
    }
    expect(String(ownerError)).toMatch(/only the room owner/iu);

    await room.removeGuestPresence('remove-owner', presenceId);
    snapshot = await room.lobbySnapshot('remove-owner');
    expect(snapshot.lurkers).toHaveLength(0);

    // Still within the cooldown: the next heartbeat from the same tab is refused.
    await room.upsertGuestPresence({ presenceId, stage: 'visit', city: 'Porto', country: 'PT' });
    snapshot = await room.lobbySnapshot('remove-owner');
    expect(snapshot.lurkers).toHaveLength(0);

    // A knock from the same blocked tab is refused too — reachability is
    // proven first so the failure below is actually the block, not a room
    // nobody is watching.
    await room.touchPresence('remove-owner');
    let knockError: unknown;
    try {
      await room.requestJoin({
        name: 'Blocked Visitor',
        email: 'blocked@example.net',
        presence_id: presenceId,
      });
    } catch (error) {
      knockError = error;
    }
    expect(String(knockError)).toMatch(/try again shortly/iu);

    // Once the cooldown lapses, the same tab is welcome again.
    vi.setSystemTime(Date.parse('2026-08-10T12:06:00.000Z'));
    await room.upsertGuestPresence({ presenceId, stage: 'visit', city: 'Porto', country: 'PT' });
    snapshot = await room.lobbySnapshot('remove-owner');
    expect(snapshot.lurkers).toHaveLength(1);
  });
});
