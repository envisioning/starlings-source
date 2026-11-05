import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_MANIFEST_DESCRIPTION_MAX_CHARS,
  AGENT_MANIFEST_TTL_MILLISECONDS,
  type PeersResponse,
} from '@starlings/contracts';
import { resetPeerRosterCache } from '../src/peers';
import { ensureAgentPeople, refreshAgentManifests } from '../src/agents';
import { recordOwnerHeartbeat, recordOwnerSignIn } from '../src/usage';

const rosa = { sub: 'peers-rosa', email: 'rosa@example.com', name: 'Rosa' };
const ada = { sub: 'peers-ada', email: 'ada@example.com', name: 'Ada' };

async function ownerSession(email = rosa.email, name = rosa.name) {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email }),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}` };
}

async function roster(headers: Record<string, string>) {
  const response = await exports.default.fetch(new Request('http://local/api/peers', { headers }));
  expect(response.status).toBe(200);
  return response.json<PeersResponse>();
}

beforeEach(() => resetPeerRosterCache());

afterEach(async () => {
  resetPeerRosterCache();
  await env.USAGE.prepare('DELETE FROM people WHERE sub IN (?1, ?2, ?3, ?4)')
    .bind(rosa.sub, ada.sub, `dev:${rosa.email}`, `dev:${ada.email}`)
    .run();
  await env.USAGE.prepare('DELETE FROM rings WHERE callee_sub IN (?1, ?2, ?3, ?4)')
    .bind(rosa.sub, ada.sub, `dev:${rosa.email}`, `dev:${ada.email}`)
    .run();
  await env.USAGE.prepare("DELETE FROM people WHERE kind = 'agent'").run();
});

async function post(path: string, headers: Record<string, string>, body: unknown) {
  return exports.default.fetch(new Request(`http://local${path}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', origin: env.WEB_ORIGIN },
    body: JSON.stringify(body),
  }));
}

describe('team presence', () => {
  it('refuses an unauthenticated caller', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/peers', {
      headers: { origin: env.WEB_ORIGIN },
    }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'owner_auth_required' });
  });

  it('lists members and marks the caller', async () => {
    await recordOwnerSignIn(env as Env, rosa, 'mac');
    await recordOwnerSignIn(env as Env, ada, 'ios');

    const body = await roster(await ownerSession());
    const emails = body.peers.map((peer) => peer.email);
    expect(emails).toContain('rosa@example.com');
    expect(emails).toContain('ada@example.com');
    expect(body.peers.find((peer) => peer.email === rosa.email)?.is_self).toBe(true);
    expect(body.peers.find((peer) => peer.email === ada.email)?.is_self).toBe(false);
  });

  it('calls a member with a recent heartbeat active and a cold one offline', async () => {
    await recordOwnerSignIn(env as Env, ada, 'ios', Date.now() - 86_400_000);
    let body = await roster(await ownerSession());
    expect(body.peers.find((peer) => peer.email === ada.email)?.status).toBe('offline');

    resetPeerRosterCache();
    await recordOwnerHeartbeat(env as Env, ada, 'ios');
    body = await roster(await ownerSession());
    const peer = body.peers.find((row) => row.email === ada.email);
    expect(peer?.status).toBe('active');
    expect(peer?.last_client).toBe('ios');
  });

  it('reports a live room as in_meeting and outranks the heartbeat', async () => {
    await recordOwnerHeartbeat(env as Env, rosa, 'ios');
    const owner = await ownerSession();
    const start = await exports.default.fetch(new Request('http://local/api/rooms/rosa/start', {
      method: 'POST',
      headers: owner,
    }));
    expect(start.status).toBe(200);

    resetPeerRosterCache();
    const body = await roster(owner);
    // The dev session and the ledger row are separate subs for the same person;
    // the roster is keyed by person, so either row proves the room is live.
    const peer = body.peers.find((row) => row.email === rosa.email && row.room_slug === 'rosa');
    expect(peer?.status).toBe('in_meeting');

    await exports.default.fetch(new Request('http://local/api/rooms/rosa/end', {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }));
  });

  it('reports every device checked in, not only the last one to beat', async () => {
    // One person, two devices, both awake: a roster that picks the most recent
    // beat is wrong about where to find them half the time.
    await recordOwnerHeartbeat(env as Env, ada, 'mac');
    await recordOwnerHeartbeat(env as Env, ada, 'ios');

    const body = await roster(await ownerSession());
    const peer = body.peers.find((row) => row.email === ada.email);
    expect(peer?.clients).toEqual(['mac', 'ios']);
    // `last_client` still answers "who beat last"; `clients` answers "where are they".
    expect(peer?.last_client).toBe('ios');
  });

  it('drops a device that has gone cold from clients but keeps last_seen_at', async () => {
    const longAgo = Date.now() - 3_600_000;
    await recordOwnerHeartbeat(env as Env, ada, 'mac', longAgo);

    const body = await roster(await ownerSession());
    const peer = body.peers.find((row) => row.email === ada.email);
    expect(peer?.status).toBe('offline');
    expect(peer?.clients).toEqual([]);
    // The whole point of last_seen_at: "last seen an hour ago", not silence.
    expect(peer?.last_seen_at).toBe(longAgo);
  });

  it('lets a member set and clear unavailable, and outranks their heartbeat', async () => {
    // The dev session mints the people row, so the JWT's sub and the ledger row
    // are the same person. `email` is UNIQUE, so seeding a second sub for the
    // same address here would silently write to a row this session cannot see.
    const owner = await ownerSession();

    const until = Date.now() + 1_800_000;
    const set = await post('/api/peers/dnd', owner, { until });
    expect(set.status).toBe(200);
    await expect(set.json()).resolves.toMatchObject({ dnd_until: until });

    let body = await roster(owner);
    let me = body.peers.find((row) => row.is_self);
    expect(me?.status).toBe('dnd');
    expect(me?.dnd_until).toBe(until);

    const cleared = await post('/api/peers/dnd', owner, { until: null });
    expect(cleared.status).toBe(200);
    body = await roster(owner);
    me = body.peers.find((row) => row.is_self);
    expect(me?.status).not.toBe('dnd');
    expect(me?.dnd_until).toBeNull();
  });

  it('delivers a ring to the person rung and to nobody else', async () => {
    const caller = await ownerSession();
    const callee = await ownerSession(ada.email, 'Ada');

    const rung = await post('/api/peers/ring', caller, { peer_email: ada.email });
    expect(rung.status).toBe(200);

    // The caller must not see their own ring: it is stamped per recipient,
    // after the shared roster cache.
    const mine = await roster(caller);
    expect(mine.incoming_ring).toBeNull();

    const hers = await roster(callee);
    expect(hers.incoming_ring?.caller_email).toBe(rosa.email);

    const dismissed = await post('/api/peers/ring/clear', callee, {});
    expect(dismissed.status).toBe(200);
    const after = await roster(callee);
    expect(after.incoming_ring).toBeNull();
  });

  it('refuses to ring somebody who is unavailable', async () => {
    // Enforced, not merely rendered: a ring that lands anyway is decoration.
    const callee = await ownerSession(ada.email, 'Ada');
    await post('/api/peers/dnd', callee, { until: Date.now() + 600_000 });

    const refused = await post('/api/peers/ring', await ownerSession(), { peer_email: ada.email });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ code: 'peer_unavailable' });
  });

  it('sets intent without touching the status the devices prove', async () => {
    const owner = await ownerSession();

    const set = await post('/api/peers/intent', owner, { intent: 'focused', until: Date.now() + 1_800_000 });
    expect(set.status).toBe(200);

    const body = await roster(owner);
    const me = body.peers.find((row) => row.is_self);
    expect(me?.intent).toBe('focused');
    // The whole point of the second axis: what they said, and what their
    // devices proved, are both still true and neither has overwritten the
    // other. Which rung of the evidence ladder they land on is not this test's
    // business — only that intent did not take it over.
    expect(me?.status).not.toBe('dnd');
    expect(me?.intent_until).toBeGreaterThan(Date.now());
  });

  it('drops a lapsed intent without anybody clearing it', async () => {
    const owner = await ownerSession();
    await post('/api/peers/intent', owner, { intent: 'focused', until: Date.now() + 60_000 });

    // Expiry is read at roster time, so moving the deadline into the past is
    // the whole of "time passed" — there is no sweep to wait for.
    await env.USAGE.prepare('UPDATE people SET intent_until = ?2 WHERE email = ?1')
      .bind(rosa.email, Date.now() - 1_000)
      .run();
    resetPeerRosterCache();

    const me = (await roster(owner)).peers.find((row) => row.is_self);
    expect(me?.intent).toBeNull();
    expect(me?.intent_until).toBeNull();
  });

  it('requires an end on focused, and refuses one on available', async () => {
    const owner = await ownerSession();

    const timeboxed = await post('/api/peers/intent', owner, {
      intent: 'available',
      until: Date.now() + 60_000,
    });
    expect(timeboxed.status).toBe(400);

    const endless = await post('/api/peers/intent', owner, { intent: 'focused' });
    expect(endless.status).toBe(400);

    const past = await post('/api/peers/intent', owner, { intent: 'focused', until: Date.now() - 1_000 });
    expect(past.status).toBe(400);

    const set = await post('/api/peers/intent', owner, { intent: 'available' });
    expect(set.status).toBe(200);
    await expect(set.json()).resolves.toMatchObject({ intent: 'available', intent_until: null });

    const me = (await roster(owner)).peers.find((row) => row.is_self);
    expect(me?.intent).toBe('available');
    expect(me?.intent_until).toBeNull();
  });

  it('appears offline to everyone but yourself, and still takes a ring', async () => {
    const me = await ownerSession();
    const other = await ownerSession(ada.email, ada.name);
    // Both hearts beating, so without the flag both read as present.
    await recordOwnerHeartbeat(env as Env, rosa, 'mac');
    await recordOwnerHeartbeat(env as Env, ada, 'mac');
    resetPeerRosterCache();

    const set = await post('/api/peers/appear-offline', me, { invisible: true });
    expect(set.status).toBe(200);
    await expect(set.json()).resolves.toEqual({ invisible: true });

    // My own row tells me the truth, and that I am hidden.
    const mine = (await roster(me)).peers.find((row) => row.is_self);
    expect(mine?.invisible).toBe(true);
    expect(mine?.status).not.toBe('offline');

    // Ada sees an absence indistinguishable from a real one: offline, no
    // devices, no since — and `invisible` false, so nothing marks it as hiding.
    const seen = (await roster(other)).peers.find((row) => row.email === rosa.email);
    expect(seen?.status).toBe('offline');
    expect(seen?.invisible).toBe(false);
    expect(seen?.clients).toEqual([]);
    expect(seen?.since).toBeNull();

    // Hiding is not a closed door: a ring still goes through (DND is the door).
    const ring = await post('/api/peers/ring', other, { peer_email: rosa.email });
    expect(ring.status).toBe(200);

    const cleared = await post('/api/peers/appear-offline', me, { invisible: false });
    expect(cleared.status).toBe(200);
    const visibleAgain = (await roster(other)).peers.find((row) => row.email === rosa.email);
    expect(visibleAgain?.status).not.toBe('offline');
  });

  it('clears intent back to nothing', async () => {
    const owner = await ownerSession();
    await post('/api/peers/intent', owner, { intent: 'available' });
    resetPeerRosterCache();

    const cleared = await post('/api/peers/intent', owner, { intent: null });
    expect(cleared.status).toBe(200);
    const me = (await roster(owner)).peers.find((row) => row.is_self);
    expect(me?.intent).toBeNull();
  });

  it('still rings somebody who is focused', async () => {
    // Only unavailable is a closed door. Focused is read on the callee to
    // keep the ring quiet, never here to swallow it.
    const callee = await ownerSession(ada.email, 'Ada');
    await post('/api/peers/intent', callee, { intent: 'focused', until: Date.now() + 600_000 });

    const rung = await post('/api/peers/ring', await ownerSession(), { peer_email: ada.email });
    expect(rung.status).toBe(200);
    expect((await roster(callee)).incoming_ring?.caller_email).toBe(rosa.email);
  });

  it('refuses intent from an unauthenticated caller', async () => {
    const response = await post('/api/peers/intent', {}, { intent: 'available' });
    expect(response.status).toBe(401);
  });

  it('puts a colleague in the room they are standing in, not their own', async () => {
    const owner = await ownerSession();
    const start = await exports.default.fetch(new Request('http://local/api/rooms/rosa/start', {
      method: 'POST',
      headers: owner,
    }));
    expect(start.status).toBe(200);

    // Ada has no room of her own in the map, so nothing about her own slug
    // could ever say she is busy. Standing in rosa's meeting is what says it.
    await recordOwnerSignIn(env as Env, ada, 'mac');
    const joined = await post('/api/rooms/rosa/join-requests', await ownerSession(ada.email, 'Ada'), {
      name: 'Ada',
      email: ada.email,
    });
    expect(joined.status).toBe(201);
    const receipt = await joined.json<{ requestId: string; lobbyToken: string; status: string }>();
    // A verified member skips the queue, so there is nothing to admit.
    expect(receipt.status).toBe('admitted');
    // Admitted is not the same as standing in the room: `participants` is
    // written when the token is issued, which is what occupancy reads.
    const exchanged = await post(
      `/api/rooms/rosa/join-requests/${receipt.requestId}/exchange`,
      await ownerSession(ada.email, 'Ada'),
      { lobby_token: receipt.lobbyToken },
    );
    expect(exchanged.status).toBe(200);

    resetPeerRosterCache();
    const peers = (await roster(owner)).peers;
    const her = peers.find((row) => row.email === ada.email);
    const him = peers.find((row) => row.email === rosa.email && row.room_slug === 'rosa');
    expect(her?.status).toBe('in_meeting');
    // The whole point: two people carrying the same slug are one conversation,
    // which is the only way a roster can draw a group instead of a list.
    expect(her?.in_room_slug).toBe('rosa');
    expect(him?.in_room_slug).toBe('rosa');

    await exports.default.fetch(new Request('http://local/api/rooms/rosa/end', {
      method: 'POST',
      headers: { ...owner, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }));
    resetPeerRosterCache();
  });

  it('marks a call apart from a wave on the same row', async () => {
    const caller = await ownerSession();
    const callee = await ownerSession(ada.email, 'Ada');

    await post('/api/peers/ring', caller, { peer_email: ada.email });
    expect((await roster(callee)).incoming_ring?.kind).toBe('wave');

    // One outstanding ring per person: calling replaces the wave rather than
    // queueing behind it, and the newer ask is the one that is true.
    const called = await post('/api/peers/call', caller, { peer_email: ada.email });
    expect(called.status).toBe(200);
    const ring = (await roster(callee)).incoming_ring;
    expect(ring?.kind).toBe('call');
    expect(ring?.caller_email).toBe(rosa.email);
  });

  it('refuses to call somebody who is unavailable', async () => {
    // A call is a louder ask than a wave, so the closed door holds at least as
    // firmly — the same 409 the wave gets.
    const callee = await ownerSession(ada.email, 'Ada');
    await post('/api/peers/dnd', callee, { until: Date.now() + 600_000 });

    const refused = await post('/api/peers/call', await ownerSession(), { peer_email: ada.email });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ code: 'peer_unavailable' });
  });

  it('refuses a call from an unauthenticated caller', async () => {
    const response = await post('/api/peers/call', {}, { peer_email: ada.email });
    expect(response.status).toBe(401);
  });

  it('refuses a ring from an unauthenticated caller', async () => {
    const response = await post('/api/peers/ring', {}, { peer_email: ada.email });
    expect(response.status).toBe(401);
  });

  it('bumps last_seen_at from the heartbeat route', async () => {
    await recordOwnerSignIn(env as Env, rosa, 'mac', Date.now() - 86_400_000);
    const response = await exports.default.fetch(new Request('http://local/api/owner/heartbeat', {
      method: 'POST',
      headers: { ...(await ownerSession()), 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({ client: 'ios' }),
    }));
    expect(response.status).toBe(200);
  });
});

describe('agents in the roster', () => {
  const vocab = 'agent-vocab@example.com';

  it('derives an agent row from the map, with no device and no room', async () => {
    await recordOwnerSignIn(env as Env, rosa, 'mac');

    const body = await roster(await ownerSession());
    const agent = body.peers.find((peer) => peer.email === vocab);
    expect(agent).toBeDefined();
    expect(agent).toMatchObject({
      kind: 'agent',
      // The fixture roster names this one and gives it no endpoint, so nothing
      // is listening and the roster says so. It stays fully addressable: the
      // message waits in the thread, which is why `not_connected` is not the
      // same claim as a person being away.
      agent_state: 'not_connected',
      status: 'offline',
      room_slug: null,
      last_client: null,
      clients: [],
      busy_until: null,
      dnd_until: null,
      participants: 0,
    });
  });

  it('reads ready once the map gives it somewhere to be reached', async () => {
    const configured = (env as Env).AGENT_ROSTER;
    (env as Env).AGENT_ROSTER = JSON.stringify({
      [vocab]: { name: 'Vocab', endpoint: 'https://vocab.example.com/handoff' },
    });
    resetPeerRosterCache();
    // The roster read refreshes the agent's manifest; this test is about the
    // state, not the manifest, so the runtime answers with nothing.
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      expect(url).toBe('https://vocab.example.com/manifest');
      return new Response('{}', { status: 404 });
    });
    try {
      await recordOwnerSignIn(env as Env, rosa, 'mac');
      const body = await roster(await ownerSession());
      const agent = body.peers.find((peer) => peer.email === vocab);
      // `ready` is a weaker claim than it looks, and deliberately so: a message
      // reaches a runtime, not that the runtime is up. Proving that needs a
      // probe nothing makes yet.
      expect(agent).toMatchObject({ kind: 'agent', agent_state: 'ready', status: 'available' });
    } finally {
      vi.unstubAllGlobals();
      (env as Env).AGENT_ROSTER = configured;
      resetPeerRosterCache();
    }
  });

  it('carries a rename from the map onto the row', async () => {
    const configured = (env as Env).AGENT_ROSTER;
    try {
      await recordOwnerSignIn(env as Env, rosa, 'mac');
      // First spelling writes the row.
      (env as Env).AGENT_ROSTER = JSON.stringify({ [vocab]: 'Vocab' });
      resetPeerRosterCache();
      await roster(await ownerSession());

      // Second spelling has to reach it. This used to be dead code: the upsert
      // ran only for rows that were absent, so a row kept the name it was born
      // with and renaming an agent changed the map and nothing else.
      (env as Env).AGENT_ROSTER = JSON.stringify({ [vocab]: 'Vocabulary' });
      resetPeerRosterCache();
      const body = await roster(await ownerSession());
      expect(body.peers.find((peer) => peer.email === vocab)?.name).toBe('Vocabulary');
    } finally {
      (env as Env).AGENT_ROSTER = configured;
      resetPeerRosterCache();
    }
  });

  it('drops an agent that has left the map, without deleting its row', async () => {
    const configured = (env as Env).AGENT_ROSTER;
    try {
      await recordOwnerSignIn(env as Env, rosa, 'mac');
      (env as Env).AGENT_ROSTER = JSON.stringify({ [vocab]: 'Vocab' });
      resetPeerRosterCache();
      expect((await roster(await ownerSession())).peers.some((peer) => peer.email === vocab)).toBe(true);

      // Retired. The row stays — an old message resolves its sender through it,
      // and a transcript quoting nobody is worse than a list one name shorter.
      (env as Env).AGENT_ROSTER = JSON.stringify({});
      resetPeerRosterCache();
      expect((await roster(await ownerSession())).peers.some((peer) => peer.email === vocab)).toBe(false);

      const { results } = await (env as Env).USAGE.prepare(
        'SELECT sub FROM people WHERE email = ?1',
      ).bind(vocab).all<{ sub: string }>();
      expect(results).toHaveLength(1);
    } finally {
      (env as Env).AGENT_ROSTER = configured;
      resetPeerRosterCache();
    }
  });

  it('gives a person no agent state at all', async () => {
    await recordOwnerSignIn(env as Env, rosa, 'mac');
    const body = await roster(await ownerSession());
    const person = body.peers.find((peer) => peer.email === rosa.email);
    // Present and null, not absent. A person's presence is evidence about a
    // person; an agent's is the health of a service. One field cannot mean
    // both, so a person never carries the agent one.
    expect(person?.agent_state).toBeNull();
  });

  it('sorts people above agents, whatever either is doing', async () => {
    await recordOwnerSignIn(env as Env, rosa, 'mac');
    await recordOwnerSignIn(env as Env, ada, 'ios');

    const body = await roster(await ownerSession());
    const lastHuman = body.peers.map((peer) => peer.kind).lastIndexOf('human');
    const firstAgent = body.peers.map((peer) => peer.kind).indexOf('agent');
    expect(firstAgent).toBeGreaterThan(lastHuman);
  });

  it('gives an agent no intent to have', async () => {
    await recordOwnerSignIn(env as Env, rosa, 'mac');
    const body = await roster(await ownerSession());
    const agent = body.peers.find((peer) => peer.email === vocab);
    expect(agent?.intent).toBeNull();
    expect(agent?.intent_until).toBeNull();
  });

  it('refuses to ring an agent', async () => {
    await recordOwnerSignIn(env as Env, rosa, 'mac');
    // The roster read is what derives the row.
    await roster(await ownerSession());

    const response = await post('/api/peers/ring', await ownerSession(), { peer_email: vocab });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'peer_unavailable' });
  });
});

describe('agent manifest', () => {
  const vocab = 'agent-vocab@example.com';
  const vocabSub = `agent:${vocab}`;

  // The default test roster names this agent with no endpoint, so a roster read
  // never fetches a manifest — the read-path tests can seed the cached column
  // and read it back without a runtime in the loop.
  async function seedManifest(raw: unknown): Promise<void> {
    await recordOwnerSignIn(env as Env, rosa, 'mac');
    await roster(await ownerSession()); // derive the agent row
    await env.USAGE.prepare("UPDATE people SET agent_manifest = ?2 WHERE sub = ?1 AND kind = 'agent'")
      .bind(vocabSub, raw === null ? null : JSON.stringify(raw))
      .run();
    resetPeerRosterCache();
  }

  async function agentPeer() {
    const body = await roster(await ownerSession());
    return body.peers.find((peer) => peer.email === vocab);
  }

  it('attaches a cached manifest to the agent peer', async () => {
    await seedManifest({
      description: 'Curates the Envisioning AI/ML vocabulary.',
      skills: [{ name: 'vocab-creator', description: 'Add a term from a link.' }],
      home_url: 'https://www.org.example/vocab',
    });
    const agent = await agentPeer();
    expect(agent?.manifest).toEqual({
      description: 'Curates the Envisioning AI/ML vocabulary.',
      skills: [{ name: 'vocab-creator', description: 'Add a term from a link.' }],
      home_url: 'https://www.org.example/vocab',
    });
  });

  it('keeps the model, tools, connections, schedules and repo link, and drops the junk in them', async () => {
    await seedManifest({
      description: 'Curates vocabulary.',
      model: 'anthropic/claude-sonnet-5',
      tools: [
        { name: 'vocab-write', description: 'Create or update a term.', requires_approval: true },
        { name: 'vocab-lookup', requires_approval: 'yes' },
        { description: 'no name' },
      ],
      connections: [{ name: 'cms', protocol: 'openapi', description: 'not a field' }, { protocol: 'mcp' }],
      schedules: [{ cron: '0 6 * * *', description: 'Morning audit.' }, { description: 'no cron' }],
      repo_url: 'https://github.com/envisioning/vocab-agent',
      home_url: 'javascript:alert(1)',
    });
    const agent = await agentPeer();
    expect(agent?.manifest).toEqual({
      description: 'Curates vocabulary.',
      model: 'anthropic/claude-sonnet-5',
      tools: [
        { name: 'vocab-write', description: 'Create or update a term.', requires_approval: true },
        { name: 'vocab-lookup' },
      ],
      connections: [{ name: 'cms', protocol: 'openapi' }],
      schedules: [{ cron: '0 6 * * *', description: 'Morning audit.' }],
      repo_url: 'https://github.com/envisioning/vocab-agent',
    });
  });

  it('keeps a version stamp and drops a build time from the future', async () => {
    await seedManifest({ description: 'Curates vocabulary.', version: 'efa621a', built_at: Date.now() - 3_600_000 });
    expect((await agentPeer())?.manifest).toMatchObject({ version: 'efa621a' });
    expect((await agentPeer())?.manifest?.built_at).toBeTypeOf('number');

    await seedManifest({ description: 'Curates vocabulary.', built_at: Date.now() + 7 * 86_400_000 });
    expect((await agentPeer())?.manifest?.built_at).toBeUndefined();
  });

  it('counts the hand-off ledger into an activity block, and a person gets none', async () => {
    await recordOwnerSignIn(env as Env, rosa, 'mac');
    await roster(await ownerSession());
    const now = Date.now();
    const day = 86_400_000;
    const rows: [number, number | null, number | null][] = [
      [now - 100 * day, now - 100 * day + 60_000, null],  // old: counts toward the total only
      [now - 2 * day, now - 2 * day + 30_000, null],       // 30 s
      [now - day, now - day + 120_000, null],              // 2 min — the median of three
      [now - 3_600_000, now - 3_600_000 + 600_000, null],  // 10 min, and the latest reply
      [now - 60_000, null, now - 30_000],                  // reset, never answered
    ];
    for (const [accepted, replied, reset] of rows) {
      await env.USAGE.prepare(
        'INSERT INTO agent_handoffs (agent_sub, thread_id, accepted_at, replied_at, reset_at) VALUES (?1, ?2, ?3, ?4, ?5)',
      ).bind(vocabSub, `thread-${accepted}`, accepted, replied, reset).run();
    }
    resetPeerRosterCache();
    const body = await roster(await ownerSession());
    expect(body.peers.find((peer) => peer.email === vocab)?.activity).toEqual({
      jobs_total: 5,
      jobs_30d: 4,
      resets_30d: 1,
      last_replied_at: now - 3_600_000 + 600_000,
      typical_reply_ms: 120_000,
    });
    expect(body.peers.find((peer) => peer.email === rosa.email)?.activity).toBeNull();
  });

  it('clamps an oversized manifest as it reads it', async () => {
    await seedManifest({ description: 'D'.repeat(5000) });
    const agent = await agentPeer();
    expect(agent?.manifest?.description).toHaveLength(AGENT_MANIFEST_DESCRIPTION_MAX_CHARS);
  });

  it('drops a malformed skill and keeps the good one', async () => {
    await seedManifest({
      description: 'Curates vocabulary.',
      skills: [{ description: 'no name, nothing to draw' }, { name: 'vocab-creator' }],
    });
    const agent = await agentPeer();
    expect(agent?.manifest?.skills).toEqual([{ name: 'vocab-creator' }]);
  });

  it('keeps key names and whether each is set, and drops anything that is not a bare name', async () => {
    await seedManifest({
      description: 'Curates vocabulary.',
      keys: [
        { name: 'AGENT_WEBHOOK_SECRET', set: true },
        { name: 'FLUX_API_KEY', set: false },
        { name: 'FLUX_API_KEY=sg_live_123', set: true },   // a value leaked into the name: dropped, never drawn
        { name: 'lowercase', set: true },                   // not an env name
        { name: 'NO_SET_FIELD' },                           // unknown is unset, never claimed set
      ],
    });
    const agent = await agentPeer();
    expect(agent?.manifest?.keys).toEqual([
      { name: 'AGENT_WEBHOOK_SECRET', set: true },
      { name: 'FLUX_API_KEY', set: false },
      { name: 'NO_SET_FIELD', set: false },
    ]);
  });

  it('keeps the house docs a runtime reads, with the required mark and its links, and drops a doc with no name', async () => {
    await seedManifest({
      description: 'Writes reports.',
      docs: [
        {
          name: 'voice',
          title: 'House voice',
          description: 'How Envisioning writes.',
          source: 'envisioning/org.example:VOICE.md@main',
          view_url: 'https://github.com/envisioning/org.example/blob/main/VOICE.md',
          edit_url: 'https://github.com/envisioning/org.example/edit/main/VOICE.md',
          required: true,
        },
        { name: 'design', view_url: 'javascript:alert(1)', required: 'yes' },  // a bad link is dropped, a non-boolean is not required
        { title: 'Nameless' },                                                  // no name: nothing to read it by
      ],
    });
    const agent = await agentPeer();
    expect(agent?.manifest?.docs).toEqual([
      {
        name: 'voice',
        title: 'House voice',
        description: 'How Envisioning writes.',
        source: 'envisioning/org.example:VOICE.md@main',
        view_url: 'https://github.com/envisioning/org.example/blob/main/VOICE.md',
        edit_url: 'https://github.com/envisioning/org.example/edit/main/VOICE.md',
        required: true,
      },
      { name: 'design' },
    ]);
  });

  it('reads a manifest of pure junk as none at all', async () => {
    // A 200 that carries no description is nothing a card can honestly draw.
    await seedManifest({ skills: [{ name: 'orphan' }] });
    const agent = await agentPeer();
    expect(agent?.manifest).toBeNull();
  });

  it('gives an unmanifested agent and a person a null manifest', async () => {
    await recordOwnerSignIn(env as Env, rosa, 'mac');
    const body = await roster(await ownerSession());
    expect(body.peers.find((peer) => peer.email === vocab)?.manifest).toBeNull();
    expect(body.peers.find((peer) => peer.email === rosa.email)?.manifest).toBeNull();
  });

  it('fetches, clamps and caches from the runtime, then respects the TTL', async () => {
    const configured = (env as Env).AGENT_ROSTER;
    (env as Env).AGENT_ROSTER = JSON.stringify({
      [vocab]: { name: 'Vocab', endpoint: 'https://vocab.example.com/handoff' },
    });
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('vocab.example.com')) {
        calls += 1;
        expect(url).toBe('https://vocab.example.com/manifest');
        // Oversize description and a nameless skill, to prove the fetch path
        // clamps and drops before it ever reaches the cache.
        return new Response(JSON.stringify({
          description: 'D'.repeat(5000),
          skills: [{ description: 'no name' }, { name: 'vocab-creator', description: 'Add a term.' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    try {
      await ensureAgentPeople(env as Env, Date.now());

      await refreshAgentManifests(env as Env, Date.now());
      expect(calls).toBe(1);

      const stored = await env.USAGE.prepare(
        'SELECT agent_manifest, agent_manifest_fetched_at FROM people WHERE sub = ?1',
      ).bind(vocabSub).first<{ agent_manifest: string | null; agent_manifest_fetched_at: number | null }>();
      expect(stored?.agent_manifest_fetched_at).not.toBeNull();
      const manifest = JSON.parse(stored!.agent_manifest!);
      expect(manifest.description).toHaveLength(AGENT_MANIFEST_DESCRIPTION_MAX_CHARS);
      expect(manifest.skills).toEqual([{ name: 'vocab-creator', description: 'Add a term.' }]);

      // Within the TTL, the fetched-at gate skips the runtime entirely.
      await refreshAgentManifests(env as Env, Date.now());
      expect(calls).toBe(1);

      // Past the TTL, exactly one more probe.
      await refreshAgentManifests(env as Env, Date.now() + AGENT_MANIFEST_TTL_MILLISECONDS + 1);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
      (env as Env).AGENT_ROSTER = configured;
      resetPeerRosterCache();
    }
  });

  it('clears a stale copy on a hard 404 but keeps it on a transient error', async () => {
    const configured = (env as Env).AGENT_ROSTER;
    (env as Env).AGENT_ROSTER = JSON.stringify({
      [vocab]: { name: 'Vocab', endpoint: 'https://vocab.example.com/handoff' },
    });
    const realFetch = globalThis.fetch;
    let status = 200;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('vocab.example.com')) {
        if (status === 200) {
          return new Response(JSON.stringify({ description: 'Curates vocabulary.' }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('', { status });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    async function storedManifest(): Promise<string | null> {
      const row = await env.USAGE.prepare('SELECT agent_manifest FROM people WHERE sub = ?1')
        .bind(vocabSub).first<{ agent_manifest: string | null }>();
      return row?.agent_manifest ?? null;
    }

    try {
      await ensureAgentPeople(env as Env, Date.now());

      // A good copy lands.
      await refreshAgentManifests(env as Env, Date.now());
      await expect(storedManifest()).resolves.not.toBeNull();

      // A 5xx is transient: the last good copy survives.
      status = 503;
      await refreshAgentManifests(env as Env, Date.now() + AGENT_MANIFEST_TTL_MILLISECONDS + 1);
      await expect(storedManifest()).resolves.not.toBeNull();

      // A 404 is the runtime saying it serves none: the stale copy is cleared.
      status = 404;
      await refreshAgentManifests(env as Env, Date.now() + 2 * AGENT_MANIFEST_TTL_MILLISECONDS + 2);
      await expect(storedManifest()).resolves.toBeNull();
    } finally {
      globalThis.fetch = realFetch;
      (env as Env).AGENT_ROSTER = configured;
      resetPeerRosterCache();
    }
  });
});
