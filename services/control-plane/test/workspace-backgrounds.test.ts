import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { backgroundTonesFromAccent, ENVISIONING_BACKGROUND_TONES } from '@starlings/contracts/background-gallery';
import { workspaceBackgroundAdminResponseSchema, workspaceBackgroundTonesSchema, type WorkspaceBackgroundAdminResponse } from '@starlings/contracts/workspace-backgrounds';
import { resetWorkspaceProfileCache } from '../src/workspace-profile';
import { backgroundImageSize } from '../src/background-image';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
async function session(email = 'rosa@example.com') {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Test', email }) }));
  const { access_token } = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${access_token}`, origin: env.WEB_ORIGIN };
}
async function call(path = '', init: RequestInit = {}, email?: string) {
  return exports.default.fetch(new Request(`http://local/api/admin/workspace/backgrounds${path}`, { ...init, headers: { ...await session(email), ...init.headers } }));
}
async function read() { return workspaceBackgroundAdminResponseSchema.parse(await (await call()).json()); }
async function save(value: unknown) { return call('', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }); }
async function upload(bytes = PNG) { return call('/image', { method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes }); }
afterEach(async () => {
  await env.USAGE.prepare("DELETE FROM workspace_settings WHERE key IN ('backgrounds', 'brand')").run();
  await env.DOWNLOADS?.delete('workspace/background');
  await env.USAGE.prepare("DELETE FROM people WHERE email = 'ada@example.com'").run();
  resetWorkspaceProfileCache();
});
describe('workspace backgrounds', () => {
  it('pins Envisioning, derives from a saved accent, then accepts explicit tones and a gallery default', async () => {
    expect((await read()).resolved.tones).toEqual(workspaceBackgroundTonesSchema.parse(ENVISIONING_BACKGROUND_TONES));
    await env.USAGE.prepare("INSERT INTO workspace_settings (key, value, updated_by, updated_at) VALUES ('brand', ?1, 'test-admin', ?2)").bind(JSON.stringify({ name: 'HQ', accent: '#2563eb', mark: null }), Date.now()).run();
    resetWorkspaceProfileCache();
    expect((await read()).resolved.tones).toEqual(workspaceBackgroundTonesSchema.parse(backgroundTonesFromAccent('#2563eb')));
    const tones = workspaceBackgroundTonesSchema.parse(backgroundTonesFromAccent('#e85d04'));
    const chosen = { mode: 'generated', generator: 'flock', tone: 'bright' };
    expect((await save({ tones, default: chosen })).status).toBe(200);
    const descriptor = await (await exports.default.fetch(new Request('http://local/.well-known/meet'))).json<{ brand: { backgrounds: unknown } }>();
    expect(descriptor.brand.backgrounds).toMatchObject({ tones, default: chosen });
  });
  it('refuses invisible colours and an image default without an upload', async () => {
    expect((await save({ tones: { ...ENVISIONING_BACKGROUND_TONES, dark: { base: '#000000', modules: '#000000' } }, default: null })).status).toBe(400);
    expect((await save({ tones: null, default: { mode: 'image' } })).status).toBe(400);
  });
  it('is for admins only, reads and writes, and refuses anonymous reads', async () => {
    expect((await call('', {}, 'ada@example.com')).status).toBe(403);
    for (const [path, method, body] of [['', 'PUT', JSON.stringify({ tones: null, default: null })], ['/image', 'PUT', PNG], ['/image', 'DELETE', undefined]] as const) {
      expect((await call(path, { method, body: body ?? null, headers: { 'content-type': 'application/json' } }, 'ada@example.com')).status).toBe(403);
    }
    expect((await exports.default.fetch(new Request('http://local/api/admin/workspace/backgrounds'))).status).toBe(401);
  });
  it('serves the uploaded picture publicly by version, replaces it and clears an image default on removal', async () => {
    const uploaded = await upload();
    expect(uploaded.status).toBe(200);
    const first = await uploaded.json<WorkspaceBackgroundAdminResponse>();
    expect(first.resolved.image_url).toContain('/workspace-background?v=');
    const response = await exports.default.fetch(new Request(first.resolved.image_url!));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    const head = await exports.default.fetch(new Request(first.resolved.image_url!, { method: 'HEAD' }));
    expect(await head.text()).toBe('');
    expect((await save({ tones: null, default: { mode: 'image' } })).status).toBe(200);
    const other = PNG.slice(); other[29] = other[29]! ^ 1;
    const replaced = await (await upload(other)).json<WorkspaceBackgroundAdminResponse>();
    expect(replaced.settings.default).toEqual({ mode: 'image' });
    expect(replaced.resolved.image_url).not.toBe(first.resolved.image_url);
    expect((await exports.default.fetch(new Request(first.resolved.image_url!))).status).toBe(404);
    const removed = await (await call('/image', { method: 'DELETE' })).json<WorkspaceBackgroundAdminResponse>();
    expect(removed.settings).toEqual({ tones: null, image: null, default: null });
    expect((await exports.default.fetch(new Request(replaced.resolved.image_url!))).status).toBe(404);
  });
  it('refuses active, truncated, oversize and dimensionally excessive pictures before R2', async () => {
    for (const bytes of [new TextEncoder().encode('<svg onload="x()"/>'), PNG.slice(0, 24), new Uint8Array(12 * 1024 * 1024 + 1)]) {
      expect((await upload(bytes)).status).toBeGreaterThanOrEqual(400);
    }
    const large = PNG.slice(); new DataView(large.buffer).setUint32(16, 1281);
    expect((await upload(large)).status).toBe(400);
    expect((await read()).settings.image).toBeNull();
  });
  it('reads raster dimensions from bytes rather than a submitted MIME type', () => {
    expect(backgroundImageSize(PNG)).toEqual({ type: 'image/png', width: 1, height: 1 });
    const jpeg = new Uint8Array([255,216,255,192,0,8,8,0,100,0,200,1,255,217]);
    expect(backgroundImageSize(jpeg)).toEqual({ type: 'image/jpeg', width: 200, height: 100 });
    const webp = new Uint8Array(30); const view = new DataView(webp.buffer);
    webp.set(new TextEncoder().encode('RIFF')); view.setUint32(4,22,true); webp.set(new TextEncoder().encode('WEBPVP8X'),8); view.setUint32(16,10,true); webp[24] = 199; webp[27] = 99;
    expect(backgroundImageSize(webp)).toEqual({ type: 'image/webp', width: 200, height: 100 });
  });
});
