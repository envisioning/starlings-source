// What this browser remembers for the signed-in owner, and one call that
// forgets all of it — docs/CACHING.md.
//
// The web keys none of these by account: it has no identity in hand
// without a request, and a change of owner passes through sign-out or an
// expired session. That only holds while every store is purged on both.
// Snapshots were; document drafts and search recents were not, so the next
// person on this browser inherited the last one's unsent text and history.
//
// Drafts are erased, not kept: unsent text is the one store here that is
// prose, and a browser someone signs out of is the one place it must not
// stay. Whoever wants a draft back saves it first.

import { apiBase } from './config';
import { clearHomeLayout } from './home-layout';
import { clearLanguage } from './language';
import { purgeSnapshots } from './snapshot-store';
import { removeStored, removeStoredWithPrefix, StorageKeys } from './storage';

const DRAFT_PREFIX = 'meet-docs-draft:';
/** Written on sign-out so every other tab of this browser lets go too. */
const SIGN_OUT_KEY = 'meet-signed-out-at';

/**
 * In-memory stores that a later chunk loads (the stars in `favorites.ts`)
 * register here, so this entry-chunk file does not import them.
 */
const purgeHooks = new Set<() => void>();

export function onOwnerPurge(purge: () => void): void {
  purgeHooks.add(purge);
}

/** Forget everything kept for the owner: snapshots, drafts, recents, layout, language, and the registered stores. */
export function purgeOwnerLocalState(): void {
  purgeSnapshots();
  for (const purge of purgeHooks) purge();
  clearHomeLayout();
  clearLanguage();
  removeStored(StorageKeys.searchRecents);
  removeStored(StorageKeys.memberHint);
  removeStored(StorageKeys.ownerSession);
  removeStoredWithPrefix(DRAFT_PREFIX);
}

/** Sign-out proper: purge here, and tell the other tabs through storage. */
export function signOutLocally(): void {
  purgeOwnerLocalState();
  try {
    localStorage.setItem(SIGN_OUT_KEY, String(Date.now()));
  } catch {
    // No storage, no other tabs to reach.
  }
}

/**
 * The member's Sign out, from Settings or the footer: end the session on the
 * Worker, purge this browser, and start over at the root. The root is
 * reached through the central sign-out, which also ends the auth host's
 * session when this workspace signs in there (docs/CENTRAL_AUTH.md).
 */
export async function signOut(): Promise<void> {
  try {
    await fetch(`${apiBase}/auth/logout`, { method: 'POST' });
  } finally {
    // The next owner on this browser starts cold (docs/CACHING.md):
    // snapshots, drafts, recents, layout — and every other tab.
    signOutLocally();
    window.location.assign(`${apiBase}/auth/central/sign-out`);
  }
}

/**
 * Another tab signed out. Purge here too and start over at the root, so a
 * Work or Docs tab left open does not keep showing the last owner's lists
 * on a session the Worker has already ended.
 */
export function watchForSignOutElsewhere(): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SIGN_OUT_KEY || !event.newValue) return;
    purgeOwnerLocalState();
    window.location.assign('/');
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
