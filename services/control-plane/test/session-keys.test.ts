import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeJwt, decodeProtectedHeader, SignJWT } from 'jose';
import { signingKey } from '../src/crypto';
import { signOwnerRefreshToken } from '../src/auth';
import { ACCEPTED_SESSION_ISSUERS, LEGACY_SESSION_ISSUER, SESSION_ISSUER, sessionSigningKeys, signSessionJwt, verifySessionJwt } from '../src/session-keys';

// meet#313: tokens name their key, and a rotation signs nobody out.
const OLD = (env as Env).SESSION_SIGNING_SECRET;
const NEW = 'rotated-session-signing-secret-with-32-characters';
const options = { issuer: 'starlings.example', audience: 'meet-test' };

function rotated(previous: string | undefined): Env {
  return { ...(env as Env), SESSION_SIGNING_SECRET: NEW, SESSION_SIGNING_SECRET_PREVIOUS: previous } as Env;
}

const claims = () => new SignJWT({ email: 'kid@example.com' })
  .setIssuer(options.issuer)
  .setAudience(options.audience)
  .setSubject('kid')
  .setIssuedAt()
  .setExpirationTime('1h');

afterEach(() => {
  (env as Env).SESSION_SIGNING_SECRET = OLD;
  delete (env as Env).SESSION_SIGNING_SECRET_PREVIOUS;
});

describe('session signing keys', () => {
  it('signs with a key id that names the current key', async () => {
    const token = await signSessionJwt(claims(), env as Env);
    const [current] = await sessionSigningKeys(env as Env);
    expect(decodeProtectedHeader(token).kid).toBe(current!.kid);
    expect(current!.kid).toHaveLength(16);
    await expect(verifySessionJwt(token, env as Env, options)).resolves.toBeTruthy();
  });

  it('verifies a token the previous key signed while the rotation is under way, and not after', async () => {
    const token = await signSessionJwt(claims(), env as Env);
    await expect(verifySessionJwt(token, rotated(OLD), options)).resolves.toBeTruthy();
    await expect(verifySessionJwt(token, rotated(undefined), options)).rejects.toThrow();
  });

  it('tries every key for a token signed before key ids existed', async () => {
    const legacy = await claims().setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(signingKey(OLD));
    await expect(verifySessionJwt(legacy, rotated(OLD), options)).resolves.toBeTruthy();
    await expect(verifySessionJwt(legacy, rotated(undefined), options)).rejects.toThrow();
  });

  it('refuses a key id that names neither key', async () => {
    const forged = await claims().setProtectedHeader({ alg: 'HS256', typ: 'JWT', kid: 'not-a-known-kid0' }).sign(signingKey(OLD));
    await expect(verifySessionJwt(forged, env as Env, options)).rejects.toThrow(/unknown key id/u);
  });

  it('fails an expired token at once, without trying the previous key', async () => {
    const expired = await new SignJWT({})
      .setIssuer(options.issuer).setAudience(options.audience)
      .setIssuedAt(1).setExpirationTime(2)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .sign(signingKey(NEW));
    await expect(verifySessionJwt(expired, rotated(OLD), options)).rejects.toThrow(/exp/u);
  });

  it('a phone renews through a rotation, and its new pair outlives the previous key', async () => {
    const owner = { sub: 'dev:rotate@example.com', email: 'rotate@example.com', name: 'Rotate' };
    const refresh = await signOwnerRefreshToken(owner, env as Env, { id: 'device-rotate', client: 'ios' });
    const renew = (token: string) => exports.default.fetch(new Request('http://local/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: token, client: 'ios' }),
    }));

    (env as Env).SESSION_SIGNING_SECRET = NEW;
    (env as Env).SESSION_SIGNING_SECRET_PREVIOUS = OLD;
    const response = await renew(refresh);
    expect(response.status).toBe(200);
    const renewed = await response.json<{ refresh_token: string }>();
    // The pair it bought is signed with the new key.
    expect(decodeProtectedHeader(renewed.refresh_token).kid).toBe((await sessionSigningKeys(env as Env))[0]!.kid);

    // Step two of the runbook drops the previous key: what it signed is spent.
    delete (env as Env).SESSION_SIGNING_SECRET_PREVIOUS;
    expect((await renew(renewed.refresh_token)).status).toBe(200);
  });
});

// meet#1059: new tokens name Starlings; one signed before the rename lives out its lifetime.
describe('session issuer', () => {
  const issued = (issuer: string) => new SignJWT({}).setIssuer(issuer).setAudience('meet-test').setIssuedAt().setExpirationTime('1h');
  const accepted = { issuer: ACCEPTED_SESSION_ISSUERS, audience: 'meet-test' };

  it('signs new tokens with the Starlings issuer', async () => {
    const owner = { sub: 'dev:issuer@example.com', email: 'issuer@example.com', name: 'Issuer' };
    const refresh = await signOwnerRefreshToken(owner, env as Env, { id: 'device-issuer', client: 'mac' });
    expect(decodeJwt(refresh).iss).toBe(SESSION_ISSUER);
  });

  it('still verifies a token signed with the old issuer, and refuses any other', async () => {
    await expect(verifySessionJwt(await signSessionJwt(issued(LEGACY_SESSION_ISSUER), env as Env), env as Env, accepted)).resolves.toBeTruthy();
    await expect(verifySessionJwt(await signSessionJwt(issued(SESSION_ISSUER), env as Env), env as Env, accepted)).resolves.toBeTruthy();
    await expect(verifySessionJwt(await signSessionJwt(issued('elsewhere.example'), env as Env), env as Env, accepted)).rejects.toThrow(/iss/u);
  });
});

describe('admin_audit is append-only (migration 0079)', () => {
  it('refuses UPDATE and DELETE, and still takes INSERT', async () => {
    await env.USAGE.prepare(
      "INSERT INTO admin_audit (ts, actor_sub, actor_email, action, subject, detail) VALUES (?1, 's', 'a@example.com', 'test.append-only', NULL, NULL)",
    ).bind(Date.now()).run();
    await expect(env.USAGE.prepare("UPDATE admin_audit SET detail = 'x' WHERE action = 'test.append-only'").run())
      .rejects.toThrow(/append-only/u);
    await expect(env.USAGE.prepare("DELETE FROM admin_audit WHERE action = 'test.append-only'").run())
      .rejects.toThrow(/append-only/u);
  });

  it('lets retention delete a row older than 2 years, and only that row', async () => {
    const threeYearsAgo = Date.now() - 3 * 365 * 24 * 60 * 60 * 1000;
    await env.USAGE.prepare(
      "INSERT INTO admin_audit (ts, actor_sub, actor_email, action, subject, detail) VALUES (?1, 's', 'a@example.com', 'test.retention', NULL, NULL)",
    ).bind(threeYearsAgo).run();
    await env.USAGE.prepare("DELETE FROM admin_audit WHERE action = 'test.retention'").run();
    const left = await env.USAGE.prepare("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'test.retention'").first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
