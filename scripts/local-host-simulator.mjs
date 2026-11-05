const apiBase = process.env.MEET_LOCAL_API ?? 'http://127.0.0.1:8787/api';
const room = process.env.MEET_LOCAL_ROOM ?? 'rosa';

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `${response.status} ${response.statusText}`);
  return data;
}

const session = await request('/dev/session', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Local Mac Host', email: 'rosa@example.com' }),
});
const authorization = { authorization: `Bearer ${session.access_token}` };
const meeting = await request(`/rooms/${room}/start`, { method: 'POST', headers: authorization });

console.log(JSON.stringify({
  ready: true,
  role: 'host-mac-simulator',
  roomURL: `http://127.0.0.1:5173/room/${room}`,
  meetingID: meeting.meeting_id,
  autoAdmit: true,
}));

let stopped = false;
async function stop() {
  if (stopped) return;
  stopped = true;
  await request(`/rooms/${room}/meetings/${meeting.meeting_id}/finalize`, {
    method: 'POST',
    headers: authorization,
  }).catch(() => undefined);
}
process.once('SIGINT', () => void stop().finally(() => process.exit(0)));
process.once('SIGTERM', () => void stop().finally(() => process.exit(0)));

let lastHeartbeat = 0;
while (!stopped) {
  if (Date.now() - lastHeartbeat >= 10_000) {
    await request(`/rooms/${room}/meetings/${meeting.meeting_id}/heartbeat`, {
      method: 'POST',
      headers: authorization,
    });
    lastHeartbeat = Date.now();
  }
  const lobby = await request(`/rooms/${room}/lobby`, { headers: authorization });
  for (const guest of lobby.requests.filter((request) => request.status === 'waiting')) {
    await request(`/rooms/${room}/join-requests/${guest.id}/decision`, {
      method: 'POST',
      headers: { ...authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ admit: true }),
    });
    console.log(JSON.stringify({ admitted: true, requestID: guest.id, guestName: guest.name }));
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
