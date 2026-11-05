/**
 * The sign-up page's endpoint and the confirmation mail (meet#967,
 * docs/SESSIONS.md §0). Runs as a `d1` workspace, through the Worker's routes;
 * the store seam itself is tested on both stores in event-signups.test.ts.
 */
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_REGISTRATION_CAP } from '@starlings/contracts/event-signups';
import worker from '../src/index';
import { buildSessionInvite, confirmationMail, sessionTimeLine } from '../src/event-invite';
import { eventHeadTags, roomHeadTags, ROOM_SHARE_DESCRIPTION } from '../src/event-page';
import { googleCalendarURL, outlookCalendarURL } from '@starlings/contracts/event-calendar';

const SLUG = 'starlings-at-work';
const EVENT_ID = 'abcdef12-0000-4000-8000-0000000000aa';
const STARTS = Date.parse('2099-10-20T15:00:00.000Z');
const POSTMARK_KEY = 'test-postmark-key';

const base = { ...env, WORK_STORE: 'd1', POSTMARK_API_KEY: POSTMARK_KEY, MAIL_FROM: 'Starlings <contact@org.example>' } as Env;

interface SentMail { To: string; Subject: string; TextBody: string; HtmlBody: string; Attachments?: Array<{ Name: string; Content: string; ContentType: string }> }
let sent: SentMail[] = [];

function stubOutbound(turnstile: boolean = true): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (url.startsWith('https://api.postmarkapp.com/')) {
      sent.push(JSON.parse(String(init?.body)) as SentMail);
      return Response.json({ ErrorCode: 0 });
    }
    if (url.startsWith('https://challenges.cloudflare.com/')) return Response.json({ success: turnstile });
    throw new Error(`unexpected outbound request: ${url}`);
  });
}

async function call(path: string, body?: unknown, apiEnv: Env = base): Promise<Response> {
  return callWith(path, body, apiEnv);
}

async function callWith(path: string, body: unknown, apiEnv: Env): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`http://local${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: env.WEB_ORIGIN, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), apiEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

async function seedEvent(startsAt = STARTS): Promise<void> {
  await env.USAGE.prepare(`
    INSERT INTO events (id, title, starts_on, public_slug, starts_at, ends_at, time_zone, room_slug, cta_url, cta_label, follow_up_note, created_at, updated_at, description, body, image_url)
    VALUES (?1, 'Starlings at work', '2099-10-20', ?2, ?3, ?4, 'Europe/Amsterdam', 'rosa', 'https://site.example/interest?source=artificial-insights', 'Ask about a pilot', 'Thanks for coming.', 0, 0, ?5, ?6, ?7)`)
    .bind(EVENT_ID, SLUG, startsAt, startsAt + 45 * 60_000, DESCRIPTION, BODY, IMAGE)
    .run();
}

const DESCRIPTION = 'A live call where Starlings runs a real project.';
const BODY = '## What happens\n\nA real project, live.';
const IMAGE = 'https://images.example.test/cover.png';
const person = { name: 'Ada Example', email: 'ada@example.test' };

beforeEach(async () => {
  sent = [];
  stubOutbound();
  await env.USAGE.batch([
    env.USAGE.prepare('DELETE FROM event_registrations'),
    env.USAGE.prepare('DELETE FROM events'),
    env.USAGE.prepare(`DELETE FROM people WHERE email = 'rosa@example.com'`),
  ]);
  await seedEvent();
});

/** The owner of room `rosa` in the test map, with a name and, when given, a photo. */
async function seedHost(photo: boolean): Promise<void> {
  await env.USAGE.prepare(`INSERT INTO people (sub, email, name, first_seen_at, last_seen_at, avatar_updated_at, avatar_content_type)
    VALUES ('host-sub', 'rosa@example.com', 'Rosa Ortiz', 1, 1, ?1, ?2)`)
    .bind(photo ? 1234 : null, photo ? 'image/png' : null)
    .run();
  if (photo) await env.AVATARS.put('avatars/host-sub', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { httpMetadata: { contentType: 'image/png' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('event sign-up page', () => {
  it('shows the public projection with the description: no note, no count', async () => {
    const response = await call(`/api/events/${SLUG}`);
    expect(response.status).toBe(200);
    const { event } = await response.json<{ event: Record<string, unknown> }>();
    expect(event).toMatchObject({ id: EVENT_ID, slug: SLUG, title: 'Starlings at work', room_slug: 'rosa', open: true, closed_reason: null, cta_label: 'Ask about a pilot', description: DESCRIPTION });
    expect(event).toMatchObject({ body: BODY, image_url: IMAGE, attendance: 'online', duration_minutes: 45, host: null, spots_left: null, going: null });
    expect(event).not.toHaveProperty('follow_up_note');
    expect(event).not.toHaveProperty('registration_count');
  });

  it('names the room owner as host, from the people records, and serves the photo', async () => {
    await seedHost(true);
    const { event } = await (await call(`/api/events/${SLUG}`)).json<{ event: { host: { name: string; image_url: string | null } } }>();
    expect(event.host).toEqual({ name: 'Rosa Ortiz', image_url: `/api/events/${SLUG}/host-photo?v=1234` });
    const photo = await call(event.host.image_url!);
    expect(photo.status).toBe(200);
    expect(photo.headers.get('content-type')).toBe('image/png');
    expect((await call('/api/events/nothing-here/host-photo')).status).toBe(404);
  });

  it('shows a host without a photo, and serves no photo', async () => {
    await seedHost(false);
    const { event } = await (await call(`/api/events/${SLUG}`)).json<{ event: { host: unknown } }>();
    expect(event.host).toEqual({ name: 'Rosa Ortiz', image_url: null });
    expect((await call(`/api/events/${SLUG}/host-photo`)).status).toBe(404);
  });

  it('answers 404 for a slug with no event', async () => {
    expect((await call('/api/events/nothing-here')).status).toBe(404);
    expect((await call('/api/events/nothing-here/register', person)).status).toBe(404);
  });

  it('signs up, and mails the personal link with the calendar invite', async () => {
    const response = await call(`/api/events/${SLUG}/register`, person);
    expect(response.status, await response.clone().text()).toBe(202);
    const answer = await response.json<{ ok: true; join: { url: string; ics_uid: string; ics_sequence: number } }>();
    const row = await env.USAGE.prepare('SELECT join_token, ics_uid, confirmation_sent_at FROM event_registrations').first<{ join_token: string; ics_uid: string; confirmation_sent_at: number | null }>();
    // A new sign-up gets its link and its calendar id on the page (SESSIONS.md S9).
    expect(answer).toEqual({ ok: true, join: { url: expect.stringContaining(`/room/rosa/${row!.join_token}`), ics_uid: row!.ics_uid, ics_sequence: 0 } });
    expect(row?.confirmation_sent_at).not.toBeNull();
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.To).toBe('ada@example.test');
    expect(mail.TextBody).toContain(`/room/rosa/${row!.join_token}`);
    expect(mail.TextBody).toContain('https://site.example/interest?source=artificial-insights');
    expect(mail.TextBody).toMatch(/17:00 to 17:45 CEST\n\nA live call where Starlings runs a real project\.\n\nJoin with your link/u);
    expect(mail.HtmlBody).toContain(`<p>${DESCRIPTION}</p>`);
    expect(mail.TextBody).not.toMatch(/—/u);
    expect(mail.TextBody).toContain('This link is yours. The calendar invite is attached.');
    expect(mail.HtmlBody).toContain(`/room/rosa/${row!.join_token}`);
    const invite = mail.Attachments?.[0];
    expect(invite?.ContentType).toBe('text/calendar; method=REQUEST; charset=utf-8');
    const ics = new TextDecoder().decode(Uint8Array.from(atob(invite!.Content), (char) => char.charCodeAt(0)));
    expect(ics).toContain(`UID:${row!.ics_uid}`);
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics.replace(/\r\n /gu, '')).toContain(`/room/rosa/${row!.join_token}`);
  });

  it('answers a repeat sign-up with no link, and mails the same token and calendar id again', async () => {
    const first = await call(`/api/events/${SLUG}/register`, person);
    const second = await call(`/api/events/${SLUG}/register`, { ...person, email: 'ADA@example.test' });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect((await first.json<{ join: unknown }>()).join).not.toBeNull();
    expect(await second.json()).toEqual({ ok: true, join: null });
    const rows = await env.USAGE.prepare('SELECT join_token FROM event_registrations').all<{ join_token: string }>();
    expect(rows.results).toHaveLength(1);
    expect(sent).toHaveLength(2);
    const uid = (mail: SentMail) => /UID:([^\r\n]+)/u.exec(atob(mail.Attachments![0]!.Content))?.[1];
    expect(uid(sent[1]!)).toBe(uid(sent[0]!));
    expect(sent[1]!.TextBody).toContain(`/room/rosa/${rows.results[0]!.join_token}`);
  });

  it('refuses a bad Turnstile answer once the secret is set', async () => {
    stubOutbound(false);
    const response = await call(`/api/events/${SLUG}/register`, { ...person, turnstile_token: 'bad' }, { ...base, TURNSTILE_SECRET_KEY: 'test-turnstile-secret' } as Env);
    expect(response.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it('refuses a caller over the rate limit', async () => {
    const limited = { ...base, FEEDBACK_LIMIT: { limit: async () => ({ success: false }) } } as unknown as Env;
    expect((await call(`/api/events/${SLUG}/register`, person, limited)).status).toBe(429);
  });

  it('refuses a sign-up after the start', async () => {
    await env.USAGE.prepare('UPDATE events SET starts_at = ?1').bind(Date.now() - 60_000).run();
    expect((await call(`/api/events/${SLUG}/register`, person)).status).toBe(409);
    const { event } = await (await call(`/api/events/${SLUG}`)).json<{ event: { open: boolean; closed_reason: string } }>();
    expect(event).toMatchObject({ open: false, closed_reason: 'started' });
  });

  it('refuses a sign-up on a full event', async () => {
    const insert = env.USAGE.prepare(`INSERT INTO event_registrations (id, event_id, name, email, join_token, ics_uid, created_at) VALUES (?1, ?2, 'P', ?3, ?4, ?5, 0)`);
    await env.USAGE.batch(Array.from({ length: SESSION_REGISTRATION_CAP }, (_, n) => insert.bind(`reg-${n}`, EVENT_ID, `p${n}@example.test`, `TOKEN${String(n).padStart(11, '0')}`, `uid-${n}`)));
    expect((await call(`/api/events/${SLUG}/register`, person)).status).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it('logs no token and no address', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    }
    await call(`/api/events/${SLUG}/register`, person);
    vi.stubGlobal('fetch', async () => new Response('down', { status: 500 }));
    await call(`/api/events/${SLUG}/register`, person);
    const row = await env.USAGE.prepare('SELECT join_token FROM event_registrations').first<{ join_token: string }>();
    for (const line of lines) {
      expect(line).not.toContain('ada@example.test');
      expect(line).not.toContain(row!.join_token);
    }
  });
});

describe('the calendar invite', () => {
  const event = { title: 'Starlings, at work; live', starts_at: '2099-10-20T15:00:00.000Z', ends_at: '2099-10-20T15:45:00.000Z' };
  const invite = (uid: string) => buildSessionInvite({
    uid, sequence: 0, method: 'REQUEST', event,
    url: 'https://meet.example.test/room/rosa/K7Q2M9X4C8V1B6N3',
    organizer: { name: 'Starlings', email: 'contact@example.test' },
    attendee: { name: 'Ada Example', email: 'ada@example.test' },
    now: new Date('2099-10-01T00:00:00.000Z'),
  });

  it('keeps the UID it is given, writes CRLF lines of at most 75 octets, and escapes text', () => {
    const ics = invite('reg-1@meet.example.test');
    expect(ics).toContain('UID:reg-1@meet.example.test\r\n');
    expect(ics).toContain('DTSTART:20991020T150000Z\r\n');
    expect(ics).toContain('SUMMARY:Starlings\\, at work\\; live\r\n');
    expect(ics).toContain('TRIGGER:-PT15M');
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(invite('reg-1@meet.example.test')).toBe(ics);
  });

  it('writes the time in the event zone on a 24-hour clock', () => {
    expect(sessionTimeLine({ ...event, time_zone: 'Europe/Amsterdam' })).toBe('Tuesday, 20 October 2099, 17:00 to 17:45 CEST');
    const mail = confirmationMail({
      ...event, id: 'x', slug: 's', description: null, body: null, image_url: null, attendance: null, duration_minutes: null,
      time_zone: null, room_slug: 'rosa', cta_url: null, cta_label: null, follow_up_note: null, registration_count: 0,
    }, 'Ada', 'https://meet.example.test/room/rosa/T');
    expect(mail.text).not.toMatch(/[—–]|AM|PM/u);
  });

  it('writes a PUBLISH file for the page with the same UID, the link as location and notes, and no people', () => {
    const ics = buildSessionInvite({ uid: 'reg-1@meet.example.test', sequence: 0, method: 'PUBLISH', event, url: 'https://meet.example.test/room/rosa/K7Q2M9X4C8V1B6N3' });
    const unfolded = ics.replace(/\r\n /gu, '');
    expect(unfolded).toContain('METHOD:PUBLISH\r\n');
    expect(unfolded).toContain('UID:reg-1@meet.example.test\r\n');
    expect(unfolded).toContain('LOCATION:https://meet.example.test/room/rosa/K7Q2M9X4C8V1B6N3\r\n');
    expect(unfolded).toContain('DESCRIPTION:https://meet.example.test/room/rosa/K7Q2M9X4C8V1B6N3\r\n');
    expect(unfolded).not.toMatch(/ORGANIZER|ATTENDEE/u);
  });

  it('builds the Google and Outlook links with the time and the link', () => {
    const link = 'https://meet.example.test/room/rosa/T';
    const google = new URL(googleCalendarURL(event, link));
    expect(google.searchParams.get('dates')).toBe('20991020T150000Z/20991020T154500Z');
    expect(google.searchParams.get('location')).toBe(link);
    const outlook = new URL(outlookCalendarURL(event, link));
    expect(outlook.searchParams.get('startdt')).toBe('2099-10-20T15:00:00.000Z');
    expect(outlook.searchParams.get('body')).toBe(link);
  });
});

describe('the event page head', () => {
  const SHELL = '<!doctype html><html><head><title>Starlings</title><meta name="description" content="Generic" /></head><body><div id="root"></div></body></html>';
  const assets = { fetch: async () => new Response(SHELL, { headers: { 'content-type': 'text/html; charset=utf-8' } }) };
  const withAssets = { ...base, ASSETS: assets } as unknown as Env;
  const metaCount = (html: string, key: string) => html.split(key).length - 1;

  it('replaces the title and the description, and adds the preview tags with the cover image', async () => {
    const response = await callWith(`/event/${SLUG}`, undefined, withAssets);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<title>Starlings at work · Envisioning</title>');
    expect(html).not.toContain('Generic');
    expect(metaCount(html, 'name="description"')).toBe(1);
    expect(html).toContain(`<meta property="og:description" content="${DESCRIPTION}">`);
    expect(html).toContain(`<meta property="og:image" content="${IMAGE}">`);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain(`<meta property="og:url" content="${new URL(env.WEB_ORIGIN).origin}/event/${SLUG}">`);
  });

  it('shows the workspace card for an unknown slug, and keeps the shell title and description', async () => {
    const html = await (await callWith('/event/nothing-here', undefined, withAssets)).text();
    expect(html).toContain('<title>Starlings</title>');
    expect(html).toContain('content="Generic"');
    expect(html).toContain('<meta property="og:title" content="Envisioning">');
    expect(html).not.toContain('og:description');
    expect(metaCount(html, 'og:title')).toBe(1);
  });

  it('keeps the card a prerendered page carries', async () => {
    const own = SHELL.replace('</head>', '<meta property="og:title" content="Own"></head>');
    const page = { ...base, ASSETS: { fetch: async () => new Response(own, { headers: { 'content-type': 'text/html; charset=utf-8' } }) } } as unknown as Env;
    const html = await (await callWith('/event/nothing-here', undefined, page)).text();
    expect(metaCount(html, 'og:title')).toBe(1);
    expect(html).toContain('content="Own"');
  });

  it('names whose room a room link opens', () => {
    const { title, meta } = roomHeadTags({ owner: 'Ana "A" Lima', workspace: 'Envisioning', url: 'https://example.test/room/ana', image: 'https://example.test/icon-512.png' });
    expect(title).toBe('Ana "A" Lima’s room · Envisioning');
    expect(meta).toContain('<meta property="og:title" content="Ana &#34;A&#34; Lima’s room">');
    expect(meta).toContain(`<meta property="og:description" content="${ROOM_SHARE_DESCRIPTION}">`);
    expect(meta).toContain('<meta property="og:image" content="https://example.test/icon-512.png">');
    expect(meta).toContain('<meta name="twitter:card" content="summary">');
  });

  it('escapes every value, uses the time line without a description, and a summary card without an image', () => {
    const { title, meta } = eventHeadTags({
      event: { title: 'A "quoted" <event>', description: null, image_url: null, starts_at: '2099-10-20T15:00:00.000Z', ends_at: '2099-10-20T15:45:00.000Z', time_zone: 'Europe/Amsterdam' },
      workspace: 'Envisioning',
      url: 'https://example.test/event/x',
      fallbackImage: 'https://example.test/icon-512.png',
    });
    expect(title).toBe('A "quoted" <event> · Envisioning');
    expect(meta).toContain('content="A &#34;quoted&#34; &#60;event&#62;"');
    expect(meta).toContain('content="Tuesday, 20 October 2099, 17:00 to 17:45 CEST"');
    expect(meta).toContain('<meta property="og:image" content="https://example.test/icon-512.png">');
    expect(meta).toContain('<meta name="twitter:card" content="summary">');
  });
});
