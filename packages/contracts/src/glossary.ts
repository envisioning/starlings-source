import { z } from 'zod';

/**
 * The glossary — one place for what a word means in Meet (docs/DOCUMENTATION.md,
 * decision 7;).
 *
 * `docs/agents/CONTEXT.md` §Glossary is generated from this by
 * `scripts/gen-glossary.mjs`; the docs site renders it at `/docs/glossary`;
 * the pt-BR term list reads it. Each term carries its sources so
 * it can be checked rather than trusted. Do not add a term without one.
 *
 * `docs/SURFACES.md` stays the authority on the UI vocabulary; the rows here
 * that cite it are its summary, not a second ruling.
 */
export const glossaryTermSchema = z.object({
  /** The word as it appears in UI copy and docs. */
  term: z.string().min(1),
  /** Other spellings people use, including the ones to avoid. */
  aliases: z.array(z.string().min(1)).optional(),
  meaning: z.string().min(1),
  /** Docs or code paths, repo-relative, that define it. */
  sources: z.array(z.string().min(1)).min(1),
}).strict();
export type GlossaryTerm = z.infer<typeof glossaryTermSchema>;

export const GLOSSARY: GlossaryTerm[] = [
  // Who
  { term: 'owner', meaning: 'An authenticated member of the workspace, on one of its identity domains, who hosts from the Mac or iOS app. Not a role a guest can hold.', sources: ['docs/PRIVACY.md'] },
  { term: 'host', meaning: 'The one device that runs a meeting: it admits guests, renews the lease and runs the recognizer. Another device of the same member joins as a companion with its microphone off. Also the product mode for running a room from a native client. Not the Google identity check; that is the owner. Called "the chair" until 5.8.9.', sources: ['docs/SURFACES.md', 'docs/TRANSCRIPTION.md', 'docs/IOS_HOST.md'] },
  { term: 'guest', aliases: ['visitor'], meaning: 'Anyone who is not the owner in a room: joining from a browser, Mac Join or iOS. No account. Name and email required; notes consent optional.', sources: ['docs/PRIVACY.md', 'docs/SURFACES.md'] },
  { term: 'guest thread', meaning: 'A subject\'s one thread shared by members and the guests a `manage` holder granted on it (`kind = guest`). The subject\'s own Talk stays members only. Guests reach it through a link: read, or read and post text.', sources: ['docs/ACCESS.md', 'docs/PRIVACY.md'] },
  { term: 'peer', meaning: 'Another member of the workspace, in presence copy and `GET /api/peers`. Not "user", not "contact" (that is Core).', sources: ['docs/SURFACES.md'] },
  { term: 'agent', meaning: 'A non-human peer on the Team roster with its own runtime. Messageable, never waved or called; takes cards by hand-off.', sources: ['docs/AGENTS_SURFACE.md'] },
  { term: 'decision ask', aliases: ['decision queue'], meaning: 'A question an agent files with `ask_decision`: options, a recommendation and a default-by day. It heads INBOX on every client; the answer is recorded as a decision on the subject. Shipped. It never holds an action and never applies the recommendation.', sources: ['docs/AGENTS_SURFACE.md', 'docs/help/howto/answer-a-decision.md'] },
  { term: 'action approval', meaning: 'A held agent action (send, post, spend, delete) that runs only after a person confirms it. Not built yet. Never call a decision ask an approval.', sources: ['docs/AGENTS_SURFACE.md'] },
  // Where
  { term: 'room', meaning: 'The permanent slug and permalink, `/room/<slug>`. Not the live session.', sources: ['docs/SURFACES.md'] },
  { term: 'meeting', meaning: 'The live session with a `meeting_id`. Chrome says meeting once media is up; permalinks say room.', sources: ['docs/SURFACES.md'] },
  { term: 'the internal room', aliases: ['/room/team'], meaning: 'The one room whose audience is the whole workspace, addressed `/room/team`. Membership is the admission: no waiting room, no booking door. Written as the address, never "the team room".', sources: ['docs/adr/0001-internal-room.md'] },
  { term: 'waiting room', meaning: 'The guest-facing admission surface. Every guest- and host-facing string says waiting room.', sources: ['docs/SURFACES.md'] },
  { term: 'lobby', meaning: 'The same queue on the wire and in `starlings`: `LobbyStatus`, the join-request routes. Never renamed casually.', sources: ['docs/SURFACES.md'] },
  { term: 'knock', aliases: ['ask to join'], meaning: 'What a guest does at a room\'s door. Answered by admitting. Not a colleague gesture.', sources: ['docs/SURFACES.md'] },
  { term: 'prejoin', meaning: 'The camera and microphone check before a knock or a go-live. Not "preflight".', sources: ['docs/SURFACES.md'] },
  { term: 'launch', meaning: 'The owner\'s idle home on the Mac: waiting room list, upcoming, Start room.', sources: ['docs/SURFACES.md'] },
  { term: 'stage', meaning: 'The live video grid.', sources: ['docs/SURFACES.md'] },
  { term: 'surface', meaning: 'What the person is looking at, a main page: Home, Calendar, Work, Team, Docs, and the guest flow. Each has a reference page under `docs/help/surfaces/`.', sources: ['docs/SURFACES.md', 'scripts/docs-frontmatter.mjs'] },
  { term: 'Home', meaning: 'Today: the clock, the modules in your order, your room. ⌘1.', sources: ['docs/SURFACES.md'] },
  { term: 'Work', meaning: 'The subject surface: projects, and leads, partners and events where their work modules are on, with tasks, issues, documents and Talk. ⌘3.', sources: ['docs/SURFACES.md', 'docs/WORK.md', 'docs/WORK_MODEL.md'] },
  { term: 'Team', meaning: 'The people surface: who is around, and reaching them. ⌘4. Not the meeting\'s People panel.', sources: ['docs/SURFACES.md'] },
  { term: 'Docs', meaning: 'The fifth surface: the whole corpus, read and written from Starlings. ⌘5. Documents on a subject are the contextual slice.', sources: ['docs/SURFACES.md', 'docs/DOCS.md'] },
  { term: 'Mine', meaning: 'Everything assigned to you across every subject. Inside Work, never a surface of its own.', sources: ['docs/SURFACES.md'] },
  { term: 'INBOX', meaning: 'What needs you, in Work; each row leaves when resolved.', sources: ['docs/SURFACES.md'] },
  { term: 'Sales', meaning: 'The work module for leads: a section inside Work, not a tab. A workspace admin turns it on; each person can hide it.', sources: ['docs/SURFACES.md', 'docs/WORK_MODEL.md'] },
  { term: 'work module', meaning: 'A set of record types a workspace admin turns on in Admin: Sales, Partners, Events, Support, and later the commercial ones. Always two words; a Home module is a card.', sources: ['docs/WORK_MODEL.md'] },
  { term: 'store', meaning: 'Where a workspace keeps its records: Envisioning Core or its own D1. `WORK_STORE`, set at deploy, not in Admin.', sources: ['docs/WORKSPACE_STORE.md', 'docs/WORK_MODEL.md'] },
  { term: 'Core', meaning: 'Envisioning\'s store, the CRM and CMS behind `CORE_API_ORIGIN`, and nothing else. Never a word in the UI: the door to it is **Other records**.', sources: ['docs/MEETING_LOG.md', 'docs/CORE_REGISTRY.md'] },
  { term: 'Settings', meaning: 'App preferences. ⌘, on the Mac, the gear elsewhere. Not a surface. Qualify "in-meeting Settings" when you mean that.', sources: ['docs/SURFACES.md'] },
  // Things
  { term: 'subject', meaning: 'One project, event, lead or organization: the object everything in Work hangs off. A channel is one view of a subject. `partner` folds into `organization` (ADR 0006).', sources: ['docs/SURFACES.md', 'docs/CHANNELS.md', 'docs/adr/0006-organization-subject.md'] },
  { term: 'client', meaning: 'A relationship, not a kind: an organization with an active project or license. Read from the records; no flag. Never "customer".', sources: ['docs/adr/0006-organization-subject.md', 'docs/SURFACES.md'] },
  { term: 'support request', meaning: 'A card on an organization, made from a line in its guest thread. Its state is `WorkStage`. Not "ticket". Not built.', sources: ['docs/SUPPORT.md'] },
  { term: 'intake', meaning: 'The one members-only subject per workspace for support requests from people with no organization, one guest thread per visitor. Not built.', sources: ['docs/SUPPORT.md'] },
  { term: 'public door', meaning: 'A workspace page for people with no account, on its public host: join a room, guest thread, Book a time, support, email in. One registry; Admin lists each with Copy.', sources: ['docs/SUPPORT.md'] },
  { term: 'Subject Overview', meaning: 'A subject\'s landing state: Talk beside Tasks / Issues / Documents / History. Not Work\'s global Overview.', sources: ['docs/SURFACES.md'] },
  { term: 'Talk', meaning: 'The one conversation on a subject.', sources: ['docs/SURFACES.md', 'docs/CHANNELS.md'] },
  { term: 'History', aliases: ['Interactions'], meaning: 'A subject\'s pane merging Core interactions with its event trail, by time. The type `CrmInteraction` and web\'s `pane=interactions` keep the old name.', sources: ['docs/SURFACES.md', 'docs/TIMELINE.md'] },
  { term: 'thread', meaning: 'One conversation. The parent is polymorphic: none for a DM, a subject for Talk.', sources: ['docs/SURFACES.md', 'docs/CHANNELS.md'] },
  { term: 'Messages', aliases: ['DM'], meaning: 'Direct messages between members, reached through a person in Team. Not "chat".', sources: ['docs/SURFACES.md'] },
  { term: 'Groups', meaning: 'Team\'s rail block: Everyone pinned, then the private groups, newest message first. A group is a DM with more than one other person; the people are its name.', sources: ['docs/SURFACES.md'] },
  { term: 'Chat', meaning: 'The message panel inside a meeting. Not a destination.', sources: ['docs/SURFACES.md'] },
  { term: 'Search', aliases: ['⌘K', 'the palette'], meaning: 'One box that finds anything and jumps anywhere. Every per-surface field is the same search with a fixed scope.', sources: ['docs/SURFACES.md', 'fixtures/search-rows.json'] },
  { term: 'card', meaning: 'A task or an issue on the board: the anchor every agent turn names. Stored in Core or GitHub, never in Starlings.', sources: ['docs/BOARD.md'] },
  { term: 'artifact', meaning: 'The finished meeting record, transcript segments plus notes, as delivered to the control plane and to consenting recipients.', sources: ['docs/TRANSCRIPTION.md', 'docs/MEETING_LOG.md'] },
  { term: 'the outbox', meaning: '`MeetingArtifactOutbox`, one actor shared by the Mac and iOS clients: idempotent by segment UUID, crash-safe, text only.', sources: ['docs/TRANSCRIPTION.md'] },
  { term: 'ambient capture', aliases: ['notepad mode'], meaning: 'Transcribing a call Starlings does not host: local audio, local STT, the same outbox and artifact path. No bot in the foreign call.', sources: ['docs/AMBIENT_CAPTURE.md'] },
  { term: 'capability', meaning: 'One row of `packages/contracts/src/capabilities.ts`: what Starlings does, where it works, and how an agent reaches it: its doors, human only, built in, or a planned door. Not the Worker\'s role capabilities.', sources: ['packages/contracts/src/capabilities.ts', 'docs/DOCUMENTATION.md'] },
  { term: 'Picture', aliases: ['avatar'], meaning: 'A member\'s own uploaded face. Initials are what a person without one looks like. The wire keeps `avatar`.', sources: ['docs/SURFACES.md'] },
  // Gestures
  { term: 'Message', meaning: 'Asks for nothing now; it waits in a thread.', sources: ['docs/SURFACES.md'] },
  { term: 'Wave', aliases: ['Ring'], meaning: 'A nudge from Team: one chime on a running client, gone in 45 seconds, no claim anyone was reached. Was Ring until 1.6.0; the wire keeps `/api/peers/ring`.', sources: ['docs/SURFACES.md', 'docs/PRESENCE.md'] },
  { term: 'Call', meaning: 'Into a colleague\'s room: a knock if a meeting runs, an ask (Open room / Not now) if they are only available. A room opened this way does not transcribe.', sources: ['docs/SURFACES.md'] },
  { term: 'Hand off', meaning: 'Giving a card to an agent: a message to the agent carrying the card. Nothing new on the wire.', sources: ['docs/SURFACES.md', 'docs/BOARD.md'] },
  { term: 'Welcome', meaning: 'The room noticing you arrive: a chime and a ring on your own tile. Not a gesture; nothing sends it.', sources: ['docs/SURFACES.md'] },
  // State
  { term: 'intent', meaning: 'What a person says about themselves: Available, Focused. A second axis beside the evidence ladder, never a seventh status.', sources: ['docs/SURFACES.md', 'docs/PRESENCE.md'] },
  { term: 'Unavailable', aliases: ['dnd'], meaning: 'A self-set closed door, always with an end. `dnd` on the wire.', sources: ['docs/SURFACES.md'] },
  { term: 'WorkStage', meaning: 'The one stage vocabulary, `queued / doing / review / blocked / done / dropped`, computed from the row and never stored. Pinned by `fixtures/work-items.json`; change the fixture first.', sources: ['docs/BOARD.md', 'fixtures/work-items.json'] },
  { term: 'WorkSection', meaning: 'The date-section vocabulary beside `WorkStage`. Answers when, not where in the pipeline.', sources: ['docs/BOARD.md'] },
  { term: 'phase', meaning: '`MeetingPhase`, the connection lifecycle: setup, connecting, connected, ended, failed. Not a page.', sources: ['docs/SURFACES.md'] },
  { term: 'the lease', meaning: 'The owner device\'s proof of presence that the control plane gates admission and token exchange on.', sources: ['docs/SECURITY.md'] },
  // Systems
  { term: 'control plane', aliases: ['the Worker'], meaning: 'The Cloudflare Workers, Durable Objects, Queues and D1 side. Holds room state, consent, transcript text, summaries. Never media.', sources: ['docs/PRIVACY.md'] },
  { term: 'the factory', meaning: 'The automation that acts on `agent:*` labels on GitHub issues and opens draft PRs.', sources: ['docs/BOARD.md'] },
  { term: 'the board', meaning: 'A projection: Core tasks and GitHub issues read through `WorkStage`. No Starlings-side table holds a card or a column. People see it one project at a time, on the project\'s Board pane.', sources: ['docs/BOARD.md'] },
  { term: 'the act record', meaning: 'Who acted, under whose authority, on what, and how it went: one row per act in `mcp_calls` and `admin_audit`. Never aggregated. Not a status, and never written as "the ledger".', sources: ['docs/LEDGER.md', 'docs/MCP.md'] },
  { term: 'the account ledger', meaning: 'What the organization used: meetings held and the funnel around them, aggregated for Admin. `meetings_ledger` and `usage_events`. Always qualified, because two other things are called a ledger.', sources: ['docs/LEDGER.md', 'docs/ADMIN.md'] },
  { term: 'MCP', aliases: ['/mcp', 'Connected agents'], meaning: 'The door a member\'s Claude uses to read and write Starlings. OAuth pairing on `/connect`; every call recorded.', sources: ['docs/MCP.md'] },
  { term: 'starlings CLI', meaning: 'The Mac CLI over a local socket: `status`, `devices`, `host`, `join`, `lobby`. Speaks wire vocabulary.', sources: ['docs/OPERATIONS.md', 'CLI/StarlingsCLI.swift'] },
];

/** One term, matched on the term or an alias, case-insensitive. */
export function glossaryTerm(word: string): GlossaryTerm | undefined {
  const needle = word.trim().toLowerCase();
  return GLOSSARY.find((row) => row.term.toLowerCase() === needle || row.aliases?.some((alias) => alias.toLowerCase() === needle));
}
