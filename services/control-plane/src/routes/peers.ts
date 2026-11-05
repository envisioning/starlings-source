import { cancelAgent } from '../agents';
import { enrollAgent, pollEnrollment } from '../agent-enrollment';
import type { AgentEnrollPollResponse, AgentEnrollResponse } from '@starlings/contracts/agent-enrollment';
import { serveAvatar } from '../avatars';
import {
  type AgentCancelResponse,
  type OkResponse,
  type PeerAppearOfflineResponse,
  type PeerDoNotDisturbResponse,
  type PeerIntentResponse,
  type PeersResponse,
  type SearchResponse,
  agentCancelSchema,
  avatarQuerySchema,
  peerAppearOfflineSchema,
  peerCallSchema,
  peerDoNotDisturbSchema,
  peerIntentSchema,
  peerProfileSchema,
  peerRingSchema,
  searchQuerySchema,
} from '../contracts';
import { json, readBoundedJSON } from '../http';
import { clearRing, peerRoster, ringPeer, setAppearOffline, setDoNotDisturb, setIntent, setProfile } from '../peers';
import { parseQuery } from '../route-util';
import { searchRows } from '../search';
import { defineRoute, type Route } from '../route-types';

export const peersRoutes: readonly Route[] = [
  defineRoute({
    method: 'GET',
    path: '/api/avatar',
    gate: { kind: 'capability', capability: 'ownProfile' },
    handler: async ({ env, url }) => {
      const query = parseQuery(avatarQuerySchema, url);
      return serveAvatar(env, query.email, query.v ?? null);
    },
  }),

  // One search (AGENTS.md invariant 27): every hit this Worker can
  // see, matched and ranked by the contract. An empty query is answered
  // empty without the fan-out — the palette draws recents and doors from
  // the device for that.
  defineRoute({
    method: 'GET',
    path: '/api/search',
    gate: { kind: 'capability', capability: 'crmWork' },
    handler: async ({ request, env, ctx, url, owner }) => {
      const query = searchQuerySchema.parse(Object.fromEntries(url.searchParams));
      if (query.q.trim().length === 0) return json({ rows: [], partial: [] } satisfies SearchResponse);
      return json(await searchRows(request, env, ctx, owner, query.q, query.tz) satisfies SearchResponse);
    },
  }),

  // Agent enrollment (docs/AGENTS_SURFACE.md §Enrollment): any runtime asks to
  // join Team; nothing happens until a workspace admin approves its code.
  defineRoute({
    method: 'POST',
    path: '/api/agents/enroll',
    gate: { kind: 'public', reason: 'an agent runtime asks to join; only an admin approval makes it an agent' },
    handler: async ({ request, env }) => json(await enrollAgent(request, env) satisfies AgentEnrollResponse, 201),
  }),

  defineRoute({
    method: 'POST',
    path: '/api/agents/enroll/poll',
    gate: { kind: 'public', reason: 'the poll token, held only by the runtime that enrolled, is the proof' },
    handler: async ({ request, env }) => json(await pollEnrollment(request, env) satisfies AgentEnrollPollResponse),
  }),

  // A card taken out of an agent's hands on the board (docs/BOARD.md). The
  // person's drag already moved the label; this tells the runtime to stop.
  defineRoute({
    method: 'POST',
    path: '/api/agents/cancel',
    gate: { kind: 'capability', capability: 'agents', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = agentCancelSchema.parse(await readBoundedJSON(request));
      const delivery = await cancelAgent(env, {
        agentEmail: body.agent_email,
        ref: body.ref,
        sender: { sub: owner.sub, email: owner.email, name: owner.name },
      });
      // `told` predates `delivery` and is kept for a client that reads only it.
      return json({ ok: true, told: delivery === 'accepted', delivery } satisfies AgentCancelResponse);
    },
  }),

  // A call is the same row with a different ask: open your room, I want to
  // talk now. The caller then joins the ordinary way once that room is live —
  // `memberAdmission` lets a verified member in without a queue, so nothing
  // here weakens lobby-before-media. See docs/SURFACES.md §Reaching a person.
  defineRoute({
    method: 'POST',
    path: '/api/peers/call',
    gate: { kind: 'capability', capability: 'reachColleague', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = peerCallSchema.parse(await readBoundedJSON(request));
      return json(await ringPeer(owner, env, body.peer_email, 'call') satisfies OkResponse);
    },
  }),

  // The two parts of presence a person sets by hand. Unavailable is a closed
  // door and is enforced — a ring is refused against it. Intent only says
  // where somebody is, and changes how a ring lands rather than whether.
  defineRoute({
    method: 'POST',
    path: '/api/peers/dnd',
    gate: { kind: 'capability', capability: 'roster', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = peerDoNotDisturbSchema.parse(await readBoundedJSON(request));
      return json(await setDoNotDisturb(owner, env, body.until) satisfies PeerDoNotDisturbResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/peers/intent',
    gate: { kind: 'capability', capability: 'roster', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = peerIntentSchema.parse(await readBoundedJSON(request));
      return json(await setIntent(owner, env, body.intent, body.until ?? null) satisfies PeerIntentResponse);
    },
  }),

  // Appear offline: hides you from the roster, refuses nothing. See
  // docs/PRESENCE.md §"Appear offline".
  defineRoute({
    method: 'POST',
    path: '/api/peers/appear-offline',
    gate: { kind: 'capability', capability: 'roster', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = peerAppearOfflineSchema.parse(await readBoundedJSON(request));
      return json(await setAppearOffline(owner, env, body.invisible) satisfies PeerAppearOfflineResponse);
    },
  }),

  defineRoute({
    method: 'GET',
    path: '/api/peers',
    gate: { kind: 'capability', capability: 'roster' },
    handler: async ({ env, ctx, owner }) => json(await peerRoster(owner, env, ctx) satisfies PeersResponse),
  }),

  // Ring a colleague: no push, no APNs. One row the callee's next roster poll
  // reads, expiring on its own. Reaches a foregrounded client and nothing else
  // — see IncomingRing in packages/contracts. A running Mac makes a sound of
  // its own when it notices one, which is a local reaction to a poll, not a
  // notification this route delivers.
  defineRoute({
    method: 'POST',
    path: '/api/peers/ring',
    gate: { kind: 'capability', capability: 'reachColleague', origin: 'trusted' },
    // The gate before the body: a refusal is 401/403, never a 400 that
    // answers before the session is read.
    handler: async ({ request, env, owner }) => {
      const body = peerRingSchema.parse(await readBoundedJSON(request));
      return json(await ringPeer(owner, env, body.peer_email) satisfies OkResponse);
    },
  }),

  defineRoute({
    method: 'POST',
    path: '/api/peers/ring/clear',
    gate: { kind: 'capability', capability: 'reachColleague', origin: 'trusted' },
    handler: async ({ env, owner }) => json(await clearRing(owner, env) satisfies OkResponse),
  }),

  // Your own row, and only your own: there is no route here for writing
  // somebody else's title.
  defineRoute({
    method: 'PATCH',
    path: '/api/peers/profile',
    gate: { kind: 'capability', capability: 'ownProfile', origin: 'trusted' },
    handler: async ({ request, env, owner }) => {
      const body = peerProfileSchema.parse(await readBoundedJSON(request));
      return json(await setProfile(owner, env, body) satisfies OkResponse);
    },
  }),
];
