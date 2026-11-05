// A shut-down workspace (meet#834): every request but health answers
// "closed", pages get one line, and removing the row opens it again.
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { WORKSPACE_SHUTDOWN_KEY, isWorkspaceClosed, resetWorkspaceLifecycleCache } from '../src/workspace-lifecycle';

const db = (env as Env).USAGE;

async function shutDown(): Promise<void> {
  await db.prepare(`INSERT INTO workspace_settings (key, value, updated_by, updated_at) VALUES (?1, '2026-10-18T12:00:00.000Z', 'retire-workspace', 1)
    ON CONFLICT(key) DO NOTHING`).bind(WORKSPACE_SHUTDOWN_KEY).run();
  resetWorkspaceLifecycleCache();
}

afterEach(async () => {
  await db.prepare('DELETE FROM workspace_settings WHERE key = ?1').bind(WORKSPACE_SHUTDOWN_KEY).run();
  resetWorkspaceLifecycleCache();
});

describe('a shut-down workspace', () => {
  it('answers closed on the API and on pages, and keeps health open', async () => {
    await shutDown();
    const api = await exports.default.fetch(new Request('http://local/api/threads'));
    expect(api.status).toBe(503);
    expect(await api.json()).toMatchObject({ code: 'workspace_closed', error: 'This workspace is closed.' });

    const page = await exports.default.fetch(new Request('http://local/work'));
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('This workspace is closed.');

    const descriptor = await exports.default.fetch(new Request('http://local/.well-known/meet'));
    expect(descriptor.status).toBe(503);

    const health = await exports.default.fetch(new Request('http://local/api/health'));
    expect(health.status).toBe(200);
  });

  it('opens again when the row goes', async () => {
    await shutDown();
    expect(await isWorkspaceClosed(env as Env)).toBe(true);
    await db.prepare('DELETE FROM workspace_settings WHERE key = ?1').bind(WORKSPACE_SHUTDOWN_KEY).run();
    resetWorkspaceLifecycleCache();
    expect(await isWorkspaceClosed(env as Env)).toBe(false);
    expect((await exports.default.fetch(new Request('http://local/api/health'))).status).toBe(200);
  });

  it('trusts one read for 30 seconds per isolate', async () => {
    const at = 1_000_000;
    expect(await isWorkspaceClosed(env as Env, at)).toBe(false);
    await db.prepare(`INSERT INTO workspace_settings (key, value, updated_by, updated_at) VALUES (?1, 'x', 'test', 1)`).bind(WORKSPACE_SHUTDOWN_KEY).run();
    expect(await isWorkspaceClosed(env as Env, at + 29_000)).toBe(false);
    expect(await isWorkspaceClosed(env as Env, at + 31_000)).toBe(true);
  });
});
