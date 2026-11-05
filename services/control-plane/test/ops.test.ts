// Operational alerts (meet#318): failures counted in D1, one mail per kind
// per six hours, dead jobs kept until replayed, and the stale-deploy check.
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import {
  ALERT_INTERVAL_MS,
  DEAD_IMPORT_JOBS_QUEUE,
  DEAD_JOBS_QUEUE,
  D1_UNREACHABLE_KIND,
  replayDeadJobs,
  checkDeployStale,
  isHourlyTick,
  isTransientD1Error,
  recordFailure,
  sendDueAlerts,
} from '../src/ops';

const DAY_MS = 24 * 60 * 60_000;

async function failureRow(kind: string, day: string) {
  return env.USAGE.prepare('SELECT count, last_detail FROM ops_failures WHERE kind = ?1 AND day = ?2')
    .bind(kind, day).first<{ count: number; last_detail: string | null }>();
}

async function adminHeaders() {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json', origin: env.WEB_ORIGIN };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('recordFailure', () => {
  it('adds up per kind and day, and keeps the last detail without an address', async () => {
    const now = Date.parse('2031-03-04T10:00:00Z');
    await recordFailure(env, 'test.upsert', 'first', now);
    await recordFailure(env, 'test.upsert', 'mail to ana@acme.com failed', now + 1000);
    await recordFailure(env, 'test.upsert', undefined, now + 2000);
    const row = await failureRow('test.upsert', '2031-03-04');
    expect(row).toEqual({ count: 3, last_detail: 'mail to <address> failed' });
  });

  it('never throws', async () => {
    const broken = { USAGE: { prepare: () => { throw new Error('D1 down'); } } } as unknown as Env;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordFailure(broken, 'test.broken')).resolves.toBeUndefined();
  });
});

describe('sendDueAlerts', () => {
  function postmark() {
    const mails: Array<{ To: string; Subject: string; TextBody: string }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).hostname === 'api.postmarkapp.com') {
        mails.push(await request.json());
        return Response.json({ ok: true });
      }
      return new Response('unexpected', { status: 500 });
    });
    return mails;
  }

  it('mails once per kind, then not again within six hours', async () => {
    const alertEnv = { ...env, OPS_ALERT_EMAIL: 'ops@example.com', POSTMARK_API_KEY: 'pm-test' } as Env;
    const mails = postmark();
    const now = Date.parse('2032-05-06T12:00:00Z');
    await recordFailure(env, 'test.alert', 'meeting-1', now - DAY_MS);
    await recordFailure(env, 'test.alert', 'meeting-2', now);

    expect(await sendDueAlerts(alertEnv, now)).toContain('test.alert');
    const mail = mails.find((row) => row.Subject === 'Starlings: test.alert failing');
    expect(mail?.To).toBe('ops@example.com');
    expect(mail?.TextBody).toContain('Today (2032-05-06 UTC): 1');
    expect(mail?.TextBody).toContain('Yesterday (2032-05-05 UTC): 1');
    expect(mail?.TextBody).toContain('meeting-2');
    expect(mail?.TextBody).toContain('docs/OPERATIONS.md');

    // A new failure inside the six hours waits.
    await recordFailure(env, 'test.alert', 'meeting-3', now + 60_000);
    expect(await sendDueAlerts(alertEnv, now + 60 * 60_000)).not.toContain('test.alert');
    // After six hours it is mailed.
    expect(await sendDueAlerts(alertEnv, now + ALERT_INTERVAL_MS + 60_000)).toContain('test.alert');
    // Nothing new since: no mail, however long it has been.
    expect(await sendDueAlerts(alertEnv, now + 2 * ALERT_INTERVAL_MS)).not.toContain('test.alert');
    expect(mails.filter((row) => row.Subject === 'Starlings: test.alert failing')).toHaveLength(2);
  });

  it('sends nothing when OPS_ALERT_EMAIL is unset', async () => {
    const mails = postmark();
    const now = Date.parse('2033-01-01T12:00:00Z');
    await recordFailure(env, 'test.silent', 'x', now);
    expect(await sendDueAlerts({ ...env, OPS_ALERT_EMAIL: '', POSTMARK_API_KEY: 'pm-test' } as Env, now)).toEqual([]);
    expect(mails).toHaveLength(0);
  });

  it('does not mark a kind as sent when Postmark refuses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }));
    const now = Date.parse('2034-01-01T12:00:00Z');
    await recordFailure(env, 'test.refused', 'x', now);
    const alertEnv = { ...env, OPS_ALERT_EMAIL: 'ops@example.com', POSTMARK_API_KEY: 'pm-test' } as Env;
    expect(await sendDueAlerts(alertEnv, now)).toEqual([]);
    expect(await env.USAGE.prepare(`SELECT sent_at FROM ops_alerts WHERE kind = 'test.refused'`).first()).toBeNull();
  });

  it('mails d1_unreachable only once a day holds 30', async () => {
    const alertEnv = { ...env, OPS_ALERT_EMAIL: 'ops@example.com', POSTMARK_API_KEY: 'pm-test' } as Env;
    const mails = postmark();
    const now = Date.parse('2035-03-03T12:00:00Z');
    for (let i = 0; i < 29; i += 1) await recordFailure(env, D1_UNREACHABLE_KIND, 'delivery.sweep.failed: Network connection lost.', now);
    expect(await sendDueAlerts(alertEnv, now)).not.toContain(D1_UNREACHABLE_KIND);
    await recordFailure(env, D1_UNREACHABLE_KIND, 'delivery.sweep.failed: Network connection lost.', now);
    expect(await sendDueAlerts(alertEnv, now)).toContain(D1_UNREACHABLE_KIND);
    expect(mails.filter((row) => row.Subject === `Starlings: ${D1_UNREACHABLE_KIND} failing`)).toHaveLength(1);
  });
});

describe('isTransientD1Error', () => {
  it('knows a lost connection from a bad statement', () => {
    expect(isTransientD1Error(new Error('D1_ERROR: Network connection lost.'))).toBe(true);
    expect(isTransientD1Error(new Error('D1_ERROR: D1 DB is overloaded. Requests queued for too long.'))).toBe(true);
    expect(isTransientD1Error(new Error('D1_ERROR: no such table: deliveries'))).toBe(false);
    expect(isTransientD1Error('Network connection lost')).toBe(false);
  });
});

describe('the dead-letter consumer', () => {
  function deadBatch(bodies: Array<{ id: string; body: unknown }>, queue = DEAD_JOBS_QUEUE) {
    const acked: string[] = [];
    const retried: string[] = [];
    const messages = bodies.map(({ id, body }) => ({
      id,
      body,
      timestamp: new Date(),
      attempts: 1,
      ack: () => { acked.push(id); },
      retry: () => { retried.push(id); },
    }));
    return {
      batch: { queue, messages, ackAll() {}, retryAll() {} } as unknown as MessageBatch<never>,
      acked,
      retried,
    };
  }

  it('stores and acks each dead message, counts it, and an admin replays it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const meetingId = crypto.randomUUID();
    const { batch, acked, retried } = deadBatch([
      { id: 'dead-1', body: { roomSlug: 'rosa', meetingId } },
      { id: 'dead-2', body: { kind: 'no-such-job' } },
    ]);
    await worker.queue(batch, env);
    expect(acked).toEqual(['dead-1', 'dead-2']);
    expect(retried).toEqual([]);
    const today = new Date().toISOString().slice(0, 10);
    expect((await failureRow('dead_job', today))?.count).toBeGreaterThanOrEqual(2);

    const headers = await adminHeaders();
    const summary = await (await exports.default.fetch(new Request('http://local/api/admin/dead-jobs', { headers }))).json<{ count: number }>();
    expect(summary.count).toBe(2);

    const sendBatch = vi.spyOn(env.ARTIFACT_JOBS, 'sendBatch').mockResolvedValue(undefined as never);
    const replay = await exports.default.fetch(new Request('http://local/api/admin/replay-jobs', {
      method: 'POST', headers, body: JSON.stringify({ dead: true }),
    }));
    expect(await replay.json()).toEqual({ queued: 1 });
    expect(sendBatch).toHaveBeenCalledWith([{ body: { roomSlug: 'rosa', meetingId } }]);
    // The job that went out is gone; the one no queue carries stays.
    const rows = await env.USAGE.prepare('SELECT id FROM dead_jobs ORDER BY id').all<{ id: string }>();
    expect(rows.results.map((row) => row.id)).toEqual(['dead-2']);
  });

  it('shelves the imports\' dead queue too, and a replay puts each job back on its own queue (meet#603)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await env.USAGE.prepare('DELETE FROM dead_jobs').run();
    const meetingId = crypto.randomUUID();
    const { batch, acked } = deadBatch([
      { id: 'dead-import', body: { kind: 'granola', noteId: 'not_1' } },
      { id: 'dead-notes', body: { roomSlug: 'rosa', meetingId } },
    ], DEAD_IMPORT_JOBS_QUEUE);
    await worker.queue(batch, env);
    expect(acked).toEqual(['dead-import', 'dead-notes']);

    const imports = vi.spyOn(env.IMPORT_JOBS, 'sendBatch').mockResolvedValue(undefined as never);
    const notes = vi.spyOn(env.ARTIFACT_JOBS, 'sendBatch').mockResolvedValue(undefined as never);
    expect(await replayDeadJobs(env)).toBe(2);
    expect(imports).toHaveBeenCalledWith([{ body: { kind: 'granola', noteId: 'not_1' } }]);
    expect(notes).toHaveBeenCalledWith([{ body: { roomSlug: 'rosa', meetingId } }]);
  });

  it('retries a message whose row cannot be written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { batch, acked, retried } = deadBatch([{ id: 'dead-3', body: { roomSlug: 'rosa', meetingId: crypto.randomUUID() } }]);
    const broken = { ...env, USAGE: { prepare: () => { throw new Error('D1 down'); } } } as unknown as Env;
    await worker.queue(batch, broken);
    expect(acked).toEqual([]);
    expect(retried).toEqual(['dead-3']);
  });

  it('refuses the dead replay to a member', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', email: 'ops-member@example.com' }),
    }));
    const { access_token } = await response.json<{ access_token: string }>();
    const headers = { authorization: `Bearer ${access_token}`, 'content-type': 'application/json', origin: env.WEB_ORIGIN };
    expect((await exports.default.fetch(new Request('http://local/api/admin/dead-jobs', { headers }))).status).toBe(403);
    expect((await exports.default.fetch(new Request('http://local/api/admin/replay-jobs', {
      method: 'POST', headers, body: JSON.stringify({ dead: true }),
    }))).status).toBe(403);
  });
});

describe('the stale-deploy check', () => {
  // The deploy check reads envisioning/starlings with its own token, never the App (docs/GITHUB_CONNECTOR.md).
  async function githubEnv(): Promise<Env> {
    return { ...env, GITHUB_DEPLOY_CHECK_TOKEN: 'github_pat_test' } as Env;
  }

  function githubCompare(committedAt: number) {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === '/repos/envisioning/starlings/compare/abc1234...main') {
        return Response.json({
          status: 'ahead',
          ahead_by: 2,
          commits: [
            { sha: 'old0001', commit: { committer: { date: new Date(committedAt).toISOString() } } },
            { sha: 'head002', commit: { committer: { date: new Date(committedAt + 60_000).toISOString() } } },
          ],
        });
      }
      return new Response('unexpected', { status: 500 });
    });
  }

  it('counts nothing while main is ahead for 45 minutes or less', async () => {
    const now = Date.parse('2035-02-02T10:00:00Z');
    const withApp = await githubEnv();
    githubCompare(now - 30 * 60_000);
    expect(await checkDeployStale(withApp, now, 'abc1234')).toBe('fresh');
    expect(await failureRow('deploy_stale', '2035-02-02')).toBeNull();
  });

  it('counts deploy_stale once main has been ahead for more than 45 minutes', async () => {
    const now = Date.parse('2035-02-03T10:00:00Z');
    const withApp = await githubEnv();
    githubCompare(now - 50 * 60_000);
    expect(await checkDeployStale(withApp, now, 'abc1234')).toBe('stale');
    expect(await failureRow('deploy_stale', '2035-02-03')).toEqual({ count: 1, last_detail: 'head002' });
  });

  it('is skipped when the build did not record its commit', async () => {
    expect(await checkDeployStale(await githubEnv(), Date.now(), 'unknown')).toBe('skipped');
  });

  it('runs on one tick an hour', () => {
    expect(isHourlyTick(Date.parse('2035-02-03T10:00:00Z'))).toBe(true);
    expect(isHourlyTick(Date.parse('2035-02-03T10:04:59Z'))).toBe(true);
    expect(isHourlyTick(Date.parse('2035-02-03T10:05:00Z'))).toBe(false);
  });
});
