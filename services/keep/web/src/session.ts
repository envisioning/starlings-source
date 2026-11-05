// The key session: the one place a private key lives while the tab is open.
//
// Rules, each of which closes a real hole:
//
//   - The private key is a CryptoKey in module memory. Not in localStorage,
//     not in sessionStorage, not in IndexedDB. A reload locks. A closed tab
//     locks. It is extractable, because adding a second way to unlock means
//     wrapping it again; script that runs in this page could use it either
//     way, so non-extractable would buy nothing.
//   - Vault keys are derived on demand and cached only while unlocked.
//   - Fifteen minutes without a pointer or key event locks. So does the tab
//     going hidden for longer than two minutes.
//   - Locking drops every reference. Plaintext the UI still holds is the
//     UI's problem, which is why reveal dialogs clear on close.

import type { KeyWrap, StaffKey, WrappedToPublicKey } from '@keep/contracts';
import {
  fromBase64URL,
  importVaultKey,
  unwrapKeyWithPrivateKey,
  unwrapPrivateKey,
  wrapPrivateKeyWithPRF,
  wrapPrivateKeyWithPassphrase,
  wrappingKeyFromPRF,
  wrappingKeyFromPassphrase,
  type WrappedPrivateKey,
} from '@keep/crypto';
import { unlockPasskey } from './passkey';

const IDLE_LOCK_MS = 15 * 60 * 1000;
const HIDDEN_LOCK_MS = 2 * 60 * 1000;

type Listener = () => void;

let privateKey: CryptoKey | null = null;
let publicKey: string | null = null;
const vaultKeys = new Map<string, CryptoKey>();
const listeners = new Set<Listener>();
let idleTimer: number | null = null;
let hiddenSince: number | null = null;

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isUnlocked(): boolean {
  return privateKey !== null;
}

export function lock(): void {
  privateKey = null;
  publicKey = null;
  vaultKeys.clear();
  notify();
}

function armIdleTimer(): void {
  if (idleTimer !== null) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(lock, IDLE_LOCK_MS);
}

function onActivity(): void {
  if (privateKey) armIdleTimer();
}

function onVisibility(): void {
  if (document.visibilityState === 'hidden') {
    hiddenSince = Date.now();
    return;
  }
  if (hiddenSince !== null && Date.now() - hiddenSince > HIDDEN_LOCK_MS) lock();
  hiddenSince = null;
}

let watching = false;
function watch(): void {
  if (watching) return;
  watching = true;
  for (const event of ['pointerdown', 'keydown', 'scroll']) {
    window.addEventListener(event, onActivity, { passive: true });
  }
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', lock);
}

async function accept(key: CryptoKey, ownPublicKey: string): Promise<void> {
  privateKey = key;
  publicKey = ownPublicKey;
  vaultKeys.clear();
  watch();
  armIdleTimer();
  notify();
}

/** The wrap for a method, if this person holds one. */
export function wrapFor(staffKey: StaffKey, method: 'prf' | 'passphrase'): KeyWrap | null {
  return staffKey.wraps.find((entry) => entry.wrap.method === method) ?? null;
}

/** Unlock with the passkey. `false` if the person cancelled. */
export async function unlockWithPasskey(staffKey: StaffKey): Promise<boolean> {
  const entry = wrapFor(staffKey, 'prf');
  if (!entry || entry.wrap.method !== 'prf') throw new Error('No passkey on this key.');
  const prf = await unlockPasskey(entry.wrap.credential_id);
  if (!prf) return false;
  const wrappingKey = await wrappingKeyFromPRF(prf, fromBase64URL(entry.wrap.hkdf_salt));
  await accept(await unwrapPrivateKey(wrappingKey, entry.wrapped_private_key, true), staffKey.public_key);
  return true;
}

/** Unlock with a passphrase. Throws `KeepCryptoError` on a wrong one. */
export async function unlockWithPassphrase(staffKey: StaffKey, passphrase: string): Promise<void> {
  const entry = wrapFor(staffKey, 'passphrase');
  if (!entry || entry.wrap.method !== 'passphrase') throw new Error('No passphrase on this key.');
  const wrappingKey = await wrappingKeyFromPassphrase(passphrase, fromBase64URL(entry.wrap.pbkdf2_salt), entry.wrap.pbkdf2_iterations);
  await accept(await unwrapPrivateKey(wrappingKey, entry.wrapped_private_key, true), staffKey.public_key);
}

/** Seal the open private key under a passphrase, to add as another wrap. */
export async function rewrapWithPassphrase(passphrase: string): Promise<WrappedPrivateKey> {
  if (!privateKey) throw new LockedError();
  return wrapPrivateKeyWithPassphrase(privateKey, passphrase);
}

/** Seal the open private key under a passkey's PRF output, to add as another wrap. */
export async function rewrapWithPRF(prf: Uint8Array, credentialId: string): Promise<WrappedPrivateKey> {
  if (!privateKey) throw new LockedError();
  return wrapPrivateKeyWithPRF(privateKey, prf, credentialId);
}

/** Straight after enrolment: the key is already in hand, no need to unwrap it. */
export async function unlockWithFreshKey(key: CryptoKey, ownPublicKey: string): Promise<void> {
  await accept(key, ownPublicKey);
}

export class LockedError extends Error {
  constructor() {
    super('Keep is locked.');
    this.name = 'LockedError';
  }
}

/** Raw vault key bytes: needed to wrap it to a colleague. Never cached. */
export async function vaultKeyBytes(wrapped: WrappedToPublicKey): Promise<Uint8Array> {
  if (!privateKey || !publicKey) throw new LockedError();
  return unwrapKeyWithPrivateKey(wrapped, privateKey, publicKey);
}

/** The vault's AES key, cached per (vault, wrap) while unlocked. */
export async function vaultKey(vaultId: string, keyVersion: number, wrapped: WrappedToPublicKey): Promise<CryptoKey> {
  if (!privateKey || !publicKey) throw new LockedError();
  const cacheKey = `${vaultId}:${keyVersion}`;
  const cached = vaultKeys.get(cacheKey);
  if (cached) return cached;
  const key = await importVaultKey(await unwrapKeyWithPrivateKey(wrapped, privateKey, publicKey));
  vaultKeys.set(cacheKey, key);
  return key;
}

export function forgetVaultKey(vaultId: string): void {
  for (const key of [...vaultKeys.keys()]) {
    if (key.startsWith(`${vaultId}:`)) vaultKeys.delete(key);
  }
}
