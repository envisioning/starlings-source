// @keep/crypto — every operation that touches a key.
//
// This module is the trusted computing base of Keep. It runs in the
// browser (and in Node for tests and any future CLI); it never runs in the
// Worker. Read it with the suite in mind:
//
//   staff keypair     ECDH P-256. Universally supported in WebCrypto; X25519
//                     would be nicer and is not yet everywhere.
//   wrap to a person  ECIES: ephemeral P-256 → ECDH → HKDF-SHA256 → AES-256-GCM.
//                     The recipient's public key is the AAD, so a wrap
//                     re-addressed to another key fails to open.
//   private key       PKCS#8, AES-256-GCM under a wrapping key from either a
//                     passkey's PRF output (HKDF) or a passphrase (PBKDF2).
//   vault key         32 random bytes, AES-256-GCM.
//   item              JSON body, AES-256-GCM under the vault key, AAD =
//                     `${vault_id}:${item_id}:${key_version}` so a row cannot
//                     be moved between vaults or versions.
//   recovery          the private half XOR-split into two shares. Both, or
//                     nothing.
//   release           one item body under a one-time key, AAD =
//                     `release:${release_id}:${vault_id}:${item_id}`; the key
//                     wrapped to an agent's session public key.
//
// Nothing here logs, throws a plaintext in a message, or keeps a key past
// the call — holding keys in memory is the caller's job (see web/src/session.ts).

import {
  CRYPTO_SUITE,
  PBKDF2_ITERATIONS,
  PRF_SALT_LABEL,
  itemBodySchema,
  type ItemBody,
  type Sealed,
  type WrapParams,
  type WrappedToPublicKey,
} from '@keep/contracts';

const subtle = crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CURVE = 'P-256';
const HKDF_INFO_WRAP = `${CRYPTO_SUITE}/wrap-to-public-key`;
const HKDF_INFO_PRF = `${CRYPTO_SUITE}/prf-wrapping-key`;

export { CRYPTO_SUITE, PBKDF2_ITERATIONS, PRF_SALT_LABEL };

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export function toBase64URL(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function fromBase64URL(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** The PRF salt every enrolment and unlock passes to the authenticator. */
export function prfSalt(): Uint8Array {
  return encoder.encode(PRF_SALT_LABEL);
}

// ---------------------------------------------------------------------------
// AES-GCM primitives
// ---------------------------------------------------------------------------

async function importAESKey(raw: Uint8Array, usages: Array<'encrypt' | 'decrypt'> = ['encrypt', 'decrypt']): Promise<CryptoKey> {
  if (raw.byteLength !== 32) throw new Error('AES-256 key must be 32 bytes.');
  return subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, usages);
}

async function seal(key: CryptoKey, plaintext: Uint8Array, aad: Uint8Array): Promise<Sealed> {
  const iv = randomBytes(12);
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
    key,
    plaintext as BufferSource,
  );
  return { iv: toBase64URL(iv), ciphertext: toBase64URL(ciphertext) };
}

async function open(key: CryptoKey, sealed: Sealed, aad: Uint8Array): Promise<Uint8Array> {
  try {
    const plaintext = await subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64URL(sealed.iv) as BufferSource, additionalData: aad as BufferSource, tagLength: 128 },
      key,
      fromBase64URL(sealed.ciphertext) as BufferSource,
    );
    return new Uint8Array(plaintext);
  } catch {
    // WebCrypto's error carries nothing useful and we must not add anything.
    throw new KeepCryptoError('Could not open: wrong key or tampered data.');
  }
}

export class KeepCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeepCryptoError';
  }
}

// ---------------------------------------------------------------------------
// Staff keypair
// ---------------------------------------------------------------------------

export interface StaffKeypair {
  /** Raw uncompressed point, base64url. What the directory publishes. */
  publicKey: string;
  privateKey: CryptoKey;
}

export async function generateStaffKeypair(): Promise<StaffKeypair> {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: CURVE }, true, ['deriveBits'])) as CryptoKeyPair;
  const raw = (await subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer;
  return { publicKey: toBase64URL(raw), privateKey: pair.privateKey };
}

export async function exportPrivateKey(privateKey: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array((await subtle.exportKey('pkcs8', privateKey)) as ArrayBuffer);
}

export async function importPrivateKey(pkcs8: Uint8Array, extractable = false): Promise<CryptoKey> {
  return subtle.importKey('pkcs8', pkcs8 as BufferSource, { name: 'ECDH', namedCurve: CURVE }, extractable, ['deriveBits']);
}

async function importPublicKey(raw: string): Promise<CryptoKey> {
  return subtle.importKey('raw', fromBase64URL(raw) as BufferSource, { name: 'ECDH', namedCurve: CURVE }, true, []);
}

// ---------------------------------------------------------------------------
// Wrapping the private key — passkey PRF or passphrase
// ---------------------------------------------------------------------------

export interface WrappedPrivateKey {
  wrapped: Sealed;
  wrap: WrapParams;
}

/** The PRF output is 32 bytes from the authenticator; HKDF it with a per-enrolment salt. */
export async function wrappingKeyFromPRF(prfOutput: Uint8Array, hkdfSalt: Uint8Array): Promise<CryptoKey> {
  const material = await subtle.importKey('raw', prfOutput as BufferSource, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt as BufferSource, info: encoder.encode(HKDF_INFO_PRF) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function wrappingKeyFromPassphrase(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  if (iterations < PBKDF2_ITERATIONS) throw new Error('PBKDF2 iterations below the floor.');
  const material = await subtle.importKey('raw', encoder.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

const PRIVATE_KEY_AAD = encoder.encode(`${CRYPTO_SUITE}/staff-private-key`);

export async function wrapPrivateKeyWithPRF(privateKey: CryptoKey, prfOutput: Uint8Array, credentialId: string): Promise<WrappedPrivateKey> {
  const hkdfSalt = randomBytes(32);
  const wrappingKey = await wrappingKeyFromPRF(prfOutput, hkdfSalt);
  const wrapped = await seal(wrappingKey, await exportPrivateKey(privateKey), PRIVATE_KEY_AAD);
  return { wrapped, wrap: { method: 'prf', credential_id: credentialId, hkdf_salt: toBase64URL(hkdfSalt) } };
}

export async function wrapPrivateKeyWithPassphrase(privateKey: CryptoKey, passphrase: string): Promise<WrappedPrivateKey> {
  const salt = randomBytes(32);
  const wrappingKey = await wrappingKeyFromPassphrase(passphrase, salt, PBKDF2_ITERATIONS);
  const wrapped = await seal(wrappingKey, await exportPrivateKey(privateKey), PRIVATE_KEY_AAD);
  return { wrapped, wrap: { method: 'passphrase', pbkdf2_salt: toBase64URL(salt), pbkdf2_iterations: PBKDF2_ITERATIONS } };
}

export async function unwrapPrivateKey(wrappingKey: CryptoKey, wrapped: Sealed, extractable = false): Promise<CryptoKey> {
  const pkcs8 = await open(wrappingKey, wrapped, PRIVATE_KEY_AAD);
  return importPrivateKey(pkcs8, extractable);
}

// ---------------------------------------------------------------------------
// Wrapping a symmetric key to a public key (ECIES)
// ---------------------------------------------------------------------------

async function ecdhWrappingKey(privateKey: CryptoKey, publicKey: CryptoKey, ephemeralRaw: Uint8Array, recipientRaw: Uint8Array): Promise<CryptoKey> {
  // `public` is the DOM spelling; workers-types spells it `$public`. Both
  // runtimes read the DOM one, so widen the type rather than pick a side.
  const shared = await subtle.deriveBits({ name: 'ECDH', public: publicKey } as unknown as Parameters<typeof subtle.deriveBits>[0], privateKey, 256);
  const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const salt = new Uint8Array(ephemeralRaw.byteLength + recipientRaw.byteLength);
  salt.set(ephemeralRaw, 0);
  salt.set(recipientRaw, ephemeralRaw.byteLength);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: encoder.encode(HKDF_INFO_WRAP) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function wrapKeyToPublicKey(keyBytes: Uint8Array, recipientPublicKey: string): Promise<WrappedToPublicKey> {
  const recipient = await importPublicKey(recipientPublicKey);
  const recipientRaw = fromBase64URL(recipientPublicKey);
  const ephemeral = (await subtle.generateKey({ name: 'ECDH', namedCurve: CURVE }, true, ['deriveBits'])) as CryptoKeyPair;
  const ephemeralRaw = new Uint8Array((await subtle.exportKey('raw', ephemeral.publicKey)) as ArrayBuffer);
  const wrappingKey = await ecdhWrappingKey(ephemeral.privateKey, recipient, ephemeralRaw, recipientRaw);
  const sealed = await seal(wrappingKey, keyBytes, recipientRaw);
  return { ephemeral_public_key: toBase64URL(ephemeralRaw), ...sealed };
}

export async function unwrapKeyWithPrivateKey(wrapped: WrappedToPublicKey, privateKey: CryptoKey, ownPublicKey: string): Promise<Uint8Array> {
  const ephemeral = await importPublicKey(wrapped.ephemeral_public_key);
  const ephemeralRaw = fromBase64URL(wrapped.ephemeral_public_key);
  const ownRaw = fromBase64URL(ownPublicKey);
  const wrappingKey = await ecdhWrappingKey(privateKey, ephemeral, ephemeralRaw, ownRaw);
  return open(wrappingKey, { iv: wrapped.iv, ciphertext: wrapped.ciphertext }, ownRaw);
}

// ---------------------------------------------------------------------------
// Vault keys and items
// ---------------------------------------------------------------------------

export function generateVaultKey(): Uint8Array {
  return randomBytes(32);
}

export async function importVaultKey(raw: Uint8Array): Promise<CryptoKey> {
  return importAESKey(raw);
}

function itemAAD(vaultId: string, itemId: string, keyVersion: number): Uint8Array {
  return encoder.encode(`${vaultId}:${itemId}:${keyVersion}`);
}

export async function sealItem(vaultKey: CryptoKey, vaultId: string, itemId: string, keyVersion: number, body: ItemBody): Promise<Sealed> {
  const plaintext = encoder.encode(JSON.stringify(itemBodySchema.parse(body)));
  return seal(vaultKey, plaintext, itemAAD(vaultId, itemId, keyVersion));
}

export async function openItem(vaultKey: CryptoKey, vaultId: string, itemId: string, keyVersion: number, sealed: Sealed): Promise<ItemBody> {
  const plaintext = await open(vaultKey, sealed, itemAAD(vaultId, itemId, keyVersion));
  return itemBodySchema.parse(JSON.parse(decoder.decode(plaintext)));
}

// ---------------------------------------------------------------------------
// Attended releases — one item body to one agent session key
// ---------------------------------------------------------------------------

function releaseAAD(releaseId: string, vaultId: string, itemId: string): Uint8Array {
  return encoder.encode(`release:${releaseId}:${vaultId}:${itemId}`);
}

/**
 * The approving device's half: seal the opened body under a fresh release
 * key and wrap that key to the agent's session public key. The release key
 * is dropped with this call.
 */
export async function sealRelease(
  body: ItemBody,
  sessionPublicKey: string,
  releaseId: string,
  vaultId: string,
  itemId: string,
): Promise<{ sealed: Sealed; wrapped_key: WrappedToPublicKey }> {
  const releaseKey = randomBytes(32);
  const plaintext = encoder.encode(JSON.stringify(itemBodySchema.parse(body)));
  const sealed = await seal(await importAESKey(releaseKey), plaintext, releaseAAD(releaseId, vaultId, itemId));
  return { sealed, wrapped_key: await wrapKeyToPublicKey(releaseKey, sessionPublicKey) };
}

/** The agent's half: unwrap the release key with the session private key, then open the body. */
export async function openRelease(
  payload: { sealed: Sealed; wrapped_key: WrappedToPublicKey },
  sessionPrivateKey: CryptoKey,
  sessionPublicKey: string,
  releaseId: string,
  vaultId: string,
  itemId: string,
): Promise<ItemBody> {
  const releaseKey = await unwrapKeyWithPrivateKey(payload.wrapped_key, sessionPrivateKey, sessionPublicKey);
  const plaintext = await open(await importAESKey(releaseKey), payload.sealed, releaseAAD(releaseId, vaultId, itemId));
  return itemBodySchema.parse(JSON.parse(decoder.decode(plaintext)));
}

// ---------------------------------------------------------------------------
// Recovery — two shares, both required
// ---------------------------------------------------------------------------

/** XOR split: share A is random, share B = secret ⊕ A. Either alone is noise. */
export function splitSecret(secret: Uint8Array): [Uint8Array, Uint8Array] {
  const a = randomBytes(secret.byteLength);
  const b = new Uint8Array(secret.byteLength);
  for (let index = 0; index < secret.byteLength; index += 1) b[index] = secret[index]! ^ a[index]!;
  return [a, b];
}

export function joinShares(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.byteLength !== b.byteLength) throw new KeepCryptoError('Shares differ in length.');
  const secret = new Uint8Array(a.byteLength);
  for (let index = 0; index < a.byteLength; index += 1) secret[index] = a[index]! ^ b[index]!;
  return secret;
}

/** A share as a person stores it: prefixed so it is recognisable in a vault. */
export function formatShare(label: 'A' | 'B', share: Uint8Array): string {
  return `keep-recovery-${label}:${toBase64URL(share)}`;
}

export function parseShare(value: string): { label: 'A' | 'B'; share: Uint8Array } {
  const match = /^keep-recovery-([AB]):([A-Za-z0-9_-]+)$/u.exec(value.trim());
  if (!match) throw new KeepCryptoError('Not a Keep recovery share.');
  return { label: match[1] as 'A' | 'B', share: fromBase64URL(match[2]!) };
}

// ---------------------------------------------------------------------------
// Passphrases
// ---------------------------------------------------------------------------

/**
 * Five groups of four from a 32-letter alphabet with no look-alikes:
 * `xxxx-xxxx-xxxx-xxxx-xxxx`, 100 bits. Same shape as the Swift client's.
 */
const PASSPHRASE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function generatePassphrase(groups = 5, groupLength = 4): string {
  const bytes = randomBytes(groups * groupLength);
  const out: string[] = [];
  let index = 0;
  for (let g = 0; g < groups; g += 1) {
    let group = '';
    for (let c = 0; c < groupLength; c += 1) {
      group += PASSPHRASE_ALPHABET[bytes[index]! % PASSPHRASE_ALPHABET.length];
      index += 1;
    }
    out.push(group);
  }
  return out.join('-');
}
