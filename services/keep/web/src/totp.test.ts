import { describe, expect, it } from 'vitest';
import { parseTOTP, totpCode, totpSecondsRemaining, totpURI } from './totp';

const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totp', () => {
  it('matches RFC 6238 SHA-1 vectors', async () => {
    const totp = parseTOTP(`otpauth://totp/RFC:test?secret=${rfcSecret}&digits=8`)!;
    expect(await totpCode(totp, 59_000)).toBe('94287082');
    expect(await totpCode(totp, 1_111_111_109_000)).toBe('07081804');
    expect(await totpCode(totp, 1_234_567_890_000)).toBe('89005924');
    expect(await totpCode(totp, 20_000_000_000_000)).toBe('65353130');
  });

  it('accepts a bare secret with spaces and round-trips the uri', async () => {
    const totp = parseTOTP('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')!;
    expect(await totpCode(totp, 59_000)).toBe('287082');
    expect(parseTOTP(totpURI(totp))!.secret).toEqual(totp.secret);
    expect(totpSecondsRemaining(totp, 59_000)).toBe(1);
  });

  it('reads issuer and account', () => {
    const totp = parseTOTP(`otpauth://totp/GitHub:rosa%40org.example?secret=${rfcSecret}&issuer=GitHub&period=60`)!;
    expect(totp.issuer).toBe('GitHub');
    expect(totp.account).toBe('rosa@org.example');
    expect(totp.period).toBe(60);
  });

  it('rejects garbage', () => {
    expect(parseTOTP('')).toBeNull();
    expect(parseTOTP('not base32 !!')).toBeNull();
    expect(parseTOTP(`otpauth://hotp/x?secret=${rfcSecret}`)).toBeNull();
  });
});
