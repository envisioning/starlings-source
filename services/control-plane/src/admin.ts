// Account-wide /admin read model. Assembled at the Worker: live tiles and
// meeting history fan out over OWNER_ROOM_MAP Durable Objects; people come
// from D1. Never put transcript text, summary text, or guest emails on this
// object — the page renders it as JSON. See docs/ADMIN.md.
//
// Two writes live here, both org-wide and both `requireOrgAdmin`: roster
// visibility (Admin is where a test account gets taken out of the global Team
// list, because Admin is the only surface that still shows it afterwards) and
// role. Every one of them appends to `admin_audit` — see docs/ADMIN.md §11.

import { subjectAccessFor } from './subject-access';
import { identityDomains, isRootAdminEmail, rootAdminEmails } from './workspace-identity';
import { publicRooms, retireRoomStatement } from './member-rooms';
import { notesEngineState, type NotesEngineState } from './notes';
import { agentFreezes } from './agent-freezes';
import { agents } from './agents';
import { dropOwnerDevice, forgetDevice, isBootstrapAdminEmail, listOwnerDevices } from './auth';
import { resetRoleCache, type RoleSession } from './capabilities';
import { lastJobRuns, recentAdminActions, recordAdminAction, type AdminAuditEntry } from './admin-audit';
import { recentMcpCalls } from './mcp';
import type { McpCallEntry } from '@starlings/contracts/mcp';
import type { AdminOverview as ContractAdminOverview } from '@starlings/contracts';
import { ledgerMeetings } from './ledger';
import { downstreamUsageSummary } from './downstream-usage';
import {
  type AdminAgentActivityResponse,
  type AdminDownstreamUsage,
  adminPersonAccessSchema,
  adminPersonRoleSchema,
  adminPersonVisibilitySchema,
  deviceRevokeSchema,
  emailSchema,
  ownerRoomMap,
  type AdminPersonAccessResponse,
  type AdminPersonDevicesResponse,
  type AdminPersonRole,
  type AdminPersonRoleResponse,
  type AdminPersonVisibilityResponse,
  type OwnerSession,
} from './contracts';
import { crmSyncEnabled } from './crm';
import { clearResponsibleFor } from './responsible';
import { ControlError } from './errors';
import { resetPeerRosterCache } from './peers';
import type { AdminMeetingRecord, AdminRoomSnapshot } from './room-coordinator';
import { roomStub } from './do-jurisdiction';
import { githubAppConnected } from './github-app';

/** LiveKit Cloud Build (free): 5,000 WebRTC participant-minutes/month, hard cap. */
export const LIVEKIT_PARTICIPANT_MINUTES_PER_MONTH = 5_000;
export const CONCURRENT_PARTICIPANT_CAP = 100;

export type ThresholdBand = 'green' | 'amber' | 'red';

export interface AdminThreshold {
  id: string;
  label: string;
  used: number;
  limit: number;
  unit: string;
  source: string;
  band: ThresholdBand;
  /** Straight-line projection to period end; omitted for instantaneous caps. */
  projected?: number;
}

/** `GET /api/admin/overview`: the one shape, in `@starlings/contracts` (`adminOverviewSchema`). */
export type AdminOverview = ContractAdminOverview;

/**
 * One roster row as Admin sees it. Same shape for a human and an agent so the
 * page renders two tables from one type — `kind` is what splits them, and
 * `hidden` is the only thing Admin can change here.
 */
/** `off` is the kill switch; `not_configured` is a missing shared secret. */
export type CrmSyncState = 'on' | 'off' | 'not_configured';

export interface AdminConfiguration {
  rooms: Array<{ slug: string; owner_email: string }>;
  livekit_minutes_limit: number;
  concurrent_participant_cap: number;
  crm_sync: CrmSyncState;
  /** Who writes meeting notes: Claude when the key is set, else Workers AI. */
  notes: NotesEngineState;
  identity_domains: string[];
  environment: string;
  /** Features that need a key; false says this workspace has them off. */
  features: { bot_check: boolean; bug_reports: boolean; github_connector: boolean };
}

export interface AdminPerson {
  email: string;
  name: string | null;
  kind: 'human' | 'agent';
  /** True when this row is filtered out of the global roster (`GET /api/peers`). */
  hidden: boolean;
  /** `admin` may make org-wide changes. Bootstrap room owners read as admin. */
  role: AdminPersonRole;
  /**
   * An account that is an admin unconditionally and cannot be demoted,
   * revoked, or locked out by anything this surface can do. The page draws no
   * controls for one, because there are none to draw.
   */
  root: boolean;
  /**
   * An agent row whose address is no longer in `AGENT_ROSTER`.
   *
   * Renaming an agent mints a new `sub`, so the old spelling keeps its row and
   * its history while the map moves on without it — `factory-www` beside
   * `factory-web`. Team already filters these out (`peerRoster`); Admin used to
   * list them beside live agents, which answered neither "who is on the team"
   * nor "what is running". Always false for a human.
   */
  retired: boolean;
  /** Cut off: no session renews, and every device was signed out. */
  revoked: boolean;
  /** Signed-in devices holding a refresh token. Zero for an agent. */
  devices: number;
  last_seen_at: number;
  room_slug: string | null;
  calendar_connected: boolean;
  last_client: string | null;
  meetings_hosted: number;
}

export interface AdminMeeting {
  meeting_id: string;
  room_slug: string;
  host_email: string;
  title: string | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  participant_count: number;
  guest_count: number;
  guest_domains: string[];
  was_booked: boolean;
    meeting_kind: string | null;
    worst_quality: string | null;
    summary_generated: boolean;
    crm_synced: boolean;
}

export async function adminOverview(env: Env, viewer: RoleSession): Promise<AdminOverview> {
  // Read-only. Same as GET /api/auth/me: a cookie or bearer is enough.
  // Origin is omitted on many same-origin GETs, and requiring it 403'd the
  // Vite sign-in into a reload loop. The `admin` gate in `routes/admin.ts`
  // decides who reads it.

  const rooms = await publicRooms(env);
  const degraded: string[] = [];
  const snapshots = await Promise.all(
    rooms.map(async ({ slug }) => {
      try {
        const room = await roomStub(env, slug);
        return await room.adminSnapshot(slug);
      } catch (error) {
        console.warn(JSON.stringify({
          level: 'warn',
          message: 'admin.room.snapshot.failed',
          slug,
          error: error instanceof Error ? error.message : 'Unknown error',
        }));
        // Zeros keep the arithmetic below total, but they are not the answer:
        // the slug goes on `degraded` so the page can say the figures are
        // short a room instead of drawing a quiet, wrong zero.
        degraded.push(slug);
        return emptyRoomSnapshot(slug);
      }
    }),
  );
  degraded.sort();

  const nowMs = Date.now();
  const monthStart = startOfUtcMonth(nowMs);
  const prevStart = startOfUtcMonth(monthStart - 1);
  const dayOfMonth = utcDayOfMonth(nowMs);
  const daysInMonth = utcDaysInMonth(nowMs);

  // Ledger first. The fan-out is the fallback for a ledger that has not been
  // backfilled yet, so the page never opens empty — see decision 9.
  const ledger = await ledgerMeetings(env);
  const meetingsSource: 'ledger' | 'rooms' = ledger.length > 0 ? 'ledger' : 'rooms';
  const meetings = meetingsSource === 'ledger' ? ledger : snapshots.flatMap((room) => room.meetings);
  const thisMonth = meetings.filter((row) => row.started_at >= monthStart);
  const priorMonth = meetings.filter((row) => row.started_at >= prevStart && row.started_at < monthStart);

  const minutes = (rows: AdminMeetingRecord[]) => rows.reduce((sum, row) => sum + row.client_seconds, 0) / 60;
  const participantMinutes = minutes(thisMonth);
  const priorMinutes = minutes(priorMonth);
  const projectedMinutes = dayOfMonth > 0 ? (participantMinutes / dayOfMonth) * daysInMonth : participantMinutes;
  const downstreamUsage = await downstreamUsageSummary(env, monthStart).catch(() => null);

  const uniqueHosts = new Set(thisMonth.map((row) => row.host_email)).size;
  const uniqueGuests = thisMonth.reduce((sum, row) => sum + row.guest_count, 0);
  const durations = thisMonth
    .map((row) => row.duration_ms)
    .filter((value): value is number => value != null && value > 0);
  const averageDuration = durations.length === 0
    ? 0
    : durations.reduce((sum, value) => sum + value, 0) / durations.length;

  const roomsInSession = snapshots.filter((room) => room.live.in_session);
  const participantsConnected = snapshots.reduce((sum, room) => sum + room.live.participants, 0);
  const waiting = snapshots.reduce((sum, room) => sum + room.live.waiting, 0);
  const busiestRoom = snapshots.reduce((max, room) => Math.max(max, room.live.participants), 0);

  const hostedByEmail = new Map<string, number>();
  for (const row of thisMonth) {
    hostedByEmail.set(row.host_email, (hostedByEmail.get(row.host_email) ?? 0) + 1);
  }

  const roster = await loadPeople(env, hostedByEmail);
  const people = roster.filter((row) => row.kind !== 'agent');
  // Retired rows are kept in D1 — an old message resolves its sender through
  // one — and shown nowhere. `retired_agents` is the count, so the page can
  // say they exist without listing them as if they were running.
  const liveAgents = roster.filter((row) => row.kind === 'agent' && !row.retired);
  const retiredAgents = roster.filter((row) => row.kind === 'agent' && row.retired).length;
  const funnel = mergeFunnel(snapshots);
  const crmSync = crmSyncState(env);
  const health = {
    ended_without_summary: meetings.filter((row) => row.ended_at != null && !row.summary_generated).length,
    crm_sync: crmSync,
    poor_quality_participants: snapshots.reduce((sum, room) => sum + room.poor_quality_participants, 0),
    reconnects: snapshots.reduce((sum, room) => sum + room.reconnects, 0),
  };

  const thresholds: AdminThreshold[] = [
    threshold(
      'livekit_minutes',
      'LiveKit participant-minutes',
      participantMinutes,
      LIVEKIT_PARTICIPANT_MINUTES_PER_MONTH,
      'min / month',
      'LiveKit Cloud Build (5,000 min/month, hard cap)',
      projectedMinutes,
    ),
    threshold(
      'concurrent',
      'Concurrent participants',
      participantsConnected,
      CONCURRENT_PARTICIPANT_CAP,
      '',
      'SESSIONS.md cap',
    ),
    threshold(
      'per_room',
      'Participants in busiest room',
      busiestRoom,
      CONCURRENT_PARTICIPANT_CAP,
      '',
      'SESSIONS.md cap',
    ),
  ].sort((a, b) => bandRank(a.band) - bandRank(b.band));

  const [allAudit, jobs, allMcpCalls, viewerIsAdmin, access] = await Promise.all([
    recentAdminActions(env),
    lastJobRuns(env),
    recentMcpCalls(env),
    isOrgAdminEmail(env, roster, viewer),
    subjectAccessFor(env, viewer),
  ]);
  // Only an admin reads this page, but an admin by root or bootstrap may
  // still lack a subject grant: a restricted subject the viewer cannot see
  // must not show up by id in the trail or the call record (docs/ACCESS.md).
  const hiddenIds = viewerIsAdmin ? [] : access.hidden.map((key) => key.id);
  const names = (text: string | null | undefined) => !!text && hiddenIds.some((id) => text.includes(id));
  const audit = allAudit.filter((entry) => !names(entry.subject) && !names(entry.detail));
  const mcpCalls = allMcpCalls.filter((entry) => !names(entry.args) && !names(entry.name));

  return {
    generated_at: nowMs,
    degraded,
    meetings_source: meetingsSource,
    now: {
      rooms_in_session: roomsInSession.length,
      participants_connected: participantsConnected,
      waiting,
      rooms: snapshots.map((room) => ({
        slug: room.slug,
        host_email: room.host_email,
        in_session: room.live.in_session,
        participants: room.live.participants,
        waiting: room.live.waiting,
      })),
    },
    this_month: {
      participant_minutes: round1(participantMinutes),
      participant_minutes_limit: LIVEKIT_PARTICIPANT_MINUTES_PER_MONTH,
      projected_minutes: round1(projectedMinutes),
      meetings: thisMonth.length,
      unique_hosts: uniqueHosts,
      unique_guests: uniqueGuests,
      average_duration_ms: averageDuration,
      prior_meetings: priorMonth.length,
      prior_minutes: round1(priorMinutes),
      sparkline: sparkline(meetings, nowMs),
    },
    downstream_usage: downstreamUsage,
    thresholds,
    people,
    agents: liveAgents,
    retired_agents: retiredAgents,
    meetings: meetings
      .map(toPublicMeeting)
      .sort((a, b) => b.started_at - a.started_at),
    funnel,
    health,
    audit,
    jobs,
    mcp_calls: mcpCalls,
    viewer: { email: viewer.email, is_admin: viewerIsAdmin, is_root: isRootAdminEmail(env, viewer.email) },
    configuration: {
      rooms: rooms.map(({ slug, email }) => ({ slug, owner_email: email })),
      livekit_minutes_limit: LIVEKIT_PARTICIPANT_MINUTES_PER_MONTH,
      concurrent_participant_cap: CONCURRENT_PARTICIPANT_CAP,
      crm_sync: crmSync,
      notes: notesEngineState(env),
      identity_domains: [...identityDomains(env)],
      environment: String(env.ENVIRONMENT ?? 'unknown'),
      features: {
        bot_check: Boolean(env.TURNSTILE_SECRET_KEY?.trim()),
        bug_reports: Boolean(env.GITHUB_ISSUES_TOKEN?.trim() && env.GITHUB_ISSUES_REPO?.trim()),
        github_connector: await githubAppConnected(env),
      },
    },
  };
}

/**
 * Recent agent activity observed by Meet. This deliberately reports only
 * hand-off outcomes and finalized replies, not thread contents or runtime
 * internals. Acceptance and reply are separate facts, not a claimed run pair.
 */
export async function adminAgentActivity(env: Env): Promise<AdminAgentActivityResponse> {
  const generatedAt = Date.now();
  const since = generatedAt - 30 * 24 * 60 * 60_000;
  const eventLimit = 100;
  const [grouped, recent, total, people, freezes] = await Promise.all([
    env.USAGE.prepare(
      `SELECT agent_sub,
              SUM(CASE WHEN kind = 'handoff' THEN 1 ELSE 0 END) AS handoffs,
              SUM(CASE WHEN kind = 'accepted' THEN 1 ELSE 0 END) AS accepted,
              SUM(CASE WHEN kind = 'rejected' THEN 1 ELSE 0 END) AS rejected,
              SUM(CASE WHEN kind = 'delivery_failed' THEN 1 ELSE 0 END) AS delivery_failed,
              SUM(CASE WHEN kind = 'reply' THEN 1 ELSE 0 END) AS replies,
              SUM(CASE WHEN kind = 'watchdog_reset' THEN 1 ELSE 0 END) AS watchdog_resets,
              SUM(CASE WHEN kind = 'watchdog_reset_failed' THEN 1 ELSE 0 END) AS watchdog_reset_failures,
              MAX(occurred_at) AS last_activity_at
         FROM agent_activity_events
        WHERE occurred_at >= ?1
        GROUP BY agent_sub`,
    ).bind(since).all<{
      agent_sub: string;
      handoffs: number;
      accepted: number;
      rejected: number;
      delivery_failed: number;
      replies: number;
      watchdog_resets: number;
      watchdog_reset_failures: number;
      last_activity_at: number | null;
    }>(),
    env.USAGE.prepare(
      `SELECT agent_sub, kind, occurred_at, duration_ms, response_status
         FROM agent_activity_events
        WHERE occurred_at >= ?1
        ORDER BY occurred_at DESC, event_id DESC
        LIMIT ?2`,
    ).bind(since, eventLimit).all<{
      agent_sub: string;
      kind: AdminAgentActivityResponse['events'][number]['kind'];
      occurred_at: number;
      duration_ms: number | null;
      response_status: number | null;
    }>(),
    env.USAGE.prepare(
      'SELECT COUNT(*) AS count FROM agent_activity_events WHERE occurred_at >= ?1',
    ).bind(since).first<{ count: number }>(),
    env.USAGE.prepare(
      "SELECT sub, email, name FROM people WHERE kind = 'agent'",
    ).all<{ sub: string; email: string; name: string | null }>(),
    agentFreezes(env),
  ]);

  const configured = await agents(env);
  const configuredBySub = new Map(configured.map((agent) => [agent.sub, agent]));
  const peopleBySub = new Map(people.results.map((person) => [person.sub, person]));
  type Summary = AdminAgentActivityResponse['agents'][number];
  const summaries = new Map<string, Summary>();
  const ensureSummary = (sub: string): Summary => {
    const existing = summaries.get(sub);
    if (existing) return existing;
    const current = configuredBySub.get(sub);
    const person = peopleBySub.get(sub);
    const email = current?.email ?? person?.email ?? sub.replace(/^agent:/u, '');
    const summary: Summary = {
      agent_email: email,
      agent_name: current?.name ?? person?.name ?? null,
      endpoint_configured: Boolean(current?.endpoint),
      source: current?.source ?? null,
      endpoint_origin: current?.endpoint ? new URL(current.endpoint).origin : null,
      handoffs: 0,
      accepted: 0,
      rejected: 0,
      delivery_failed: 0,
      replies: 0,
      watchdog_resets: 0,
      watchdog_reset_failures: 0,
      last_activity_at: null,
      frozen_at: freezes.get(sub)?.frozen_at ?? null,
      frozen_by_email: freezes.get(sub)?.frozen_by_email ?? null,
    };
    summaries.set(sub, summary);
    return summary;
  };

  for (const agent of configured) ensureSummary(agent.sub);
  // A frozen agent stays listed after it leaves the roster, so its freeze can be lifted.
  for (const sub of freezes.keys()) ensureSummary(sub);
  for (const row of grouped.results) {
    Object.assign(ensureSummary(row.agent_sub), {
      handoffs: row.handoffs,
      accepted: row.accepted,
      rejected: row.rejected,
      delivery_failed: row.delivery_failed,
      replies: row.replies,
      watchdog_resets: row.watchdog_resets,
      watchdog_reset_failures: row.watchdog_reset_failures,
      last_activity_at: row.last_activity_at,
    });
  }

  const agentsSummary = [...summaries.values()].sort((a, b) => a.agent_email.localeCompare(b.agent_email));
  const totals = agentsSummary.reduce((sum, row) => ({
    handoffs: sum.handoffs + row.handoffs,
    accepted: sum.accepted + row.accepted,
    rejected: sum.rejected + row.rejected,
    delivery_failed: sum.delivery_failed + row.delivery_failed,
    replies: sum.replies + row.replies,
    watchdog_resets: sum.watchdog_resets + row.watchdog_resets,
    watchdog_reset_failures: sum.watchdog_reset_failures + row.watchdog_reset_failures,
  }), {
    handoffs: 0,
    accepted: 0,
    rejected: 0,
    delivery_failed: 0,
    replies: 0,
    watchdog_resets: 0,
    watchdog_reset_failures: 0,
  });
  const events = recent.results.flatMap((row) => {
    const summary = summaries.get(row.agent_sub);
    return summary ? [{
      agent_email: summary.agent_email,
      agent_name: summary.agent_name,
      kind: row.kind,
      occurred_at: row.occurred_at,
      duration_ms: row.duration_ms,
      response_status: row.response_status,
    }] : [];
  });

  return {
    generated_at: generatedAt,
    window_days: 30,
    source: 'meet-observed',
    totals,
    agents: agentsSummary,
    events,
    events_truncated: (total?.count ?? 0) > eventLimit,
  };
}

/**
 * Two independent reasons the meeting log might not be reaching Core, told
 * apart because they need different fixes: `CRM_SYNC_MODE` is a deliberate
 * kill switch, a missing `INTERNAL_REQUEST_SECRET` is an unfinished setup.
 * Neither branch reveals the secret — only whether one is present.
 */
function crmSyncState(env: Env): CrmSyncState {
  if (String(env.CRM_SYNC_MODE ?? 'on') !== 'on') return 'off';
  return crmSyncEnabled(env) ? 'on' : 'not_configured';
}

/**
 * Whether the caller may use the controls the page renders.
 *
 * Answered from the roster already in hand rather than with a second query —
 * `loadPeople` has just read every row, and a page that draws a button it is
 * about to 403 is worse than one that draws none.
 */
async function isOrgAdminEmail(
  env: Env,
  roster: AdminPerson[],
  viewer: OwnerSession,
): Promise<boolean> {
  if (isBootstrapAdminEmail(env, viewer.email)) return true;
  const email = viewer.email.trim().toLowerCase();
  return roster.some((row) => row.email.trim().toLowerCase() === email && row.role === 'admin');
}

function toPublicMeeting(row: AdminMeetingRecord): AdminMeeting {
  return {
    meeting_id: row.meeting_id,
    room_slug: row.room_slug,
    host_email: row.host_email,
    title: row.title,
    started_at: row.started_at,
    ended_at: row.ended_at,
    duration_ms: row.duration_ms,
    participant_count: row.participant_count,
    guest_count: row.guest_count,
    guest_domains: row.guest_domains,
    was_booked: row.was_booked,
    meeting_kind: row.meeting_kind,
    worst_quality: row.worst_quality,
    summary_generated: row.summary_generated,
    crm_synced: row.crm_synced,
  };
}

async function loadPeople(
  env: Env,
  hostedByEmail: Map<string, number>,
): Promise<AdminPerson[]> {
  // The map is the roster, exactly as `peerRoster` treats it. An agent row the
  // map no longer names is retired, not running.
  const listed = new Set((await agents(env)).map((agent) => agent.email.trim().toLowerCase()));
  try {
    const { results } = await env.USAGE.prepare(
      `SELECT p.email, p.name, p.kind, p.role, p.hidden_at, p.revoked_at, p.last_seen_at,
              p.room_slug, p.calendar_connected, p.last_client,
              (SELECT COUNT(*) FROM owner_devices d WHERE d.sub = p.sub) AS devices
       FROM people p ORDER BY p.last_seen_at DESC`,
    ).all<{
      email: string;
      name: string | null;
      kind: string | null;
      role: string | null;
      hidden_at: number | null;
      revoked_at: number | null;
      devices: number;
      last_seen_at: number;
      room_slug: string | null;
      calendar_connected: number;
      last_client: string | null;
    }>();
    return results.map((row) => ({
      email: row.email,
      name: row.name,
      // Anything that is not the literal 'agent' is a human. An unknown kind
      // from an older row must not quietly become a robot.
      kind: row.kind === 'agent' ? 'agent' : 'human',
      // A room owner reads as admin whether or not the column says so — that
      // is the bootstrap in `requireOrgAdmin`, and the page must show the same
      // truth the guard enforces.
      role: row.role === 'admin' || isBootstrapAdminEmail(env, row.email) ? 'admin' : 'member',
      hidden: row.hidden_at != null,
      root: isRootAdminEmail(env, row.email),
      retired: row.kind === 'agent' && !listed.has(row.email.trim().toLowerCase()),
      // A root admin's row cannot say otherwise, whatever the column holds.
      revoked: isRootAdminEmail(env, row.email) ? false : row.revoked_at != null,
      devices: row.devices ?? 0,
      last_seen_at: row.last_seen_at,
      room_slug: row.room_slug,
      calendar_connected: row.calendar_connected === 1,
      last_client: row.last_client,
      meetings_hosted: hostedByEmail.get(row.email) ?? 0,
    }));
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'admin.people.query.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return [];
  }
}

/**
 * Hide a roster row from the global view, or bring it back.
 *
 * Nothing is deleted: `hidden_at` is a filter applied by `peerRoster`, so a
 * hidden test account keeps its history, still resolves as the sender of old
 * messages, and reappears the moment this is called with `hidden: false`.
 *
 * The roster cache is per-isolate and ten seconds long, so dropping it here
 * only makes *this* isolate honest immediately — the rest catch up on their
 * own TTL. That is the correct trade: the alternative is a coordination
 * binding for a change that is measured in minutes, not milliseconds.
 */
export async function setPersonVisibility(
  env: Env,
  owner: OwnerSession,
  raw: unknown,
): Promise<AdminPersonVisibilityResponse> {
  const input = adminPersonVisibilitySchema.parse(raw);
  const hiddenAt = input.hidden ? Date.now() : null;

  const result = await env.USAGE.prepare(
    `UPDATE people SET hidden_at = ?2, hidden_by_sub = ?3 WHERE email = ?1`,
  ).bind(input.email, hiddenAt, input.hidden ? owner.sub : null).run();

  if ((result.meta?.changes ?? 0) === 0) {
    throw new ControlError('No such person.', 404, 'person_not_found');
  }

  resetPeerRosterCache();
  // `hidden_by_sub` records only the *current* state's author, and un-hiding
  // clears it. The audit row is the part that survives the next change.
  await recordAdminAction(env, owner, input.hidden ? 'person.hide' : 'person.show', input.email, null);
  return { email: input.email, hidden: input.hidden };
}

/**
 * Grant or withdraw org admin.
 *
 * Both refusals here are the server's to make, not the page's: a disabled
 * button is a courtesy, and this route is reachable without one.
 *
 * - **Never your own role.** Self-promotion is the obvious half. The half that
 *   actually bites is an admin demoting themselves and locking the only
 *   surface that can undo it.
 * - **Never the last admin.** Counted across the role column *and* the
 *   `OWNER_ROOM_MAP` bootstrap, because those owners are admins too and an
 *   account with one of each is not an account with none.
 *
 * A bootstrap room owner cannot be demoted by writing this column at all —
 * `requireOrgAdmin` would keep admitting them — so that is refused here rather
 * than written and silently ignored.
 */
export async function setPersonRole(
  env: Env,
  owner: OwnerSession,
  raw: unknown,
): Promise<AdminPersonRoleResponse> {
  const input = adminPersonRoleSchema.parse(raw);
  const email = input.email.trim().toLowerCase();

  if (email === owner.email.trim().toLowerCase()) {
    throw new ControlError('You can’t change your own role.', 409, 'role_change_refused');
  }

  const target = await env.USAGE.prepare('SELECT kind, role FROM people WHERE email = ?1')
    .bind(email)
    .first<{ kind: string | null; role: string | null }>();
  if (!target) throw new ControlError('No such person.', 404, 'person_not_found');
  if (target.kind === 'agent') {
    throw new ControlError('An agent can’t be an admin.', 409, 'role_change_refused');
  }
  if (isRootAdminEmail(env, email)) {
    throw new ControlError(
      'That account is a root admin and cannot be demoted.',
      409,
      'role_change_refused',
    );
  }
  if (isBootstrapAdminEmail(env, email)) {
    throw new ControlError(
      'A room owner is an admin by configuration. Change OWNER_ROOM_MAP instead.',
      409,
      'role_change_refused',
    );
  }

  if (input.role === 'member' && target.role === 'admin' && await countAdmins(env) <= 1) {
    throw new ControlError('That is the last admin.', 409, 'role_change_refused');
  }

  await env.USAGE.prepare('UPDATE people SET role = ?2 WHERE email = ?1')
    .bind(email, input.role)
    .run();
  // A role change must bite on the next request, not after the cache window.
  resetRoleCache();

  await recordAdminAction(env, owner, 'person.role', email, input.role);
  return { email, role: input.role };
}

/**
 * Cut somebody off, or let them back.
 *
 * `people.revoked_at` has been read on every session renewal since
 * `0005_revocation.sql` and written by nothing. Offboarding was a hand-written
 * `wrangler d1 execute` that the person doing it had to remember existed. This
 * is the writer that column has been waiting for.
 *
 * Three things it does that a bare `UPDATE` does not:
 *
 * - **Signs the devices out.** Revocation only bites at the next renewal, and
 *   a Mac that renewed this morning has 60 days of refresh token left. Dropping
 *   `owner_devices` makes the refresh fail now rather than eventually. The
 *   access token they already hold still works until it expires — at most 8h —
 *   which is a property of a stateless JWT, not something this can fix, and is
 *   why the response says how many devices went.
 * - **Refuses the two suicides.** Revoking yourself locks you out of the page
 *   that would undo it; revoking the last admin locks everyone out of it.
 * - **Leaves a row.** Cutting off a colleague is the single most consequential
 *   thing this surface can do, and it is the one that most needs an author.
 *
 * Restoring is the same call with `revoked: false`. Nothing was deleted but the
 * device rows, so the person signs in again and carries on.
 */
export async function setPersonAccess(
  env: Env,
  owner: OwnerSession,
  raw: unknown,
): Promise<AdminPersonAccessResponse> {
  const input = adminPersonAccessSchema.parse(raw);
  const email = input.email.trim().toLowerCase();

  if (email === owner.email.trim().toLowerCase()) {
    throw new ControlError('You can’t revoke your own access.', 409, 'access_change_refused');
  }

  // Before the row is even read: a root admin cannot be revoked, and the
  // refusal must not depend on a query that could fail open.
  if (input.revoked && isRootAdminEmail(env, email)) {
    throw new ControlError(
      'That account is a root admin and cannot be revoked.',
      409,
      'access_change_refused',
    );
  }

  const target = await env.USAGE.prepare('SELECT sub, role FROM people WHERE email = ?1')
    .bind(email)
    .first<{ sub: string; role: string | null }>();
  if (!target) throw new ControlError('No such person.', 404, 'person_not_found');

  const targetIsAdmin = target.role === 'admin' || isBootstrapAdminEmail(env, email);
  if (input.revoked && targetIsAdmin && await countAdmins(env) <= 1) {
    throw new ControlError('That is the last admin.', 409, 'access_change_refused');
  }

  // Revoking retires their room in the same write: guests get the
  // not-found every unknown slug gets, and the slug is never reissued to
  // anybody else. Restoring leaves it retired; their next sign-in takes it back.
  const now = Date.now();
  const revoke = env.USAGE.prepare('UPDATE people SET revoked_at = ?2 WHERE email = ?1')
    .bind(email, input.revoked ? now : null);
  await env.USAGE.batch(input.revoked ? [revoke, retireRoomStatement(env, email, now)] : [revoke]);
  // The guards read `revoked_at` through the same cache as the role: this
  // isolate stops vouching for the person now, the others within the cache
  // window (capabilities.ts, `standingOf`).
  resetRoleCache();

  // Only on the way out. Restoring does not resurrect the devices — the person
  // signs in again, which is the same thing a new laptop would do.
  let devicesSignedOut = 0;
  if (input.revoked) {
    const { results } = await env.USAGE.prepare('SELECT device_id FROM owner_devices WHERE sub = ?1')
      .bind(target.sub)
      .all<{ device_id: string }>();
    const dropped = await env.USAGE.prepare('DELETE FROM owner_devices WHERE sub = ?1')
      .bind(target.sub)
      .run();
    devicesSignedOut = dropped.meta?.changes ?? 0;
    // Their native access tokens are refused from the next request, not from
    // the next renewal — as long as this isolate stops vouching for them. A web
    // session has no device row; `requireCapability` refuses it on `revoked_at`.
    for (const row of results) forgetDevice(row.device_id);
  }
  // Nobody inherits their subjects silently (docs/OWNERSHIP.md decision 9):
  // each one they answered for reads as nobody chosen, and shows a suggestion.
  const responsibleCleared = input.revoked ? await clearResponsibleFor(env, email, owner.email) : 0;

  await recordAdminAction(
    env,
    owner,
    input.revoked ? 'person.revoke' : 'person.restore',
    email,
    input.revoked
      ? `${devicesSignedOut} device${devicesSignedOut === 1 ? '' : 's'} signed out; responsible on ${responsibleCleared} subject${responsibleCleared === 1 ? '' : 's'} cleared`
      : null,
  );
  return { email, revoked: input.revoked, devices_signed_out: devicesSignedOut };
}

/** `GET /api/admin/people/devices?email=`: one person's signed-in installs. */
export async function listPersonDevices(env: Env, rawEmail: string | null): Promise<AdminPersonDevicesResponse> {
  const email = emailSchema.parse(rawEmail ?? '').trim().toLowerCase();
  const target = await env.USAGE.prepare('SELECT sub FROM people WHERE email = ?1')
    .bind(email)
    .first<{ sub: string }>();
  if (!target) throw new ControlError('No such person.', 404, 'person_not_found');
  return { email, devices: await listOwnerDevices(env, target.sub, null) };
}

/**
 * Sign one device out, whoever's it is.
 *
 * The one admin write that may target yourself or a root admin, because it is
 * not a lockout: the person signs in again from any device, and the account
 * that would have to repair things keeps every other way in. It exists for
 * the phone that is no longer in anybody's pocket — the person's own list in
 * Settings does the same for their own devices, and this is for when they
 * cannot reach it.
 */
export async function revokeDevice(
  env: Env,
  owner: OwnerSession,
  raw: unknown,
): Promise<AdminPersonDevicesResponse> {
  const input = deviceRevokeSchema.parse(raw);
  const target = await env.USAGE.prepare(
    `SELECT p.email, p.sub, d.client, d.label FROM owner_devices d JOIN people p ON p.sub = d.sub WHERE d.device_id = ?1`,
  )
    .bind(input.device_id)
    .first<{ email: string; sub: string; client: string; label: string | null }>();
  if (!target) throw new ControlError('That device is already signed out.', 404, 'device_not_found');
  await dropOwnerDevice(env, target.sub, input.device_id);
  await recordAdminAction(env, owner, 'device.revoke', target.email, target.label ?? target.client);
  return { email: target.email, devices: await listOwnerDevices(env, target.sub, null) };
}

/**
 * How many admins the account has, bootstrap owners included.
 *
 * Fails *closed* — an unreachable D1 answers 0, which refuses the demotion.
 * The alternative is a query error reading as "plenty of admins left" on the
 * one call whose whole purpose is to stop the account reaching zero.
 *
 * Root admins are seeded into the set before anything is read, so a healthy
 * count can never report an account that has one as having none. They are also
 * refused earlier and unconditionally, so nothing about the root guarantee
 * rests on this function returning at all.
 */
async function countAdmins(env: Env): Promise<number> {
  // Root admins count first and unconditionally, so this can never report an
  // account with a root admin in it as having none.
  const admins = new Set<string>(rootAdminEmails(env));
  try {
    for (const owner of Object.keys(ownerRoomMap(env.OWNER_ROOM_MAP))) admins.add(owner);
    const { results } = await env.USAGE.prepare(
      `SELECT email FROM people WHERE role = 'admin' AND revoked_at IS NULL`,
    ).all<{ email: string }>();
    for (const row of results) admins.add(row.email.trim().toLowerCase());
    return admins.size;
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'admin.role.count.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return 0;
  }
}

function mergeFunnel(snapshots: AdminRoomSnapshot[]): AdminOverview['funnel'] {
  const byClient: Record<string, number> = {};
  const byCountry: Record<string, number> = {};
  let knocks = 0;
  let admitted = 0;
  let rejected = 0;
  let joined = 0;
  for (const room of snapshots) {
    knocks += room.funnel.knocks;
    admitted += room.funnel.admitted;
    rejected += room.funnel.rejected;
    joined += room.funnel.joined;
    for (const [key, value] of Object.entries(room.funnel.by_client)) {
      byClient[key] = (byClient[key] ?? 0) + value;
    }
    for (const [key, value] of Object.entries(room.funnel.by_country)) {
      byCountry[key] = (byCountry[key] ?? 0) + value;
    }
  }
  const abandonRate = knocks === 0 ? 0 : Math.max(0, (knocks - joined) / knocks);
  return { knocks, admitted, rejected, joined, abandon_rate: abandonRate, by_client: byClient, by_country: byCountry };
}

function sparkline(meetings: AdminMeetingRecord[], nowMs: number): Array<{ day: string; meetings: number; minutes: number }> {
  const days: Array<{ day: string; meetings: number; minutes: number }> = [];
  for (let i = 29; i >= 0; i--) {
    const start = utcDayStart(nowMs - i * 86_400_000);
    const end = start + 86_400_000;
    const rows = meetings.filter((row) => row.started_at >= start && row.started_at < end);
    days.push({
      day: new Date(start).toISOString().slice(0, 10),
      meetings: rows.length,
      minutes: round1(rows.reduce((sum, row) => sum + row.client_seconds, 0) / 60),
    });
  }
  return days;
}

function threshold(
  id: string,
  label: string,
  used: number,
  limit: number,
  unit: string,
  source: string,
  projected?: number,
  precision = 1,
): AdminThreshold {
  const ratio = limit <= 0 ? 0 : (projected ?? used) / limit;
  const band: ThresholdBand = ratio >= 0.85 ? 'red' : ratio >= 0.6 ? 'amber' : 'green';
  return {
    id,
    label,
    used: roundTo(used, precision),
    limit,
    unit,
    source,
    band,
    ...(projected == null ? {} : { projected: roundTo(projected, precision) }),
  };
}

function roundTo(value: number, precision: number): number {
  return Number(value.toFixed(precision));
}

function bandRank(band: ThresholdBand): number {
  return band === 'red' ? 0 : band === 'amber' ? 1 : 2;
}

function emptyRoomSnapshot(slug: string): AdminRoomSnapshot {
  return {
    slug,
    host_email: '',
    live: { in_session: false, participants: 0, waiting: 0 },
    meetings: [],
    funnel: { knocks: 0, admitted: 0, rejected: 0, joined: 0, by_client: {}, by_country: {} },
    poor_quality_participants: 0,
    reconnects: 0,
  };
}

function startOfUtcMonth(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function utcDayOfMonth(ms: number): number {
  return new Date(ms).getUTCDate();
}

function utcDaysInMonth(ms: number): number {
  const date = new Date(ms);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

function utcDayStart(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
