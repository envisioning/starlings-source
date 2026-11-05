const encoder = new TextEncoder();

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64URL(value);
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return base64URL(new Uint8Array(digest));
}

/** SHA-256 as lower-case hex: the form event registration token hashes take on both stores. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

/**
 * Constant-time comparison for values that are already digests (equal length,
 * no secret-dependent length). Unlike constantTimeEqual this never awaits, so
 * a Durable Object can compare without releasing its input gate.
 */
export function constantTimeEqualSync(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

/**
 * Hex HMAC-SHA256, the wire format sibling Envisioning services expect on
 * `x-internal-signature` (Core verifies with node:crypto `.digest('hex')`).
 * A string secret is keyed as its UTF-8 bytes; raw bytes key as given (the
 * app channel door's hex-decoded `APP_INTAKE_KEY`).
 */
export async function hmacSHA256Hex(secret: string | Uint8Array<ArrayBuffer>, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    typeof secret === 'string' ? encoder.encode(secret) : secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** How far a signed request's timestamp (Unix ms) may be from now. */
export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

/**
 * A timestamped hex HMAC-SHA256: the timestamp is Unix ms within
 * `SIGNATURE_WINDOW_MS` of now, and `signature` is the HMAC of `message`
 * (which includes the timestamp), compared in constant time. Used by the
 * support line and the app channel door.
 */
export async function verifyTimedSignature(
  secret: string | Uint8Array<ArrayBuffer>,
  input: { timestamp: string; signature: string; message: string },
): Promise<boolean> {
  const sentAt = Number(input.timestamp);
  if (!input.timestamp || !Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > SIGNATURE_WINDOW_MS) return false;
  return constantTimeEqualSync(await hmacSHA256Hex(secret, input.message), input.signature.trim().toLowerCase());
}

export function signingKey(secret: string): Uint8Array {
  if (secret.length < 32) throw new Error('SESSION_SIGNING_SECRET must contain at least 32 characters.');
  return encoder.encode(secret);
}

function base64URL(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/**
 * Base64 HMAC-SHA256 over raw key bytes — the Standard Webhooks wire format
 * (`webhooks.fyi`), which Granola signs its deliveries with. Distinct from
 * `hmacSHA256Hex` in two ways that both matter: the key is decoded bytes
 * rather than the secret's characters, and the digest is base64 rather than
 * hex. Verifying with the wrong one silently never matches.
 */
export async function hmacSHA256Base64(keyBytes: Uint8Array, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  let binary = '';
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Decodes a base64 string to bytes. Throws on anything that is not base64. */
export function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Encodes bytes as standard base64. */
export function bytesBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A secret sealed with AES-GCM: a fresh IV and the ciphertext, both base64. */
export interface SealedSecret {
  iv: string;
  ciphertext: string;
}

/**
 * The AES-GCM key from a configured secret's text. SHA-256 of the text, so any
 * length of key material works and a stored record opens again after a deploy.
 */
async function sealingKey(keyMaterial: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyMaterial));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Seal a credential at rest: Google refresh tokens for Calendar and the connectors. */
export async function sealSecret(keyMaterial: string, plaintext: string): Promise<SealedSecret> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await sealingKey(keyMaterial),
    new TextEncoder().encode(plaintext),
  );
  return { iv: bytesBase64(iv), ciphertext: bytesBase64(new Uint8Array(ciphertext)) };
}

export async function openSecret(keyMaterial: string, sealed: SealedSecret): Promise<string> {
  const iv = base64Bytes(sealed.iv);
  const data = base64Bytes(sealed.ciphertext);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    await sealingKey(keyMaterial),
    data.buffer as ArrayBuffer,
  );
  return new TextDecoder().decode(plaintext);
}
