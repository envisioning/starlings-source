// The LiveKit token broker (meet#823, docs/CENTRAL_AUTH.md "The LiveKit
// broker"). The broker runs as its real `LiveKitService` entrypoint with the
// `ctx.props` a workspace's `LIVEKIT` binding carries; the workspace side runs
// as a workspace Worker does, behind a binding that copies arguments and
// answers as RPC does.
import { env } from 'cloudflare:workers';
import { jwtVerify } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { LIVEKIT_BROKER_VERSION } from '@starlings/contracts/livekit-broker';
import type { AuthEnv } from '../src/auth-worker/env';
import { LiveKitService } from '../src/auth-worker/index';
import { issueLiveKitToken, liveKitRoomName } from '../src/livekit';

const auth = 'https://auth.starlings.example';
const hq = 'https://hq.starlings.example';
const firm = 'https://firm-two.starlings.example';
const KEY = 'broker-test-key';
const SECRET = 'broker-test-secret-with-enough-length-for-hs256';
let authEnv: AuthEnv;

const storeSecret = (value: string) => ({ get: async () => value });

beforeAll(() => {
  authEnv = {
    AUTH_DB: (env as unknown as { AUTH_DB: D1Database }).AUTH_DB,
    ENVIRONMENT: 'development',
    AUTH_ORIGIN: auth,
    RETURN_ORIGIN_ALIASES: '',
    GOOGLE_WEB_CLIENT_ID: 'test-web',
    GOOGLE_CONNECTOR_CLIENT_ID: '',
    AUTH_SIGNING_SECRET: 'auth-test-signing-secret-with-at-least-32-characters',
    GOOGLE_WEB_CLIENT_SECRET: 'test-web-secret',
    MAIL_FROM: 'Starlings <hello@starlings.example>',
    OPS_ALERT_EMAIL: 'ops@example.net',
    SIGNUP_ORIGIN: 'https://site.example',
    OPS_ORIGIN: 'https://ops.starlings.example',
    SHARED_LIVEKIT_API_KEY: storeSecret(KEY) as unknown as SecretsStoreSecret,
    SHARED_LIVEKIT_API_SECRET: storeSecret(SECRET) as unknown as SecretsStoreSecret,
  };
});

/** What a workspace's LIVEKIT binding is: the real entrypoint with the props the account owner set. */
function bindingFor(props: unknown, configured: AuthEnv = authEnv) {
  const service = new LiveKitService({ props } as unknown as ExecutionContext, configured);
  return {
    participant: async (input: unknown) => structuredClone(await service.participant(structuredClone(input))),
    admin: async (input: unknown) => structuredClone(await service.admin(structuredClone(input))),
  };
}
/** A workspace Worker at `origin` with the broker and no LiveKit key of its own. */
const workspaceEnv = (origin: string) => {
  const { LIVEKIT_API_KEY: _key, LIVEKIT_API_SECRET: _secret, ...rest } = env as unknown as Record<string, unknown>;
  return { ...rest, WEB_ORIGIN: origin, WORKSPACE_ORIGIN_ALIASES: '', LIVEKIT: bindingFor({ origin }) } as unknown as Env;
};
const person = { identity: 'guest-1', name: 'Ana', metadata: '{"owner":false}' };
const verify = (token: string) => jwtVerify(token, new TextEncoder().encode(SECRET), { issuer: KEY });

describe('LiveKitService', () => {
  it('signs a participant token for a room under the caller\'s prefix, with the fixed grants', async () => {
    const answer = await bindingFor({ origin: hq }).participant({ v: LIVEKIT_BROKER_VERSION, room: 'ws.hq.meet-ana-1', ...person });
    expect(answer).toMatchObject({ ok: true });
    if (!answer.ok) return;
    const { payload } = await verify(answer.token);
    expect(payload.sub).toBe('guest-1');
    expect(payload.video).toEqual({
      room: 'ws.hq.meet-ana-1', roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: false,
    });
    expect(payload.exp! - payload.iat!).toBe(7_200);
  });

  it('signs a one-minute admin token for one of the caller\'s rooms', async () => {
    const answer = await bindingFor({ origin: hq }).admin({ v: LIVEKIT_BROKER_VERSION, room: 'ws.hq.meet-ana-1' });
    expect(answer).toMatchObject({ ok: true });
    if (!answer.ok) return;
    const { payload } = await verify(answer.token);
    expect(payload.video).toEqual({ roomAdmin: true, room: 'ws.hq.meet-ana-1' });
    expect(payload.exp! - payload.iat!).toBe(60);
  });

  it('refuses a room of another workspace, of Envisioning, or the bare prefix', async () => {
    const broker = bindingFor({ origin: hq });
    for (const room of ['ws.firm-two.meet-x-1', 'meet-mz-1', 'ws.hq.', 'ws.hqx.meet-x-1', 'ws.h.meet-x-1']) {
      expect(await broker.participant({ v: LIVEKIT_BROKER_VERSION, room, ...person })).toEqual({ ok: false, reason: 'room_refused' });
      expect(await broker.admin({ v: LIVEKIT_BROKER_VERSION, room })).toEqual({ ok: false, reason: 'room_refused' });
    }
  });

  it('refuses a binding without props, with extra props, for a service host or off starlings.example', async () => {
    for (const props of [undefined, {}, { origin: hq, room: 'x' }, { origin: 'https://docs-hq.starlings.example' }, { origin: auth }, { origin: 'https://evil.example.com' }]) {
      expect(await bindingFor(props).admin({ v: LIVEKIT_BROKER_VERSION, room: 'ws.hq.meet-a-1' })).toEqual({ ok: false, reason: 'origin_refused' });
    }
  });

  it('refuses a grant, a stray field or another version in the input', async () => {
    const broker = bindingFor({ origin: hq });
    expect(await broker.participant({ v: LIVEKIT_BROKER_VERSION, room: 'ws.hq.meet-a-1', ...person, video: { roomAdmin: true } })).toEqual({ ok: false, reason: 'invalid_request' });
    expect(await broker.admin({ v: 2, room: 'ws.hq.meet-a-1' })).toEqual({ ok: false, reason: 'invalid_request' });
  });

  it('answers not_configured without the key, and signs nothing', async () => {
    const { SHARED_LIVEKIT_API_KEY: _key, ...bare } = authEnv;
    expect(await bindingFor({ origin: hq }, bare as AuthEnv).admin({ v: LIVEKIT_BROKER_VERSION, room: 'ws.hq.meet-a-1' })).toEqual({ ok: false, reason: 'not_configured' });
  });
});

describe('a brokered workspace', () => {
  it('names its rooms under its prefix; Envisioning keeps meet-', () => {
    expect(liveKitRoomName(workspaceEnv(firm), 'ana', 'm1')).toBe('ws.firm-two.meet-ana-m1');
    expect(liveKitRoomName(env as unknown as Env, 'ana', 'm1')).toBe('meet-ana-m1');
  });

  it('gets its participant token from the broker, with no LiveKit key of its own', async () => {
    const issued = await issueLiveKitToken(workspaceEnv(firm), 'ws.firm-two.meet-ana-m1', { identity: 'guest-1', name: 'Ana', email: 'ana@example.net', owner: false });
    const { payload } = await verify(issued.token);
    expect(payload.video).toMatchObject({ room: 'ws.firm-two.meet-ana-m1', roomJoin: true });
    expect(JSON.parse(String(payload.metadata))).toMatchObject({ owner: false });
  });

  it('fails a token for a room the broker refuses, and never falls back to a key', async () => {
    await expect(issueLiveKitToken(workspaceEnv(firm), 'meet-mz-1', { identity: 'guest-1', name: 'Ana', email: 'ana@example.net', owner: false }))
      .rejects.toThrow(/refused a participant token: room_refused/u);
  });
});
