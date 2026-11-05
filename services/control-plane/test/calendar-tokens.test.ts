import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeNativeGoogleCode } from '../src/auth';
import { nativeGoogleClientFor } from '../src/google-oauth';
import {
  connectAdditionalCalendarAccount,
  listCalendarAccounts,
  nativeRefreshClient,
  listGoogleCalendars,
  writeTokenRecord,
} from '../src/calendar';

// The Meet apps' and the Starlings apps' Google clients (meet#735), and the
// redirect each app sends: its client's reversed ID.
const MEET_CLIENT = '111-meet.apps.googleusercontent.com';
const STARLINGS_CLIENT = '111-starlings.apps.googleusercontent.com';
const MEET_REDIRECT = 'com.googleusercontent.apps.111-meet:/oauth/callback';
const STARLINGS_REDIRECT = 'com.googleusercontent.apps.111-starlings:/oauth/callback';

function fakeEnv() {
  const store = new Map<string, string>();
  const env = {
    GOOGLE_TOKEN_ENCRYPTION_KEY: 'test-key',
    GOOGLE_NATIVE_CLIENT_ID: MEET_CLIENT,
    GOOGLE_NATIVE_CLIENT_ID_STARLINGS: STARLINGS_CLIENT,
    WEB_ORIGIN: 'https://envisioning.starlings.example',
    CALENDAR_TOKENS: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => { store.set(key, value); },
      delete: async (key: string) => { store.delete(key); },
    },
  } as never;
  return { env, store };
}

const owner = { sub: 'owner-1', email: 'rosa@example.com' } as never;
const primaryKey = 'calendar:refresh:owner-1';
const extraKey = 'calendar:refresh:owner-1:acc123';
const accountsKey = 'calendar:accounts:owner-1';

async function seedTwoAccounts(env: never, store: Map<string, string>) {
  await writeTokenRecord(env, primaryKey, 'refresh-primary', 'rosa@example.com', 'native');
  await writeTokenRecord(env, extraKey, 'refresh-casa', 'casa@gmail.com', 'native');
  store.set(accountsKey, JSON.stringify([{ id: 'acc123', email: 'casa@gmail.com', connectedAt: 1, client: 'native' }]));
}

/**
 * Google's token endpoint and calendar list, keyed by which refresh token
 * asked. `exchange` answers an authorization-code grant, and `jwks` is what
 * verifying its id token will look up.
 */
function stubGoogle(
  refresh: (token: string) => Response,
  exchange?: { tokens: Record<string, unknown>; jwks: unknown },
) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const form = new URLSearchParams(String(init?.body));
      if (form.get('grant_type') === 'authorization_code' && exchange) return Response.json(exchange.tokens);
      return refresh(form.get('refresh_token') ?? '');
    }
    if (url.startsWith('https://www.googleapis.com/oauth2/v3/certs') && exchange) {
      return Response.json(exchange.jwks);
    }
    if (url.includes('/users/me/calendarList')) {
      const who = (new Headers(init?.headers).get('authorization') ?? '').replace('Bearer access-', '');
      return Response.json({ items: [{ id: `${who}@x`, summary: `${who} calendar`, primary: true, accessRole: 'owner' }] });
    }
    return new Response('unexpected', { status: 500 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('calendar token refresh', () => {
  it('forgets a dead extra-account token, and only that one', async () => {
    const { env, store } = fakeEnv();
    await seedTwoAccounts(env, store);
    stubGoogle((token) => token === 'refresh-casa'
      ? Response.json({ error: 'invalid_grant' }, { status: 400 })
      : Response.json({ access_token: 'access-primary' }));

    const calendars = await listGoogleCalendars(env, owner);
    // The owner's own calendars still list; the personal account costs only its own.
    expect(calendars.map((calendar) => calendar.id)).toEqual(['primary']);
    expect(store.has(primaryKey)).toBe(true);
    expect(store.has(extraKey)).toBe(false);

    // The account is still there to be seen and reconnected — not silently
    // gone while "already connected" on the next add.
    const accounts = await listCalendarAccounts(env, owner);
    expect(accounts.map((account) => [account.id, account.connected])).toEqual([
      ['primary-account', true],
      ['acc123', false],
    ]);
  });

  it('keeps every token through a Google outage', async () => {
    const { env, store } = fakeEnv();
    await seedTwoAccounts(env, store);
    stubGoogle(() => new Response('try later', { status: 503 }));

    await expect(listGoogleCalendars(env, owner)).rejects.toMatchObject({ code: 'calendar_failed' });
    expect(store.has(primaryKey)).toBe(true);
    expect(store.has(extraKey)).toBe(true);
  });

  it('does not ask for calendars from an account already known to be dead', async () => {
    const { env, store } = fakeEnv();
    await seedTwoAccounts(env, store);
    store.delete(extraKey);
    const asked: string[] = [];
    stubGoogle((token) => {
      asked.push(token);
      return Response.json({ access_token: 'access-primary' });
    });

    await listGoogleCalendars(env, owner);
    expect(asked).toEqual(['refresh-primary']);
  });
});

describe('reattaching a calendar account', () => {
  it('replaces the token under the same id and hands back its calendars', async () => {
    const { env, store } = fakeEnv();
    await seedTwoAccounts(env, store);
    const before = store.get(extraKey);
    // A real signature, because the identity check is the part worth keeping
    // real: the account is attached as data, but it is still a proven address.
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const idToken = await new SignJWT({ email: 'Casa@gmail.com', email_verified: true, nonce: 'nonce' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer('https://accounts.google.com')
      .setAudience(MEET_CLIENT)
      .setSubject('g-casa')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    stubGoogle(() => new Response('no refresh expected', { status: 500 }), {
      tokens: { id_token: idToken, access_token: 'access-casa', refresh_token: 'refresh-casa-2' },
      jwks: { keys: [{ ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256', use: 'sig' }] },
    });

    const result = await connectAdditionalCalendarAccount(env, owner, {
      code: 'code', codeVerifier: 'verifier', redirectURI: MEET_REDIRECT, nonce: 'nonce',
    });
    expect(result.account).toMatchObject({ id: 'acc123', email: 'casa@gmail.com', primary: false, connected: true });
    expect(store.get(extraKey)).not.toBe(before);
    expect(JSON.parse(store.get(accountsKey) ?? '[]')).toHaveLength(1);
    // Listed with the access token the exchange minted — no refresh, no KV read
    // of the record just written.
    expect(result.calendars?.map((calendar) => [calendar.id, calendar.accountEmail])).toEqual([
      ['acct:acc123:primary', 'casa@gmail.com'],
    ]);
  });
});

describe('two native clients (meet#735)', () => {
  it('takes each client by its redirect scheme, and refuses any other', () => {
    const { env } = fakeEnv();
    expect(nativeGoogleClientFor(env, MEET_REDIRECT)).toBe(MEET_CLIENT);
    expect(nativeGoogleClientFor(env, STARLINGS_REDIRECT)).toBe(STARLINGS_CLIENT);
    for (const redirect of [
      'meet:/oauth/callback',
      'com.googleusercontent.apps.111-other:/oauth/callback',
      'com.googleusercontent.apps.:/oauth/callback',
      'com.googleusercontent.apps.111-meet.evil:/oauth/callback',
      'https://evil.example/cb',
      '',
    ]) {
      expect(nativeGoogleClientFor(env, redirect)).toBeNull();
    }
    // An unset or placeholder Starlings client is no client.
    const noStarlings = { ...(env as object), GOOGLE_NATIVE_CLIENT_ID_STARLINGS: '' } as never;
    expect(nativeGoogleClientFor(noStarlings, STARLINGS_REDIRECT)).toBeNull();
  });

  it('refuses a sign-in code from an unknown app before it reaches Google', async () => {
    const { env } = fakeEnv();
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => { asked.push(String(input)); return new Response('no', { status: 500 }); });
    await expect(exchangeNativeGoogleCode(env, {
      code: 'code', codeVerifier: 'verifier', redirectURI: 'com.googleusercontent.apps.111-other:/oauth/callback', nonce: 'nonce',
    }, { lastClient: 'mac', ctx: {} as never })).rejects.toMatchObject({ status: 400, code: 'oauth_failed' });
    expect(asked).toEqual([]);
  });

  it('refuses a calendar code from an unknown app before it reaches Google', async () => {
    const { env } = fakeEnv();
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => { asked.push(String(input)); return new Response('no', { status: 500 }); });
    await expect(connectAdditionalCalendarAccount(env, owner, {
      code: 'code', codeVerifier: 'verifier', redirectURI: 'com.googleusercontent.apps.111-other:/oauth/callback', nonce: 'nonce',
    })).rejects.toMatchObject({ status: 400, code: 'calendar_failed' });
    expect(asked).toEqual([]);
  });

  it('refreshes with the client that issued the token, and a legacy record with the Meet client', async () => {
    const { env } = fakeEnv();
    expect(nativeRefreshClient(env, {})).toBe(MEET_CLIENT);
    expect(nativeRefreshClient(env, { clientID: STARLINGS_CLIENT })).toBe(STARLINGS_CLIENT);
    expect(() => nativeRefreshClient(env, { clientID: '999-gone.apps.googleusercontent.com' })).toThrow('no longer knows');

    const { env: real, store } = fakeEnv();
    await writeTokenRecord(real, primaryKey, 'refresh-new', 'rosa@example.com', 'native', STARLINGS_CLIENT);
    await writeTokenRecord(real, extraKey, 'refresh-old', 'casa@gmail.com', 'native');
    store.set(accountsKey, JSON.stringify([{ id: 'acc123', email: 'casa@gmail.com', connectedAt: 1, client: 'native' }]));
    expect(JSON.parse(store.get(primaryKey)!).clientID).toBe(STARLINGS_CLIENT);
    expect(JSON.parse(store.get(extraKey)!).clientID).toBeUndefined();
    const refreshedWith: Record<string, string | null> = {};
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        const form = new URLSearchParams(String(init?.body));
        refreshedWith[form.get('refresh_token') ?? ''] = form.get('client_id');
        return Response.json({ access_token: `access-${form.get('refresh_token')}` });
      }
      if (url.includes('/users/me/calendarList')) return Response.json({ items: [] });
      return new Response('unexpected', { status: 500 });
    });
    await listGoogleCalendars(real, owner);
    expect(refreshedWith).toEqual({ 'refresh-new': STARLINGS_CLIENT, 'refresh-old': MEET_CLIENT });
  });
});

