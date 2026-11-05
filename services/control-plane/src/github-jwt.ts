// The GitHub App's JWT (docs/GITHUB_CONNECTOR.md "One App, one broker"). Only
// the token broker in the auth Worker signs one: it is the one Worker that
// holds the App's private key. A workspace Worker never imports this file.

function base64url(bytes: ArrayBuffer | Uint8Array | string): string {
  const raw = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  let binary = '';
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function pemBody(pem: string): Uint8Array {
  const body = pem.replace(/-----[A-Z ]+-----/gu, '').replace(/\s+/gu, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * GitHub hands out the key as PKCS#1 (`BEGIN RSA PRIVATE KEY`), and WebCrypto
 * imports only PKCS#8. The difference is one fixed header wrapping the same
 * DER, so wrap rather than convert by hand.
 */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const derLength = (length: number): number[] => {
    if (length < 0x80) return [length];
    const bytes: number[] = [];
    let remaining = length;
    while (remaining > 0) { bytes.unshift(remaining & 0xff); remaining >>= 8; }
    return [0x80 | bytes.length, ...bytes];
  };
  // version INTEGER 0, AlgorithmIdentifier rsaEncryption with NULL params.
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length)];
  const inner = [0x02, 0x01, 0x00, ...algorithm, ...octet];
  const total = inner.length + pkcs1.length;
  return new Uint8Array([0x30, ...derLength(total), ...inner, ...pkcs1]);
}

async function importAppKey(pem: string): Promise<CryptoKey> {
  const raw = pemBody(pem);
  const der = /BEGIN RSA PRIVATE KEY/u.test(pem) ? pkcs1ToPkcs8(raw) : raw;
  return crypto.subtle.importKey('pkcs8', der.buffer as ArrayBuffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/** A ten-minute App JWT, issued a minute in the past for clock skew. */
export async function githubAppJwt(appId: number | string, pem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const key = await importAppKey(pem);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(signature)}`;
}
