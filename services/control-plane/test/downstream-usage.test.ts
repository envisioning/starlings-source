import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { downstreamUsageSummary, recordDownstreamUsage } from '../src/downstream-usage';

function monthStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

describe('client-reported downstream usage', () => {
  afterEach(async () => {
    await env.USAGE.prepare('DELETE FROM downstream_usage_reports').run();
  });

  it('keeps the maximum cumulative reading per session and sums separate sessions', async () => {
    const now = Date.now();
    const currentMonth = monthStart(now);
    const firstSession = crypto.randomUUID();
    const secondSession = crypto.randomUUID();

    await recordDownstreamUsage(env, {
      reporter_id: firstSession,
      month_start: currentMonth,
      received_bytes: 800_000_000,
    }, now);
    // A retry or delayed request with an older cumulative count cannot lower
    // or double-count the session's usage.
    await recordDownstreamUsage(env, {
      reporter_id: firstSession,
      month_start: currentMonth,
      received_bytes: 500_000_000,
    }, now + 1_000);
    await recordDownstreamUsage(env, {
      reporter_id: secondSession,
      month_start: currentMonth,
      received_bytes: 200_000_000,
    }, now + 2_000);

    await recordDownstreamUsage(env, {
      reporter_id: firstSession,
      month_start: monthStart(currentMonth - 1),
      received_bytes: 90_000_000,
    }, now + 3_000);

    await expect(downstreamUsageSummary(env, currentMonth)).resolves.toEqual({
      received_bytes: 1_000_000_000,
      reporting_sessions: 2,
      last_reported_at: now + 2_000,
    });
  });
});
