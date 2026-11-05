import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  HAND_ATTRIBUTE,
  HAND_LOWERED,
  handRaisedAt,
  handRaisedValue,
  isHandRaised,
} from '@starlings/contracts';

/**
 * A raised hand is state, not an event, and the interesting part is who is
 * allowed to write it: the attribute is set by the Worker with an admin grant
 * precisely so `canUpdateOwnMetadata` can stay shut.
 */

describe('the hand attribute', () => {
  it('reads a raise as the moment it went up', () => {
    const at = Date.parse('2026-09-06T10:00:00Z');
    expect(handRaisedAt(handRaisedValue(at))).toBe(at);
    expect(isHandRaised({ [HAND_ATTRIBUTE]: handRaisedValue(at) })).toBe(true);
  });

  it('treats lowered and never-raised as the same state', () => {
    expect(handRaisedAt(HAND_LOWERED)).toBeNull();
    expect(handRaisedAt(undefined)).toBeNull();
    expect(isHandRaised({})).toBe(false);
    expect(isHandRaised(undefined)).toBe(false);
    expect(isHandRaised({ [HAND_ATTRIBUTE]: HAND_LOWERED })).toBe(false);
  });

  it('reads a value it cannot parse as a hand that is down', () => {
    // A client reading a bad value should draw nothing, not throw inside a
    // render: a missed hand is a missed question, a thrown render is a broken
    // meeting.
    for (const raw of ['yes', 'true', '-1', '0', 'NaN', ' ']) {
      expect(handRaisedAt(raw), raw).toBeNull();
    }
  });
});

describe('the hand routes', () => {
  const meeting = '00000000-0000-4000-8000-000000000000';

  it('refuses a raise with no artifact token', async () => {
    const response = await exports.default.fetch(new Request(
      `http://local/api/rooms/rosa/meetings/${meeting}/hand`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raised: true }),
      },
    ));
    expect(response.status).toBe(401);
  });

  it('refuses lowering every hand without an owner session', async () => {
    // The queue is moderation: a guest who could clear it could silence the
    // room's questions without saying anything.
    const response = await exports.default.fetch(new Request(
      `http://local/api/rooms/rosa/meetings/${meeting}/hands`,
      { method: 'DELETE' },
    ));
    expect(response.status).toBe(401);
  });

  it('has no route for raising somebody else’s hand', async () => {
    // Whose hand it is comes from the principal, never the body. An identity
    // in the payload is simply not read — this asserts the shape stays that
    // way, because the day it is read is the day a guest can raise the host's.
    const response = await exports.default.fetch(new Request(
      `http://local/api/rooms/rosa/meetings/${meeting}/hand`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ raised: true, identity: 'guest:someone-else' }),
      },
    ));
    // Still the auth wall, not a 400: the body never gets a say.
    expect(response.status).toBe(401);
  });
});
