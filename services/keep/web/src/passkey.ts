// WebAuthn with the PRF extension: the passkey hands back 32 bytes that are
// the same on every unlock, and those bytes (through HKDF) wrap the private
// key. No master password to type or forget; a Touch ID prompt instead.
//
// The credential is bound to this origin's RP ID. Moving Keep to a new host
// invalidates every passkey — see wrangler.jsonc.
//
// Not every browser/authenticator pair implements PRF. `prfAvailable()`
// answers before enrolment so the UI can offer the passphrase path instead.

import { productName } from './deployment';
import { fromBase64URL, prfSalt, randomBytes, toBase64URL } from '@keep/crypto';


interface PRFResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

function extensionResults(credential: PublicKeyCredential): PRFResults {
  return credential.getClientExtensionResults() as PRFResults;
}

export function passkeysSupported(): boolean {
  return typeof PublicKeyCredential !== 'undefined' && typeof navigator.credentials?.create === 'function';
}

/**
 * Create a passkey for this person and ask for PRF in the same ceremony.
 * Returns the credential id and the PRF output, or `null` if the
 * authenticator created a credential without PRF — in which case the
 * credential is useless to us and the caller falls back to a passphrase.
 */
export async function enrolPasskey(email: string, name: string): Promise<{ credentialId: string; prf: Uint8Array } | null> {
  const userId = randomBytes(16);
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: productName(), id: window.location.hostname },
      user: { id: userId as BufferSource, name: email, displayName: name },
      challenge: randomBytes(32) as BufferSource,
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      timeout: 120_000,
      extensions: { prf: { eval: { first: prfSalt() as BufferSource } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!credential) return null;

  const results = extensionResults(credential);
  const credentialId = toBase64URL(new Uint8Array(credential.rawId));
  if (results.prf?.results?.first) {
    return { credentialId, prf: new Uint8Array(results.prf.results.first) };
  }
  // Some authenticators only evaluate PRF on `get`, not on `create`. Try once.
  if (results.prf?.enabled) {
    const prf = await unlockPasskey(credentialId);
    if (prf) return { credentialId, prf };
  }
  return null;
}

/** Ask the named passkey for its PRF output. `null` when the person cancels. */
export async function unlockPasskey(credentialId: string): Promise<Uint8Array | null> {
  let assertion: PublicKeyCredential | null;
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        rpId: window.location.hostname,
        challenge: randomBytes(32) as BufferSource,
        allowCredentials: [{ type: 'public-key', id: fromBase64URL(credentialId) as BufferSource }],
        userVerification: 'required',
        timeout: 120_000,
        extensions: { prf: { eval: { first: prfSalt() as BufferSource } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
  } catch (error) {
    if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) return null;
    throw error;
  }
  if (!assertion) return null;
  const first = extensionResults(assertion).prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}
