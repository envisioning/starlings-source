import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectAdditionalAndroidCalendarAccount, listGoogleCalendars } from '../src/calendar';

// The Android Calendar connect (docs/agents/areas/android.md, "Calendar").
// A file of its own: the Worker caches Google's key set per module, and a
// key from another file's test would not be fetched again.

function fakeEnv() {
  const store = new Map<string, string>();
  const env = {
    GOOGLE_TOKEN_ENCRYPTION_KEY: 'test-key',
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('an Android serverAuthCode', () => {
  const WEB_CLIENT = '111-web.apps.googleusercontent.com';

  it('is redeemed by the web client with its secret, no verifier and no redirect, and refreshes with it', async () => {
    const { env, store } = fakeEnv();
    const web = Object.assign(env as object, { GOOGLE_WEB_CLIENT_ID: WEB_CLIENT, GOOGLE_WEB_CLIENT_SECRET: 'web-secret' }) as never;
    // No nonce: Google sends none for this grant, and the token comes
    // straight from its token endpoint to the Worker.
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const idToken = await new SignJWT({ email: 'casa@gmail.com', email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer('https://accounts.google.com')
      .setAudience(WEB_CLIENT)
      .setSubject('g-casa')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256', use: 'sig' }] };
    const grants: URLSearchParams[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        const form = new URLSearchParams(String(init?.body));
        grants.push(form);
        if (form.get('grant_type') === 'authorization_code') {
          return Response.json({ id_token: idToken, access_token: 'access-casa', refresh_token: 'refresh-casa' });
        }
        return Response.json({ access_token: 'access-casa' });
      }
      if (url.startsWith('https://www.googleapis.com/oauth2/v3/certs')) return Response.json(jwks);
      if (url.includes('/users/me/calendarList')) return Response.json({ items: [] });
      return new Response('unexpected', { status: 500 });
    });

    const result = await connectAdditionalAndroidCalendarAccount(web, owner, 'server-auth-code');
    expect(result.account).toMatchObject({ email: 'casa@gmail.com', primary: false, connected: true });
    const [exchange] = grants;
    expect(Object.fromEntries(exchange!)).toEqual({
      code: 'server-auth-code',
      client_id: WEB_CLIENT,
      client_secret: 'web-secret',
      redirect_uri: '',
      grant_type: 'authorization_code',
    });
    const record = JSON.parse(store.get(`calendar:refresh:owner-1:${result.account.id}`)!);
    expect(record).toMatchObject({ client: 'web', email: 'casa@gmail.com' });
    expect(record.clientID).toBeUndefined();

    grants.length = 0;
    await listGoogleCalendars(web, owner).catch(() => undefined);
    expect(grants.find((form) => form.get('grant_type') === 'refresh_token')?.get('client_id')).toBe(WEB_CLIENT);
  });

  it('is refused before Google when the workspace holds no client secret', async () => {
    const { env } = fakeEnv();
    const web = Object.assign(env as object, { GOOGLE_WEB_CLIENT_ID: WEB_CLIENT }) as never;
    vi.stubGlobal('fetch', async () => new Response('no call expected', { status: 500 }));
    await expect(connectAdditionalAndroidCalendarAccount(web, owner, 'server-auth-code')).rejects.toMatchObject({ status: 503 });
  });
});
