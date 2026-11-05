import { describe, expect, it } from 'vitest';
import {
  exportPrivateKey,
  fromBase64URL,
  generateStaffKeypair,
  generateVaultKey,
  importPrivateKey,
  importVaultKey,
  joinShares,
  openItem,
  parseShare,
  formatShare,
  randomBytes,
  sealItem,
  splitSecret,
  toBase64URL,
  unwrapKeyWithPrivateKey,
  unwrapPrivateKey,
  wrapKeyToPublicKey,
  wrapPrivateKeyWithPRF,
  wrapPrivateKeyWithPassphrase,
  wrappingKeyFromPRF,
  wrappingKeyFromPassphrase,
} from './index';

const body = { username: 'ops@client.example', password: 'hunter2', url: 'https://db.client.example', notes: '', totp: '' };

describe('encoding', () => {
  it('round-trips base64url', () => {
    const bytes = randomBytes(37);
    expect(fromBase64URL(toBase64URL(bytes))).toEqual(bytes);
  });
});

describe('items', () => {
  it('seals and opens under the vault key with the row as AAD', async () => {
    const key = await importVaultKey(generateVaultKey());
    const sealed = await sealItem(key, 'v1', 'i1', 1, body);
    expect(await openItem(key, 'v1', 'i1', 1, sealed)).toEqual(body);
  });

  it('refuses a row moved to another vault, item or key version', async () => {
    const key = await importVaultKey(generateVaultKey());
    const sealed = await sealItem(key, 'v1', 'i1', 1, body);
    await expect(openItem(key, 'v2', 'i1', 1, sealed)).rejects.toThrow(/Could not open/u);
    await expect(openItem(key, 'v1', 'i2', 1, sealed)).rejects.toThrow(/Could not open/u);
    await expect(openItem(key, 'v1', 'i1', 2, sealed)).rejects.toThrow(/Could not open/u);
  });

  it('refuses a tampered ciphertext', async () => {
    const key = await importVaultKey(generateVaultKey());
    const sealed = await sealItem(key, 'v1', 'i1', 1, body);
    const bytes = fromBase64URL(sealed.ciphertext);
    bytes[0] = bytes[0]! ^ 0xff;
    await expect(openItem(key, 'v1', 'i1', 1, { ...sealed, ciphertext: toBase64URL(bytes) })).rejects.toThrow();
  });

  it('refuses the wrong vault key', async () => {
    const key = await importVaultKey(generateVaultKey());
    const other = await importVaultKey(generateVaultKey());
    const sealed = await sealItem(key, 'v1', 'i1', 1, body);
    await expect(openItem(other, 'v1', 'i1', 1, sealed)).rejects.toThrow();
  });
});

describe('wrapping to a public key', () => {
  it('only the holder of the private key opens it', async () => {
    const alice = await generateStaffKeypair();
    const bob = await generateStaffKeypair();
    const vaultKey = generateVaultKey();
    const wrapped = await wrapKeyToPublicKey(vaultKey, alice.publicKey);
    expect(await unwrapKeyWithPrivateKey(wrapped, alice.privateKey, alice.publicKey)).toEqual(vaultKey);
    await expect(unwrapKeyWithPrivateKey(wrapped, bob.privateKey, bob.publicKey)).rejects.toThrow();
  });

  it('refuses a wrap re-addressed to a different public key', async () => {
    const alice = await generateStaffKeypair();
    const bob = await generateStaffKeypair();
    const wrapped = await wrapKeyToPublicKey(generateVaultKey(), alice.publicKey);
    // Bob presents Alice's blob with his own key material: AAD mismatch.
    await expect(unwrapKeyWithPrivateKey(wrapped, alice.privateKey, bob.publicKey)).rejects.toThrow();
  });
});

describe('wrapping the private key', () => {
  it('round-trips through a passphrase', async () => {
    const pair = await generateStaffKeypair();
    const { wrapped, wrap } = await wrapPrivateKeyWithPassphrase(pair.privateKey, 'correct horse battery staple');
    if (wrap.method !== 'passphrase') throw new Error('unexpected method');
    const wrappingKey = await wrappingKeyFromPassphrase('correct horse battery staple', fromBase64URL(wrap.pbkdf2_salt), wrap.pbkdf2_iterations);
    const restored = await unwrapPrivateKey(wrappingKey, wrapped);
    // Same key: something wrapped to the public half opens with the restored private half.
    const vaultKey = generateVaultKey();
    const toAlice = await wrapKeyToPublicKey(vaultKey, pair.publicKey);
    expect(await unwrapKeyWithPrivateKey(toAlice, restored, pair.publicKey)).toEqual(vaultKey);

    const wrong = await wrappingKeyFromPassphrase('incorrect horse', fromBase64URL(wrap.pbkdf2_salt), wrap.pbkdf2_iterations);
    await expect(unwrapPrivateKey(wrong, wrapped)).rejects.toThrow();
  }, 20_000);

  it('round-trips through a PRF output', async () => {
    const pair = await generateStaffKeypair();
    const prf = randomBytes(32);
    const { wrapped, wrap } = await wrapPrivateKeyWithPRF(pair.privateKey, prf, 'cred-1');
    if (wrap.method !== 'prf') throw new Error('unexpected method');
    const restored = await unwrapPrivateKey(await wrappingKeyFromPRF(prf, fromBase64URL(wrap.hkdf_salt)), wrapped);
    const pkcs8 = await exportPrivateKey(await importPrivateKey(await exportPrivateKey(pair.privateKey), true));
    expect(restored.type).toBe('private');
    expect(pkcs8.byteLength).toBeGreaterThan(0);
  });
});

describe('recovery shares', () => {
  it('needs both shares', () => {
    const secret = randomBytes(138);
    const [a, b] = splitSecret(secret);
    expect(joinShares(a, b)).toEqual(secret);
    expect(joinShares(a, a)).not.toEqual(secret);
    const parsedA = parseShare(formatShare('A', a));
    const parsedB = parseShare(formatShare('B', b));
    expect(joinShares(parsedA.share, parsedB.share)).toEqual(secret);
  });
});

// The checked-in vectors are what the Swift client is tested against. This
// keeps the TypeScript side honest about them too.
describe('vectors.json', () => {
  it('opens under this implementation', async () => {
    const vectors = (await import('./vectors.json', { with: { type: 'json' } })).default;
    const vaultKey = await importVaultKey(fromBase64URL(vectors.vault.key));
    expect(await openItem(vaultKey, vectors.vault.id, vectors.item.id, vectors.vault.key_version, vectors.item.sealed)).toEqual(vectors.item.body);
    const recipient = await importPrivateKey(fromBase64URL(vectors.recipient.private_key_pkcs8));
    expect(await unwrapKeyWithPrivateKey(vectors.vault.wrapped_to_recipient, recipient, vectors.recipient.public_key)).toEqual(
      fromBase64URL(vectors.vault.key),
    );
    const wrap = vectors.passphrase.wrap as { pbkdf2_salt: string; pbkdf2_iterations: number };
    const wrappingKey = await wrappingKeyFromPassphrase(vectors.passphrase.value, fromBase64URL(wrap.pbkdf2_salt), wrap.pbkdf2_iterations);
    const restored = await unwrapPrivateKey(wrappingKey, vectors.passphrase.wrapped);
    expect(restored.type).toBe('private');
    const prfWrap = vectors.prf.wrap as { hkdf_salt: string };
    const prfKey = await wrappingKeyFromPRF(fromBase64URL(vectors.prf.output), fromBase64URL(prfWrap.hkdf_salt));
    expect((await unwrapPrivateKey(prfKey, vectors.prf.wrapped)).type).toBe('private');
  }, 20_000);
});
