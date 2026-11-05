// The service worker: receives batches from the content script, posts them
// to the Meet app on the loopback interface with the pairing token, and
// keeps a ring of the ones that did not get through while the app was away.

import { createRing, makeBatch } from './batching.js';

const ENDPOINT = 'http://127.0.0.1:47613/meet-events';
const ring = createRing();

async function token() {
  const { token } = await chrome.storage.local.get('token');
  return token || '';
}

async function post(batch) {
  const bearer = await token();
  if (!bearer) return false;
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
      body: JSON.stringify(batch),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function flush() {
  for (const held of ring.drain()) {
    if (!(await post(held))) { ring.push(held); break; }
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'meet-batch') return;
  const batch = makeBatch(message);
  (async () => {
    await flush();
    const ok = await post(batch);
    // A heartbeat that did not land is dropped; anything else waits its turn.
    if (!ok && !message.volatile) ring.push(batch);
    await chrome.storage.local.set({ lastResult: { ok, at: Date.now(), code: batch.meetingCode } });
  })();
});

chrome.alarms.create('meet-flush', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'meet-flush') flush(); });
