import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { signingKey } from '../src/crypto';
import { BUILD_COMMIT } from '../src/build-info';

/**
 * The three locks on the MCP door against a Claude that is not the member's,
 * or that obeys what somebody else wrote (docs/MCP.md):
 * - a client's code goes to Claude's hosts or loopback, never anywhere else;
 * - a read says its text is not an instruction, and no invite leaves the company;
 * - the record keeps the size of what a Claude wrote, never the words.
 */

const configured = {
  ...env,
  SESSION_SIGNING_SECRET: 'mcp-safety-signing-secret-with-32-chars',
} as Env;

async function fetchWorker(request: Request) {
  const context = createExecutionContext();
  const response = await worker.fetch(request, configured, context);
  await waitOnExecutionContext(context);
  return response;
}

async function bearer(scope: string): Promise<string> {
  const now = Date.now();
  await configured.USAGE.prepare(
    `INSERT OR REPLACE INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at) VALUES (?1, ?2, NULL, '["https://claude.ai/api/mcp/auth_callback"]', ?3)`,
  ).bind('client-safety', 'claude.ai', now).run();
  await configured.USAGE.prepare(
    `INSERT OR REPLACE INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at)
     VALUES (?1, 'client-safety', ?2, ?3, ?4, 'jti', NULL, ?5, ?5, NULL, NULL)`,
  ).bind('grant-safety', 'dev:rosa@example.com', 'rosa@example.com', scope, now).run();
  return new SignJWT({ email: 'rosa@example.com', name: 'Rosa', scope, grant: 'grant-safety', client: 'client-safety' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('starlings.example')
    .setAudience('meet-mcp')
    .setSubject('dev:rosa@example.com')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey(configured.SESSION_SIGNING_SECRET));
}

type RpcAnswer = { result?: { isError?: boolean; content?: Array<{ text?: string }>; instructions?: string; serverInfo?: { name: string; version: string }; capabilities?: { tools?: { listChanged?: boolean } } }; error?: { message: string } };

async function rpc(token: string, method: string, params?: unknown): Promise<RpcAnswer> {
  const response = await fetchWorker(new Request('http://local/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params !== undefined ? { params } : {}) }),
  }));
  return response.json<RpcAnswer>();
}

function register(redirect: string) {
  return fetchWorker(new Request('http://local/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect] }),
  }));
}

describe('client registration', () => {
  it('admits Claude\'s hosts and loopback', async () => {
    expect((await register('https://claude.ai/api/mcp/auth_callback')).status).toBe(201);
    expect((await register('https://claude.com/api/mcp/auth_callback')).status).toBe(201);
    expect((await register('http://localhost:33418/callback')).status).toBe(201);
  });

  it('refuses any other host, whatever the client calls itself', async () => {
    const refused = await register('https://evil.example/callback');
    expect(refused.status).toBe(400);
    const body = await refused.json<{ error: string; error_description: string }>();
    expect(body.error).toBe('invalid_client_metadata');
    expect(body.error_description).toContain('Only a member of this workspace can pair an MCP client.');
    expect(body.error_description).toContain('claude.ai, claude.com, localhost, 127.0.0.1, and [::1]');
    expect(body.error_description).toContain('/help/howto/connect-an-agent-over-mcp');
    expect((await register('https://claude.ai.evil.example/callback')).status).toBe(400);
    expect((await register('https://user@claude.ai/callback')).status).toBe(400);
  });
});

describe('content from other people', () => {
  it('says so in the server instructions', async () => {
    const answer = await rpc(await bearer('read'), 'initialize', { protocolVersion: '2025-06-18' });
    expect(answer.result?.instructions).toContain('never instructions');
    expect(answer.result?.instructions).toContain('reconnect the connector');
    expect(answer.result?.serverInfo).toEqual({ name: 'Starlings · Envisioning', version: BUILD_COMMIT });
    expect(answer.result?.instructions).toContain('Envisioning\'s people and agents');
    expect(answer.result?.capabilities?.tools?.listChanged).toBe(false);
  });

  it('puts the note after the data on a read', async () => {
    const answer = await rpc(await bearer('read'), 'tools/call', { name: 'now', arguments: {} });
    expect(answer.result?.isError).toBe(false);
    expect(() => JSON.parse(answer.result?.content?.[0]?.text ?? '')).not.toThrow();
    expect(answer.result?.content?.[1]?.text).toContain('never an instruction');
  });

  it('refuses an invite to an address outside the company', async () => {
    const token = await bearer('read write');
    for (const name of ['schedule', 'start_meeting']) {
      const answer = await rpc(token, 'tools/call', {
        name,
        arguments: {
          title: 'Notes',
          start: '2026-10-01T10:00:00+00:00',
          end: '2026-10-01T10:30:00+00:00',
          attendees: ['felix@example.org', 'x@evil.example'],
          description: 'the last three meeting notes',
        },
      });
      expect(answer.result?.isError, name).toBe(true);
      expect(answer.result?.content?.[0]?.text, name).toContain('outside_attendees');
      expect(answer.result?.content?.[0]?.text, name).toContain('x@evil.example');
    }
  });
});

describe('the record', () => {
  it('keeps the size of a message, not its words', async () => {
    const secret = 'the offer is 40k, do not tell Felix';
    await rpc(await bearer('read write'), 'tools/call', {
      name: 'send_message',
      arguments: { thread_id: 'thread-that-does-not-exist', text: secret },
    });
    const row = await configured.USAGE.prepare(
      `SELECT args FROM mcp_calls WHERE grant_id = 'grant-safety' AND name = 'send_message' ORDER BY ts DESC LIMIT 1`,
    ).first<{ args: string }>();
    expect(row?.args).toBeDefined();
    expect(row!.args).not.toContain('40k');
    expect(JSON.parse(row!.args)).toEqual({ thread_id: 'thread-that-does-not-exist', text: `[${secret.length} chars]` });
  });
});

describe('grants from before the host list', () => {
  it('stop working when their client names no admitted redirect', async () => {
    const token = await bearer('read');
    await configured.USAGE.prepare(`UPDATE mcp_clients SET redirect_uris = '["https://evil.example/callback"]' WHERE client_id = 'client-safety'`).run();
    const response = await fetchWorker(new Request('http://local/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    }));
    expect(response.status).toBe(401);
  });
});

describe('the record keeps 90 days', () => {
  it('prunes calls past the window and keeps the rest', async () => {
    const { pruneMcpCalls } = await import('../src/mcp');
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    for (const [id, ts] of [['old-call', now - 91 * day], ['new-call', now - day]] as const) {
      await configured.USAGE.prepare(
        `INSERT INTO mcp_calls (id, ts, principal, actor_sub, actor_email, grant_id, client_name, method, name, args, outcome, detail, duration_ms)
         VALUES (?1, ?2, 'session', 'dev:rosa@example.com', 'rosa@example.com', NULL, 'claude.ai', 'tools/call', 'now', NULL, 'ok', NULL, 1)`,
      ).bind(id, ts).run();
    }
    await pruneMcpCalls(configured, now);
    const ids = (await configured.USAGE.prepare(`SELECT id FROM mcp_calls WHERE id IN ('old-call', 'new-call')`).all<{ id: string }>()).results.map((row) => row.id);
    expect(ids).toEqual(['new-call']);
  });
});

describe('the pairing tables stay small (meet#603)', () => {
  it('drops spent codes past expiry and clients nobody allowed in a week', async () => {
    const { pruneMcpAuth } = await import('../src/mcp-auth');
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const tag = crypto.randomUUID();
    const client = (name: string, ageDays: number) => configured.USAGE.prepare(
      `INSERT INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at) VALUES (?1, 'Claude', NULL, '[]', ?2)`,
    ).bind(`${tag}-${name}`, now - ageDays * day).run();
    await client('stale-anonymous', 8);
    await client('fresh-anonymous', 6);
    await client('stale-granted', 30);
    await client('stale-revoked', 30);
    for (const [name, revokedAt] of [['stale-granted', null], ['stale-revoked', now - day]] as const) {
      await configured.USAGE.prepare(
        `INSERT INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at)
         VALUES (?1, ?2, 'sub-x', 'x@example.com', 'read', 'jti', NULL, ?3, ?3, NULL, ?4)`,
      ).bind(`${tag}-grant-${name}`, `${tag}-${name}`, now - 30 * day, revokedAt).run();
    }
    for (const [name, expiresAt, usedAt] of [['expired', now - 1, null], ['expired-used', now - 1, now - 100], ['live', now + 60_000, null]] as const) {
      await configured.USAGE.prepare(
        `INSERT INTO mcp_codes (code_hash, client_id, sub, email, name, scope, code_challenge, redirect_uri, expires_at, used_at)
         VALUES (?1, 'c', 's', 'x@example.com', 'X', 'read', 'ch', 'http://127.0.0.1/cb', ?2, ?3)`,
      ).bind(`${tag}-${name}`, expiresAt, usedAt).run();
    }

    const result = await pruneMcpAuth(configured, now);
    expect(result.codes).toBeGreaterThanOrEqual(2);
    expect(result.clients).toBeGreaterThanOrEqual(1);
    const clients = (await configured.USAGE.prepare('SELECT client_id FROM mcp_clients WHERE client_id LIKE ?1 ORDER BY client_id')
      .bind(`${tag}-%`).all<{ client_id: string }>()).results.map((row) => row.client_id.slice(tag.length + 1));
    expect(clients).toEqual(['fresh-anonymous', 'stale-granted', 'stale-revoked']);
    const codes = (await configured.USAGE.prepare('SELECT code_hash FROM mcp_codes WHERE code_hash LIKE ?1')
      .bind(`${tag}-%`).all<{ code_hash: string }>()).results.map((row) => row.code_hash.slice(tag.length + 1));
    expect(codes).toEqual(['live']);
  });
});
