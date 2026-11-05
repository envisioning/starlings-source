import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { roomStub } from '../src/do-jurisdiction';
import { sealAgentSecret } from '../src/agent-roster';
import { hmacSHA256Hex } from '../src/crypto';
import { processArtifactJob } from '../src/artifacts';
import { recordNotesOwed, sweepOwedNotes } from '../src/notes-owed';
import { settleMeetingAgentCommit } from '../src/meeting-agent-tools';
import { deliverMeeting, requestDelivery } from '../src/deliveries';
import { resetDocsTokenCache } from '../src/docs';
import { resetRoleCache } from '../src/capabilities';
import { meetingAgentHandoffSchema, MEETING_AGENT_MAX_DURATION_MS, type MeetingAgentHandoff, type MeetingAgentContext, type MeetingAgentResult } from '@starlings/contracts/meeting-agent';
import { coreTask } from './core-rows';

const installationId = '11111111-2222-4333-8444-555555555555';
const agentSub = 'agent:dispatch-fixture';
const agentEmail = 'dispatch-fixture@agents.example.invalid';
const workspaceId = 'dispatch-workspace';
const secret = 'dispatch-webhook-secret-at-least-32-characters';
const runtimeOrigin = `https://starlings-meeting-${installationId.replaceAll('-', '')}.vercel.app`;
const runtimeId = 'wrun_' + 'A'.repeat(26);
const saved = { core: (env as Env).INTERNAL_REQUEST_SECRET, docs: (env as Env).DOCS_INTERNAL_SECRET };

beforeEach(async () => {
  vi.spyOn(env.ARTIFACT_JOBS, 'send').mockResolvedValue(undefined as never);
  vi.spyOn(env.ARTIFACT_JOBS, 'sendBatch').mockResolvedValue(undefined as never);
  await env.USAGE.batch([
    env.USAGE.prepare('DELETE FROM managed_agent_provisioning'),
    env.USAGE.prepare('DELETE FROM built_in_agent_installations'),
    env.USAGE.prepare('DELETE FROM agent_freezes'),
    env.USAGE.prepare('DELETE FROM subject_visibility'),
    env.USAGE.prepare('DELETE FROM subject_grants'),
    env.USAGE.prepare("DELETE FROM workspace_settings WHERE key IN ('meeting_agent_workspace_id', 'plan')"),
  ]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); resetRoleCache(); resetDocsTokenCache();
  (env as Env).INTERNAL_REQUEST_SECRET = saved.core ?? ''; (env as Env).DOCS_INTERNAL_SECRET = saved.docs ?? ''; });

async function fixture(options: { minutes?: number; text?: boolean; installed?: boolean; filed?: boolean } = {}) {
  const now = Date.now();
  const owner = { sub: 'dispatch-owner', email: 'dispatch-owner@example.com', name: 'Owner' };
  const sealed = await sealAgentSecret(env, secret);
  await env.USAGE.batch([
    env.USAGE.prepare(`INSERT OR REPLACE INTO people (sub, email, name, kind, role, first_seen_at, last_seen_at)
      VALUES (?1, ?2, 'Owner', 'human', 'member', ?3, ?3)`).bind(owner.sub, owner.email, now),
    env.USAGE.prepare(`INSERT OR REPLACE INTO people (sub, email, name, kind, role, first_seen_at, last_seen_at)
      VALUES (?1, ?2, 'Steward', 'agent', 'member', ?3, ?3)`).bind(agentSub, agentEmail, now),
    env.USAGE.prepare(`INSERT OR REPLACE INTO agents (email, sub, name, source, created_at, webhook_secret_iv, webhook_secret_sealed, inbound_key_iv, inbound_key_sealed)
      VALUES (?1, ?2, 'Steward', 'enrolled', ?3, ?4, ?5, ?4, ?5)`).bind(agentEmail, agentSub, now, sealed.iv, sealed.ciphertext),
    env.USAGE.prepare(`INSERT OR REPLACE INTO workspace_settings (key, value, updated_at, updated_by)
      VALUES ('meeting_agent_workspace_id', ?1, ?2, ?3)`).bind(workspaceId, now, owner.sub),
  ]);
  if (options.installed !== false) await env.USAGE.batch([
    env.USAGE.prepare(`INSERT INTO built_in_agent_installations (id, workspace_id, agent_sub, role, state, created_at)
      VALUES (?1, ?2, ?3, 'meeting_follow_through', 'ready', ?4)`).bind(installationId, workspaceId, agentSub, now),
    env.USAGE.prepare(`INSERT INTO managed_agent_provisioning (installation_id, accountable_email, accountable_sub, stage, runtime_origin, runtime_version, project_id, verified_at, updated_at)
      VALUES (?1, 'admin@example.invalid', 'actual-installing-admin', 'ready', ?2, '34f0e6e', 'prj_fixture', ?3, ?3)`).bind(installationId, runtimeOrigin, now),
  ]);
  const slug = `dispatch-${crypto.randomUUID().slice(0, 8)}`, room = await roomStub(env, slug);
  await room.configureRoom({ slug, ownerSub: owner.sub, ownerEmail: owner.email, kind: 'permanent', expiresAt: null });
  const meeting = await room.startMeeting(owner, owner.email, 'fixture-device');
  const segmentId = crypto.randomUUID();
  if (options.text !== false) await room.appendTranscript(owner.sub, meeting.id, [{ id: segmentId, meeting_id: meeting.id,
    speaker_id: 'owner:private@example.invalid', speaker_name: 'Ana', language: 'en', starts_at_ms: 0, ends_at_ms: 2000,
    text: 'I will send the report.', is_final: true }]);
  await room.finalizeMeeting(owner.sub, meeting.id);
  await runInDurableObject(room, (_instance, ctx) => {
    ctx.storage.sql.exec('UPDATE meetings SET started_at = ? WHERE id = ?', now - (options.minutes ?? 20) * 60_000, meeting.id);
  });
  if (options.filed) await room.setMeetingCategory(owner.sub, meeting.id, { meetingKind: 'project', projectId: 'dispatch-project',
    leadId: null, partnerOrganizationId: null, subjectTitle: 'Project', categorizedBy: owner.email });
  await recordNotesOwed(env, slug, meeting.id, now);
  return { room, slug, meeting, owner, segmentId, job: { roomSlug: slug, meetingId: meeting.id } };
}
function result(context: MeetingAgentContext): MeetingAgentResult {
  return { workspace_id: context.workspace_id, installation_id: context.installation_id, agent_sub: context.agent_sub,
    actor_sub: context.actor_sub, room_slug: context.room_slug, meeting_id: context.meeting_id, source_revision: context.source_revision,
    grant_id: context.grant_id, invocation_id: context.invocation_id, run_id: context.run_id, correlation_id: context.correlation_id,
    expected_result_revision: context.expected_result_revision, skill_version: context.skill_version, model: 'fixture-model',
    title: 'Report', summary: 'Ana will send the report.',
    action_items: [{ proposal_id: 'send-report', what: 'Send the report', who: 'Ana', by_when: null,
      source_segment_ids: [context.segments[0]!.id], quote: 'I will send the report.', at_ms: 0 }],
    decision_candidates: [], open_questions: ['When is it due?'], follow_up: null };
}
async function attempt(f: Awaited<ReturnType<typeof fixture>>): Promise<unknown> {
  try { await processArtifactJob(f.job, env); return null; } catch (error) { return error; }
}
async function owed(f: Awaited<ReturnType<typeof fixture>>) {
  return env.USAGE.prepare('SELECT done_at FROM notes_owed WHERE meeting_id = ?1').bind(f.meeting.id).first<{ done_at: number | null }>();
}
function runtime(onHandoff: (job: MeetingAgentHandoff) => Promise<Response>) {
  const calls: MeetingAgentHandoff[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(runtimeOrigin + '/meet/meeting/handoff');
    expect(init?.redirect).toBe('manual');
    const raw = String(init?.body), job = meetingAgentHandoffSchema.parse(JSON.parse(raw));
    // Steward refuses a deadline further ahead than its own limit (403).
    expect(job.deadline_at).toBeLessThanOrEqual(Date.now() + MEETING_AGENT_MAX_DURATION_MS);
    const headers = new Headers(init?.headers), stamp = headers.get('x-internal-timestamp');
    expect(headers.get('x-internal-signature')).toBe(await hmacSHA256Hex(secret, `${stamp}.meeting-agent.POST./meet/meeting/handoff.${raw}`));
    expect(raw).not.toContain('send the report'); expect(raw).not.toContain('@');
    calls.push(job); return onHandoff(job);
  });
  return calls;
}
const ack = (job: MeetingAgentHandoff) => Response.json({ accepted: true, run_id: job.run_id, runtime_run_id: runtimeId });

describe('automatic meeting dispatch through the existing artifact queue', () => {
  it('records one actual-owner product assignment before handoff; ACK leaves notes owed', async () => {
    const f = await fixture();
    const calls = runtime(async (job) => {
      const run = await f.room.automaticMeetingAgentRun(f.meeting.id);
      expect(run?.id).toBe(job.run_id); expect(run?.invocation.actor_sub).toBe(f.owner.sub);
      expect(run?.invocation.kind).toBe('built_in_product'); expect(run?.correlation_id).toBe(`meeting-finalized:${f.meeting.id}`);
      expect(await owed(f)).toEqual({ done_at: null }); return ack(job);
    });
    expect(await attempt(f)).toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1); expect((await f.room.artifactForProcessing(f.meeting.id)).summary).toBeNull();
    const state = await f.room.exportState();
    expect(state.tables.meeting_agent_runs?.[0]).toMatchObject({ dispatch_attempts: 1, dispatch_runtime_id: runtimeId, dispatch_accepted_at: expect.any(Number) });
    expect(state.tables.meeting_agent_runs?.[0]).not.toHaveProperty('transcript');
  });

  it('refuses a redirected handoff without accepting its ACK or forwarding the signature', async () => {
    const f = await fixture();
    const calls = runtime(async (job) => Response.json({ accepted: true, run_id: job.run_id, runtime_run_id: runtimeId },
      { status: 302, headers: { location: 'https://untrusted.example.invalid/handoff' } }));
    expect(await attempt(f)).toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1); expect(await owed(f)).toEqual({ done_at: null });
    expect((await f.room.artifactForProcessing(f.meeting.id)).summary).toBeNull();
    expect((await f.room.exportState()).tables.meeting_agent_runs?.[0]).toMatchObject({
      dispatch_attempts: 1, dispatch_accepted_at: null, dispatch_runtime_id: null, dispatch_lease_id: null });
  });

  it('deduplicates concurrent finalization jobs and concurrent owed-notes sweeps', async () => {
    const f = await fixture(); const calls = runtime(async (job) => ack(job));
    await Promise.all([attempt(f), attempt(f), attempt(f)]); expect(calls).toHaveLength(1);
    await Promise.all([sweepOwedNotes(env, Date.now() + 16 * 60_000), sweepOwedNotes(env, Date.now() + 16 * 60_000)]);
    await Promise.all([attempt(f), attempt(f)]); expect(calls).toHaveLength(1);
    expect((await f.room.exportState()).tables.meeting_agent_runs).toHaveLength(1);
  });

  it('retries a lost ACK with the same job/run/grant after a runtime restart', async () => {
    const f = await fixture(); const calls = runtime(async (job) => { if (calls.length === 1) throw new Error('private provider text'); return ack(job); });
    const first = await attempt(f); expect(first).toMatchObject({ status: 503 }); expect(String(first)).not.toContain('private');
    await attempt(f); expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
    expect((await f.room.exportState()).tables.meeting_agent_runs).toHaveLength(1);
  });

  it('a committed ACK without a canonical receipt never finishes notes', async () => {
    const f = await fixture(); runtime(async (job) => Response.json({ accepted: true, run_id: job.run_id, outcome: 'committed' }));
    expect(await attempt(f)).toMatchObject({ status: 503 }); expect(await owed(f)).toEqual({ done_at: null });
    expect((await f.room.artifactForProcessing(f.meeting.id)).summary).toBeNull();
  });

  it('recovers commit before ACK, duplicate callback and queue redelivery without another result', async () => {
    const f = await fixture(); let receipt;
    const calls = runtime(async (job) => {
      const request = { workspace_id: job.workspace_id, room_slug: job.room_slug, meeting_id: job.meeting_id, run_id: job.run_id };
      const context = await f.room.meetingAgentContext(request, agentSub); const output = result(context);
      receipt = await f.room.commitMeetingAgentResult(request, agentSub, output);
      expect(await f.room.commitMeetingAgentResult(request, agentSub, output)).toEqual(receipt);
      throw new Error('Crash before handoff ACK');
    });
    await attempt(f); expect(await f.room.pendingMeetingAgentDeliveries()).toHaveLength(1);
    await processArtifactJob(f.job, env); await processArtifactJob(f.job, env);
    expect(calls).toHaveLength(1); expect((await f.room.meetingLogMaterial(f.meeting.id)).revision).toBe(receipt!.result_revision);
    expect((await owed(f))?.done_at).toEqual(expect.any(Number)); expect(await f.room.pendingMeetingAgentDeliveries()).toHaveLength(0);
  });

  it('a worker dying after its dispatch lease recovers the same assignment when the lease expires', async () => {
    const f = await fixture(); const run = await f.room.prepareAutomaticMeetingAgentRun(f.meeting.id, installationId, 'meeting-follow-through-v1');
    expect(await f.room.claimMeetingAgentDispatch(run.id)).not.toBeNull();
    const calls = runtime(async (job) => ack(job)); expect(await attempt(f)).toMatchObject({ status: 503 }); expect(calls).toHaveLength(0);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 61_000);
    await attempt(f); expect(calls[0]?.run_id).toBe(run.id);
  });

  it('bounds handoffs, then the existing sweep closes expired work with system fallback and refuses late output', async () => {
    // A refused hand-off is retried after its 60 s lease, so eight tries fit inside the grant.
    const f = await fixture(); const calls = runtime(async () => new Response(null, { status: 503 }));
    vi.useFakeTimers(); const now = Date.now();
    for (let n = 0; n < 8; n++) { vi.setSystemTime(now + n * 61_000); await attempt(f); }
    expect(calls).toHaveLength(6);
    const run = (await f.room.automaticMeetingAgentRun(f.meeting.id))!;
    const context = await f.room.meetingAgentContext({ workspace_id: workspaceId, room_slug: f.slug, meeting_id: f.meeting.id, run_id: run.id }, agentSub);
    vi.setSystemTime(now + 31 * 60_000); await sweepOwedNotes(env); await processArtifactJob(f.job, env);
    expect((await f.room.artifactForProcessing(f.meeting.id)).summary).toContain('System-authored fallback');
    let denied; try { await f.room.commitMeetingAgentResult({ workspace_id: workspaceId, room_slug: f.slug, meeting_id: f.meeting.id, run_id: run.id }, agentSub, result(context)); } catch (error) { denied = error; }
    expect(denied).toMatchObject({ status: 403 }); expect(calls).toHaveLength(6);
    const state = await f.room.exportState(); expect(JSON.parse(String(state.tables.meetings?.[0]?.agent_notes_metadata))).toEqual({ actor_kind: 'system', outcome: 'fallback', reason: 'expired' });
  });

  it.each(['pause', 'freeze', 'remove', 'personal', 'human_revoke', 'human_agent', 'restricted', 'unverified', 'wrong_origin'] as const)('refuses %s before dispatch while preserving essential artifacts', async (mode) => {
    const f = await fixture({ filed: mode === 'restricted' });
    if (mode === 'pause') await env.USAGE.prepare("UPDATE built_in_agent_installations SET state = 'paused'").run();
    if (mode === 'freeze') await env.USAGE.prepare("INSERT INTO agent_freezes (agent_sub, agent_email, frozen_at, frozen_by_email) VALUES (?1, ?2, ?3, 'admin@example.invalid')").bind(agentSub, agentEmail, Date.now()).run();
    if (mode === 'remove') await env.USAGE.prepare('UPDATE agents SET removed_at = ?1 WHERE sub = ?2').bind(Date.now(), agentSub).run();
    if (mode === 'personal') await runInDurableObject(f.room, (_instance, ctx) => { ctx.storage.sql.exec('UPDATE meetings SET agent_personal = 1 WHERE id = ?', f.meeting.id); });
    if (mode === 'human_revoke') await env.USAGE.prepare('UPDATE people SET revoked_at = ?1 WHERE sub = ?2').bind(Date.now(), f.owner.sub).run();
    if (mode === 'human_agent') await env.USAGE.prepare("UPDATE people SET kind = 'agent' WHERE sub = ?1").bind(f.owner.sub).run();
    if (mode === 'restricted') await env.USAGE.prepare("INSERT INTO subject_visibility (kind, subject_id, visibility, updated_by, updated_at) VALUES ('project', 'dispatch-project', 'restricted', ?1, ?2)").bind(f.owner.sub, Date.now()).run();
    if (mode === 'unverified') await env.USAGE.prepare('UPDATE managed_agent_provisioning SET verified_at = NULL').run();
    if (mode === 'wrong_origin') await env.USAGE.prepare("UPDATE managed_agent_provisioning SET runtime_origin = 'https://other.invalid'").run();
    const calls = runtime(async (job) => ack(job)); await processArtifactJob(f.job, env);
    expect(calls).toHaveLength(0); const material = await f.room.artifactForProcessing(f.meeting.id);
    expect(material.transcript).toHaveLength(1); expect(material.summary).toContain('System-authored fallback');
  });

  it('never overwrites human notes when a response arrives late', async () => {
    const f = await fixture(); let context: MeetingAgentContext | null = null;
    runtime(async (job) => { context = await f.room.meetingAgentContext(job, agentSub); return ack(job); }); await attempt(f);
    await f.room.setSummary(f.meeting.id, 'Correction', 'Human corrected notes'); await processArtifactJob(f.job, env);
    let denied; try { await f.room.commitMeetingAgentResult(context!, agentSub, result(context!)); } catch (error) { denied = error; }
    expect(denied).toMatchObject({ status: 409 }); expect((await f.room.artifactForProcessing(f.meeting.id)).summary).toBe('Human corrected notes');
  });

  it('short meetings are discarded before any agent grant, and missing final text needs no runtime', async () => {
    const short = await fixture({ minutes: 1 }); const calls = runtime(async (job) => ack(job));
    await processArtifactJob(short.job, env); expect(await short.room.automaticMeetingAgentRun(short.meeting.id)).toBeNull();
    const empty = await fixture({ text: false, installed: false }); await processArtifactJob(empty.job, env);
    expect((await empty.room.artifactForProcessing(empty.meeting.id)).summary).toContain('No finalized transcript'); expect(calls).toHaveLength(0);
  });

  it('recovers a crash between commit and delivery, and delivers independent destinations without re-extraction', async () => {
    const f = await fixture({ filed: true });
    (env as Env).INTERNAL_REQUEST_SECRET = 'core-fixture-secret-at-least-32-characters';
    (env as Env).DOCS_INTERNAL_SECRET = 'docs-fixture-secret-at-least-32-characters'; resetDocsTokenCache();
    await runInDurableObject(f.room, (_instance, ctx) => {
      ctx.storage.sql.exec(`INSERT INTO participants (meeting_id, identity, name, email, transcript_opt_in, role, updated_at)
        VALUES (?, 'guest:ana', 'Ana', 'ana@outside.invalid', 1, 'guest', ?)`, f.meeting.id, Date.now());
    });
    const run = await f.room.prepareAutomaticMeetingAgentRun(f.meeting.id, installationId, 'meeting-follow-through-v1');
    const request = { workspace_id: workspaceId, room_slug: f.slug, meeting_id: f.meeting.id, run_id: run.id };
    const context = await f.room.meetingAgentContext(request, agentSub);
    await f.room.commitMeetingAgentResult(request, agentSub, { ...result(context), follow_up: { subject: 'Report', body: 'Here is the report plan.' } });
    // Durable result exists; a failed ledger write must keep its settlement marker and owed row.
    await env.USAGE.prepare(`CREATE TRIGGER dispatch_delivery_failure BEFORE INSERT ON meeting_deliveries
      BEGIN SELECT RAISE(FAIL, 'synthetic delivery interruption'); END`).run();
    let interrupted;
    try { await settleMeetingAgentCommit(env, f.slug, run.id); } catch (error) { interrupted = error; }
    finally { await env.USAGE.prepare('DROP TRIGGER dispatch_delivery_failure').run(); }
    expect(interrupted).toBeInstanceOf(Error); expect(await f.room.pendingMeetingAgentDeliveries()).toHaveLength(1);
    expect(await owed(f)).toEqual({ done_at: null });
    const counts = { tasks: 0, logs: 0, docs: 0 }; let docsUp = false;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(request.url).pathname;
      if (path === '/api/tokens/meet-exchange') return Response.json({ token: 'evd_fixture', scopes: [], expires_at: new Date(Date.now() + 3600_000).toISOString() });
      if (path === '/api/docs') {
        if (!docsUp) return new Response('{}', { status: 503 }); counts.docs++;
        return Response.json({ id: 'doc-fixture', path: '/work/transcripts/doc-fixture', title: 'Report', subjects: [], updated_at: new Date().toISOString() }, { status: 201 });
      }
      if (path === '/api/docs/doc-fixture') return Response.json({ id: 'doc-fixture', path: '/work/transcripts/doc-fixture', title: 'Report', subjects: [], updated_at: new Date().toISOString() });
      if (path.endsWith('/subjects')) return Response.json({ ok: true });
      if (path === '/api/public/meet-meeting-logs') { counts.logs++; return Response.json({ ok: true }); }
      if (path === '/api/public/meet-crm-tasks') { counts.tasks++; return Response.json({ ok: true, task: coreTask({ id: 'task-fixture', title: 'Send the report', status: 'proposed', project_id: 'dispatch-project' }) }); }
      throw new Error(`Unexpected fixture path: ${path}`);
    });
    await processArtifactJob(f.job, env); expect(await f.room.pendingMeetingAgentDeliveries()).toHaveLength(0);
    expect((await owed(f))?.done_at).toEqual(expect.any(Number));
    const destinations = await env.USAGE.prepare('SELECT destination FROM meeting_deliveries WHERE meeting_id = ?1').bind(f.meeting.id).all<{ destination: string }>();
    expect(destinations.results.map((row) => row.destination).sort()).toEqual(['core', 'docs', 'followup', 'proposals']);
    let partial; try { await deliverMeeting(env, f.slug, f.meeting.id); } catch (error) { partial = error; }
    expect(String(partial)).toContain('docs'); expect(counts.tasks).toBe(1); expect(counts.logs).toBe(1);
    const followup = await env.USAGE.prepare('SELECT meeting_id FROM meeting_follow_ups WHERE meeting_id = ?1').bind(f.meeting.id).first();
    expect(followup).not.toBeNull();
    docsUp = true; await deliverMeeting(env, f.slug, f.meeting.id); await requestDelivery(env, f.slug, f.meeting.id, { inline: true });
    expect(counts.tasks).toBe(1); expect(counts.docs).toBe(1);
    expect((await f.room.meetingLogMaterial(f.meeting.id)).actionItems[0]?.task_id).toBe('task-fixture');
    expect((await f.room.exportState()).tables.meeting_agent_runs).toHaveLength(1);
  });

  it('filing after extraction uses the same canonical result instead of another runtime call', async () => {
    const f = await fixture(); const calls = runtime(async (job) => {
      const context = await f.room.meetingAgentContext(job, agentSub);
      await f.room.commitMeetingAgentResult(job, agentSub, result(context)); return ack(job);
    });
    await processArtifactJob(f.job, env);
    await f.room.setMeetingCategory(f.owner.sub, f.meeting.id, { meetingKind: 'project', projectId: 'dispatch-project',
      leadId: null, partnerOrganizationId: null, subjectTitle: 'Project', categorizedBy: f.owner.email });
    await processArtifactJob(f.job, env); expect(calls).toHaveLength(1);
    expect((await f.room.meetingLogMaterial(f.meeting.id)).actionItems[0]?.proposal_id).toBe('send-report');
  });

  it('uninstalled workspaces retain their legacy deterministic path', async () => {
    const f = await fixture({ installed: false }); const calls = runtime(async (job) => ack(job)); await processArtifactJob(f.job, env);
    expect((await f.room.artifactForProcessing(f.meeting.id)).summary).not.toBeNull(); expect(calls).toHaveLength(0);
    expect(await f.room.automaticMeetingAgentRun(f.meeting.id)).toBeNull();
  });
});
