// The release goes stale and the TestFlight build ages out (meet#587): the
// hourly feed check, the daily TestFlight check, their alert mail, and the
// released version on Admin › Operations.
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RELEASE_FEED_URL,
  RELEASE_STALE_MS,
  TESTFLIGHT_STALE_DAYS,
  checkReleaseStale,
  checkTestflightStale,
  readReleaseFeed,
  recentFailures,
  sendDueAlerts,
  testflightCheckBlocker,
} from '../src/ops';

const DAY_MS = 24 * 60 * 60_000;
const NOW = Date.parse('2037-05-20T12:00:00Z');

async function failureRows(kind: string) {
  const { results } = await env.USAGE.prepare('SELECT day, count, last_detail FROM ops_failures WHERE kind = ?1')
    .bind(kind).all<{ day: string; count: number; last_detail: string | null }>();
  return results;
}

function feed(publishedMsAgo: number, version = '4.4.3'): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    expect(new Request(input).url).toBe(RELEASE_FEED_URL);
    return Response.json({ schema: 1, version, published: new Date(NOW - publishedMsAgo).toISOString() });
  }) as typeof fetch;
}

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

beforeEach(async () => {
  await env.USAGE.prepare("DELETE FROM ops_failures WHERE kind IN ('release_stale', 'testflight_stale', 'testflight_check_skipped')").run();
  await env.USAGE.prepare("DELETE FROM ops_alerts WHERE kind IN ('release_stale', 'testflight_stale')").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('checkReleaseStale', () => {
  it('counts nothing while the released version is eight days old or younger', async () => {
    expect(await checkReleaseStale(env, NOW, feed(RELEASE_STALE_MS))).toBe('fresh');
    expect(await failureRows('release_stale')).toEqual([]);
  });

  it('a feed older than eight days counts release_stale and produces one alert mail', async () => {
    expect(await checkReleaseStale(env, NOW, feed(RELEASE_STALE_MS + 60_000))).toBe('stale');
    expect(await failureRows('release_stale')).toEqual([
      { day: '2037-05-20', count: 1, last_detail: 'Starlings 4.4.3 is 8 days old' },
    ]);

    const mails = postmark();
    const alertEnv = { ...env, OPS_ALERT_EMAIL: 'ops@example.com', POSTMARK_API_KEY: 'pm-test' } as Env;
    expect(await sendDueAlerts(alertEnv, NOW)).toContain('release_stale');
    // The next tick, with the check holding again, is held back by the six-hour interval.
    await checkReleaseStale(env, NOW + 60 * 60_000, feed(RELEASE_STALE_MS + 61 * 60_000));
    expect(await sendDueAlerts(alertEnv, NOW + 60 * 60_000)).not.toContain('release_stale');
    const mail = mails.filter((row) => row.Subject === 'Starlings: release_stale failing');
    expect(mail).toHaveLength(1);
    expect(mail[0]!.TextBody).toContain('Starlings 4.4.3 is 8 days old');
    // The mail is the weekly release reminder: it names the step, and it never runs it.
    expect(mail[0]!.TextBody).toContain('the weekly standing release is due');
    expect(mail[0]!.TextBody).toContain('pnpm release');
  });

  it('throws, and counts nothing, when the feed cannot be read', async () => {
    const down = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    await expect(checkReleaseStale(env, NOW, down)).rejects.toThrow('503');
    const junk = (async () => Response.json({ version: '4.4.3', published: 'last week' })) as typeof fetch;
    await expect(checkReleaseStale(env, NOW, junk)).rejects.toThrow('published date');
    expect(await failureRows('release_stale')).toEqual([]);
  });

  it('reads the version and its age', async () => {
    expect(await readReleaseFeed(NOW, feed(3 * DAY_MS, '6.4.2'))).toEqual({
      version: '6.4.2',
      published_at: NOW - 3 * DAY_MS,
      age_days: 3,
    });
  });
});

describe('checkTestflightStale', () => {
  async function appleEnv(): Promise<{ env: Env; publicKey: CryptoKey }> {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
    let binary = '';
    for (const byte of der) binary += String.fromCharCode(byte);
    const body = btoa(binary).match(/.{1,64}/g)!.join('\n');
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
    return {
      env: { ...env, APPLE_API_KEY: pem, APPLE_API_KEY_ID: 'KEY123', APPLE_API_ISSUER_ID: 'issuer-1', ASC_APP_ID: '6740000000' } as Env,
      publicKey: pair.publicKey,
    };
  }

  function appStoreConnect(uploadedMsAgo: number, seen: Array<{ url: string; authorization: string | null }>): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push({ url: request.url, authorization: request.headers.get('authorization') });
      return Response.json({
        data: [{ attributes: { version: '2481', uploadedDate: new Date(NOW - uploadedMsAgo).toISOString() } }],
      });
    }) as typeof fetch;
  }

  it('is skipped, and says what is missing, without the Apple values', async () => {
    expect(testflightCheckBlocker(env)).toBe('no APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER_ID, ASC_APP_ID');
    expect(await checkTestflightStale(env, NOW, (async () => { throw new Error('not called'); }) as typeof fetch)).toBe('skipped');
  });

  it('asks App Store Connect for the newest build with a token it can verify, and is quiet at 75 days', async () => {
    const apple = await appleEnv();
    const seen: Array<{ url: string; authorization: string | null }> = [];
    expect(await checkTestflightStale(apple.env, NOW, appStoreConnect(TESTFLIGHT_STALE_DAYS * DAY_MS, seen))).toBe('fresh');
    expect(await failureRows('testflight_stale')).toEqual([]);

    const url = new URL(seen[0]!.url);
    expect(url.origin + url.pathname).toBe('https://api.appstoreconnect.apple.com/v1/builds');
    expect(Object.fromEntries(url.searchParams)).toEqual({ 'filter[app]': '6740000000', sort: '-uploadedDate', limit: '1' });

    const [header, payload, signature] = seen[0]!.authorization!.replace('Bearer ', '').split('.') as [string, string, string];
    const decode = (part: string) => JSON.parse(atob(part.replaceAll('-', '+').replaceAll('_', '/')));
    expect(decode(header)).toEqual({ alg: 'ES256', kid: 'KEY123', typ: 'JWT' });
    expect(decode(payload)).toMatchObject({ iss: 'issuer-1', aud: 'appstoreconnect-v1', iat: NOW / 1000, exp: NOW / 1000 + 600 });
    const raw = Uint8Array.from(atob(signature.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));
    expect(await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' }, apple.publicKey, raw, new TextEncoder().encode(`${header}.${payload}`),
    )).toBe(true);
  });

  it('counts testflight_stale for a build older than 75 days', async () => {
    const apple = await appleEnv();
    expect(await checkTestflightStale(apple.env, NOW, appStoreConnect(76 * DAY_MS, []))).toBe('stale');
    expect(await failureRows('testflight_stale')).toEqual([
      { day: '2037-05-20', count: 1, last_detail: 'build 2481 is 76 days old' },
    ]);
  });

  it('throws when App Store Connect refuses', async () => {
    const apple = await appleEnv();
    const refused = (async () => new Response('no', { status: 401 })) as typeof fetch;
    await expect(checkTestflightStale(apple.env, NOW, refused)).rejects.toThrow('401');
  });

  it('shows a skipped check on Admin without mailing it', async () => {
    await env.USAGE.prepare("INSERT INTO ops_failures (kind, day, count, last_at, last_detail) VALUES ('testflight_check_skipped', ?1, 1, ?2, 'no APPLE_API_KEY') ON CONFLICT (kind, day) DO NOTHING")
      .bind(new Date().toISOString().slice(0, 10), Date.now()).run();
    const mails = postmark();
    const alertEnv = { ...env, OPS_ALERT_EMAIL: 'ops@example.com', POSTMARK_API_KEY: 'pm-test' } as Env;
    expect(await sendDueAlerts(alertEnv, Date.now())).not.toContain('testflight_check_skipped');
    expect(mails.some((row) => row.Subject.includes('testflight_check_skipped'))).toBe(false);
    expect((await recentFailures(env)).find((row) => row.kind === 'testflight_check_skipped')).toMatchObject({ mailed: false });
  });
});

describe('Admin › Operations release line', () => {
  async function adminHeaders() {
    const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Admin', email: 'rosa@example.com' }),
    }));
    const { access_token: token } = await response.json<{ access_token: string }>();
    return { authorization: `Bearer ${token}`, origin: env.WEB_ORIGIN };
  }

  it('shows the released version and when it was published, or null when the feed is down', async () => {
    const publishedAt = Date.now() - 9 * DAY_MS;
    vi.stubGlobal('fetch', async () => Response.json({ version: '4.4.3', published: new Date(publishedAt).toISOString() }));
    const ok = await exports.default.fetch(new Request('http://local/api/admin/ops-failures', { headers: await adminHeaders() }));
    expect((await ok.json<{ release: unknown }>()).release).toEqual({ version: '4.4.3', published_at: publishedAt });

    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }));
    const down = await exports.default.fetch(new Request('http://local/api/admin/ops-failures', { headers: await adminHeaders() }));
    expect(down.status).toBe(200);
    expect((await down.json<{ release: unknown }>()).release).toBeNull();
  });
});

describe('readReleaseFeed', () => {
  it('reads the product site feed only, and a feed it cannot read is a failure', async () => {
    const asked: string[] = [];
    const missing = (async (input: RequestInfo | URL) => {
      asked.push(new Request(input).url);
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    await expect(readReleaseFeed(NOW, missing)).rejects.toThrow('404');
    expect(asked).toEqual(['https://site.example/updates/starlings.json']);

    const broken = (async () => new Response('down', { status: 503 })) as typeof fetch;
    await expect(readReleaseFeed(NOW, broken)).rejects.toThrow('503');
  });
});
