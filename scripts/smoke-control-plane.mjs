#!/usr/bin/env node

const api = process.env.MEET_SMOKE_API ?? 'http://127.0.0.1:8787/api';
const origin = process.env.MEET_SMOKE_ORIGIN ?? 'http://127.0.0.1:5173';

async function request(path, { method = 'GET', token, body, webOrigin = false } = {}) {
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
  if (!response.ok) {
    throw new Error(`${method} ${path} returned ${response.status}: ${payload.error ?? 'unknown error'}`);
  }
  return payload;
}

const health = await request('/health');
if (!health.ok || health.environment !== 'development') {
  throw new Error('Smoke tests require the local development control plane.');
}

const session = await request('/dev/session', {
  method: 'POST',
  body: { name: 'Local Owner', email: 'rosa@example.com' },
});
const ownerToken = session.access_token;

const ownerRoom = await request('/owner/room', { token: ownerToken });
const slug = ownerRoom.room.slug;
const ownerConnection = await request(`/rooms/${slug}/start`, {
  method: 'POST',
  token: ownerToken,
  body: {},
});
await request(`/rooms/${slug}/meetings/${ownerConnection.meeting_id}/heartbeat`, {
  method: 'POST',
  token: ownerToken,
  body: {},
});

const join = await request(`/rooms/${slug}/join-requests`, {
  method: 'POST',
  webOrigin: true,
  body: {
    name: 'Browser Guest',
    email: 'guest@example.net',
  },
});
const lobby = await request(`/rooms/${slug}/lobby`, { token: ownerToken });
if (!lobby.requests.some((candidate) => candidate.id === join.requestId && candidate.status === 'waiting')) {
  throw new Error('The owner lobby did not receive the guest request.');
}

await request(`/rooms/${slug}/join-requests/${join.requestId}/decision`, {
  method: 'POST',
  token: ownerToken,
  body: { admit: true },
});
const admitted = await request(
  `/rooms/${slug}/join-requests/${join.requestId}?token=${encodeURIComponent(join.lobbyToken)}`,
);
if (admitted.status !== 'admitted') throw new Error('The guest was not admitted.');

const guestConnection = await request(`/rooms/${slug}/join-requests/${join.requestId}/exchange`, {
  method: 'POST',
  webOrigin: true,
  body: { lobby_token: join.lobbyToken },
});
if (guestConnection.meeting_id !== ownerConnection.meeting_id) {
  throw new Error('Owner and guest received different meeting IDs.');
}

const segmentID = crypto.randomUUID();
await request(`/rooms/${slug}/meetings/${ownerConnection.meeting_id}/transcript`, {
  method: 'POST',
  token: ownerToken,
  body: {
    segments: [{
      id: segmentID,
      meeting_id: ownerConnection.meeting_id,
      speaker_id: 'owner:rosa@example.com',
      speaker_name: 'Local Owner',
      language: 'en',
      starts_at_ms: 0,
      ends_at_ms: 1_200,
      text: 'The local end-to-end meeting pipeline works.',
      is_final: true,
    }],
  },
});
// Repeat deliberately: the Durable Object must accept an idempotent retry.
const duplicate = await request(`/rooms/${slug}/meetings/${ownerConnection.meeting_id}/transcript`, {
  method: 'POST',
  token: ownerToken,
  body: {
    segments: [{
      id: segmentID,
      meeting_id: ownerConnection.meeting_id,
      speaker_id: 'owner:rosa@example.com',
      speaker_name: 'Local Owner',
      language: 'en',
      starts_at_ms: 0,
      ends_at_ms: 1_200,
      text: 'The local end-to-end meeting pipeline works.',
      is_final: true,
    }],
  },
});
if (duplicate.accepted !== 0) throw new Error('Duplicate transcript segment was not idempotent.');

await request(`/rooms/${slug}/meetings/${ownerConnection.meeting_id}/finalize`, {
  method: 'POST',
  token: ownerToken,
  body: {},
});
const artifact = await request(
  `/rooms/${slug}/meetings/${ownerConnection.meeting_id}/artifact`,
  { token: guestConnection.artifact_token },
);
if (artifact.transcript?.length !== 1 || artifact.transcript[0].id !== segmentID) {
  throw new Error('The finalized guest artifact did not contain exactly one transcript segment.');
}

console.log(JSON.stringify({
  ok: true,
  roomKind: ownerRoom.room.kind,
  admission: admitted.status,
  transcriptSegments: artifact.transcript.length,
  artifactAccess: 'admitted guest',
  hostLease: 'active',
}));
