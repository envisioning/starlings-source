// One sentence, one draft (meet#235): the TypeScript parser against the
// fixture the Swift parser also answers to.
import { describe, expect, it } from 'vitest';
import fixture from '../../../fixtures/quick-add.json';
import { parseQuickAdd, type QuickAddDraft } from '@starlings/contracts/quick-add';

interface Case { name: string; input: string; expect: QuickAddDraft }

describe('quick-add fixture', () => {
  const context = { now: fixture.now, defaultDurationMinutes: fixture.defaultDurationMinutes };
  for (const entry of fixture.cases as Case[]) {
    it(entry.name, () => {
      expect(parseQuickAdd(entry.input, context)).toEqual(entry.expect);
    });
  }
});

// The Worker route: the grammar answers on its own; only what it cannot read
// goes to the notes engine, and the answer says which.
import { env, exports } from 'cloudflare:workers';
import { afterEach, vi } from 'vitest';
import type { CalendarQuickAddResponse } from '@starlings/contracts';

type MutableEnv = Omit<Env, 'ANTHROPIC_API_KEY'> & { ANTHROPIC_API_KEY: string };

async function owner() {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
  }));
  const session = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json', origin: (env as Env).WEB_ORIGIN };
}

async function quickAdd(headers: Record<string, string>, sentence: string, allowModel = true) {
  const response = await exports.default.fetch(new Request('http://local/api/calendar/quick-add', {
    method: 'POST', headers,
    body: JSON.stringify({ sentence, now: '2026-09-19T10:00', time_zone: 'Europe/Lisbon', default_duration_minutes: 60, allow_model: allowModel }),
  }));
  expect(response.status).toBe(200);
  return response.json<CalendarQuickAddResponse>();
}

afterEach(() => {
  vi.unstubAllGlobals();
  (env as MutableEnv).ANTHROPIC_API_KEY = '';
});

describe('POST /api/calendar/quick-add', () => {
  it('answers from the grammar without a model call', async () => {
    const headers = await owner();
    let called = false;
    vi.stubGlobal('fetch', async () => { called = true; return new Response('no', { status: 500 }); });
    const body = await quickAdd(headers, 'Lunch with Ana tomorrow 12:30');
    expect(body.source).toBe('grammar');
    expect(body.draft).toMatchObject({ title: 'Lunch with Ana', start: '2026-09-20T12:30', end: '2026-09-20T13:30', all_day: false, invitees: ['Ana'] });
    expect(called).toBe(false);
  });

  it('sends only what it could not read to the notes engine, and says so', async () => {
    const headers = await owner();
    (env as MutableEnv).ANTHROPIC_API_KEY = 'sk-ant-test';
    let sent = '';
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.includes('/v1/messages')) throw new Error(`unexpected fetch ${url}`);
      sent = String(init?.body ?? '');
      return new Response(JSON.stringify({
        id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-5', stop_reason: 'tool_use', stop_sequence: null,
        content: [{ type: 'tool_use', id: 't', name: 'propose_events', input: { events: [{
          title: 'Dentist', all_day: false, start: '2026-10-02T09:00:00+01:00', end: '2026-10-02T09:30:00+01:00',
          time_zone: 'Europe/Lisbon', location: 'Clínica Luz', notes: null, attendees: [], confidence: 0.8,
        }] } }],
        usage: { input_tokens: 50, output_tokens: 40 },
      }), { headers: { 'content-type': 'application/json' } });
    });
    const body = await quickAdd(headers, 'Dentist right after the holidays, morning');
    expect(body.source).toBe('model');
    expect(body.draft).toMatchObject({ title: 'Dentist', start: '2026-10-02T09:00', end: '2026-10-02T09:30', location: 'Clínica Luz', confidence: 0.8 });
    expect(sent).toContain('Dentist right after the holidays');
    expect(sent).not.toContain('rosa@example.com');
  });

  it('keeps the model out when told to, and when there is no key', async () => {
    const headers = await owner();
    vi.stubGlobal('fetch', async () => { throw new Error('no network'); });
    expect((await quickAdd(headers, 'Dentist', false)).source).toBe('grammar');
    expect((await quickAdd(headers, 'Dentist')).source).toBe('grammar');
  });
});
