import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { signingKey } from '../src/crypto';
import { handleMcp, mcpIdempotencyKey, pruneMcpIdempotency, type Dispatch } from '../src/mcp';

const configured = {
  ...env,
  SESSION_SIGNING_SECRET: 'mcp-idempotency-signing-secret-32-chars',
} as Env;

type ToolResult = {
  content?: Array<{ text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
  replayed?: boolean;
};
type RpcAnswer = { result?: ToolResult; error?: { code: number; message: string } };

async function bearer(): Promise<{ token: string; grantID: string }> {
  const suffix = crypto.randomUUID();
  const now = Date.now();
  const clientID = `mcp-idem-${suffix}`;
  const grantID = `mcp-idem-${suffix}`;
  await configured.USAGE.prepare(
    `INSERT INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at)
     VALUES (?1, 'Idempotency test', NULL, '["https://claude.ai/api/mcp/auth_callback"]', ?2)`,
  ).bind(clientID, now).run();
  await configured.USAGE.prepare(
    `INSERT INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at)
     VALUES (?1, ?2, 'dev:rosa@example.com', 'rosa@example.com', 'read write', 'jti', NULL, ?3, ?3, NULL, NULL)`,
  ).bind(grantID, clientID, now).run();
  const token = await new SignJWT({
    email: 'rosa@example.com',
    name: 'Rosa',
    scope: 'read write',
    grant: grantID,
    client: clientID,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('starlings.example')
    .setAudience('meet-mcp')
    .setSubject('dev:rosa@example.com')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey(configured.SESSION_SIGNING_SECRET));
  return { token, grantID };
}

function beginCall(token: string, args: Record<string, unknown>, dispatch: Dispatch) {
  const context = createExecutionContext();
  const response = handleMcp(new Request('http://local/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: { name: 'send_message', arguments: args },
    }),
  }), configured, context, dispatch);
  return { context, response };
}

async function call(token: string, args: Record<string, unknown>, dispatch: Dispatch): Promise<RpcAnswer> {
  const pending = beginCall(token, args, dispatch);
  const response = await pending.response;
  await waitOnExecutionContext(pending.context);
  return response.json<RpcAnswer>();
}

function successfulDispatch(onWrite: () => void): Dispatch {
  return async (request) => {
    onWrite();
    const body = await request.json<{ text: string }>();
    return Response.json({ message: { id: 'message-id', text: body.text } });
  };
}

describe('MCP write idempotency', () => {
  it('lists retry keys for every write tool except start_meeting', async () => {
    const { token } = await bearer();
    const context = createExecutionContext();
    const response = await handleMcp(new Request('http://local/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }), configured, context, async () => new Response());
    await waitOnExecutionContext(context);
    const answer = await response.json<{ result: { tools: Array<{ name: string; inputSchema: { properties?: Record<string, { maxLength?: number }>; oneOf?: Array<{ properties?: Record<string, { maxLength?: number }> }> } }> } }>();
    const writes = answer.result.tools.filter((tool) => [
      'send_message', 'task', 'record_decision', 'ask_decision', 'set_goal', 'create_issue', 'schedule', 'cms', 'docs_write', 'start_meeting',
    ].includes(tool.name));
    expect(writes).toHaveLength(10);
    for (const tool of writes.filter((tool) => tool.name !== 'start_meeting')) {
      const variants = tool.inputSchema.oneOf ?? [tool.inputSchema];
      expect(variants.some((variant) => variant.properties?.idempotency_key?.maxLength === 128), tool.name).toBe(true);
    }
    expect(writes.find((tool) => tool.name === 'start_meeting')?.inputSchema.properties?.idempotency_key).toBeUndefined();
  });

  it('replays the first result for the same explicit key and records the retry', async () => {
    const { token, grantID } = await bearer();
    let writes = 0;
    const dispatch = successfulDispatch(() => { writes += 1; });
    const args = { thread_id: 'thread-id-1', text: 'Hello', idempotency_key: 'one-attempt' };
    const first = await call(token, args, dispatch);
    const second = await call(token, args, dispatch);
    const separate = await call(token, { ...args, idempotency_key: 'separate-write' }, dispatch);

    expect(writes).toBe(2);
    expect(second.result?.structuredContent).toEqual(first.result?.structuredContent);
    expect(second.result?.replayed).toBe(true);
    expect(separate.result?.replayed).toBeUndefined();
    const rows = await configured.USAGE.prepare(
      'SELECT replayed FROM mcp_calls WHERE grant_id = ?1 AND name = \'send_message\' ORDER BY ts DESC LIMIT 3',
    ).bind(grantID).all<{ replayed: number }>();
    expect(rows.results.map((row) => row.replayed)).toEqual([0, 1, 0]);
  });

  it('does not keep an argument refusal under the key, so the fixed retry runs', async () => {
    const { token } = await bearer();
    let writes = 0;
    const dispatch = successfulDispatch(() => { writes += 1; });
    const refused = await call(token, { thread_id: 'thread-id-1', text: 'Hello', description: 'wrong key', idempotency_key: 'fix-and-retry' }, dispatch);
    expect(refused.result?.isError).toBe(true);
    expect(refused.result?.content?.[0]?.text).toContain('invalid_request');
    expect(writes).toBe(0);

    const fixed = await call(token, { thread_id: 'thread-id-1', text: 'Hello', idempotency_key: 'fix-and-retry' }, dispatch);
    expect(fixed.result?.isError).toBe(false);
    expect(fixed.result?.replayed).toBeUndefined();
    expect(writes).toBe(1);

    const replay = await call(token, { thread_id: 'thread-id-1', text: 'Hello', idempotency_key: 'fix-and-retry' }, dispatch);
    expect(replay.result?.replayed).toBe(true);
    expect(writes).toBe(1);
  });

  it('collapses identical derived keys within a window and separates keys after eleven minutes', async () => {
    const args = { text: 'A message', thread_id: 'thread-id-1' };
    const start = 1_800_000_000_000;
    const reordered = { thread_id: 'thread-id-1', text: 'A message' };
    expect(await mcpIdempotencyKey('send_message', 'rosa@example.com', args, start))
      .toBe(await mcpIdempotencyKey('send_message', 'rosa@example.com', reordered, start + 9 * 60 * 1000));
    expect(await mcpIdempotencyKey('send_message', 'rosa@example.com', args, start))
      .not.toBe(await mcpIdempotencyKey('send_message', 'rosa@example.com', args, start + 11 * 60 * 1000));

    const { token } = await bearer();
    let writes = 0;
    const dispatch = successfulDispatch(() => { writes += 1; });
    await call(token, args, dispatch);
    await call(token, args, dispatch);
    expect(writes).toBe(1);
  });

  it('returns in_progress for a concurrent retry, then replays after the first result is stored', async () => {
    const { token } = await bearer();
    let writes = 0;
    let signalStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dispatch: Dispatch = async (request) => {
      writes += 1;
      signalStarted();
      await gate;
      const body = await request.json<{ text: string }>();
      return Response.json({ message: { id: 'message-id', text: body.text } });
    };
    const args = { thread_id: 'thread-id-1', text: 'Hello', idempotency_key: 'concurrent-key' };
    const first = beginCall(token, args, dispatch);
    await started;

    const pending = await call(token, args, dispatch);
    expect(pending.result?.isError).toBe(true);
    expect(pending.result?.content?.[0]?.text).toContain('in_progress');
    expect(pending.result?.content?.[0]?.text).toContain('Retry in a few seconds');
    expect(writes).toBe(1);

    release();
    const firstResponse = await first.response;
    await waitOnExecutionContext(first.context);
    expect((await firstResponse.json<RpcAnswer>()).result?.isError).toBe(false);
    const replay = await call(token, args, dispatch);
    expect(replay.result?.replayed).toBe(true);
    expect(writes).toBe(1);
  });

  it('prunes only idempotency rows older than 24 hours', async () => {
    const now = Date.now();
    const email = `prune-${crypto.randomUUID()}@example.com`;
    await configured.USAGE.batch([
      configured.USAGE.prepare('INSERT INTO mcp_idempotency (key, principal_email, tool, result_json, created_at) VALUES (\'old\', ?1, \'send_message\', NULL, ?2)').bind(email, now - 25 * 60 * 60 * 1000),
      configured.USAGE.prepare('INSERT INTO mcp_idempotency (key, principal_email, tool, result_json, created_at) VALUES (\'new\', ?1, \'send_message\', NULL, ?2)').bind(email, now - 23 * 60 * 60 * 1000),
    ]);
    expect(await pruneMcpIdempotency(configured, now)).toBeGreaterThanOrEqual(1);
    const rows = await configured.USAGE.prepare('SELECT key FROM mcp_idempotency WHERE principal_email = ?1 ORDER BY key').bind(email).all<{ key: string }>();
    expect(rows.results.map((row) => row.key)).toEqual(['new']);
  });
});
