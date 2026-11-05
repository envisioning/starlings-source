import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { workspaceBrandAdminResponseSchema, type WorkspaceBrandAdminResponse } from '@starlings/contracts/workspace-profile';
import { workspaceDescriptorSchema } from '@starlings/contracts/workspace-descriptor';
import { markType, resetWorkspaceProfileCache } from '../src/workspace-profile';

// meet#861: the workspace's name, accent and mark are settings an admin edits.

async function session(email: string, name: string) {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email }),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}`, origin: env.WEB_ORIGIN };
}

const admin = () => session('rosa@example.com', 'Rosa');

async function call(path: string, headers: Record<string, string>, init: RequestInit = {}) {
  return exports.default.fetch(new Request(`http://local${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } }));
}

async function descriptor() {
  return workspaceDescriptorSchema.parse(await (await exports.default.fetch(new Request('http://local/.well-known/meet'))).json());
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

afterEach(async () => {
  await env.USAGE.prepare("DELETE FROM workspace_settings WHERE key = 'brand'").run();
  await env.DOWNLOADS?.delete('workspace/mark');
  resetWorkspaceProfileCache();
});

describe('workspace profile', () => {
  it('answers the deployed name before anything is saved', async () => {
    const response = await call('/api/admin/workspace', await admin());
    expect(response.status).toBe(200);
    // Envisioning names itself through WORKSPACE_NAME, like every workspace (meet#934).
    expect(workspaceBrandAdminResponseSchema.parse(await response.json())).toEqual({
      name: 'Envisioning', accent: null, mark_url: null, source: 'deployment', updated_at: null,
    });
  });

  it('saves a name and an accent that the descriptor serves at once, and audits it', async () => {
    const headers = await admin();
    const saved = await call('/api/admin/workspace', headers, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '  Acme  ', accent: '#2563EB' }),
    });
    expect(saved.status).toBe(200);
    const body = await saved.json<WorkspaceBrandAdminResponse>();
    expect(body).toMatchObject({ name: 'Acme', accent: '#2563eb', source: 'settings' });
    expect(body.updated_at).toEqual(expect.any(Number));
    expect(await descriptor()).toMatchObject({ name: 'Acme', brand: { accent: '#2563eb' } });

    const audit = await env.USAGE.prepare("SELECT detail FROM admin_audit WHERE action = 'workspace.brand' ORDER BY ts DESC LIMIT 1").first<{ detail: string }>();
    expect(audit?.detail).toContain('Acme');
  });

  it('lets a saved row clear the accent, and a cleared name falls back to the deployed one', async () => {
    const headers = await admin();
    await call('/api/admin/workspace', headers, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: null, accent: null }),
    });
    const { workspaceAccent, workspaceName } = await import('../src/workspace-profile');
    const deployed = { ...env, WORKSPACE_NAME: 'From the deploy', WORKSPACE_ACCENT: '#3355aa' } as Env;
    expect(await workspaceName(deployed)).toBe('From the deploy');
    expect(await workspaceAccent(deployed)).toBeNull();
  });

  it('refuses an accent text cannot be read on', async () => {
    const response = await call('/api/admin/workspace', await admin(), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Acme', accent: '#808080' }),
    });
    expect(response.status).toBe(400);
    expect((await call('/api/admin/workspace', await admin()).then((r) => r.json<WorkspaceBrandAdminResponse>())).source).toBe('deployment');
  });

  it('refuses a member who is not an admin', async () => {
    const response = await call('/api/admin/workspace', await session('ada@example.com', 'Ada'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Mine now', accent: null }),
    });
    expect(response.status).toBe(403);
    await env.USAGE.prepare("DELETE FROM people WHERE email = 'ada@example.com'").run();
  });

  it('uploads a PNG mark, serves it, and removes it', async () => {
    const headers = await admin();
    const uploaded = await call('/api/admin/workspace/mark', headers, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: PNG });
    expect(uploaded.status).toBe(200);
    const body = await uploaded.json<WorkspaceBrandAdminResponse>();
    expect(body.mark_url).toMatch(/^\/workspace-mark\?v=/u);
    expect((await descriptor()).brand.mark_url).toContain('/workspace-mark?v=');
    const served = await exports.default.fetch(new Request(`http://local${body.mark_url}`));
    expect(served.headers.get('content-type')).toBe('image/png');

    const removed = await call('/api/admin/workspace/mark', headers, { method: 'DELETE' });
    expect((await removed.json<WorkspaceBrandAdminResponse>()).mark_url).toBeNull();
  });

  it('refuses a mark that is neither a PNG nor a clean SVG', async () => {
    const response = await call('/api/admin/workspace/mark', await admin(), {
      method: 'PUT',
      headers: { 'content-type': 'image/svg+xml' },
      body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    });
    expect(response.status).toBe(400);
  });

  it('tells a mark by its bytes', () => {
    const svg = (text: string) => markType(new TextEncoder().encode(text));
    expect(markType(PNG)).toBe('image/png');
    expect(svg('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>')).toBe('image/svg+xml');
    expect(svg('<svg onload="x()"></svg>')).toBeNull();
    expect(svg('<svg><foreignObject/></svg>')).toBeNull();
    expect(svg('<html><svg></svg></html>')).toBeNull();
    expect(markType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
  });
});
