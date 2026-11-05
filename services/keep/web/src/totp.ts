// RFC 6238 time-based one-time codes, from an otpauth:// URI or a bare
// base32 secret. Computed in the browser from the sealed secret; the
// server never sees the secret or a code. Mirrors KeepKit's `KeepTOTP`.

export interface TOTP {
  secret: Uint8Array;
  digits: number;
  period: number;
  algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512';
  issuer: string | null;
  account: string | null;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(text: string): Uint8Array | null {
  const cleaned = text.toUpperCase().replace(/[\s=-]/gu, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function parseTOTP(text: string): TOTP | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase().startsWith('otpauth://')) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (url.host.toLowerCase() !== 'totp') return null;
    const secret = base32Decode(url.searchParams.get('secret') ?? '');
    if (!secret || secret.length === 0) return null;
    const label = decodeURIComponent(url.pathname.replace(/^\//u, ''));
    const parts = label.split(':', 2).map((part) => part.trim());
    const algorithmParam = (url.searchParams.get('algorithm') ?? 'SHA1').toUpperCase();
    const algorithm = algorithmParam === 'SHA256' ? 'SHA-256' : algorithmParam === 'SHA512' ? 'SHA-512' : 'SHA-1';
    return {
      secret,
      digits: Number(url.searchParams.get('digits')) || 6,
      period: Number(url.searchParams.get('period')) || 30,
      algorithm,
      issuer: url.searchParams.get('issuer') ?? (parts.length === 2 ? parts[0]! : null),
      account: parts.length === 2 ? parts[1]! : parts[0] || null,
    };
  }
  const secret = base32Decode(trimmed);
  if (!secret || secret.length === 0) return null;
  return { secret, digits: 6, period: 30, algorithm: 'SHA-1', issuer: null, account: null };
}

export function totpURI(totp: TOTP): string {
  const label = [totp.issuer, totp.account].filter(Boolean).join(':') || 'Keep';
  const params = new URLSearchParams({ secret: base32Encode(totp.secret) });
  if (totp.issuer) params.set('issuer', totp.issuer);
  if (totp.algorithm !== 'SHA-1') params.set('algorithm', totp.algorithm.replace('-', ''));
  if (totp.digits !== 6) params.set('digits', String(totp.digits));
  if (totp.period !== 30) params.set('period', String(totp.period));
  return `otpauth://totp/${encodeURIComponent(label)}?${params}`;
}

export async function totpCode(totp: TOTP, at = Date.now()): Promise<string> {
  const counter = Math.floor(at / 1000 / totp.period);
  const message = new Uint8Array(8);
  new DataView(message.buffer).setUint32(4, counter >>> 0);
  new DataView(message.buffer).setUint32(0, Math.floor(counter / 2 ** 32));
  const key = await crypto.subtle.importKey('raw', totp.secret as BufferSource, { name: 'HMAC', hash: totp.algorithm }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** totp.digits).padStart(totp.digits, '0');
}

export function totpSecondsRemaining(totp: TOTP, at = Date.now()): number {
  return totp.period - (Math.floor(at / 1000) % totp.period);
}

/**
 * Read a QR code out of an image, when the browser can (`BarcodeDetector`:
 * Chrome, Edge, Safari 17+ on Apple silicon). Null when it cannot or there
 * is none; the caller falls back to paste.
 */
export async function decodeQR(file: Blob): Promise<string | null> {
  const Detector = (globalThis as { BarcodeDetector?: new (options: { formats: string[] }) => { detect(source: ImageBitmap): Promise<Array<{ rawValue: string }>> } })
    .BarcodeDetector;
  if (!Detector) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const codes = await new Detector({ formats: ['qr_code'] }).detect(bitmap);
    return codes[0]?.rawValue ?? null;
  } catch {
    return null;
  }
}

export function qrDecodeSupported(): boolean {
  return 'BarcodeDetector' in globalThis;
}
