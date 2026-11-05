// Model calls and tokens per day (meet#321): every call site adds to D1
// `model_usage`, the daily check counts a `model_spend` failure over the
// figure, and only an org admin reads the table.
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { summarize, titleFromSummary } from '../src/artifacts';
import { extractCalendarEvents } from '../src/calendar-extract';
import { runJev } from '../src/granola-suggest';
import { checkModelSpend, isDailyTick, recordModelUsage } from '../src/model-usage';
import { claudeNotes } from '../src/notes';
import { proposeTaskCandidates } from '../src/task-candidates';
import type { ArtifactMaterial } from '../src/room-coordinator';

const today = () => new Date().toISOString().slice(0, 10);

async function usageRow(purpose: string, day = today()) {
  return env.USAGE.prepare(
    'SELECT provider, model, calls, input_tokens, output_tokens FROM model_usage WHERE day = ?1 AND purpose = ?2',
  ).bind(day, purpose).first<{ provider: string; model: string; calls: number; input_tokens: number; output_tokens: number }>();
}

function stubClaude(content: unknown[]) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname !== 'api.anthropic.com') return new Response('unexpected', { status: 500 });
    return Response.json({
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test-5', content,
      stop_reason: 'tool_use', stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 },
    });
  });
}

const smallModel = (response: string) => ({ run: async () => ({ response }) }) as unknown as Env['AI'];

const artifact: ArtifactMaterial = {
  meetingId: '0b7f7c2e-3333-4c8f-9a13-8a9d0e2f0001',
  roomSlug: 'rosa',
  title: null,
  startedAt: Date.parse('2026-09-16T09:00:00Z'),
  endedAt: Date.parse('2026-09-16T09:30:00Z'),
  summary: null,
  transcript: [{ speaker_name: 'Ana', text: 'We ship on Friday.', starts_at_ms: 0 }],
} as unknown as ArtifactMaterial;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('recordModelUsage', () => {
  it('adds calls and tokens up per day, provider, model and purpose', async () => {
    const now = Date.parse('2036-01-02T10:00:00Z');
    await recordModelUsage(env, { provider: 'anthropic', model: 'm', purpose: 'test.upsert', input: 10, output: 3 }, now);
    await recordModelUsage(env, { provider: 'anthropic', model: 'm', purpose: 'test.upsert', input: 5, output: 2 }, now + 1000);
    expect(await usageRow('test.upsert', '2036-01-02')).toEqual({ provider: 'anthropic', model: 'm', calls: 2, input_tokens: 15, output_tokens: 5 });
  });

  it('never throws, and does nothing without D1', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { USAGE: { prepare: () => { throw new Error('D1 down'); } } } as unknown as Env;
    await expect(recordModelUsage(broken, { provider: 'anthropic', model: 'm', purpose: 'x', input: 1, output: 1 })).resolves.toBeUndefined();
    await expect(recordModelUsage({}, { provider: 'anthropic', model: 'm', purpose: 'x', input: 1, output: 1 })).resolves.toBeUndefined();
  });
});

describe('every call site records its usage', () => {
  it('notes, with Anthropic token counts including the cache', async () => {
    stubClaude([{ type: 'tool_use', id: 't1', name: 'write_notes', input: { notes_markdown: '## Summary\nShip Friday.', action_items: [] } }]);
    await claudeNotes({ ...env, ANTHROPIC_API_KEY: 'sk-ant-test', NOTES_MODEL: 'claude-test-5' } as unknown as Env, {
      meetingId: artifact.meetingId, startedAt: artifact.startedAt, title: null, participants: ['Ana'], transcript: artifact.transcript,
    });
    expect(await usageRow('notes')).toMatchObject({ provider: 'anthropic', model: 'claude-test-5', calls: 1, input_tokens: 125, output_tokens: 40 });
  });

  it('calendar mail extraction', async () => {
    stubClaude([{ type: 'tool_use', id: 't1', name: 'propose_events', input: { events: [] } }]);
    await extractCalendarEvents({ ...env, ANTHROPIC_API_KEY: 'sk-ant-test' }, {
      from: null, subject: 'Lunch', date: null, body: 'Lunch on Friday at noon.', instructions: null, forwardedAt: null,
    });
    expect(await usageRow('calendar-extract')).toMatchObject({ provider: 'anthropic', calls: 1, input_tokens: 125, output_tokens: 40 });
  });

  it('the summary fallback on Workers AI, as an estimate', async () => {
    await summarize(artifact, { ...env, SUMMARY_MODE: 'ai', SUMMARY_MODEL: 'small-model', AI: smallModel('Title: Friday\n\n## Summary\nShip.'), ANTHROPIC_API_KEY: '' } as unknown as Env);
    const row = await usageRow('notes-fallback');
    expect(row).toMatchObject({ provider: 'workers-ai', model: 'small-model', calls: 1 });
    expect(row!.input_tokens).toBeGreaterThan(0);
    expect(row!.output_tokens).toBe(Math.ceil('Title: Friday\n\n## Summary\nShip.'.length / 4));
  });

  it('a title from the summary', async () => {
    await titleFromSummary({ ...artifact, summary: '## Summary\nShip.' }, { ...env, SUMMARY_MODE: 'ai', SUMMARY_MODEL: 'small-model', AI: smallModel('Friday ship') } as unknown as Env);
    expect(await usageRow('title')).toMatchObject({ provider: 'workers-ai', calls: 1 });
  });

  it('live transcript chunks', async () => {
    await proposeTaskCandidates(
      { ...env, TASK_SUGGEST_MODE: 'ai', TASK_SUGGEST_MODEL: 'chunk-model', AI: smallModel('[]') } as unknown as Env,
      { excerpt: 'Ana: we ship on Friday.' },
    );
    expect(await usageRow('task-candidates')).toMatchObject({ provider: 'workers-ai', model: 'chunk-model', calls: 1, output_tokens: 1 });
  });

  it('Granola suggestions, on Workers AI and on the gateway', async () => {
    const answer = { answers: { kind: { type: 'choice', choice: 'lead', probabilities: { lead: 0.9 } } } };
    await runJev({ ...env, GRANOLA_SUGGEST_MODEL: 'typesafe/jev', AI: { run: async () => answer } } as unknown as Env, { title: 'x' }, {});
    expect(await usageRow('granola-suggest')).toMatchObject({ provider: 'workers-ai', model: 'typesafe/jev', calls: 1 });

    vi.stubGlobal('fetch', async () => Response.json({ ...answer, usage: { inputTokens: 321 } }));
    await runJev({ ...env, GRANOLA_SUGGEST_MODEL: 'typesafe/jev', AI_GATEWAY_API_KEY: 'gw-test' } as unknown as Env, { title: 'x' }, {});
    const gateway = await env.USAGE.prepare(
      `SELECT calls, input_tokens FROM model_usage WHERE day = ?1 AND purpose = 'granola-suggest' AND provider = 'ai-gateway'`,
    ).bind(today()).first();
    expect(gateway).toEqual({ calls: 1, input_tokens: 321 });
  });
});

describe('the daily spend check', () => {
  async function failures(day: string) {
    return (await env.USAGE.prepare(`SELECT count FROM ops_failures WHERE kind = 'model_spend' AND day = ?1`).bind(day).first<{ count: number }>())?.count ?? 0;
  }

  it('counts model_spend above SPEND_ALERT_DAILY_TOKENS and not below', async () => {
    const yesterday = Date.parse('2037-03-03T12:00:00Z');
    const now = Date.parse('2037-03-04T00:01:00Z');
    await recordModelUsage(env, { provider: 'anthropic', model: 'm', purpose: 'notes', input: 600, output: 400 }, yesterday);

    expect(await checkModelSpend({ ...env, SPEND_ALERT_DAILY_TOKENS: '1000' } as Env, now)).toBe(1000);
    expect(await failures('2037-03-04')).toBe(0);

    expect(await checkModelSpend({ ...env, SPEND_ALERT_DAILY_TOKENS: '999' } as Env, now)).toBe(1000);
    expect(await failures('2037-03-04')).toBe(1);

    await checkModelSpend({ ...env, SPEND_ALERT_DAILY_TOKENS: '' } as Env, now);
    expect(await failures('2037-03-04')).toBe(1);
  });

  it('runs on one tick a day', () => {
    expect(isDailyTick(Date.parse('2037-03-04T00:00:00Z'))).toBe(true);
    expect(isDailyTick(Date.parse('2037-03-04T00:05:00Z'))).toBe(false);
    expect(isDailyTick(Date.parse('2037-03-04T12:00:00Z'))).toBe(false);
  });
});

describe('GET /api/admin/model-usage', () => {
  async function session(email: string) {
    const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ada', email }),
    }));
    return { authorization: `Bearer ${(await response.json<{ access_token: string }>()).access_token}` };
  }

  it('answers an org admin and refuses a member', async () => {
    await recordModelUsage(env, { provider: 'workers-ai', model: 'm', purpose: 'test.route', input: 4, output: 2 });
    const admin = await exports.default.fetch(new Request('http://local/api/admin/model-usage?days=7', { headers: await session('rosa@example.com') }));
    expect(admin.status).toBe(200);
    const body = await admin.json<{ rows: Array<{ purpose: string; calls: number }> }>();
    expect(body.rows.find((row) => row.purpose === 'test.route')).toMatchObject({ calls: 1 });

    const member = await exports.default.fetch(new Request('http://local/api/admin/model-usage', { headers: await session('usage-member@example.com') }));
    expect(member.status).toBe(403);
  });
});
