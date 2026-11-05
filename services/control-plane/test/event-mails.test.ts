/**
 * The reminder and the follow-up mail of an event sign-up (meet#970,
 * docs/SESSIONS.md §0 S5 and S6): idempotency through the sent-at stamps,
 * cancelled registrations, the empty-note refusal and the permission rule.
 */
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { sendDueReminders } from '../src/event-signup-mail';
import { resetRoleCache } from '../src/capabilities';
import { personIdForEmail } from '../src/person-ids';

const d1 = { ...env, WORK_STORE: 'd1', POSTMARK_API_KEY: 'test-postmark-key', MAIL_FROM: 'Starlings <contact@org.example>' } as Env;
const EVENT_ID = 'abcdef12-0000-4000-8000-0000000000dd';
const MINUTE = 60_000;
const CREATOR = 'eventmail-ana@example.com';
const OTHER = 'eventmail-bo@example.com';
const ADMIN = 'rosa@example.com';

let sent: Array<{ To: string; Subject: string; TextBody: string; HtmlBody?: string; Headers?: Array<{ Name: string; Value: string }> }> = [];

async function invoke(request: Request): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, d1, context);
  await waitOnExecutionContext(context);
  return response;
}

async function member(email: string): Promise<Record<string, string>> {
  const session = await invoke(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, name: email.split('@')[0] }),
  }));
  expect(session.status).toBe(200);
  return { authorization: `Bearer ${(await session.json<{ access_token: string }>()).access_token}` };
}

async function followUp(headers: Record<string, string>): Promise<Response> {
  return invoke(new Request(`http://local/api/events/${EVENT_ID}/follow-up`, { method: 'POST', headers }));
}

async function seed(startsAt: number, note: string | null, createdBy: string | null): Promise<void> {
  await env.USAGE.prepare(`
    INSERT INTO events (id, title, starts_on, public_slug, starts_at, ends_at, time_zone, room_slug, cta_url, cta_label, follow_up_note, created_by, created_at, updated_at, description)
    VALUES (?1, 'Starlings at work', '2026-10-20', 'starlings-at-work', ?2, ?3, 'Europe/Amsterdam', 'rosa', 'https://site.example/interest?source=artificial-insights', 'Ask about a pilot', ?4, ?5, 0, 0, 'A live call where Starlings runs a real project.')`)
    .bind(EVENT_ID, startsAt, startsAt + 45 * MINUTE, note, createdBy)
    .run();
  const insert = env.USAGE.prepare(`
    INSERT INTO event_registrations (id, event_id, name, email, join_token, status, ics_uid, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)`);
  await env.USAGE.batch([
    insert.bind('reg-1', EVENT_ID, 'Ada', 'ada@example.test', 'TokenAdaRegistered01', 'registered', 'uid-1'),
    insert.bind('reg-2', EVENT_ID, 'Ben', 'ben@example.test', 'TokenBenRegistered01', 'registered', 'uid-2'),
    insert.bind('reg-3', EVENT_ID, 'Cy', 'cy@example.test', 'TokenCyCancelled0001', 'cancelled', 'uid-3'),
  ]);
}

beforeEach(async () => {
  sent = [];
  resetRoleCache();
  await env.USAGE.batch([
    env.USAGE.prepare('DELETE FROM event_registrations'),
    env.USAGE.prepare('DELETE FROM events'),
    env.USAGE.prepare('DELETE FROM event_mail_opt_outs'),
    env.USAGE.prepare('DELETE FROM event_mail_unsubscribe_links'),
  ]);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new Request(input, init).url;
    if (!url.startsWith('https://api.postmarkapp.com/')) throw new Error(`unexpected outbound request: ${url}`);
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ ErrorCode: 0 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the reminder', () => {
  it('goes once to each live registration, an hour before the start', async () => {
    await seed(Date.now() + 40 * MINUTE, 'Thanks for coming.', null);
    expect(await sendDueReminders(d1)).toBe(2);
    expect(sent.map((mail) => mail.To).sort()).toEqual(['ada@example.test', 'ben@example.test']);
    expect(sent[0]!.TextBody).toMatch(/\/room\/rosa\/TokenAdaRegistered01|\/room\/rosa\/TokenBenRegistered01/u);
    expect(sent.every((mail) => !mail.TextBody.includes('example.test'))).toBe(true);
    expect(sent.every((mail) => !mail.TextBody.includes('A live call'))).toBe(true);
    // Transactional: no unsubscribe link, no List-Unsubscribe (meet#1071).
    expect(sent.every((mail) => !mail.TextBody.includes('Unsubscribe') && !mail.Headers)).toBe(true);
    expect(await sendDueReminders(d1)).toBe(0);
    expect(sent).toHaveLength(2);
  });

  it('waits until the event is within the hour', async () => {
    await seed(Date.now() + 2 * 60 * MINUTE, 'Thanks for coming.', null);
    expect(await sendDueReminders(d1)).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

describe('the follow-up', () => {
  it('goes to every live registration once, when the creator asks', async () => {
    await member(CREATOR);
    await seed(Date.now() - 2 * 60 * MINUTE, 'Thanks for coming. The notes are on the event page.', await personIdForEmail(d1, CREATOR));
    const headers = await member(CREATOR);
    const first = await followUp(headers);
    expect(first.status, await first.clone().text()).toBe(200);
    expect(await first.json()).toEqual({ sent: 2 });
    expect(sent.map((mail) => mail.To).sort()).toEqual(['ada@example.test', 'ben@example.test']);
    expect(sent[0]!.TextBody).toContain('Thanks for coming.');
    expect(sent[0]!.TextBody).not.toContain('A live call');
    expect(sent[0]!.TextBody).toContain('https://site.example/interest?source=artificial-insights');
    expect(await (await followUp(headers)).json()).toEqual({ sent: 0 });
  });

  // meet#1071: a follow-up can be marketing, so it can be refused in one click.
  it('carries an unsubscribe link, and an address that clicks it gets no further follow-up', async () => {
    await seed(Date.now() - 2 * 60 * MINUTE, 'Thanks for coming.', null);
    const admin = await member(ADMIN);
    expect(await (await followUp(admin)).json()).toEqual({ sent: 2 });
    const ada = sent.find((mail) => mail.To === 'ada@example.test')!;
    const link = /(https?:\/\/\S+\/api\/event-mail\/unsubscribe\/[A-Za-z0-9_-]{43})/u.exec(ada.TextBody)?.[1];
    expect(link).toBeDefined();
    expect(link).not.toContain('ada');
    expect(ada.HtmlBody).toContain(link);
    expect(ada.Headers).toEqual([
      { Name: 'List-Unsubscribe', Value: `<${link}>` },
      { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
    ]);

    const page = await invoke(new Request(`http://local${new URL(link!).pathname}`));
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    // A mail client's one-click POST works too, and repeating it is harmless.
    expect((await invoke(new Request(`http://local${new URL(link!).pathname}`, { method: 'POST' }))).status).toBe(204);
    expect((await invoke(new Request('http://local/api/event-mail/unsubscribe/' + 'A'.repeat(43)))).status).toBe(404);

    // The next event's follow-up skips Ada and still reaches Ben.
    sent = [];
    await env.USAGE.batch([env.USAGE.prepare('DELETE FROM event_registrations'), env.USAGE.prepare('DELETE FROM events')]);
    await seed(Date.now() - 2 * 60 * MINUTE, 'Thanks again.', null);
    expect(await (await followUp(admin)).json()).toEqual({ sent: 1 });
    expect(sent.map((mail) => mail.To)).toEqual(['ben@example.test']);
  });

  it('lets a workspace admin send it too', async () => {
    await seed(Date.now() - 2 * 60 * MINUTE, 'Thanks for coming.', null);
    const response = await followUp(await member(ADMIN));
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ sent: 2 });
  });

  it('refuses a member who neither made the event nor runs the workspace', async () => {
    await member(CREATOR);
    await seed(Date.now() - 2 * 60 * MINUTE, 'Thanks for coming.', await personIdForEmail(d1, CREATOR));
    expect((await followUp(await member(OTHER))).status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it('refuses an event with no follow-up note', async () => {
    await seed(Date.now() - 2 * 60 * MINUTE, null, null);
    expect((await followUp(await member(ADMIN))).status).toBe(409);
    expect(sent).toHaveLength(0);
  });
});
