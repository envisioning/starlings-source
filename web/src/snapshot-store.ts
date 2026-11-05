// Stale-while-revalidate snapshots for the work graph on the web —
// docs/CACHING.md, the browser tier of what `SnapshotStore.swift` does on Mac
// and iOS. The last good *value* of a list read, so Work paints what it last
// knew the instant it opens and refreshes behind that. Never the answer:
// every entry is replaced by the live read a moment later, and a failed
// refresh leaves the last snapshot on screen with its age and Retry.
//
// Keys are not per owner here, unlike the native stores: the web has no
// signed-in identity in hand without a second request, and on the web a
// change of owner always passes through sign-out (`/auth/logout`) or an
// expired session — both of which `purgeOwnerLocalState()` (owner-local-
// state.ts), which purges this store with the drafts and recents beside it.
//
// Never stores tokens, transcripts, audio or credentials: the keys are chosen
// by `crm-work.ts`, and only list reads go through it.
//
// A purge is a boundary in time: a read that started before it
// belongs to the owner who just left, however late it lands. `generation`
// counts purges; `revalidate` reads it before the request and refuses to
// save, or return, an answer from an older one. The refusal is a 401 with
// `session_expired`, which every list already treats as "sign in again", so
// the page shows the gate instead of the last owner's rows.

import { snapshotsInvalidatedBy, type SnapshotWrite } from '@starlings/contracts/request-policy';
import { ControlRequestError } from './config';
import { readStored, removeStoredWithPrefix, writeStored } from './storage';
import { uiLocale } from './i18n';

const PREFIX = 'meet-snapshot:';
const SCHEMA = 2;
/** Past this a snapshot stops being a head start and becomes a lie. */
const MAX_AGE_MS = 7 * 24 * 3_600_000;
export const INVALIDATE_EVENT = 'meet-snapshot-invalidate';

export interface Snapshot<T> {
  value: T;
  savedAt: number;
  /** The Worker's validator for `value`, sent back as `If-None-Match`. */
  etag: string | null;
}

interface Envelope {
  schema: number;
  key: string;
  savedAt: number;
  value: unknown;
  etag: string | null;
}

const memory = new Map<string, Snapshot<unknown>>();
/** One read per key at a time: Home's cards and its badges ask for the same list together. */
const inflight = new Map<string, Promise<unknown>>();
let generation = 0;

/** Which owner's turn it is: bumps on every purge. Read before an async write, compare after. */
export function storeGeneration(): number {
  return generation;
}

/** The read landed after a purge: nothing of it may be kept or shown. */
export function staleReadError(): ControlRequestError {
  return new ControlRequestError('Signed out while loading.', 401, 'session_expired');
}

export function loadSnapshot<T>(key: string): Snapshot<T> | null {
  const hit = memory.get(key) as Snapshot<T> | undefined;
  if (hit) return isUsable(hit.savedAt) ? hit : null;
  const raw = readStored(PREFIX + key);
  if (!raw) return null;
  try {
    const envelope = JSON.parse(raw) as Envelope;
    if (envelope.schema !== SCHEMA || envelope.key !== key || !isUsable(envelope.savedAt)) return null;
    const snapshot = { value: envelope.value as T, savedAt: envelope.savedAt, etag: envelope.etag ?? null };
    memory.set(key, snapshot);
    return snapshot;
  } catch {
    return null;
  }
}

/** Fire and forget: a cache that failed to write costs the next open its head start. */
export function saveSnapshot<T>(key: string, value: T, etag: string | null = null): void {
  const savedAt = Date.now();
  memory.set(key, { value, savedAt, etag });
  const envelope: Envelope = { schema: SCHEMA, key, savedAt, value, etag };
  try {
    writeStored(PREFIX + key, JSON.stringify(envelope));
  } catch {
    // Quota, most likely. The memory tier still has it for this session.
  }
}

/**
 * One snapshotted read, start to finish: send the snapshot's validator, keep
 * the snapshot on 304 (re-saved, so "Updated" says now — the list is
 * confirmed current), save the new value on 200. `read` gets the validator to
 * send and returns what came back; `normalize` shapes a fresh body.
 */
export function revalidate<Body, T>(
  key: string,
  read: (ifNoneMatch: string | null) => Promise<{ unchanged: true; etag: string | null } | { unchanged: false; value: Body; etag: string | null }>,
  normalize: (body: Body) => T,
): Promise<T> {
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const next = revalidateOnce(key, read, normalize).finally(() => inflight.delete(key));
  inflight.set(key, next);
  return next;
}

async function revalidateOnce<Body, T>(
  key: string,
  read: (ifNoneMatch: string | null) => Promise<{ unchanged: true; etag: string | null } | { unchanged: false; value: Body; etag: string | null }>,
  normalize: (body: Body) => T,
): Promise<T> {
  const known = loadSnapshot<T>(key);
  const started = generation;
  const result = await read(known?.etag ?? null);
  if (generation !== started) throw staleReadError();
  if (result.unchanged) {
    if (!known) throw new Error('The server answered 304 without a snapshot to keep.');
    saveSnapshot(key, known.value, result.etag ?? known.etag);
    return known.value;
  }
  const value = normalize(result.value);
  saveSnapshot(key, value, result.etag);
  return value;
}

/**
 * The resources a write made stale, by prefix (`crm/subjects` takes every
 * filtered page with it). Memory drops them, storage keeps them as the next
 * open's head start, and `INVALIDATE_EVENT` tells a list on screen that did
 * not write to re-read.
 */
export function invalidateSnapshots(prefixes: string[]): void {
  for (const key of [...memory.keys()]) {
    if (snapshotMatches(key, prefixes)) memory.delete(key);
  }
  // A read already in flight began before the write; the next one must not join it.
  for (const key of [...inflight.keys()]) {
    if (snapshotMatches(key, prefixes)) inflight.delete(key);
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<string[]>(INVALIDATE_EVENT, { detail: prefixes }));
  }
}

/**
 * What a named write made stale, from the table the Mac and iOS read too
 * (`packages/contracts/src/request-policy.ts`). A web write names
 * what it did (`task.update`), never the lists it clears: a list added to the
 * table is cleared on all three clients at once.
 */
export function invalidateFor(write: SnapshotWrite): void {
  invalidateSnapshots(snapshotsInvalidatedBy(write));
}

/**
 * Signing out takes every snapshot with it; the next owner starts cold.
 * Through `removeStoredWithPrefix`, not `localStorage` directly: `storage.ts`
 * keeps its own memory tier, and a key removed only from `localStorage` came
 * back from there on the next read.
 */
export function purgeSnapshots(): void {
  generation += 1;
  memory.clear();
  // A read begun before the purge is the last owner's; nobody joins it.
  inflight.clear();
  removeStoredWithPrefix(PREFIX);
}

/** `key` is, or is under, one of `prefixes`; `crm/mine` covers only itself. */
export function snapshotMatches(key: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => key === prefix || key.startsWith(`${prefix}?`) || key.startsWith(`${prefix}/`));
}

/** "Updated 4 minutes ago" — beside a failed refresh, so a snapshot is never mistaken for live data. */
export function updatedLabel(savedAt: number, now = Date.now()): string {
  const ageSeconds = Math.max(0, Math.round((now - savedAt) / 1000));
  if (ageSeconds < 60) return 'Updated just now';
  const formatter = new Intl.RelativeTimeFormat(uiLocale, { numeric: 'always' });
  if (ageSeconds < 3_600) return `Updated ${formatter.format(-Math.round(ageSeconds / 60), 'minute')}`;
  if (ageSeconds < 86_400) return `Updated ${formatter.format(-Math.round(ageSeconds / 3_600), 'hour')}`;
  return `Updated ${formatter.format(-Math.round(ageSeconds / 86_400), 'day')}`;
}

function isUsable(savedAt: number): boolean {
  return Number.isFinite(savedAt) && Date.now() - savedAt < MAX_AGE_MS;
}
