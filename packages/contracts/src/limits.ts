// Numeric wire limits shared by schema validation (Worker) and client-side
// clamping (web/Mac). Zod-free so browsers can import without schema code.

/** Millisecond quality counters are cumulative per participant, capped at 24h. */
export const QUALITY_DURATION_MAX_MS = 86_400_000;
export const QUALITY_RECONNECT_MAX = 10_000;
/** Quality is cumulative, so a five-minute flush keeps the signal without a per-minute write. */
export const QUALITY_REPORT_INTERVAL_MILLISECONDS = 300_000;
export const DOWNSTREAM_USAGE_REPORT_INTERVAL_MILLISECONDS = 60_000;

/** Transcript batching: schema ceiling and the byte budget the route accepts. */
export const TRANSCRIPT_BATCH_MAX_SEGMENTS = 250;
export const TRANSCRIPT_BODY_MAX_BYTES = 1_048_576;

/** Default JSON body cap for every other mutating route. */
export const JSON_BODY_MAX_BYTES = 65_536;

/**
 * Bug reports carry a generated debug dump alongside the typed message, so a
 * legitimate one exceeds the default JSON cap. The report ceiling is deliberately
 * below what the dump can reach on a long call — a truncated report still tells
 * us what we need, and an unbounded one is a free write into the issue tracker.
 */
export const FEEDBACK_BODY_MAX_BYTES = 131_072;
export const FEEDBACK_MESSAGE_MAX_CHARS = 4_000;
export const FEEDBACK_REPORT_MAX_CHARS = 40_000;

/**
 * Hosting safety window and the renewal cadence advertised to native hosts.
 * The lease is authoritative; the cadence merely tells clients when to renew.
 */
export const HOST_LEASE_MILLISECONDS = 30_000;
export const HOST_HEARTBEAT_INTERVAL_MILLISECONDS = 10_000;
/** How long an offer to host stands before the host keeps it. */
export const HOST_OFFER_MILLISECONDS = 60_000;

/**
 * When a crash or force-quit takes the host away, the meeting row stays `open`
 * forever: nothing but an explicit End writes `ended_at`. Guests were never at
 * risk (admission and exchange both demand a live 30s lease), but the owner's
 * launch screen kept offering to reclaim a meeting from days ago.
 *
 * Twenty missed leases — ten minutes — is far past any network blip a host
 * recovers from, so the next read of the open meeting closes it instead.
 */
export const STALE_MEETING_MILLISECONDS = 600_000;

/**
 * A meeting that ended inside this window was a test, a misclick, a
 * reconnect or a no-show — not a meeting (MZ, 2026-09-15: five minutes).
 * It gets no summary, no transcript document, no channel line and no ledger
 * row, and the room marks it `discarded`.
 */
export const MIN_MEETING_MILLISECONDS = 5 * 60_000;

/**
 * Team presence. A client heartbeat inside this window means the person has
 * the app in front of them; past it they are `away` until the row goes cold.
 * Deliberately several times the beat so one dropped request is not "left".
 */
export const PEER_ACTIVE_MILLISECONDS = 300_000;
export const PEER_HEARTBEAT_INTERVAL_MILLISECONDS = 60_000;

/**
 * How often a client re-reads the roster while Team is actually on screen.
 * The Worker caches this read for ten seconds, but thirty seconds still keeps
 * a short-lived ring inside its 45-second lifetime while cutting the steady
 * foreground roster cost by a third.
 */
export const PEER_ROSTER_POLL_SECONDS = 30;

/**
 * The same read, by a client nobody is currently looking at — an app behind
 * other windows, or a tab in the background. A ring lives RING_TTL_MILLISECONDS,
 * so this still draws one with a poll to spare, and an idle client stops being
 * the largest single source of traffic on the account.
 */
export const PEER_ROSTER_BACKGROUND_POLL_SECONDS = 30;

/**
 * Unread lists change less often than presence and have no short-lived ring
 * to deliver. Keep the inbox signal, but do not spend a roster request's
 * cadence on it while the app is merely open.
 */
export const THREAD_LIST_POLL_SECONDS = 60;
export const THREAD_LIST_BACKGROUND_POLL_SECONDS = 120;

/**
 * How often a waiting guest asks whether they have been let in. The lobby has
 * a WebSocket and *that* is the delivery path; this is the fallback for a
 * browser or network that will not carry one, so it only runs briskly while
 * the socket is not open.
 */
export const LOBBY_POLL_SECONDS = 5;

/** Calendar freshness is useful, but it is not part of the live meeting path. */
export const CALENDAR_REFRESH_SECONDS = 300;

/**
 * The same poll once the socket is carrying status. Not zero: a socket can go
 * quiet without closing, and a guest stranded on a seat the host already
 * granted is a worse failure than one request every quarter minute.
 */
export const LOBBY_SOCKET_POLL_SECONDS = 15;

/** Pre-knock presence is a lobby hint, not a live media signal. */
export const GUEST_PRESENCE_HEARTBEAT_MILLISECONDS = 15_000;

/**
 * How long an assembled roster may be served from an isolate's memory. The
 * roster fans out over one Durable Object per mapped room, so an uncached read
 * costs N round-trips — and every phone on the team polls it.
 */
export const PEER_ROSTER_CACHE_MILLISECONDS = 10_000;

/** Rows older than this are dropped from the roster rather than shown "offline" forever. */
/**
 * Profile pictures. Clients square and downscale before uploading — a Mac, a
 * phone and a browser can all do it locally, and none of them needs the Worker
 * to own an image pipeline — so the ceiling only has to be generous enough for
 * one 512px frame, not for whatever came out of a camera.
 */
export const AVATAR_EDGE_PIXELS = 512;
export const AVATAR_MAX_BYTES = 1_048_576;

export const PEER_ROSTER_MAX_AGE_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;

/**
 * A ring is a nudge, not a call. There is no push: it is written on one side
 * and read on the other side's next roster poll — which a running client then
 * announces locally — so it must expire on its own. An unanswered ring that
 * waits forever becomes a lie about when somebody wanted you. Comfortably
 * longer than the poll, far shorter than a conversation.
 */
export const RING_TTL_MILLISECONDS = 45_000;

/**
 * Free/busy costs one Google call per member with a connected calendar, so it
 * is cached well above the roster's own TTL. A minute is far inside any
 * calendar block a person could notice starting or ending.
 */
export const PEER_BUSY_CACHE_MILLISECONDS = 60_000;

/** How far ahead `busy_until` looks. Longer than any block worth naming on a roster row. */
export const PEER_BUSY_HORIZON_MILLISECONDS = 4 * 60 * 60 * 1_000;

/**
 * Direct messages. The body cap is a message, not a document — long-form
 * belongs in a meeting note, and an unbounded body is a free write into a
 * Durable Object someone else pays for.
 */
export const MESSAGE_TEXT_MAX_CHARS = 4_000;

/**
 * Lines that peer organizations and our agents together may write into one
 * guest thread in one UTC day (docs/ACCESS.md, FEDERATION.md decision 10).
 * Two machines that answer each other are a loop; this is its ceiling.
 * People are never counted.
 */
export const GUEST_THREAD_MACHINE_TURNS_PER_DAY = 50;

/**
 * How many live transcript lines a meeting view keeps in memory, on every
 * surface (decided 2026-09-19). A view, never the record: the
 * transcript itself is the outbox and the room coordinator. The short
 * caption strip over the stage is a separate window on the last line or
 * two. Swift: `CaptionMessage.historyLineLimit`.
 */
export const LIVE_TRANSCRIPT_HISTORY_LINES = 500;
export const MESSAGE_PAGE_MAX = 100;
/** Preview kept in the D1 thread index for the conversation list. */
export const MESSAGE_PREVIEW_MAX_CHARS = 140;
/**
 * How many work-graph rows one event line may point at. An event says one
 * thing happened; a line carrying a dozen refs is a digest, and a digest is
 * what a channel exists to make unnecessary.
 */
export const THREAD_MESSAGE_REF_MAX = 8;
/**
 * Reactions. One short emoji per row — the cap is characters and not bytes
 * because a family emoji is one glyph made of five code points joined by
 * zero-width joiners, and a byte ceiling would refuse it while accepting five
 * unrelated faces.
 *
 * The per-message ceiling is on *distinct* emoji, not on people: a hundred
 * colleagues agreeing is one row each and costs nothing, whereas a hundred
 * different symbols on one message is somebody using a transcript as a
 * canvas. Both are per-thread Durable Object writes that nobody else pays for.
 */
export const MESSAGE_REACTION_EMOJI_MAX_CHARS = 16;
export const MESSAGE_REACTION_MAX_PER_MESSAGE = 24;

/**
 * How many people one message may name. High enough that nobody hits it in a
 * sentence, low enough that a mention list cannot be used to badge the whole
 * company from a single write.
 */
export const MESSAGE_MENTION_MAX = 20;

/**
 * How long an author may still edit or withdraw what they said. Not forever:
 * a transcript somebody can silently rewrite months later is not a record of
 * anything, and the point of an edit window is the typo you noticed, not the
 * position you would rather have taken. A withdrawn message leaves a tombstone
 * either way — the row stays, the text does not.
 */
export const MESSAGE_EDIT_WINDOW_MILLISECONDS = 24 * 60 * 60 * 1_000;

/**
 * Attachments. The ceiling is a screenshot, a scanned page, a short clip —
 * not a deliverable. Anything larger belongs in the place that already owns
 * files, and an unbounded upload is a free write into storage somebody else
 * pays for, exactly like the message body cap above.
 */
export const ATTACHMENT_MAX_BYTES = 25 * 1_048_576;
export const ATTACHMENT_MAX_PER_MESSAGE = 10;
export const ATTACHMENT_NAME_MAX_CHARS = 200;
/**
 * How far apart an inbound signed request's clock may be from the Worker's.
 * Wide enough for ordinary drift between two hosts, narrow enough that a
 * captured request stops being replayable the same afternoon.
 */
export const INTERNAL_SIGNATURE_SKEW_MILLISECONDS = 300_000;
/**
 * How long an agent reads as working after its runtime accepted a hand-off
 * and before it says anything back.
 *
 * Long enough for a real turn — a page fetched, a model run, a few writes —
 * and short enough that a run which died silently stops claiming to be alive.
 * A longer job going quiet on the roster while it is still going is the
 * smaller error, and it corrects itself the moment the agent speaks.
 */
export const AGENT_BUSY_TTL_MILLISECONDS = 600_000;
/**
 * How long a hand-off can sit unanswered before resetStuckAgents (agents.ts)
 * gives up on it and calls the agent's `resetEndpoint`, if it declared one.
 *
 * Same value as AGENT_BUSY_TTL_MILLISECONDS on purpose: the moment the roster
 * badge would start lying by going quiet on a run that is still alive is
 * exactly the moment a real answer is already overdue. Kept as its own
 * constant, not a reuse, because the two are allowed to drift apart later —
 * a longer job that is genuinely still working should get more slack before
 * a reset than a badge needs before it stops claiming to know.
 */
export const AGENT_STUCK_RESET_MILLISECONDS = 600_000;
/**
 * How long a cached agent manifest is trusted before Meet re-fetches it from
 * the runtime. The manifest is like presence: a snapshot the runtime owns and
 * Meet only displays, so a stale one is the agent's to fix. Fifteen minutes is
 * far longer than the roster's own cache, because a description of what an
 * agent does changes on the order of deploys, not seconds — and the fetch is
 * off the response path either way. See docs/AGENTS_SURFACE.md §The manifest.
 */
export const AGENT_MANIFEST_TTL_MILLISECONDS = 900_000;
/**
 * Poll cadence while a thread is open. There is no socket and no push yet, so
 * this is the whole delivery story — deliberately brisk while you are looking
 * at a conversation, and stopped entirely when you are not.
 */
export const THREAD_POLL_SECONDS = 4;
/**
 * Poll cadence for an open thread the person is not looking at: the window
 * is visible behind another app, or the Mac app is not active. A hidden tab
 * or an occluded window polls not at all and reads once on return. An open
 * pane at four seconds is 900 requests an hour whether or not anybody is
 * there; a Mac behind a browser and a browser tab behind a Mac were most of
 * the account's requests. Mirrored by `DirectMessageCadence.backgroundThreadPoll`.
 */
export const THREAD_BACKGROUND_POLL_SECONDS = 30;
/**
 * Poll cadence while a turn with an agent is open: from the moment a member
 * writes to it until its final answer lands. The runtime narrates its steps
 * as it goes and streams the answer as a row rewritten in place, and at the
 * ordinary cadence a three-second turn is over before it is seen to start.
 * One read a second, only for the duration of a turn, only in the pane that
 * is watching it. Mirrored by `DirectMessageCadence.agentTurnPoll` in Swift.
 */
export const AGENT_TURN_POLL_SECONDS = 1;

/**
 * How long after sending to an agent the working row shows on trust alone.
 * The roster's `busy` flag is written when the runtime accepts, and the first
 * roster read after a send is up to THREAD_POLL_SECONDS away; without this the
 * row starts late or, for a short run, never. Past it the row stays only if
 * the roster says busy, so a runtime that never accepted stops reading as
 * working. Mirrored by `DirectMessageCadence.agentAcceptGrace` in Swift.
 */
export const AGENT_ACCEPT_GRACE_SECONDS = 20;

/**
 * A room's own door, per minute, whatever the address. Sized for
 * the 100-person cap arriving at once: a session's audience knocks and opens
 * the page inside a minute, and a venue is one address, so the Worker's
 * per-address limiters (`JOIN_LIMIT`, `PRESENCE_LIMIT` in wrangler.jsonc,
 * keyed on room + address) are sized the same way. Turnstile and the
 * 99-guard bound abuse; these bound a flood.
 */
export const ROOM_KNOCKS_PER_MINUTE = 120;
export const ROOM_NEW_VISITORS_PER_MINUTE = 200;

/**
 * Events proposed from mail forwarded to `calendar@`. A row the
 * owner has not answered leaves after this long; a mail yields at most this
 * many rows; a row under this confidence is never shown, because a wrong
 * proposal costs more attention than a missing one.
 */
export const PENDING_CALENDAR_EVENT_TTL_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
export const PENDING_CALENDAR_EVENTS_PER_MAIL = 8;
export const PENDING_CALENDAR_EVENT_MIN_CONFIDENCE = 0.5;

/**
 * The calendar window ⌘K reaches: last week, and the 45-day range cap ahead
 *. The Worker searches it; a client that opens an event row looks
 * in the same window when the event is not in the week it has loaded, so
 * every hit Search can show is one the door can open.
 */
export const SEARCH_EVENTS_BACK_DAYS = 7;
export const SEARCH_EVENTS_AHEAD_DAYS = 38;

/**
 * How close two lines from one person have to be to read as one turn, on
 * every client. Slack's rule: three sentences typed in a row become one block
 * instead of three separately stamped rows. Swift reads it as
 * `ContractConstants.threadGroupingWindowMs`.
 */
export const THREAD_GROUPING_WINDOW_MS = 5 * 60 * 1000;

/**
 * A custom call background is scaled to what the camera is worth matching,
 * once on the way in. Past the byte ceiling a file is a mistake: a screenshot
 * is a fraction of it.
 */
export const CUSTOM_BACKGROUND_MAX_WIDTH = 1280;
export const CUSTOM_BACKGROUND_MAX_HEIGHT = 720;
export const CUSTOM_BACKGROUND_MAX_BYTES = 12 * 1024 * 1024;
