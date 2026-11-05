/**
 * Open decisions (migration 0063, docs/help/howto/answer-a-decision.md):
 * an agent asks through MCP `ask_decision`, the member answers from INBOX,
 * the agent reads it back. The answer is stored before Core is written, a
 * Core failure keeps it, and the same answer again retries the write.
 */
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDecisionAskPastDefault, sortDecisionAsks, type DecisionAsk, type DecisionAskResponse, type DecisionAsksResponse } from '@starlings/contracts/decision-asks';
import type { InboxResponse } from '@starlings/contracts/inbox';
import worker from '../src/index';
import { attentionRequestID } from '@starlings/contracts/attention';
import { readAttentionRequest, resolveAttentionRequest } from '../src/attention-requests';
import { signingKey } from '../src/crypto';
import { resetRoleCache } from '../src/capabilities';
import { resetPeerRosterCache } from '../src/peers';

const projectID = 'c0ffee00-0000-4000-8000-0000000000d1';
const coreDecisionID = 'c0ffee00-0000-4000-8000-0000000000d2';
const ROSA = 'rosa@example.com';

/** Core configured, so an answer on a subject writes a Core decision. */
const withCore = {
  ...env,
  CRM_SYNC_MODE: 'on',
  CORE_API_BASE_URL: 'https://core.test',
  INTERNAL_REQUEST_SECRET: 'a-shared-test-secret-with-at-least-32-characters',
  SESSION_SIGNING_SECRET: 'decision-asks-signing-secret-32-chars!!',
} as Env;
/** No Core at all: the queue is Meet's own and works without it. */
const withoutCore = { ...withCore, INTERNAL_REQUEST_SECRET: '' } as Env;

const DAY = 86_400_000;
const day = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

afterEach(async () => {
  vi.restoreAllMocks();
  await env.USAGE.prepare("DELETE FROM attention_requests WHERE json_extract(snapshot, '$.asked_by_email') IN (?1, 'decision-ada@example.com') OR recipient_email IN (?1, 'decision-ada@example.com')").bind(ROSA).run();
  await env.USAGE.prepare("DELETE FROM decision_asks WHERE asked_by_email IN (?1, 'decision-ada@example.com') OR waits_on_email IN (?1, 'decision-ada@example.com')").bind(ROSA).run();
  await env.USAGE.prepare("DELETE FROM mcp_idempotency WHERE principal_email = ?1").bind(ROSA).run();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'decision-%'").run();
  resetRoleCache();
  resetPeerRosterCache();
});

async function fetchAs(config: Env, request: Request): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, config, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A member session, the way every client holds one. */
async function session(config: Env, email: string): Promise<Record<string, string>> {
  const response = await fetchAs(config, new Request('http://local/api/dev/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: email.split('@')[0], email }),
  }));
  const body = await response.json<{ access_token: string }>();
  const headers = { authorization: `Bearer ${body.access_token}` };
  await fetchAs(config, new Request('http://local/api/peers', { headers }));
  return headers;
}

async function hit(config: Env, method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return fetchAs(config, new Request(`http://local${path}`, {
    method, headers: { ...headers, 'content-type': 'application/json' }, body: body === undefined ? null : JSON.stringify(body),
  }));
}

async function bearer(config: Env, scope = 'read write'): Promise<string> {
  const now = Date.now();
  await config.USAGE.prepare(
    `INSERT OR REPLACE INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at) VALUES ('client-decisions', 'claude.ai', NULL, '["https://claude.ai/api/mcp/auth_callback"]', ?1)`,
  ).bind(now).run();
  await config.USAGE.prepare(
    `INSERT OR REPLACE INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at)
     VALUES ('grant-decisions', 'client-decisions', ?1, ?2, ?3, 'jti', NULL, ?4, ?4, NULL, NULL)`,
  ).bind(`dev:${ROSA}`, ROSA, scope, now).run();
  return new SignJWT({ email: ROSA, name: 'Rosa', scope, grant: 'grant-decisions', client: 'client-decisions' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('starlings.example')
    .setAudience('meet-mcp')
    .setSubject(`dev:${ROSA}`)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey(config.SESSION_SIGNING_SECRET));
}

type ToolAnswer = { result?: { isError?: boolean; replayed?: boolean; structuredContent?: unknown; content?: Array<{ text?: string }> }; error?: { message: string } };

async function tool(config: Env, token: string, name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const response = await fetchAs(config, new Request('http://local/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  return response.json<ToolAnswer>();
}

const askArgs = (extra: Record<string, unknown> = {}) => ({
  question: 'Ship the queue behind a flag?',
  context: 'The web row is done; the Mac row needs a build.',
  options: [{ key: 'flag', label: 'Behind a flag' }, { key: 'ship', label: 'Ship to everyone' }],
  recommendation: 'flag',
  default_by: day(3),
  links: [{ url: 'https://github.com/envisioning/starlings-source/issues/1', title: 'meet#1' }],
  ...extra,
});

/** Core as the queue reaches it: open projects, and decision writes, failing on demand. */
function mockCore(state: { fail: boolean; writes: Array<Record<string, unknown>> }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith('meet-crm-subjects')) {
      const kind = url.searchParams.get('kind');
      const rows = kind === 'project'
        ? [{ id: projectID, kind: 'project', title: 'Acme rollout', subtitle: 'Acme', has_repo: false, open_tasks: 0, internal: false, organization_id: 'org-a', organization_name: 'Acme' }]
        : [];
      return Response.json({ ok: true, subjects: rows, has_more: false });
    }
    if (url.pathname === '/api/public/meet-crm-decisions' && request.method === 'POST') {
      const body = await request.json<Record<string, unknown>>();
      state.writes.push(body);
      if (state.fail) return Response.json({ ok: false, error: 'down' }, { status: 503 });
      return Response.json({
        ok: true,
        decision: {
          id: coreDecisionID, subject_kind: body.subject_kind, subject_id: body.subject_id, body: body.body, source: body.source,
          source_ref: body.source_ref, goal_id: null, decided_by: null, decided_by_name: 'Rosa', decided_by_email: ROSA,
          decided_at: new Date().toISOString(),
        },
      }, { status: 201 });
    }
    return Response.json({ ok: true }, { status: 200 });
  });
}

describe('decision queue rules', () => {
  it('is overdue once the default-by day has passed, in UTC', () => {
    const noon = Date.parse('2026-10-03T12:00:00Z');
    expect(isDecisionAskPastDefault('2026-10-03', noon)).toBe(false);
    expect(isDecisionAskPastDefault('2026-10-02', noon)).toBe(true);
    expect(isDecisionAskPastDefault('not a day', noon)).toBe(false);
  });

  it('orders overdue first, then the soonest default-by', () => {
    const ask = (id: string, overdue: boolean, default_by: string) => ({ id, overdue, default_by, created_at: '2026-09-28T00:00:00Z' });
    const order = sortDecisionAsks([ask('later', false, '2026-10-09'), ask('late', true, '2026-09-20'), ask('sooner', false, '2026-10-01')]);
    expect(order.map((row) => row.id)).toEqual(['late', 'sooner', 'later']);
  });
});

describe('/api/decision-asks', () => {
  it('shares the public attention answer and dismissal with the compatibility routes and Inbox', async () => {
    const headers = await session(withoutCore, ROSA);
    const create = async () => (await (await hit(withoutCore, 'POST', '/api/decision-asks', headers, askArgs())).json<DecisionAskResponse>()).ask;
    const ask = await create();
    const id = attentionRequestID({ type: 'decision', decision_id: ask.id });
    const path = `/api/attention/${encodeURIComponent(id)}/resolve`;
    const first = await hit(withoutCore, 'POST', path, headers, { action: 'answer', option_ids: ['ship'], note: 'The same winner' });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ accepted: true, request: { id, state: 'answered', answer: { note: 'The same winner' } } });
    const loser = await hit(withoutCore, 'POST', path, headers, { action: 'answer', option_ids: ['flag'] });
    expect(await loser.json()).toMatchObject({ accepted: false, request: { state: 'answered', answer: { option_ids: ['ship'] } } });
    expect((await (await hit(withoutCore, 'GET', '/api/decision-asks?status=answered', headers)).json<DecisionAsksResponse>()).asks)
      .toMatchObject([{ id: ask.id, answer: 'ship', answer_note: 'The same winner' }]);
    const next = await create();
    const dismissed = await hit(withoutCore, 'POST', `/api/attention/${encodeURIComponent(attentionRequestID({ type: 'decision', decision_id: next.id }))}/resolve`, headers, { action: 'dismiss' });
    expect(await dismissed.json()).toMatchObject({ accepted: true, request: { state: 'dismissed' } });
    expect(await env.USAGE.prepare('SELECT status FROM decision_asks WHERE id = ?1').bind(next.id).first())
      .toEqual({ status: 'withdrawn' });
    const inbox = await (await hit(withoutCore, 'GET', '/api/crm/inbox', headers)).json<InboxResponse>();
    expect(inbox.items.some((item) => item.source === 'decision')).toBe(false);
  });
  it('needs a member', async () => {
    expect((await fetchAs(withoutCore, new Request('http://local/api/decision-asks'))).status).toBe(401);
  });

  it('asks, lists first in INBOX, answers once, and only the member it waits on answers', async () => {
    const rosa = await session(withoutCore, ROSA);
    const ada = await session(withoutCore, 'decision-ada@example.com');
    await hit(withoutCore, 'POST', '/api/quick-notes', rosa, { body: 'A note, newer than the ask', source: 'work' });

    const refused = await hit(withoutCore, 'POST', '/api/decision-asks', rosa, askArgs({ recommendation: 'nope' }));
    expect(refused.status).toBe(400);

    const created = await hit(withoutCore, 'POST', '/api/decision-asks', rosa, askArgs());
    expect(created.status).toBe(201);
    const { ask } = await created.json<DecisionAskResponse>();
    expect(ask).toMatchObject({ status: 'open', waits_on_email: ROSA, recommendation: 'flag', overdue: false, subject: null });
    expect(ask.links).toEqual([{ url: 'https://github.com/envisioning/starlings-source/issues/1', title: 'meet#1' }]);

    const inbox = await (await hit(withoutCore, 'GET', '/api/crm/inbox', rosa)).json<InboxResponse>();
    expect(inbox.items[0]).toMatchObject({ source: 'decision', key: `decision:${ask.id}` });
    expect(inbox.items.map((item) => item.source)).toContain('note');

    // Somebody else cannot answer rosa's decision.
    expect((await hit(withoutCore, 'POST', `/api/decision-asks/${ask.id}/answer`, ada, { answer: 'ship' })).status).toBe(403);

    const answered = await hit(withoutCore, 'POST', `/api/decision-asks/${ask.id}/answer`, rosa, { answer: 'SHIP', note: 'Everyone is ready.' });
    expect(answered.status).toBe(200);
    const after = (await answered.json<DecisionAskResponse>()).ask;
    expect(after).toMatchObject({ status: 'answered', answer: 'ship', answer_label: 'Ship to everyone', answer_note: 'Everyone is ready.', answered_by_email: ROSA });

    // A different answer later is refused; the same one is a harmless retry.
    expect((await hit(withoutCore, 'POST', `/api/decision-asks/${ask.id}/answer`, rosa, { answer: 'flag' })).status).toBe(409);
    expect((await hit(withoutCore, 'POST', `/api/decision-asks/${ask.id}/answer`, rosa, { answer: 'ship' })).status).toBe(200);

    const again = await (await hit(withoutCore, 'GET', '/api/crm/inbox', rosa)).json<InboxResponse>();
    expect(again.items.some((item) => item.source === 'decision')).toBe(false);

    const resolved = await (await hit(withoutCore, 'GET', '/api/decision-asks?status=resolved', rosa)).json<DecisionAsksResponse>();
    expect(resolved.asks.map((row) => row.id)).toEqual([ask.id]);
  });

  it('waits on another member when asked to, and a person can turn the source off', async () => {
    const rosa = await session(withoutCore, ROSA);
    const ada = await session(withoutCore, 'decision-ada@example.com');
    expect((await hit(withoutCore, 'POST', '/api/decision-asks', rosa, askArgs({ waits_on: 'nobody@example.com' }))).status).toBe(404);
    const { ask } = await (await hit(withoutCore, 'POST', '/api/decision-asks', rosa, askArgs({ waits_on: 'decision-ada@example.com' }))).json<DecisionAskResponse>();
    expect(ask.waits_on_email).toBe('decision-ada@example.com');

    const mine = await (await hit(withoutCore, 'GET', '/api/crm/inbox', rosa)).json<InboxResponse>();
    expect(mine.items.some((item) => item.source === 'decision')).toBe(false);
    const hers = await (await hit(withoutCore, 'GET', '/api/crm/inbox', ada)).json<InboxResponse>();
    expect(hers.items.map((item) => item.key)).toContain(`decision:${ask.id}`);

    await hit(withoutCore, 'PATCH', '/api/crm/subject-state', ada, { inbox_sources: { decision: false } });
    const off = await (await hit(withoutCore, 'GET', '/api/crm/inbox', ada)).json<InboxResponse>();
    expect(off.items.some((item) => item.source === 'decision')).toBe(false);
    await env.USAGE.prepare("DELETE FROM work_preferences WHERE sub IN (SELECT sub FROM people WHERE email LIKE 'decision-%')").run();
  });

  it('withdraws, and applies the default only once the day has passed', async () => {
    const rosa = await session(withoutCore, ROSA);
    const soon = (await (await hit(withoutCore, 'POST', '/api/decision-asks', rosa, askArgs())).json<DecisionAskResponse>()).ask;
    const early = await hit(withoutCore, 'POST', `/api/decision-asks/${soon.id}/apply-default`, rosa, {});
    expect(early.status).toBe(400);

    const withdrawn = await (await hit(withoutCore, 'POST', `/api/decision-asks/${soon.id}/withdraw`, rosa, { reason: 'Settled in the call.' })).json<DecisionAskResponse>();
    expect(withdrawn.ask).toMatchObject({ status: 'withdrawn', answer: null, answer_note: 'Settled in the call.' });
    expect((await hit(withoutCore, 'POST', `/api/decision-asks/${soon.id}/answer`, rosa, { answer: 'flag' })).status).toBe(409);

    const late = (await (await hit(withoutCore, 'POST', '/api/decision-asks', rosa, askArgs({ default_by: day(-2) }))).json<DecisionAskResponse>()).ask;
    expect(late.overdue).toBe(true);
    const defaulted = await (await hit(withoutCore, 'POST', `/api/decision-asks/${late.id}/apply-default`, rosa, {})).json<DecisionAskResponse>();
    expect(defaulted.ask).toMatchObject({ status: 'defaulted', answer: 'flag', answer_label: 'Behind a flag', overdue: false });
  });
});

describe('the Core record on answer', () => {
  it('stores the answer first, keeps it when Core fails, and writes the decision on retry', async () => {
    const core = { fail: true, writes: [] as Array<Record<string, unknown>> };
    mockCore(core);
    const rosa = await session(withCore, ROSA);
    const { ask } = await (await hit(withCore, 'POST', '/api/decision-asks', rosa, askArgs({ subject: { kind: 'project', id: projectID, title: 'Acme rollout' } }))).json<DecisionAskResponse>();

    const failed = await hit(withCore, 'POST', `/api/decision-asks/${ask.id}/answer`, rosa, { answer: 'flag', note: 'Staged.' });
    expect(failed.status).toBe(200);
    expect((await failed.json<DecisionAskResponse>()).ask).toMatchObject({ status: 'answered', answer: 'flag', core_decision_id: null });
    const row = await env.USAGE.prepare('SELECT status, core_error FROM decision_asks WHERE id = ?1').bind(ask.id).first<{ status: string; core_error: string | null }>();
    expect(row?.status).toBe('answered');
    expect(row?.core_error).toBeTruthy();

    core.fail = false;
    const retried = await (await hit(withCore, 'POST', `/api/decision-asks/${ask.id}/answer`, rosa, { answer: 'flag' })).json<DecisionAskResponse>();
    expect(retried.ask.core_decision_id).toBe(coreDecisionID);
    expect(core.writes).toHaveLength(2);
    expect(core.writes[1]).toMatchObject({
      subject_kind: 'project',
      subject_id: projectID,
      source: 'manual',
      source_ref: ask.id,
      actor_email: ROSA,
    });
    expect(String(core.writes[1]!.body)).toBe('Ship the queue behind a flag? → Behind a flag\n\nStaged.');

    // Written once: a third send owes nothing.
    await hit(withCore, 'POST', `/api/decision-asks/${ask.id}/answer`, rosa, { answer: 'flag' });
    expect(core.writes).toHaveLength(2);
  });
});

describe('MCP ask_decision', () => {
  it('asks on a subject, reads it back through list, now and open, and replays a retried ask', async () => {
    const core = { fail: false, writes: [] as Array<Record<string, unknown>> };
    mockCore(core);
    const token = await bearer(withCore);
    const args = askArgs({ subject: `subject:project:${projectID}`, idempotency_key: 'queue-flag-1' });

    const first = await tool(withCore, token, 'ask_decision', args);
    expect(first.result?.isError).toBe(false);
    const ask = (first.result?.structuredContent as DecisionAskResponse).ask;
    expect(ask).toMatchObject({ status: 'open', subject: { kind: 'project', id: projectID, title: 'Acme rollout' } });
    expect(ask.asked_by).toBe('Rosa via claude.ai');

    const retry = await tool(withCore, token, 'ask_decision', args);
    expect(retry.result?.replayed).toBe(true);
    const count = await env.USAGE.prepare('SELECT COUNT(*) AS n FROM decision_asks WHERE asked_by_email = ?1').bind(ROSA).first<{ n: number }>();
    expect(count?.n).toBe(1);

    const listed = await tool(withCore, token, 'ask_decision', { action: 'list' });
    expect((listed.result?.structuredContent as DecisionAsksResponse).asks.map((row) => row.id)).toEqual([ask.id]);

    const now = await tool(withCore, token, 'now', {});
    const nowBody = now.result?.structuredContent as { decisions_waiting: DecisionAsk[]; decisions_answered: DecisionAsk[] };
    expect(nowBody.decisions_waiting.map((row) => row.id)).toEqual([ask.id]);
    expect(nowBody.decisions_answered).toEqual([]);

    // The member answers in the app; the agent reads it back.
    const rosa = await session(withCore, ROSA);
    await hit(withCore, 'POST', `/api/decision-asks/${ask.id}/answer`, rosa, { answer: 'ship' });
    const listedAgain = await tool(withCore, token, 'ask_decision', { action: 'list', status: 'resolved' });
    expect((listedAgain.result?.structuredContent as DecisionAsksResponse).asks[0]).toMatchObject({ id: ask.id, answer: 'ship', core_decision_id: coreDecisionID });
    const nowAgain = (await tool(withCore, token, 'now', {})).result?.structuredContent as { decisions_answered: DecisionAsk[] };
    expect(nowAgain.decisions_answered.map((row) => row.id)).toEqual([ask.id]);

    const opened = (await tool(withCore, token, 'open', { door: `subject:project:${projectID}` })).result?.structuredContent as { decision_asks: DecisionAsk[] };
    expect(opened.decision_asks.map((row) => row.id)).toEqual([ask.id]);
  });

  it('refuses an ask without a recommendation among the options, and apply_default before the day', async () => {
    const token = await bearer(withoutCore);
    const bad = await tool(withoutCore, token, 'ask_decision', askArgs({ recommendation: 'maybe' }));
    expect(bad.result?.isError).toBe(true);
    const good = await tool(withoutCore, token, 'ask_decision', askArgs());
    const ask = (good.result?.structuredContent as DecisionAskResponse).ask;
    const early = await tool(withoutCore, token, 'ask_decision', { action: 'apply_default', ask: ask.id });
    expect(early.result?.isError).toBe(true);
    expect(early.result?.content?.[0]?.text).toContain('invalid_request');
    const withdrawn = await tool(withoutCore, token, 'ask_decision', { action: 'withdraw', ask: ask.id, reason: 'Moot.' });
    expect((withdrawn.result?.structuredContent as DecisionAskResponse).ask.status).toBe('withdrawn');
  });

  it('lets a read-only connector list but not ask', async () => {
    const token = await bearer(withoutCore, 'read');
    const listed = await tool(withoutCore, token, 'ask_decision', { action: 'list' });
    expect(listed.result?.isError).toBe(false);
    const asked = await tool(withoutCore, token, 'ask_decision', askArgs());
    expect(asked.result?.isError).toBe(true);
    expect(asked.result?.content?.[0]?.text).toContain('read-only');
  });
});


describe('decision attention compatibility', () => {
  const attentionId = (id: string) => attentionRequestID({ type: 'decision', decision_id: id });
  async function create() {
    const rosa = await session(withoutCore, ROSA);
    const { ask } = await (await hit(withoutCore, 'POST', '/api/decision-asks', rosa, askArgs())).json<DecisionAskResponse>();
    return { rosa, ask };
  }

  it('registers one canonical request and routes an old-client answer through it', async () => {
    const { rosa, ask } = await create();
    expect(await readAttentionRequest(env.USAGE, attentionId(ask.id)))
      .toMatchObject({ kind: 'decision', state: 'open', revision: 0, recipient_email: ROSA });
    const response = await hit(withoutCore, 'POST', `/api/decision-asks/${ask.id}/answer`, rosa, { answer: 'ship', note: 'Ready' });
    expect(response.status).toBe(200);
    const canonical = await readAttentionRequest(env.USAGE, attentionId(ask.id));
    expect(canonical).toMatchObject({ state: 'answered', revision: 1,
      answer: { option_ids: ['ship'], option_labels: ['Ship to everyone'], note: 'Ready' } });
    await hit(withoutCore, 'POST', `/api/decision-asks/${ask.id}/answer`, rosa, { answer: 'ship', note: 'Changed' });
    expect(await readAttentionRequest(env.USAGE, attentionId(ask.id))).toEqual(canonical);
  });

  it('reflects a canonical answer in Inbox, resolved lists and retries while the legacy row remains open', async () => {
    const { rosa, ask } = await create();
    await resolveAttentionRequest(env.USAGE, attentionId(ask.id), ROSA, { action: 'answer', option_ids: ['flag'], note: 'Canonical note' });
    const raw = await env.USAGE.prepare('SELECT status FROM decision_asks WHERE id = ?1').bind(ask.id).first<{ status: string }>();
    expect(raw?.status).toBe('open');
    const inbox = await (await hit(withoutCore, 'GET', '/api/crm/inbox', rosa)).json<InboxResponse>();
    expect(inbox.items.some((item) => item.key === attentionId(ask.id))).toBe(false);
    const resolved = await (await hit(withoutCore, 'GET', '/api/decision-asks?status=resolved', rosa)).json<DecisionAsksResponse>();
    expect(resolved.asks).toHaveLength(1);
    expect(resolved.asks[0]).toMatchObject({ id: ask.id, status: 'answered', answer: 'flag', answer_note: 'Canonical note' });
    expect((await hit(withoutCore, 'POST', `/api/decision-asks/${ask.id}/answer`, rosa, { answer: 'ship' })).status).toBe(409);
    expect((await hit(withoutCore, 'POST', `/api/decision-asks/${ask.id}/answer`, rosa, { answer: 'flag' })).status).toBe(200);
    expect(await env.USAGE.prepare('SELECT status, answer_note FROM decision_asks WHERE id = ?1').bind(ask.id).first())
      .toMatchObject({ status: 'answered', answer_note: 'Canonical note' });
  });

  it('imports a resolved legacy record without reopening it', async () => {
    const { rosa, ask } = await create();
    await env.USAGE.prepare('DELETE FROM attention_requests WHERE id = ?1').bind(attentionId(ask.id)).run();
    await env.USAGE.prepare(`UPDATE decision_asks SET status = 'answered', answer = 'ship', answer_note = 'Legacy note',
      answered_at = ?2, answered_by_email = ?3 WHERE id = ?1`).bind(ask.id, Date.now(), ROSA).run();
    const resolved = await (await hit(withoutCore, 'GET', '/api/decision-asks?status=resolved', rosa)).json<DecisionAsksResponse>();
    expect(resolved.asks[0]).toMatchObject({ id: ask.id, status: 'answered', answer_note: 'Legacy note' });
    expect(await readAttentionRequest(env.USAGE, attentionId(ask.id))).toMatchObject({ state: 'answered', revision: 0 });
    expect((await hit(withoutCore, 'POST', `/api/decision-asks/${ask.id}/answer`, rosa, { answer: 'flag' })).status).toBe(409);
  });

  it('adopts an old worker resolution over an imported open source during rollout', async () => {
    const { rosa, ask } = await create();
    await env.USAGE.prepare(`UPDATE decision_asks SET status = 'answered', answer = 'ship', answer_note = 'Old worker',
      answered_at = ?2, answered_by_email = ?3 WHERE id = ?1`).bind(ask.id, Date.now(), ROSA).run();
    const listed = await (await hit(withoutCore, 'GET', '/api/decision-asks?status=all', rosa)).json<DecisionAsksResponse>();
    expect(listed.asks[0]).toMatchObject({ status: 'answered', answer_note: 'Old worker' });
    expect(await readAttentionRequest(env.USAGE, attentionId(ask.id))).toMatchObject({ state: 'answered', revision: 1 });
    expect((await hit(withoutCore, 'POST', `/api/decision-asks/${ask.id}/answer`, rosa, { answer: 'flag' })).status).toBe(409);
  });

  it('projects dismissal for old clients and removes the pending row without inventing an answer', async () => {
    const { rosa, ask } = await create();
    await resolveAttentionRequest(env.USAGE, attentionId(ask.id), ROSA, { action: 'dismiss' });
    const withdrawn = await (await hit(withoutCore, 'GET', '/api/decision-asks?status=withdrawn', rosa)).json<DecisionAsksResponse>();
    expect(withdrawn.asks[0]).toMatchObject({ id: ask.id, status: 'withdrawn', answer: null });
    const inbox = await (await hit(withoutCore, 'GET', '/api/crm/inbox', rosa)).json<InboxResponse>();
    expect(inbox.items.some((item) => item.key === attentionId(ask.id))).toBe(false);
    expect((await readAttentionRequest(env.USAGE, attentionId(ask.id))).state).toBe('dismissed');
  });

  it('accepts only one competing old-client answer and keeps its note in both stores', async () => {
    const { rosa, ask } = await create();
    const responses = await Promise.all([
      hit(withoutCore, 'POST', `/api/decision-asks/${ask.id}/answer`, rosa, { answer: 'flag', note: 'First path' }),
      hit(withoutCore, 'POST', `/api/decision-asks/${ask.id}/answer`, rosa, { answer: 'ship', note: 'Second path' }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = await readAttentionRequest(env.USAGE, attentionId(ask.id));
    expect(winner.revision).toBe(1);
    const legacy = await env.USAGE.prepare('SELECT answer, answer_note FROM decision_asks WHERE id = ?1').bind(ask.id).first();
    expect(legacy).toMatchObject({ answer: winner.answer!.option_ids[0], answer_note: winner.answer!.note });
  });
});
