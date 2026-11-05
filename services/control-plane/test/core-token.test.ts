import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrmSyncError, exchangeCoreToken } from '../src/crm';
import worker from '../src/index';

const SECRET = 'meet-core-shared-secret-at-least-32-chars';
const secretEnv = { ...env, INTERNAL_REQUEST_SECRET: SECRET } as Env;

function coreAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const issued = {
  ok: true,
  token: 'core_pat_0123456789abcdef',
  scopes: ['search:read', 'contacts:read', 'contacts:write'],
  expires_at: '2026-12-07T09:00:00.000Z',
  email: 'rosa@example.com',
};

afterEach(() => vi.restoreAllMocks());

describe('Core token exchange', () => {
  it('signs a lowercased email and the device name for Core’s owner exchange', async () => {
    const seen: { url: string; headers: Headers; body: string }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) });
      return coreAnswer(issued);
    });

    const result = await exchangeCoreToken(secretEnv, 'ROSA@example.com', 'iPhone');

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://core.invalid/api/public/meet-owner-exchange');
    expect(JSON.parse(seen[0]!.body)).toEqual({ email: 'rosa@example.com', device_name: 'iPhone' });
    expect(seen[0]!.headers.get('content-type')).toBe('application/json');

    const timestamp = seen[0]!.headers.get('x-internal-timestamp')!;
    const signature = seen[0]!.headers.get('x-internal-signature')!;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const expected = [...new Uint8Array(await crypto.subtle.sign(
      'HMAC', key, new TextEncoder().encode(`${timestamp}.${seen[0]!.body}`),
    ))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    expect(signature).toBe(expected);

    expect(result).toEqual({
      token: issued.token,
      scopes: issued.scopes,
      expires_at: issued.expires_at,
      email: 'rosa@example.com',
    });
  });

  it('omits device_name when blank so Core applies its own default', async () => {
    let body: unknown;
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return coreAnswer(issued);
    });
    await exchangeCoreToken(secretEnv, 'rosa@example.com', '   ');
    expect(body).toEqual({ email: 'rosa@example.com' });
  });

  it('turns Core’s no_core_account into core_account_missing, and any other refusal into a 502', async () => {
    vi.stubGlobal('fetch', async () => coreAnswer({ ok: false, error: 'no_core_account' }, 404));
    await expect(exchangeCoreToken(secretEnv, 'new@example.com', undefined))
      .rejects.toMatchObject({ status: 404, code: 'core_account_missing' });

    // A backend without the route answers an HTML 404. That is an outage on
    // our side, not a missing account — it must never tell the owner to go
    // and sign in somewhere.
    vi.stubGlobal('fetch', async () => new Response('<!DOCTYPE html><html>not found</html>', { status: 404, headers: { 'content-type': 'text/html' } }));
    await expect(exchangeCoreToken(secretEnv, 'rosa@example.com', undefined))
      .rejects.toMatchObject({ status: 502 });

    vi.stubGlobal('fetch', async () => coreAnswer({ ok: false, error: 'Unauthorized' }, 401));
    await expect(exchangeCoreToken(secretEnv, 'rosa@example.com', undefined))
      .rejects.toMatchObject({ status: 502 });
  });

  it('refuses a token response it cannot use', async () => {
    vi.stubGlobal('fetch', async () => coreAnswer({ ok: true, token: '' }));
    await expect(exchangeCoreToken(secretEnv, 'rosa@example.com', undefined)).rejects.toThrow(CrmSyncError);
  });

  it('is off without the shared secret, like every other Core call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(exchangeCoreToken({ ...env, INTERNAL_REQUEST_SECRET: '' } as Env, 'rosa@example.com', undefined))
      .rejects.toMatchObject({ status: 503, code: 'not_configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('POST /api/core/token', () => {
  async function ownerSession(configured: Env, context: ExecutionContext): Promise<string> {
    const response = await worker.fetch(new Request('http://local/api/dev/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }), configured, context);
    return (await response.json<{ access_token: string }>()).access_token;
  }

  it('requires an owner session', async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(new Request('http://local/api/core/token', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }), secretEnv, context);
    expect(response.status).toBe(401);
    await waitOnExecutionContext(context);
  });

  it('answers not_configured without the shared secret', async () => {
    const context = createExecutionContext();
    const unconfigured = { ...env, INTERNAL_REQUEST_SECRET: '' } as Env;
    const token = await ownerSession(unconfigured, context);
    const response = await worker.fetch(new Request('http://local/api/core/token', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
    }), unconfigured, context);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'not_configured' });
    await waitOnExecutionContext(context);
  });

  it('brokers the session’s own address, never the body’s, and hands the token back untouched', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    let forwarded: unknown;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      forwarded = await request.json();
      return coreAnswer(issued);
    });
    const response = await worker.fetch(new Request('http://local/api/core/token', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ device_name: 'MacBook', email: 'someone-else@example.com' }),
    }), secretEnv, context);
    expect(response.status).toBe(200);
    expect(forwarded).toEqual({ email: 'rosa@example.com', device_name: 'MacBook' });
    expect(await response.json()).toEqual({
      token: issued.token, scopes: issued.scopes, expires_at: issued.expires_at, email: 'rosa@example.com',
    });
    await waitOnExecutionContext(context);
  });

  it('surfaces core_account_missing with Core’s instruction', async () => {
    const context = createExecutionContext();
    const token = await ownerSession(secretEnv, context);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => coreAnswer({ ok: false, error: 'no_core_account' }, 404));
    const response = await worker.fetch(new Request('http://local/api/core/token', {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
    }), secretEnv, context);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'core_account_missing' });
    await waitOnExecutionContext(context);
  });
});
