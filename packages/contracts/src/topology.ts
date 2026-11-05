import { z } from 'zod';

/**
 * The topology registry — which services Meet is made of and what runs between
 * them, in one place, as data.
 *
 * `docs/MAP.md` is the prose version and stays the place a sentence gets
 * argued over. This file is the same facts in a shape a page can draw:
 * `web/src/SystemDiagram.tsx` renders it, and `web/src/topology.test.ts` keeps
 * it honest — every `code` path and every `doc` a row names must exist, every
 * edge must land on a node, and the invariants below are asserted as data
 * rather than trusted as prose.
 *
 * Two densities, one registry. A node with no `parent` is a box on the public
 * drawing (`/workspace`); a node with one is a box inside its parent on the
 * full drawing (`/workspace/status`). Adding a service is one row plus its
 * edges — never a second copy of the picture.
 *
 * Nothing here is layout. Where a box lands is `web/src/topology-layout.ts`,
 * computed from `lane` and row order, so this file never has a coordinate in
 * it.
 *
 * Not `services/control-plane/src/capabilities.ts` (what a role may do), and
 * not `capabilities.ts` next door (what the product does). This is what the
 * product is *built out of*.
 */

/**
 * What kind of thing a box is. Drives its shape and its colour, nothing else.
 * `sibling` is another service Envisioning runs — Core, Docs, Keep are ours in
 * the way the Worker is, and drawing them like a vendor said otherwise.
 */
export const TOPOLOGY_KINDS = ['client', 'media', 'edge', 'store', 'sibling', 'external'] as const;
export const topologyKindSchema = z.enum(TOPOLOGY_KINDS);
export type TopologyKind = z.infer<typeof topologyKindSchema>;

/** The rows of the drawing, top to bottom. A child sits in its parent's lane. */
export const TOPOLOGY_LANE_IDS = ['people', 'media', 'control', 'state', 'outside'] as const;
export const topologyLaneSchema = z.enum(TOPOLOGY_LANE_IDS);
export type TopologyLaneId = z.infer<typeof topologyLaneSchema>;

export type TopologyLaneDef = {
  id: TopologyLaneId;
  title: string;
  blurb: string;
  /** Drawn as a column beside that lane instead of as its own row. */
  beside?: TopologyLaneId;
};

export const TOPOLOGY_LANES: readonly TopologyLaneDef[] = [
  { id: 'people', title: 'In the meeting', blurb: 'The devices a person is looking at.' },
  { id: 'media', title: 'Media', blurb: 'Audio and video, end to end, never recorded.' },
  { id: 'control', title: 'The control plane', blurb: 'One Cloudflare Worker. Text only — it never sees a stream.' },
  // Beside the control plane, not under it: everything it keeps is one step
  // sideways, so a line from the Worker to an outside service does not have to
  // cross the store to get there.
  { id: 'state', title: 'What it keeps', blurb: 'Room state, the words, the ledger, the files.', beside: 'control' },
  { id: 'outside', title: 'The rest of the company', blurb: 'Services Starlings reads and writes on a member\'s behalf.' },
];

/** How a line is carried. `binding` is a Cloudflare binding — it never leaves the account. */
export const TOPOLOGY_TRANSPORTS = ['webrtc', 'https', 'wss', 'binding', 'queue', 'local'] as const;
export const topologyTransportSchema = z.enum(TOPOLOGY_TRANSPORTS);
export type TopologyTransport = z.infer<typeof topologyTransportSchema>;

export const TRANSPORT_LABEL: Record<TopologyTransport, string> = {
  webrtc: 'WebRTC',
  https: 'HTTPS',
  wss: 'WebSocket',
  binding: 'Cloudflare binding',
  queue: 'Queue',
  local: 'On the device',
};

export const topologyNodeSchema = z.object({
  /** Stable slug. The diagram links to `#<id>`; do not rename. */
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  name: z.string().min(1),
  kind: topologyKindSchema,
  lane: topologyLaneSchema,
  /**
   * The box this one collapses into on the public drawing. Absent means the
   * node is itself a box there. One level only — a parent has no parent.
   */
  parent: z.string().min(1).optional(),
  /** One sentence, in `docs/MAP.md` voice: what this thing holds or does. */
  holds: z.string().min(1),
  /** Whose machine it runs on, when it is not ours. */
  vendor: z.string().min(1).optional(),
  /**
   * Where this box keeps what it holds. A service of ours answers it from its
   * own repo's docs; a vendor's box answers it only where we know.
   */
  stores: z.string().min(1).optional(),
  /** Repo-relative path that owns it — a file or a directory. Must exist. */
  code: z.string().min(1).optional(),
  /** The doc that owns it, relative to the repo root. Must exist. */
  doc: z.string().regex(/^docs\/.+\.md$/u).optional(),
  /**
   * `full` keeps a box off the public drawing without collapsing it into
   * another — for the machinery a reader of `/workspace` does not need.
   */
  detail: z.enum(['overview', 'full']).optional(),
  /**
   * Drawn, but carrying nothing today. Nothing carries it at the moment — a
   * row says what it is in its own sentence instead — and it is here for the
   * day a switch is the point again.
   */
  dormant: z.string().min(1).optional(),
  /**
   * The Cloudflare resources this box accounts for, as `<worker>/<kind>/<name>`
   * read off that Worker's `wrangler.jsonc`. `web/src/topology.test.ts` reads
   * the configs and fails on a binding no box claims, so a new one cannot go
   * undrawn.
   */
  cloudflare: z.array(z.string().regex(/^(meet|docs|keep)\/[a-z0-9_]+(?:\/.+)?$/u)).optional(),
}).strict();
export type TopologyNode = z.infer<typeof topologyNodeSchema>;

/** The Workers the registry draws, and where each one's config lives. */
export const CLOUDFLARE_WORKERS = {
  meet: 'envisioning/starlings services/control-plane/wrangler.jsonc',
  docs: 'envisioning/docs services/docs-api/wrangler.jsonc',
  keep: 'envisioning/keep services/keep-api/wrangler.jsonc',
} as const;
export type CloudflareWorker = keyof typeof CLOUDFLARE_WORKERS;

export const topologyEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  /** What travels. A noun phrase, not a protocol — the protocol is `over`. */
  carries: z.string().min(1),
  over: topologyTransportSchema,
  /** `both` draws one line with two heads; `one` points at `to`. */
  dir: z.enum(['one', 'both']),
  /**
   * What this line never carries. The invariants of `AGENTS.md` as data: the
   * test reads these, and the drawing prints them on the line.
   */
  never: z.string().min(1).optional(),
  /**
   * `overview` lines are on both drawings and may only join two parentless
   * nodes. `full` lines are the detail, and may join anything.
   */
  detail: z.enum(['overview', 'full']),
  doc: z.string().regex(/^docs\/.+\.md$/u).optional(),
  dormant: z.string().min(1).optional(),
}).strict();
export type TopologyEdge = z.infer<typeof topologyEdgeSchema>;

/** Date of the last read of the code against every row. Change it when you change a row. */
export const TOPOLOGY_REVIEWED_AT = '2026-10-15';

export const TOPOLOGY_NODES: TopologyNode[] = [
  // ---- In the meeting ------------------------------------------------------
  {
    id: 'host-device',
    name: 'The hosting device',
    kind: 'client',
    lane: 'people',
    holds: 'One owner device opens the room, admits guests, and writes the transcript on its own hardware.',
    code: 'Sources',
    doc: 'docs/TRANSCRIPTION.md',
  },
  {
    id: 'mac',
    name: 'Mac app',
    kind: 'client',
    lane: 'people',
    parent: 'host-device',
    holds: 'AppKit. Host and Join, local speech-to-text, the five windows, and the `starlings` socket.',
    code: 'Sources',
    doc: 'docs/OPERATIONS.md',
  },
  {
    id: 'ios',
    name: 'iPhone and iPad app',
    kind: 'client',
    lane: 'people',
    parent: 'host-device',
    holds: 'SwiftUI. Hosts, admits and transcribes on device, with the Live Activity and widgets beside it.',
    code: 'iOS',
    doc: 'docs/IOS_HOST.md',
  },
  {
    id: 'watch',
    name: 'Apple Watch',
    kind: 'client',
    lane: 'people',
    parent: 'host-device',
    holds: 'A companion to the phone. Reads `agenda.json` out of the app group; never a token.',
    code: 'watchOS',
    doc: 'docs/SURFACES.md',
  },
  {
    id: 'extension',
    name: 'Chrome extension',
    kind: 'client',
    lane: 'people',
    parent: 'host-device',
    holds: 'Tells the Mac who is speaking in a call Starlings did not host, so ambient capture has names.',
    code: 'extension',
    doc: 'docs/MEET_EVENTS.md',
  },
  {
    id: 'browser',
    name: 'The browser',
    kind: 'client',
    lane: 'people',
    holds: 'Guests join at `/room/<slug>` with no account; a signed-in member gets the five surfaces too. It never hosts.',
    code: 'web',
    doc: 'docs/ROOM_ENTRY.md',
  },

  // ---- Media ---------------------------------------------------------------
  {
    id: 'livekit',
    name: 'LiveKit Cloud',
    kind: 'media',
    lane: 'media',
    vendor: 'LiveKit',
    holds: 'Carries audio, video and screen between the people in the room. Nothing is recorded, and no stream is stored.',
    doc: 'docs/PRIVACY.md',
  },

  // ---- The control plane ---------------------------------------------------
  {
    id: 'worker',
    stores: 'Durable Objects: one per room, per conversation, per member',
    name: 'Starlings control plane',
    kind: 'edge',
    lane: 'control',
    vendor: 'Cloudflare',
    holds: 'One Worker: the door, the routes, and the SPA in front of them. It holds text and never media.',
    code: 'services/control-plane/src/index.ts',
    doc: 'docs/MAP.md',
    cloudflare: ['meet/worker'],
  },
  {
    id: 'room-do',
    name: 'Room',
    kind: 'edge',
    lane: 'control',
    parent: 'worker',
    holds: 'A Durable Object per room: who knocked, who was admitted, consent, the transcript text, the summary.',
    code: 'services/control-plane/src/room-coordinator.ts',
    doc: 'docs/ROOM_ENTRY.md',
    cloudflare: ['meet/durable_object/RoomCoordinator'],
  },
  {
    id: 'thread-do',
    name: 'Threads',
    kind: 'edge',
    lane: 'control',
    parent: 'worker',
    holds: 'A Durable Object per conversation: messages, reactions, mentions, and the attachments\' keys.',
    code: 'services/control-plane/src/thread-coordinator.ts',
    doc: 'docs/GUEST_THREADS.md',
    cloudflare: ['meet/durable_object/ThreadCoordinator'],
  },
  {
    id: 'notes-do',
    name: 'Quick Notes',
    kind: 'edge',
    lane: 'control',
    parent: 'worker',
    holds: 'A Durable Object per member: the notes taken in a hurry, from any surface.',
    code: 'services/control-plane/src/quick-notes.ts',
    doc: 'docs/WORK.md',
    cloudflare: ['meet/durable_object/QuickNotesCoordinator'],
  },
  {
    id: 'mcp',
    name: 'MCP door',
    kind: 'edge',
    lane: 'control',
    parent: 'worker',
    holds: 'A member\'s Claude calls the Starlings tools as that member, under a grant they issued.',
    code: 'services/control-plane/src/mcp.ts',
    doc: 'docs/MCP.md',
  },
  {
    id: 'static-assets',
    name: 'Static Assets',
    kind: 'edge',
    lane: 'control',
    parent: 'worker',
    holds: 'The built web app, served by the same Worker. The Worker runs first, so every route is checked before the app answers.',
    code: 'services/control-plane/src/index.ts',
    doc: 'docs/DEPLOYMENT.md',
    cloudflare: ['meet/assets'],
  },
  {
    id: 'rate-limits',
    name: 'Rate limiting',
    kind: 'edge',
    lane: 'control',
    parent: 'worker',
    holds: 'Seven per-minute burst guards: the knock, presence, feedback, error reports, link previews, the agent door and MCP.',
    code: 'services/control-plane/src/http.ts',
    doc: 'docs/SECURITY.md',
    cloudflare: [
      'meet/ratelimit/FEEDBACK_LIMIT',
      'meet/ratelimit/JOIN_LIMIT',
      'meet/ratelimit/PRESENCE_LIMIT',
      'meet/ratelimit/AGENT_LIMIT',
      'meet/ratelimit/LINK_PREVIEW_LIMITER',
      'meet/ratelimit/MCP_LIMIT',
      'meet/ratelimit/ERROR_EVENT_LIMIT',
    ],
  },
  {
    id: 'secrets-store',
    name: 'Secrets Store',
    kind: 'edge',
    lane: 'control',
    parent: 'worker',
    holds: 'Keys every Starlings workspace shares, kept once in starlings-shared. Envisioning reads the support line key, which signs its request to connect to hq.',
    code: 'services/control-plane/src/support-line.ts',
    doc: 'docs/CONFIGURATION.md',
    cloudflare: ['meet/secrets_store_secrets'],
  },
  {
    id: 'cron',
    name: 'Cron trigger',
    kind: 'edge',
    lane: 'control',
    parent: 'worker',
    holds: 'Every five minutes: the agent watchdog, the calendar sweep, favorites and GitHub sync, pruning, and the daily backup plan.',
    code: 'services/control-plane/src/worker-scheduled.ts',
    doc: 'docs/OPERATIONS.md',
    cloudflare: ['meet/cron/*/5 * * * *'],
  },
  {
    id: 'workers-logs',
    name: 'Workers Logs',
    kind: 'edge',
    lane: 'control',
    parent: 'worker',
    holds: 'One request in a hundred is logged. A failure is also counted in D1, and the count is what mails a person.',
    code: 'services/control-plane/src/ops.ts',
    doc: 'docs/OPERATIONS.md',
    cloudflare: ['meet/observability'],
  },
  {
    id: 'workers-builds',
    name: 'Workers Builds',
    kind: 'edge',
    lane: 'control',
    parent: 'worker',
    holds: 'Every push to main builds the web app and deploys the Worker, with its D1 migrations.',
    doc: 'docs/DEPLOYMENT.md',
  },

  // ---- What it keeps -------------------------------------------------------
  {
    id: 'store',
    stores: 'D1, two KV namespaces, four R2 buckets and two queues, all on our own Cloudflare account',
    name: 'Starlings store',
    kind: 'store',
    lane: 'state',
    vendor: 'Cloudflare',
    holds: 'The ledger, the tokens, the files and the job queue behind the Worker. Text and files — no media bucket.',
    code: 'services/control-plane/migrations',
    doc: 'docs/MAP.md',
  },
  {
    id: 'd1',
    name: 'D1 `meet-usage`',
    kind: 'store',
    lane: 'state',
    parent: 'store',
    holds: 'The usage ledger, the people, their roles and their work preferences.',
    code: 'services/control-plane/migrations',
    doc: 'docs/OPERATIONS.md',
    cloudflare: ['meet/d1/meet-usage'],
  },
  {
    id: 'kv',
    name: 'KV namespaces',
    kind: 'store',
    lane: 'state',
    parent: 'store',
    holds: '`CALENDAR_TOKENS`: the Google Calendar refresh tokens, one per owner who attached a calendar. `CORE_CACHE`: sixty seconds of the Core reads the board and the feed fan out to.',
    code: 'services/control-plane/src/core-cache.ts',
    doc: 'docs/CACHING.md',
    cloudflare: ['meet/kv/CALENDAR_TOKENS', 'meet/kv/CORE_CACHE'],
  },
  {
    id: 'r2',
    name: 'R2 buckets',
    kind: 'store',
    lane: 'state',
    parent: 'store',
    holds: 'Four buckets: `meet-downloads` for release zips, `meet-avatars`, `meet-attachments` for the files in a conversation, and `meet-backups`, the daily text backup of every Durable Object, kept in the EU for 30 days. No audio, no video.',
    code: 'services/control-plane/src/backups.ts',
    doc: 'docs/OPERATIONS.md',
    cloudflare: ['meet/r2/meet-downloads', 'meet/r2/meet-avatars', 'meet/r2/meet-attachments', 'meet/r2/meet-backups'],
  },
  {
    id: 'queue',
    name: 'Queue `meet-artifact-jobs`',
    kind: 'store',
    lane: 'state',
    parent: 'store',
    holds: 'Finalization, CRM filing and the nightly backups, one consumer at a time. Three failures and a job waits on `meet-artifact-jobs-dead` for an admin.',
    code: 'services/control-plane/src/artifacts.ts',
    doc: 'docs/OPERATIONS.md',
    cloudflare: ['meet/queue/meet-artifact-jobs', 'meet/queue/meet-artifact-jobs-dead'],
  },
  {
    id: 'import-queue',
    name: 'Queue `meet-import-jobs`',
    kind: 'store',
    lane: 'state',
    parent: 'store',
    holds: 'The Granola, GitHub and Slack imports, on their own queue so a bulk import never holds up a meeting\'s notes. Same policy, and its own dead queue, `meet-import-jobs-dead`.',
    code: 'services/control-plane/src/worker-queue.ts',
    doc: 'docs/OPERATIONS.md',
    cloudflare: ['meet/queue/meet-import-jobs', 'meet/queue/meet-import-jobs-dead'],
  },

  // ---- The rest of the company --------------------------------------------
  {
    id: 'core',
    stores: 'Supabase (Postgres)',
    name: 'Core',
    kind: 'sibling',
    lane: 'outside',
    vendor: 'Envisioning',
    holds: 'The CRM. Subjects, tasks and interactions, read and written over HMAC — a meeting is filed on the project it belongs to.',
    code: 'services/control-plane/src/crm.ts',
    doc: 'docs/MEETING_LOG.md',
  },
  {
    id: 'docs-service',
    stores: 'Cloudflare D1, and R2 for what is attached',
    name: 'Docs',
    kind: 'sibling',
    lane: 'outside',
    vendor: 'Envisioning',
    holds: 'Where documents and their comments live. Every read goes through the Starlings Worker; the browser never holds a Docs token. Docs calls back over a service binding to tell the workspace when a guest views a shared link.',
    code: 'services/control-plane/src/docs.ts',
    doc: 'docs/DOCS.md',
    cloudflare: ['meet/service/docs', 'docs/worker', 'docs/service/starlings-envisioning'],
  },
  {
    id: 'docs-d1',
    name: 'D1 `docs`',
    kind: 'store',
    lane: 'outside',
    parent: 'docs-service',
    vendor: 'Cloudflare',
    holds: 'Every document, its comments, who it is shared with, and the signatures on it.',
    doc: 'docs/DOCS.md',
    cloudflare: ['docs/d1/docs'],
  },
  {
    id: 'docs-r2',
    name: 'R2 `docs-files`',
    kind: 'store',
    lane: 'outside',
    parent: 'docs-service',
    vendor: 'Cloudflare',
    holds: 'The images in a document, a saved link\'s preview, and a signature\'s image.',
    doc: 'docs/DOCS.md',
    cloudflare: ['docs/r2/docs-files'],
  },
  {
    id: 'docs-platform',
    name: 'The Docs Worker',
    kind: 'sibling',
    lane: 'outside',
    parent: 'docs-service',
    vendor: 'Cloudflare',
    holds: 'Static Assets for its own app. An hourly Cron that mirrors documents out to the surfaces that need them as files. Rate limiting on claiming a shared link and on signing. Workers Logs, with traces.',
    doc: 'docs/DOCS.md',
    cloudflare: ['docs/assets', 'docs/cron/17 * * * *', 'docs/ratelimit/CLAIM_LIMIT', 'docs/ratelimit/SIGN_LIMIT', 'docs/observability'],
  },
  {
    id: 'keep',
    stores: 'Cloudflare D1 — and every item is encrypted on the device before it gets there',
    name: 'Keep',
    kind: 'sibling',
    lane: 'outside',
    vendor: 'Envisioning',
    holds: 'Where client credentials live. Starlings reads what a member may see, over a service binding.',
    code: 'services/control-plane/src/keep.ts',
    doc: 'docs/KEEP.md',
    cloudflare: ['meet/service/keep', 'keep/worker'],
  },
  {
    id: 'keep-platform',
    name: 'The Keep Worker',
    kind: 'sibling',
    lane: 'outside',
    parent: 'keep',
    vendor: 'Cloudflare',
    holds: 'Static Assets for its own app. Rate limiting on revealing an item, 300 a minute. Workers Logs, with traces.',
    doc: 'docs/KEEP.md',
    cloudflare: ['keep/assets', 'keep/ratelimit/REVEAL_LIMIT', 'keep/observability'],
  },
  // Where a vault lives. Keep holds the directory, the keys' public halves and
  // the audit; a store holds only sealed rows, so any of them may hold a vault
  // without being trusted with it. One is built; two are anticipated.
  {
    id: 'keep-d1',
    name: 'D1 `keep`',
    kind: 'store',
    lane: 'outside',
    parent: 'keep',
    vendor: 'Cloudflare',
    holds: 'Every vault today: wrapped keys and sealed items, in Keep\'s own database.',
    doc: 'docs/KEEP.md',
    cloudflare: ['keep/d1/keep'],
  },
  {
    id: 'keep-supabase',
    name: 'Supabase',
    kind: 'store',
    lane: 'outside',
    parent: 'keep',
    vendor: 'Supabase',
    holds: 'A vault kept in Postgres as sealed rows. Supabase Vault adds nothing here; the item is already sealed on the device.',
    doc: 'docs/KEEP.md',
    dormant: 'Planned: Keep does not store vaults here yet',
  },
  {
    id: 'keep-vercel',
    name: 'Vercel',
    kind: 'store',
    lane: 'outside',
    parent: 'keep',
    vendor: 'Vercel',
    holds: 'A vault kept in Vercel Marketplace storage, Neon Postgres or Blob, as sealed rows.',
    doc: 'docs/KEEP.md',
    dormant: 'Planned: Keep does not store vaults here yet',
  },
  {
    id: 'google',
    name: 'Google Workspace',
    kind: 'external',
    lane: 'outside',
    vendor: 'Google',
    holds: 'Both halves of Google: who is one of us at sign-in, and the owner\'s day once they attach a calendar.',
    code: 'services/control-plane/src/google-oauth.ts',
    doc: 'docs/CALENDAR.md',
  },
  {
    id: 'starlings-auth',
    stores: 'Cloudflare D1 `starlings-auth`: one sealed result per sign-in attempt, for a minute, and which GitHub installation each workspace connected',
    name: 'Starlings sign-in',
    kind: 'sibling',
    lane: 'outside',
    vendor: 'Envisioning',
    holds: 'Google sign-in and Google consent on the auth host, for a workspace that binds it (hq first). The workspace starts an attempt and redeems its one-time code over a service binding, then sets its own session. It also holds the Starlings GitHub App\'s key, and mints a GitHub token for each workspace\'s own installation over the GITHUB binding.',
    code: 'services/control-plane/src/central-auth.ts',
    doc: 'docs/CENTRAL_AUTH.md',
    cloudflare: ['meet/service/starlings-auth'],
  },
  {
    id: 'starlings-ops',
    stores: 'Nothing: no D1, KV, R2 or queue. It asks each workspace when the page loads',
    name: 'The operator console',
    kind: 'sibling',
    lane: 'outside',
    vendor: 'Envisioning',
    holds: 'The product across every workspace on the ops host, for the platform operator behind Cloudflare Access. Provisioning adds each new workspace to it.',
    code: 'services/control-plane/src/ops-worker/index.ts',
    doc: 'docs/OPS_CONSOLE.md',
  },
  {
    id: 'models',
    name: 'The models',
    kind: 'external',
    lane: 'outside',
    holds: 'Where the writing happens: the notes after a meeting, a forwarded mail read into events, suggested tasks and filing.',
    code: 'services/control-plane/src/notes.ts',
    doc: 'docs/AMBIENT_CAPTURE.md',
  },
  {
    id: 'agents',
    name: 'Agents',
    kind: 'external',
    lane: 'outside',
    vendor: 'Vercel',
    holds: 'Peers with no device. Each is one row in the roster; a hand-off is signed, and an unanswered one is reset every five minutes.',
    code: 'services/control-plane/src/agents.ts',
    doc: 'docs/AGENTS_SURFACE.md',
  },
  {
    id: 'workers-ai',
    name: 'Workers AI',
    kind: 'external',
    lane: 'outside',
    parent: 'models',
    vendor: 'Cloudflare',
    holds: 'The small models on the same account: the summary a meeting ends with, and the tasks it suggests from what was said.',
    code: 'services/control-plane/src/artifacts.ts',
    doc: 'docs/AMBIENT_CAPTURE.md',
    cloudflare: ['meet/ai'],
  },
  {
    id: 'vercel-gateway',
    name: 'Vercel AI Gateway',
    kind: 'external',
    lane: 'outside',
    parent: 'models',
    vendor: 'Vercel',
    holds: 'One door, for the decision model that suggests where an imported Granola note should be filed.',
    code: 'services/control-plane/src/granola-suggest.ts',
    doc: 'docs/GRANOLA_BRIDGE.md',
  },
  {
    id: 'connectors',
    name: 'Connectors',
    kind: 'external',
    lane: 'outside',
    holds: 'Every outside source that writes meetings into Starlings. One card each on `/admin/connectors`; the next one is a card, not a page.',
    code: 'web/src/ConnectorsPage.tsx',
    doc: 'docs/GRANOLA_BRIDGE.md',
  },
  {
    id: 'github',
    name: 'GitHub',
    kind: 'external',
    lane: 'outside',
    parent: 'connectors',
    vendor: 'GitHub',
    holds: 'The Work board is issue labels on `envisioning/starlings`; the connector maps repositories to subjects.',
    code: 'services/control-plane/src/github-connector.ts',
    doc: 'docs/GITHUB_CONNECTOR.md',
  },
  {
    id: 'slack',
    name: 'Slack',
    kind: 'external',
    lane: 'outside',
    parent: 'connectors',
    vendor: 'Slack',
    holds: 'Channel history read into the subject\'s channel by a paced job chain.',
    code: 'services/control-plane/src/slack-connector.ts',
    doc: 'docs/SLACK_IMPORT.md',
  },
  {
    id: 'beeper',
    name: 'Beeper',
    kind: 'external',
    lane: 'outside',
    parent: 'connectors',
    vendor: 'Beeper',
    holds: 'Chat from every network in one client. Two ways in: straight into the subject\'s channel, and through Core\'s Mac helper, which syncs it too.',
    doc: 'docs/CORE_REGISTRY.md',
  },
  {
    id: 'granola',
    name: 'Granola',
    kind: 'external',
    lane: 'outside',
    parent: 'connectors',
    vendor: 'Granola',
    holds: 'Notes from calls Starlings did not host. Two ways in: the Starlings bridge on the webhook, and Core\'s Mac helper, which syncs them too.',
    code: 'services/control-plane/src/granola.ts',
    doc: 'docs/GRANOLA_BRIDGE.md',
  },
  {
    id: 'turnstile',
    name: 'Turnstile',
    kind: 'external',
    lane: 'outside',
    vendor: 'Cloudflare',
    detail: 'full',
    holds: 'The bot check in front of the routes anyone may POST without signing in. Its keys are the switch; a native knock skips the widget.',
    code: 'services/control-plane/src/turnstile.ts',
    doc: 'docs/SECURITY.md',
  },
  {
    id: 'inbound-mail',
    name: 'Cloudflare Email Routing',
    kind: 'external',
    lane: 'outside',
    vendor: 'Cloudflare',
    detail: 'full',
    holds: 'Mail to a subject\'s address, or to `calendar@`, handed to the Worker as one message from the member who sent it. The address exists once a zone is named.',
    code: 'services/control-plane/src/inbound-email.ts',
    doc: 'docs/CHANNELS.md',
  },
  {
    id: 'open-web',
    name: 'The open web',
    kind: 'external',
    lane: 'outside',
    detail: 'full',
    holds: 'The page behind a link somebody pasted, fetched once so the message can show what it points at.',
    code: 'services/control-plane/src/link-preview.ts',
    doc: 'docs/CHANNELS.md',
  },
  {
    id: 'peer-meet',
    name: 'A peer workspace',
    kind: 'external',
    lane: 'outside',
    detail: 'full',
    holds: 'Another organization\'s workspace: its people and agents reach ours through the door a member\'s Claude already uses, per shared subject, and neither company\'s conversations leave the workspace that holds them. Designed, not built.',
    doc: 'docs/FEDERATION.md',
  },
  {
    id: 'postmark',
    name: 'Postmark',
    kind: 'external',
    lane: 'outside',
    vendor: 'Postmark',
    holds: 'Outbound mail — invitations and the notices a guest gets — sent from the contact address.',
    code: 'services/control-plane/src/mail.ts',
    doc: 'docs/CHANNELS.md',
  },
];

export const TOPOLOGY_EDGES: TopologyEdge[] = [
  // ---- The public drawing --------------------------------------------------
  {
    from: 'host-device',
    to: 'livekit',
    carries: 'Audio, video and screen',
    over: 'webrtc',
    dir: 'both',
    never: 'A recording. Nothing is written to disk, here or anywhere.',
    detail: 'overview',
    doc: 'docs/PRIVACY.md',
  },
  {
    from: 'browser',
    to: 'livekit',
    carries: 'Audio, video and screen',
    over: 'webrtc',
    dir: 'both',
    never: 'A recording, and never a stream before the owner has admitted you.',
    detail: 'overview',
    doc: 'docs/PRIVACY.md',
  },
  {
    from: 'host-device',
    to: 'worker',
    carries: 'Transcript text, summaries, admissions and room state',
    over: 'https',
    dir: 'both',
    never: 'Audio, video, or the screen. The words leave; the sound does not.',
    detail: 'overview',
    doc: 'docs/TRANSCRIPTION.md',
  },
  {
    from: 'browser',
    to: 'worker',
    carries: 'The knock, admission status, chat, and every workspace read',
    over: 'wss',
    dir: 'both',
    detail: 'overview',
    doc: 'docs/ROOM_ENTRY.md',
  },
  {
    from: 'worker',
    to: 'livekit',
    carries: 'A media token, minted only once the owner has admitted the guest',
    over: 'https',
    dir: 'one',
    never: 'Media. No stream passes through the Worker.',
    detail: 'overview',
    doc: 'docs/SECURITY.md',
  },
  {
    from: 'worker',
    to: 'store',
    carries: 'Room state, the words, the ledger, the files, the jobs',
    over: 'binding',
    dir: 'both',
    detail: 'overview',
    doc: 'docs/MAP.md',
  },
  {
    from: 'worker',
    to: 'core',
    carries: 'The meeting, its notes and its tasks, filed on a subject',
    over: 'https',
    dir: 'both',
    detail: 'overview',
    doc: 'docs/MEETING_LOG.md',
  },
  {
    from: 'worker',
    to: 'docs-service',
    carries: 'Documents and comments, on the member\'s behalf',
    over: 'binding',
    dir: 'both',
    never: 'A Docs token into the browser. The Worker keeps its own, per owner.',
    detail: 'overview',
    doc: 'docs/DOCS.md',
  },
  {
    from: 'worker',
    to: 'google',
    carries: 'The owner\'s day, and the meetings scheduled from Starlings',
    over: 'https',
    dir: 'both',
    detail: 'overview',
    doc: 'docs/CALENDAR.md',
  },
  {
    from: 'connectors',
    to: 'worker',
    carries: 'Meetings from outside sources — a webhook in, a paced job pulling history',
    over: 'https',
    dir: 'both',
    detail: 'overview',
    doc: 'docs/GRANOLA_BRIDGE.md',
  },
  {
    from: 'worker',
    to: 'models',
    carries: 'Transcript text to write the notes from, and a mail to read into events',
    over: 'https',
    dir: 'both',
    never: 'Audio. A model reads the words the device wrote, never the sound.',
    detail: 'overview',
    doc: 'docs/AMBIENT_CAPTURE.md',
  },
  {
    from: 'agents',
    to: 'worker',
    carries: 'A signed hand-off out, the agent\'s answer back',
    over: 'https',
    dir: 'both',
    never: 'A seat in the room. An agent has no device and no media.',
    detail: 'overview',
    doc: 'docs/AGENTS_SURFACE.md',
  },

  // ---- The full drawing ----------------------------------------------------
  {
    from: 'extension',
    to: 'mac',
    carries: 'Who is speaking in a call Starlings did not host',
    over: 'local',
    dir: 'one',
    detail: 'full',
    doc: 'docs/MEET_EVENTS.md',
  },
  {
    from: 'watch',
    to: 'ios',
    carries: '`agenda.json`, out of the shared app group',
    over: 'local',
    dir: 'one',
    never: 'A token. The watch holds no credential.',
    detail: 'full',
    doc: 'docs/SURFACES.md',
  },
  {
    from: 'mac',
    to: 'room-do',
    carries: 'The outbox: transcript segments, idempotent by segment UUID',
    over: 'https',
    dir: 'both',
    never: 'A tear-down of media when it fails. The room outlives the outbox.',
    detail: 'full',
    doc: 'docs/TRANSCRIPTION.md',
  },
  {
    from: 'ios',
    to: 'room-do',
    carries: 'The same outbox, from the phone when the phone is the host',
    over: 'https',
    dir: 'both',
    detail: 'full',
    doc: 'docs/IOS_HOST.md',
  },
  {
    from: 'browser',
    to: 'thread-do',
    carries: 'Messages, reactions and mentions, live',
    over: 'wss',
    dir: 'both',
    detail: 'full',
    doc: 'docs/GUEST_THREADS.md',
  },
  {
    from: 'browser',
    to: 'notes-do',
    carries: 'A note taken in a hurry, from whichever surface is open',
    over: 'https',
    dir: 'both',
    detail: 'full',
    doc: 'docs/WORK.md',
  },
  {
    from: 'room-do',
    to: 'queue',
    carries: 'A finalization job, once the meeting ends',
    over: 'queue',
    dir: 'one',
    detail: 'full',
    doc: 'docs/OPERATIONS.md',
  },
  {
    from: 'queue',
    to: 'core',
    carries: 'The filed interaction, its tasks, and the subject it belongs to',
    over: 'https',
    dir: 'one',
    detail: 'full',
    doc: 'docs/MEETING_LOG.md',
  },
  {
    from: 'queue',
    to: 'workers-ai',
    carries: 'A transcript to read, and the summary and tasks it comes back with',
    over: 'binding',
    dir: 'both',
    detail: 'full',
    doc: 'docs/AMBIENT_CAPTURE.md',
  },
  {
    from: 'beeper',
    to: 'worker',
    carries: 'Chat from every network, into the channel of the subject it is about',
    over: 'https',
    dir: 'one',
    detail: 'full',
    doc: 'docs/CHANNELS.md',
  },
  {
    from: 'beeper',
    to: 'core',
    carries: 'The conversations Core\'s Mac helper syncs, on their way to a subject',
    over: 'https',
    dir: 'one',
    detail: 'full',
    doc: 'docs/CORE_REGISTRY.md',
  },
  {
    from: 'granola',
    to: 'core',
    carries: 'The same notes, synced by Core\'s Mac helper as well',
    over: 'https',
    dir: 'one',
    detail: 'full',
    doc: 'docs/CORE_REGISTRY.md',
  },
  {
    from: 'granola',
    to: 'import-queue',
    carries: 'A note from a call Starlings did not host, on its webhook',
    over: 'https',
    dir: 'one',
    detail: 'full',
    doc: 'docs/GRANOLA_BRIDGE.md',
  },
  {
    from: 'core',
    to: 'thread-do',
    carries: 'GitHub events on a project — issues, pull requests, releases — into its channel',
    over: 'https',
    dir: 'one',
    detail: 'full',
    doc: 'docs/GITHUB_WEBHOOK.md',
  },
  {
    from: 'worker',
    to: 'github',
    carries: 'The Work board\'s issues and their `agent:*` labels',
    over: 'https',
    dir: 'both',
    detail: 'full',
    doc: 'docs/BOARD.md',
  },
  {
    from: 'worker',
    to: 'slack',
    carries: 'Channel history, paced into the subject\'s channel',
    over: 'https',
    dir: 'one',
    detail: 'full',
    doc: 'docs/SLACK_IMPORT.md',
  },
  {
    from: 'worker',
    to: 'vercel-gateway',
    carries: 'Which kind, which subject — the suggested filing for an imported note',
    over: 'https',
    dir: 'both',
    never: 'A decision. The answer is drawn as a pre-filled control and never written on its own.',
    detail: 'full',
    doc: 'docs/GRANOLA_BRIDGE.md',
  },
  {
    from: 'browser',
    to: 'google',
    carries: 'Sign-in with the Workspace account that makes somebody one of us',
    over: 'https',
    dir: 'both',
    detail: 'full',
    doc: 'docs/SECURITY.md',
  },
  {
    from: 'host-device',
    to: 'google',
    carries: 'The same sign-in, natively, and the calendar the owner attached',
    over: 'https',
    dir: 'both',
    detail: 'full',
    doc: 'docs/SECURITY.md',
  },
  {
    from: 'browser',
    to: 'turnstile',
    carries: 'A bot check before a knock a stranger may send',
    over: 'https',
    dir: 'both',
    detail: 'full',
    doc: 'docs/SECURITY.md',
  },
  {
    from: 'worker',
    to: 'turnstile',
    carries: 'The token from that check, verified before the knock is taken',
    over: 'https',
    dir: 'one',
    detail: 'full',
    doc: 'docs/SECURITY.md',
  },
  {
    from: 'inbound-mail',
    to: 'worker',
    carries: 'A forwarded mail, as one message from the member who sent it',
    over: 'https',
    dir: 'one',
    detail: 'full',
    doc: 'docs/CHANNELS.md',
  },
  {
    from: 'worker',
    to: 'open-web',
    carries: 'One fetch of a pasted link, to show what it points at',
    over: 'https',
    dir: 'both',
    detail: 'full',
    doc: 'docs/CHANNELS.md',
  },
  {
    from: 'peer-meet',
    to: 'mcp',
    carries: 'An organization, reading and writing the subjects it shares with us',
    over: 'https',
    dir: 'both',
    never: 'More than the shared subject. A peer is a third principal on one door, not a new one.',
    detail: 'full',
    doc: 'docs/FEDERATION.md',
  },
  {
    from: 'worker',
    to: 'starlings-auth',
    carries: 'A sign-in attempt, and the one-time code that redeems it',
    over: 'binding',
    dir: 'both',
    never: 'A session or a refresh token. Only the workspace holds those.',
    detail: 'full',
    doc: 'docs/CENTRAL_AUTH.md',
  },
  {
    from: 'starlings-ops',
    to: 'worker',
    carries: 'Names, versions, counts and health, from the workspace\'s OpsService',
    over: 'binding',
    dir: 'one',
    never: 'A record, a message, a transcript, a document or an address.',
    detail: 'full',
    doc: 'docs/OPS_CONSOLE.md',
  },
  {
    from: 'starlings-auth',
    to: 'google',
    carries: 'Web sign-in and consent for every workspace, on one registered host',
    over: 'https',
    dir: 'both',
    detail: 'full',
    doc: 'docs/CENTRAL_AUTH.md',
  },
  {
    from: 'worker',
    to: 'keep',
    carries: 'The credentials a member may see',
    over: 'binding',
    dir: 'both',
    detail: 'overview',
    doc: 'docs/KEEP.md',
  },
  {
    from: 'worker',
    to: 'postmark',
    carries: 'Invitations and the notices a guest gets',
    over: 'https',
    dir: 'one',
    detail: 'full',
    doc: 'docs/CHANNELS.md',
  },
  {
    from: 'mac',
    to: 'r2',
    carries: 'A notarized release zip, on the updater\'s check',
    over: 'https',
    dir: 'one',
    detail: 'full',
    doc: 'docs/UPDATER.md',
  },
];

/** One node by id, or undefined. */
export function topologyNodeById(id: string): TopologyNode | undefined {
  return TOPOLOGY_NODES.find((node) => node.id === id);
}

/** The boxes on the public drawing: the ones nothing collapses them into. */
export function topLevelNodes(): TopologyNode[] {
  return TOPOLOGY_NODES.filter((node) => node.parent === undefined);
}

/** What collapses into one box, in registry order. Empty for a leaf. */
export function childNodes(id: string): TopologyNode[] {
  return TOPOLOGY_NODES.filter((node) => node.parent === id);
}

export type TopologyDetail = 'overview' | 'full';
export type TopologyGraph = { nodes: TopologyNode[]; edges: TopologyEdge[] };

/**
 * The graph at one density. `overview` is the top-level boxes and the lines
 * marked `overview`; `full` is every box, with the children nested, and every
 * line. The two drawings are the same registry read twice.
 */
export function topologyGraph(detail: TopologyDetail): TopologyGraph {
  if (detail === 'full') return { nodes: TOPOLOGY_NODES, edges: TOPOLOGY_EDGES };
  return {
    nodes: topLevelNodes().filter((node) => node.detail !== 'full'),
    edges: TOPOLOGY_EDGES.filter((edge) => edge.detail === 'overview'),
  };
}

export type TopologyLane = { id: TopologyLaneId; title: string; blurb: string; nodes: TopologyNode[] };

/** The lanes of one drawing, in order, each with its boxes. Empty lanes are dropped. */
export function topologyLanes(detail: TopologyDetail): TopologyLane[] {
  const { nodes } = topologyGraph(detail);
  return TOPOLOGY_LANES
    .map((lane) => ({ ...lane, nodes: nodes.filter((node) => node.lane === lane.id && node.parent === undefined) }))
    .filter((lane) => lane.nodes.length > 0);
}

/**
 * Every line that never carries something, as sentences. The privacy claims on
 * `/workspace` and `/privacy` are these rows, not a second list of promises.
 */
export function topologyInvariants(): { edge: TopologyEdge; sentence: string }[] {
  return TOPOLOGY_EDGES
    .filter((edge) => edge.never !== undefined)
    .map((edge) => ({
      edge,
      sentence: `${topologyNodeById(edge.from)?.name ?? edge.from} → ${topologyNodeById(edge.to)?.name ?? edge.to}: ${edge.carries}. Never: ${edge.never}`,
    }));
}
