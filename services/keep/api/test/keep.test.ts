import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  generateStaffKeypair,
  generateVaultKey,
  importVaultKey,
  openItem,
  openRelease,
  sealItem,
  sealRelease,
  unwrapKeyWithPrivateKey,
  uuid,
  wrapKeyToPublicKey,
  wrapPrivateKeyWithPassphrase,
  type StaffKeypair,
} from '@keep/crypto';
import type { MachineVaultDetail, ReleasePayload, ReleaseSummary, VaultAccess, VaultDetail, WrappedToPublicKey } from '@keep/contracts';
import worker from '../src/index';
import { signStaffSession } from '../src/auth';
import { hmacSHA256Hex } from '../src/crypto';

const ORIGIN = 'http://localhost:8789';

// Storage is shared across the tests in this file; start each one empty.
beforeEach(async () => {
  await env.DB.batch(
    ['releases', 'audit_events', 'items', 'vault_recovery_keys', 'vault_members', 'vaults', 'recovery_key', 'staff_keys', 'device_tokens', 'agents'].map((table) =>
      env.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
});
const WEB_ORIGIN = 'http://localhost:5175';

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const request = new Request(`${ORIGIN}${path}`, init);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

interface Person {
  email: string;
  pair: StaffKeypair;
  call: (path: string, init?: RequestInit) => Promise<Response>;
}

async function person(email: string, name = email.split('@')[0]!): Promise<Person> {
  const token = await signStaffSession({ sub: `g-${email}`, email, name }, env);
  const pair = await generateStaffKeypair();
  const as = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', `keep_session=${token}`);
    if (init.method && init.method !== 'GET' && !headers.has('origin')) headers.set('origin', WEB_ORIGIN);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    return call(path, { ...init, headers });
  };
  return { email, pair, call: as };
}

async function enrol(who: Person): Promise<void> {
  const { wrapped, wrap } = await wrapPrivateKeyWithPassphrase(who.pair.privateKey, 'a passphrase long enough');
  const response = await who.call('/api/keys/me', {
    method: 'PUT',
    body: JSON.stringify({ suite: 'keep-v1', public_key: who.pair.publicKey, wrapped_private_key: wrapped, wrap }),
  });
  expect(response.status).toBe(201);
}

async function makeVault(owner: Person, name: string, others: Person[] = []): Promise<{ vault: VaultDetail; key: Uint8Array }> {
  const key = generateVaultKey();
  const members = await Promise.all(
    [owner, ...others].map(async (member) => ({ email: member.email, wrapped_key: await wrapKeyToPublicKey(key, member.pair.publicKey) })),
  );
  const response = await owner.call('/api/vaults', {
    method: 'POST',
    body: JSON.stringify({ name, members, recovery_wrapped_key: null }),
  });
  expect(response.status).toBe(201);
  return { vault: await response.json<VaultDetail>(), key };
}

async function agentToken(address: string, name = 'Vocab'): Promise<string> {
  const text = JSON.stringify({ email: address, name, device_name: 'broker', scope: 'agent' });
  const timestamp = String(Date.now());
  const response = await call('/api/tokens/meet-exchange', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-timestamp': timestamp,
      'x-internal-signature': await hmacSHA256Hex('test-keep-internal-secret-shared-with-meet', `${timestamp}.${text}`),
    },
    body: text,
  });
  expect(response.status).toBe(201);
  return (await response.json<{ token: string }>()).token;
}

async function asAgent(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  if (init.body) headers.set('content-type', 'application/json');
  return call(path, { ...init, headers });
}

describe('auth', () => {
  it('rejects an anonymous request', async () => {
    const response = await call('/api/vaults');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'unauthorized' });
  });

  it('serves health without a session', async () => {
    const response = await call('/api/health');
    expect(response.status).toBe(200);
  });

  it('refuses a session JWT as a bearer: only device tokens ride that header', async () => {
    const mz = await person('rosa@org.example');
    const token = await signStaffSession({ sub: 'g', email: mz.email, name: 'MZ' }, env);
    const response = await call('/api/vaults', { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(401);
  });

  it('a bogus bearer fails outright rather than falling back to the cookie', async () => {
    const mz = await person('rosa@org.example');
    const token = await signStaffSession({ sub: 'g', email: mz.email, name: 'MZ' }, env);
    const response = await call('/api/vaults', { headers: { cookie: `keep_session=${token}`, authorization: 'Bearer evk_nope' } });
    expect(response.status).toBe(401);
  });

  it('rejects a mutation from a foreign origin', async () => {
    const mz = await person('rosa@org.example');
    const response = await mz.call('/api/vaults', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
  });

  it('sets a strict CSP on every response', async () => {
    const response = await call('/api/health');
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
  });
});

describe('enrolment', () => {
  it('reports enrolment on /api/me and lists the directory', async () => {
    const mz = await person('rosa@org.example', 'Rosa Ortiz');
    expect((await (await mz.call('/api/me')).json<{ enrolled: boolean }>()).enrolled).toBe(false);
    await enrol(mz);
    const me = await (await mz.call('/api/me')).json<{ enrolled: boolean; key: { public_key: string; wrap: { method: string } } }>();
    expect(me.enrolled).toBe(true);
    expect(me.key.public_key).toBe(mz.pair.publicKey);
    expect(me.key.wrap.method).toBe('passphrase');
    const directory = await (await mz.call('/api/keys/directory')).json<{ entries: Array<{ email: string; name: string }> }>();
    expect(directory.entries).toEqual([expect.objectContaining({ email: 'rosa@org.example', name: 'Rosa Ortiz' })]);
  });

  it('refuses to re-enrol without replace, and drops memberships with it', async () => {
    const mz = await person('rosa@org.example');
    await enrol(mz);
    await makeVault(mz, 'Client A');
    const again = await mz.call('/api/keys/me', {
      method: 'PUT',
      body: JSON.stringify({
        suite: 'keep-v1',
        public_key: mz.pair.publicKey,
        wrapped_private_key: { iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAA' },
        wrap: { method: 'passphrase', pbkdf2_salt: 'AAAA', pbkdf2_iterations: 600000 },
      }),
    });
    expect(again.status).toBe(409);
    const replaced = await mz.call('/api/keys/me?replace=1', {
      method: 'PUT',
      body: JSON.stringify({
        suite: 'keep-v1',
        public_key: mz.pair.publicKey,
        wrapped_private_key: { iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAA' },
        wrap: { method: 'passphrase', pbkdf2_salt: 'AAAA', pbkdf2_iterations: 600000 },
      }),
    });
    expect(replaced.status).toBe(201);
    const vaults = await (await mz.call('/api/vaults')).json<{ vaults: unknown[] }>();
    expect(vaults.vaults).toHaveLength(0);
  });

  it('adds a second way to unwrap the same key, one per method', async () => {
    const mz = await person('rosa@org.example');
    await enrol(mz);
    const { wrapped, wrap } = await wrapPrivateKeyWithPassphrase(mz.pair.privateKey, 'another passphrase entirely');
    const prfWrap = { wrapped_private_key: { iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAA' }, wrap: { method: 'prf', credential_id: 'AAAA', hkdf_salt: 'AAAA' } };
    expect((await mz.call('/api/keys/me/wraps', { method: 'POST', body: JSON.stringify(prfWrap) })).status).toBe(201);
    const again = await mz.call('/api/keys/me/wraps', { method: 'POST', body: JSON.stringify({ wrapped_private_key: wrapped, wrap }) });
    expect(again.status).toBe(201);
    const key = (await again.json<{ wraps: Array<{ wrap: { method: string } }> }>()).wraps;
    expect(key.map((entry) => entry.wrap.method)).toEqual(['passphrase', 'prf']);
    // The primary passphrase wrap was replaced, not duplicated.
    const me = await (await mz.call('/api/me')).json<{ key: { wrapped_private_key: { iv: string } } }>();
    expect(me.key.wrapped_private_key.iv).toBe(wrapped.iv);
  });

  it('rejects PBKDF2 below the floor', async () => {
    const mz = await person('rosa@org.example');
    const response = await mz.call('/api/keys/me', {
      method: 'PUT',
      body: JSON.stringify({
        suite: 'keep-v1',
        public_key: mz.pair.publicKey,
        wrapped_private_key: { iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAA' },
        wrap: { method: 'passphrase', pbkdf2_salt: 'AAAA', pbkdf2_iterations: 1000 },
      }),
    });
    expect(response.status).toBe(400);
  });
});

describe('vaults', () => {
  it('a non-member cannot see, open or list the vault', async () => {
    const mz = await person('rosa@org.example');
    const other = await person('other@org.example');
    await enrol(mz);
    await enrol(other);
    const { vault } = await makeVault(mz, 'Client A');
    expect((await other.call(`/api/vaults/${vault.id}`)).status).toBe(404);
    expect((await other.call(`/api/vaults/${vault.id}/audit`)).status).toBe(404);
    expect((await (await other.call('/api/vaults')).json<{ vaults: unknown[] }>()).vaults).toHaveLength(0);
  });

  it('refuses a vault that does not wrap to the caller or to an unenrolled person', async () => {
    const mz = await person('rosa@org.example');
    const ghost = await person('ghost@org.example');
    await enrol(mz);
    const key = generateVaultKey();
    const noSelf = await mz.call('/api/vaults', {
      method: 'POST',
      body: JSON.stringify({
        name: 'X',
        members: [{ email: ghost.email, wrapped_key: await wrapKeyToPublicKey(key, ghost.pair.publicKey) }],
        recovery_wrapped_key: null,
      }),
    });
    expect(noSelf.status).toBe(400);
    const unenrolled = await mz.call('/api/vaults', {
      method: 'POST',
      body: JSON.stringify({
        name: 'X',
        members: [
          { email: mz.email, wrapped_key: await wrapKeyToPublicKey(key, mz.pair.publicKey) },
          { email: ghost.email, wrapped_key: await wrapKeyToPublicKey(key, ghost.pair.publicKey) },
        ],
        recovery_wrapped_key: null,
      }),
    });
    expect(unenrolled.status).toBe(400);
    expect(await unenrolled.json()).toMatchObject({ code: 'not_enrolled' });
  });

  it('the server never sees plaintext and a member can open what another sealed', async () => {
    const mz = await person('rosa@org.example');
    const ana = await person('ana@org.example');
    await enrol(mz);
    await enrol(ana);
    const { vault, key } = await makeVault(mz, 'Client A', [ana]);

    const vaultKey = await importVaultKey(key);
    const itemId = uuid();
    const body = { username: 'ops', password: 'p@ss', url: 'https://x', notes: 'n', totp: '' };
    const sealed = await sealItem(vaultKey, vault.id, itemId, 1, body);
    const created = await mz.call(`/api/vaults/${vault.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ id: itemId, name: 'Staging DB', kind: 'database', sealed, key_version: 1 }),
    });
    expect(created.status).toBe(201);

    // The list carries no ciphertext.
    const detail = await (await ana.call(`/api/vaults/${vault.id}`)).json<VaultDetail>();
    expect(detail.items).toHaveLength(1);
    expect(JSON.stringify(detail.items)).not.toContain('ciphertext');
    expect(JSON.stringify(detail)).not.toContain('p@ss');

    // Ana unwraps the vault key with her private key and opens the item.
    const anaKey = await importVaultKey(await unwrapKeyWithPrivateKey(detail.wrapped_key, ana.pair.privateKey, ana.pair.publicKey));
    const revealed = await (await ana.call(`/api/vaults/${vault.id}/items/${itemId}`)).json<{ sealed: typeof sealed; key_version: number }>();
    expect(await openItem(anaKey, vault.id, itemId, revealed.key_version, revealed.sealed)).toEqual(body);

    // One reveal, one audit row, attributed to Ana, naming the item.
    const audit = await (await mz.call(`/api/vaults/${vault.id}/audit`)).json<{ events: Array<{ kind: string; actor: string; item_name: string | null }> }>();
    expect(audit.events.filter((event) => event.kind === 'item.reveal')).toEqual([
      expect.objectContaining({ actor: 'ana@org.example', item_name: 'Staging DB' }),
    ]);
  });

  it('rejects an item sealed under a stale key version', async () => {
    const mz = await person('rosa@org.example');
    await enrol(mz);
    const { vault, key } = await makeVault(mz, 'Client A');
    const sealed = await sealItem(await importVaultKey(key), vault.id, uuid(), 2, { username: '', password: '', url: '', notes: '', totp: '' });
    const response = await mz.call(`/api/vaults/${vault.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ id: uuid(), name: 'X', kind: 'login', sealed, key_version: 2 }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'stale_rotation' });
  });

  it('grant, then revoke by rotation: the removed member is locked out and the audit survives', async () => {
    const mz = await person('rosa@org.example');
    const ana = await person('ana@org.example');
    await enrol(mz);
    await enrol(ana);
    const { vault, key } = await makeVault(mz, 'Client A');

    const grant = await mz.call(`/api/vaults/${vault.id}/members`, {
      method: 'POST',
      body: JSON.stringify({ email: ana.email, wrapped_key: await wrapKeyToPublicKey(key, ana.pair.publicKey) }),
    });
    expect(grant.status).toBe(201);
    expect((await grant.json<VaultDetail>()).members.map((member) => member.email).sort()).toEqual(['ana@org.example', 'rosa@org.example']);

    const itemId = uuid();
    const oldKey = await importVaultKey(key);
    const body = { username: 'u', password: 'p', url: '', notes: '', totp: '' };
    await mz.call(`/api/vaults/${vault.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ id: itemId, name: 'Login', kind: 'login', sealed: await sealItem(oldKey, vault.id, itemId, 1, body), key_version: 1 }),
    });

    // Rotation missing an item is refused.
    const newKeyBytes = generateVaultKey();
    const newKey = await importVaultKey(newKeyBytes);
    const incomplete = await mz.call(`/api/vaults/${vault.id}/rotate`, {
      method: 'POST',
      body: JSON.stringify({
        key_version: 2,
        members: [{ email: mz.email, wrapped_key: await wrapKeyToPublicKey(newKeyBytes, mz.pair.publicKey) }],
        recovery_wrapped_key: null,
        items: [],
      }),
    });
    expect(incomplete.status).toBe(409);

    const rotated = await mz.call(`/api/vaults/${vault.id}/rotate`, {
      method: 'POST',
      body: JSON.stringify({
        key_version: 2,
        members: [{ email: mz.email, wrapped_key: await wrapKeyToPublicKey(newKeyBytes, mz.pair.publicKey) }],
        recovery_wrapped_key: null,
        items: [{ id: itemId, sealed: await sealItem(newKey, vault.id, itemId, 2, body) }],
      }),
    });
    expect(rotated.status).toBe(200);
    const after = await rotated.json<VaultDetail>();
    expect(after.key_version).toBe(2);
    expect(after.members.map((member) => member.email)).toEqual(['rosa@org.example']);

    // Ana is gone: 404, not 403.
    expect((await ana.call(`/api/vaults/${vault.id}`)).status).toBe(404);

    // MZ opens the re-sealed item under the new key.
    const mine = await (await mz.call(`/api/vaults/${vault.id}`)).json<VaultDetail>();
    const mzKey = await importVaultKey(await unwrapKeyWithPrivateKey(mine.wrapped_key, mz.pair.privateKey, mz.pair.publicKey));
    const revealed = await (await mz.call(`/api/vaults/${vault.id}/items/${itemId}`)).json<{ sealed: { iv: string; ciphertext: string } }>();
    expect(await openItem(mzKey, vault.id, itemId, 2, revealed.sealed)).toEqual(body);

    // A second rotation targeting the wrong version is refused.
    const stale = await mz.call(`/api/vaults/${vault.id}/rotate`, {
      method: 'POST',
      body: JSON.stringify({ key_version: 2, members: [], recovery_wrapped_key: null, items: [] }),
    });
    expect(stale.status).toBe(400); // members min(1) fails first — zod

    // Delete keeps the trail.
    expect((await mz.call(`/api/vaults/${vault.id}`, { method: 'DELETE' })).status).toBe(204);
    const trail = await (await mz.call('/api/audit')).json<{ events: Array<{ kind: string; vault_id: string | null }> }>();
    const kinds = trail.events.filter((event) => event.vault_id === vault.id).map((event) => event.kind);
    expect(kinds).toContain('vault.delete');
    expect(kinds).toContain('vault.rotate');
    expect(kinds).toContain('item.create');
  });

  it('recovery: once a key exists, vaults must wrap to it', async () => {
    const mz = await person('rosa@org.example');
    await enrol(mz);
    const recovery = await generateStaffKeypair();
    const set = await mz.call('/api/recovery', {
      method: 'PUT',
      body: JSON.stringify({ suite: 'keep-v1', public_key: recovery.publicKey, holders: ['rosa@org.example', 'ana@org.example'] }),
    });
    expect(set.status).toBe(201);
    expect((await mz.call('/api/recovery', { method: 'PUT', body: JSON.stringify({ suite: 'keep-v1', public_key: recovery.publicKey, holders: ['a@org.example', 'b@org.example'] }) })).status).toBe(409);

    const key = generateVaultKey();
    const without = await mz.call('/api/vaults', {
      method: 'POST',
      body: JSON.stringify({
        name: 'X',
        members: [{ email: mz.email, wrapped_key: await wrapKeyToPublicKey(key, mz.pair.publicKey) }],
        recovery_wrapped_key: null,
      }),
    });
    expect(without.status).toBe(400);

    const withWrap = await mz.call('/api/vaults', {
      method: 'POST',
      body: JSON.stringify({
        name: 'X',
        members: [{ email: mz.email, wrapped_key: await wrapKeyToPublicKey(key, mz.pair.publicKey) }],
        recovery_wrapped_key: await wrapKeyToPublicKey(key, recovery.publicKey),
      }),
    });
    expect(withWrap.status).toBe(201);
    expect((await withWrap.json<VaultDetail>()).recovery_wrapped).toBe(true);
  });
});

describe('device tokens', () => {
  async function exchange(body: Record<string, unknown>, secret = 'test-keep-internal-secret-shared-with-meet'): Promise<Response> {
    const text = JSON.stringify(body);
    const timestamp = String(Date.now());
    return call('/api/tokens/meet-exchange', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-timestamp': timestamp,
        'x-internal-signature': await hmacSHA256Hex(secret, `${timestamp}.${text}`),
      },
      body: text,
    });
  }

  it('mints a token the device can use without an Origin, and replaces the previous one', async () => {
    const first = await exchange({ email: 'rosa@org.example', name: 'Rosa Ortiz', device_name: 'MZ Air' });
    expect(first.status).toBe(201);
    const { token } = await first.json<{ token: string }>();
    expect(token.startsWith('evk_')).toBe(true);

    const me = await call('/api/me', { headers: { authorization: `Bearer ${token}` } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: 'rosa@org.example', name: 'Rosa Ortiz', enrolled: false });

    // A device mutation carries no Origin.
    const enrolled = await call('/api/keys/me', {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        suite: 'keep-v1',
        public_key: 'AAAA',
        wrapped_private_key: { iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAA' },
        wrap: { method: 'passphrase', pbkdf2_salt: 'AAAA', pbkdf2_iterations: 600000 },
      }),
    });
    expect(enrolled.status).toBe(201);

    const second = await exchange({ email: 'rosa@org.example', name: 'Rosa Ortiz', device_name: 'MZ Air' });
    expect(second.status).toBe(201);
    expect((await call('/api/me', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('refuses a bad signature, a stale timestamp and a foreign domain', async () => {
    expect((await exchange({ email: 'rosa@org.example', name: 'MZ', device_name: 'x' }, 'wrong')).status).toBe(401);
    expect((await exchange({ email: 'mz@gmail.com', name: 'MZ', device_name: 'x' })).status).toBe(400);
    const text = JSON.stringify({ email: 'rosa@org.example', name: 'MZ', device_name: 'x' });
    const old = String(Date.now() - 10 * 60 * 1000);
    const stale = await call('/api/tokens/meet-exchange', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-timestamp': old,
        'x-internal-signature': await hmacSHA256Hex('test-keep-internal-secret-shared-with-meet', `${old}.${text}`),
      },
      body: text,
    });
    expect(stale.status).toBe(401);
  });

  it('lists and revokes from a cookie session', async () => {
    const minted = await (await exchange({ email: 'rosa@org.example', name: 'MZ', device_name: 'Phone' })).json<{ token: string }>();
    const mz = await person('rosa@org.example');
    const list = await (await mz.call('/api/tokens')).json<{ tokens: Array<{ id: string; device_name: string }> }>();
    expect(list.tokens).toEqual([expect.objectContaining({ device_name: 'Phone' })]);
    expect((await mz.call(`/api/tokens/${list.tokens[0]!.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await call('/api/me', { headers: { authorization: `Bearer ${minted.token}` } })).status).toBe(401);
  });

  it('serves the Apple association file from the Worker', async () => {
    const response = await call('/.well-known/apple-app-site-association');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ webcredentials: { apps: ['TEAM.com.envisioning.meet'] } });
  });
});

describe('recovery', () => {
  it('covers an older vault, lists it for a holder, and lets them join', async () => {
    const mz = await person('rosa@org.example');
    const ana = await person('ana@org.example');
    await enrol(mz);
    await enrol(ana);
    // A vault from before the recovery key existed.
    const { vault, key } = await makeVault(mz, 'Old client');
    expect(vault.recovery_wrapped).toBe(false);

    const recovery = await generateStaffKeypair();
    expect((await mz.call('/api/recovery', { method: 'PUT', body: JSON.stringify({ suite: 'keep-v1', public_key: recovery.publicKey, holders: [mz.email, ana.email] }) })).status).toBe(201);

    // Nothing to recover yet: the vault has no recovery copy.
    expect((await (await ana.call('/api/recovery/vaults')).json<{ vaults: unknown[] }>()).vaults).toHaveLength(0);

    // Cover it.
    const covered = await mz.call(`/api/vaults/${vault.id}/recovery`, {
      method: 'POST',
      body: JSON.stringify({ recovery_wrapped_key: await wrapKeyToPublicKey(key, recovery.publicKey) }),
    });
    expect(covered.status).toBe(201);
    expect((await covered.json<VaultDetail>()).recovery_wrapped).toBe(true);
    expect((await mz.call(`/api/vaults/${vault.id}/recovery`, { method: 'POST', body: JSON.stringify({ recovery_wrapped_key: await wrapKeyToPublicKey(key, recovery.publicKey) }) })).status).toBe(409);

    // Ana, not a member, holds both shares: she lists, opens with the recovery key, joins.
    const listed = await (await ana.call('/api/recovery/vaults')).json<{ vaults: Array<{ id: string; recovery_wrapped_key: WrappedToPublicKey; members: string[] }> }>();
    expect(listed.vaults.map((entry) => entry.id)).toEqual([vault.id]);
    expect(listed.vaults[0]!.members).toEqual(['rosa@org.example']);
    const opened = await unwrapKeyWithPrivateKey(listed.vaults[0]!.recovery_wrapped_key, recovery.privateKey, recovery.publicKey);
    expect(opened).toEqual(key);
    expect((await ana.call(`/api/vaults/${vault.id}`)).status).toBe(404);
    const joined = await ana.call(`/api/recovery/vaults/${vault.id}/join`, {
      method: 'POST',
      body: JSON.stringify({ wrapped_key: await wrapKeyToPublicKey(opened, ana.pair.publicKey) }),
    });
    expect(joined.status).toBe(204);
    const detail = await (await ana.call(`/api/vaults/${vault.id}`)).json<VaultDetail>();
    expect(detail.members.map((member) => member.email).sort()).toEqual(['ana@org.example', 'rosa@org.example']);
    expect(await unwrapKeyWithPrivateKey(detail.wrapped_key, ana.pair.privateKey, ana.pair.publicKey)).toEqual(key);

    const trail = await (await mz.call(`/api/vaults/${vault.id}/audit`)).json<{ events: Array<{ kind: string; actor: string }> }>();
    expect(trail.events.map((event) => event.kind)).toEqual(expect.arrayContaining(['vault.cover', 'recovery.join']));
    expect(trail.events.find((event) => event.kind === 'recovery.join')?.actor).toBe('ana@org.example');
  });
});

describe('agents and machine vaults', () => {
  /** The broker's part: a token, a key pair it keeps, the public half registered. */
  async function brokeredAgent(address: string): Promise<{ token: string; pair: StaffKeypair }> {
    const token = await agentToken(address);
    const pair = await generateStaffKeypair();
    const registered = await asAgent(token, '/api/agent/key', { method: 'PUT', body: JSON.stringify({ suite: 'keep-v1', public_key: pair.publicKey }) });
    expect(registered.status).toBe(200);
    return { token, pair };
  }

  async function machineVault(owner: Person, address: string, publicKey: string): Promise<MachineVaultDetail> {
    const response = await owner.call('/api/machine-vaults', {
      method: 'POST',
      body: JSON.stringify({ name: 'Vocab keys', agent: address, wrapped_key: await wrapKeyToPublicKey(generateVaultKey(), publicKey) }),
    });
    expect(response.status).toBe(201);
    return response.json<MachineVaultDetail>();
  }

  /** A person seals an item to the agent: a fresh item key, wrapped to the agent's public key. */
  async function sealToAgent(vault: MachineVaultDetail, itemId: string, body: { username: string; password: string; url: string; notes: string; totp: string }) {
    const itemKey = generateVaultKey();
    return {
      sealed: await sealItem(await importVaultKey(itemKey), vault.id, itemId, vault.key_version, body),
      wrapped_key: await wrapKeyToPublicKey(itemKey, vault.agent.public_key!),
    };
  }

  it('an agent token reaches its own routes and nothing else', async () => {
    const mz = await person('rosa@org.example');
    await enrol(mz);
    await makeVault(mz, 'Client A');
    const { token } = await brokeredAgent('scout@org.example');
    for (const path of ['/api/me', '/api/vaults', '/api/keys/directory', '/api/audit', '/api/tokens', '/api/agents', '/api/machine-vaults']) {
      expect((await asAgent(token, path)).status).toBe(404);
    }
    const self = await (await asAgent(token, '/api/agent/me')).json<{ address: string; vaults: unknown[] }>();
    expect(self).toMatchObject({ address: 'scout@org.example', vaults: [] });
    // The key is set once. A different one is refused.
    const other = await generateStaffKeypair();
    expect((await asAgent(token, '/api/agent/key', { method: 'PUT', body: JSON.stringify({ suite: 'keep-v1', public_key: other.publicKey }) })).status).toBe(409);
  });

  it('a person and an agent never share an address or a vault', async () => {
    const mz = await person('rosa@org.example');
    await enrol(mz);
    const { pair } = await brokeredAgent('scout@org.example');
    // The agent's address cannot enrol as a person, so no person vault can wrap to it.
    const posing = await person('scout@org.example');
    const enrolled = await posing.call('/api/keys/me', {
      method: 'PUT',
      body: JSON.stringify({ suite: 'keep-v1', public_key: pair.publicKey, wrapped_private_key: { iv: 'AAAAAAAAAAAAAAAA', ciphertext: 'AAAA' }, wrap: { method: 'passphrase', pbkdf2_salt: 'AAAA', pbkdf2_iterations: 600000 } }),
    });
    expect(enrolled.status).toBe(409);
    const { vault, key } = await makeVault(mz, 'Client A');
    const grant = await mz.call(`/api/vaults/${vault.id}/members`, {
      method: 'POST',
      body: JSON.stringify({ email: 'scout@org.example', wrapped_key: await wrapKeyToPublicKey(key, pair.publicKey) }),
    });
    expect(grant.status).toBe(400);
    expect(await grant.json()).toMatchObject({ code: 'not_enrolled' });

    // A machine vault has one member, its agent; a person route never sees it.
    const machine = await machineVault(mz, 'scout@org.example', pair.publicKey);
    expect((await mz.call(`/api/vaults/${machine.id}`)).status).toBe(404);
    expect((await posing.call(`/api/vaults/${machine.id}`)).status).toBe(404);
    expect((await mz.call(`/api/vaults/${machine.id}/members`, { method: 'POST', body: JSON.stringify({ email: mz.email, wrapped_key: await wrapKeyToPublicKey(generateVaultKey(), mz.pair.publicKey) }) })).status).toBe(404);
    expect((await mz.call(`/api/recovery/vaults/${machine.id}/join`, { method: 'POST', body: JSON.stringify({ wrapped_key: await wrapKeyToPublicKey(generateVaultKey(), mz.pair.publicKey) }) })).status).toBe(404);
    expect((await (await mz.call('/api/vaults')).json<{ vaults: Array<{ id: string }> }>()).vaults.map((entry) => entry.id)).toEqual([vault.id]);
  });

  it('people write to a machine vault, nobody reads it through keep-api, and only the agent key opens it', async () => {
    const mz = await person('rosa@org.example');
    await enrol(mz);
    const { token, pair } = await brokeredAgent('scout@org.example');
    const vault = await machineVault(mz, 'scout@org.example', pair.publicKey);
    expect(vault).toMatchObject({ machine: true, agent_member: true, key_version: 1, agent: { address: 'scout@org.example' } });

    const itemId = uuid();
    const body = { username: '', password: 'sk-live-123', url: 'https://api.vendor.test', notes: '', totp: '' };
    const created = await mz.call(`/api/machine-vaults/${vault.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ id: itemId, name: 'Vendor key', kind: 'api_key', key_version: 1, ...(await sealToAgent(vault, itemId, body)) }),
    });
    expect(created.status).toBe(201);

    // The lists carry no ciphertext and no wrap.
    for (const response of [await mz.call(`/api/machine-vaults/${vault.id}`), await mz.call('/api/machine-vaults'), await asAgent(token, '/api/agent/me')]) {
      const text = await response.text();
      expect(text).not.toContain('ciphertext');
      expect(text).not.toContain('ephemeral_public_key');
    }
    // No reveal: not on the person route, not on a machine route, not for the agent.
    expect((await mz.call(`/api/vaults/${vault.id}/items/${itemId}`)).status).toBe(404);
    expect((await mz.call(`/api/machine-vaults/${vault.id}/items/${itemId}`)).status).toBe(404);
    expect((await asAgent(token, `/api/vaults/${vault.id}/items/${itemId}`)).status).toBe(404);

    // What is stored opens with the agent's private key, and with no other.
    const row = await env.DB.prepare('SELECT iv, ciphertext, wrapped_key FROM items WHERE id = ?').bind(itemId).first<{ iv: string; ciphertext: string; wrapped_key: string }>();
    const wrap = JSON.parse(row!.wrapped_key) as WrappedToPublicKey;
    const itemKey = await importVaultKey(await unwrapKeyWithPrivateKey(wrap, pair.privateKey, pair.publicKey));
    expect(await openItem(itemKey, vault.id, itemId, 1, { iv: row!.iv, ciphertext: row!.ciphertext })).toEqual(body);
    await expect(unwrapKeyWithPrivateKey(wrap, mz.pair.privateKey, mz.pair.publicKey)).rejects.toThrow();
    await expect(openItem(itemKey, vault.id, uuid(), 1, { iv: row!.iv, ciphertext: row!.ciphertext })).rejects.toThrow();

    const trail = await (await mz.call(`/api/machine-vaults/${vault.id}/audit`)).json<{ events: Array<{ kind: string; actor: string }> }>();
    expect(trail.events.find((event) => event.kind === 'item.create')?.actor).toBe('rosa@org.example');
  });

  it('revoke ends the agent: its token dies, its key and membership go, old writes are stale', async () => {
    const mz = await person('rosa@org.example');
    await enrol(mz);
    const { token, pair } = await brokeredAgent('scout@org.example');
    const vault = await machineVault(mz, 'scout@org.example', pair.publicKey);
    const revoked = await mz.call(`/api/machine-vaults/${vault.id}/revoke`, { method: 'POST' });
    expect(revoked.status).toBe(200);
    expect(await revoked.json<MachineVaultDetail>()).toMatchObject({ key_version: 2, agent_member: false, agent: { public_key: null } });
    expect((await asAgent(token, '/api/agent/me')).status).toBe(401);

    const itemId = uuid();
    const late = await mz.call(`/api/machine-vaults/${vault.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ id: itemId, name: 'Late', kind: 'api_key', key_version: 1, ...(await sealToAgent(vault, itemId, { username: '', password: 'x', url: '', notes: '', totp: '' })) }),
    });
    expect(late.status).toBe(409);

    // A new token, a new key, a new grant at the new version.
    const next = await brokeredAgent('scout@org.example');
    const grant = await mz.call(`/api/machine-vaults/${vault.id}/agent`, {
      method: 'POST',
      body: JSON.stringify({ wrapped_key: await wrapKeyToPublicKey(generateVaultKey(), next.pair.publicKey) }),
    });
    expect(grant.status).toBe(201);
    expect(await grant.json<MachineVaultDetail>()).toMatchObject({ key_version: 2, agent_member: true });
  });
});

describe('who can use it', () => {
  it('lists members with their last use, to members only, and carries no wrap or ciphertext', async () => {
    const mz = await person('rosa@org.example');
    const ana = await person('ana@org.example');
    const other = await person('other@org.example');
    await enrol(mz);
    await enrol(ana);
    await enrol(other);
    const { vault, key } = await makeVault(mz, 'Client A', [ana]);
    const itemId = uuid();
    await mz.call(`/api/vaults/${vault.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ id: itemId, name: 'Login', kind: 'login', key_version: 1, sealed: await sealItem(await importVaultKey(key), vault.id, itemId, 1, { username: 'u', password: 'p', url: '', notes: '', totp: '' }) }),
    });
    expect((await ana.call(`/api/vaults/${vault.id}/items/${itemId}`)).status).toBe(200);

    const response = await mz.call(`/api/vaults/${vault.id}/access?item=${itemId}`);
    const text = await response.text();
    expect(text).not.toContain('ciphertext');
    expect(text).not.toContain('ephemeral_public_key');
    const access = JSON.parse(text) as VaultAccess;
    expect(access.agents).toEqual([]);
    expect(access.releases).toEqual([]);
    expect(access.people.find((entry) => entry.address === ana.email)?.last_used_at).not.toBeNull();
    expect(access.people.find((entry) => entry.address === mz.email)?.last_used_at).toBeNull();

    expect((await other.call(`/api/vaults/${vault.id}/access`)).status).toBe(404);
    expect((await mz.call(`/api/vaults/${vault.id}/access?item=${uuid()}`)).status).toBe(404);
  });
});

describe('attended releases', () => {
  const body = { username: 'ops', password: 'hunter2-value', url: 'https://vendor.test', notes: '', totp: '' };

  /** A person's vault with one item, an agent Keep knows, and a session key pair the agent made. */
  async function setup() {
    const mz = await person('rosa@org.example');
    const ana = await person('ana@org.example');
    const other = await person('other@org.example');
    await enrol(mz);
    await enrol(ana);
    await enrol(other);
    const { vault, key } = await makeVault(mz, 'Client A', [ana]);
    const itemId = uuid();
    const created = await mz.call(`/api/vaults/${vault.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ id: itemId, name: 'Vendor login', kind: 'login', key_version: 1, sealed: await sealItem(await importVaultKey(key), vault.id, itemId, 1, body) }),
    });
    expect(created.status).toBe(201);
    const token = await agentToken('scout@org.example');
    const otherToken = await agentToken('herald@org.example', 'Comms');
    const session = await generateStaffKeypair();
    return { mz, ana, other, vault, key, itemId, token, otherToken, session };
  }

  /** The approving device: open the item, seal it to the session key, post the release. */
  async function approve(
    who: Person,
    ctx: Awaited<ReturnType<typeof setup>>,
    releaseId = uuid(),
    seconds = 900,
    reader: Person = ctx.mz,
  ): Promise<Response> {
    const reveal = await reader.call(`/api/vaults/${ctx.vault.id}/items/${ctx.itemId}`);
    const detail = await reveal.json<{ sealed: { iv: string; ciphertext: string } }>();
    const opened = await openItem(await importVaultKey(ctx.key), ctx.vault.id, ctx.itemId, 1, detail.sealed);
    const payload = await sealRelease(opened, ctx.session.publicKey, releaseId, ctx.vault.id, ctx.itemId);
    return who.call(`/api/vaults/${ctx.vault.id}/releases`, {
      method: 'POST',
      body: JSON.stringify({
        id: releaseId,
        item_id: ctx.itemId,
        agent: 'scout@org.example',
        task: 'Renew the vendor certificate',
        session_public_key: ctx.session.publicKey,
        expires_in_seconds: seconds,
        ...payload,
      }),
    });
  }

  it('the named agent fetches once, opens it with its session key, and the trail names everyone', async () => {
    const ctx = await setup();
    const releaseId = uuid();
    const approved = await approve(ctx.ana, ctx, releaseId);
    expect(approved.status).toBe(201);
    expect(await approved.json<ReleaseSummary>()).toMatchObject({ status: 'live', approver: ctx.ana.email, agent: { address: 'scout@org.example' } });

    const first = await asAgent(ctx.token, `/api/agent/releases/${releaseId}/fetch`, { method: 'POST' });
    expect(first.status).toBe(200);
    const payload = await first.json<ReleasePayload>();
    expect(payload.release).toMatchObject({ vault_id: ctx.vault.id, item_id: ctx.itemId, status: 'used' });
    expect(await openRelease(payload, ctx.session.privateKey, ctx.session.publicKey, releaseId, ctx.vault.id, ctx.itemId)).toEqual(body);
    // Bound to its release: the same payload does not open as another one.
    await expect(openRelease(payload, ctx.session.privateKey, ctx.session.publicKey, uuid(), ctx.vault.id, ctx.itemId)).rejects.toThrow();

    // One fetch: the second is refused, and the stored payload is gone.
    const second = await asAgent(ctx.token, `/api/agent/releases/${releaseId}/fetch`, { method: 'POST' });
    expect(second.status).toBe(410);
    expect(await second.json()).toMatchObject({ code: 'release_closed' });
    const row = await env.DB.prepare('SELECT iv, ciphertext, wrapped_key FROM releases WHERE id = ?').bind(releaseId).first();
    expect(row).toEqual({ iv: null, ciphertext: null, wrapped_key: null });

    const trail = await (await ctx.mz.call(`/api/vaults/${ctx.vault.id}/audit`)).json<{ events: Array<{ kind: string; actor: string; detail: Record<string, unknown> | null }> }>();
    const approval = trail.events.filter((event) => event.kind === 'release.approve');
    const uses = trail.events.filter((event) => event.kind === 'item.use');
    expect(approval).toHaveLength(1);
    expect(approval[0]).toMatchObject({ actor: ctx.ana.email, detail: { agent: 'scout@org.example', approver: ctx.ana.email, task: 'Renew the vendor certificate' } });
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ actor: 'scout@org.example', detail: { approver: ctx.ana.email, task: 'Renew the vendor certificate' } });
  });

  it('refuses a fetch after the expiry and after an early end', async () => {
    const ctx = await setup();
    const expiring = uuid();
    expect((await approve(ctx.mz, ctx, expiring, 60)).status).toBe(201);
    await env.DB.prepare(`UPDATE releases SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).bind(expiring).run();
    expect((await asAgent(ctx.token, `/api/agent/releases/${expiring}/fetch`, { method: 'POST' })).status).toBe(410);

    const ended = uuid();
    expect((await approve(ctx.mz, ctx, ended)).status).toBe(201);
    const end = await ctx.ana.call(`/api/vaults/${ctx.vault.id}/releases/${ended}/end`, { method: 'POST' });
    expect(end.status).toBe(200);
    expect(await end.json<ReleaseSummary>()).toMatchObject({ status: 'ended', ended_by: ctx.ana.email });
    expect((await asAgent(ctx.token, `/api/agent/releases/${ended}/fetch`, { method: 'POST' })).status).toBe(410);
    const row = await env.DB.prepare('SELECT ciphertext, wrapped_key FROM releases WHERE id = ?').bind(ended).first();
    expect(row).toEqual({ ciphertext: null, wrapped_key: null });
    // Ending twice is one act: one audit row.
    await ctx.mz.call(`/api/vaults/${ctx.vault.id}/releases/${ended}/end`, { method: 'POST' });
    const trail = await (await ctx.mz.call(`/api/vaults/${ctx.vault.id}/audit`)).json<{ events: Array<{ kind: string; actor: string }> }>();
    expect(trail.events.filter((event) => event.kind === 'release.end')).toEqual([expect.objectContaining({ actor: ctx.ana.email })]);
  });

  it('only the named agent, and only a member of a person’s vault', async () => {
    const ctx = await setup();
    const releaseId = uuid();
    // A non-member cannot approve, read or end; a machine vault takes no release.
    expect((await approve(ctx.other, ctx, releaseId)).status).toBe(404);
    expect((await approve(ctx.mz, ctx, releaseId)).status).toBe(201);
    expect((await ctx.other.call(`/api/vaults/${ctx.vault.id}/releases/${releaseId}`)).status).toBe(404);
    expect((await ctx.other.call(`/api/vaults/${ctx.vault.id}/releases/${releaseId}/end`, { method: 'POST' })).status).toBe(404);
    const agentPair = await generateStaffKeypair();
    expect((await asAgent(ctx.token, '/api/agent/key', { method: 'PUT', body: JSON.stringify({ suite: 'keep-v1', public_key: agentPair.publicKey }) })).status).toBe(200);
    const machine = await ctx.mz.call('/api/machine-vaults', {
      method: 'POST',
      body: JSON.stringify({ name: 'Vocab keys', agent: 'scout@org.example', wrapped_key: await wrapKeyToPublicKey(generateVaultKey(), agentPair.publicKey) }),
    });
    const machineId = (await machine.json<MachineVaultDetail>()).id;
    expect((await ctx.mz.call(`/api/vaults/${machineId}/releases`, { method: 'POST', body: JSON.stringify({}) })).status).toBe(404);

    // Another agent, and a person, reach nothing of it.
    expect((await asAgent(ctx.otherToken, `/api/agent/releases/${releaseId}`)).status).toBe(404);
    expect((await asAgent(ctx.otherToken, `/api/agent/releases/${releaseId}/fetch`, { method: 'POST' })).status).toBe(404);
    expect((await ctx.mz.call(`/api/agent/releases/${releaseId}/fetch`, { method: 'POST' })).status).toBe(404);
    // The other agent's attempt did not use it up.
    expect((await asAgent(ctx.token, `/api/agent/releases/${releaseId}/fetch`, { method: 'POST' })).status).toBe(200);
  });

  it('no list carries the value, the sealed body or the wrap', async () => {
    const ctx = await setup();
    const releaseId = uuid();
    expect((await approve(ctx.mz, ctx, releaseId)).status).toBe(201);
    const responses = [
      await ctx.mz.call(`/api/vaults/${ctx.vault.id}/access`),
      await ctx.mz.call(`/api/vaults/${ctx.vault.id}/access?item=${ctx.itemId}`),
      await ctx.mz.call(`/api/vaults/${ctx.vault.id}/releases/${releaseId}`),
      await ctx.mz.call(`/api/vaults/${ctx.vault.id}/audit`),
      await ctx.mz.call('/api/audit'),
      await asAgent(ctx.token, `/api/agent/releases/${releaseId}`),
      await asAgent(ctx.token, '/api/agent/me'),
    ];
    for (const response of responses) {
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain('ciphertext');
      expect(text).not.toContain('ephemeral_public_key');
      expect(text).not.toContain(body.password);
    }
    const access = await (await ctx.mz.call(`/api/vaults/${ctx.vault.id}/access`)).json<VaultAccess>();
    expect(access.releases).toEqual([expect.objectContaining({ id: releaseId, approver: ctx.mz.email, last_used_at: null })]);
  });
});
