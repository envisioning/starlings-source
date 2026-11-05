// Team presence read model. Who else at Envisioning is around, whether their
// Mac can take a call, and whether they want to be interrupted at all.
// Envisioning-only by route: presence is never exposed to guests or to
// unauthenticated callers (docs/PRIVACY.md).
//
// The roster is the people ledger in D1 — everyone who has ever signed in —
// enriched with live room state for the members who have a permanent room, the
// calendar for the ones who connected one, and their own unavailable.
// Membership is not the room map: a colleague without a room is still on the
// team, they just cannot be called.

import { identityDomains } from './workspace-identity';
import { publicRoomSlugs, roomOfMember } from './member-rooms';
import { readManagedAgentReadiness } from './managed-agent-provisioning';
import { managedAgentDescription } from '@starlings/contracts/managed-agent';
import { agents, ensureAgentPeople, refreshAgentManifests } from './agents';
import type { RoleSession } from './capabilities';
import { fetchCalendarFreeBusy } from './calendar';
import {
  AGENT_ACTIVITY_WINDOW_MILLISECONDS,
  AGENT_BUSY_TTL_MILLISECONDS,
  type AgentActivity,
  type AgentManifest,
  type AgentState,
  parseAgentManifest,
  PEER_ACTIVE_MILLISECONDS,
  PEER_BUSY_CACHE_MILLISECONDS,
  PEER_BUSY_HORIZON_MILLISECONDS,
  PEER_CLIENTS,
  PEER_ROSTER_CACHE_MILLISECONDS,
  PEER_INTENTS,
  PEER_ROSTER_MAX_AGE_MILLISECONDS,
  RING_TTL_MILLISECONDS,
  WORK_DAYS_WEEKDAYS,
  type IncomingRing,
  type OwnerSession,
  type Peer,
  type PeerClient,
  type PeerClientVersions,
  type PeerAppearOfflineResponse,
  type PeerDoNotDisturbResponse,
  type PeerIntent,
  type PeerIntentResponse,
  type PeerProfileInput,
  type PeerKind,
  type RingKind,
  type PeerStatus,
  type PeersResponse,
} from './contracts';
import { ThreadError } from './errors';
import type { RoomPresenceSnapshot } from './room-coordinator';
import { roomStub } from './do-jurisdiction';

interface PersonRow {
  sub: string;
  email: string;
  name: string | null;
  kind: string;
  last_seen_at: number;
  room_slug: string | null;
  last_client: string | null;
  dnd_until: number | null;
  agent_busy_until: number | null;
  /** The runtime's clamped manifest JSON, cached on the row. Null for a person. */
  agent_manifest: string | null;
  intent: string | null;
  intent_until: number | null;
  invisible: number;
  last_seen_mac: number | null;
  last_seen_ios: number | null;
  last_seen_web: number | null;
  version_mac: string | null;
  version_ios: string | null;
  version_web: string | null;
  avatar_updated_at: number | null;
  timezone: string | null;
  work_start_minute: number | null;
  work_end_minute: number | null;
  work_days: number | null;
  title: string | null;
  pronouns: string | null;
}

/**
 * The profile half of a roster row. Read straight through for a human and
 * blank for an agent — a piece of software has no zone, no working hours and
 * no pronouns, and inventing them would put a local time on something that
 * does not live anywhere.
 */
function profileOf(person: PersonRow): Pick<Peer, 'timezone' | 'working_hours' | 'title' | 'pronouns'> {
  // Both ends or neither. A half-written pattern is treated as never having
  // said, because every surface reading it would otherwise invent the rest.
  const hours = person.work_start_minute !== null && person.work_end_minute !== null
    ? {
      start_minute: person.work_start_minute,
      end_minute: person.work_end_minute,
      days: person.work_days ?? WORK_DAYS_WEEKDAYS,
    }
    : null;
  return {
    timezone: person.timezone,
    working_hours: hours,
    title: person.title,
    pronouns: person.pronouns,
  };
}

/**
 * The cached manifest, re-clamped as it is read. It was clamped before it was
 * cached, so this is belt-and-braces — a row written by an older build or
 * corrupted in place can never reach a client unbounded — and a parse failure
 * is drawn as no manifest, which is the honest name-and-state card.
 */
function manifestOf(person: PersonRow): AgentManifest | null {
  if (!person.agent_manifest) return null;
  try {
    return parseAgentManifest(JSON.parse(person.agent_manifest));
  } catch {
    return null;
  }
}

/** When a person's calendar says they are busy, and until when. */
type BusyMap = Map<string, number>;

/**
 * Isolate-local roster cache. One uncached read costs a Durable Object
 * round-trip per mapped room, and the whole team polls this; ten seconds is
 * shorter than any status a person can perceive changing and turns a team-sized
 * poll into one fan-out. Per-isolate on purpose — no coordination, no binding,
 * and staleness is bounded by the TTL either way.
 */
let cached: { at: number; response: PeersResponse } | null = null;

/**
 * Free/busy is an *external* call per member, so it gets its own, longer TTL
 * and survives roster refreshes. Kept separate rather than folded into the
 * roster cache: a ten-second calendar poll would be twelve times the Google
 * traffic for an answer that changes on the hour.
 */
let busyCached: { at: number; busy: BusyMap } | null = null;

export function resetPeerRosterCache(): void {
  cached = null;
  busyCached = null;
}

export async function peerRoster(owner: RoleSession, env: Env, ctx: ExecutionContext): Promise<PeersResponse> {
  const now = Date.now();

  if (cached && now - cached.at < PEER_ROSTER_CACHE_MILLISECONDS) {
    return personalize(cached.response, owner, env, now);
  }

  // On the cache miss only, so this is at most one extra read every ten
  // seconds and a write only the first time an agent is added to the map.
  await ensureAgentPeople(env, now);

  // Off the response path: the fetch to a sandbox is on `ctx.waitUntil`, its
  // own TTL gates it to once per fifteen minutes per agent, and this read
  // draws whatever copy is already cached. A roster never waits on a runtime.
  ctx.waitUntil(refreshAgentManifests(env, now));

  const managed = await readManagedAgentReadiness(env);
  const defined = await agents(env);
  // Which agents have somewhere to be reached. Read from the roster rather
  // than probed: an entry with no endpoint cannot answer, and that is knowable
  // without spending a request on finding out.
  const connected = new Set(
    defined.filter((agent) => agent.endpoint && (agent.sub !== managed?.installation.agent_sub || managed.installation.state === 'ready' || managed.installation.state === 'paused')).map((agent) => agent.email),
  );
  const agentAvatars = new Map(defined.map((agent) => [agent.email, agent.avatar]));
  // The map is the roster, so an agent that has left it leaves the list.
  //
  // Filtered on the read rather than deleted: a `people` row is what an old
  // message resolves its sender through, and dropping one would leave a
  // transcript quoting nobody. So a retired agent keeps its history and stops
  // being somewhere anyone can write. Renaming an address mints a new `sub`,
  // which is why two spellings of one agent sat in the list together.
  const listed = new Set(defined.map((agent) => agent.sub));

  const people = (await loadPeople(env, now))
    .filter((person) => person.kind !== 'agent' || listed.has(person.sub));
  if (managed) {
    const person = people.find((person) => person.sub === managed.installation.agent_sub);
    if (person) person.agent_manifest = JSON.stringify({ ...(manifestOf(person) ?? {}), description: managedAgentDescription(managed) });
  }
  const rooms = await loadRoomPresence(env, people);
  const busy = await loadBusy(env, people, now);
  const occupancy = occupiedRooms(rooms);
  const activity = await loadAgentActivity(env, now);

  const response: PeersResponse = {
    generated_at: now,
    peers: people
      .map((person) => toPeer(
        person,
        rooms.get(person.room_slug ?? ''),
        busy.get(person.email),
        now,
        occupancy.get(person.email.toLowerCase()),
        connected,
        activity,
        agentAvatars,
      ))
      .sort(comparePeers),
    incoming_ring: null,
  };
  cached = { at: now, response };
  return personalize(response, owner, env, now);
}

/**
 * The two things that differ per caller — their own row, and whether somebody
 * rang them — are stamped *after* the cache rather than making the cache
 * per-caller. Getting this wrong would serve one person's ring to the team.
 */
async function personalize(
  response: PeersResponse,
  owner: OwnerSession,
  env: Env,
  now: number,
): Promise<PeersResponse> {
  return {
    generated_at: response.generated_at,
    // Appear-offline is applied here, per reader, because the roster above
    // is one cached answer for the whole team: the hidden person sees their
    // own true row, everyone else sees an absence indistinguishable from one.
    peers: response.peers.map((peer) => {
      const isSelf = peer.email === owner.email;
      return isSelf || !peer.invisible ? { ...peer, is_self: isSelf } : maskInvisible(peer);
    }),
    incoming_ring: await incomingRing(env, owner.sub, now),
  };
}

/**
 * Envisioning identity spans two domains, so the roster is scoped to the *org*
 * rather than to the caller's own suffix. Filtering by the caller's literal
 * domain would have split one team in two the moment somebody signed in with
 * an identity domain — each half invisible to the other.
 */
/**
 * Rows hidden in Admin are filtered here and nowhere else. That is the whole
 * feature: a test account keeps its `people` row — so old messages still
 * resolve their sender — and simply stops being part of the team everyone
 * else sees. See `migrations/0024_person_hidden.sql`.
 */
/**
 * The cold-row cutoff is deliberately not applied to agents. An agent has no
 * heartbeat to give — its `last_seen_at` is stamped once, when the row is
 * derived from the map — so a month later the cutoff would quietly drop it out
 * of the roster, and the fix would have been to beat a fake heartbeat for
 * something that is not a device.
 */
// An agent is on the team by `kind`, whatever its domain: an enrolled agent is
// `<name>@agents.<workspace host>`, never a sign-in domain. Which agents show
// is the roster's call (`listed` in `peerRoster`), not this query's.
async function loadPeople(env: Env, now: number): Promise<PersonRow[]> {
  try {
    const clause = identityDomains(env).map((_, index) => `email LIKE ?${index + 1}`).join(' OR ');
    const bindings: unknown[] = identityDomains(env).map((domain) => `%@${domain}`);
    const cutoffIndex = bindings.length + 1;
    const { results } = await env.USAGE.prepare(
      `SELECT sub, email, name, kind, last_seen_at, room_slug, last_client, dnd_until,
              agent_busy_until, agent_manifest, intent, intent_until, invisible,
              last_seen_mac, last_seen_ios, last_seen_web, version_mac, version_ios, version_web,
              avatar_updated_at,
              timezone, work_start_minute, work_end_minute, work_days, title, pronouns
         FROM people
        WHERE ((${clause}) OR kind = 'agent') AND (kind = 'agent' OR last_seen_at >= ?${cutoffIndex})
          AND hidden_at IS NULL
        ORDER BY last_seen_at DESC`,
    ).bind(...bindings, now - PEER_ROSTER_MAX_AGE_MILLISECONDS).all<PersonRow>();
    return results;
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'peers.people.read.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return [];
  }
}

/**
 * What each agent has done, from the hand-off ledger. Two reads on the cache
 * miss — a total per agent, and the last thirty days row by row so the median
 * is a real median — and nothing per agent beyond that. An agent with no
 * rows has no entry, which a client draws as no ACTIVITY block.
 */
async function loadAgentActivity(env: Env, now: number): Promise<Map<string, AgentActivity>> {
  const activity = new Map<string, AgentActivity>();
  try {
    const since = now - AGENT_ACTIVITY_WINDOW_MILLISECONDS;
    const [totals, recent] = await Promise.all([
      env.USAGE.prepare(
        'SELECT agent_sub, COUNT(*) AS jobs, MAX(replied_at) AS last_replied_at FROM agent_handoffs GROUP BY agent_sub',
      ).all<{ agent_sub: string; jobs: number; last_replied_at: number | null }>(),
      env.USAGE.prepare(
        'SELECT agent_sub, accepted_at, replied_at, reset_at FROM agent_handoffs WHERE accepted_at >= ?1',
      ).bind(since).all<{ agent_sub: string; accepted_at: number; replied_at: number | null; reset_at: number | null }>(),
    ]);
    for (const row of totals.results) {
      activity.set(row.agent_sub, {
        jobs_total: row.jobs,
        jobs_30d: 0,
        resets_30d: 0,
        last_replied_at: row.last_replied_at,
        typical_reply_ms: null,
      });
    }
    const replies = new Map<string, number[]>();
    for (const row of recent.results) {
      const entry = activity.get(row.agent_sub);
      if (!entry) continue;
      entry.jobs_30d += 1;
      if (row.reset_at !== null) entry.resets_30d += 1;
      if (row.replied_at !== null && row.replied_at >= row.accepted_at) {
        const list = replies.get(row.agent_sub) ?? [];
        list.push(row.replied_at - row.accepted_at);
        replies.set(row.agent_sub, list);
      }
    }
    for (const [sub, list] of replies) {
      list.sort((a, b) => a - b);
      const entry = activity.get(sub)!;
      entry.typical_reply_ms = list[Math.floor(list.length / 2)] ?? null;
    }
  } catch (error) {
    // A ledger that cannot be read costs the ACTIVITY block, not the roster.
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'peers.agent_activity.read.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
  return activity;
}

/**
 * Live state for the rooms the roster actually references, and only for a
 * slug that is still a public room (member-rooms.ts): a retired room or one
 * that left the map has no presence to show.
 */
async function loadRoomPresence(
  env: Env,
  people: PersonRow[],
): Promise<Map<string, RoomPresenceSnapshot>> {
  const mapped = await publicRoomSlugs(env);
  const slugs = [...new Set(people.map((row) => row.room_slug).filter((slug): slug is string => Boolean(slug)))]
    .filter((slug) => mapped.has(slug));

  const snapshots = await Promise.all(slugs.map(async (slug) => {
    try {
      const room = await roomStub(env, slug);
      return await room.presenceSnapshot(slug);
    } catch (error) {
      // One unreachable room must not blank the whole team.
      console.warn(JSON.stringify({
        level: 'warn',
        message: 'peers.room.snapshot.failed',
        slug,
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      return null;
    }
  }));

  const byslug = new Map<string, RoomPresenceSnapshot>();
  for (const snapshot of snapshots) if (snapshot) byslug.set(snapshot.slug, snapshot);
  return byslug;
}

/**
 * Which room each member is actually standing in, from the rooms that are
 * open. A person is in at most one — LiveKit would not have them in two, and
 * if a stale row ever said otherwise the first live room wins rather than the
 * map disagreeing with itself.
 *
 * This is what makes the team surface able to say *who is with whom*: without
 * it every participant is drawn against their own room, so a conversation with
 * four people in it renders as four unrelated rows.
 */
function occupiedRooms(
  rooms: Map<string, RoomPresenceSnapshot>,
): Map<string, RoomPresenceSnapshot> {
  const byEmail = new Map<string, RoomPresenceSnapshot>();
  for (const snapshot of rooms.values()) {
    if (!snapshot.in_session) continue;
    for (const email of snapshot.member_emails) {
      if (!byEmail.has(email)) byEmail.set(email, snapshot);
    }
  }
  return byEmail;
}

/**
 * Calendar busy, read with **each member's own** connected token for their own
 * calendar — never one caller asking Google about everybody. Two reasons: the
 * answer then does not depend on how freebusy sharing is configured inside the
 * Workspace, and it is identical for every caller, so it stays inside the
 * shared roster cache instead of forking it per person.
 *
 * Free/busy only: start and end, never a title. A member with no connected
 * calendar, or a calendar that will not answer, simply has no busy signal and
 * falls back to the room-and-heartbeat ladder.
 */
async function loadBusy(env: Env, people: PersonRow[], now: number): Promise<BusyMap> {
  if (busyCached && now - busyCached.at < PEER_BUSY_CACHE_MILLISECONDS) return busyCached.busy;

  const timeMin = new Date(now).toISOString();
  const timeMax = new Date(now + PEER_BUSY_HORIZON_MILLISECONDS).toISOString();
  const answers = await Promise.all(people.map(async (person) => {
    try {
      const [answer] = await fetchCalendarFreeBusy(
        env,
        { sub: person.sub, email: person.email, name: person.name ?? person.email },
        { timeMin, timeMax, emails: [person.email] },
      );
      if (!answer || answer.error) return null;
      const until = busyUntil(answer.busy, now);
      return until === null ? null : ([person.email, until] as const);
    } catch {
      // No calendar, a revoked token, or Google being unavailable. Presence
      // degrades to what the room and the heartbeat prove; it never fails.
      return null;
    }
  }));

  const busy: BusyMap = new Map();
  for (const answer of answers) if (answer) busy.set(answer[0], answer[1]);
  busyCached = { at: now, busy };
  return busy;
}

/**
 * The end of the block covering `now`, following straight into any block that
 * begins the moment the previous one ends. Back-to-back meetings are one
 * stretch of unavailability to everybody except the person living them.
 */
export function busyUntil(
  slots: ReadonlyArray<{ start: string; end: string }>,
  now: number,
): number | null {
  const spans = slots
    .map((slot) => ({ start: Date.parse(slot.start), end: Date.parse(slot.end) }))
    .filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start)
    .sort((a, b) => a.start - b.start);

  let until: number | null = null;
  for (const span of spans) {
    if (until === null) {
      if (span.start <= now && span.end > now) until = span.end;
      continue;
    }
    if (span.start <= until && span.end > until) until = span.end;
  }
  return until;
}

function toPeer(
  person: PersonRow,
  room: RoomPresenceSnapshot | undefined,
  busy: number | undefined,
  now: number,
  occupied: RoomPresenceSnapshot | undefined = undefined,
  connected: ReadonlySet<string> = new Set(),
  activity: ReadonlyMap<string, AgentActivity> = new Map(),
  agentAvatars: ReadonlyMap<string, Peer['agent_avatar']> = new Map(),
): Peer {
  const kind: PeerKind = person.kind === 'agent' ? 'agent' : 'human';
  if (kind === 'agent') {
    return toAgentPeer(
      person,
      now,
      connected.has(person.email),
      activity.get(person.sub) ?? null,
      agentAvatars.get(person.email) ?? null,
    );
  }
  // Where they are standing beats what their own room is doing. Somebody in a
  // colleague's meeting used to read `active` — a person visibly at their desk
  // and, as far as the roster could tell, doing nothing.
  const here = occupied ?? room;
  const { status, since } = derivePeerStatus(person, here, busy ?? null, now);
  return {
    email: person.email,
    favorite_ref: person.sub,
    name: person.name,
    kind,
    room_slug: person.room_slug,
    status,
    // A person has no agent state. Present and null rather than absent,
    // because every peer shares one shape.
    agent_state: null,
    since,
    last_seen_at: person.last_seen_at,
    last_client: person.last_client,
    clients: activeClients(person, now),
    client_versions: activeClientVersions(person, now),
    in_room_slug: status === 'in_meeting' ? (here?.slug ?? null) : null,
    busy_until: status === 'busy' ? (busy ?? null) : null,
    dnd_until: person.dnd_until && person.dnd_until > now ? person.dnd_until : null,
    avatar_updated_at: person.avatar_updated_at,
    agent_avatar: null,
    ...currentIntent(person, now),
    invisible: person.invisible === 1,
    ...profileOf(person),
    // A person never carries a manifest — it is an agent's self-description.
    manifest: null,
    activity: null,
    participants: status === 'in_meeting' ? (here?.participants ?? 0) : 0,
    is_self: false,
  };
}

/**
 * What a colleague who appears offline looks like to everybody else: the same
 * row an absent person produces. Nothing here may leak a signal — no `since`
 * (it would date the "departure"), no devices, no room, no intent, no busy.
 * `dnd_until` is kept because `ringPeer` still enforces it and would name the
 * reason; hiding it here would only make that refusal read as a bug.
 */
function maskInvisible(peer: Peer): Peer {
  return {
    ...peer,
    status: 'offline',
    since: null,
    clients: [],
    client_versions: {},
    in_room_slug: null,
    participants: 0,
    busy_until: null,
    intent: null,
    intent_until: null,
    invisible: false,
    is_self: false,
  };
}

/**
 * An agent has no device, no room and no calendar, so every field the human
 * ladder is built from is missing rather than false. Running it through
 * `derivePeerStatus` would read the absence as evidence and report an agent
 * offline five minutes after it was added — the same word meaning the opposite
 * thing.
 *
 * `agent_state` is what a client draws, and it is not the person ladder: a
 * person's presence is evidence about a person, an agent's is the health of a
 * service, and one green dot cannot honestly mean both.
 *
 * Three states, in descending order of how much has been checked. `working` —
 * a runtime *accepted* a hand-off and has not answered; the only claim here
 * anything verified. `ready` — the roster gives it an endpoint, so a message
 * reaches a runtime; whether that runtime is up needs a probe nothing makes
 * yet. `not_connected` — no endpoint, nothing listening **yet**, and the
 * message still waits in the thread, which is why this is not "away".
 *
 * `status` is kept in step for clients that have not learned `agent_state`,
 * and it is the coarser answer: an agent nothing is listening to used to read
 * `available`, which was the roster promising something nobody had checked.
 * See docs/AGENTS_SURFACE.md.
 */
function toAgentPeer(
  person: PersonRow,
  now: number,
  connected: boolean,
  activity: AgentActivity | null,
  agentAvatar: Peer['agent_avatar'],
): Peer {
  const working = person.agent_busy_until !== null && person.agent_busy_until > now;
  const agentState: AgentState = working ? 'working' : connected ? 'ready' : 'not_connected';
  return {
    email: person.email,
    favorite_ref: person.sub,
    name: person.name,
    kind: 'agent',
    // Never a room: an agent is not in meetings, so it can never be called
    // into one, and a slug here would put a Join button on it.
    room_slug: null,
    in_room_slug: null,
    status: working ? 'busy' : connected ? 'available' : 'offline',
    agent_state: agentState,
    // When the runtime accepted the hand-off it is on: `markWorking` stamps
    // acceptance plus the TTL, so the TTL taken back off is the acceptance.
    // The clock a pane counts up from while the row says working. Nothing
    // else about an agent has a "since" — it has no device to have been
    // seen on — so idle is null, the same as a person who is offline.
    since: working ? person.agent_busy_until! - AGENT_BUSY_TTL_MILLISECONDS : null,
    last_seen_at: person.last_seen_at,
    last_client: null,
    clients: [],
    // Reusing the calendar's field on purpose: it already means "this ends at
    // some point", and every client already draws it.
    busy_until: working ? person.agent_busy_until : null,
    dnd_until: null,
    // An agent can have a picture like anybody else — its row is a `people`
    // row — and the roster carries it for the same reason it carries a name.
    avatar_updated_at: person.avatar_updated_at,
    agent_avatar: agentAvatar,
    // An agent has nothing to intend. The column exists on its row because
    // every peer shares one shape, not because anything will ever write it.
    intent: null,
    intent_until: null,
    // Nothing to hide from either — an agent's availability is service health.
    invisible: false,
    // Nor anywhere to be. A local time on something that does not live
    // anywhere is the one field on this row that would read as a lie rather
    // than as an absence — so an agent keeps its title and has no clock.
    timezone: null,
    working_hours: null,
    title: person.title,
    pronouns: null,
    // What the runtime says it is and can do, or null when it serves none —
    // drawn read-only as the agent's own words, never as a Meet-authored claim.
    manifest: manifestOf(person),
    activity,
    participants: 0,
    is_self: false,
  };
}

/**
 * An intent that has run out is no intent at all. Read at roster time rather
 * than swept, so a lapsed `focused` needs no writer to come back and clear
 * it — the person whose deadline passed is very likely the one person not
 * looking at the app.
 */
export function currentIntent(
  person: Pick<PersonRow, 'intent' | 'intent_until'>,
  now: number,
): { intent: PeerIntent | null; intent_until: number | null } {
  const value = PEER_INTENTS.find((candidate) => candidate === person.intent) ?? null;
  if (!value) return { intent: null, intent_until: null };
  if (person.intent_until !== null && person.intent_until <= now) {
    return { intent: null, intent_until: null };
  }
  return { intent: value, intent_until: person.intent_until };
}

/**
 * Every device checked in inside the active window, not just the one that beat
 * last. Somebody at their desk with a phone beside them is on both, and a
 * roster that picks one is wrong about where to find them half the time.
 */
export function activeClients(
  person: Pick<PersonRow, 'last_seen_mac' | 'last_seen_ios' | 'last_seen_web'>,
  now: number,
): PeerClient[] {
  const seen: Record<PeerClient, number | null> = {
    mac: person.last_seen_mac,
    ios: person.last_seen_ios,
    web: person.last_seen_web,
  };
  return PEER_CLIENTS.filter((client) => {
    const at = seen[client];
    return at !== null && at !== undefined && now - at <= PEER_ACTIVE_MILLISECONDS;
  });
}

/** The version each active device last reported. A device with no report has no key. */
export function activeClientVersions(
  person: Pick<PersonRow, 'last_seen_mac' | 'last_seen_ios' | 'last_seen_web' | 'version_mac' | 'version_ios' | 'version_web'>,
  now: number,
): PeerClientVersions {
  const reported: Record<PeerClient, string | null> = {
    mac: person.version_mac,
    ios: person.version_ios,
    web: person.version_web,
  };
  const versions: PeerClientVersions = {};
  for (const client of activeClients(person, now)) {
    const version = reported[client];
    if (version) versions[client] = version;
  }
  return versions;
}

/**
 * Strongest provable signal wins, with one exception at the top: do not
 * disturb is *self-declared*, and a person saying "not now" outranks anything
 * their devices can prove about them.
 *
 * Below it, a meeting outranks a calendar block, which outranks an idle Mac,
 * and all three outrank a heartbeat — because each is evidence about whether a
 * room can take a call, while a heartbeat only says a phone is awake.
 */
export function derivePeerStatus(
  person: Pick<PersonRow, 'last_seen_at' | 'dnd_until'>,
  room: RoomPresenceSnapshot | undefined,
  busy: number | null,
  now: number,
): { status: PeerStatus; since: number | null } {
  if (person.dnd_until !== null && person.dnd_until > now) {
    return { status: 'dnd', since: null };
  }
  if (room?.in_session) return { status: 'in_meeting', since: room.host_seen_at };
  if (busy !== null && busy > now) return { status: 'busy', since: null };
  if (room?.host_present) return { status: 'available', since: room.host_seen_at };
  if (now - person.last_seen_at <= PEER_ACTIVE_MILLISECONDS) {
    return { status: 'active', since: person.last_seen_at };
  }
  return { status: 'offline', since: null };
}

const STATUS_RANK: Record<PeerStatus, number> = {
  in_meeting: 0,
  busy: 1,
  available: 2,
  active: 3,
  dnd: 4,
  offline: 5,
};

/**
 * Present first, then alphabetical — a roster that reorders itself is
 * unreadable. Unavailable sorts low on purpose: it is a person who has
 * asked not to be at the top of anybody's list.
 */
function comparePeers(a: Peer, b: Peer): number {
  // People before agents, whatever either is doing. An agent is permanently
  // `available`, so without this it would sit above every colleague who is
  // merely at their desk — the roster's first job is to show you the team.
  if (a.kind !== b.kind) return a.kind === 'agent' ? 1 : -1;
  const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
  if (rank !== 0) return rank;
  return (a.name ?? a.email).localeCompare(b.name ?? b.email);
}

// ---------------------------------------------------------------------------
// Ring — a nudge with no sound and no push. See IncomingRing in contracts.

/**
 * Ring a colleague: write one row that their next roster poll will read. There
 * is no delivery guarantee and there must be no pretence of one — a ring
 * reaches a client that is running and foregrounded, and nothing else.
 */
export async function ringPeer(
  owner: RoleSession,
  env: Env,
  peerEmail: string,
  kind: RingKind = 'wave',
): Promise<{ ok: true }> {
  const callee = await env.USAGE.prepare(
    'SELECT sub, kind, dnd_until FROM people WHERE email = ?1',
  ).bind(peerEmail.toLowerCase()).first<{ sub: string; kind: string; dnd_until: number | null }>();
  if (!callee) throw new ThreadError('That person is not on your team.', 404, 'room_not_found');
  // A ring is a nudge toward a room, and an agent is never in one. Refused
  // here rather than merely hidden on the clients: a ring that lands in a row
  // nothing will ever read is a call nobody answers.
  if (callee.kind === 'agent') {
    throw new ThreadError('That is an agent. Send it a message instead.', 409, 'peer_unavailable');
  }

  const now = Date.now();
  // Unavailable is enforced here, not merely rendered. A ring that still
  // lands after somebody has said "not now" is decoration.
  if (callee.dnd_until !== null && callee.dnd_until > now) {
    throw new ThreadError('They are unavailable. Send a message instead.', 409, 'peer_unavailable');
  }
  // `focused` deliberately does *not* refuse here. It is read on the callee
  // to suppress the sound, not on the server to swallow the ring: a wave that
  // vanishes without telling either side is worse than a quiet one, and "they
  // will see it when they look up" is the entire point of focused. Only
  // unavailable is a closed door.

  // A call asks somebody to open a room, so the caller must have one to be
  // walked back to. A wave asks for nothing and needs nothing.
  const room = await roomOfMember(env, owner.email);
  await env.USAGE.prepare(
    `INSERT INTO rings (callee_sub, kind, caller_email, caller_name, caller_room_slug, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(callee_sub) DO UPDATE SET
       kind = excluded.kind,
       caller_email = excluded.caller_email,
       caller_name = excluded.caller_name,
       caller_room_slug = excluded.caller_room_slug,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at`,
  ).bind(callee.sub, kind, owner.email, owner.name, room, now, now + RING_TTL_MILLISECONDS).run();
  return { ok: true };
}

/**
 * A member's own Claude asks them to open their own room (,
 * docs/MCP.md §start_meeting). Not `ringPeer`: there is no colleague and no
 * `reachColleague` capability in play — the owner is both ends, and the
 * caller's name is the paired client so the row says who asked.
 *
 * Refused when a ring is already pending, because `rings` holds one row per
 * person: an agent's ask must never overwrite a colleague who is waving.
 * Refused when the owner has no room, since there is nothing to open.
 *
 * Returns whether an ask now sits in the row. It is never a promise that a
 * device saw it — the same honesty `ringPeer` keeps.
 */
export async function askOwnerToHost(
  env: Env,
  owner: { sub: string; email: string },
  askedBy: string,
): Promise<{ asked: boolean; room: string | null; reason?: 'no_room' | 'ring_pending' }> {
  const room = await roomOfMember(env, owner.email);
  if (!room) return { asked: false, room: null, reason: 'no_room' };

  const now = Date.now();
  const pending = await env.USAGE.prepare(
    'SELECT kind FROM rings WHERE callee_sub = ?1 AND expires_at > ?2',
  ).bind(owner.sub, now).first<{ kind: string | null }>();
  if (pending) return { asked: false, room, reason: 'ring_pending' };

  await env.USAGE.prepare(
    `INSERT INTO rings (callee_sub, kind, caller_email, caller_name, caller_room_slug, created_at, expires_at)
     VALUES (?1, 'agent_start', ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(callee_sub) DO UPDATE SET
       kind = excluded.kind,
       caller_email = excluded.caller_email,
       caller_name = excluded.caller_name,
       caller_room_slug = excluded.caller_room_slug,
       created_at = excluded.created_at,
       expires_at = excluded.expires_at`,
  ).bind(owner.sub, owner.email, askedBy, room, now, now + RING_TTL_MILLISECONDS).run();
  return { asked: true, room };
}

/** Answered, dismissed, or simply seen — either way it stops being pending. */
export async function clearRing(owner: RoleSession, env: Env): Promise<{ ok: true }> {
  await env.USAGE.prepare('DELETE FROM rings WHERE callee_sub = ?1').bind(owner.sub).run();
  return { ok: true };
}

async function incomingRing(env: Env, sub: string, now: number): Promise<IncomingRing | null> {
  try {
    const row = await env.USAGE.prepare(
      `SELECT kind, caller_email, caller_name, caller_room_slug, created_at, expires_at
         FROM rings WHERE callee_sub = ?1 AND expires_at > ?2`,
    ).bind(sub, now).first<{
      kind: string | null;
      caller_email: string;
      caller_name: string | null;
      caller_room_slug: string | null;
      created_at: number;
      expires_at: number;
    }>();
    if (!row) return null;
    return {
      // An unknown kind reads as a wave: the harmless one. A build that has
      // not heard of a gesture must not offer to accept it.
      kind: row.kind === 'call' ? 'call' : 'wave',
      caller_email: row.caller_email,
      caller_name: row.caller_name,
      room_slug: row.caller_room_slug,
      created_at: row.created_at,
      expires_at: row.expires_at,
    };
  } catch (error) {
    // A roster that fails because nobody rang is worse than a missed ring.
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'peers.ring.read.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return null;
  }
}

// ---------------------------------------------------------------------------
// Unavailable — the closed door. Stored as `dnd_until`.

/**
 * `until` is absolute and required (null clears it). An unavailable with no
 * end is one nobody ever turns off, and a roster full of permanently silent
 * people is a roster nobody trusts.
 */
export async function setDoNotDisturb(
  owner: RoleSession,
  env: Env,
  until: number | null,
): Promise<PeerDoNotDisturbResponse> {
  const now = Date.now();
  const value = until !== null && until > now ? until : null;
  await env.USAGE.prepare('UPDATE people SET dnd_until = ?2 WHERE sub = ?1').bind(owner.sub, value).run();
  // Their own row is in the shared roster, so the team must not keep seeing
  // the old answer for the rest of the cache window.
  cached = null;
  return { dnd_until: value };
}

/**
 * Appear offline, the third thing a person sets by hand. Sticky — no `until` —
 * because it is a choice about being seen, not about being interrupted, and a
 * choice like that lapsing on a timer is how a roster starts lying about who
 * is around. See migration 0030 and docs/PRESENCE.md.
 */
export async function setAppearOffline(
  owner: RoleSession,
  env: Env,
  invisible: boolean,
): Promise<PeerAppearOfflineResponse> {
  await env.USAGE.prepare('UPDATE people SET invisible = ?2 WHERE sub = ?1')
    .bind(owner.sub, invisible ? 1 : 0)
    .run();
  cached = null;
  return { invisible };
}

/**
 * The other thing a person sets by hand. Kept next to unavailable because
 * they are the same kind of claim, and deliberately in a different column
 * because they are enforced differently: unavailable turns a ring away,
 * intent only changes how one lands.
 *
 * `focused` always carries an expiry and nothing else may. The schema already
 * refuses the other shapes; this only guards against a deadline in the past.
 */
export async function setIntent(
  owner: RoleSession,
  env: Env,
  intent: PeerIntent | null,
  until: number | null,
): Promise<PeerIntentResponse> {
  const now = Date.now();
  if (intent === 'focused' && (until === null || until <= now)) {
    throw new ThreadError('Focused needs an end that is still ahead.', 400, 'invalid_request');
  }
  const value = intent;
  const expires = value === 'focused' ? until : null;
  await env.USAGE.prepare('UPDATE people SET intent = ?2, intent_until = ?3 WHERE sub = ?1')
    .bind(owner.sub, value, expires)
    .run();
  // Their own row is in the shared roster, so the team must not keep seeing
  // the old answer for the rest of the cache window.
  cached = null;
  return { intent: value, intent_until: expires };
}

/**
 * Edit the parts of your own row you own. Yours only — there is no route for
 * writing somebody else's title, and a roster where colleagues can rename each
 * other is a roster nobody trusts.
 *
 * Every field is optional and separately clearable, so a client that only
 * edits a title cannot blank a zone it never drew. Setting a zone deliberately
 * pins it: `timezone_source` becomes `self`, and check-ins stop moving it.
 */
export async function setProfile(
  owner: Pick<RoleSession, 'sub'>,
  env: Env,
  input: PeerProfileInput,
): Promise<{ ok: true }> {
  const sets: string[] = [];
  const bindings: unknown[] = [];
  const set = (column: string, value: unknown) => {
    bindings.push(value);
    sets.push(`${column} = ?${bindings.length + 1}`);
  };

  if (input.title !== undefined) set('title', input.title || null);
  if (input.pronouns !== undefined) set('pronouns', input.pronouns || null);
  if (input.timezone !== undefined) {
    set('timezone', input.timezone);
    // Clearing it hands the column back to the devices, which is the only way
    // to undo a pin without knowing what the pin was.
    set('timezone_source', input.timezone === null ? null : 'self');
  }
  if (input.working_hours !== undefined) {
    set('work_start_minute', input.working_hours?.start_minute ?? null);
    set('work_end_minute', input.working_hours?.end_minute ?? null);
    set('work_days', input.working_hours?.days ?? null);
  }
  if (sets.length === 0) return { ok: true };

  await env.USAGE.prepare(`UPDATE people SET ${sets.join(', ')} WHERE sub = ?1`)
    .bind(owner.sub, ...bindings).run();
  // The roster is cached per isolate for ten seconds, and a profile edit is
  // the one write here somebody watches for its own effect.
  resetPeerRosterCache();
  return { ok: true };
}
