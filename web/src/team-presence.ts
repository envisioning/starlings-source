import type {
  AgentActivity,
  AgentManifest,
  AgentManifestTool,
  IncomingRing,
  Peer,
  PeerClient,
  PeerIntent,
  PeerStatus,
  PeersResponse,
} from '@starlings/contracts';
import { isStrayConversation, teamRailOrder, type TeamRailDirect } from '@starlings/contracts/team-rail';
import { isWithinWorkingHours, WORK_DAY_BITS } from '@starlings/contracts/work-hours';
import { PEER_HEARTBEAT_INTERVAL_MILLISECONDS } from '@starlings/contracts/limits';
import { PEER_CLIENT_LABELS, PEER_STATUS_LABELS } from '@starlings/contracts/presence-values';
import { meetVersion } from 'virtual:meet-version';
import { apiFetch } from './api';
import type { ThreadSummary } from '@starlings/contracts';
import { refreshPoll, subscribePoll, type PollSubscriber } from './shared-poll';
import { formatTime, localTimeComponents } from './meeting-time';
import { plural, t, uiLocale } from './i18n';

export type { IncomingRing, Peer, PeerClient, PeersResponse };

export interface CalendarBusyInterval {
  start: string;
  end: string;
}

export interface CalendarFreeBusyPerson {
  email: string;
  busy: CalendarBusyInterval[];
  /** Google can distinguish a free calendar from one the caller cannot read. */
  error: string;
}

/**
 * Read one colleague's free/busy for the viewer's current local day. This is
 * deliberately interaction-scoped rather than part of the roster poll: Team
 * can show a useful day strip without making every presence refresh fan out
 * into another calendar request for every person.
 */
export async function fetchPeerFreeBusy(
  email: string,
  day = new Date(),
): Promise<CalendarFreeBusyPerson> {
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const body = await apiFetch<{ people?: CalendarFreeBusyPerson[] }>('/calendar/free-busy', {
    method: 'POST',
    body: {
      time_min: start.toISOString(),
      time_max: end.toISOString(),
      emails: [email],
    },
    fallbackError: t('Couldn’t load their calendar.'),
    noStore: true,
  });
  return body.people?.find((person) => person.email.toLowerCase() === email.toLowerCase()) ?? {
    email,
    busy: [],
    error: 'unavailable',
  };
}

/** Roster read. Member-gated at the Worker; there is no unauthenticated form. */
export async function fetchPeers(): Promise<PeersResponse> {
  return apiFetch<PeersResponse>('/peers', {
    fallbackError: t('Couldn’t load your team.'),
    noStore: true,
  });
}

/**
 * Watch the roster. One timer and one `/peers` request for the whole tab,
 * however many things are reading it — the Team page, the home page's "is my
 * room open" button, and anything else that lands here later.
 *
 * This is the read worth sharing: every `/peers` fans out to a Durable Object
 * per room at the Worker, so a duplicate poller is a duplicate DO request, not
 * merely a duplicate fetch.
 */
export function subscribePeers(subscriber: PollSubscriber<PeersResponse>): () => void {
  return subscribePoll('peers', fetchPeers, subscriber);
}

/** Re-read the roster now and hand it to every subscriber. */
export function refreshPeers(): Promise<void> {
  return refreshPoll('peers');
}

/**
 * "This browser has Meet open." Without it a member who lives in the web app
 * reads as offline to the whole team, and their last-seen is stuck at whenever
 * they last opened the Mac.
 */
/**
 * Undefined rather than a guess when the browser will not say. The Worker
 * treats a missing zone as "nothing new to record", which leaves whatever the
 * person's other devices last proved — better than overwriting it with UTC.
 */
function browserTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export async function sendHeartbeat(): Promise<void> {
  await apiFetch('/owner/heartbeat', {
    method: 'POST',
    // The zone travels with the beat: the browser already knows it, and the
    // alternative is a roster that can say somebody is available without
    // being able to say it is the middle of their night.
    // A dev build's version can be anything; only a plain x.y.z travels, so
    // a stray string never costs the beat itself.
    body: { client: 'web', timezone: browserTimezone(), version: /^\d{1,4}\.\d{1,4}\.\d{1,6}$/u.test(meetVersion) ? meetVersion : undefined },
    fallbackError: t('Couldn’t check in.'),
  });
}

export async function ringPeer(peerEmail: string): Promise<void> {
  await apiFetch('/peers/ring', {
    method: 'POST',
    body: { peer_email: peerEmail },
    fallbackError: t('Couldn’t wave at them.'),
  });
}

export async function clearIncomingRing(): Promise<void> {
  await apiFetch('/peers/ring/clear', {
    method: 'POST',
    body: {},
    fallbackError: t('Couldn’t clear that.'),
  });
}

export async function setDoNotDisturb(until: number | null): Promise<{ dnd_until: number | null }> {
  return apiFetch<{ dnd_until: number | null }>('/peers/dnd', {
    method: 'POST',
    body: { until },
    fallbackError: t('Couldn’t change your status.'),
  });
}

export async function setIntent(intent: PeerIntent | null, until: number | null): Promise<void> {
  await apiFetch('/peers/intent', {
    method: 'POST',
    body: { intent, until },
    fallbackError: t('Couldn’t change your status.'),
  });
}

export async function setAppearOffline(invisible: boolean): Promise<void> {
  await apiFetch('/peers/appear-offline', {
    method: 'POST',
    body: { invisible },
    fallbackError: t('Couldn’t change your visibility.'),
  });
}

export const heartbeatIntervalMs = PEER_HEARTBEAT_INTERVAL_MILLISECONDS;

/**
 * When a Focused or Unavailable set now runs out: the end of today. One
 * expiry, not a menu of them — a person who is done sooner picks Available.
 * Every timeboxed answer must end: a status nobody turns off is a person who
 * has quietly left the roster.
 */
export function endOfDay(now = new Date()): number {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end.getTime();
}

/**
 * Everything a person can say about themselves, in one list — the Mac's
 * `PeerStatusOption` (Sources/PeerPresence.swift) verbatim, in the same order:
 * most open at the top, most closed at the bottom. One control, one answer, so
 * nobody is ever both "available" and invisible (docs/PRESENCE.md).
 *
 * Focused and Unavailable are two columns at the Worker (`intent` and
 * `dnd_until`) because they are enforced differently — a ring lands quietly
 * on one and is refused on the other — but to the person setting them they
 * are two rows of the same question.
 */
export type StatusOptionKey = 'available' | 'focused' | 'unavailable' | 'offline';

export interface StatusOption {
  key: StatusOptionKey;
  label: string;
}

export const STATUS_OPTIONS: readonly StatusOption[] = [
  { key: 'available', label: t('Available') },
  { key: 'focused', label: t('Focused') },
  { key: 'unavailable', label: t('Unavailable') },
  { key: 'offline', label: t('Offline') },
];

/** The line your own card shows while hidden — your roster looks ordinary to you. */
export const APPEAR_OFFLINE_REMINDER = t('You appear offline to others');

/** Which row the person is standing on. */
export function selectedStatusOption(peer: Peer, now: number): StatusOption {
  const first = (key: StatusOptionKey) => STATUS_OPTIONS.find((option) => option.key === key) ?? STATUS_OPTIONS[0];
  if (peer.invisible) return first('offline');
  if (peer.dnd_until !== null && peer.dnd_until > now) return first('unavailable');
  if (peer.intent === 'focused') return first('focused');
  return first('available');
}

/**
 * Apply one answer, in the Mac's order: unavailable first (saying you are
 * around clears it), intent when the door is open, and visibility on every
 * answer — hiding hides, anything else means you can be seen again.
 */
export async function applyStatusOption(option: StatusOption, now = new Date()): Promise<void> {
  switch (option.key) {
    case 'available':
      await setDoNotDisturb(null);
      await setIntent('available', null);
      break;
    case 'focused':
      await setDoNotDisturb(null);
      await setIntent('focused', endOfDay(now));
      break;
    case 'unavailable':
      // Leaves intent alone on purpose: when the door opens again, where
      // you said you were is still where you are.
      await setDoNotDisturb(endOfDay(now));
      break;
    case 'offline':
      break;
  }
  await setAppearOffline(option.key === 'offline');
}

export function peerInitials(peer: Peer): string {
  const source = peer.name?.trim() || peer.email;
  const words = source.split(/[\s@._-]+/u).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0] ?? '').join('');
  return (letters || source.slice(0, 2)).toUpperCase();
}

export function peerDisplayName(peer: Peer): string {
  const name = peer.name?.trim();
  if (name) return name;
  return peer.email.split('@')[0] ?? peer.email;
}

export function peerShortName(peer: Peer): string {
  return peerDisplayName(peer).split(/\s+/u)[0] ?? peerDisplayName(peer);
}

/** Software, not somebody. See docs/AGENTS_SURFACE.md. */
export function isAgent(peer: Peer): boolean {
  return peer.kind === 'agent';
}

/**
 * A manifest's links out — home, readme, repo — in the order every client draws
 * them. Already clamped to http(s) by the contract.
 */
export function agentManifestLinks(manifest: AgentManifest): { title: string; url: string }[] {
  return [
    { title: t('Home'), url: manifest.home_url },
    { title: t('Readme'), url: manifest.readme_url },
    { title: t('Repo'), url: manifest.repo_url },
  ].filter((link): link is { title: string; url: string } => Boolean(link.url));
}

/** "Build efa621a · 2 hours ago", or the half that is known; null for neither. */
export function agentBuildLine(manifest: AgentManifest, now = Date.now()): string | null {
  const parts: string[] = [];
  if (manifest.version) parts.push(t('Build {version}', { version: manifest.version }));
  if (manifest.built_at) parts.push(relativeTime(Math.min(manifest.built_at, now), now));
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The lines under ACTIVITY, in the order every client draws them. Formatted
 * on the device like "last seen", so a cached roster never reads stale.
 */
export function agentActivityLines(activity: AgentActivity, now = Date.now()): string[] {
  const lines: string[] = [];
  let jobs = plural(activity.jobs_total, { one: '{count} job', other: '{count} jobs' });
  if (activity.jobs_30d > 0) jobs += t(', {jobs_30d} in the last 30 days', { jobs_30d: activity.jobs_30d });
  lines.push(jobs);
  if (activity.resets_30d > 0) {
    lines.push(plural(activity.resets_30d, { one: '{count} reset in the last 30 days', other: '{count} resets in the last 30 days' }));
  }
  if (activity.last_replied_at) lines.push(t('Last reply {now}', { now: relativeTime(Math.min(activity.last_replied_at, now), now) }));
  if (activity.typical_reply_ms) lines.push(t('Usually replies in {typical_reply_ms}', { typical_reply_ms: briefDuration(activity.typical_reply_ms) }));
  return lines;
}

/** "40 s", "4 min", "2 h" — the coarsest unit that still says something. */
function briefDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

/** One list entry for a tool: the name, the human gate, the description. */
export function agentToolEntry(tool: AgentManifestTool): { name: string; detail?: string } {
  return { name: tool.requires_approval ? t('{name} (asks first)', { name: tool.name }) : tool.name, detail: tool.description };
}

/**
 * The first line of a manifest description, for the one line a roster row has.
 * A multi-paragraph description belongs on the card, not crowding the row.
 */
export function firstLine(text: string): string {
  const line = text.split('\n', 1)[0]?.trim() ?? '';
  return line;
}

/**
 * Only a live host lease can answer a knock, so an awake phone is not enough
 * — and an agent has neither a room nor any way to be in one.
 */
/** The room Join room opens: the one they stand in (somebody else's when they are a guest there), else their own. */
export function joinRoomSlug(peer: Peer): string | null {
  return peer.status === 'in_meeting' ? (peer.in_room_slug ?? peer.room_slug) : null;
}

export function isCallable(peer: Peer): boolean {
  return !peer.is_self && !isAgent(peer) && peer.room_slug !== null
    && (peer.status === 'in_meeting' || peer.status === 'available');
}


/**
 * Anyone but you who is not offline and has not asked to be left alone.
 *
 * Never an agent: a ring is a nudge toward a room, the Worker refuses it with
 * `peer_unavailable`, and a button that always fails is worse than no button.
 */
export function isRingable(peer: Peer): boolean {
  return !peer.is_self && !isAgent(peer)
    && peer.status !== 'offline' && peer.status !== 'dnd';
}

const CLIENT_LABEL = Object.fromEntries(
  Object.entries(PEER_CLIENT_LABELS).map(([client, label]) => [client, t(label)]),
) as Record<PeerClient, string>;

export function clientLabel(client: PeerClient): string {
  return CLIENT_LABEL[client];
}

/** Every device they are on, each with the version it reported: "Desktop (5.8.1), Web". */
export function peerDevicesLine(peer: Pick<Peer, 'clients' | 'client_versions'>): string {
  return peer.clients.map((client) => {
    const version = peer.client_versions?.[client];
    return version ? `${clientLabel(client)} (${version})` : clientLabel(client);
  }).join(', ');
}

/** The colleague's clock, fixed to Meet's 24-hour format. */
export function peerLocalTime(peer: Peer, now = Date.now()): string | null {
  if (!peer.timezone) return null;
  try {
    return formatTime(new Date(now), { timeZone: peer.timezone });
  } catch {
    return null;
  }
}

/** Whether now is inside the working pattern the colleague supplied. */
export function peerIsWithinWorkingHours(peer: Peer, now = Date.now()): boolean | null {
  if (!peer.timezone || !peer.working_hours) return null;
  const local = localTimeComponents(new Date(now), peer.timezone);
  if (!local) return null;
  const weekdayBit = {
    mon: WORK_DAY_BITS.mon,
    tue: WORK_DAY_BITS.tue,
    wed: WORK_DAY_BITS.wed,
    thu: WORK_DAY_BITS.thu,
    fri: WORK_DAY_BITS.fri,
    sat: WORK_DAY_BITS.sat,
    sun: WORK_DAY_BITS.sun,
  }[local.weekday];
  if (!weekdayBit) return null;
  return isWithinWorkingHours(peer.working_hours, local.hour * 60 + local.minute, weekdayBit);
}

/**
 * The status line says what can be done about it, not only what is true:
 * "Available" means a room can answer, and a peer with no room can never be
 * called however awake their phone is.
 */
export function statusLine(peer: Peer, now: number): string {
  // Your own card while you appear offline: the roster hands you the truth
  // (`invisible` is only ever true on your own row), but the card says what
  // everyone else sees, or it reads "Available" over a menu that has Appear
  // offline checked.
  if (peer.invisible) return t('Offline');
  // `available` on an agent means *addressable*, not alive — nothing has
  // checked a runtime's health, and "Available" would promise that it had.
  // `busy` is the exception: the Worker writes it only when a runtime
  // accepted a hand-off, which is a claim something actually verified. No
  // "Agent" word: the avatar already says so.
  if (isAgent(peer)) return peer.status === 'busy' ? t('Working') : '';
  switch (peer.status) {
    case 'dnd':
      return peer.dnd_until
        ? t('Unavailable · until {dnd_until}', { dnd_until: clockTime(peer.dnd_until) })
        : t('Unavailable');
    case 'in_meeting':
      return peer.participants > 0
        ? plural(peer.participants, { one: t('In a meeting · {count} person'), other: t('In a meeting · {count} people') })
        : t('In a meeting');
    case 'busy':
      return peer.busy_until ? t('Busy · free at {busy_until}', { busy_until: clockTime(peer.busy_until) }) : t('Busy');
    case 'available':
      return intentLine(peer) ?? (peer.room_slug ? t('Available · {room_slug}', { room_slug: peer.room_slug }) : t('Available'));
    case 'active':
      return intentLine(peer) ?? t('Active');
    case 'offline':
      return peer.last_seen_at ? t('Last seen {now}', { now: relativeTime(peer.last_seen_at, now) }) : t('Offline');
  }
}

/**
 * What they said, when it says more than what the devices prove. Drawn only
 * over `available`/`active`: a closed door or a meeting is a stronger fact,
 * and the server already dropped a lapsed intent.
 */
function intentLine(peer: Peer): string | null {
  if (peer.intent !== 'focused') return null;
  return peer.intent_until ? t('Focused · until {intent_until}', { intent_until: clockTime(peer.intent_until) }) : t('Focused');
}

/** The words are the contract's (`presence-values.ts`), drawn in the page's language. */
export const STATUS_LABEL = Object.fromEntries(
  Object.entries(PEER_STATUS_LABELS).map(([status, label]) => [status, t(label)]),
) as Record<PeerStatus, string>;

function clockTime(at: number): string {
  return formatTime(new Date(at));
}

const RELATIVE = new Intl.RelativeTimeFormat(uiLocale, { numeric: 'auto' });
const UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: 'year', ms: 365 * 24 * 60 * 60_000 },
  { unit: 'month', ms: 30 * 24 * 60 * 60_000 },
  { unit: 'day', ms: 24 * 60 * 60_000 },
  { unit: 'hour', ms: 60 * 60_000 },
  { unit: 'minute', ms: 60_000 },
];

/**
 * Rendered here rather than at the Worker: the roster is served from a
 * ten-second cache, so a server-formatted "2 minutes ago" would arrive stale
 * and in the wrong language. Clamped forward — clock skew between a phone and
 * the control plane must never produce "in 3 minutes".
 */
export function relativeTime(at: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - at);
  for (const { unit, ms } of UNITS) {
    if (elapsed >= ms) return RELATIVE.format(-Math.round(elapsed / ms), unit);
  }
  return t('just now');
}

export async function callPeer(peerEmail: string): Promise<void> {
  await apiFetch('/peers/call', {
    method: 'POST', body: { peer_email: peerEmail }, fallbackError: t('Couldn’t call them.'),
  });
}

/** A one-use marker for the deliberate Call gesture; URLs alone never auto-join. */
export function enterPeerRoom(slug: string): void {
  sessionStorage.setItem('meet.pendingCall', JSON.stringify({ slug, at: Date.now() }));
  window.location.assign(`/room/${encodeURIComponent(slug)}`);
}

export function consumePeerCall(slug: string): boolean {
  try {
    const raw = sessionStorage.getItem('meet.pendingCall');
    sessionStorage.removeItem('meet.pendingCall');
    if (!raw) return false;
    const call = JSON.parse(raw) as { slug?: string; at?: number };
    return call.slug === slug && typeof call.at === 'number' && Date.now() - call.at >= 0 && Date.now() - call.at < 45_000;
  } catch { return false; }
}

/**
 * The Team rail's one order for PEOPLE and AGENTS — `TeamRail.order` in
 * `Sources/DirectMessages.swift` for the Mac and the phone (docs/SURFACES.md
 * "Team's rail", 2026-09-15), the shape Work's SUBJECTS has: whoever you
 * have a conversation with, latest message first, then everybody else as
 * the server sorted them (present first, then alphabetical). Unread does
 * not jump the queue — the dot and the weight say it, as on a subject row.
 */
export function orderTeamRail(peers: Peer[], directs: ThreadSummary[]): Peer[] {
  // The rule is one for every client (`@starlings/contracts/team-rail`).
  const byEmail = new Map(peers.map((peer) => [peer.email, peer]));
  return teamRailOrder(peers.map((peer) => peer.email), directs.map(railDirect))
    .flatMap((email) => byEmail.get(email) ?? []);
}

/** A thread, reduced to what the rail's rules read. */
function railDirect(thread: ThreadSummary): TeamRailDirect {
  return {
    kind: thread.kind,
    isGroup: (thread.peers?.length ?? 0) > 1,
    peerEmail: thread.peer_email ?? null,
    lastMessageAt: thread.last_message_at ?? null,
  };
}

/**
 * Conversations whose other side is not on the roster — hidden in Admin,
 * or gone cold enough to fall off it. They trail PEOPLE, drawn from the
 * thread, so a conversation outlives the row that started it.
 */
export function strayConversations(directs: ThreadSummary[], roster: Peer[], selfEmail: string | undefined): ThreadSummary[] {
  const known = new Set(roster.map((peer) => peer.email));
  return directs.filter((thread) => isStrayConversation(railDirect(thread), known, selfEmail));
}
