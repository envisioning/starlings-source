// Runs on meet.google.com. Reads the participant roster and the speaking
// indicator from the page, once a second, and tells the service worker about
// call start, call end, roster changes, and a heartbeat. Names and timing
// only: no audio, no captions, no chat, nothing typed.
//
// Selectors are Meet's, and Meet changes them. Each has a fallback and a
// null answer is "unknown", never "empty" — an empty roster must not be
// reported because a selector went stale.

import { createLifecycle, meetingCode } from './lifecycle.js';
import { sameRoster } from './batching.js';
import { inCallUI, readRoster, pageTitle } from './meet-page.js';

const lifecycle = createLifecycle();
let lastRoster = [];
let lastShipAt = 0;

function ship(payload) {
  try {
    chrome.runtime.sendMessage({ type: 'meet-batch', ...payload });
  } catch {
    // The worker is asleep or the extension was reloaded; the next tick tries again.
  }
}

function tick() {
  const code = meetingCode(location.pathname);
  if (!code) return;
  const event = lifecycle.observe(inCallUI(document));
  if (lifecycle.state !== 'inCall' && !event) return;
  if (event?.kind === 'call-started') lastRoster = [];
  const roster = readRoster(document) ?? lastRoster;
  const now = Date.now();
  const rosterChanged = !sameRoster(roster, lastRoster);
  const heartbeat = now - lastShipAt >= 60_000;
  if (!event && !rosterChanged && !heartbeat) return;
  lastRoster = roster;
  lastShipAt = now;
  ship({
    meetingCode: code,
    title: pageTitle(document),
    roster,
    lifecycle: event ?? (heartbeat && !rosterChanged ? { kind: 'heartbeat', atMs: now } : null),
    volatile: !event && !rosterChanged,
  });
}

setInterval(tick, 1000);
window.addEventListener('pagehide', () => {
  const code = meetingCode(location.pathname);
  const event = lifecycle.pagehide();
  if (code && event) ship({ meetingCode: code, title: pageTitle(document), roster: lastRoster, lifecycle: event, volatile: false });
});
