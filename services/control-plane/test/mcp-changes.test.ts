import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeMcpChangeCursor, parseMcpChangeCursor } from '@starlings/contracts/mcp';
import { handleMcp, type Dispatch } from '../src/mcp';
import { signingKey } from '../src/crypto';

const configured = {
  ...env,
  SESSION_SIGNING_SECRET: 'mcp-changes-signing-secret-at-least-32-chars',
  OWNER_ROOM_MAP: JSON.stringify({ 'rosa@example.com': 'rosa' }),
} as Env;

async function bearer(): Promise<{ token: string; clientId: string; grantId: string }> {
  const suffix = crypto.randomUUID();
  const now = Date.now();
  const clientId = `mcp-changes-${suffix}`;
  const grantId = `mcp-changes-${suffix}`;
  await configured.USAGE.prepare(
    `INSERT INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at)
     VALUES (?1, 'Changes test', NULL, '["https://claude.ai/api/mcp/auth_callback"]', ?2)`,
  ).bind(clientId, now).run();
  await configured.USAGE.prepare(
    `INSERT INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at)
     VALUES (?1, ?2, 'dev:rosa@example.com', 'rosa@example.com', 'read', 'jti', NULL, ?3, ?3, NULL, NULL)`,
  ).bind(grantId, clientId, now).run();
  const token = await new SignJWT({
    email: 'rosa@example.com', name: 'Rosa', scope: 'read', grant: grantId, client: clientId,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('starlings.example')
    .setAudience('meet-mcp')
    .setSubject('dev:rosa@example.com')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey(configured.SESSION_SIGNING_SECRET));
  return { token, clientId, grantId };
}

async function read(token: string, uri: string, dispatch: Dispatch) {
  const context = createExecutionContext();
  const response = await handleMcp(new Request('http://local/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } }),
  }), configured, context, dispatch);
  await waitOnExecutionContext(context);
  return response.json<{ result?: { contents: Array<{ text: string }> }; error?: { message: string } }>();
}

describe('MCP changes resource', () => {
  let fixture: Awaited<ReturnType<typeof bearer>> | undefined;
  afterEach(async () => {
    if (!fixture) return;
    await configured.USAGE.prepare('DELETE FROM mcp_grants WHERE id = ?1').bind(fixture.grantId).run();
    await configured.USAGE.prepare('DELETE FROM mcp_clients WHERE client_id = ?1').bind(fixture.clientId).run();
    fixture = undefined;
  });

  it('keeps equal-time rows across the 200-row page boundary', async () => {
    fixture = await bearer();
    const changedAt = Date.parse('2026-09-23T10:00:00.000Z');
    const firstRows = Array.from({ length: 200 }, (_, index) => ({
      id: String(index).padStart(3, '0'),
      changed_at: changedAt,
      change: 'created',
      summary: `Message ${index}`,
      actor: { name: 'Rosa', email: 'rosa@example.com' },
    }));
    const paths: string[] = [];
    const dispatch: Dispatch = async (request) => {
      const url = new URL(request.url);
      paths.push(url.pathname + url.search);
      if (url.pathname === '/api/threads/messages') {
        const cursor = parseMcpChangeCursor(url.searchParams.get('since')!);
        const changes = cursor?.id === null
          ? firstRows.map((row) => ({ ...row, thread_id: 'changes-thread' }))
          : cursor?.id === '199'
            ? [{ ...firstRows[0]!, id: '200', thread_id: 'changes-thread', summary: 'Message 200' }]
            : [];
        return Response.json({ changes, has_more: cursor?.id === null });
      }
      throw new Error(`Unexpected route ${url.pathname}`);
    };

    const initial = '2026-09-23T09:59:00.000Z';
    const first = await read(fixture.token, `starlings://changes/${initial}?kinds=message`, dispatch);
    expect(first.error).toBeUndefined();
    const firstBody = JSON.parse(first.result!.contents[0]!.text) as {
      changes: Array<{ changed_at: string }>;
      next_cursor: string;
      truncated: boolean;
    };
    expect(firstBody.changes).toHaveLength(200);
    expect(firstBody.changes.at(-1)?.changed_at).toBe('2026-09-23T10:00:00.000Z');
    expect(firstBody.truncated).toBe(true);

    const second = await read(fixture.token, `starlings://changes/${firstBody.next_cursor}?kinds=message`, dispatch);
    const secondBody = JSON.parse(second.result!.contents[0]!.text) as {
      changes: Array<{ summary: string }>;
      next_cursor: string;
      truncated: boolean;
    };
    expect(secondBody.changes.map((row) => row.summary)).toEqual(['Message 200']);
    expect(secondBody.truncated).toBe(false);

    const third = await read(fixture.token, `starlings://changes/${secondBody.next_cursor}?kinds=message`, dispatch);
    const thirdBody = JSON.parse(third.result!.contents[0]!.text) as { changes: unknown[] };
    expect(thirdBody.changes).toEqual([]);
    expect(paths.every((path) => !path.includes('/meetings?'))).toBe(true);
  });

  it('reads one finalized meeting through its owner-scoped ledger route', async () => {
    fixture = await bearer();
    const dispatch: Dispatch = async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/rooms/rosa/meetings') {
        return Response.json({
          meetings: [{
            meeting_id: 'meeting-1',
            room_slug: 'rosa',
            host_email: 'rosa@example.com',
            title: 'Planning',
            changed_at: Date.parse('2026-09-23T10:00:00.000Z'),
          }],
          has_more: false,
        });
      }
      throw new Error(`Unexpected route ${url.pathname}`);
    };
    const result = await read(
      fixture.token,
      'starlings://changes/2026-09-23T09:59:00.000Z?kinds=meeting',
      dispatch,
    );
    expect(result.error).toBeUndefined();
    const body = JSON.parse(result.result!.contents[0]!.text) as {
      changes: Array<{ kind: string; change: string; door: string; summary: string }>;
      truncated: boolean;
    };
    expect(body.changes).toEqual([{
      kind: 'meeting',
      door: 'starlings://meeting/rosa/meeting-1',
      changed_at: '2026-09-23T10:00:00.000Z',
      change: 'finalized',
      summary: 'Planning',
      actor: { name: null, email: 'rosa@example.com' },
    }]);
    expect(body.truncated).toBe(false);
  });
});
