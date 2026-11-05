#!/usr/bin/env node
// Load check for one room's Durable Object at the 100 cap ( §2).
//
// Opens N guests against a control plane the way the browser does: a
// pre-knock presence heartbeat, a knock, the lobby WebSocket, then a poll
// until admitted. The owner admits every waiting request as fast as the
// API lets it. Reports knock latency, decision → socket-status latency,
// how many sockets stayed open, and the 429s the per-IP knock limit handed
// out — from one machine every guest shares an address, which is also what
// a venue's Wi-Fi looks like to the Worker.
//
//   pnpm dev:api                       # or the full `pnpm dev`
//   node scripts/load-lobby.mjs        # 100 guests, local stack
//   MEET_LOAD_API=https://the built-in workspace's host/api \
//   MEET_LOAD_OWNER_TOKEN=<bearer> node scripts/load-lobby.mjs --guests 100 --hold 120
//
// Against production there is no dev session: pass an owner bearer. The
// knock limit (JOIN_LIMIT, 12 per minute per IP) applies there too; use
// --pace to stay under it or read the 429 count as the finding.

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (!key.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) { args.set(key.slice(2), 'true'); continue; }
  args.set(key.slice(2), next);
  i += 1;
}

const api = process.env.MEET_LOAD_API ?? 'http://127.0.0.1:8787/api';
const origin = process.env.MEET_LOAD_ORIGIN ?? 'http://127.0.0.1:5173';
const guests = Number(args.get('guests') ?? 100);
/** Seconds to keep sockets and heartbeats alive after everyone is admitted. */
const holdSeconds = Number(args.get('hold') ?? 30);
/** Knocks per minute; 0 sends them all at once. */
const pace = Number(args.get('pace') ?? 0);
const heartbeatMs = 15_000;

async function request(path, { method = 'GET', token, body, webOrigin = false } = {}) {
  const started = performance.now();
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(webOrigin ? { origin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload, ms: performance.now() - started };
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);
}

function summary(values) {
  return { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: percentile(values, 100) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- owner -------------------------------------------------------------

let ownerToken = process.env.MEET_LOAD_OWNER_TOKEN;
if (!ownerToken) {
  const health = await request('/health');
  if (!health.ok || health.payload.environment !== 'development') {
    throw new Error('No MEET_LOAD_OWNER_TOKEN and the control plane is not the local development one.');
  }
  const session = await request('/dev/session', { method: 'POST', body: { name: 'Load Owner', email: 'rosa@example.com' } });
  if (!session.ok) throw new Error(`dev session: ${session.status}`);
  ownerToken = session.payload.access_token;
}

const ownerRoom = await request('/owner/room', { token: ownerToken });
if (!ownerRoom.ok) throw new Error(`owner room: ${ownerRoom.status} ${ownerRoom.payload.error ?? ''}`);
const slug = ownerRoom.payload.room.slug;
const start = await request(`/rooms/${slug}/start`, { method: 'POST', token: ownerToken, body: {} });
if (!start.ok) throw new Error(`start: ${start.status} ${start.payload.error ?? ''}`);
const meetingId = start.payload.meeting_id;
console.error(`room ${slug}, meeting ${meetingId}, ${guests} guests, hold ${holdSeconds}s, pace ${pace || 'burst'}`);

const ownerHeartbeat = setInterval(() => {
  void request(`/rooms/${slug}/meetings/${meetingId}/heartbeat`, { method: 'POST', token: ownerToken, body: {} });
}, 10_000);

// ---- guests ------------------------------------------------------------

const knockMs = [];
const admitMs = [];
const rateLimited = [];
const knockFailed = [];
const socketFailed = [];
let socketsOpen = 0;
const presenceFailed = { count: 0 };
const timers = [];
const sockets = [];

async function guest(n) {
  const presenceId = crypto.randomUUID();
  const presence = await request(`/rooms/${slug}/guest-presence`, {
    method: 'POST', webOrigin: true, body: { presence_id: presenceId, stage: 'visit' },
  });
  if (!presence.ok) presenceFailed.count += 1;
  timers.push(setInterval(() => {
    void request(`/rooms/${slug}/guest-presence`, {
      method: 'POST', webOrigin: true, body: { presence_id: presenceId, stage: 'visit' },
    }).then((r) => { if (!r.ok) presenceFailed.count += 1; });
  }, heartbeatMs));

  const knock = await request(`/rooms/${slug}/join-requests`, {
    method: 'POST', webOrigin: true, body: { name: `Load guest ${n}`, email: `load-${n}@example.net` },
  });
  if (knock.status === 429) { rateLimited.push(n); return null; }
  if (!knock.ok) { knockFailed.push({ n, status: knock.status, error: knock.payload.error }); return null; }
  knockMs.push(knock.ms);
  const { requestId, lobbyToken } = knock.payload;

  const url = new URL(`${api}/rooms/${slug}/lobby/socket`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('request_id', requestId);
  url.searchParams.set('token', lobbyToken);
  const admitted = new Promise((resolve) => {
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      socketFailed.push({ n, error: String(error) });
      resolve(null);
      return;
    }
    sockets.push(socket);
    socket.addEventListener('open', () => { socketsOpen += 1; });
    socket.addEventListener('close', () => { socketsOpen -= 1; });
    socket.addEventListener('error', () => { socketFailed.push({ n, error: 'socket error' }); });
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === 'lobby.status' && (message.status === 'admitted' || message.status === 'joined')) resolve(performance.now());
      } catch { /* newer message */ }
    });
  });
  return { n, requestId, lobbyToken, admitted };
}

const pending = [];
const knockStarted = performance.now();
for (let n = 0; n < guests; n += 1) {
  pending.push(guest(n));
  if (pace > 0) await sleep(60_000 / pace);
}
const knocked = (await Promise.all(pending)).filter(Boolean);
console.error(`knocked ${knocked.length}/${guests} in ${Math.round(performance.now() - knockStarted)}ms (${rateLimited.length} rate limited, ${knockFailed.length} failed)`);

// ---- admit -------------------------------------------------------------

const decidedAt = new Map();
const admitStarted = performance.now();
for (const g of knocked) {
  const before = performance.now();
  const decision = await request(`/rooms/${slug}/join-requests/${g.requestId}/decision`, {
    method: 'POST', token: ownerToken, body: { admit: true },
  });
  if (decision.ok) decidedAt.set(g.n, before);
}
const admitAll = performance.now() - admitStarted;

const settled = await Promise.all(knocked.map(async (g) => {
  const at = await Promise.race([g.admitted, sleep(30_000).then(() => 'timeout')]);
  if (typeof at === 'number' && decidedAt.has(g.n)) admitMs.push(at - decidedAt.get(g.n));
  return at;
}));
const noStatus = settled.filter((v) => v === 'timeout' || v === null).length;

// The join itself: one exchange per admitted guest, the way the browser does
// it once the status flips. This is where the 99 guard answers.
const exchangeStatus = {};
for (const g of knocked) {
  const exchange = await request(`/rooms/${slug}/join-requests/${g.requestId}/exchange`, {
    method: 'POST', webOrigin: true, body: { lobby_token: g.lobbyToken },
  });
  exchangeStatus[exchange.status] = (exchangeStatus[exchange.status] ?? 0) + 1;
}

console.error(`holding ${holdSeconds}s with ${socketsOpen} sockets open`);
await sleep(holdSeconds * 1_000);

const lobby = await request(`/rooms/${slug}/lobby`, { token: ownerToken });

// ---- report ------------------------------------------------------------

const report = {
  api,
  guests,
  pace: pace || 'burst',
  knock: { ...summary(knockMs), rate_limited: rateLimited.length, failed: knockFailed.slice(0, 5) },
  admit: { ...summary(admitMs), owner_decisions_total_ms: Math.round(admitAll), no_socket_status: noStatus },
  sockets: { opened: sockets.length, open_after_hold: socketsOpen, failed: socketFailed.length },
  presence: { heartbeat_failures: presenceFailed.count },
  exchange: exchangeStatus,
  lobby_after: lobby.ok ? { requests: lobby.payload.requests?.length ?? null, presence: lobby.payload.presence?.length ?? lobby.payload.visitors?.length ?? null } : lobby.status,
};
console.log(JSON.stringify(report, null, 2));

for (const t of timers) clearInterval(t);
clearInterval(ownerHeartbeat);
for (const s of sockets) { try { s.close(); } catch { /* already closed */ } }
await request(`/rooms/${slug}/meetings/${meetingId}/finalize`, { method: 'POST', token: ownerToken, body: {} }).catch(() => {});
process.exit(0);
