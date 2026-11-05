// Lifted from Meet's control-plane so both services hash, seal and compare the
// same way. The one addition here is `sha256Hex` — signatures commit to a hex
// digest because that is what a person can read off an audit certificate and
// re-compute with `shasum -a 256`.

const encoder = new TextEncoder();

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64URL(value);
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** Numeric code for email verification. Uniform over 000000–999999. */
export function numericCode(digits = 6): string {
  const max = 10 ** digits;
  const buffer = new Uint32Array(1);
  // Reject the tail of the uint32 range so small codes are not over-represented.
  const limit = Math.floor(0xffff_ffff / max) * max;
  let value = 0;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0]!;
  } while (value >= limit);
  return String(value % max).padStart(digits, '0');
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return base64URL(new Uint8Array(digest));
}

export async function sha256Hex(value: string | ArrayBuffer | Uint8Array): Promise<string> {
  const data = typeof value === 'string' ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return hex(new Uint8Array(digest));
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

export async function hmacSHA256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return hex(new Uint8Array(signature));
}

export function signingKey(secret: string): Uint8Array {
  if (secret.length < 32) throw new Error('SESSION_SIGNING_SECRET must contain at least 32 characters.');
  return encoder.encode(secret);
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64URL(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export { hex as toHex };
