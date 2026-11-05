import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import type { PeersResponse } from '@starlings/contracts';
import { isWithinWorkingHours, WORK_DAY_BITS, WORK_DAYS_WEEKDAYS } from '@starlings/contracts';
import { recordOwnerSignIn } from '../src/usage';
import { resetPeerRosterCache } from '../src/peers';

const rosa = { email: 'pp-rosa@example.com', name: 'Rosa' };

async function member(person: { email: string; name: string }) {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(person),
  }));
  const body = await response.json<{ access_token: string }>();
  await recordOwnerSignIn(env as Env, { sub: `dev:${person.email}`, ...person }, 'mac');
  return { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json' };
}

async function beat(headers: Record<string, string>, body: Record<string, unknown>) {
  return exports.default.fetch(new Request('http://local/api/owner/heartbeat', {
    method: 'POST', headers, body: JSON.stringify(body),
  }));
}

async function profile(headers: Record<string, string>, body: Record<string, unknown>) {
  return exports.default.fetch(new Request('http://local/api/peers/profile', {
    method: 'PATCH', headers, body: JSON.stringify(body),
  }));
}

async function me(headers: Record<string, string>) {
  resetPeerRosterCache();
  const response = await exports.default.fetch(new Request('http://local/api/peers', { headers }));
  const body = await response.json<PeersResponse>();
  return body.peers.find((peer) => peer.email === rosa.email);
}

afterEach(async () => {
  resetPeerRosterCache();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'pp-%'").run();
});

describe('timezone', () => {
  it('takes the zone a device reports on its heartbeat', async () => {
    const headers = await member(rosa);
    expect((await beat(headers, { client: 'mac', timezone: 'Europe/Lisbon' })).status).toBe(200);
    expect((await me(headers))?.timezone).toBe('Europe/Lisbon');
  });

  it('refuses a zone that parses but does not exist', async () => {
    const headers = await member(rosa);
    const response = await beat(headers, { client: 'mac', timezone: 'Europe/Atlantis' });
    expect(response.status).toBe(400);
  });

  it('lets a device correct itself when somebody travels', async () => {
    const headers = await member(rosa);
    await beat(headers, { client: 'mac', timezone: 'Europe/Lisbon' });
    await beat(headers, { client: 'mac', timezone: 'Asia/Tokyo' });
    expect((await me(headers))?.timezone).toBe('Asia/Tokyo');
  });

  it('never lets a device overwrite a zone the person set themselves', async () => {
    const headers = await member(rosa);
    await profile(headers, { timezone: 'Europe/Lisbon' });
    await beat(headers, { client: 'mac', timezone: 'Asia/Tokyo' });
    expect((await me(headers))?.timezone).toBe('Europe/Lisbon');
  });

  it('hands the zone back to the devices when the pin is cleared', async () => {
    const headers = await member(rosa);
    await profile(headers, { timezone: 'Europe/Lisbon' });
    await profile(headers, { timezone: null });
    await beat(headers, { client: 'mac', timezone: 'Asia/Tokyo' });
    expect((await me(headers))?.timezone).toBe('Asia/Tokyo');
  });
});

describe('profile', () => {
  it('stores a title and working hours, and leaves untouched fields alone', async () => {
    const headers = await member(rosa);
    await profile(headers, {
      title: 'Founder',
      working_hours: { start_minute: 9 * 60, end_minute: 18 * 60, days: WORK_DAYS_WEEKDAYS },
    });
    // A client that only edits a title must not blank what it never drew.
    await profile(headers, { pronouns: 'they/them' });

    const row = await me(headers);
    expect(row?.title).toBe('Founder');
    expect(row?.pronouns).toBe('they/them');
    expect(row?.working_hours).toEqual({ start_minute: 540, end_minute: 1080, days: WORK_DAYS_WEEKDAYS });
  });

  it('refuses a minute outside the day', async () => {
    const headers = await member(rosa);
    const response = await profile(headers, {
      working_hours: { start_minute: 0, end_minute: 2000, days: WORK_DAYS_WEEKDAYS },
    });
    expect(response.status).toBe(400);
  });
});

describe('isWithinWorkingHours', () => {
  const nineToSix = { start_minute: 540, end_minute: 1080, days: WORK_DAYS_WEEKDAYS };

  it('is undecidable when nobody has said', () => {
    // Not "no" — a client treating a missing pattern as off duty would stop
    // people ringing anybody who never filled in a form.
    expect(isWithinWorkingHours(null, 600, WORK_DAY_BITS.mon)).toBeNull();
  });

  it('answers inside, outside, and on the wrong day', () => {
    expect(isWithinWorkingHours(nineToSix, 600, WORK_DAY_BITS.mon)).toBe(true);
    expect(isWithinWorkingHours(nineToSix, 1380, WORK_DAY_BITS.mon)).toBe(false);
    expect(isWithinWorkingHours(nineToSix, 600, WORK_DAY_BITS.sun)).toBe(false);
  });

  it('handles a shift that crosses midnight', () => {
    const nights = { start_minute: 1320, end_minute: 360, days: WORK_DAYS_WEEKDAYS };
    expect(isWithinWorkingHours(nights, 1380, WORK_DAY_BITS.tue)).toBe(true);
    expect(isWithinWorkingHours(nights, 120, WORK_DAY_BITS.tue)).toBe(true);
    expect(isWithinWorkingHours(nights, 720, WORK_DAY_BITS.tue)).toBe(false);
  });
});
