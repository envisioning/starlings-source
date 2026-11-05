import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The host rules the Durable Object holds (meet#560, meet#561): who may
 * renew, claim, release, offer and accept. The routes add the SFU roster
 * (`currentConnected`, `pendingConnected`); here those are inputs.
 */

// Fake Date only, as in room-coordinator.test.ts: the room runs in this
// isolate, and a faked setTimeout there never fires.
afterEach(() => vi.useRealTimers());

const owner = { sub: 'rules-owner', email: 'rules@example.com', name: 'Rules Owner' };
const member = { sub: 'rules-member', email: 'member@example.com', name: 'Rules Member' };
const macA = { deviceID: 'device-a', identity: 'rules+mac-a@example.com' };
const macB = { deviceID: 'device-b', identity: 'rules+mac-b@example.com' };
const macC = { deviceID: 'device-c', identity: 'rules+mac-c@example.com' };

async function roomWithMeeting(name: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-30T08:00:00Z'));
  const room = env.ROOMS.getByName(name);
  await room.configureRoom({ slug: name, ownerSub: owner.sub, ownerEmail: owner.email, kind: 'permanent', expiresAt: null });
  const meeting = await room.startMeeting(owner, macA.identity, macA.deviceID);
  await room.startMeeting(owner, macB.identity, macB.deviceID);
  return { room, meeting };
}

/** The error an RPC call rejected with, or null. Rejections are caught here, not left unhandled. */
async function refusal(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call();
    return null;
  } catch (error) {
    return error;
  }
}

function claim(device: { deviceID: string; identity: string }, overrides: Partial<{
  expected: string | null;
  currentConnected: boolean;
  pendingConnected: boolean;
  ifVacant: boolean;
}> = {}) {
  return {
    ...device,
    expected: macA.identity,
    currentConnected: true,
    pendingConnected: false,
    ifVacant: false,
    ...overrides,
  };
}

describe('host rules', () => {
  it('refuses a claim when the host moved since the route read it', async () => {
    const { room, meeting } = await roomWithMeeting('rules-cas');
    // B takes over a host that dropped out.
    await expect(room.claimHost(owner.sub, meeting.id, claim(macB, { currentConnected: false })))
      .resolves.toMatchObject({ status: 'host', hostIdentity: macB.identity });
    // C read A as the host before B's claim landed: refused, not a second host.
    expect(await refusal(() => room.claimHost(owner.sub, meeting.id, claim(macC, { currentConnected: false }))))
      .toMatchObject({ code: 'host_not_active', status: 409 });
    expect((await room.hostState(owner.sub, meeting.id)).hostIdentity).toBe(macB.identity);
  });

  it('takes the host with ifVacant only when nobody holds it', async () => {
    const { room, meeting } = await roomWithMeeting('rules-vacant');
    expect(await refusal(() => room.claimHost(owner.sub, meeting.id, claim(macB, { ifVacant: true }))))
      .toMatchObject({ code: 'host_not_active', status: 409 });
    await room.releaseHost(owner.sub, meeting.id, macA.deviceID, owner.email, false);
    await expect(room.claimHost(owner.sub, meeting.id, claim(macB, { expected: null, ifVacant: true })))
      .resolves.toMatchObject({ status: 'host', hostIdentity: macB.identity });
  });

  it('keeps the host when the device that asked has left', async () => {
    const { room, meeting } = await roomWithMeeting('rules-gone-target');
    await room.claimHost(owner.sub, meeting.id, claim(macB));
    const after = await room.releaseHost(owner.sub, meeting.id, macA.deviceID, owner.email, false);
    expect(after).toMatchObject({ hostIdentity: macA.identity, pendingHostIdentity: null });
    await expect(room.heartbeat(owner.sub, meeting.id, macA.deviceID)).resolves.toBe(Date.now() + 30_000);
  });

  it('lets a request from a device that left stop blocking other claims', async () => {
    const { room, meeting } = await roomWithMeeting('rules-stale-request');
    await room.claimHost(owner.sub, meeting.id, claim(macB));
    // B is still in the call: C waits its turn.
    expect(await refusal(() => room.claimHost(owner.sub, meeting.id, claim(macC, { pendingConnected: true }))))
      .toMatchObject({ code: 'host_not_active', status: 409 });
    // B left: C's request replaces it.
    await expect(room.claimHost(owner.sub, meeting.id, claim(macC, { pendingConnected: false })))
      .resolves.toMatchObject({ status: 'release_requested', pendingIdentity: macC.identity });
  });

  it('never lets a session without an install id renew or release a device host', async () => {
    const { room, meeting } = await roomWithMeeting('rules-null-device');
    expect(await refusal(() => room.heartbeat(owner.sub, meeting.id, null, owner.email)))
      .toMatchObject({ code: 'host_not_active', status: 409 });
    expect(await refusal(() => room.releaseHost(owner.sub, meeting.id, null, owner.email, false)))
      .toMatchObject({ code: 'host_not_active', status: 409 });
  });

  it('matches a deviceless host by identity, so another person cannot renew it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T08:00:00Z'));
    const room = env.ROOMS.getByName('rules-deviceless');
    await room.configureRoom({ slug: 'rules-deviceless', ownerSub: owner.sub, ownerEmail: owner.email, kind: 'permanent', expiresAt: null });
    const meeting = await room.startMeeting(owner);
    await expect(room.heartbeat(owner.sub, meeting.id, null, owner.email)).resolves.toBe(Date.now() + 30_000);
    expect(await refusal(() => room.heartbeat(owner.sub, meeting.id, null, 'someone@example.com')))
      .toMatchObject({ code: 'host_not_active', status: 409 });
  });

  it('lets a start take over a host whose lease lapsed', async () => {
    const { room, meeting } = await roomWithMeeting('rules-lapsed');
    vi.setSystemTime(new Date('2026-09-30T08:00:31Z'));
    const phone = await room.startMeeting(owner, 'rules+iphone-x@example.com', 'device-x');
    expect(phone).toMatchObject({ id: meeting.id, hostIdentity: 'rules+iphone-x@example.com' });
  });

  it('lets an offered member host the meeting, and nothing else in the room', async () => {
    const { room, meeting } = await roomWithMeeting('rules-offer');
    expect(await room.isHostMember(member.sub)).toBe(false);
    expect(await refusal(() => room.hostState(member.sub, meeting.id)))
      .toMatchObject({ code: 'not_room_owner', status: 403 });

    await room.offerHost(owner.sub, meeting.id, macA, { identity: 'guest:abc', email: member.email });
    expect((await room.lobbySnapshot(owner.sub)).meeting).toMatchObject({ hostOfferIdentity: 'guest:abc' });

    // Only the address the offer names can accept.
    expect(await refusal(() => room.answerHostOffer({ sub: 'other', email: 'other@example.com' }, meeting.id, true)))
      .toMatchObject({ code: 'host_not_active', status: 409 });
    await room.answerHostOffer(member, meeting.id, true);
    expect(await room.isHostMember(member.sub)).toBe(true);

    // The member joins, claims, and the owner's Mac hands over.
    const memberMac = { deviceID: 'member-mac', identity: 'member+mac-m@example.com' };
    await room.startMeeting(member, memberMac.identity, memberMac.deviceID);
    await expect(room.claimHost(member.sub, meeting.id, claim(memberMac)))
      .resolves.toMatchObject({ status: 'release_requested' });
    await room.releaseHost(owner.sub, meeting.id, macA.deviceID, owner.email, true);
    await expect(room.heartbeat(member.sub, meeting.id, memberMac.deviceID)).resolves.toBe(Date.now() + 30_000);

    // Room settings stay the owner's.
    expect(await refusal(() => room.setRoomSettings(member.sub, { refuse_recorders: true })))
      .toMatchObject({ code: 'not_room_owner', status: 403 });
  });

  it('drops an offer that is declined or runs out', async () => {
    const { room, meeting } = await roomWithMeeting('rules-offer-lapse');
    await room.offerHost(owner.sub, meeting.id, macA, { identity: 'guest:abc', email: member.email });
    await room.answerHostOffer(member, meeting.id, false);
    expect(await room.isHostMember(member.sub)).toBe(false);
    expect((await room.lobbySnapshot(owner.sub)).meeting).toMatchObject({ hostOfferIdentity: null });

    await room.offerHost(owner.sub, meeting.id, macA, { identity: 'guest:abc', email: member.email });
    vi.setSystemTime(new Date('2026-09-30T08:01:01Z'));
    expect(await refusal(() => room.answerHostOffer(member, meeting.id, true)))
      .toMatchObject({ code: 'host_not_active', status: 409 });
  });

  it('refuses an offer from a device that is not the host', async () => {
    const { room, meeting } = await roomWithMeeting('rules-offer-not-host');
    expect(await refusal(() => room.offerHost(owner.sub, meeting.id, macB, { identity: 'guest:abc', email: member.email })))
      .toMatchObject({ code: 'host_not_active', status: 409 });
  });

  it('moves the Host badge once, and again when the host moves', async () => {
    const { room, meeting } = await roomWithMeeting('rules-badge');
    await expect(room.hostBadgeChange(meeting.id)).resolves.toEqual({ set: macA.identity, clear: null });
    await room.hostBadgeChange(meeting.id, true);
    await expect(room.hostBadgeChange(meeting.id)).resolves.toBeNull();
    await room.claimHost(owner.sub, meeting.id, claim(macB, { currentConnected: false }));
    await expect(room.hostBadgeChange(meeting.id)).resolves.toEqual({ set: macB.identity, clear: macA.identity });
  });
});
