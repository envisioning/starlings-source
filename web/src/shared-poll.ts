import {
  PEER_ROSTER_BACKGROUND_POLL_SECONDS,
  PEER_ROSTER_POLL_SECONDS,
  THREAD_LIST_BACKGROUND_POLL_SECONDS,
  THREAD_LIST_POLL_SECONDS,
} from '@starlings/contracts/limits';

/**
 * One timer, one request, however many things are watching.
 *
 * The member pages each used to run their own interval over the same two
 * reads — the roster and the unread list — so a tab could hold three timers
 * asking for state that arrives from a ten-second cache anyway. Worse, every
 * `/peers` read fans out to a Durable Object per room, which made an idle tab
 * the largest single source of traffic on the account.
 *
 * So callers subscribe to a named poll instead of starting one. The first
 * subscriber starts the timer, the last one stops it, and a second subscriber
 * that arrives mid-window is answered from the value already in hand rather
 * than with a fresh request.
 *
 * Cadence follows attention, matching what the Mac client already does for
 * presence while giving the slower unread list its own budget:
 *
 *   - hidden tab            → nothing. Presence published from a tab nobody
 *                             can see is a lie, and it resumes with an
 *                             immediate read the moment it comes back.
 *   - visible, unfocused    → PEER_ROSTER_BACKGROUND_POLL_SECONDS. Meet is on
 *                             screen behind another app; a ring still lands
 *                             inside its lifetime, at a third of the requests.
 *   - visible and focused   → PEER_ROSTER_POLL_SECONDS, still inside a ring's
 *                             short lifetime without spending cache churn.
 */

export type PollSubscriber<T> = {
  onValue: (value: T) => void;
  /** Optional: a poll that can fail meaningfully (auth) rather than silently. */
  onError?: (cause: unknown) => void;
};

type Poll = {
  key: string;
  read: () => Promise<unknown>;
  subscribers: Set<PollSubscriber<never>>;
  timer: number | undefined;
  /** Seconds the live timer runs at, so a retune only restarts on a change. */
  cadence: number | undefined;
  last: { value: unknown; at: number } | null;
  inFlight: Promise<void> | null;
};

const polls = new Map<string, Poll>();

/**
 * The thread list's poll, which runs at the slower thread-list cadence. One
 * name for both sides: the cadence test used to look for `threads.unread`
 * while the list subscribed as `threads.all`, so it polled at the roster's
 * pace.
 */
export const THREADS_POLL_KEY = 'threads.all';

/** Events from mail forwarded to calendar@: a minute late is on time. */
export const PENDING_EVENTS_POLL_KEY = 'calendar.pending';

/** `null` means "do not poll at all right now". */
function cadenceSeconds(key: string): number | null {
  const threadList = key === THREADS_POLL_KEY || key === PENDING_EVENTS_POLL_KEY;
  if (typeof document === 'undefined') return threadList ? THREAD_LIST_POLL_SECONDS : PEER_ROSTER_POLL_SECONDS;
  if (document.visibilityState !== 'visible') return null;
  // `hasFocus` is false for a visible window behind another app — the browser
  // equivalent of the Mac's "app behind other windows".
  if (document.hasFocus()) return threadList ? THREAD_LIST_POLL_SECONDS : PEER_ROSTER_POLL_SECONDS;
  return threadList ? THREAD_LIST_BACKGROUND_POLL_SECONDS : PEER_ROSTER_BACKGROUND_POLL_SECONDS;
}

function tick(poll: Poll): Promise<void> {
  // A second caller inside one request waits for it rather than making its own.
  if (poll.inFlight) return poll.inFlight;
  const run = poll.read().then(
    (value) => {
      poll.last = { value, at: Date.now() };
      for (const subscriber of poll.subscribers) (subscriber.onValue as (value: unknown) => void)(value);
    },
    (cause: unknown) => {
      // A failed read leaves the last answer standing. Subscribers that care
      // about *why* — a roster that turned 403 — say so with onError.
      for (const subscriber of poll.subscribers) subscriber.onError?.(cause);
    },
  ).finally(() => {
    poll.inFlight = null;
  });
  poll.inFlight = run;
  return run;
}

function stop(poll: Poll): void {
  window.clearInterval(poll.timer);
  poll.timer = undefined;
  poll.cadence = undefined;
}

/**
 * Bring one poll's timer in line with the current cadence, reading straight
 * away if what we are holding is already older than that cadence allows.
 */
function retune(poll: Poll): void {
  if (poll.subscribers.size === 0) {
    stop(poll);
    return;
  }
  const seconds = cadenceSeconds(poll.key);
  if (seconds === null) {
    stop(poll);
    return;
  }
  const stale = !poll.last || Date.now() - poll.last.at >= seconds * 1_000;
  if (poll.cadence !== seconds) {
    stop(poll);
    poll.cadence = seconds;
    poll.timer = window.setInterval(() => void tick(poll), seconds * 1_000);
  }
  if (stale) void tick(poll);
}

function retuneAll(): void {
  for (const poll of polls.values()) retune(poll);
}

let listening = false;

function listen(): void {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  document.addEventListener('visibilitychange', retuneAll);
  // Focus and blur, not just visibility: a window in front of nothing is still
  // a window nobody is reading.
  window.addEventListener('focus', retuneAll);
  window.addEventListener('blur', retuneAll);
}

/**
 * Watch a named poll. Returns the unsubscribe, so an effect can `return` it.
 *
 * `read` is taken from whoever subscribes first; every later subscriber under
 * the same key shares that one request. Keys are per endpoint, not per caller.
 */
export function subscribePoll<T>(
  key: string,
  read: () => Promise<T>,
  subscriber: PollSubscriber<T>,
): () => void {
  listen();
  let poll = polls.get(key);
  if (!poll) {
    poll = { key, read: read as () => Promise<unknown>, subscribers: new Set(), timer: undefined, cadence: undefined, last: null, inFlight: null };
    polls.set(key, poll);
  }
  const entry = poll;
  entry.subscribers.add(subscriber as PollSubscriber<never>);

  // Draw immediately from what is already in hand — a page that mounts nine
  // seconds into the window should not sit empty waiting for the next beat.
  if (entry.last) subscriber.onValue(entry.last.value as T);
  retune(entry);

  return () => {
    entry.subscribers.delete(subscriber as PollSubscriber<never>);
    if (entry.subscribers.size === 0) stop(entry);
  };
}

/**
 * Read now, whatever the timer was going to do — for the moment right after an
 * action that changed the answer (do-not-disturb, a new avatar, a fresh
 * session). Everyone subscribed to the key sees the result, so a page never
 * has to hold a second copy of the same state.
 */
export function refreshPoll(key: string): Promise<void> {
  const poll = polls.get(key);
  return poll ? tick(poll) : Promise.resolve();
}

/** Test seam: forget every timer and every held value. */
export function resetPolls(): void {
  for (const poll of polls.values()) stop(poll);
  polls.clear();
}
