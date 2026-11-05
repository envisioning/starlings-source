// What the app receives and when. A batch is one POST; the ring keeps the
// last ones while the app is away and drops the volatile ones (heartbeats)
// on any failure — a stale heartbeat is worthless and would only displace a
// real event.

export const SCHEMA_VERSION = 2;
export const HEARTBEAT_MS = 60_000;
export const RING_CAP = 200;

export function makeBatch({ meetingCode, title, roster, lifecycle, now = Date.now() }) {
  const batch = { schemaVersion: SCHEMA_VERSION, meetingCode, capturedAtMs: now, roster };
  if (title) batch.title = title;
  if (lifecycle) batch.lifecycle = lifecycle;
  return batch;
}

/** Whether a heartbeat is due: none shipped in the last minute. */
export function heartbeatDue(lastShippedAtMs, now = Date.now()) {
  return now - lastShippedAtMs >= HEARTBEAT_MS;
}

export function createRing(cap = RING_CAP) {
  const items = [];
  return {
    get size() { return items.length; },
    push(batch) {
      items.push(batch);
      while (items.length > cap) items.shift();
    },
    /** Everything, oldest first; the caller re-pushes what failed. */
    drain() { return items.splice(0, items.length); },
  };
}

/** True when two rosters carry the same names in the same speaking state. */
export function sameRoster(a, b) {
  if (a.length !== b.length) return false;
  return a.every((p, i) => p.name === b[i].name && Boolean(p.speaking) === Boolean(b[i].speaking));
}
