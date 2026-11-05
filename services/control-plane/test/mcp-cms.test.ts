import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { signingKey } from '../src/crypto';
import { resetCorePatCache } from '../src/crm';

/**
 * The folded `cms` tool (docs/MCP.md, tool surface).
 * Core is a mock: the owner exchange, which must be asked for the
 * `cms-editor` preset, and `/api/agent/cms/*`, which must carry that PAT.
 */

const eventID = '585d3599-c813-4b98-a741-01a79b6736a1';
const configured = {
  ...env,
  CRM_SYNC_MODE: 'on',
  CORE_API_BASE_URL: 'https://core.test',
  INTERNAL_REQUEST_SECRET: 'a-shared-test-secret-with-at-least-32-characters',
  SESSION_SIGNING_SECRET: 'mcp-cms-signing-secret-with-32-characters',
} as Env;

beforeEach(() => resetCorePatCache());
afterEach(() => vi.restoreAllMocks());

async function bearer(scope: string): Promise<string> {
  const now = Date.now();
  await configured.USAGE.prepare(
    `INSERT OR REPLACE INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at) VALUES (?1, ?2, NULL, '["https://claude.ai/api/mcp/auth_callback"]', ?3)`,
  ).bind('client-cms', 'claude.ai', now).run();
  await configured.USAGE.prepare(
    `INSERT OR REPLACE INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at)
     VALUES (?1, 'client-cms', ?2, ?3, ?4, 'jti', NULL, ?5, ?5, NULL, NULL)`,
  ).bind('grant-cms', 'dev:rosa@example.com', 'rosa@example.com', scope, now).run();
  return new SignJWT({ email: 'rosa@example.com', name: 'Rosa', scope, grant: 'grant-cms', client: 'client-cms' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('starlings.example')
    .setAudience('meet-mcp')
    .setSubject('dev:rosa@example.com')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey(configured.SESSION_SIGNING_SECRET));
}

async function rpc(token: string, method: string, params?: unknown) {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request('http://local/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params !== undefined ? { params } : {}) }),
  }), configured, context);
  await waitOnExecutionContext(context);
  return response.json<{ result?: { isError?: boolean; content?: Array<{ text?: string }>; tools?: Array<{ name: string }> }; error?: { message: string } }>();
}

function callTool(token: string, name: string, args: Record<string, unknown>) {
  return rpc(token, 'tools/call', { name, arguments: args });
}

interface Seen {
  exchanges: Array<Record<string, unknown>>;
  agent: Array<{ method: string; path: string; search: string; bearer: string | null; body: Record<string, unknown> | null }>;
}

/** Core, as far as the tools reach it: the owner exchange and /api/agent/cms/*. */
function mockCore(answer: (call: Seen['agent'][number]) => Response): Seen {
  const seen: Seen = { exchanges: [], agent: [] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/api/public/meet-owner-exchange') {
      const body = await request.json<Record<string, unknown>>();
      seen.exchanges.push(body);
      const preset = body.preset === 'cms-editor' ? 'cms-editor' : 'sales-assistant';
      return Response.json({
        ok: true,
        token: `pat-${preset}`,
        scopes: preset === 'cms-editor' ? ['cms:read', 'cms:write'] : ['cms:read'],
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        email: 'rosa@example.com',
      });
    }
    if (url.pathname.startsWith('/api/agent/cms/')) {
      const call = {
        method: request.method,
        path: url.pathname,
        search: url.search,
        bearer: request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? null,
        body: request.method === 'GET' ? null : await request.json<Record<string, unknown>>(),
      };
      seen.agent.push(call);
      return answer(call);
    }
    return Response.json({ error: `unmocked ${request.method} ${url.pathname}` }, { status: 500 });
  });
  return seen;
}

describe('cms tools', () => {
  it('lists cms in both scopes', async () => {
    const names = async (token: string) => (await rpc(token, 'tools/list')).result!.tools!.map((tool) => tool.name);
    const read = await names(await bearer('read'));
    const write = await names(await bearer('read write'));
    expect(read).toContain('cms');
    expect(write).toContain('cms');
    expect(write).toHaveLength(14);
  });

  it('creates an event through Core as the member with a cms-editor PAT', async () => {
    const seen = mockCore((call) => Response.json({ data: { id: eventID, title: 'E3 / Sabiá — Signals workshop', ...call.body } }, { status: 201 }));
    const body = { title: 'E3 / Sabiá — Signals workshop', event_date: '2026-10-15', start_time: '09:00', timezone: 'America/Sao_Paulo', is_published: false };
    const answer = await callTool(await bearer('read write'), 'cms', { entity: 'events', body });
    expect(answer.error).toBeUndefined();
    expect(answer.result?.isError).toBeFalsy();

    expect(seen.exchanges).toEqual([
      expect.objectContaining({ email: 'rosa@example.com', device_name: 'CMS (Worker)', preset: 'cms-editor' }),
    ]);
    expect(seen.agent).toEqual([
      expect.objectContaining({ method: 'POST', path: '/api/agent/cms/events', bearer: 'pat-cms-editor', body }),
    ]);
    const text = answer.result?.content?.[0]?.text ?? '';
    expect(JSON.parse(text)).toMatchObject({ data: { id: eventID } });
  });

  it('updates by id with PATCH and reuses the cached PAT', async () => {
    const seen = mockCore((call) => Response.json({ data: { id: eventID, title: 'E3', ...call.body } }));
    const token = await bearer('read write');
    await callTool(token, 'cms', { entity: 'events', id: eventID, body: { is_published: true } });
    await callTool(token, 'cms', { entity: 'events', id: eventID, body: { place: 'Campinas' } });
    expect(seen.exchanges).toHaveLength(1);
    expect(seen.agent.map((call) => [call.method, call.path, call.body])).toEqual([
      ['PATCH', `/api/agent/cms/events/${eventID}`, { is_published: true }],
      ['PATCH', `/api/agent/cms/events/${eventID}`, { place: 'Campinas' }],
    ]);
    const row = await configured.USAGE.prepare(
      `SELECT name FROM mcp_calls WHERE name = 'cms' ORDER BY ts DESC LIMIT 1`,
    ).first<{ name: string }>();
    expect(row?.name).toBe('cms');
  });

  it('reads a list with a filter and a record by id, with the read scope only', async () => {
    const seen = mockCore(() => Response.json({ data: [], meta: { count: 0, limit: 25, offset: 0 } }));
    const token = await bearer('read');
    const list = await callTool(token, 'cms', { entity: 'technologies', filter: { research_id: eventID }, q: 'quantum', limit: 5 });
    expect(list.result?.isError).toBeFalsy();
    await callTool(token, 'cms', { entity: 'events', id: eventID });
    expect(seen.agent.map((call) => `${call.method} ${call.path}${call.search}`)).toEqual([
      `GET /api/agent/cms/technologies?q=quantum&limit=5&research_id=${eventID}`,
      `GET /api/agent/cms/events/${eventID}`,
    ]);
  });

  it('passes Core\'s validation reason back to the caller', async () => {
    mockCore(() => Response.json({ error: 'Validation error', details: { _errors: [], venue: { _errors: ["Unrecognized key(s) in object: 'venue'"] } } }, { status: 400 }));
    const answer = await callTool(await bearer('read write'), 'cms', { entity: 'events', body: { title: 'x', venue: 'y' } });
    expect(answer.result?.isError).toBe(true);
    expect(answer.result?.content?.[0]?.text).toContain('venue');
  });

  it('refuses cms writes on a read grant, and never reaches Core', async () => {
    const seen = mockCore(() => Response.json({}));
    const token = await bearer('read');
    const answer = await callTool(token, 'cms', { entity: 'events', body: { title: 'x' } });
    expect(answer.result?.isError ?? answer.error !== undefined).toBe(true);
    expect(seen.agent).toHaveLength(0);
  });

  it('serves the registry as a resource', async () => {
    const seen = mockCore(() => Response.json({ data: { space: 'cms', entities: [] } }));
    const answer = await rpc(await bearer('read'), 'resources/read', { uri: 'starlings://cms/registry' });
    expect(answer.error).toBeUndefined();
    expect(seen.agent.map((call) => call.path)).toEqual(['/api/agent/cms/meta/registry']);
  });
});

describe('technology images and draft searches', () => {
  it('forwards publication filters and technology image requests through the member CMS grant', async () => {
    const seen = mockCore(() => Response.json({ data: { id: eventID, published: false }, saved: true, image_url: 'https://images.test/x.png', cost_usd: 0.04 }));
    const token = await bearer('read write');
    await callTool(token, 'cms', { entity: 'technologies', filter: { research_id: eventID, publication: 'all' } });
    const image = { request_id: '596dd1bb-0fd5-4aec-af57-1d3fd0f07c63' };
    const answer = await callTool(token, 'cms', { entity: 'technologies', id: eventID, image, idempotency_key: 'technology-image-1' });
    expect(answer.result?.isError).toBeFalsy();
    expect(seen.agent[0]?.search).toContain('publication=all');
    expect(seen.agent[1]).toMatchObject({ method: 'POST', path: `/api/agent/cms/technologies/${eventID}/image`, body: image, bearer: 'pat-cms-editor' });
    const denied = await callTool(await bearer('read'), 'cms', { entity: 'technologies', id: eventID, image });
    expect(denied.result?.isError).toBe(true);
  });
  it('rejects event-shaped technology images and technology-shaped event images', async () => {
    const seen = mockCore(() => Response.json({ data: {} }));
    const token = await bearer('read write');
    const a = await callTool(token, 'cms', { entity: 'technologies', id: eventID, image: { look: 'appearance', scene: 'urban' } });
    const b = await callTool(token, 'cms', { entity: 'events', id: eventID, image: { request_id: '596dd1bb-0fd5-4aec-af57-1d3fd0f07c63' } });
    expect(a.result?.isError).toBe(true); expect(b.result?.isError).toBe(true);
    expect(seen.agent).toHaveLength(0);
  });
});
