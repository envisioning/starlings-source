import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { DiagnosticsListResponse } from '@starlings/contracts';
import { pruneDiagnostics } from '../src/diagnostics';

/** Crash and hang reports from the Apple clients (meet#320). */

async function session(email: string) {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Ada', email }),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json' };
}

function post(headers: Record<string, string>, body: unknown) {
  return exports.default.fetch(new Request('http://local/api/diagnostics', { method: 'POST', headers, body: JSON.stringify(body) }));
}

const report = { platform: 'macos', app_version: '4.4.1', kind: 'crash', payload_json: '{"crashDiagnostics":[]}' };

describe('diagnostics', () => {
  it('stores a device report and lets an admin read it', async () => {
    const created = await post(await session('diag-member@example.com'), report);
    expect(created.status).toBe(201);
    const { id } = await created.json<{ id: string }>();

    const admin = await session('rosa@example.com');
    const list = await (await exports.default.fetch(new Request('http://local/api/admin/diagnostics', { headers: admin }))).json<DiagnosticsListResponse>();
    expect(list.reports.find((row) => row.id === id)).toMatchObject({ email: 'diag-member@example.com', kind: 'crash', platform: 'macos' });

    const payload = await exports.default.fetch(new Request(`http://local/api/admin/diagnostics/${id}`, { headers: admin }));
    expect(await payload.text()).toBe(report.payload_json);
  });

  it('keeps reports from members away from members', async () => {
    const member = await session('diag-member@example.com');
    const response = await exports.default.fetch(new Request('http://local/api/admin/diagnostics', { headers: member }));
    expect(response.status).toBe(403);
  });

  it('refuses a payload over the cap and a kind it does not know', async () => {
    const member = await session('diag-member@example.com');
    expect((await post(member, { ...report, payload_json: 'x'.repeat(64 * 1024 + 1) })).status).toBe(400);
    expect((await post(member, { ...report, kind: 'screenshot' })).status).toBe(400);
  });

  it('prunes reports older than 30 days', async () => {
    const now = Date.now();
    await env.USAGE.prepare(
      `INSERT INTO diagnostics (id, ts, sub, email, platform, app_version, kind, payload) VALUES ('old-report', ?1, 's', 'e', 'ios', '1', 'hang', '{}')`,
    ).bind(now - 31 * 24 * 60 * 60 * 1000).run();
    await pruneDiagnostics(env, now);
    expect(await env.USAGE.prepare(`SELECT id FROM diagnostics WHERE id = 'old-report'`).first()).toBeNull();
  });
});
