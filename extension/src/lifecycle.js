// The call's lifecycle as a machine over what the page shows, so the content
// script only has to answer "is the in-call UI on screen?" once a second.
//
//   idle ──join──▶ inCall ──leave──▶ idle
//
// Every transition is an event with the epoch it happened. Reloads re-fire
// join by design; the app debounces, it has the durable state.

export function createLifecycle(now = () => Date.now()) {
  let state = 'idle';
  return {
    get state() { return state; },
    /** Feed one observation; returns the transition event or null. */
    observe(inCallUI) {
      if (inCallUI && state === 'idle') {
        state = 'inCall';
        return { kind: 'call-started', atMs: now() };
      }
      if (!inCallUI && state === 'inCall') {
        state = 'idle';
        return { kind: 'call-ended', atMs: now(), reason: 'left' };
      }
      return null;
    },
    /** The page is going away while in a call. */
    pagehide() {
      if (state !== 'inCall') return null;
      state = 'idle';
      return { kind: 'call-ended', atMs: now(), reason: 'pagehide' };
    },
  };
}

/** `abc-defg-hij` from a meet.google.com path, or null on the landing page. */
export function meetingCode(pathname) {
  const match = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?]|$)/.exec(pathname);
  return match ? match[1] : null;
}
