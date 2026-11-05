import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { pruneAdminAudit } from '../src/admin-audit';
import { pruneUsageEvents } from '../src/ledger';

// Retention decided 2026-10-01 (meet#603): audit 2 years, usage events 13 months.
const DAY = 24 * 60 * 60 * 1000;

describe('daily retention', () => {
  it('drops audit rows older than 2 years and keeps the rest', async () => {
    const insert = (ts: number, action: string) => env.USAGE.prepare(
      "INSERT INTO admin_audit (ts, actor_sub, actor_email, action, subject, detail) VALUES (?1, 's', 'a@example.com', ?2, NULL, NULL)",
    ).bind(ts, action).run();
    await insert(Date.now() - 800 * DAY, 'test.retention.old');
    await insert(Date.now() - 700 * DAY, 'test.retention.recent');
    await pruneAdminAudit(env as Env);
    const { results } = await env.USAGE.prepare(
      "SELECT action FROM admin_audit WHERE action LIKE 'test.retention.%'",
    ).all<{ action: string }>();
    expect(results.map((row) => row.action)).toEqual(['test.retention.recent']);
  });

  it('drops usage events older than 13 months and keeps the rest', async () => {
    const insert = (ts: number, meeting: string) => env.USAGE.prepare(
      "INSERT INTO usage_events (ts, kind, meeting_id) VALUES (?1, 'meeting_start', ?2)",
    ).bind(ts, meeting).run();
    await insert(Date.now() - 420 * DAY, 'retention-old');
    await insert(Date.now() - 360 * DAY, 'retention-recent');
    await pruneUsageEvents(env as Env);
    const { results } = await env.USAGE.prepare(
      "SELECT meeting_id FROM usage_events WHERE meeting_id LIKE 'retention-%'",
    ).all<{ meeting_id: string }>();
    expect(results.map((row) => row.meeting_id)).toEqual(['retention-recent']);
  });
});
