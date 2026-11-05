// The Worker's side of Core's rate limit.
//
// Core limits every Meet call signed as us, as one caller. Home, Work, the
// pickers and a task create all draw from the same quota, so a burst from
// one screen turns into a 429 on whichever call is unlucky: "Core task create
// failed (429)", "Core subject detail failed (429)". Three small tools:
//
//  - `withCoreRetry`: a 429 is Core refusing before it did anything, so
//    retrying is safe for a write as well as a read — it cannot create twice.
//    It waits what Core's `Retry-After` says (capped), else backs off, and it
//    parks every other caller in the isolate behind the same cooldown so a
//    burst does not keep hammering a quota that just said stop.
//  - `coreSlot`: at most CORE_CONCURRENCY Core calls in flight per isolate.
//  - `memoCore`: a ten-second memo with in-flight de-duplication for the
//    reads a screen repeats (picker keystrokes, subject detail, my-work).
//    Isolate-local on purpose: these reads are per keystroke and per person,
//    so a KV write for each (core-cache.ts) would cost more than it saves.
//    Any Meet write drops it.
//
// All three are shared by every request the isolate serves, and a Workers
// request can be cancelled mid-await (the client timed out or went away).
// A cancelled request runs no `finally` and settles no promise. So nothing
// here may make one request wait on another: a slot is a lease
// that ages out, a waiter polls on its own timer, and a request that finds
// another request's read still in flight waits a bounded time, then reads for
// itself. Before this, a cancelled call kept its slot for good and woke no
// waiter. Six of them jammed the isolate, and the runtime cancelled every
// later Core-touching request as hung: a bare HTTP 500 with no `code`, which
// the calendar showed as "Google events didn't refresh".

export const CORE_CONCURRENCY = 6;
export const CORE_MEMO_TTL_MS = 10_000;
/** The longest one wait on a 429 may be, whatever Core asks for. */
export const MAX_RETRY_WAIT_MS = 6_000;
/** The longest a call waits for a cooldown another call started. */
const MAX_COOLDOWN_WAIT_MS = 6_000;
/** The longest a call waits for a free slot before it goes anyway. */
export const MAX_SLOT_WAIT_MS = 6_000;
/** A slot older than this belongs to a request that was cancelled; it no longer counts. */
export const SLOT_LEASE_MS = 30_000;
/** The longest a call waits on a read another request started before it reads for itself. */
export const MAX_SHARED_WAIT_MS = 8_000;
const SLOT_POLL_MS = 25;

let coolUntil = 0;
let slotWaitMs = MAX_SLOT_WAIT_MS;
let slotLeaseMs = SLOT_LEASE_MS;
let sharedWaitMs = MAX_SHARED_WAIT_MS;
/** Each held slot and when it was taken. */
const slots = new Map<symbol, number>();
const memo = new Map<string, { at: number; value: Promise<unknown>; settled: boolean }>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Core's `Retry-After` (seconds or an HTTP date) in milliseconds, or null when absent or unreadable. */
export function retryAfterMs(response: Response, now = Date.now()): number | null {
  const raw = response.headers.get('retry-after')?.trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/u.test(raw)) return Math.round(Number(raw) * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** Run `send`, and again after a pause each time Core answers 429. The last answer comes back whatever it is. */
export async function withCoreRetry(
  send: () => Promise<Response>,
  options: { retries?: number; pauseMs?: number } = {},
): Promise<Response> {
  const retries = options.retries ?? 2;
  const pauseMs = options.pauseMs ?? 1_000;
  for (let attempt = 0; ; attempt += 1) {
    const cooling = Math.min(coolUntil - Date.now(), MAX_COOLDOWN_WAIT_MS);
    if (cooling > 0) await sleep(cooling);
    const response = await coreSlot(send);
    if (response.status !== 429 || attempt >= retries) return response;
    const wait = Math.min(retryAfterMs(response) ?? pauseMs * 2 ** attempt, MAX_RETRY_WAIT_MS);
    coolUntil = Math.max(coolUntil, Date.now() + wait);
    // Free the connection; the body of a 429 is never read.
    void response.body?.cancel().catch(() => undefined);
    await sleep(wait);
  }
}

/** Slots still held by a live call. A lease past its age is dropped. */
function liveSlots(now: number): number {
  for (const [slot, takenAt] of slots) if (now - takenAt >= slotLeaseMs) slots.delete(slot);
  return slots.size;
}

/**
 * At most CORE_CONCURRENCY calls in flight. The waiter polls on its own
 * timer and goes anyway after `slotWaitMs`: no other request wakes it.
 */
async function coreSlot<T>(run: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + slotWaitMs;
  while (liveSlots(Date.now()) >= CORE_CONCURRENCY && Date.now() < deadline) await sleep(SLOT_POLL_MS);
  const slot = Symbol('core-slot');
  slots.set(slot, Date.now());
  try {
    return await run();
  } finally {
    slots.delete(slot);
  }
}

/**
 * Wait for a promise, but for `ms` at most. `null` means it did not settle in
 * time, and the caller goes on without it. The timer is this request's own,
 * so a promise that another, cancelled request owns cannot hang the caller.
 * A rejection that comes after the bound is dropped, not left unhandled.
 */
export async function awaitBounded<T>(pending: Promise<T>, ms: number = sharedWaitMs): Promise<{ value: T } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  const settled = pending.then((value) => ({ value }));
  settled.catch(() => undefined);
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `read()` once per `key` per ten seconds; callers that arrive meanwhile
 * share the one read. A failed read is forgotten at once. A read still in
 * flight is shared for `MAX_SHARED_WAIT_MS` at most: its request can be
 * cancelled, and then it never settles.
 */
export function memoCore<T>(key: string, read: () => Promise<T>, ttlMs = CORE_MEMO_TTL_MS): Promise<T> {
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && now - hit.at < ttlMs) {
    if (hit.settled) return hit.value as Promise<T>;
    return awaitBounded(hit.value as Promise<T>).then((shared) => (shared ? shared.value : read()));
  }
  if (memo.size > 200) {
    for (const [stale, entry] of memo) if (now - entry.at >= ttlMs) memo.delete(stale);
  }
  const value = read();
  const entry = { at: now, value: value as Promise<unknown>, settled: false };
  memo.set(key, entry);
  value.then(
    () => { entry.settled = true; },
    () => {
      entry.settled = true;
      if (memo.get(key) === entry) memo.delete(key);
    },
  );
  return value;
}

/** A Meet write happened: nothing memoised before it may answer the re-read after it. */
export function forgetCoreMemo(): void {
  memo.clear();
}

/** Tests start each case cold. A case may shorten the waits to play a cancelled request. */
export function resetCoreGate(waits: { slotWaitMs?: number; slotLeaseMs?: number; sharedWaitMs?: number } = {}): void {
  memo.clear();
  slots.clear();
  coolUntil = 0;
  slotWaitMs = waits.slotWaitMs ?? MAX_SLOT_WAIT_MS;
  slotLeaseMs = waits.slotLeaseMs ?? SLOT_LEASE_MS;
  sharedWaitMs = waits.sharedWaitMs ?? MAX_SHARED_WAIT_MS;
}
