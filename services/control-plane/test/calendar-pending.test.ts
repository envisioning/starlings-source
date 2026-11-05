// Mail forwarded to calendar@ becomes proposed events (meet#234).
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PendingCalendarEvent } from '@starlings/contracts';
import { readEvents } from '../src/calendar-extract';
import { slugLocalPart } from '../src/inbound-address';
import { handleInboundEmail, type InboundEmailMessage } from '../src/inbound-email';
import { sweepPendingEvents } from '../src/pending-calendar-events';
import { recordOwnerSignIn } from '../src/usage';
import { withInboundMailbox } from './inbound-mailbox';

withInboundMailbox();

const rosa ={ sub: 'dev:cp-rosa@example.com', email: 'cp-rosa@example.com', name: 'Rosa' };

type MutableEnv = Omit<Env, 'INBOUND_EMAIL' | 'ANTHROPIC_API_KEY'> & { INBOUND_EMAIL: string; ANTHROPIC_API_KEY: string };

const outbound = {
  title: 'Flight LIS → AMS TP670',
  all_day: false,
  start: '2026-10-03T07:10:00+01:00',
  end: '2026-10-03T11:05:00+02:00',
  time_zone: 'Europe/Lisbon',
  location: 'LIS → AMS',
  notes: 'Booking ref X7Q2ZP, seat 14A',
  attendees: [],
  confidence: 0.96,
};
const back = { ...outbound, title: 'Flight AMS → LIS TP671', start: '2026-10-06T18:20:00+02:00', end: '2026-10-06T20:10:00+01:00', time_zone: 'Europe/Amsterdam', location: 'AMS → LIS' };

/** Claude answering from a script: the fetch the SDK makes is the only network here. */
function withExtractor(events: unknown[], onRequest?: (body: unknown) => void): () => void {
  const mutable = env as MutableEnv;
  const key = mutable.ANTHROPIC_API_KEY;
  mutable.ANTHROPIC_API_KEY = 'sk-ant-test';
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes('/v1/messages')) throw new Error(`unexpected fetch ${url}`);
    onRequest?.(JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : '{}'))));
    return new Response(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'propose_events', input: { events } }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 400, output_tokens: 120 },
    }), { headers: { 'content-type': 'application/json' } });
  });
  return () => { mutable.ANTHROPIC_API_KEY = key ?? ''; };
}

async function member() {
  await recordOwnerSignIn(env as Env, rosa, 'mac');
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: rosa.name, email: rosa.email }),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json' };
}

async function pending(headers: Record<string, string>): Promise<PendingCalendarEvent[]> {
  const response = await exports.default.fetch(new Request('http://local/api/calendar/pending', { headers }));
  expect(response.status).toBe(200);
  return (await response.json<{ events: PendingCalendarEvent[] }>()).events;
}

const FORWARD = [
  'Only the flights, not the hotel.',
  '',
  '---------- Forwarded message ---------',
  'From: TAP <noreply@flytap.example>',
  'Date: Wed, 17 Sep 2026 at 16:02',
  'Subject: Your booking X7Q2ZP',
  'To: Rosa <rosa@example.com>',
  '',
  'TP670 Lisbon 07:10 → Amsterdam 11:05, 3 Oct 2026, seat 14A',
  'TP671 Amsterdam 18:20 → Lisbon 20:10, 6 Oct 2026',
  'Hotel Ambassade, 3–6 Oct',
].join('\n');

function rawMail(text: string, to = 'meet-test.calendar@starlings.example'): string {
  return [
    `From: Rosa <${rosa.email}>`,
    `To: ${to}`,
    'Subject: Fwd: Your booking X7Q2ZP',
    'Date: Thu, 18 Sep 2026 09:00:00 +0100',
    'Message-ID: <fwd-1@mail.example>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
  ].join('\r\n');
}

function envelope(raw: string, overrides: Partial<Omit<InboundEmailMessage, 'raw'>> = {}): InboundEmailMessage {
  const bytes = new TextEncoder().encode(raw);
  return {
    from: rosa.email,
    to: 'meet-test.calendar@starlings.example',
    headers: new Headers(),
    raw: new Response(bytes).body!,
    rawSize: bytes.byteLength,
    ...overrides,
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await env.USAGE.prepare('DELETE FROM pending_calendar_events').run();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'cp-%'").run();
});

describe('the address', () => {
  it('is never minted for a subject', () => {
    expect(slugLocalPart('Calendar')).toBeNull();
    expect(slugLocalPart('Events')).toBeNull();
    expect(slugLocalPart('Calendar 2027')).toBe('calendar-2027');
  });
});

describe('what the model said', () => {
  it('keeps rows the schema accepts, over the confidence floor, up to the cap', () => {
    const rows = readEvents({
      events: [
        outbound,
        { ...back, confidence: 0.2 },
        { ...back, start: 'tomorrow' },
        { ...back, all_day: true },
        { ...back, all_day: true, start: '2026-10-06', end: '2026-10-07' },
        ...Array.from({ length: 10 }, (_, index) => ({ ...back, title: `Row ${index}` })),
      ],
    });
    expect(rows).not.toBeNull();
    expect(rows!.length).toBe(8);
    expect(rows![0]).toEqual(outbound);
    expect(rows![1]).toMatchObject({ all_day: true, start: '2026-10-06' });
    expect(rows!.some((row) => row.confidence < 0.5 || row.start === 'tomorrow')).toBe(false);
  });

  it('is nothing when the envelope is not what the tool takes', () => {
    expect(readEvents(undefined)).toBeNull();
    expect(readEvents({ rows: [] })).toBeNull();
    expect(readEvents({ events: [] })).toEqual([]);
  });
});

describe('a mail to calendar@', () => {
  it('proposes its events once, with the forwarder’s note as instructions', async () => {
    let sent: unknown = null;
    const restore = withExtractor([outbound, back], (body) => { sent = body; });
    try {
      const headers = await member();
      const first = await handleInboundEmail(envelope(rawMail(FORWARD)), env as Env);
      expect(first).toEqual({ accepted: true, calendar: true, proposed: 2, duplicate: false });

      const request = sent as { messages: Array<{ content: string }>; tool_choice: { name: string } };
      expect(request.tool_choice.name).toBe('propose_events');
      expect(request.messages[0]!.content).toContain('Instructions from the person forwarding:\nOnly the flights, not the hotel.');
      expect(request.messages[0]!.content).toContain('Subject: Your booking X7Q2ZP');
      expect(request.messages[0]!.content).not.toContain('Forwarded message');

      const rows = await pending(headers);
      expect(rows.map((row) => row.title)).toEqual([outbound.title, back.title]);
      expect(rows[0]).toMatchObject({
        all_day: false,
        start: outbound.start,
        location: 'LIS → AMS',
        notes: 'Booking ref X7Q2ZP, seat 14A',
        source_subject: 'Your booking X7Q2ZP',
        source_from: 'TAP <noreply@flytap.example>',
        confidence: 0.96,
      });
      expect(rows[0]!.expires_at - rows[0]!.created_at).toBe(7 * 24 * 60 * 60 * 1_000);

      // The same mail again, from another client: the model is not asked twice.
      const second = await handleInboundEmail(envelope(rawMail(FORWARD).replace('fwd-1', 'fwd-2')), env as Env);
      expect(second).toEqual({ accepted: true, calendar: true, proposed: 0, duplicate: true });
      expect((await pending(headers)).length).toBe(2);
    } finally {
      restore();
    }
  });

  it('arrives at calendar@ on the workspace\'s own host, with INBOUND_EMAIL on or fixed (meet#1184)', async () => {
    const inbound = (env as MutableEnv).INBOUND_EMAIL;
    const restore = withExtractor([outbound, back]);
    try {
      await member();
      const to = 'calendar@meet-test.starlings.example';
      expect(await handleInboundEmail(envelope(rawMail(FORWARD, to), { to }), env as Env))
        .toEqual({ accepted: true, calendar: true, proposed: 2, duplicate: false });
      (env as MutableEnv).INBOUND_EMAIL = 'fixed';
      await env.USAGE.prepare('DELETE FROM pending_calendar_events').run();
      expect(await handleInboundEmail(envelope(rawMail(FORWARD, to).replace('fwd-1', 'fwd-3'), { to }), env as Env))
        .toEqual({ accepted: true, calendar: true, proposed: 2, duplicate: false });
    } finally {
      (env as MutableEnv).INBOUND_EMAIL = inbound;
      restore();
    }
  });

  it('discards a row, and knows a row that is gone', async () => {
    const restore = withExtractor([outbound]);
    try {
      const headers = await member();
      await handleInboundEmail(envelope(rawMail(FORWARD)), env as Env);
      const [row] = await pending(headers);
      const discard = await exports.default.fetch(new Request(`http://local/api/calendar/pending/${row!.id}/discard`, { method: 'POST', headers }));
      expect(discard.status).toBe(200);
      expect(await pending(headers)).toEqual([]);
      const again = await exports.default.fetch(new Request(`http://local/api/calendar/pending/${row!.id}/discard`, { method: 'POST', headers }));
      expect(again.status).toBe(404);
      const add = await exports.default.fetch(new Request(`http://local/api/calendar/pending/${row!.id}/add`, { method: 'POST', headers, body: '{}' }));
      expect(add.status).toBe(404);
    } finally {
      restore();
    }
  });

  it('is someone else’s business only to them', async () => {
    const restore = withExtractor([outbound]);
    try {
      const headers = await member();
      await handleInboundEmail(envelope(rawMail(FORWARD)), env as Env);
      const other = { sub: 'dev:cp-ana@example.com', email: 'cp-ana@example.com', name: 'Ana' };
      await recordOwnerSignIn(env as Env, other, 'mac');
      const session = await exports.default.fetch(new Request('http://local/api/dev/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: other.name, email: other.email }),
      }));
      const token = (await session.json<{ access_token: string }>()).access_token;
      expect(await pending({ authorization: `Bearer ${token}` })).toEqual([]);
    } finally {
      restore();
    }
  });

  it('proposes nothing for a non-member, a mail with no events, or no extractor', async () => {
    const restore = withExtractor([]);
    try {
      await member();
      expect(await handleInboundEmail(envelope(rawMail(FORWARD), { from: 'ana@acme.example' }), env as Env))
        .toEqual({ accepted: false, reason: 'not_member' });
      expect(await handleInboundEmail(envelope(rawMail('Newsletter, no dates.')), env as Env))
        .toEqual({ accepted: false, reason: 'no_events' });
      (env as MutableEnv).ANTHROPIC_API_KEY = '';
      expect(await handleInboundEmail(envelope(rawMail(FORWARD)), env as Env))
        .toEqual({ accepted: false, reason: 'no_extractor' });
    } finally {
      restore();
    }
  });

  it('sweeps rows past their week', async () => {
    const restore = withExtractor([outbound]);
    try {
      const headers = await member();
      await handleInboundEmail(envelope(rawMail(FORWARD)), env as Env);
      expect(await sweepPendingEvents(env as Env)).toBe(0);
      expect(await sweepPendingEvents(env as Env, Date.now() + 8 * 24 * 60 * 60 * 1_000)).toBe(1);
      expect(await pending(headers)).toEqual([]);
    } finally {
      restore();
    }
  });
});
