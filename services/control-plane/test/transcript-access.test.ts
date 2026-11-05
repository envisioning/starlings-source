import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { signingKey } from '../src/crypto';
import { resetPeerRosterCache } from '../src/peers';
import { resetRoleCache } from '../src/capabilities';

const CORE_SECRET = 'transcript-access-core-secret-with-32-chars';
const SESSION_SECRET = 'transcript-access-session-secret-32-chars';
const PROJECT_ID = 'c0ffee00-0000-4000-8000-0000000000e1';
const configured = {
  ...env,
  INTERNAL_REQUEST_SECRET: CORE_SECRET,
  SESSION_SIGNING_SECRET: SESSION_SECRET,
} as Env;

async function fetchWorker(request: Request) {
  const context = createExecutionContext();
  const response = await worker.fetch(request, configured, context);
  await waitOnExecutionContext(context);
  return response;
}

async function session(email: string, name: string) {
  const response = await fetchWorker(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email }),
  }));
  expect(response.status).toBe(200);
  const { access_token } = await response.json<{ access_token: string }>();
  const headers = { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' };
  // The people row is created on the first authenticated read.
  await fetchWorker(new Request('http://local/api/peers', { headers }));
  return headers;
}

async function meeting(owner: Record<string, string>, filed: boolean) {
  const created = await fetchWorker(new Request('http://local/api/rooms/rosa/meetings/ambient', {
    method: 'POST',
    headers: owner,
    body: JSON.stringify({
      started_at: '2026-09-16T09:00:00.000Z',
      ended_at: '2026-09-16T09:30:00.000Z',
      title: 'Acme kickoff',
    }),
  }));
  expect(created.status).toBe(201);
  const { meeting_id } = await created.json<{ meeting_id: string }>();
  const segment = {
    id: crypto.randomUUID(), meeting_id, speaker_id: 'ambient:ana', speaker_name: 'Ana',
    language: 'en', starts_at_ms: 0, ends_at_ms: 900, text: 'Kickoff transcript.', is_final: true,
  };
  const appended = await fetchWorker(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/transcript`, {
    method: 'POST', headers: owner, body: JSON.stringify({ segments: [segment] }),
  }));
  expect(appended.status).toBe(200);
  const finalized = await fetchWorker(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/finalize`, {
    method: 'POST', headers: owner,
  }));
  expect(finalized.status).toBe(202);

  if (filed) {
    await env.ROOMS.getByName('rosa').setMeetingCategory(`dev:rosa@example.com`, meeting_id, {
      meetingKind: 'project', leadId: null, projectId: PROJECT_ID, partnerOrganizationId: null,
      subjectTitle: 'Acme rollout', categorizedBy: 'rosa@example.com',
    });
  }
  return { meeting_id, segment };
}

async function setRole(email: string, role: 'member' | 'community') {
  await configured.USAGE.prepare('UPDATE people SET role = ?2 WHERE email = ?1').bind(email, role).run();
  resetRoleCache();
  resetPeerRosterCache();
}

function coreHasProject() {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
    ok: true,
    subject: { id: PROJECT_ID, kind: 'project', title: 'Acme rollout', subtitle: 'Acme' },
  }), { headers: { 'content-type': 'application/json' } }));
}

async function mcpBearer(email: string, name: string) {
  const client = `transcript-client-${crypto.randomUUID()}`;
  const grant = `transcript-grant-${crypto.randomUUID()}`;
  const now = Date.now();
  await configured.USAGE.prepare(
    `INSERT INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at) VALUES (?1, 'claude.ai', NULL, '["https://claude.ai/api/mcp/auth_callback"]', ?2)`,
  ).bind(client, now).run();
  await configured.USAGE.prepare(
    `INSERT INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, 'read', 'jti', NULL, ?5, ?5, NULL, NULL)`,
  ).bind(grant, client, `dev:${email}`, email, now).run();
  return new SignJWT({ email, name, scope: 'read', grant, client })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('starlings.example')
    .setAudience('meet-mcp')
    .setSubject(`dev:${email}`)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey(SESSION_SECRET));
}

afterEach(async () => {
  vi.unstubAllGlobals();
  resetRoleCache();
  resetPeerRosterCache();
  await configured.USAGE.prepare("DELETE FROM people WHERE email LIKE 'transcript-%@example.com'").run();
});

describe('filed transcript access', () => {
  it('keeps an unfiled transcript owner-only', async () => {
    const owner = await session('rosa@example.com', 'Rosa');
    const colleagueEmail = `transcript-${crypto.randomUUID()}@example.com`;
    const colleague = await session(colleagueEmail, 'Colleague');
    const { meeting_id } = await meeting(owner, false);

    const ownerRead = await fetchWorker(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/transcript`, { headers: owner }));
    expect(ownerRead.status).toBe(200);
    // The owner's view names who was there (meet#692): the header of an export.
    const ownerBody = await ownerRead.json<{ attendees?: string[] }>();
    expect(Array.isArray(ownerBody.attendees)).toBe(true);
    const colleagueRead = await fetchWorker(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/transcript`, { headers: colleague }));
    expect(colleagueRead.status).toBe(404);
  });

  it('lets a member read a filed record, without owner controls or delivery state', async () => {
    const owner = await session('rosa@example.com', 'Rosa');
    const colleagueEmail = `transcript-${crypto.randomUUID()}@example.com`;
    const colleague = await session(colleagueEmail, 'Colleague');
    const { meeting_id } = await meeting(owner, true);
    coreHasProject();

    const response = await fetchWorker(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/transcript`, { headers: colleague }));
    expect(response.status).toBe(200);
    const body = await response.json<{ artifact: { transcript: Array<{ text: string }> }; deliveries: unknown[]; read_only?: boolean }>();
    expect(body.artifact.transcript.map((line) => line.text)).toEqual(['Kickoff transcript.']);
    expect(body.deliveries).toEqual([]);
    expect(body.read_only).toBe(true);
    // The roster stays the owner's; a member's export names the speakers.
    expect((body as { attendees?: unknown }).attendees).toBeUndefined();

    const rename = await fetchWorker(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/transcript`, {
      method: 'PATCH', headers: colleague,
      body: JSON.stringify({ speaker_id: 'ambient:ana', speaker_name: 'Changed by colleague' }),
    }));
    expect(rename.status).toBe(403);
  });

  it('refuses community accounts even when the meeting is filed', async () => {
    const owner = await session('rosa@example.com', 'Rosa');
    const communityEmail = `transcript-${crypto.randomUUID()}@example.com`;
    const community = await session(communityEmail, 'Community');
    await setRole(communityEmail, 'community');
    const { meeting_id } = await meeting(owner, true);
    const response = await fetchWorker(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/transcript`, { headers: community }));
    expect(response.status).toBe(403);
    expect(await response.json<{ code?: string }>()).toMatchObject({ code: 'capability_denied' });
  });

  it('makes the same filed record available through the MCP transcript tool', async () => {
    const owner = await session('rosa@example.com', 'Rosa');
    const colleagueEmail = `transcript-${crypto.randomUUID()}@example.com`;
    await session(colleagueEmail, 'Colleague');
    const { meeting_id } = await meeting(owner, true);
    coreHasProject();
    const token = await mcpBearer(colleagueEmail, 'Colleague');
    const response = await fetchWorker(new Request('http://local/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'transcript', arguments: { room: 'rosa', meeting_id },
      } }),
    }));
    const answer = await response.json<{ result?: { isError?: boolean; content?: Array<{ text?: string }> } }>();
    expect(answer.result?.isError).toBe(false);
    expect(answer.result?.content?.[0]?.text).toContain('Kickoff transcript.');
  });
});
