// A short-lived cache in front of the Core reads the board and the feed fan
// out to — docs/CACHING.md §Worker cache.
//
// The clients' snapshots and ETags made an unchanged
// list cheap on the wire, but the Worker still did the read behind every 304:
// eight subject pages, then one tasks read and one issues read per open
// subject for the board, one interactions read per open subject for the feed.
// That fan-out is what this spares. Sixty seconds is the bound on staleness
// for a change Meet did not make (a Core edit, a GitHub comment); a change
// Meet *did* make purges its keys on the way out, so the writer's re-read is
// never served the list from before its write.
//
// Workers KV, not the Cache API. Production is served on workers.dev, where
// `caches.default` accepts every put and answers every match with a miss
//: the minute cache and the last-known copy below did
// nothing there, and a Core outage or a 429 reached every Work surface as an
// error. KV is shared by every isolate and every colo, and works on any
// hostname. Its limits shape the module: a delete is seen at once in the colo
// that made it and within about half a minute elsewhere (the `cacheTtl` on a
// fresh read), a key can be written about once a second, and a TTL is at least
// sixty seconds. So a failed KV call is only ever a miss, never an error, and a
// stale copy is rewritten at most every `STALE_REWRITE_SECONDS`.
//
// Never caches anything per person (`crm/mine`, the Sales inbox) or anything
// whose staleness the person could mistake for their own write not landing. A
// key that did hold one member's view would carry that member's id; none does
// today. The one credential in this namespace, the Worker's own Core token,
// is not written here: `crm.ts` seals it under `pat/`.

import { env } from 'cloudflare:workers';
import { forgetCoreMemo } from './core-gate';

export const CORE_CACHE_TTL_SECONDS = 60;
/** KV will not keep a key for less than this. */
const KV_MIN_TTL_SECONDS = 60;
/** How long a fresh read may be served from an edge's own copy after a purge elsewhere. KV's floor is 30. */
const KV_EDGE_SECONDS = 30;
/** A live read that succeeds rewrites its last-known copy at most this often per isolate: KV takes about one write a second per key. */
const STALE_REWRITE_SECONDS = 15;

export type CoreCacheKey =
  | 'subjects/open'
  | `subject-counts/${'project' | 'lead'}`
  | `tasks/${'project' | 'lead' | 'event' | 'organization' | 'meeting' | 'signals_account' | 'partner'}/${string}`
  // Every partner's own tasks in one Core read (`scope=partner`), for the board: `tasks/partner/all`.
  | `issues/${string}`
  | `interactions/${'project' | 'lead'}/${string}`
  // The Granola bridge's whole ledger and the subject lists its suggestions
  // choose from; one read per minute instead of one per page or per note.
  | 'granola/ledger'
  | `subjects/all/${'project' | 'lead' | 'partner' | 'event'}`
  // The cross-subject goal and decision lists search reads (#262).
  | 'goals/open'
  | 'decisions/recent'
  // Read live every time; only the last-known copy is kept, for when Core
  // cannot answer (`staleOnError`).
  | `tasks-open/${string}`
  | `tasks-status/${string}`;

/** Every key this isolate has stored, so tests can start each case cold. */
const stored = new Set<CoreCacheKey>();
const knownIssueProjects = new Set<string>();
/** When this isolate last wrote each last-known copy, so a polled live read does not write on every pass. */
const staleWrittenAt = new Map<CoreCacheKey, number>();

const freshName = (key: CoreCacheKey) => `fresh/${key}`;
/**
 * The last-known copy of a read, kept a week beside the sixty-second one.
 * Only `staleOnError` and `cachedRead` read it, and only when Core fails to
 * answer. A write purges the fresh copy, never this one.
 */
const STALE_TTL_SECONDS = 7 * 24 * 60 * 60;
const staleName = (key: CoreCacheKey) => `stale/${key}`;

/** What a name holds: the value in an envelope, so a read that legitimately answered `null` is still a hit. */
interface Entry<T> {
  value: T;
}

function store(): KVNamespace | null {
  // Absent in some unit-test shapes and in a checkout that has not bound it yet; then every read is live.
  try {
    return (env as unknown as Partial<Env>).CORE_CACHE ?? null;
  } catch {
    return null;
  }
}

/** A KV failure is a miss. The cache is an optimisation and must never be the reason a read fails. */
function kvFailed(operation: string, name: string, error: unknown): void {
  console.warn(JSON.stringify({ event: 'core-cache.kv_failed', operation, name, error: String((error as Error)?.message ?? error) }));
}

async function readEntry<T>(kv: KVNamespace, name: string, edgeSeconds?: number): Promise<Entry<T> | null> {
  try {
    const entry = await kv.get<Entry<T>>(name, { type: 'json', ...(edgeSeconds ? { cacheTtl: edgeSeconds } : {}) });
    return entry && typeof entry === 'object' && 'value' in entry ? entry : null;
  } catch (error) {
    kvFailed('get', name, error);
    return null;
  }
}

async function writeEntry<T>(kv: KVNamespace, name: string, value: T, ttlSeconds: number): Promise<void> {
  try {
    await kv.put(name, JSON.stringify({ value } satisfies Entry<T>), { expirationTtl: Math.max(ttlSeconds, KV_MIN_TTL_SECONDS) });
  } catch (error) {
    kvFailed('put', name, error);
  }
}

async function deleteName(kv: KVNamespace, name: string): Promise<void> {
  try {
    await kv.delete(name);
  } catch (error) {
    kvFailed('delete', name, error);
  }
}

/** Core could not answer: rate limit, server error, timeout, network. Never a 4xx that means "no". */
function coreUnavailable(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status !== 'number' || status === 429 || status >= 500;
}

async function putStale<T>(kv: KVNamespace, key: CoreCacheKey, value: T): Promise<void> {
  const last = staleWrittenAt.get(key);
  if (last !== undefined && Date.now() - last < STALE_REWRITE_SECONDS * 1000) return;
  staleWrittenAt.set(key, Date.now());
  stored.add(key);
  await writeEntry(kv, staleName(key), value, STALE_TTL_SECONDS);
}

/**
 * `read()` live; on success the answer is kept as the last-known copy. When
 * Core cannot answer and a last-known copy exists, that copy is returned and
 * the failure is logged. With no copy the error goes on as before.
 */
export async function staleOnError<T>(key: CoreCacheKey, read: () => Promise<T>): Promise<T> {
  const kv = store();
  try {
    const value = await read();
    if (kv) await putStale(kv, key, value);
    return value;
  } catch (error) {
    if (!kv || !coreUnavailable(error)) throw error;
    const hit = await readEntry<T>(kv, staleName(key));
    if (!hit) throw error;
    console.warn(JSON.stringify({ event: 'core-cache.stale_served', key, error: String((error as Error)?.message ?? error) }));
    return hit.value;
  }
}

/**
 * The value under `key` if it is younger than the TTL, else `read()`'s
 * answer, stored for the next caller. A read that throws stores nothing;
 * one that came back incomplete can say so through `keep` and is not stored
 * either, so the next caller tries the whole set again.
 */
export async function cachedRead<T>(
  key: CoreCacheKey,
  read: () => Promise<T>,
  options: { ttlSeconds?: number; keep?: (value: T) => boolean } = {},
): Promise<T> {
  const kv = store();
  if (kv) {
    const hit = await readEntry<T>(kv, freshName(key), KV_EDGE_SECONDS);
    if (hit) return hit.value;
  }
  const value = await staleOnError(key, read);
  if (kv && (options.keep?.(value) ?? true)) {
    stored.add(key);
    await writeEntry(kv, freshName(key), value, options.ttlSeconds ?? CORE_CACHE_TTL_SECONDS);
  }
  return value;
}

/** After a write Meet made: the lists it changed, gone before the writer re-reads. */
export async function purgeCoreCache(keys: CoreCacheKey[]): Promise<void> {
  forgetCoreMemo();
  const kv = store();
  if (!kv) return;
  await Promise.all(keys.map((key) => deleteName(kv, freshName(key))));
}

/** Keep an index so a Mine issue write can evict its project list. Shared by every isolate, so any of them can read it. */
const ISSUES_INDEX: CoreCacheKey = 'issues/index';
const ISSUES_INDEX_TTL_SECONDS = 120;

async function readIssuesIndex(kv: KVNamespace): Promise<string[]> {
  const entry = await readEntry<unknown>(kv, freshName(ISSUES_INDEX));
  // A malformed index only costs an occasional cache miss.
  return Array.isArray(entry?.value) ? entry.value.filter((id): id is string => typeof id === 'string') : [];
}

export async function trackIssueCacheProjects(projectIDs: string[]): Promise<void> {
  const kv = store();
  if (!kv || projectIDs.length === 0) return;
  const existing = await readIssuesIndex(kv);
  for (const id of projectIDs) knownIssueProjects.add(id);
  const next = [...new Set([...existing, ...knownIssueProjects])];
  stored.add(ISSUES_INDEX);
  await writeEntry(kv, freshName(ISSUES_INDEX), next, ISSUES_INDEX_TTL_SECONDS);
}

/** An issue write from Mine has no project id, so evict every linked issue list. */
export async function purgeIssueCaches(): Promise<void> {
  const kv = store();
  if (!kv) return;
  const projectIDs = [...new Set([...knownIssueProjects, ...await readIssuesIndex(kv)])];
  const local = [...stored].filter((key): key is `issues/${string}` => key.startsWith('issues/') && key !== ISSUES_INDEX);
  const keys = [...new Set([...projectIDs.map((id) => `issues/${id}` as const), ...local])];
  await purgeCoreCache(keys);
  await deleteName(kv, freshName(ISSUES_INDEX));
  stored.delete(ISSUES_INDEX);
  for (const id of projectIDs) knownIssueProjects.delete(id);
}

/** Tests only: forget everything this isolate stored. */
export async function purgeAllCoreCache(): Promise<void> {
  const kv = store();
  if (kv) await Promise.all([...stored].map((key) => deleteName(kv, staleName(key))));
  await purgeCoreCache([...stored]);
  stored.clear();
  knownIssueProjects.clear();
  staleWrittenAt.clear();
}

/** The per-subject keys a task, issue or subject change touches. */
export function subjectCacheKeys(subject: { kind: string; id: string }): CoreCacheKey[] {
  const kind = subject.kind === 'lead' ? 'lead' : 'project';
  const keys: CoreCacheKey[] = [`tasks/${kind}/${subject.id}`];
  if (kind === 'project') keys.push(`issues/${subject.id}`);
  return keys;
}
