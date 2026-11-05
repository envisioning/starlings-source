import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetRoleCache } from '../src/capabilities';
import { signingKey } from '../src/crypto';
import { handleMcp, type Dispatch } from '../src/mcp';

/**
 * `/mcp` admits a person who joined by invitation (meet#1159): the same
 * member gate as every internal route, not the identity domains alone.
 */

const configured = {
  ...env,
  SESSION_SIGNING_SECRET: 'mcp-invited-member-signing-secret-32ch',
} as Env;

type RpcAnswer = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: { code: number; message: string } };

async function seedPerson(email: string, options: { invited?: boolean; revoked?: boolean } = {}): Promise<string> {
  const sub = `mcp-invited-${crypto.randomUUID()}`;
  const now = Date.now();
  await configured.USAGE.prepare(
    `INSERT INTO people (sub, email, name, first_seen_at, last_seen_at, revoked_at) VALUES (?1, ?2, 'Ana', ?3, ?3, ?4)`,
  ).bind(sub, email, now, options.revoked ? now : null).run();
  if (options.invited) {
    await configured.USAGE.prepare(
      `INSERT INTO invitations (id, email, role, invited_by, created_at, expires_at, accepted_at)
       VALUES (?1, ?2, 'member', 'rosa@example.com', ?3, ?4, ?3)`,
    ).bind(crypto.randomUUID(), email, now, now + 86_400_000).run();
  }
  return sub;
}

/** A paired Claude: a client, a live grant and an access token for `email`. */
async function pair(sub: string, email: string): Promise<string> {
  const suffix = crypto.randomUUID();
  const now = Date.now();
  const clientID = `mcp-invited-${suffix}`;
  const grantID = `mcp-invited-${suffix}`;
  await configured.USAGE.prepare(
    `INSERT INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at)
     VALUES (?1, 'Invited test', NULL, '["https://claude.ai/api/mcp/auth_callback"]', ?2)`,
  ).bind(clientID, now).run();
  await configured.USAGE.prepare(
    `INSERT INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, 'read write', 'jti', NULL, ?5, ?5, NULL, NULL)`,
  ).bind(grantID, clientID, sub, email, now).run();
  return new SignJWT({ email, name: 'Ana', scope: 'read write', grant: grantID, client: clientID })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('starlings.example')
    .setAudience('meet-mcp')
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey(configured.SESSION_SIGNING_SECRET));
}

const dispatch: Dispatch = async (request) => {
  const body = await request.json<{ text: string }>();
  return Response.json({ message: { id: 'message-id', text: body.text } });
};

async function sendMessage(token: string): Promise<{ status: number; answer: RpcAnswer | null }> {
  const context = createExecutionContext();
  const response = await handleMcp(new Request('http://local/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'send_message', arguments: { thread_id: 'thread-id-1', text: 'hello', idempotency_key: crypto.randomUUID() } },
    }),
  }), configured, context, dispatch);
  await waitOnExecutionContext(context);
  return { status: response.status, answer: response.status === 200 ? await response.json<RpcAnswer>() : null };
}

describe('/mcp and invited members (meet#1159)', () => {
  beforeEach(() => resetRoleCache());

  it('admits an invited address outside the sign-in domains and runs a tool', async () => {
    const email = `ana-${crypto.randomUUID()}@example.net`;
    const sub = await seedPerson(email, { invited: true });
    const { status, answer } = await sendMessage(await pair(sub, email));
    expect(status).toBe(200);
    expect(answer?.error).toBeUndefined();
    expect(answer?.result?.isError).toBeFalsy();
  });

  it('refuses an invited address whose person was revoked', async () => {
    const email = `revoked-${crypto.randomUUID()}@example.net`;
    const sub = await seedPerson(email, { invited: true, revoked: true });
    expect((await sendMessage(await pair(sub, email))).status).toBe(401);
  });

  it('refuses an outside address with no accepted invitation', async () => {
    const email = `stranger-${crypto.randomUUID()}@example.net`;
    const sub = await seedPerson(email);
    expect((await sendMessage(await pair(sub, email))).status).toBe(401);
  });

  it('admits a domain member as before', async () => {
    const email = `bo-${crypto.randomUUID()}@example.com`;
    const sub = await seedPerson(email);
    const { status, answer } = await sendMessage(await pair(sub, email));
    expect(status).toBe(200);
    expect(answer?.error).toBeUndefined();
    expect(answer?.result?.isError).toBeFalsy();
  });
});
