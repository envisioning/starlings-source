/**
 * The capability registry names the MCP doors an agent has into each
 * capability (docs/DOCUMENTATION.md, meet#267). Every name it uses must be a
 * tool `tools/list` answers with, or a resource template the server lists,
 * so the registry cannot promise a door that is not there.
 */
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { agentReachable } from '@starlings/contracts/capabilities';
import worker from '../src/index';
import { signingKey } from '../src/crypto';

const configured = {
  ...env,
  SESSION_SIGNING_SECRET: 'mcp-capabilities-signing-secret-32-chars',
} as Env;

async function bearer(): Promise<string> {
  const now = Date.now();
  await configured.USAGE.prepare(
    `INSERT OR REPLACE INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at) VALUES (?1, ?2, NULL, '["https://claude.ai/api/mcp/auth_callback"]', ?3)`,
  ).bind('client-caps', 'claude.ai', now).run();
  await configured.USAGE.prepare(
    `INSERT OR REPLACE INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at)
     VALUES (?1, 'client-caps', ?2, ?3, ?4, 'jti', NULL, ?5, ?5, NULL, NULL)`,
  ).bind('grant-caps', 'dev:rosa@example.com', 'rosa@example.com', 'read write', now).run();
  return new SignJWT({ email: 'rosa@example.com', name: 'Rosa', scope: 'read write', grant: 'grant-caps', client: 'client-caps' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('starlings.example')
    .setAudience('meet-mcp')
    .setSubject('dev:rosa@example.com')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey(configured.SESSION_SIGNING_SECRET));
}

async function rpc<T>(token: string, method: string): Promise<T> {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request('http://local/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
  }), configured, context);
  await waitOnExecutionContext(context);
  const body = await response.json<{ result?: T }>();
  return body.result!;
}

describe('start_meeting', () => {
  it('schedules in the member\'s own room and leaves an ask their devices will read', async () => {
    const token = await bearer();
    const { tools } = await rpc<{ tools: Array<{ name: string }> }>(token, 'tools/list');
    expect(tools.map((tool) => tool.name)).toContain('start_meeting');
  });

  it('gives every tool an object input schema, as the MCP spec requires', async () => {
    // Claude tolerated a bare `oneOf`; the Python MCP SDK (Hermes) refuses
    // the whole tools/list over one schema without `type: "object"`.
    const token = await bearer();
    const { tools } = await rpc<{ tools: Array<{ name: string; inputSchema: { type?: string } }> }>(token, 'tools/list');
    for (const tool of tools) expect(tool.inputSchema.type, `tool ${tool.name}`).toBe('object');
  });
});

describe('capability registry doors', () => {
  it('has a registry row for every tool and resource the server lists', async () => {
    // The other direction: a new door with no row is a capability the help
    // and llms.txt cannot see. Add the tool to a row's `agent.mcpTools`.
    const token = await bearer();
    const { tools } = await rpc<{ tools: Array<{ name: string }> }>(token, 'tools/list');
    const { resourceTemplates } = await rpc<{ resourceTemplates: Array<{ uriTemplate: string }> }>(token, 'resources/templates/list');
    const named = new Set(agentReachable().flatMap((row) => [...(row.agent?.mcpTools ?? []), ...(row.agent?.mcpResources ?? [])]));
    for (const tool of tools) expect(named, `tool ${tool.name} has no capability row`).toContain(tool.name);
    for (const template of resourceTemplates) expect(named, `resource ${template.uriTemplate} has no capability row`).toContain(template.uriTemplate);
  });


  it('ends every documented tool description with its help pages', async () => {
    const token = await bearer();
    const { tools } = await rpc<{ tools: Array<{ name: string; description: string }> }>(token, 'tools/list');
    const documented = new Set(agentReachable().flatMap((row) => row.agent?.mcpTools ?? []));
    for (const tool of tools) {
      if (!documented.has(tool.name)) continue;
      expect(tool.description, tool.name).toMatch(/ Docs: \S+\/help\/\S+/u);
    }
    // One concrete door: search reaches Work, whose page is the surface reference.
    const search = tools.find((tool) => tool.name === 'search')!;
    expect(search.description).toContain('/help/surfaces/work');
  });

  it('names only tools and resources the MCP server lists', async () => {
    const token = await bearer();
    const { tools } = await rpc<{ tools: Array<{ name: string }> }>(token, 'tools/list');
    const { resourceTemplates } = await rpc<{ resourceTemplates: Array<{ uriTemplate: string }> }>(token, 'resources/templates/list');
    const toolNames = new Set(tools.map((tool) => tool.name));
    const templates = new Set(resourceTemplates.map((template) => template.uriTemplate));
    for (const row of agentReachable()) {
      for (const name of row.agent?.mcpTools ?? []) expect(toolNames, `${row.id} names tool ${name}`).toContain(name);
      for (const uri of row.agent?.mcpResources ?? []) expect(templates, `${row.id} names resource ${uri}`).toContain(uri);
    }
  });
});
