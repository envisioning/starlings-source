import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { hmacSHA256Hex } from '../src/crypto';
import { recordOwnerSignIn } from '../src/usage';
import { removeAgent } from '../src/agent-roster';
import { readManagedAgentReadiness } from '../src/managed-agent-provisioning';
import { managedAgentBootstrapResponseSchema, managedAgentDescription } from '@starlings/contracts/managed-agent';
import { meetingAgentContextSchema, type MeetingAgentResult } from '@starlings/contracts/meeting-agent';
const key = 'managed-bootstrap-fixture-key-32-characters';
const runtimeId = 'wrun_' + 'a'.repeat(26);
const scoped = { ...env, MANAGED_AGENT_PROVISIONING_KEY: key, ROOT_ADMIN_EMAILS: 'rosa@example.com' } as unknown as Env;
beforeEach(async () => {
  await env.USAGE.batch([
    env.USAGE.prepare('DELETE FROM managed_agent_provisioning'),
    env.USAGE.prepare('DELETE FROM built_in_agent_installations'),
    env.USAGE.prepare("DELETE FROM agent_freezes WHERE agent_sub LIKE 'agent:steward%'"),
    env.USAGE.prepare("DELETE FROM agents WHERE email LIKE 'steward%'"),
    env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'steward%' OR email = 'rosa@example.com'"),
    env.USAGE.prepare("DELETE FROM workspace_settings WHERE key = 'meeting_agent_workspace_id'"),
  ]);
});
afterEach(() => vi.unstubAllGlobals());
async function call(action: string, body: Record<string, unknown> = {}, options: { secret?: string; bearer?: boolean; configured?: boolean; purpose?: string } = {}) {
  const path = '/api/internal/managed-agent/provision', raw = JSON.stringify({ action, ...body }), stamp = String(Date.now());
  const signature = await hmacSHA256Hex(options.secret ?? key, `${stamp}.${options.purpose ?? 'managed-agent'}.POST.${path}.${raw}`);
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('https://meet.test' + path, { method: 'POST', body: raw, headers: {
    'x-internal-timestamp': stamp, 'x-internal-signature': signature,
    ...(options.bearer ? { authorization: 'Bearer fixture' } : {}),
  } }), options.configured === false ? env : scoped, ctx);
  await waitOnExecutionContext(ctx); return response;
}
async function begin() {
  const res = await call('begin', { accountable_email: 'rosa@example.com' });
  expect(res.status).toBe(200); return managedAgentBootstrapResponseSchema.parse(await res.json());
}
async function bind() {
  const reserved = await begin(), id = reserved.readiness.installation.id;
  const response = await call('bind', { installation_id: id, project_id: 'prj_fixture', runtime_version: '123abcd',
    runtime_origin: `https://starlings-meeting-${id.replaceAll('-', '')}.vercel.app` });
  expect(response.status).toBe(200); return reserved;
}
async function human() {
  await recordOwnerSignIn(scoped, { sub: 'actual-admin', email: 'rosa@example.com', name: 'Admin' }, 'web');
}

function runtime(proof = true) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.redirect).toBe('manual');
    const url = String(input);
    if (url.endsWith('/manifest')) return Response.json({ description: 'Synthetic fixture runtime', version: '123abcd', skills: [{ name: 'meeting-follow-through', description: 'Fixture' }], tools: [{ name: 'meeting-process', description: 'Fixture' }] });
    if (url.endsWith('/handoff')) {
      const row = await env.USAGE.prepare('SELECT probe_run_id FROM managed_agent_provisioning').first<{ probe_run_id: string }>();
      return Response.json({ accepted: true, run_id: row!.probe_run_id, runtime_run_id: runtimeId });
    }
    return proof ? Response.json({ erased: true, runtime_run_id: runtimeId, expired_at: Date.now() }) : Response.json({ erased: false }, { status: 503 });
  }));
}
async function probe(reserved: Awaited<ReturnType<typeof begin>>) {
  const row = await env.USAGE.prepare('SELECT probe_run_id FROM managed_agent_provisioning').first<{ probe_run_id: string }>();
  const install = reserved.readiness.installation;
  const request = { workspace_id: install.workspace_id, room_slug: 'installation-check', meeting_id: row!.probe_run_id, run_id: row!.probe_run_id };
  async function tool(door: string, body: unknown) {
    const path = `/api/internal/meeting-agent/${door}`, raw = JSON.stringify(body), stamp = String(Date.now()), ctx = createExecutionContext();
    const response = await worker.fetch(new Request('https://meet.test' + path, { method: 'POST', body: raw, headers: {
      'x-internal-key-id': install.agent_email, 'x-internal-timestamp': stamp,
      'x-internal-signature': await hmacSHA256Hex(reserved.inbound_key!, `${stamp}.meeting-agent.POST.${path}.${raw}`),
    } }), scoped, ctx); await waitOnExecutionContext(ctx); return response;
  }
  const read = await tool('context', request); expect(read.status).toBe(200);
  const context = meetingAgentContextSchema.parse(await read.json());
  expect(context.actor_sub).toBe('installation-diagnostic'); expect(context.participants).toEqual([]);
  const { content_kind, segments, subject, agenda, previous_proposals, started_at, ended_at, participants, ...scope } = context;
  const result: MeetingAgentResult = { ...scope, title: 'Synthetic check', summary: 'No commitments.', model: 'fixture-model', action_items: [], decision_candidates: [], open_questions: [], follow_up: null };
  return { tool, request, result };
}
describe('managed agent bootstrap and readiness', () => {
  it('is absent without the ephemeral key and refuses sessions, agent keys and other signature purposes', async () => {
    expect((await call('status', {}, { configured: false })).status).toBe(404);
    for (const options of [{ bearer: true }, { secret: 'wrong-key' }, { purpose: 'meeting-agent' }]) expect((await call('status', {}, options)).status).toBe(403);
    expect((await call('begin', { accountable_email: 'operator@other.test' })).status).toBe(403);
  });
  it('reserves once, preserves keys, creates no human and returns no keys from status', async () => {
    const a = await begin(), b = await begin(); expect(b).toEqual(a);
    expect(a.readiness.installation.state).toBe('provisioning'); expect(a.readiness.accountable_sub).toBeNull();
    expect(await env.USAGE.prepare("SELECT COUNT(*) AS count FROM people WHERE kind = 'human'").first()).toEqual({ count: 0 });
    const status = await (await call('status')).json(); expect(status).toMatchObject({ webhook_key: null, inbound_key: null });
    expect(managedAgentDescription(a.readiness)).toContain('Setup is in progress');
    await human(); expect((await readManagedAgentReadiness(scoped))!.installation.state).toBe('provisioning');
  });
  it('leaves an unrelated Steward untouched and allocates a different address', async () => {
    await env.USAGE.prepare("INSERT INTO agents (email, sub, name, source, created_at) VALUES ('steward@agents.localhost', 'agent:unrelated', 'Custom', 'enrolled', ?1)").bind(Date.now()).run();
    // The address domain is derived from the workspace public origin, never a global roster.
    const install = (await begin()).readiness.installation;
    const unrelated = await env.USAGE.prepare("SELECT sub, name, removed_at FROM agents WHERE sub = 'agent:unrelated'").first();
    expect(unrelated).toMatchObject({ name: 'Custom', removed_at: null }); expect(install.agent_sub).not.toBe('agent:unrelated');
    expect(install.agent_email).toContain('steward-2@');
  });
  it('requires a canonical signed callback and hosted erasure before waiting for an actual admin', async () => {
    const reserved = await bind(); runtime();
    expect((await call('verify')).status).toBe(200);
    expect((await readManagedAgentReadiness(scoped))!.verified_at).toBeNull();
    const p = await probe(reserved);
    expect((await p.tool('commit', { ...p.request, result: p.result })).status).toBe(200);
    expect((await p.tool('context', { ...p.request, workspace_id: 'another-workspace' })).status).toBe(403);
    runtime(false); expect((await call('verify')).status).toBe(503);
    expect((await readManagedAgentReadiness(scoped))!.installation.state).toBe('provisioning');
    runtime(); expect((await call('verify')).status).toBe(200);
    let state = (await readManagedAgentReadiness(scoped))!; expect(state.stage).toBe('awaiting_admin'); expect(state.accountable_sub).toBeNull();
    expect(managedAgentDescription(state)).toContain('admin to sign in');
    const persisted = await env.USAGE.prepare('SELECT * FROM managed_agent_provisioning').first();
    expect(JSON.stringify(persisted)).not.toContain('No commitments.'); expect(JSON.stringify(persisted)).not.toContain('synthetic installation check');
    await human(); state = (await readManagedAgentReadiness(scoped))!;
    expect(state.installation.state).toBe('ready'); expect(state.accountable_sub).toBe('actual-admin');
    expect(state.installation.source).toBe('starlings_managed');
  });
  it.each(['manifest', 'handoff', 'verify'])('refuses redirected runtime %s without readiness or signature forwarding', async (door) => {
    const reserved = await bind(); runtime();
    if (door === 'verify') {
      expect((await call('verify')).status).toBe(200);
      const p = await probe(reserved);
      expect((await p.tool('commit', { ...p.request, result: p.result })).status).toBe(200);
    }
    const original = globalThis.fetch, calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push(url); expect(init?.redirect).toBe('manual');
      if (url.endsWith('/' + door)) return new Response('{}', { status: 302,
        headers: { location: 'https://untrusted.example.invalid/' + door } });
      return original(input, init);
    });
    expect((await call('verify')).status).toBe(503);
    const origin = `https://starlings-meeting-${reserved.readiness.installation.id.replaceAll('-', '')}.vercel.app`;
    expect(calls).toEqual(door === 'manifest' ? [origin + '/manifest'] : [origin + '/manifest', origin + '/meet/meeting/' + door]);
    expect((await readManagedAgentReadiness(scoped))!).toMatchObject({ stage: 'failed', verified_at: null, failed_step: 'runtime_verify' });
  });

  it('a freeze during setup refuses diagnostic reads and admin activation', async () => {
    const reserved = await bind(); runtime(); await call('verify');
    const p = await probe(reserved), agent = reserved.readiness.installation;
    await env.USAGE.prepare(`INSERT INTO agent_freezes (agent_sub, agent_email, frozen_at, frozen_by_email)
      VALUES (?1, ?2, ?3, 'rosa@example.com')`).bind(agent.agent_sub, agent.agent_email, Date.now()).run();
    expect((await p.tool('context', p.request)).status).toBe(403);
    await human();
    const state = (await readManagedAgentReadiness(scoped))!;
    expect(state.installation.state).toBe('frozen'); expect(state.accountable_sub).toBeNull();
    const retry = await begin(); expect(retry.inbound_key).toBeNull(); expect(managedAgentDescription(state)).toContain('Frozen');
  });
  it('records a retryable unavailable runtime and refuses changed resource ownership', async () => {
    const original = await bind(); vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 503 })));
    expect((await call('verify')).status).toBe(503);
    expect((await readManagedAgentReadiness(scoped))!).toMatchObject({ stage: 'failed', failed_step: 'runtime_verify', retryable: true });
    expect((await begin()).inbound_key).toBe(original.inbound_key);
    expect((await call('bind', { project_id: 'prj_other', runtime_origin: 'https://evil.test', runtime_version: '123abcd' })).status).toBe(400);
  });
  it('re-pins the Bots commit only after a failed, unverified configure or deploy (meet#1152)', async () => {
    const reserved = await bind(), id = reserved.readiness.installation.id;
    const runtime_origin = `https://starlings-meeting-${id.replaceAll('-', '')}.vercel.app`;
    const rebind = (body: Record<string, unknown>) => call('bind', { installation_id: id, project_id: 'prj_fixture', runtime_origin, ...body });
    // Running and not failed: neither a new commit nor a re-pin.
    expect((await rebind({ runtime_version: '456cdef' })).status).toBe(409);
    expect((await rebind({ runtime_version: '456cdef', repin: true })).status).toBe(409);
    // Failed at verify: the deploy happened, so the commit stays.
    expect((await call('failed', { installation_id: id, failed_step: 'runtime_verify' })).status).toBe(200);
    expect((await rebind({ runtime_version: '456cdef', repin: true })).status).toBe(409);
    // Failed at deploy: only an explicit re-pin moves it, and the row runs again.
    expect((await call('failed', { installation_id: id, failed_step: 'runtime_deploy' })).status).toBe(200);
    expect((await rebind({ runtime_version: '456cdef' })).status).toBe(409);
    expect((await rebind({ runtime_version: '456cdef', repin: true })).status).toBe(200);
    expect((await readManagedAgentReadiness(scoped))!).toMatchObject({ stage: 'runtime', failed_step: null, runtime_version: '456cdef' });
    // Verified: an upgrade stays explicit, even after a later failure is recorded.
    await env.USAGE.prepare("UPDATE managed_agent_provisioning SET verified_at = ?1, stage = 'failed', failed_step = 'runtime_deploy'").bind(Date.now()).run();
    expect((await rebind({ runtime_version: '789abcd', repin: true })).status).toBe(409);
    expect((await readManagedAgentReadiness(scoped))!.runtime_version).toBe('456cdef');
  });
  it('removal revokes keys and queues erasure atomically; reruns never resurrect the agent', async () => {
    const a = await bind(), install = a.readiness.installation;
    expect(await removeAgent(scoped, install.agent_email, 'rosa@example.com', Date.now())).toBe(true);
    const b = await begin(); expect(b.readiness.installation.id).toBe(install.id); expect(b.readiness.installation.state).toBe('removed');
    expect(b.webhook_key).toBeNull(); expect(b.inbound_key).toBeNull();
    expect(await removeAgent(scoped, install.agent_email, 'rosa@example.com', Date.now())).toBe(false);
    const ledger = await env.USAGE.prepare('SELECT erase_requested_at, erased_at FROM managed_agent_provisioning').first<{ erase_requested_at: number; erased_at: number | null }>();
    expect(ledger!.erase_requested_at).toBeGreaterThan(0); expect(ledger!.erased_at).toBeNull();
    expect((await call('erased', { project_id: 'prj_other' })).status).toBe(409);
    expect((await call('erased', { project_id: 'prj_fixture' })).status).toBe(200);
  });
});
