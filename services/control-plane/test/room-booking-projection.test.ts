import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPublicBookingProjection } from '../src/schedule-proxy';

const TOKEN = '8f2c9d21-4a77-4a0e-9c31-1d0e1a2b3c4d';

/** What Core returns: manage links are paths, and Meet supplies the origin. */
const UPSTREAM = {
  title: 'Envisioning / Ana Silva',
  subject: 'Roadmap review and the Q4 pilot',
  starts_at: '2026-08-12T14:00:00.000Z',
  ends_at: '2026-08-12T15:00:00.000Z',
  status: 'scheduled',
  reschedule_path: `/meet/rosa/cancel/${TOKEN}/reschedule`,
  cancel_path: `/meet/rosa/cancel/${TOKEN}`,
};

/** What Meet serves: same fields, manage paths resolved against Core's origin. */
const SCHEDULED = {
  title: UPSTREAM.title,
  subject: UPSTREAM.subject,
  starts_at: UPSTREAM.starts_at,
  ends_at: UPSTREAM.ends_at,
  status: UPSTREAM.status,
  reschedule_url: `https://core.invalid/meet/rosa/cancel/${TOKEN}/reschedule`,
  cancel_url: `https://core.invalid/meet/rosa/cancel/${TOKEN}`,
  // Core does not project these yet (meet#217).
  guest_name: null,
  guest_email: null,
};

/** Stub the one outbound call to Core and hand back the URL it was asked for. */
function stubCore(respond: () => Response): { url: () => string; body: () => string } {
  let seen = '';
  let seenBody = '';
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (input instanceof Request) seenBody = await input.clone().text();
    else if (typeof init?.body === 'string') seenBody = init.body;
    return respond();
  });
  return { url: () => seen, body: () => seenBody };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('booking projection lookup', () => {
  it('asks Core for the public projection of that slug and token', async () => {
    const core = stubCore(() => Response.json({ booking: UPSTREAM }));
    const lookup = await fetchPublicBookingProjection(env as Env, 'rosa', TOKEN);
    expect(core.url()).toBe(`https://core.invalid/api/meet/rosa/booking/${TOKEN}/public`);
    expect(lookup).toEqual({ outcome: 'found', projection: SCHEDULED });
  });

  it('re-projects the upstream body so a new Core field cannot reach a guest', async () => {
    stubCore(() => Response.json({
      booking: {
        ...UPSTREAM,
        guest_name: 'Ana',
        guest_email: 'ana@acme.com',
        guest_notes: 'wants pricing',
        interaction_id: 'crm-1',
      },
    }));
    const lookup = await fetchPublicBookingProjection(env as Env, 'rosa', TOKEN);
    expect(lookup.outcome).toBe('found');
    expect(lookup.outcome === 'found' && Object.keys(lookup.projection).sort()).toEqual([
      'cancel_url',
      'ends_at',
      'guest_email',
      'guest_name',
      'reschedule_url',
      'starts_at',
      'status',
      'subject',
      'title',
    ]);
    // The holder's own identity is projected (meet#217); notes and CRM ids are not.
    expect(lookup.outcome === 'found' && lookup.projection).toMatchObject({
      guest_name: 'Ana',
      guest_email: 'ana@acme.com',
    });
  });

  it('carries a cancelled booking through as status only', async () => {
    stubCore(() => Response.json({
      booking: {
        title: null, subject: null, starts_at: null, ends_at: null, status: 'cancelled',
        reschedule_path: null, cancel_path: null,
      },
    }));
    await expect(fetchPublicBookingProjection(env as Env, 'rosa', TOKEN)).resolves.toMatchObject({
      outcome: 'found',
      projection: { status: 'cancelled', title: null },
    });
  });

  it('separates an unknown token from Core being down', async () => {
    stubCore(() => Response.json({ error: 'Booking not found' }, { status: 404 }));
    await expect(fetchPublicBookingProjection(env as Env, 'rosa', TOKEN))
      .resolves.toEqual({ outcome: 'unknown' });

    stubCore(() => Response.json({ error: 'Failed to fetch booking' }, { status: 500 }));
    await expect(fetchPublicBookingProjection(env as Env, 'rosa', TOKEN))
      .resolves.toEqual({ outcome: 'unavailable' });

    vi.stubGlobal('fetch', async () => { throw new Error('network down'); });
    await expect(fetchPublicBookingProjection(env as Env, 'rosa', TOKEN))
      .resolves.toEqual({ outcome: 'unavailable' });
  });

  it('will not let Core point the join card at another host', async () => {
    // Meet owns the origin: anything that is not a plain rooted path is dropped
    // rather than resolved, so a bad value upstream cannot become a link out.
    for (const hostile of [
      '//evil.example/meet/rosa/cancel',
      'https://evil.example/meet/rosa/cancel',
      'javascript:alert(1)',
      'meet/rosa/cancel',
      '',
    ]) {
      stubCore(() => Response.json({
        booking: { ...UPSTREAM, cancel_path: hostile, reschedule_path: hostile },
      }));
      const lookup = await fetchPublicBookingProjection(env as Env, 'rosa', TOKEN);
      expect(lookup.outcome === 'found' && lookup.projection).toMatchObject({
        cancel_url: null,
        reschedule_url: null,
      });
    }
  });

  it('leaves a cancelled booking with nothing to manage', async () => {
    stubCore(() => Response.json({
      booking: {
        title: null, subject: null, starts_at: null, ends_at: null,
        status: 'cancelled', reschedule_path: null, cancel_path: null,
      },
    }));
    const lookup = await fetchPublicBookingProjection(env as Env, 'rosa', TOKEN);
    expect(lookup.outcome === 'found' && lookup.projection).toMatchObject({
      status: 'cancelled',
      cancel_url: null,
      reschedule_url: null,
    });
  });

  it('rejects a body whose status is not one the join card knows', async () => {
    stubCore(() => Response.json({ booking: { ...UPSTREAM, status: 'confirmed' } }));
    await expect(fetchPublicBookingProjection(env as Env, 'rosa', TOKEN))
      .resolves.toEqual({ outcome: 'unavailable' });

    stubCore(() => new Response('not json', { status: 200 }));
    await expect(fetchPublicBookingProjection(env as Env, 'rosa', TOKEN))
      .resolves.toEqual({ outcome: 'unavailable' });
  });

  it('falls back to a Meet-minted calendar token when Core has no row', async () => {
    stubCore(() => Response.json({ error: 'Booking not found' }, { status: 404 }));
    const minted = 'MeetMintedToken12';
    await env.CALENDAR_TOKENS.put(`calendar:booking:${minted}`, JSON.stringify({
      v: 1,
      slug: 'rosa',
      title: 'Design review',
      starts_at: '2026-08-14T10:00:00.000Z',
      ends_at: '2026-08-14T11:00:00.000Z',
      status: 'scheduled',
      owner_sub: 'owner-1',
    }));
    const lookup = await fetchPublicBookingProjection(env as Env, 'rosa', minted);
    expect(lookup).toEqual({
      outcome: 'found',
      projection: {
        title: 'Design review',
        subject: null,
        starts_at: '2026-08-14T10:00:00.000Z',
        ends_at: '2026-08-14T11:00:00.000Z',
        status: 'scheduled',
        reschedule_url: null,
        cancel_url: null,
        guest_name: null,
        guest_email: null,
      },
    });
    await env.CALENDAR_TOKENS.delete(`calendar:booking:${minted}`);
  });

  it('projects a hand-sent invite: named guest, no window, never expired', async () => {
    stubCore(() => Response.json({ error: 'Booking not found' }, { status: 404 }));
    const minted = 'MeetInviteToken12';
    await env.CALENDAR_TOKENS.put(`calendar:booking:${minted}`, JSON.stringify({
      v: 1,
      slug: 'rosa',
      title: 'Q4 roadmap',
      starts_at: null,
      ends_at: null,
      status: 'scheduled',
      owner_sub: 'owner-1',
      guest_name: 'Ada',
      guest_email: 'ada@example.net',
    }));
    const lookup = await fetchPublicBookingProjection(env as Env, 'rosa', minted);
    expect(lookup.outcome === 'found' && lookup.projection).toMatchObject({
      title: 'Q4 roadmap',
      starts_at: null,
      ends_at: null,
      status: 'scheduled',
      guest_name: 'Ada',
      guest_email: 'ada@example.net',
    });
    await env.CALENDAR_TOKENS.delete(`calendar:booking:${minted}`);
  });
});

describe('GET /api/rooms/:slug/bookings/:token', () => {
  it('serves the projection for a mapped room', async () => {
    stubCore(() => Response.json({ booking: UPSTREAM }));
    const response = await exports.default.fetch(
      new Request(`http://local/api/rooms/rosa/bookings/${TOKEN}`),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SCHEDULED);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('404s an unmapped slug without ever asking Core', async () => {
    const core = stubCore(() => Response.json({ booking: UPSTREAM }));
    const response = await exports.default.fetch(
      new Request(`http://local/api/rooms/not-rosa/bookings/${TOKEN}`),
    );
    expect(response.status).toBe(404);
    expect(core.url()).toBe('');
  });

  it('404s an unknown token and 502s a Core outage', async () => {
    stubCore(() => Response.json({ error: 'Booking not found' }, { status: 404 }));
    const unknown = await exports.default.fetch(
      new Request(`http://local/api/rooms/rosa/bookings/${TOKEN}`),
    );
    expect(unknown.status).toBe(404);

    stubCore(() => Response.json({ error: 'boom' }, { status: 503 }));
    const outage = await exports.default.fetch(
      new Request(`http://local/api/rooms/rosa/bookings/${TOKEN}`),
    );
    expect(outage.status).toBe(502);
  });

  it('refuses a token shaped like a path, so nothing extra reaches Core', async () => {
    const core = stubCore(() => Response.json({ booking: UPSTREAM }));
    for (const token of ['short', '../../admin', `${TOKEN}/extra`]) {
      const response = await exports.default.fetch(
        new Request(`http://local/api/rooms/rosa/bookings/${token}`),
      );
      expect(response.status).toBe(404);
    }
    expect(core.url()).toBe('');
  });
});

describe('GET /api/bookings/:token/room', () => {
  it('resolves a token to the room it opens, so a bare token can be pasted', async () => {
    const core = stubCore(() => Response.json({ room: { username_slug: 'rosa' } }));
    const response = await exports.default.fetch(
      new Request(`http://local/api/bookings/${TOKEN}/room`),
    );
    expect(core.url()).toBe(`https://core.invalid/api/public/bookings/${TOKEN}/room`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ slug: 'rosa' });
  });

  it('refuses to point at a room Meet does not serve', async () => {
    stubCore(() => Response.json({ room: { username_slug: 'not-rosa' } }));
    const response = await exports.default.fetch(
      new Request(`http://local/api/bookings/${TOKEN}/room`),
    );
    expect(response.status).toBe(404);
  });

  it('404s an unknown token and 502s a Core outage', async () => {
    stubCore(() => Response.json({ error: 'Booking not found' }, { status: 404 }));
    expect((await exports.default.fetch(
      new Request(`http://local/api/bookings/${TOKEN}/room`),
    )).status).toBe(404);

    stubCore(() => Response.json({ error: 'boom' }, { status: 503 }));
    expect((await exports.default.fetch(
      new Request(`http://local/api/bookings/${TOKEN}/room`),
    )).status).toBe(502);
  });

  it('never forwards something path-shaped or too short to be a token', async () => {
    const core = stubCore(() => Response.json({ room: { username_slug: 'rosa' } }));
    for (const token of ['short', '../../admin', `${TOKEN}/extra`]) {
      const response = await exports.default.fetch(
        new Request(`http://local/api/bookings/${token}/room`),
      );
      expect(response.status).toBe(404);
    }
    expect(core.url()).toBe('');
  });
});

describe('POST /api/schedule/:slug/book', () => {
  const origin = env.WEB_ORIGIN;

  it('strips turnstile_token before Core sees the booking', async () => {
    const core = stubCore(() => Response.json({ booking: { id: 'b1' } }));
    const response = await exports.default.fetch(new Request('http://local/api/schedule/rosa/book', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({
        guest_name: 'Ana',
        guest_email: 'ana@acme.com',
        turnstile_token: 'browser-token',
      }),
    }));
    expect(response.status).toBe(200);
    expect(core.url()).toBe('https://core.invalid/api/meet/rosa/book');
    expect(JSON.parse(core.body())).toEqual({
      guest_name: 'Ana',
      guest_email: 'ana@acme.com',
    });
  });

  it('refuses a booking that did not come from the web origin', async () => {
    stubCore(() => Response.json({ booking: { id: 'b1' } }));
    const response = await exports.default.fetch(new Request('http://local/api/schedule/rosa/book', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ guest_name: 'Ana' }),
    }));
    expect(response.status).toBe(403);
  });
});
