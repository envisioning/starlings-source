import { isMemberEmail, isSameMember } from './workspace-identity';
import { DurableObject } from 'cloudflare:workers';
import { MeetingAgentStore, migrateMeetingAgentStore, meetingAgentOpenQuestions } from './meeting-agent-store';
import type { MeetingAgentPrepare, MeetingAgentRun, MeetingAgentToolRequest, MeetingAgentContext, MeetingAgentResult, MeetingAgentReceipt, MeetingAgentStatus } from '@starlings/contracts/meeting-agent';
import { constantTimeEqualSync, randomToken, sha256, sha256Hex } from './crypto';
import { SESSION_WINDOW_MARGIN_MS } from '@starlings/contracts/event-signups';
import { ControlError } from './errors';
import { fallbackSummary } from './meeting-fallback';
import { recordUsageEvents } from './ledger';
import { guestClientSchema, meetingFollowUpDraftSchema, type MeetingActionItem, type MeetingDecisionCandidate, type MeetingFollowUpDraft } from '@starlings/contracts';
import type {
  AmbientMeetingRow,
  ArtifactMaterialResponse,
  GuestClient,
  GuestPresenceRow,
  GuestPresenceStage,
  JoinRequestInput,
  JoinRequestReceipt,
  JoinStatusResponse,
  LobbyRequestResponse,
  LobbyStatusValue,
  RoomSettings,
  QualityReport,
  TranscriptSegment,
} from './contracts';
import {
  HOST_LEASE_MILLISECONDS,
  HOST_OFFER_MILLISECONDS,
  ROOM_KNOCKS_PER_MINUTE,
  ROOM_NEW_VISITORS_PER_MINUTE,
  MIN_MEETING_MILLISECONDS,
  STALE_MEETING_MILLISECONDS,
  internalRoomSlugs,
  ownerAccountEmail,
} from './contracts';
import { exportSqlState, freezeSql, importSqlState, migrateFrozen, unfreezeSql, type ObjectSnapshot } from './object-snapshot';
import { subjectOfCategory } from './meeting-category';
import { liveKitRoomName } from './livekit';

export type { JoinRequestReceipt };
export type JoinStatus = JoinStatusResponse;

export interface AdminMeetingRecord {
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
  client_seconds: number;
}

export interface MeetingCategory {
  meetingKind: 'uncategorized' | 'status' | 'lead' | 'project' | 'internal' | 'partner';
  leadId: string | null;
  projectId: string | null;
  partnerOrganizationId: string | null;
  subjectTitle: string | null;
  categorizedBy: string | null;
  categorizedAt: number | null;
}

/**
 * The presence-shaped slice of a room: what the team roster needs and nothing
 * else. Kept separate from `AdminRoomSnapshot` on purpose — that one carries
 * 500 meeting rows and billing counters, and every phone on the team polls
 * this one every half minute.
 */
export interface RoomPresenceSnapshot {
  slug: string;
  owner_email: string;
  owner_sub: string;
  in_session: boolean;
  participants: number;
  /** Host lease or soft presence inside the last 30s: their Mac is up. */
  host_present: boolean;
  /** Latest host sighting on either the room row or the open meeting. */
  host_seen_at: number | null;
  /**
   * Envisioning members in the open meeting, lower-cased.
   *
   * **Members only, never guests.** A count is a fact about a room; a name is a
   * fact about a person, and a visitor in somebody's room has not agreed to be
   * listed on a colleague's roster. Filtering by identity domain rather than by
   * participant `role` is deliberate — a colleague joining another owner's room
   * is role `guest`, and is still one of us.
   *
   * This is what lets the team surface say *who is with whom* instead of
   * drawing six people who are each, separately, "in a meeting".
   */
  member_emails: string[];
}

export interface AdminRoomSnapshot {
  slug: string;
  host_email: string;
  live: { in_session: boolean; participants: number; waiting: number };
  meetings: AdminMeetingRecord[];
  funnel: {
    knocks: number;
    admitted: number;
    rejected: number;
    joined: number;
    by_client: Record<string, number>;
    by_country: Record<string, number>;
  };
  poor_quality_participants: number;
  reconnects: number;
}

/**
 * How long the host must be gone before a waiting knock is expired. One missed
 * heartbeat (laptop lid, network blip) must not destroy the lobby queue, so
 * guests only expire after several full lease periods of host silence.
 */
const KNOCK_EXPIRY_GRACE_MILLISECONDS = 3 * HOST_LEASE_MILLISECONDS;
/** Sentinel meeting_id for knocks accepted while the native host is idle but has not pressed Start. */
const PRELIVE_MEETING_ID = '__prelive__';
/** Drop pre-knock lurkers after this much silence (heartbeat is ~15s from the browser). */
const GUEST_PRESENCE_TTL_MILLISECONDS = 45_000;

/**
 * Ceiling on abandon rows written by one presence sweep.
 *
 * A room nobody has opened for a week wakes up holding every stale presence
 * row at once, and the first lobby poll after that should not turn into a
 * thousand inserts. Losing the tail of an unusually large sweep is the right
 * trade for a funnel figure.
 */
const ABANDON_EVENTS_PER_SWEEP = 50;
/**
 * How long a removed lurker's tab is refused after the host closes their
 * connection. Long enough that the next heartbeat or knock actually stays
 * shut out instead of reappearing within a poll; short enough that it is a
 * cooldown, not a standing ban with no way to undo it.
 */
const PRESENCE_BLOCK_MILLISECONDS = 5 * 60_000;

/**
 * How long after a meeting ends its participants may still flush call quality.
 * The owner pressing End disconnects everyone, and each client sends its final
 * cumulative sample on the way out — that flush must land. Beyond this window
 * the 12h artifact token has no business writing anything.
 */
const ENDED_QUALITY_GRACE_MILLISECONDS = 5 * 60_000;
/** Guests let in at once, below the ~100 guardrail (AGENTS.md invariant 15). */
const GUEST_CAPACITY = 99;
/** How often one registration link may let somebody in, per meeting: a dropped connection rejoins, a forwarded link knocks (docs/SESSIONS.md §7). */
const SESSION_TOKEN_ADMITS = 3;
/** A roster fetch at most once a minute (docs/SESSIONS.md §7). */
const SESSION_ROSTER_REFETCH_MS = 60_000;

export interface RoomConfiguration {
  slug: string;
  ownerSub: string;
  ownerEmail: string;
  /** Display name from the owner's Google profile — never their email. */
  ownerName?: string | null;
  kind: 'permanent' | 'temporary';
  expiresAt: number | null;
}

export interface MeetingConnection {
  id: string;
  livekitRoom: string;
  startedAt: number;
  hostLeaseExpiresAt: number;
  /** The device that holds the host. The SQL columns keep the old `chair_*` names. */
  hostIdentity: string | null;
  pendingHostIdentity: string | null;
  /** The device the host offered the host to, while the offer stands (60 s). */
  hostOfferIdentity: string | null;
  /** Deprecated: the same values for 5.8.x Macs' lobby reads. removes them. */
  chairIdentity: string | null;
  pendingChairIdentity: string | null;
}

export type LobbyRequest = LobbyRequestResponse;

export interface LobbySnapshot {
  meeting: (MeetingConnection & { session_door_open?: boolean }) | null;
  requests: LobbyRequest[];
  lurkers: GuestPresenceRow[];
  room_settings: RoomSettings;
}

export interface GuestPresenceUpsert {
  presenceId: string;
  stage: GuestPresenceStage;
  name?: string | null;
  city?: string | null;
  country?: string | null;
  bookingToken?: string | null;
  client?: GuestClient | null;
}

export interface JoinExchange {
  meetingId: string;
  livekitRoom: string;
  startedAt: number;
  identity: string;
  name: string;
  email: string;
  /** Surface the guest knocked from, carried into the room token's metadata. */
  client: GuestClient | null;
  on_behalf_of: string | null;
  recording: boolean;
  /** The meeting is an event session (docs/SESSIONS.md §8). */
  session: boolean;
  /** A registration link let this guest in (docs/SESSIONS.md §7): the People list says so. */
  registered: boolean;
}

/** The event a meeting was armed with at room start (docs/SESSIONS.md §7). Times are ms. */
export interface MeetingSessionArm {
  event_id: string;
  starts_at: number;
  ends_at: number;
}

export interface MeetingQuality {
  identity: string;
  client: string;
  role: 'owner' | 'guest';
  connectedMs: number;
  excellentMs: number;
  goodMs: number;
  poorMs: number;
  lostMs: number;
  reconnectCount: number;
  worstQuality: string;
  updatedAt: number;
}

export type ArtifactMaterial = ArtifactMaterialResponse;

/**
 * A meeting's follow-up, kept beside its transcript: the draft,
 * which draft it is, and whether the host approved or dismissed it. An
 * approval names its revision; a later draft cannot inherit it.
 */
export interface StoredFollowUp {
  draft: MeetingFollowUpDraft;
  revision: number;
  writtenAt: number;
  approvedRevision: number | null;
  approvedAt: number | null;
  dismissedAt: number | null;
}

function readFollowUp(raw: string | null): StoredFollowUp | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredFollowUp>;
    const draft = meetingFollowUpDraftSchema.safeParse(value.draft);
    if (!draft.success || typeof value.revision !== 'number') return null;
    return {
      draft: draft.data,
      revision: value.revision,
      writtenAt: value.writtenAt ?? 0,
      approvedRevision: value.approvedRevision ?? null,
      approvedAt: value.approvedAt ?? null,
      dismissedAt: value.dismissedAt ?? null,
    };
  } catch {
    return null;
  }
}

export interface MeetingLogParticipant {
  identity: string;
  name: string;
  /** Empty string when the guest never supplied one — never invent an address. */
  email: string;
  /** Core's meeting-log role remains owner/guest; MCP uses `kind` below. */
  role: 'owner' | 'guest';
  kind: 'human' | 'agent' | 'guest';
  /** CRM cancellation token carried in on /room/<slug>/<token>, when present. */
  bookingToken: string | null;
}

/**
 * Everything the CRM sync needs, which is deliberately wider than
 * `ArtifactMaterial`: the meeting log wants the whole roster and its booking
 * provenance.
 */
export interface MeetingLogMaterial {
  roomSlug: string;
  ownerEmail: string;
  meetingId: string;
  livekitRoom: string;
  startedAt: number;
  endedAt: number | null;
  title: string | null;
  summary: string | null;
  transcript: TranscriptSegment[];
  participants: MeetingLogParticipant[];
  /** First booking token seen on any knock for this meeting. */
  bookingToken: string | null;
  meetingKind: 'uncategorized' | 'status' | 'lead' | 'project' | 'internal' | 'partner';
  leadId: string | null;
  projectId: string | null;
  partnerOrganizationId: string | null;
  subjectTitle: string | null;
  categorizedBy: string | null;
  categorizedAt: number | null;
  /** The Docs document holding the full transcript, once filed. */
  transcriptDocumentId: string | null;
  transcriptDocumentPath: string | null;
  /**
   * `hosted` for a meeting that ran in this room; `ambient` for one the
   * owner's Mac captured from another app and filed here (docs/AMBIENT_CAPTURE.md).
   * Derived from `livekit_room`: an ambient meeting has no SFU room, so its
   * name carries the `ambient:` prefix instead — no schema change.
   */
  captureKind: MeetingCaptureKind;
  /**
   * Counts every change a destination would want to hear about: transcript
   * lines, names, the category, the notes, the end. What the delivery ledger
   * records as requested and delivered.
   */
  revision: number;
  /** Counts transcript changes only; `summaryRevision` is its value when the notes were written. */
  transcriptRevision: number;
  summaryRevision: number;
  /** Structured agent questions; older notes retain their Markdown projection. */
  openQuestions?: string[] | null;
  /** What the notes engine wrote down as commitments, with Core's id once filed. */
  actionItems: MeetingActionItem[];
  /** What it wrote down as settled, with Core's id once the owner records one. */
  decisionCandidates: MeetingDecisionCandidate[];
  /** The follow-up drafted for the people outside, and where it stands. */
  followUp?: StoredFollowUp | null;
}

export type MeetingCaptureKind = 'hosted' | 'ambient';

/** The `livekit_room` value an ambient meeting stores: a marker, not a room. */
export function ambientRoomMarker(meetingId: string): string {
  return `ambient:${meetingId}`;
}

export function captureKindOf(livekitRoom: string): MeetingCaptureKind {
  return livekitRoom.startsWith('ambient:') ? 'ambient' : 'hosted';
}

interface RoomRow extends Record<string, SqlStorageValue> {
  slug: string;
  owner_sub: string;
  owner_email: string;
  owner_name: string | null;
  kind: string;
  expires_at: number | null;
  host_seen_at: number | null;
  refuse_recorders: number;
}

interface MeetingRow extends Record<string, SqlStorageValue> {
  id: string;
  livekit_room: string;
  started_at: number;
  ended_at: number | null;
  title: string | null;
  summary: string | null;
  host_seen_at: number;
  chair_device_id: string | null;
  chair_identity: string | null;
  pending_chair_device_id: string | null;
  pending_chair_identity: string | null;
  chair_released_at: number | null;
  /** The device the host offered the host to, its person, and when. */
  host_offer_identity: string | null;
  host_offer_email: string | null;
  host_offer_at: number | null;
  /** A member who accepted an offer: may host this meeting in a room not theirs. */
  host_member_sub: string | null;
  host_member_email: string | null;
  /** The identity the Host badge was last written on. */
  host_badge_identity: string | null;
  meeting_kind: string | null;
  lead_id: string | null;
  project_id: string | null;
  partner_organization_id: string | null;
  subject_title: string | null;
  categorized_by: string | null;
  categorized_at: number | null;
  transcript_document_id: string | null;
  transcript_document_path: string | null;
  revision: number | null;
  transcript_revision: number | null;
  summary_revision: number | null;
  action_items: string | null;
  decision_candidates: string | null;
  agent_notes_metadata: string | null;
  follow_up: string | null;
}

interface GuestPresenceRowSql extends Record<string, SqlStorageValue> {
  id: string;
  stage: string;
  name: string | null;
  city: string | null;
  country: string | null;
  client_app: string | null;
  client_device: string | null;
  seen_at: number;
  created_at: number;
}

interface JoinRow extends Record<string, SqlStorageValue> {
  id: string;
  meeting_id: string;
  name: string;
  email: string;
  identity: string;
  status: LobbyRequest['status'];
  created_at: number;
  lobby_token_hash: string;
  booking_token: string | null;
  client_app: string | null;
  client_device: string | null;
  on_behalf_of: string | null;
  recording: number;
  /** 1 when an event registration link let this guest in (docs/SESSIONS.md §7). */
  registered?: number;
}

interface MeetingQualityRow extends Record<string, SqlStorageValue> {
  identity: string;
  client: string;
  role: string;
  connected_ms: number;
  excellent_ms: number;
  good_ms: number;
  poor_ms: number;
  lost_ms: number;
  reconnect_count: number;
  worst_quality: string;
  updated_at: number;
}

interface SocketAttachment {
  role: 'owner' | 'guest';
  requestId: string | undefined;
}

export class RoomCoordinator extends DurableObject<Env> {
  /**
   * Booking token per live lurker, by presence id. Memory only — never a column.
   * The host needs to know a visitor arrived on a booking link; the link itself
   * has no reason to survive the visit. Heartbeats re-send it every ~15s, so an
   * evicted object refills this within one beat, and `pruneStaleLurkers` keeps
   * it in step with the rows.
   */
  private guestPresenceTokens = new Map<string, string>();
  private readonly roomEnvironment: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.roomEnvironment = env;
    this.ctx.blockConcurrencyWhile(async () => migrateFrozen(this.ctx.storage.sql, () => this.migrate()));
  }

  /** Every table this room owns, as JSON, for the daily backup. */
  async exportState(): Promise<ObjectSnapshot> {
    return exportSqlState(this.ctx.storage.sql);
  }

  /** Replace every table with a snapshot's rows, in one transaction. Writes after the snapshot are lost. */
  async importState(snapshot: unknown): Promise<Record<string, number>> {
    // A restore must not bring back a meeting erased after the snapshot.
    const markers = this.ctx.storage.sql.exec<ErasureMarker>('SELECT * FROM erased_meetings').toArray();
    const counts = await importSqlState(this.ctx.storage, snapshot);
    if (markers.length > 0) {
      this.ctx.storage.transactionSync(() => {
        for (const marker of markers) {
          this.deleteMeetingRows(marker.meeting_id);
          this.ctx.storage.sql.exec(
            `INSERT OR REPLACE INTO erased_meetings (meeting_id, request_id, erased_at, transcript_document_id, document_owner_email)
             VALUES (?, ?, ?, ?, ?)`,
            marker.meeting_id, marker.request_id, marker.erased_at, marker.transcript_document_id, marker.document_owner_email,
          );
        }
      });
    }
    return counts;
  }

  /**
   * Why this room cannot move to another jurisdiction now, or null.
   * A meeting that has not ended is live state: a lobby, a host lease, guests
   * reading their admission. `openMeeting` closes an abandoned one first.
   */
  async moveBlocker(): Promise<string | null> {
    return this.openMeeting() ? 'a meeting has not ended' : null;
  }

  /** Refuse every write until `unfreeze` (object-snapshot.ts). */
  async freeze(): Promise<void> {
    freezeSql(this.ctx.storage.sql);
  }

  async unfreeze(): Promise<void> {
    unfreezeSql(this.ctx.storage.sql);
  }

  /** Close every lobby socket: the room moved, and clients reconnect to the copy. */
  async closeSockets(reason: string): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(1012, reason);
      } catch {
        // Socket already closed.
      }
    }
  }

  /** Delete every row and table. Only for the old copy of a room that moved. */
  async purge(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async configureRoom(configuration: RoomConfiguration): Promise<RoomConfiguration> {
    const existing = this.room();
    if (existing) {
      if (existing.owner_sub !== configuration.ownerSub || existing.slug !== configuration.slug) {
        throw new RoomError('This room belongs to a different owner.', 403, 'different_owner');
      }
      return rowToConfiguration(existing);
    }
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO room (slug, owner_sub, owner_email, owner_name, kind, expires_at, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      configuration.slug,
      configuration.ownerSub,
      configuration.ownerEmail,
      configuration.ownerName ?? null,
      configuration.kind,
      configuration.expiresAt,
      now,
    );
    if (configuration.expiresAt !== null) await this.ctx.storage.setAlarm(configuration.expiresAt);
    return configuration;
  }

  async roomConfiguration(): Promise<RoomConfiguration | null> {
    const row = this.room();
    return row ? rowToConfiguration(row) : null;
  }

  /**
   * Repoint the room at a new Google subject for the same owner — a second
   * Mac, a dev session vs real sign-in, a re-created account, or the same
   * person on the other identity domain. The caller has already checked the
   * room (member-rooms.ts); the address must still name the same person here so this
   * can never hand a room to somebody else. The row takes the address that
   * is signed in now, so later exact comparisons see the live account.
   */
  async adoptOwner(owner: { sub: string; email: string }): Promise<RoomConfiguration> {
    const room = this.requiredRoom();
    if (!isSameMember(this.env, room.owner_email, owner.email)) {
      throw new RoomError('Only the room owner can do that.', 403, 'not_room_owner');
    }
    this.ctx.storage.sql.exec(
      'UPDATE room SET owner_sub = ?, owner_email = ? WHERE slug = ?',
      owner.sub,
      owner.email.trim().toLowerCase(),
      room.slug,
    );
    return rowToConfiguration(this.requiredRoom());
  }

  /**
   * `identity` is the LiveKit identity this connection will use — the account
   * address for a client that names no device, `mz+iphone@…` for one that
   * does. A second device of the same owner resumes the open meeting and adds
   * its own participant row instead of taking over the first one's.
   */
  async startMeeting(
    owner: { sub: string; email: string; name: string },
    identity: string = owner.email,
    deviceID: string | null = null,
  ): Promise<MeetingConnection> {
    this.assertOwnerOrHostMember(owner.sub);
    this.assertRoomActive();
    // Keep the public "waiting for <owner>" name current with whatever Google
    // reports today — the room row may predate the owner ever signing in.
    if (this.isSharedRoom()) {
      // `/room/team` has one Durable Object but no single human owner. Keep the
      // latest host on the row for admin/CRM attribution while every verified
      // member remains eligible to take the host.
      this.ctx.storage.sql.exec(
        'UPDATE room SET owner_sub = ?, owner_email = ?, owner_name = ? WHERE slug = ?',
        owner.sub,
        owner.email,
        owner.name,
        this.requiredRoom().slug,
      );
    } else {
      this.ctx.storage.sql.exec('UPDATE room SET owner_name = ? WHERE owner_sub = ?', owner.name, owner.sub);
    }
    const open = this.openMeeting();
    if (open) {
      const now = Date.now();
      // Only the current host renews the meeting lease. A second device joins
      // the same room as a companion and must claim the host explicitly,
      // unless nobody holds it: released, or a lease that lapsed because the
      // host device dropped without a word (a phone in a tunnel).
      const hostWasExplicitlyReleased = open.chair_identity === null
        && open.chair_device_id === null
        && open.chair_released_at !== null;
      const hostLeaseLapsed = now - open.host_seen_at > HOST_LEASE_MILLISECONDS;
      if (hostWasExplicitlyReleased || hostLeaseLapsed
        || (open.chair_identity === identity && open.chair_device_id === deviceID)) {
        this.ctx.storage.sql.exec(
          `UPDATE meetings SET host_seen_at = ?, chair_device_id = ?, chair_identity = ?, pending_chair_device_id = NULL,
            pending_chair_identity = NULL, chair_released_at = NULL WHERE id = ?`,
          now, deviceID, identity, open.id,
        );
      }
      this.recordOwnerParticipant(open.id, identity, owner, now);
      this.touchSoftPresence();
      const refreshed = this.meeting(open.id);
      return meetingConnection(refreshed ?? open);
    }

    const room = this.requiredRoom();
    const id = crypto.randomUUID();
    const livekitRoom = liveKitRoomName(this.env, room.slug, id);
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO meetings (id, livekit_room, started_at, host_seen_at, status, chair_device_id, chair_identity, chair_released_at)
       VALUES (?, ?, ?, ?, 'open', ?, ?, NULL)`,
      id,
      livekitRoom,
      now,
      now,
      deviceID,
      identity,
    );
    this.recordOwnerParticipant(id, identity, owner, now);
    this.attachPreliveWaitingToMeeting(id);
    this.touchSoftPresence();
    this.broadcast({ type: 'meeting.started', meeting_id: id }, 'owner');
    this.broadcastWaitingCount(id);
    return {
      id,
      livekitRoom,
      startedAt: now,
      hostLeaseExpiresAt: now + HOST_LEASE_MILLISECONDS,
      hostIdentity: identity,
      pendingHostIdentity: null,
      hostOfferIdentity: null,
      chairIdentity: identity,
      pendingChairIdentity: null,
    };
  }

  /**
   * One row per owner *device*, keyed on the identity that device publishes
   * under. `email` stays the account address on every one of them, which is
   * what keeps the meeting record addressed to a person rather than to a phone.
   */
  private recordOwnerParticipant(
    meetingId: string,
    identity: string,
    owner: { email: string; name: string },
    now: number,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO participants (meeting_id, identity, name, email, transcript_opt_in, role, updated_at)
       VALUES (?, ?, ?, ?, 0, 'owner', ?)
       ON CONFLICT (meeting_id, identity) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
      meetingId,
      identity,
      owner.name,
      owner.email,
      now,
    );
  }

  async lobbySnapshot(ownerSub: string): Promise<LobbySnapshot> {
    this.assertOwnerOrHostMember(ownerSub);
    const meeting = this.openMeeting();
    // A brief host-lease gap used to park knocks on __prelive__ while a meeting
    // was already open — reclaim them whenever the owner looks at the queue.
    if (meeting) this.attachPreliveWaitingToMeeting(meeting.id);
    const meetingId = meeting?.id ?? PRELIVE_MEETING_ID;
    const requests = this.ctx.storage.sql.exec<JoinRow>(
      `SELECT id, meeting_id, name, email, identity, status, created_at, lobby_token_hash, booking_token,
              client_app, client_device, on_behalf_of, recording, registered
       FROM join_requests WHERE meeting_id = ? ORDER BY created_at ASC`,
      meetingId,
    ).toArray().map(joinRowToPublic);
    const session = meeting ? this.sessionRow(meeting.id) : undefined;
    return {
      meeting: meeting
        ? { ...meetingConnection(meeting), ...(session ? { session_door_open: session.door_closed !== 1 } : {}) }
        : null,
      requests,
      lurkers: this.liveLurkers(),
      room_settings: { refuse_recorders: this.requiredRoom().refuse_recorders === 1 },
    };
  }

  async setRoomSettings(ownerSub: string, settings: RoomSettings): Promise<RoomSettings> {
    this.assertOwner(ownerSub);
    this.ctx.storage.sql.exec('UPDATE room SET refuse_recorders = ? WHERE slug = ?', settings.refuse_recorders ? 1 : 0, this.requiredRoom().slug);
    return settings;
  }

  /**
   * Presence read for the team roster. No owner check — the Worker has already
   * authenticated an Envisioning member, and this is Envisioning-only by route.
   * Never widen it to guests: online/offline is not visitor-facing.
   */
  async presenceSnapshot(slug: string): Promise<RoomPresenceSnapshot | null> {
    const room = this.room();
    if (!room) return null;

    const open = this.openMeeting();
    const participants = open
      ? this.ctx.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM participants WHERE meeting_id = ?',
        open.id,
      ).one().count
      : 0;
    const hostSeenAt = Math.max(Number(room.host_seen_at ?? 0), Number(open?.host_seen_at ?? 0));
    const memberEmails = open
      ? this.ctx.storage.sql.exec<{ email: string | null }>(
        'SELECT email FROM participants WHERE meeting_id = ?',
        open.id,
      ).toArray()
        .map((row) => row.email?.trim().toLowerCase() ?? '')
        .filter((email) => email.length > 0 && isMemberEmail(this.env, email))
      : [];

    return {
      slug,
      owner_email: room.owner_email,
      owner_sub: room.owner_sub,
      in_session: Boolean(open),
      participants,
      member_emails: [...new Set(memberEmails)],
      // `openMeeting()` has already swept an abandoned meeting, so an open one
      // plus a live lease is the same "their Mac is there" the lobby trusts.
      host_present: this.softPresenceIsActive() || this.hostLeaseIsActive(open),
      host_seen_at: hostSeenAt > 0 ? hostSeenAt : null,
    };
  }

  /**
   * Account-admin read of this room. No owner check — the Worker has already
   * authenticated an Envisioning member. Returns metadata only: titles yes,
   * guest emails / transcript / summary text never leave this method.
   */
  async adminSnapshot(slug: string): Promise<AdminRoomSnapshot> {
    const room = this.room();
    if (!room) {
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

    const open = this.openMeeting();
    const participants = open
      ? this.ctx.storage.sql.exec<{ count: number }>(
        'SELECT COUNT(*) AS count FROM participants WHERE meeting_id = ?',
        open.id,
      ).one().count
      : 0;
    const waitingNow = this.waitingCount(open?.id ?? PRELIVE_MEETING_ID);

    // A meeting whose host has been gone past the stale window is over,
    // whether or not anything read it since: `openMeeting` above closes the
    // newest; this closes the rest, so none reads as "live" in Admin.
    this.closeStaleMeetings();

    const meetingRows = this.ctx.storage.sql.exec<{
      id: string;
      started_at: number;
      ended_at: number | null;
      title: string | null;
      meeting_kind: string | null;
      has_summary: number;
    }>(
      `SELECT id, started_at, ended_at, title, meeting_kind,
              CASE WHEN summary IS NOT NULL AND length(summary) > 0 THEN 1 ELSE 0 END AS has_summary
       FROM meetings WHERE status != 'discarded' ORDER BY started_at DESC LIMIT 500`,
    ).toArray();

    const participantCounts = new Map<string, { participant_count: number; guest_count: number }>();
    for (const row of this.ctx.storage.sql.exec<{
      meeting_id: string;
      participant_count: number;
      guest_count: number;
    }>(
      `SELECT meeting_id,
              COUNT(*) AS participant_count,
              SUM(CASE WHEN role = 'guest' THEN 1 ELSE 0 END) AS guest_count
       FROM participants GROUP BY meeting_id`,
    ).toArray()) {
      participantCounts.set(row.meeting_id, {
        participant_count: row.participant_count,
        guest_count: row.guest_count,
      });
    }

    const guestDomains = new Map<string, string[]>();
    for (const row of this.ctx.storage.sql.exec<{ meeting_id: string; email: string }>(
      `SELECT meeting_id, email FROM participants WHERE role = 'guest' AND email != ''`,
    ).toArray()) {
      const domain = emailDomain(row.email);
      if (!domain) continue;
      const list = guestDomains.get(row.meeting_id) ?? [];
      if (!list.includes(domain)) list.push(domain);
      guestDomains.set(row.meeting_id, list);
    }

    const booked = new Set(
      this.ctx.storage.sql.exec<{ meeting_id: string }>(
        `SELECT DISTINCT meeting_id FROM join_requests
         WHERE booking_token IS NOT NULL AND booking_token != ''`,
      ).toArray().map((row) => row.meeting_id),
    );

    const quality = new Map<string, { seconds: number; worst: string | null; poor: number; reconnects: number }>();
    let poorQualityParticipants = 0;
    let reconnects = 0;
    for (const row of this.ctx.storage.sql.exec<{
      meeting_id: string;
      connected_ms: number;
      poor_ms: number;
      reconnect_count: number;
      worst_quality: string;
    }>(
      `SELECT meeting_id, connected_ms, poor_ms, reconnect_count, worst_quality FROM meeting_quality`,
    ).toArray()) {
      const current = quality.get(row.meeting_id) ?? { seconds: 0, worst: null as string | null, poor: 0, reconnects: 0 };
      current.seconds += Math.max(0, row.connected_ms) / 1000;
      current.poor += row.poor_ms;
      current.reconnects += row.reconnect_count;
      current.worst = worseQuality(current.worst, row.worst_quality);
      quality.set(row.meeting_id, current);
      if (row.poor_ms >= 60_000 || row.reconnect_count > 0) poorQualityParticipants += 1;
      reconnects += row.reconnect_count;
    }

    const meetings: AdminMeetingRecord[] = meetingRows.map((row) => {
      const counts = participantCounts.get(row.id) ?? { participant_count: 0, guest_count: 0 };
      const endedAt = row.ended_at;
      const duration = endedAt != null ? Math.max(0, endedAt - row.started_at) : null;
      return {
        meeting_id: row.id,
        room_slug: room.slug,
        host_email: room.owner_email,
        title: row.title,
        started_at: row.started_at,
        ended_at: endedAt,
        duration_ms: duration,
        participant_count: counts.participant_count,
        guest_count: counts.guest_count,
        guest_domains: guestDomains.get(row.id) ?? [],
        was_booked: booked.has(row.id),
        meeting_kind: row.meeting_kind,
        worst_quality: quality.get(row.id)?.worst ?? null,
        summary_generated: row.has_summary === 1,
        crm_synced: false,
        client_seconds: Math.round(quality.get(row.id)?.seconds ?? 0),
      };
    });

    const funnelCounts = { knocks: 0, admitted: 0, rejected: 0, joined: 0 };
    const byClient: Record<string, number> = {};
    for (const row of this.ctx.storage.sql.exec<{ status: string; client_app: string | null; n: number }>(
      `SELECT status, client_app, COUNT(*) AS n FROM join_requests GROUP BY status, client_app`,
    ).toArray()) {
      funnelCounts.knocks += row.n;
      if (row.status === 'admitted' || row.status === 'joined') funnelCounts.admitted += row.n;
      if (row.status === 'rejected') funnelCounts.rejected += row.n;
      if (row.status === 'joined') funnelCounts.joined += row.n;
      const client = row.client_app || 'unknown';
      byClient[client] = (byClient[client] ?? 0) + row.n;
    }

    const byCountry: Record<string, number> = {};
    for (const lurker of this.liveLurkers()) {
      const country = lurker.country?.trim();
      if (!country) continue;
      byCountry[country] = (byCountry[country] ?? 0) + 1;
    }

    return {
      slug: room.slug,
      host_email: room.owner_email,
      live: {
        in_session: Boolean(open),
        participants,
        waiting: waitingNow,
      },
      meetings,
      funnel: { ...funnelCounts, by_client: byClient, by_country: byCountry },
      poor_quality_participants: poorQualityParticipants,
      reconnects,
    };
  }

  /**
   * One meeting in the shape the account ledger stores.
   *
   * `adminSnapshot` computes the same record, but for up to 500 meetings at
   * once — far too much to move across the wire every time a single meeting
   * finishes. This is that query scoped to one id, for the completion write in
   * `artifacts.ts`.
   */
  async meetingLedgerRecord(meetingId: string): Promise<AdminMeetingRecord | null> {
    const room = this.room();
    if (!room) return null;

    const row = this.ctx.storage.sql.exec<{
      id: string;
      started_at: number;
      ended_at: number | null;
      title: string | null;
      meeting_kind: string | null;
      has_summary: number;
    }>(
      `SELECT id, started_at, ended_at, title, meeting_kind,
              CASE WHEN summary IS NOT NULL AND length(summary) > 0 THEN 1 ELSE 0 END AS has_summary
       FROM meetings WHERE id = ?`,
      meetingId,
    ).toArray()[0];
    if (!row) return null;

    const counts = this.ctx.storage.sql.exec<{ participant_count: number; guest_count: number }>(
      `SELECT COUNT(*) AS participant_count,
              SUM(CASE WHEN role = 'guest' THEN 1 ELSE 0 END) AS guest_count
       FROM participants WHERE meeting_id = ?`,
      meetingId,
    ).one();

    const guestDomains: string[] = [];
    for (const guest of this.ctx.storage.sql.exec<{ email: string }>(
      `SELECT email FROM participants WHERE meeting_id = ? AND role = 'guest' AND email != ''`,
      meetingId,
    ).toArray()) {
      const domain = emailDomain(guest.email);
      if (domain && !guestDomains.includes(domain)) guestDomains.push(domain);
    }

    const booked = this.ctx.storage.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM join_requests
       WHERE meeting_id = ? AND booking_token IS NOT NULL AND booking_token != ''`,
      meetingId,
    ).one().n > 0;

    let seconds = 0;
    let worst: string | null = null;
    for (const quality of this.ctx.storage.sql.exec<{ connected_ms: number; worst_quality: string }>(
      'SELECT connected_ms, worst_quality FROM meeting_quality WHERE meeting_id = ?',
      meetingId,
    ).toArray()) {
      seconds += Math.max(0, quality.connected_ms) / 1000;
      worst = worseQuality(worst, quality.worst_quality);
    }

    return {
      meeting_id: row.id,
      room_slug: room.slug,
      host_email: room.owner_email,
      title: row.title,
      started_at: row.started_at,
      ended_at: row.ended_at,
      duration_ms: row.ended_at == null ? null : Math.max(0, row.ended_at - row.started_at),
      participant_count: counts.participant_count,
      guest_count: counts.guest_count,
      guest_domains: guestDomains,
      was_booked: booked,
      meeting_kind: row.meeting_kind,
      worst_quality: worst,
      summary_generated: row.has_summary === 1,
      crm_synced: false,
      client_seconds: Math.round(seconds),
    };
  }

  /**
   * Pre-knock presence from the browser join page. Does not require host soft
   * presence — the Mac picks lurkers up on the next lobby poll once online.
   */
  async upsertGuestPresence(input: GuestPresenceUpsert): Promise<void> {
    this.assertRoomActive();
    this.pruneStaleLurkers();
    // The host closed this tab's connection — stay off the page until the
    // cooldown lifts rather than reappearing on the next heartbeat.
    if (this.presenceIsBlocked(input.presenceId)) return;
    const recent = this.ctx.storage.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM guest_presence WHERE created_at >= ?',
      Date.now() - 60_000,
    ).one().count;
    // Cap new tabs, not heartbeats of existing ids (upsert below).
    const existing = this.ctx.storage.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM guest_presence WHERE id = ?',
      input.presenceId,
    ).one().count;
    if (existing === 0 && recent >= ROOM_NEW_VISITORS_PER_MINUTE) {
      throw new RoomError('This room is receiving too many visitors. Try again shortly.', 429, 'rate_limited');
    }
    const now = Date.now();
    const name = input.name?.trim() ? input.name.trim().slice(0, 80) : null;
    const city = input.city?.trim() ? input.city.trim().slice(0, 80) : null;
    const country = input.country?.trim() ? input.country.trim().slice(0, 8) : null;
    this.ctx.storage.sql.exec(
      `INSERT INTO guest_presence (id, stage, name, city, country, client_app, client_device, seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         stage = excluded.stage,
         name = COALESCE(excluded.name, guest_presence.name),
         city = COALESCE(excluded.city, guest_presence.city),
         country = COALESCE(excluded.country, guest_presence.country),
         client_app = COALESCE(excluded.client_app, guest_presence.client_app),
         client_device = COALESCE(excluded.client_device, guest_presence.client_device),
         seen_at = excluded.seen_at`,
      input.presenceId,
      input.stage,
      name,
      city,
      country,
      input.client?.app ?? null,
      input.client?.device ?? null,
      now,
      now,
    );
    // Deliberately not a column: the host needs to *know* a visitor arrived on
    // a booking link, not to have that link recorded. Every heartbeat re-sends
    // it (~15s), so this rebuilds itself if the DO is evicted, and it leaves with
    // the object rather than outliving the visit on disk.
    const bookingToken = input.bookingToken?.trim().slice(0, 128);
    if (bookingToken) this.guestPresenceTokens.set(input.presenceId, bookingToken);
    this.broadcast({ type: 'lobby.lurkers', lurkers: this.liveLurkers() }, 'owner');
  }

  async clearGuestPresence(presenceId: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM guest_presence WHERE id = ?', presenceId);
    this.guestPresenceTokens.delete(presenceId);
  }

  /**
   * Host says "get this person off my waiting page." A lurker has no live
   * socket the way a knocked-in guest does (their websocket only opens after
   * a join request exists), so there is nothing to push a "removed" message
   * down — this deletes the row now and refuses their heartbeats and knocks
   * for a cooldown, which is as close as pre-knock presence gets to closing
   * a connection.
   */
  async removeGuestPresence(ownerSub: string, presenceId: string): Promise<void> {
    this.assertOwnerOrHostMember(ownerSub);
    this.ctx.storage.sql.exec('DELETE FROM guest_presence WHERE id = ?', presenceId);
    this.guestPresenceTokens.delete(presenceId);
    this.ctx.storage.sql.exec(
      `INSERT INTO blocked_presence (id, blocked_until) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET blocked_until = excluded.blocked_until`,
      presenceId,
      Date.now() + PRESENCE_BLOCK_MILLISECONDS,
    );
    this.broadcast({ type: 'lobby.lurkers', lurkers: this.liveLurkers() }, 'owner');
  }

  private pruneExpiredPresenceBlocks(): void {
    this.ctx.storage.sql.exec('DELETE FROM blocked_presence WHERE blocked_until < ?', Date.now());
  }

  private presenceIsBlocked(presenceId: string): boolean {
    this.pruneExpiredPresenceBlocks();
    return this.ctx.storage.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM blocked_presence WHERE id = ? AND blocked_until >= ?',
      presenceId,
      Date.now(),
    ).one().count > 0;
  }

  /**
   * `memberEmail` is set when the knocker carried a verified Envisioning
   * session. Those knocks are admitted on arrival instead of queued — see
   * `memberAdmission` for the conditions, which are the same ones `decide`
   * enforces for a hand-pressed Admit.
   */
  async requestJoin(
    input: JoinRequestInput,
    memberEmail: string | null = null,
    verifiedOnBehalfOf: string | null = null,
  ): Promise<JoinRequestReceipt> {
    this.assertRoomActive();
    const meeting = this.openMeeting();
    // Reachability: live lease on the open meeting, or soft presence on the clock.
    // Attachment: always the open meeting when one exists — never __prelive__ while
    // a meeting is open, or the host lobby (which keys off meeting.id) stays empty.
    const reachable = (meeting && this.hostLeaseIsActive(meeting)) || this.softPresenceIsActive();
    if (!reachable) {
      // Neutral copy — do not reveal whether the host is online.
      throw new RoomError('Couldn’t reach this room right now — try again shortly.', 409, 'rate_limited');
    }
    // Same tab the host just closed the connection on: same neutral copy as
    // above, so a blocked visitor learns nothing beyond "try later".
    if (input.presence_id && this.presenceIsBlocked(input.presence_id)) {
      throw new RoomError('Couldn’t reach this room right now — try again shortly.', 409, 'rate_limited');
    }
    const recording = input.recording === true;
    if (recording && this.requiredRoom().refuse_recorders === 1) {
      throw new RoomError('This room does not admit recording notetakers.', 403, 'recorders_refused');
    }
    const meetingId = meeting?.id ?? PRELIVE_MEETING_ID;
    const recent = this.ctx.storage.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM join_requests WHERE created_at >= ?',
      Date.now() - 60_000,
    ).one().count;
    if (recent >= ROOM_KNOCKS_PER_MINUTE) throw new RoomError('This room is receiving too many join requests. Try again shortly.', 429, 'rate_limited');
    const lobbyToken = randomToken();
    const lobbyTokenHash = await sha256(lobbyToken);
    // Hashed here, so no await sits between the admission checks below and
    // the row they write.
    const bookingTokenText = input.booking_token?.trim();
    const registrationHash = !recording && bookingTokenText ? await sha256Hex(bookingTokenText) : null;
    const id = crypto.randomUUID();
    // LiveKit identities appear in ordinary SFU diagnostics. Keep them opaque;
    // participant details stay in the control-plane room record instead.
    const identity = `guest:${randomToken(12)}`;
    const now = Date.now();
    const bookingToken = input.booking_token?.trim() || null;
    // Notetakers always wait for an explicit owner decision, including when
    // the caller happens to carry a signed-in member session. The owner must
    // attribute the recorder before it receives room credentials.
    const memberIn = !recording && this.memberAdmission(memberEmail, meeting);
    const registered = !memberIn && registrationHash !== null && meeting !== undefined
      && this.registeredAdmission(meeting, registrationHash, now);
    const status: LobbyRequest['status'] = memberIn || registered ? 'admitted' : 'waiting';
    const email = recording ? '' : (input.email ?? '');
    this.ctx.storage.sql.exec(
      `INSERT INTO join_requests
       (id, meeting_id, name, email, transcript_opt_in, identity, lobby_token_hash, status, created_at,
        booking_token, client_app, client_device, on_behalf_of, recording, decided_at, registered)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      meetingId,
      input.name,
      email,
      0,
      identity,
      lobbyTokenHash,
      status,
      now,
      bookingToken,
      input.client?.app ?? null,
      input.client?.device ?? null,
      recording ? verifiedOnBehalfOf : null,
      recording ? 1 : 0,
      status === 'admitted' ? now : null,
      registered ? 1 : 0,
    );
    if (input.presence_id) {
      this.ctx.storage.sql.exec('DELETE FROM guest_presence WHERE id = ?', input.presence_id);
    }
    const request = joinRowToPublic({
      id,
      meeting_id: meetingId,
      name: input.name,
      email,
      identity,
      lobby_token_hash: lobbyTokenHash,
      status,
      created_at: now,
      booking_token: bookingToken,
      client_app: input.client?.app ?? null,
      client_device: input.client?.device ?? null,
      on_behalf_of: recording ? verifiedOnBehalfOf : null,
      recording: recording ? 1 : 0,
    });
    // The host still sees the arrival either way — an admitted colleague walks
    // in, they are not invisible.
    this.broadcast({ type: 'lobby.requested', request }, 'owner');
    if (status === 'admitted') {
      this.broadcast({ type: 'lobby.decided', request }, 'owner');
      this.broadcast({ type: 'lobby.status', request_id: id, status }, 'guest', id);
    }
    this.broadcast({ type: 'lobby.lurkers', lurkers: this.liveLurkers() }, 'owner');
    const waitingCount = this.waitingCount(meetingId);
    this.broadcastWaitingCount(meetingId, waitingCount);
    return { requestId: id, lobbyToken, status, waitingCount };
  }

  /**
   * Whether this knock walks straight in. Deliberately narrow:
   *
   * - only a verified Envisioning member (the router proved the session),
   * - only into a meeting that is actually running with a live host lease,
   * - and only inside the same capacity ceiling `decide` enforces.
   *
   * The idle case is left alone on purpose. Somebody sitting on their launch
   * screen has not opened a door, and a colleague materialising in a room the
   * host never started is the one behaviour nobody asked for.
   */
  private memberAdmission(memberEmail: string | null, meeting: MeetingRow | undefined): boolean {
    if (!memberEmail || !isMemberEmail(this.env, memberEmail)) return false;
    if (!meeting || meeting.ended_at !== null) return false;
    if (!this.hostLeaseIsActive(meeting)) return false;
    // Walking straight back in is what auto-admission is for, and exactly what
    // a removal was for. Once removed from this meeting a member knocks like
    // anyone else, and the host decides a second time.
    const removed = this.ctx.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM join_requests
       WHERE meeting_id = ? AND status = 'removed' AND lower(email) = lower(?)`,
      meeting.id,
      memberEmail,
    ).one().count;
    if (removed > 0) return false;
    return this.hasGuestCapacity(meeting.id);
  }

  /** The room's one capacity guard: fewer than 99 guests let in (AGENTS.md invariant 15). */
  private hasGuestCapacity(meetingId: string): boolean {
    const admitted = this.ctx.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM join_requests
       WHERE meeting_id = ? AND status IN ('admitted', 'joined')`,
      meetingId,
    ).one().count;
    return admitted < GUEST_CAPACITY;
  }

  /**
   * The second door (docs/SESSIONS.md §7): a knock with an event registration
   * token is admitted without a host click when all five hold. 1: a session is
   * armed on the open meeting and the host has not closed the door. 2: now is
   * inside [start − 15 min, end + 15 min]. 3: the token's SHA-256 is on the
   * roster. 4: that token let somebody in fewer than 3 times this meeting.
   * 5: the capacity guard. A live host lease is required too, as for every
   * admission. Anything else knocks as before; a miss is never an error.
   */
  private registeredAdmission(meeting: MeetingRow, tokenHash: string, now: number): boolean {
    const session = this.sessionRow(meeting.id);
    if (!session || session.door_closed === 1) return false;
    if (!this.hostLeaseIsActive(meeting)) return false;
    if (now < session.starts_at - SESSION_WINDOW_MARGIN_MS || now > session.ends_at + SESSION_WINDOW_MARGIN_MS) return false;
    const entry = this.ctx.storage.sql.exec<{ admits: number }>(
      'SELECT admits FROM meeting_session_roster WHERE meeting_id = ? AND token_hash = ?',
      meeting.id,
      tokenHash,
    ).toArray()[0];
    if (!entry || entry.admits >= SESSION_TOKEN_ADMITS) return false;
    if (!this.hasGuestCapacity(meeting.id)) return false;
    this.ctx.storage.sql.exec(
      'UPDATE meeting_session_roster SET admits = admits + 1 WHERE meeting_id = ? AND token_hash = ?',
      meeting.id,
      tokenHash,
    );
    return true;
  }

  async joinStatus(requestId: string, lobbyToken: string): Promise<JoinStatus> {
    const request = await this.authenticatedJoinRequest(requestId, lobbyToken);
    const reachable = request.meeting_id === PRELIVE_MEETING_ID
      ? this.softPresenceIsActive() || this.hostLeaseIsActive(this.openMeeting())
      : this.hostLeaseIsActive(this.meeting(request.meeting_id));
    // Only waiting knocks ever expire, and only after the grace window — an
    // admitted guest's status must survive a transient host-lease lapse
    // (exchange still enforces the live lease at the moment it matters).
    if (!reachable && request.status === 'waiting'
      && Date.now() - this.hostLastSeenAt(request) > KNOCK_EXPIRY_GRACE_MILLISECONDS) {
      this.ctx.storage.sql.exec(
        "UPDATE join_requests SET status = 'expired' WHERE id = ? AND status = 'waiting'",
        requestId,
      );
      this.broadcastWaitingCount(request.meeting_id);
      return { status: 'expired', waitingCount: this.waitingCount(request.meeting_id) };
    }
    return {
      status: request.status,
      waitingCount: this.waitingCount(request.meeting_id),
      ...(this.sessionOf(request.meeting_id) ? { session: true } : {}),
    };
  }

  /** Soft host presence while idle on the clock — does not start a meeting. */
  async touchPresence(ownerSub: string): Promise<void> {
    this.assertOwner(ownerSub);
    this.assertRoomActive();
    this.touchSoftPresence();
  }

  /**
   * Only the device that holds the host renews the lease. A device the host
   * was recorded with is matched by its signed install id; a host recorded
   * with none (the web, a build before per-device identity) is matched by its
   * identity, so another member's session without an install id cannot renew it.
   */
  async heartbeat(
    ownerSub: string,
    meetingId: string,
    deviceID: string | null = null,
    identity: string | null = null,
  ): Promise<number> {
    this.assertOwnerOrHostMember(ownerSub);
    const meeting = this.meeting(meetingId);
    if (!meeting || meeting.ended_at !== null) throw new RoomError('Meeting is no longer active.', 410, 'meeting_inactive');
    // Past the stale window the meeting is over, whether or not a read has
    // swept it yet (`openMeeting`). Without this a heartbeat that arrived
    // before the sweep renewed the lease and reopened the meeting to the
    // guests the stale window had already refused.
    if (Date.now() - meeting.host_seen_at > STALE_MEETING_MILLISECONDS) {
      this.closeAbandonedMeeting(meeting.id);
      throw new RoomError('Meeting is no longer active.', 410, 'meeting_inactive');
    }
    if (meeting.chair_released_at !== null || !holdsHost(this.env, meeting, deviceID, identity)) {
      throw new RoomError('This device is not the host.', 409, 'host_not_active');
    }
    const now = Date.now();
    this.ctx.storage.sql.exec('UPDATE meetings SET host_seen_at = ? WHERE id = ?', now, meetingId);
    this.touchSoftPresence();
    this.attachPreliveWaitingToMeeting(meetingId);
    return now + HOST_LEASE_MILLISECONDS;
  }

  /** Current host state for one live meeting, after the route's room gate. */
  async hostState(ownerSub: string, meetingId: string): Promise<MeetingConnection & { hostReleased: boolean }> {
    this.assertOwnerOrHostMember(ownerSub);
    const meeting = this.meeting(meetingId);
    if (!meeting || meeting.ended_at !== null) throw new RoomError('Meeting is no longer active.', 410, 'meeting_inactive');
    return { ...meetingConnection(meeting), hostReleased: meeting.chair_released_at !== null };
  }

  /**
   * Claiming is a serialized room mutation. The route read the host and the
   * SFU roster before this call; `expected` is the host it read, and the
   * claim is refused if another claim moved the host in between, so two
   * devices never both come back `host`. If the current host is still in
   * LiveKit, ask it to stop first; if it has left, transfer now and renew the
   * 30-second lease. `ifVacant` takes the host only when nobody holds it.
   */
  async claimHost(
    ownerSub: string,
    meetingId: string,
    claim: {
      deviceID: string;
      identity: string;
      expected: string | null;
      currentConnected: boolean;
      pendingConnected: boolean;
      ifVacant: boolean;
    },
  ): Promise<{ status: 'host' | 'release_requested'; hostIdentity: string | null; pendingIdentity: string | null; hostLeaseExpiresAt: number }> {
    this.assertOwnerOrHostMember(ownerSub);
    const { deviceID, identity } = claim;
    if (!deviceID || !identity) throw new RoomError('A signed-in device is required to take the host.', 409, 'host_not_active');
    const meeting = this.meeting(meetingId);
    if (!meeting || meeting.ended_at !== null) throw new RoomError('Meeting is no longer active.', 410, 'meeting_inactive');
    const now = Date.now();
    if (meeting.chair_identity === identity && meeting.chair_device_id === deviceID) {
      this.ctx.storage.sql.exec('UPDATE meetings SET host_seen_at = ? WHERE id = ?', now, meetingId);
      return { status: 'host', hostIdentity: identity, pendingIdentity: null, hostLeaseExpiresAt: now + HOST_LEASE_MILLISECONDS };
    }
    if (meeting.chair_identity !== claim.expected) {
      throw new RoomError('The host just changed. Try again.', 409, 'host_not_active');
    }
    const vacant = meeting.chair_released_at !== null || !meeting.chair_identity || !claim.currentConnected;
    if (claim.ifVacant && !vacant) {
      throw new RoomError('Another device is the host.', 409, 'host_not_active');
    }
    if (vacant) {
      this.ctx.storage.sql.exec(
        `UPDATE meetings SET chair_device_id = ?, chair_identity = ?, pending_chair_device_id = NULL,
          pending_chair_identity = NULL, host_seen_at = ?, chair_released_at = NULL,
          host_offer_identity = NULL, host_offer_email = NULL, host_offer_at = NULL WHERE id = ?`,
        deviceID, identity, now, meetingId,
      );
      return { status: 'host', hostIdentity: identity, pendingIdentity: null, hostLeaseExpiresAt: now + HOST_LEASE_MILLISECONDS };
    }
    // A request whose device has left the call is abandoned, not in the way.
    if (meeting.pending_chair_identity && meeting.pending_chair_identity !== identity && claim.pendingConnected) {
      throw new RoomError('Another device is already asking to be the host.', 409, 'host_not_active');
    }
    this.ctx.storage.sql.exec(
      'UPDATE meetings SET pending_chair_device_id = ?, pending_chair_identity = ? WHERE id = ?',
      deviceID, identity, meetingId,
    );
    return {
      status: 'release_requested',
      hostIdentity: meeting.chair_identity,
      pendingIdentity: identity,
      hostLeaseExpiresAt: meeting.host_seen_at + HOST_LEASE_MILLISECONDS,
    };
  }

  /**
   * Stop being the host, after this device's microphone and transcriber have
   * drained. With a pending request whose device is still in the call, the
   * host moves to it. With one whose device has left, the request is dropped
   * and this device stays the host: a handover to nobody would end the
   * transcript and, ten minutes later, the meeting. With no request (Leave),
   * the host is released for a companion to claim.
   */
  async releaseHost(
    ownerSub: string,
    meetingId: string,
    deviceID: string | null,
    identity: string,
    targetConnected: boolean,
  ): Promise<MeetingConnection> {
    this.assertOwnerOrHostMember(ownerSub);
    const meeting = this.meeting(meetingId);
    if (!meeting || meeting.ended_at !== null) throw new RoomError('Meeting is no longer active.', 410, 'meeting_inactive');
    if (!deviceID || meeting.chair_identity === null || !holdsHost(this.env, meeting, deviceID, identity)) {
      throw new RoomError('This device is not the host.', 409, 'host_not_active');
    }
    const now = Date.now();
    if (meeting.pending_chair_identity && targetConnected) {
      this.ctx.storage.sql.exec(
        `UPDATE meetings SET chair_device_id = pending_chair_device_id, chair_identity = pending_chair_identity,
          pending_chair_device_id = NULL, pending_chair_identity = NULL, host_seen_at = ?,
          chair_released_at = NULL WHERE id = ?`,
        now, meetingId,
      );
    } else if (meeting.pending_chair_identity) {
      this.ctx.storage.sql.exec(
        'UPDATE meetings SET pending_chair_device_id = NULL, pending_chair_identity = NULL, host_seen_at = ? WHERE id = ?',
        now, meetingId,
      );
    } else {
      this.ctx.storage.sql.exec(
        `UPDATE meetings SET chair_device_id = NULL, chair_identity = NULL,
          pending_chair_device_id = NULL, pending_chair_identity = NULL, chair_released_at = ? WHERE id = ?`,
        now, meetingId,
      );
    }
    const updated = this.meeting(meetingId);
    if (!updated) throw new RoomError('Meeting is no longer active.', 410, 'meeting_inactive');
    return meetingConnection(updated);
  }

  async decide(
    ownerSub: string,
    requestId: string,
    admit: boolean,
    onBehalfOf?: string | null,
  ): Promise<LobbyRequest> {
    this.assertOwnerOrHostMember(ownerSub);
    const request = this.joinRequest(requestId);
    if (!request) throw new RoomError('Join request not found.', 404, 'request_not_found');
    const resolvedOnBehalfOf = onBehalfOf === undefined ? request.on_behalf_of : onBehalfOf;
    if (admit && request.recording === 1 && !resolvedOnBehalfOf) {
      throw new RoomError('Choose the person who sent this notetaker before admitting it.', 400, 'notetaker_sender_required');
    }
    if (request.status !== 'waiting') throw new RoomError('Join request has already been decided.', 409, 'request_already_decided');
    if (admit) {
      if (request.meeting_id === PRELIVE_MEETING_ID) {
        throw new RoomError('Start the room before admitting guests.', 409, 'room_not_started');
      }
      const meeting = this.meeting(request.meeting_id);
      if (!meeting || meeting.ended_at !== null) {
        throw new RoomError('Meeting is no longer active.', 410, 'meeting_inactive');
      }
      // A stale signed-in client may still see the queue. Only a host actively
      // renewing the 30-second lease may grant a credential-bearing admission.
      this.assertHostLease(meeting);
      if (!this.hasGuestCapacity(request.meeting_id)) throw new RoomError('This meeting has reached its 100-person limit.', 409, 'capacity_reached');
    }
    const status: LobbyRequest['status'] = admit ? 'admitted' : 'rejected';
    if (onBehalfOf !== undefined) {
      this.ctx.storage.sql.exec(
        'UPDATE join_requests SET status = ?, on_behalf_of = ?, decided_at = ? WHERE id = ?',
        status,
        onBehalfOf,
        Date.now(),
        requestId,
      );
    } else {
      this.ctx.storage.sql.exec(
        'UPDATE join_requests SET status = ?, decided_at = ? WHERE id = ?',
        status,
        Date.now(),
        requestId,
      );
    }
    const updated = { ...joinRowToPublic(request), status, ...(onBehalfOf !== undefined ? { on_behalf_of: onBehalfOf } : {}) };
    this.broadcast({ type: 'lobby.decided', request: updated }, 'owner');
    this.broadcast({ type: 'lobby.status', request_id: requestId, status }, 'guest', requestId);
    this.broadcastWaitingCount(request.meeting_id);
    return updated;
  }

  async exchangeAdmission(requestId: string, lobbyToken: string): Promise<JoinExchange> {
    const request = await this.authenticatedJoinRequest(requestId, lobbyToken);
    // A removed guest still holds perfectly valid lobby credentials — this is
    // the check that stops a reconnect from undoing the removal — and deserves
    // to be told what happened rather than that they were never admitted.
    if (request.status === 'removed') {
      throw new RoomError('The owner removed you from this meeting.', 403, 'guest_removed');
    }
    if (request.status !== 'admitted' && request.status !== 'joined') {
      throw new RoomError('The owner has not admitted this request.', 403, 'guest_not_admitted');
    }
    const meeting = this.meeting(request.meeting_id);
    if (!meeting) throw new RoomError('This meeting has ended.', 410, 'meeting_ended');
    // A finalized meeting is over for good: without this a guest whose socket
    // dropped during shutdown would re-enter a room the owner already closed.
    if (meeting.ended_at !== null) throw new RoomError('This meeting has ended.', 410, 'meeting_ended');
    // The first credential needs a live host: that is what keeps a crashed Mac
    // from leaving a ghost-joinable room. A guest who already joined once is a
    // reconnect — page reload, network blip — and was let in while the host
    // was there, so the door stays open for them through a lease lapse until
    // the stale sweep ends the meeting. New knocks still queue meanwhile.
    if (request.status === 'joined') {
      this.assertMeetingNotStale(meeting);
    } else {
      this.assertHostLease(meeting);
    }
    const isFirstJoin = request.status !== 'joined';
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE join_requests SET status = 'joined', joined_at = COALESCE(joined_at, ?) WHERE id = ?`,
      now,
      requestId,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO participants (meeting_id, identity, name, email, transcript_opt_in, role, updated_at)
       VALUES (?, ?, ?, ?, 0, 'guest', ?)
       ON CONFLICT(meeting_id, identity) DO UPDATE SET
         name = excluded.name, email = excluded.email, updated_at = excluded.updated_at`,
      request.meeting_id,
      request.identity,
      request.name,
      request.email,
      now,
    );
    if (isFirstJoin && request.recording === 1) this.appendRecorderConsent(request, meeting, now);
    return {
      meetingId: meeting.id,
      livekitRoom: meeting.livekit_room,
      startedAt: meeting.started_at,
      identity: request.identity,
      name: request.name,
      email: request.email,
      client: clientFromColumns(request.client_app, request.client_device),
      on_behalf_of: request.on_behalf_of,
      recording: request.recording === 1,
      session: this.sessionOf(meeting.id) !== undefined,
      registered: request.registered === 1,
    };
  }

  /**
   * Upsert this participant's cumulative call quality. Clients flush
   * periodically and once on leave; because every counter is cumulative rather
   * than incremental, a replayed or duplicated flush is harmless and a client
   * that dies mid-meeting still leaves its last good sample behind.
   */
  async recordQuality(
    meetingId: string,
    identity: string,
    role: 'owner' | 'guest',
    report: QualityReport,
  ): Promise<void> {
    const meeting = this.meeting(meetingId);
    if (!meeting) throw new RoomError('Meeting not found.', 404, 'meeting_not_found');
    if (meeting.ended_at !== null && Date.now() - meeting.ended_at > ENDED_QUALITY_GRACE_MILLISECONDS) {
      throw new RoomError('This meeting has ended.', 410, 'meeting_ended');
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO meeting_quality
       (meeting_id, identity, client, role, connected_ms, excellent_ms, good_ms, poor_ms, lost_ms,
        reconnect_count, worst_quality, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(meeting_id, identity) DO UPDATE SET
         client = excluded.client, role = excluded.role,
         connected_ms = excluded.connected_ms, excellent_ms = excluded.excellent_ms,
         good_ms = excluded.good_ms, poor_ms = excluded.poor_ms, lost_ms = excluded.lost_ms,
         reconnect_count = excluded.reconnect_count, worst_quality = excluded.worst_quality,
         updated_at = excluded.updated_at`,
      meetingId,
      identity,
      report.client,
      role,
      report.connected_ms,
      report.excellent_ms,
      report.good_ms,
      report.poor_ms,
      report.lost_ms,
      report.reconnect_count,
      report.worst_quality,
      Date.now(),
    );
  }

  /**
   * Owner-only quality read-out. Kept off ``ArtifactMaterial`` on purpose: a
   * participant should not receive a report on everyone else's network.
   */
  async meetingQuality(ownerSub: string, meetingId: string): Promise<MeetingQuality[]> {
    this.assertOwner(ownerSub);
    this.assertMeeting(meetingId);
    return this.ctx.storage.sql.exec<MeetingQualityRow>(
      `SELECT identity, client, role, connected_ms, excellent_ms, good_ms, poor_ms, lost_ms,
              reconnect_count, worst_quality, updated_at
       FROM meeting_quality WHERE meeting_id = ? ORDER BY role, identity`,
      meetingId,
    ).toArray().map((row) => ({
      identity: row.identity,
      client: row.client,
      role: row.role === 'owner' ? 'owner' : 'guest',
      connectedMs: row.connected_ms,
      excellentMs: row.excellent_ms,
      goodMs: row.good_ms,
      poorMs: row.poor_ms,
      lostMs: row.lost_ms,
      reconnectCount: row.reconnect_count,
      worstQuality: row.worst_quality,
      updatedAt: row.updated_at,
    }));
  }

  async appendTranscript(ownerSub: string, meetingId: string, segments: TranscriptSegment[]): Promise<number> {
    this.assertOwnerOrHostMember(ownerSub);
    this.assertMeeting(meetingId);
    let written = 0;
    for (const segment of segments) {
      if (!segment.is_final) continue;
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO transcript_segments
         (id, meeting_id, speaker_id, speaker_name, language, starts_at_ms, ends_at_ms, text, is_final)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        segment.id,
        meetingId,
        segment.speaker_id,
        segment.speaker_name,
        segment.language,
        segment.starts_at_ms,
        segment.ends_at_ms,
        segment.text,
      );
      written += this.ctx.storage.sql.exec<{ count: number }>('SELECT changes() AS count').one().count;
    }
    if (written > 0) this.bumpRevision(meetingId, true);
    return written;
  }

  /** One speaker, renamed on every line they have. Returns the line count. */
  async renameSpeaker(ownerSub: string, meetingId: string, speakerId: string, speakerName: string): Promise<number> {
    this.assertOwner(ownerSub);
    this.assertMeeting(meetingId);
    this.ctx.storage.sql.exec(
      'UPDATE transcript_segments SET speaker_name = ? WHERE meeting_id = ? AND speaker_id = ?',
      speakerName,
      meetingId,
      speakerId,
    );
    const renamed = this.ctx.storage.sql.exec<{ count: number }>('SELECT changes() AS count').one().count;
    if (renamed > 0) this.bumpRevision(meetingId, true);
    return renamed;
  }

  /** Strike lines from the record. Returns how many were there to strike. */
  async deleteTranscriptSegments(ownerSub: string, meetingId: string, segmentIds: string[]): Promise<number> {
    this.assertOwner(ownerSub);
    this.assertMeeting(meetingId);
    let removed = 0;
    for (const id of segmentIds) {
      this.ctx.storage.sql.exec('DELETE FROM transcript_segments WHERE meeting_id = ? AND id = ?', meetingId, id);
      removed += this.ctx.storage.sql.exec<{ count: number }>('SELECT changes() AS count').one().count;
    }
    if (removed > 0) this.bumpRevision(meetingId, true);
    return removed;
  }

  /**
   * Mark the meeting over and expire the lobby. Does not touch LiveKit or the
   * artifact queue — the Worker closes the SFU room and (on finalize) emails
   * notes. Safe to call more than once.
   */
  async endMeeting(ownerSub: string, meetingId: string): Promise<{
    livekitRoom: string | null;
    alreadyEnded: boolean;
    /** When it ran, so the end can be reported as a duration. */
    startedAt: number;
    endedAt: number;
  }> {
    this.assertOwner(ownerSub);
    this.assertMeeting(meetingId);
    const meeting = this.meeting(meetingId);
    if (!meeting) throw new RoomError('Meeting not found.', 404, 'meeting_not_found');
    const alreadyEnded = meeting.ended_at !== null;
    const endedAt = meeting.ended_at ?? Date.now();
    if (!alreadyEnded) {
      this.ctx.storage.sql.exec(
        `UPDATE meetings SET status = 'ended', ended_at = COALESCE(ended_at, ?) WHERE id = ?`,
        endedAt,
        meetingId,
      );
      this.bumpRevision(meetingId);
      this.ctx.storage.sql.exec(
        `UPDATE join_requests SET status = 'expired' WHERE meeting_id = ? AND status IN ('waiting', 'admitted')`,
        meetingId,
      );
      this.broadcast({ type: 'meeting.ended', meeting_id: meetingId });
      this.broadcastWaitingCount(meetingId, 0);
    }
    return {
      livekitRoom: meeting.livekit_room ?? null,
      alreadyEnded,
      startedAt: meeting.started_at,
      endedAt,
    };
  }

  async finalizeMeeting(ownerSub: string, meetingId: string): Promise<ArtifactMaterial> {
    await this.endMeeting(ownerSub, meetingId);
    return this.artifact(meetingId);
  }

  /** SFU room name, so the Worker can close the room after finalization. */
  async livekitRoomName(meetingId: string): Promise<string | null> {
    const name = this.meeting(meetingId)?.livekit_room ?? null;
    // An ambient meeting has no SFU room to close.
    return name && captureKindOf(name) === 'hosted' ? name : null;
  }

  /**
   * The SFU room a verified owner may currently moderate, for actions the
   * Worker performs with room-admin rights on their behalf.
   *
   * Guarded like admission rather than like a read: being signed in as the
   * owner is not enough, because a stale signed-in client is not the person in
   * the host. Only a host renewing the 30-second lease on a live meeting can
   * reach into the room.
   */
  /**
   * The SFU room a meeting is running in, for a caller a route has already
   * authorized against that exact meeting.
   *
   * No owner check, deliberately: the one caller is a guest raising their own
   * hand, and their artifact principal already names the room and the meeting
   * this is being asked about. What it does keep is the liveness check — a
   * meeting that has ended has no room to write into, and answering with a
   * stale name would send a write to an SFU room nobody is in.
   */
  async liveKitRoomForMeeting(meetingId: string): Promise<string> {
    const meeting = this.meeting(meetingId);
    if (!meeting) throw new RoomError('Meeting not found.', 404, 'meeting_not_found');
    if (meeting.ended_at !== null) {
      throw new RoomError('Meeting is no longer active.', 410, 'meeting_inactive');
    }
    return meeting.livekit_room;
  }

  async moderatedLiveKitRoom(ownerSub: string, meetingId: string): Promise<string> {
    this.assertOwnerOrHostMember(ownerSub);
    const meeting = this.meeting(meetingId);
    if (!meeting) throw new RoomError('Meeting not found.', 404, 'meeting_not_found');
    if (meeting.ended_at !== null) throw new RoomError('Meeting is no longer active.', 410, 'meeting_inactive');
    this.assertHostLease(meeting);
    return meeting.livekit_room;
  }

  /**
   * Spend a participant's admission, so being removed from the SFU is being
   * removed from the meeting.
   *
   * Without this the removal would last as long as it takes a browser to
   * reconnect: the guest still holds the lobby credentials they were admitted
   * with, and `exchangeAdmission` would hand them a fresh room token. Marking
   * the request `removed` closes that door and puts them back at the one they
   * came in through — they can knock again, and the host decides again.
   *
   * Returns the guest's row so the host's lobby list can be told what changed.
   */
  async removeParticipant(
    ownerSub: string,
    meetingId: string,
    identity: string,
  ): Promise<LobbyRequest | null> {
    this.assertOwnerOrHostMember(ownerSub);
    const request = this.ctx.storage.sql.exec<JoinRow>(
      `SELECT id, meeting_id, name, email, identity, status, created_at, lobby_token_hash,
              booking_token, client_app, client_device, on_behalf_of, recording, registered
       FROM join_requests WHERE meeting_id = ? AND identity = ? ORDER BY created_at DESC LIMIT 1`,
      meetingId,
      identity,
    ).toArray()[0];
    // No row is not an error: the owner's own Mac and any future participant
    // that did not come through the lobby have nothing to spend. The SFU
    // removal still stands on its own.
    if (!request) return null;
    this.ctx.storage.sql.exec(
      `UPDATE join_requests SET status = 'removed', decided_at = ? WHERE id = ?`,
      Date.now(),
      request.id,
    );
    const updated = { ...joinRowToPublic(request), status: 'removed' as const };
    this.broadcast({ type: 'lobby.decided', request: updated }, 'owner');
    this.broadcast({ type: 'lobby.status', request_id: request.id, status: 'removed' }, 'guest', request.id);
    this.broadcastWaitingCount(request.meeting_id);
    return updated;
  }

  /** Narrow meeting-agent RPCs; only the Worker can mint or revoke a run. */
  async prepareMeetingAgentRun(input: MeetingAgentPrepare): Promise<MeetingAgentRun> {
    return new MeetingAgentStore(this.ctx.storage, this.env).prepare(input);
  }
  /** Product dispatch takes the actual room owner, never the installer/admin identity. */
  async prepareAutomaticMeetingAgentRun(meetingId: string, installationId: string, skillVersion: string): Promise<MeetingAgentRun> {
    const room = this.requiredRoom();
    const artifact = this.artifact(meetingId);
    if (artifact.endedAt === null || artifact.endedAt - artifact.startedAt < MIN_MEETING_MILLISECONDS || !artifact.transcript.some((segment) => segment.is_final)) {
      throw new ControlError('This meeting is not eligible for automatic notes.', 403, 'capability_denied');
    }
    return new MeetingAgentStore(this.ctx.storage, this.env).prepare({ meeting_id: meetingId,
      installation_id: installationId, actor_sub: room.owner_sub, kind: 'built_in_product', operation: 'propose_notes',
      skill_version: skillVersion, correlation_id: `meeting-finalized:${meetingId}` });
  }
  automaticMeetingAgentRun(meetingId: string): MeetingAgentRun | null {
    return new MeetingAgentStore(this.ctx.storage, this.env).automatic(meetingId);
  }
  async claimMeetingAgentDispatch(runId: string) {
    return new MeetingAgentStore(this.ctx.storage, this.env).claimDispatch(runId);
  }
  acceptMeetingAgentDispatch(runId: string, leaseId: string, runtimeId: string | null): void {
    new MeetingAgentStore(this.ctx.storage, this.env).accepted(runId, leaseId, runtimeId);
  }
  releaseMeetingAgentDispatch(runId: string, leaseId: string): void {
    new MeetingAgentStore(this.ctx.storage, this.env).releaseDispatch(runId, leaseId);
  }
  fallbackMeetingAgent(meetingId: string, reason: 'unavailable' | 'no_text' | 'refused' | 'expired'): boolean {
    const artifact = this.artifact(meetingId);
    return new MeetingAgentStore(this.ctx.storage, this.env).fallback(meetingId, fallbackSummary({ ...artifact,
      transcript: artifact.transcript.filter((segment) => segment.is_final) }), reason);
  }
  async meetingAgentContext(input: MeetingAgentToolRequest, agentSub: string): Promise<MeetingAgentContext> {
    return new MeetingAgentStore(this.ctx.storage, this.env).read(input, agentSub);
  }
  async meetingAgentRunStatus(input: MeetingAgentToolRequest, agentSub: string): Promise<MeetingAgentStatus> {
    return new MeetingAgentStore(this.ctx.storage, this.env).status(input, agentSub);
  }
  async commitMeetingAgentResult(input: MeetingAgentToolRequest, agentSub: string, result: MeetingAgentResult): Promise<MeetingAgentReceipt> {
    return new MeetingAgentStore(this.ctx.storage, this.env).commit(input, agentSub, result);
  }
  async revokeMeetingAgentRun(runId: string): Promise<void> {
    new MeetingAgentStore(this.ctx.storage, this.env).revoke(runId);
  }
  async pendingMeetingAgentDeliveries(): Promise<Array<{ meeting_id: string; run_id: string }>> {
    return new MeetingAgentStore(this.ctx.storage, this.env).pendingDeliveries();
  }
  async markMeetingAgentDelivered(runId: string): Promise<void> {
    new MeetingAgentStore(this.ctx.storage, this.env).delivered(runId);
  }

  async artifactForProcessing(meetingId: string): Promise<ArtifactMaterial> {
    return this.artifact(meetingId);
  }

  /**
   * Roster + text for the CRM meeting log. Unlike the artifact this includes
   * guests without an email, because the log is an internal record of who was
   * in the room.
   */
  async meetingLogMaterial(meetingId: string): Promise<MeetingLogMaterial> {
    const meeting = this.ctx.storage.sql.exec<MeetingRow>(
      `SELECT id, livekit_room, started_at, ended_at, title, summary, host_seen_at,
              meeting_kind, lead_id, project_id, partner_organization_id, subject_title, categorized_by, categorized_at,
              transcript_document_id, transcript_document_path,
              revision, transcript_revision, summary_revision, action_items, decision_candidates, follow_up, agent_notes_metadata
       FROM meetings WHERE id = ?`,
      meetingId,
    ).toArray()[0];
    if (!meeting) throw new RoomError('Meeting not found.', 404, 'meeting_not_found');
    const room = this.requiredRoom();
    const artifact = this.artifact(meetingId);
    const participants = this.ctx.storage.sql.exec<{
      identity: string; name: string; email: string; role: string; booking_token: string | null;
    }>(
      `SELECT p.identity, p.name, p.email, p.role,
              (SELECT j.booking_token FROM join_requests j
               WHERE j.meeting_id = p.meeting_id AND j.identity = p.identity AND j.booking_token IS NOT NULL
               LIMIT 1) AS booking_token
       FROM participants p WHERE p.meeting_id = ? ORDER BY p.role DESC, p.identity`,
      meetingId,
    ).toArray().map((row) => ({
      identity: row.identity,
      name: row.name,
      email: row.email,
      role: row.role === 'owner' ? 'owner' as const : 'guest' as const,
      kind: row.role === 'owner' ? 'human' as const : row.role === 'agent' ? 'agent' as const : 'guest' as const,
      bookingToken: row.booking_token || null,
    }));
    // One person, one row. An owner who hosted from the Mac and answered a
    // knock on the phone has two participant rows by design; the artifact is
    // about who was in the meeting, so the devices collapse back to the person.
    const byPerson = new Map<string, (typeof participants)[number]>();
    for (const participant of participants) {
      const key = participant.email || participant.identity;
      const seen = byPerson.get(key);
      if (!seen) byPerson.set(key, participant);
    }
    const people = [...byPerson.values()];
    // Any knock carrying a token merges this meeting with its booking, even if
    // that guest never made it out of the lobby.
    const bookingToken = this.ctx.storage.sql.exec<{ booking_token: string }>(
      `SELECT booking_token FROM join_requests
       WHERE meeting_id = ? AND booking_token IS NOT NULL ORDER BY created_at ASC LIMIT 1`,
      meetingId,
    ).toArray()[0]?.booking_token ?? null;
    return {
      roomSlug: room.slug,
      ownerEmail: room.owner_email,
      meetingId,
      livekitRoom: meeting.livekit_room,
      startedAt: meeting.started_at,
      endedAt: meeting.ended_at,
      title: meeting.title,
      summary: meeting.summary,
      transcript: artifact.transcript,
      participants: people,
      bookingToken,
      meetingKind: normalizeMeetingKind(meeting.meeting_kind),
      leadId: meeting.lead_id || null,
      projectId: meeting.project_id || null,
      partnerOrganizationId: meeting.partner_organization_id || null,
      subjectTitle: meeting.subject_title || null,
      categorizedBy: meeting.categorized_by || null,
      categorizedAt: meeting.categorized_at ?? null,
      transcriptDocumentId: meeting.transcript_document_id || null,
      transcriptDocumentPath: meeting.transcript_document_path || null,
      captureKind: captureKindOf(meeting.livekit_room),
      revision: meeting.revision ?? 0,
      transcriptRevision: meeting.transcript_revision ?? 0,
      summaryRevision: meeting.summary_revision ?? 0,
      openQuestions: meetingAgentOpenQuestions(meeting.agent_notes_metadata),
      actionItems: readActionItems(meeting.action_items),
      decisionCandidates: readDecisionCandidates(meeting.decision_candidates),
      followUp: readFollowUp(meeting.follow_up),
    };
  }

  /**
   * The host approves the follow-up: only the current draft, and
   * only once. Answers the stored follow-up as it stands after.
   */
  async approveFollowUp(meetingId: string, revision: number): Promise<StoredFollowUp> {
    this.assertMeeting(meetingId);
    const current = readFollowUp(this.ctx.storage.sql.exec<{ follow_up: string | null }>('SELECT follow_up FROM meetings WHERE id = ?', meetingId).one().follow_up);
    if (!current || current.dismissedAt) throw new RoomError('This follow-up is no longer open.', 409, 'invalid_request');
    if (current.approvedAt) {
      if (current.approvedRevision === revision) return current;
      throw new RoomError('This follow-up was already approved.', 409, 'invalid_request');
    }
    if (current.revision !== revision) throw new RoomError('The draft changed. Read it again before you approve.', 409, 'invalid_request');
    const next: StoredFollowUp = { ...current, approvedRevision: revision, approvedAt: Date.now() };
    this.ctx.storage.sql.exec('UPDATE meetings SET follow_up = ? WHERE id = ?', JSON.stringify(next), meetingId);
    return next;
  }

  /**
   * What INBOX shows for a follow-up, without the transcript: the
   * meeting's title, the draft, the tasks its notes proposed, and the roster
   * the recipients come from.
   */
  async followUpView(meetingId: string): Promise<{
    title: string;
    followUp: StoredFollowUp | null;
    tasks: Array<{ id: string; title: string }>;
    participants: MeetingLogParticipant[];
  } | null> {
    const meeting = this.ctx.storage.sql.exec<{ title: string | null; follow_up: string | null; action_items: string | null }>(
      'SELECT title, follow_up, action_items FROM meetings WHERE id = ?', meetingId,
    ).toArray()[0];
    if (!meeting) return null;
    const material = await this.meetingLogMaterial(meetingId);
    return {
      title: meeting.title?.trim() || 'Untitled meeting',
      followUp: readFollowUp(meeting.follow_up),
      tasks: readActionItems(meeting.action_items)
        .filter((item) => item.task_id)
        .map((item) => ({ id: item.task_id!, title: item.what })),
      participants: material.participants,
    };
  }

  /** The host does not want it: the draft leaves INBOX, the tasks stay as they are. */
  async dismissFollowUp(meetingId: string): Promise<void> {
    this.assertMeeting(meetingId);
    const current = readFollowUp(this.ctx.storage.sql.exec<{ follow_up: string | null }>('SELECT follow_up FROM meetings WHERE id = ?', meetingId).one().follow_up);
    if (!current || current.approvedAt || current.dismissedAt) return;
    this.ctx.storage.sql.exec('UPDATE meetings SET follow_up = ? WHERE id = ?', JSON.stringify({ ...current, dismissedAt: Date.now() }), meetingId);
  }

  /**
   * A meeting the owner's Mac captured outside any room — a Zoom call, a
   * Teams call, a conversation — arriving already over, with its roster by
   * name. Filed here so the transcript, the notes, the category and the CRM
   * write are the same ones a hosted meeting gets. Never `open`: the room's
   * live meeting, if any, is untouched.
   */
  async startAmbientMeeting(
    owner: { sub: string; email: string; name: string },
    input: { startedAt: number; endedAt: number; title: string | null; attendees: Array<{ name: string; email?: string | null | undefined }> },
  ): Promise<{ id: string }> {
    this.assertOwner(owner.sub);
    const id = crypto.randomUUID();
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO meetings (id, livekit_room, started_at, ended_at, status, title, host_seen_at)
       VALUES (?, ?, ?, ?, 'ended', ?, ?)`,
      id,
      ambientRoomMarker(id),
      input.startedAt,
      input.endedAt,
      input.title,
      now,
    );
    this.recordOwnerParticipant(id, owner.email, owner, now);
    for (const attendee of input.attendees) {
      const name = attendee.name.trim();
      const email = attendee.email?.trim().toLowerCase() ?? '';
      if (!name || name === owner.name || email === owner.email) continue;
      // An address, when the calendar knew one, is what lets Core link the
      // contact; a name alone is a name on the roster and nothing more.
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO participants (meeting_id, identity, name, email, transcript_opt_in, role, updated_at)
         VALUES (?, ?, ?, ?, 1, 'guest', ?)`,
        id,
        email ? `ambient:${email}` : `ambient:${name.toLowerCase()}`,
        name,
        email,
        now,
      );
    }
    return { id };
  }

  /**
   * The meetings the owner's Mac captured outside any room, newest first,
   * for the Meetings list: what was captured, where the
   * transcript went, how each is filed. Never a line of transcript; the
   * first line of the notes at most.
   */
  async ambientMeetings(limit = 200): Promise<AmbientMeetingRow[]> {
    const room = this.room();
    if (!room) return [];
    const rows = this.ctx.storage.sql.exec<{
      id: string;
      started_at: number;
      ended_at: number | null;
      title: string | null;
      summary: string | null;
      meeting_kind: string | null;
      lead_id: string | null;
      project_id: string | null;
      partner_organization_id: string | null;
      subject_title: string | null;
      transcript_document_path: string | null;
      segment_count: number;
    }>(
      `SELECT m.id, m.started_at, m.ended_at, m.title, m.summary, m.meeting_kind, m.lead_id, m.project_id,
              m.partner_organization_id, m.subject_title, m.transcript_document_path,
              (SELECT COUNT(*) FROM transcript_segments t WHERE t.meeting_id = m.id) AS segment_count
       FROM meetings m
       WHERE m.livekit_room LIKE 'ambient:%' AND m.status != 'discarded'
       ORDER BY m.started_at DESC LIMIT ?`,
      limit,
    ).toArray();
    return rows.map((row) => ({
      id: row.id,
      room_slug: room.slug,
      title: row.title,
      started_at: new Date(row.started_at).toISOString(),
      ended_at: row.ended_at == null ? null : new Date(row.ended_at).toISOString(),
      attendees: this.ctx.storage.sql.exec<{ name: string; email: string }>(
        `SELECT name, email FROM participants WHERE meeting_id = ? ORDER BY role DESC, name`,
        row.id,
      ).toArray().map((person) => ({ name: person.name, email: person.email || null })),
      summary_line: firstLine(row.summary),
      meeting_kind: normalizeMeetingKind(row.meeting_kind),
      lead_id: row.lead_id || null,
      project_id: row.project_id || null,
      partner_organization_id: row.partner_organization_id || null,
      subject_title: row.subject_title || null,
      has_transcript: row.segment_count > 0,
      transcript_document_path: row.transcript_document_path || null,
    }));
  }

  /** Whether the meeting is over — the category route syncs `ended` then. */
  async isEnded(meetingId: string): Promise<boolean> {
    return this.meeting(meetingId)?.ended_at != null;
  }

  /**
   * Where the transcript went. Written by the CRM job after Docs answered, so
   * a retried job updates that document instead of filing a second one.
   */
  async setTranscriptDocument(meetingId: string, documentId: string, path: string): Promise<number> {
    this.assertMeeting(meetingId);
    this.ctx.storage.sql.exec(
      'UPDATE meetings SET transcript_document_id = ?, transcript_document_path = ? WHERE id = ?',
      documentId,
      path,
      meetingId,
    );
    // The link is part of the record Core holds: a new one is a new revision.
    this.bumpRevision(meetingId);
    return this.revisionOf(meetingId);
  }

  /** The document is archived (every line was struck): nothing points at it any more. */
  async clearTranscriptDocument(meetingId: string): Promise<number> {
    this.assertMeeting(meetingId);
    this.ctx.storage.sql.exec(
      'UPDATE meetings SET transcript_document_id = NULL, transcript_document_path = NULL WHERE id = ?',
      meetingId,
    );
    this.bumpRevision(meetingId);
    return this.revisionOf(meetingId);
  }

  private revisionOf(meetingId: string): number {
    return this.ctx.storage.sql.exec<{ revision: number | null }>('SELECT revision FROM meetings WHERE id = ?', meetingId).one().revision ?? 0;
  }

  async artifactForViewer(meetingId: string, identity: string, role: 'owner' | 'guest'): Promise<ArtifactMaterial> {
    if (role === 'owner') {
      // The artifact belongs to the person, not to the device that hosted, so
      // a device-scoped identity is resolved back to the account address here.
      if (this.requiredRoom().owner_email !== ownerAccountEmail(identity)) {
        throw new RoomError('Artifact access denied.', 403, 'artifact_denied');
      }
    } else {
      const participant = this.ctx.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM participants
         WHERE meeting_id = ? AND identity = ?`,
        meetingId,
        identity,
      ).one();
      if (participant.count !== 1) throw new RoomError('Artifact access denied.', 403, 'artifact_denied');
      // In an event session the artifact goes to the host alone
      // (docs/SESSIONS.md §8): a transcript of a public room names everyone
      // who spoke, and mailing it to every guest is a disclosure.
      if (this.sessionOf(meetingId)) throw new RoomError('Artifact access denied.', 403, 'artifact_denied');
    }
    return this.artifact(meetingId);
  }

  /** Worker-authorized member access; the checked subject and read share one DO turn. */
  artifactForFiledMember(
    meetingId: string,
    expectedSubject: { kind: 'project' | 'lead' | 'organization'; id: string },
  ): { artifact: ArtifactMaterial; category: MeetingCategory } {
    const category = this.meetingCategoryValue(meetingId);
    const subject = subjectOfCategory(category);
    if (!subject || subject.kind !== expectedSubject.kind || subject.id !== expectedSubject.id) {
      throw new RoomError('Meeting not found.', 404, 'meeting_not_found');
    }
    return { artifact: this.artifact(meetingId), category };
  }

  /**
   * The notes, and what they wrote down as commitments. Rewritten notes
   * keep the Core id of any item they still carry (matched by title), so
   * a second run proposes the new ones and never the same one twice.
   */
  async setSummary(
    meetingId: string,
    title: string,
    summary: string,
    actionItems: MeetingActionItem[] = [],
    decisionCandidates: MeetingDecisionCandidate[] = [],
    model: string | null = null,
    /** Undefined keeps the follow-up as it is; null clears an open draft. */
    followUp?: MeetingFollowUpDraft | null,
  ): Promise<void> {
    this.assertMeeting(meetingId);
    const row = this.ctx.storage.sql.exec<{ action_items: string | null; decision_candidates: string | null; follow_up: string | null }>(
      'SELECT action_items, decision_candidates, follow_up FROM meetings WHERE id = ?', meetingId,
    ).one();
    // Rewritten notes rewrite an open draft as a new revision. An approved or
    // dismissed one is the host's answer, and stays.
    const before = readFollowUp(row.follow_up);
    if (followUp !== undefined && !before?.approvedAt && !before?.dismissedAt) {
      const next = followUp
        ? { draft: followUp, revision: (before?.revision ?? 0) + 1, writtenAt: Date.now(), approvedRevision: null, approvedAt: null, dismissedAt: null }
        : null;
      this.ctx.storage.sql.exec('UPDATE meetings SET follow_up = ? WHERE id = ?', next ? JSON.stringify(next) : null, meetingId);
    }
    const previous = readActionItems(row.action_items);
    const filed = new Map(previous.filter((item) => item.task_id).map((item) => [actionItemKey(item.what), item.task_id]));
    const merged = actionItems.map((item) => ({ ...item, task_id: item.task_id ?? filed.get(actionItemKey(item.what)) ?? null }));
    // Rewritten notes keep what the owner already answered:
    // a recorded candidate keeps its id, a dismissed one stays dismissed.
    const answered = new Map(
      readDecisionCandidates(row.decision_candidates)
        .filter((item) => item.decision_id || item.dismissed)
        .map((item) => [actionItemKey(item.what), item]),
    );
    const decisions = decisionCandidates.map((item) => {
      const before = answered.get(actionItemKey(item.what));
      return before ? { ...item, decision_id: before.decision_id, dismissed: before.dismissed } : item;
    });
    this.ctx.storage.sql.exec(
      'UPDATE meetings SET title = ?, summary = ?, summary_revision = transcript_revision, action_items = ?, decision_candidates = ?, summary_model = ?, agent_notes_metadata = NULL WHERE id = ?',
      title.slice(0, 160),
      summary.slice(0, 30_000),
      JSON.stringify(merged.slice(0, 60)),
      JSON.stringify(decisions.slice(0, 40)),
      model?.slice(0, 80) ?? null,
      meetingId,
    );
    this.bumpRevision(meetingId);
  }

  /**
   * Finalized meetings since `since` whose notes a model other than Claude
   * wrote. A row with no `summary_model` predates the column and
   * is left out: nobody knows which engine wrote it.
   */
  async meetingsWrittenByFallback(since: number): Promise<string[]> {
    return this.ctx.storage.sql.exec<{ id: string }>(
      `SELECT id FROM meetings
       WHERE summary IS NOT NULL AND ended_at >= ? AND summary_model IS NOT NULL AND summary_model NOT LIKE 'claude%'
       ORDER BY ended_at`,
      since,
    ).toArray().map((row) => row.id);
  }

  /**
   * The owner answered one candidate: recorded, with Core's id,
   * or dismissed. Either way it is never asked again. Returns the row as it
   * now stands, or null for an index that names nothing.
   */
  async answerDecisionCandidate(
    meetingId: string,
    index: number,
    answer: { decisionId: string } | { dismissed: true },
  ): Promise<MeetingDecisionCandidate | null> {
    this.assertMeeting(meetingId);
    const items = readDecisionCandidates(
      this.ctx.storage.sql.exec<{ decision_candidates: string | null }>('SELECT decision_candidates FROM meetings WHERE id = ?', meetingId).one().decision_candidates,
    );
    const current = items[index];
    if (!current) return null;
    items[index] = 'decisionId' in answer
      ? { ...current, decision_id: answer.decisionId, dismissed: false }
      : { ...current, dismissed: true };
    this.ctx.storage.sql.exec('UPDATE meetings SET decision_candidates = ? WHERE id = ?', JSON.stringify(items), meetingId);
    return items[index]!;
  }

  /** One action item reached Core as a proposed task: remember its id, so it is never filed twice. */
  async markActionItemFiled(meetingId: string, index: number, taskId: string): Promise<void> {
    this.assertMeeting(meetingId);
    const items = readActionItems(
      this.ctx.storage.sql.exec<{ action_items: string | null }>('SELECT action_items FROM meetings WHERE id = ?', meetingId).one().action_items,
    );
    if (!items[index]) return;
    items[index] = { ...items[index]!, task_id: taskId };
    this.ctx.storage.sql.exec('UPDATE meetings SET action_items = ? WHERE id = ?', JSON.stringify(items), meetingId);
  }

  /**
   * Envisioning-only CRM filing for the live meeting. Guests never read this;
   * any verified room owner may set it. Persisted on the DO so end-of-meeting
   * CRM sync carries lead/project even if Core was briefly down mid-call.
   */
  async setMeetingCategory(
    ownerSub: string,
    meetingId: string,
    input: {
      meetingKind: 'uncategorized' | 'status' | 'lead' | 'project' | 'internal' | 'partner';
      leadId: string | null;
      projectId: string | null;
      partnerOrganizationId: string | null;
      subjectTitle: string | null;
      categorizedBy: string;
    },
  ): Promise<{
    meetingKind: 'uncategorized' | 'status' | 'lead' | 'project' | 'internal' | 'partner';
    leadId: string | null;
    projectId: string | null;
    partnerOrganizationId: string | null;
    subjectTitle: string | null;
    categorizedBy: string | null;
    categorizedAt: number | null;
  }> {
    this.assertOwner(ownerSub);
    this.assertMeeting(meetingId);
    const categorizedAt = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE meetings SET
         meeting_kind = ?, lead_id = ?, project_id = ?, partner_organization_id = ?, subject_title = ?,
         categorized_by = ?, categorized_at = ?
       WHERE id = ?`,
      input.meetingKind,
      input.leadId,
      input.projectId,
      input.partnerOrganizationId,
      input.subjectTitle?.slice(0, 200) ?? null,
      input.categorizedBy.slice(0, 320),
      categorizedAt,
      meetingId,
    );
    this.bumpRevision(meetingId);
    return this.meetingCategory(meetingId);
  }

  async meetingCategory(meetingId: string): Promise<MeetingCategory> {
    return this.meetingCategoryValue(meetingId);
  }

  private meetingCategoryValue(meetingId: string): MeetingCategory {
    const meeting = this.ctx.storage.sql.exec<MeetingRow>(
      `SELECT id, livekit_room, started_at, ended_at, title, summary, host_seen_at,
              meeting_kind, lead_id, project_id, partner_organization_id, subject_title, categorized_by, categorized_at
       FROM meetings WHERE id = ?`,
      meetingId,
    ).toArray()[0];
    if (!meeting) throw new RoomError('Meeting not found.', 404, 'meeting_not_found');
    return {
      meetingKind: normalizeMeetingKind(meeting.meeting_kind),
      leadId: meeting.lead_id || null,
      projectId: meeting.project_id || null,
      partnerOrganizationId: meeting.partner_organization_id || null,
      subjectTitle: meeting.subject_title || null,
      categorizedBy: meeting.categorized_by || null,
      categorizedAt: meeting.categorized_at ?? null,
    };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({ error: 'WebSocket upgrade required.' }, { status: 426 });
    }
    const role = request.headers.get('x-meet-role');
    const attachment: SocketAttachment = role === 'owner'
      ? { role: 'owner', requestId: undefined }
      : { role: 'guest', requestId: request.headers.get('x-meet-request-id') ?? undefined };
    if (attachment.role === 'owner') {
      this.assertOwner(request.headers.get('x-meet-owner-sub') ?? '');
    } else {
      const requestId = attachment.requestId;
      const token = request.headers.get('x-meet-lobby-token');
      if (!requestId || !token) throw new RoomError('Lobby credentials are missing.', 401, 'lobby_credentials_missing');
      await this.authenticatedJoinRequest(requestId, token);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [attachment.role]);
    server.send(JSON.stringify({ type: 'connected', role: attachment.role }));
    if (attachment.role === 'guest' && attachment.requestId) {
      const join = this.joinRequest(attachment.requestId);
      if (join) {
        server.send(JSON.stringify({
          type: 'lobby.waiting',
          waiting_count: this.waitingCount(join.meeting_id),
        }));
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === 'string' && message === 'ping') socket.send('pong');
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    // Never echo the client's code/reason: reserved codes (1005/1006, common
    // on abnormal disconnects) and >123-byte reasons make close() throw.
    try {
      socket.close(1000);
    } catch {
      // Socket already fully closed.
    }
  }

  async alarm(): Promise<void> {
    const room = this.room();
    if (!room || room.expires_at === null || room.expires_at > Date.now()) return;
    this.ctx.storage.sql.exec("UPDATE room SET status = 'expired'");
    this.ctx.storage.sql.exec("UPDATE meetings SET status = 'ended', ended_at = COALESCE(ended_at, ?) WHERE status = 'open'", Date.now());
    this.broadcast({ type: 'room.expired' });
    for (const socket of this.ctx.getWebSockets()) socket.close(1000, 'Room expired');
  }

  private migrate(): void {
    // The meeting agent adds only lifecycle metadata; results use the meetings table.

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS room (
        slug TEXT PRIMARY KEY,
        owner_sub TEXT NOT NULL,
        owner_email TEXT NOT NULL,
        kind TEXT NOT NULL,
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        livekit_room TEXT NOT NULL UNIQUE,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL,
        title TEXT,
        summary TEXT,
        host_seen_at INTEGER NOT NULL,
        chair_device_id TEXT,
        chair_identity TEXT,
        pending_chair_device_id TEXT,
        pending_chair_identity TEXT,
        chair_released_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS meetings_status_idx ON meetings(status, started_at);
      CREATE TABLE IF NOT EXISTS join_requests (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        transcript_opt_in INTEGER NOT NULL,
        identity TEXT NOT NULL,
        lobby_token_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        joined_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS join_meeting_idx ON join_requests(meeting_id, status, created_at);
      CREATE TABLE IF NOT EXISTS participants (
        meeting_id TEXT NOT NULL,
        identity TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        transcript_opt_in INTEGER NOT NULL,
        role TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (meeting_id, identity)
      );
      CREATE TABLE IF NOT EXISTS transcript_segments (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL,
        speaker_id TEXT NOT NULL,
        speaker_name TEXT NOT NULL,
        language TEXT NOT NULL,
        starts_at_ms INTEGER NOT NULL,
        ends_at_ms INTEGER NOT NULL,
        text TEXT NOT NULL,
        is_final INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS transcript_meeting_idx ON transcript_segments(meeting_id, starts_at_ms);
      CREATE TABLE IF NOT EXISTS email_deliveries (
        meeting_id TEXT NOT NULL,
        email TEXT NOT NULL,
        message_id TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        PRIMARY KEY (meeting_id, email)
      );
      INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (1);
    `);
    const columns = this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(meetings)').toArray();
    if (!columns.some((column) => column.name === 'host_seen_at')) {
      this.ctx.storage.sql.exec('ALTER TABLE meetings ADD COLUMN host_seen_at INTEGER');
      this.ctx.storage.sql.exec('UPDATE meetings SET host_seen_at = started_at WHERE host_seen_at IS NULL');
    }
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (2)');
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meeting_quality (
        meeting_id TEXT NOT NULL,
        identity TEXT NOT NULL,
        client TEXT NOT NULL,
        role TEXT NOT NULL,
        connected_ms INTEGER NOT NULL,
        excellent_ms INTEGER NOT NULL,
        good_ms INTEGER NOT NULL,
        poor_ms INTEGER NOT NULL,
        lost_ms INTEGER NOT NULL,
        reconnect_count INTEGER NOT NULL,
        worst_quality TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (meeting_id, identity)
      );
      INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (3);
    `);
    const roomColumns = this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(room)').toArray();
    if (!roomColumns.some((column) => column.name === 'host_seen_at')) {
      this.ctx.storage.sql.exec('ALTER TABLE room ADD COLUMN host_seen_at INTEGER');
    }
    if (!roomColumns.some((column) => column.name === 'refuse_recorders')) {
      this.ctx.storage.sql.exec('ALTER TABLE room ADD COLUMN refuse_recorders INTEGER NOT NULL DEFAULT 0');
    }
    // Future: gate presence-shaped read APIs to an identity domain peers only — never expose online/offline to public guests.
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (4)');
    const joinColumns = this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(join_requests)').toArray();
    if (!joinColumns.some((column) => column.name === 'booking_token')) {
      this.ctx.storage.sql.exec('ALTER TABLE join_requests ADD COLUMN booking_token TEXT');
    }
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (5)');
    if (!roomColumns.some((column) => column.name === 'owner_name')) {
      this.ctx.storage.sql.exec('ALTER TABLE room ADD COLUMN owner_name TEXT');
    }
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (6)');
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS guest_presence (
        id TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        name TEXT,
        city TEXT,
        country TEXT,
        seen_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS guest_presence_seen_idx ON guest_presence(seen_at);
      INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (7);
    `);
    // Which surface a guest is on. Two columns rather than one JSON blob so a
    // future query can group by either axis without parsing.
    const presenceColumns = this.ctx.storage.sql
      .exec<{ name: string }>('PRAGMA table_info(guest_presence)').toArray();
    if (!presenceColumns.some((column) => column.name === 'client_app')) {
      this.ctx.storage.sql.exec('ALTER TABLE guest_presence ADD COLUMN client_app TEXT');
      this.ctx.storage.sql.exec('ALTER TABLE guest_presence ADD COLUMN client_device TEXT');
    }
    if (!joinColumns.some((column) => column.name === 'client_app')) {
      this.ctx.storage.sql.exec('ALTER TABLE join_requests ADD COLUMN client_app TEXT');
      this.ctx.storage.sql.exec('ALTER TABLE join_requests ADD COLUMN client_device TEXT');
    }
    if (!joinColumns.some((column) => column.name === 'on_behalf_of')) {
      this.ctx.storage.sql.exec('ALTER TABLE join_requests ADD COLUMN on_behalf_of TEXT');
    }
    if (!joinColumns.some((column) => column.name === 'recording')) {
      this.ctx.storage.sql.exec('ALTER TABLE join_requests ADD COLUMN recording INTEGER NOT NULL DEFAULT 0');
    }
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (8)');

    // CRM categorize POC — Envisioning-only subject on the live meeting.
    migrateMeetingAgentStore(this.ctx.storage.sql);
    const meetingColumns = this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(meetings)').toArray();
    for (const column of [
      'chair_device_id',
      'chair_identity',
      'pending_chair_device_id',
      'pending_chair_identity',
      'chair_released_at',
      'host_offer_identity',
      'host_offer_email',
      'host_offer_at',
      'host_member_sub',
      'host_member_email',
      'host_badge_identity',
      'meeting_kind',
      'lead_id',
      'project_id',
      'partner_organization_id',
      'subject_title',
      'categorized_by',
      'categorized_at',
    ] as const) {
      if (!meetingColumns.some((entry) => entry.name === column)) {
        const type = column === 'categorized_at' || column === 'chair_released_at' || column === 'host_offer_at' ? 'INTEGER' : 'TEXT';
        this.ctx.storage.sql.exec(`ALTER TABLE meetings ADD COLUMN ${column} ${type}`);
      }
    }
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (9)');

    // Presence ids the host closed the connection on — kept separate from
    // guest_presence itself so a block outlives the row it removed.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS blocked_presence (
        id TEXT PRIMARY KEY,
        blocked_until INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (10);
    `);

    // The transcript's Docs document, filed by the CRM job (see crm.ts).
    for (const column of ['transcript_document_id', 'transcript_document_path'] as const) {
      if (!meetingColumns.some((entry) => entry.name === column)) {
        this.ctx.storage.sql.exec(`ALTER TABLE meetings ADD COLUMN ${column} TEXT`);
      }
    }
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (11)');

    // Revisions for the delivery ledger: what a destination has
    // been told against what is here now.
    for (const column of ['revision', 'transcript_revision', 'summary_revision'] as const) {
      if (!meetingColumns.some((entry) => entry.name === column)) {
        this.ctx.storage.sql.exec(`ALTER TABLE meetings ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
      }
    }
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (12)');

    // The notes engine's action items as data, JSON.
    if (!meetingColumns.some((entry) => entry.name === 'action_items')) {
      this.ctx.storage.sql.exec('ALTER TABLE meetings ADD COLUMN action_items TEXT');
    }
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (13)');

    // The notes engine's decisions as data, JSON.
    if (!meetingColumns.some((entry) => entry.name === 'decision_candidates')) {
      this.ctx.storage.sql.exec('ALTER TABLE meetings ADD COLUMN decision_candidates TEXT');
    }
    // The follow-up for the people outside, JSON: the draft and its answer.
    if (!meetingColumns.some((entry) => entry.name === 'follow_up')) {
      this.ctx.storage.sql.exec('ALTER TABLE meetings ADD COLUMN follow_up TEXT');
    }
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (14)');

    // Which model wrote the notes, so notes the fallback wrote
    // can be found and written again.
    if (!meetingColumns.some((entry) => entry.name === 'summary_model')) {
      this.ctx.storage.sql.exec('ALTER TABLE meetings ADD COLUMN summary_model TEXT');
    }
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (15)');

    // An event session armed on a meeting (docs/SESSIONS.md §7):
    // the event and its window. One row per meeting, so ending and restarting
    // arms against whichever event is then current. No registrant data.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meeting_sessions (
        meeting_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        starts_at INTEGER NOT NULL,
        ends_at INTEGER NOT NULL,
        armed_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (16);
    `);

    // Auto-admit (docs/SESSIONS.md §7): the session's roster of
    // SHA-256 token hashes, never tokens or registrants, with how often each
    // hash let somebody in; when the roster was last fetched; whether the host
    // closed the door; and which knocks a registration link admitted.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS meeting_session_roster (
        meeting_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        admits INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (meeting_id, token_hash)
      );
    `);
    const sessionColumns = this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(meeting_sessions)').toArray();
    if (!sessionColumns.some((entry) => entry.name === 'roster_fetched_at')) {
      this.ctx.storage.sql.exec('ALTER TABLE meeting_sessions ADD COLUMN roster_fetched_at INTEGER');
    }
    if (!sessionColumns.some((entry) => entry.name === 'door_closed')) {
      this.ctx.storage.sql.exec('ALTER TABLE meeting_sessions ADD COLUMN door_closed INTEGER NOT NULL DEFAULT 0');
    }
    const joinRequestColumns = this.ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(join_requests)').toArray();
    if (!joinRequestColumns.some((entry) => entry.name === 'registered')) {
      this.ctx.storage.sql.exec('ALTER TABLE join_requests ADD COLUMN registered INTEGER NOT NULL DEFAULT 0');
    }
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (17)');

    // A deletion marker per erased meeting: no content, only what
    // a retry and a restore need. The Docs transcript id and its owner stay
    // until Docs has purged it, then go. Kept 30 days, as the backups.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS erased_meetings (
        meeting_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        erased_at INTEGER NOT NULL,
        transcript_document_id TEXT,
        document_owner_email TEXT
      );
      INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (18);
    `);
  }

  /** The session a meeting was armed with, if any. */
  private sessionOf(meetingId: string): MeetingSessionArm | undefined {
    return this.ctx.storage.sql.exec<{ event_id: string; starts_at: number; ends_at: number }>(
      'SELECT event_id, starts_at, ends_at FROM meeting_sessions WHERE meeting_id = ?',
      meetingId,
    ).toArray()[0];
  }

  /** Whether a meeting is an event session. The Worker asks before it asks the store. */
  async meetingSession(meetingId: string): Promise<MeetingSessionArm | null> {
    return this.sessionOf(meetingId) ?? null;
  }

  /**
   * Arm an open meeting as an event session. The Worker calls this at room
   * start when the store has an event that covers now for this room. A meeting
   * arms once; a second call keeps the first event.
   */
  async armSession(meetingId: string, arm: MeetingSessionArm, tokenHashes: readonly string[] = []): Promise<void> {
    const meeting = this.meeting(meetingId);
    if (!meeting || meeting.ended_at !== null) throw new RoomError('Meeting not found.', 404, 'meeting_not_found');
    const inserted = this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO meeting_sessions (meeting_id, event_id, starts_at, ends_at, armed_at)
       VALUES (?, ?, ?, ?, ?)`,
      meetingId, arm.event_id, arm.starts_at, arm.ends_at, Date.now(),
    ).rowsWritten;
    if (inserted > 0) this.replaceRoster(meetingId, tokenHashes);
  }

  private sessionRow(meetingId: string): (MeetingSessionArm & { roster_fetched_at: number | null; door_closed: number }) | undefined {
    return this.ctx.storage.sql.exec<{ event_id: string; starts_at: number; ends_at: number; roster_fetched_at: number | null; door_closed: number }>(
      'SELECT event_id, starts_at, ends_at, roster_fetched_at, door_closed FROM meeting_sessions WHERE meeting_id = ?',
      meetingId,
    ).toArray()[0];
  }

  /**
   * Make the roster the store's current set of live token hashes. A hash that
   * left (a cancelled registration) stops admitting; one that stays keeps its
   * admit count.
   */
  private replaceRoster(meetingId: string, tokenHashes: readonly string[]): void {
    const hashes = JSON.stringify([...new Set(tokenHashes)]);
    this.ctx.storage.sql.exec(
      `DELETE FROM meeting_session_roster
       WHERE meeting_id = ? AND token_hash NOT IN (SELECT value FROM json_each(?))`,
      meetingId, hashes,
    );
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO meeting_session_roster (meeting_id, token_hash, admits)
       SELECT ?, value, 0 FROM json_each(?)`,
      meetingId, hashes,
    );
    this.ctx.storage.sql.exec('UPDATE meeting_sessions SET roster_fetched_at = ? WHERE meeting_id = ?', Date.now(), meetingId);
  }

  /**
   * Whether the Worker should fetch the roster again before a registration
   * knock: the open meeting is an armed session with its door open, now is in
   * its window, and the roster is a minute old or more. At most one fetch per
   * minute, so a store outage mid-session costs nothing (docs/SESSIONS.md §7).
   * Answers the event to fetch, and takes the minute.
   */
  async sessionRosterRefreshDue(now: number = Date.now()): Promise<{ meeting_id: string; event_id: string } | null> {
    const meeting = this.openMeeting();
    if (!meeting) return null;
    const session = this.sessionRow(meeting.id);
    if (!session || session.door_closed === 1) return null;
    if (now < session.starts_at - SESSION_WINDOW_MARGIN_MS || now > session.ends_at + SESSION_WINDOW_MARGIN_MS) return null;
    if (session.roster_fetched_at !== null && now - session.roster_fetched_at < SESSION_ROSTER_REFETCH_MS) return null;
    this.ctx.storage.sql.exec('UPDATE meeting_sessions SET roster_fetched_at = ? WHERE meeting_id = ?', now, meeting.id);
    return { meeting_id: meeting.id, event_id: session.event_id };
  }

  /** The roster the Worker fetched after `sessionRosterRefreshDue`. */
  async refreshSessionRoster(meetingId: string, tokenHashes: readonly string[]): Promise<void> {
    if (!this.sessionRow(meetingId)) return;
    this.replaceRoster(meetingId, tokenHashes);
  }

  /**
   * The host's control: registration links stop admitting for the rest of
   * this session. Knocks still reach the waiting room.
   */
  async closeSessionDoor(ownerSub: string): Promise<{ session_door_open: boolean }> {
    this.assertOwnerOrHostMember(ownerSub);
    const meeting = this.openMeeting();
    const session = meeting ? this.sessionRow(meeting.id) : undefined;
    if (!meeting || !session) throw new RoomError('No event session is running.', 404, 'meeting_not_found');
    this.ctx.storage.sql.exec('UPDATE meeting_sessions SET door_closed = 1 WHERE meeting_id = ?', meeting.id);
    return { session_door_open: false };
  }

  /** One more change a destination has not heard: every mutation of the record ends here. */
  private bumpRevision(meetingId: string, transcript = false): void {
    this.ctx.storage.sql.exec(
      transcript
        ? 'UPDATE meetings SET revision = revision + 1, transcript_revision = transcript_revision + 1 WHERE id = ?'
        : 'UPDATE meetings SET revision = revision + 1 WHERE id = ?',
      meetingId,
    );
  }

  private appendRecorderConsent(request: JoinRow, meeting: MeetingRow, now: number): void {
    const attributedHuman = request.on_behalf_of ? displayNameFromEmail(request.on_behalf_of) : null;
    const text = attributedHuman
      ? `${request.name} is recording on ${attributedHuman}'s behalf.`
      : `${request.name} is a recording notetaker.`;
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO transcript_segments
       (id, meeting_id, speaker_id, speaker_name, language, starts_at_ms, ends_at_ms, text, is_final)
       VALUES (?, ?, ?, ?, 'und', ?, ?, ?, 1)`,
      request.id,
      request.meeting_id,
      `system:notetaker:${request.id}`,
      'Starlings',
      Math.max(0, now - meeting.started_at),
      Math.max(0, now - meeting.started_at),
      text,
    );
    if (this.ctx.storage.sql.exec<{ count: number }>('SELECT changes() AS count').one().count > 0) {
      this.bumpRevision(request.meeting_id, true);
    }
  }

  private room(): RoomRow | undefined {
    return this.ctx.storage.sql.exec<RoomRow>(
      'SELECT slug, owner_sub, owner_email, owner_name, kind, expires_at, host_seen_at, refuse_recorders FROM room LIMIT 1',
    ).toArray()[0];
  }

  private requiredRoom(): RoomRow {
    const room = this.room();
    if (!room) throw new RoomError('Room is closed.', 404, 'room_not_found');
    return room;
  }

  private assertOwner(subject: string): void {
    const room = this.requiredRoom();
    if (this.isSharedRoom() || room.owner_sub === subject) return;
    throw new RoomError('Only the room owner can do that.', 403, 'not_room_owner');
  }

  /**
   * The owner, or the member who accepted the host of the open meeting
   *. Only the meeting's own methods take this: joining as host,
   * the lease, the host handover, admission, moderation and the transcript.
   * Room settings, End and the record stay the owner's.
   */
  private assertOwnerOrHostMember(subject: string): void {
    const room = this.requiredRoom();
    if (this.isSharedRoom() || room.owner_sub === subject) return;
    if (this.openMeeting()?.host_member_sub === subject) return;
    throw new RoomError('Only the room owner can do that.', 403, 'not_room_owner');
  }

  /** Whether this signed-in member hosts the open meeting on the owner's offer. */
  async isHostMember(subject: string): Promise<boolean> {
    return this.openMeeting()?.host_member_sub === subject;
  }

  /**
   * The host asks one device in the call to host. The route has checked that
   * the device is in the call and belongs to an Envisioning member; `email` is
   * that member's address, which the answer must prove with a signed session.
   * Another device of the same person does not answer: it claims.
   */
  async offerHost(
    subject: string,
    meetingId: string,
    caller: { deviceID: string | null; identity: string },
    target: { identity: string; email: string },
  ): Promise<{ expiresAt: number }> {
    this.assertOwnerOrHostMember(subject);
    const meeting = this.meeting(meetingId);
    if (!meeting || meeting.ended_at !== null) throw new RoomError('Meeting is no longer active.', 410, 'meeting_inactive');
    if (meeting.chair_identity === null || !holdsHost(this.env, meeting, caller.deviceID, caller.identity)) {
      throw new RoomError('This device is not the host.', 409, 'host_not_active');
    }
    if (meeting.chair_identity === target.identity) {
      throw new RoomError('That device is already the host.', 409, 'host_not_active');
    }
    const now = Date.now();
    this.ctx.storage.sql.exec(
      'UPDATE meetings SET host_offer_identity = ?, host_offer_email = ?, host_offer_at = ? WHERE id = ?',
      target.identity, target.email.trim().toLowerCase(), now, meetingId,
    );
    return { expiresAt: now + HOST_OFFER_MILLISECONDS };
  }

  /**
   * The member offered the host answers, signed in as themselves. Accepting
   * lets them host this meeting (`assertOwnerOrHostMember`); they then start
   * the room as its host and claim, and the current host drains and hands
   * over as it does for a companion Mac.
   */
  async answerHostOffer(
    member: { sub: string; email: string },
    meetingId: string,
    accept: boolean,
  ): Promise<{ livekitRoom: string }> {
    const meeting = this.meeting(meetingId);
    if (!meeting || meeting.ended_at !== null) throw new RoomError('Meeting is no longer active.', 410, 'meeting_inactive');
    const open = meeting.host_offer_email !== null && meeting.host_offer_at !== null
      && Date.now() - meeting.host_offer_at <= HOST_OFFER_MILLISECONDS;
    if (!open || !isSameMember(this.env, meeting.host_offer_email!, member.email)) {
      throw new RoomError('That offer to host is no longer open.', 409, 'host_not_active');
    }
    if (accept) {
      this.ctx.storage.sql.exec(
        `UPDATE meetings SET host_member_sub = ?, host_member_email = ?, host_offer_identity = NULL,
          host_offer_email = NULL, host_offer_at = NULL WHERE id = ?`,
        member.sub, member.email.trim().toLowerCase(), meetingId,
      );
    } else {
      this.ctx.storage.sql.exec(
        'UPDATE meetings SET host_offer_identity = NULL, host_offer_email = NULL, host_offer_at = NULL WHERE id = ?',
        meetingId,
      );
    }
    return { livekitRoom: meeting.livekit_room };
  }

  /**
   * Where the Host badge must move, if anywhere, and record it as moved. The
   * route writes the LiveKit attribute; a write that fails (the host not yet
   * in the call) is tried again on the next heartbeat, because the record
   * only moves when this is asked again and the host still differs.
   */
  async hostBadgeChange(meetingId: string, written = false): Promise<{ set: string | null; clear: string | null } | null> {
    const meeting = this.meeting(meetingId);
    if (!meeting || meeting.ended_at !== null) return null;
    if (meeting.host_badge_identity === meeting.chair_identity) return null;
    if (written) {
      this.ctx.storage.sql.exec('UPDATE meetings SET host_badge_identity = ? WHERE id = ?', meeting.chair_identity, meetingId);
    }
    return { set: meeting.chair_identity, clear: meeting.host_badge_identity };
  }

  /** The address a guest declared when they knocked, for an offer to host. */
  async guestEmail(meetingId: string, identity: string): Promise<string | null> {
    const row = this.ctx.storage.sql.exec<{ email: string }>(
      `SELECT email FROM join_requests WHERE meeting_id = ? AND identity = ? AND status = 'admitted'
       ORDER BY created_at DESC LIMIT 1`,
      meetingId, identity,
    ).toArray()[0];
    return row?.email?.trim() ? row.email.trim().toLowerCase() : null;
  }

  private isSharedRoom(): boolean {
    return internalRoomSlugs(this.roomEnvironment.INTERNAL_ROOM_MAP).has(this.requiredRoom().slug);
  }

  private assertRoomActive(): void {
    const room = this.requiredRoom();
    if (room.expires_at !== null && room.expires_at <= Date.now()) throw new RoomError('This room link has expired.', 410, 'link_expired');
  }

  /**
   * The meeting still running, after closing one the host abandoned.
   *
   * Only an explicit End writes `ended_at`, so a crashed or force-quit Mac used
   * to leave its meeting `open` indefinitely. Sweeping here rather than on an
   * alarm keeps the rule in one place: every caller that cares whether a
   * meeting is live goes through this, and nothing has to fire on an idle room.
   */
  private openMeeting(): MeetingRow | undefined {
    const meeting = this.ctx.storage.sql.exec<MeetingRow>(
      `SELECT id, livekit_room, started_at, ended_at, title, summary, host_seen_at,
              chair_device_id, chair_identity, pending_chair_device_id, pending_chair_identity, chair_released_at,
              host_offer_identity, host_offer_email, host_offer_at, host_member_sub, host_member_email, host_badge_identity
       FROM meetings WHERE status = 'open' ORDER BY started_at DESC LIMIT 1`,
    ).toArray()[0];
    if (!meeting) return undefined;
    if (Date.now() - meeting.host_seen_at <= STALE_MEETING_MILLISECONDS) return meeting;
    this.closeAbandonedMeeting(meeting.id);
    return undefined;
  }

  /**
   * Same bookkeeping as `endMeeting`, minus the owner check — nobody asked for
   * this one. The SFU room is left to LiveKit's own empty-room timeout: this
   * runs on a read path with no Worker binding to close it, and a host gone
   * this long has no LiveKit room worth closing.
   */
  private closeAbandonedMeeting(meetingId: string): void {
    // It ended when the host stopped renewing, not when somebody noticed:
    // the last lease plus the stale window, never later than now.
    this.ctx.storage.sql.exec(
      `UPDATE meetings SET status = 'ended', ended_at = COALESCE(ended_at, MIN(?, host_seen_at + ?)) WHERE id = ?`,
      Date.now(),
      STALE_MEETING_MILLISECONDS,
      meetingId,
    );
    this.ctx.storage.sql.exec(
      `UPDATE join_requests SET status = 'expired' WHERE meeting_id = ? AND status IN ('waiting', 'admitted')`,
      meetingId,
    );
    this.broadcast({ type: 'meeting.ended', meeting_id: meetingId });
    this.broadcastWaitingCount(meetingId, 0);
  }

  /** Every open meeting past the stale window, ended at its last lease plus the window. */
  private closeStaleMeetings(): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE meetings SET status = 'ended', ended_at = COALESCE(ended_at, MIN(?, host_seen_at + ?))
       WHERE status = 'open' AND host_seen_at < ?`,
      now,
      STALE_MEETING_MILLISECONDS,
      now - STALE_MEETING_MILLISECONDS,
    );
  }

  /**
   * Under five minutes is not a meeting (`MIN_MEETING_MILLISECONDS`): the
   * artifact job marks it so instead of summarizing. Admin, the ledger and
   * the history stop listing it; the row stays for the audit.
   */
  async discardMeeting(meetingId: string): Promise<void> {
    this.assertMeeting(meetingId);
    this.ctx.storage.sql.exec(`UPDATE meetings SET status = 'discarded' WHERE id = ?`, meetingId);
  }

  /**
   * Erase one ended meeting (docs/DATA_REQUESTS.md): every row in
   * this room that names it, in one transaction, and a deletion marker with
   * no content. A meeting already erased answers its marker again, so a retry
   * finishes the copies outside the room. Markers older than 30 days go.
   */
  async eraseMeeting(meetingId: string, requestId: string, now = Date.now()): Promise<ErasureMarker> {
    this.ctx.storage.sql.exec('DELETE FROM erased_meetings WHERE erased_at < ?', now - ERASURE_MARKER_MILLISECONDS);
    const existing = this.erasureMarker(meetingId);
    if (existing) return existing;
    const meeting = this.ctx.storage.sql.exec<{ ended_at: number | null; transcript_document_id: string | null }>(
      'SELECT ended_at, transcript_document_id FROM meetings WHERE id = ?',
      meetingId,
    ).toArray()[0];
    if (!meeting) throw new RoomError('Meeting not found.', 404, 'meeting_not_found');
    if (meeting.ended_at === null) throw new RoomError('End the meeting before erasing it.', 409, 'invalid_request');
    const marker: ErasureMarker = {
      meeting_id: meetingId,
      request_id: requestId,
      erased_at: now,
      transcript_document_id: meeting.transcript_document_id || null,
      document_owner_email: meeting.transcript_document_id ? this.room()?.owner_email ?? null : null,
    };
    this.ctx.storage.transactionSync(() => {
      this.deleteMeetingRows(meetingId);
      this.ctx.storage.sql.exec(
        `INSERT INTO erased_meetings (meeting_id, request_id, erased_at, transcript_document_id, document_owner_email)
         VALUES (?, ?, ?, ?, ?)`,
        marker.meeting_id, marker.request_id, marker.erased_at, marker.transcript_document_id, marker.document_owner_email,
      );
    });
    return marker;
  }

  /** The marker of an erased meeting, or null. */
  erasureMarker(meetingId: string): ErasureMarker | null {
    return this.ctx.storage.sql.exec<ErasureMarker>('SELECT * FROM erased_meetings WHERE meeting_id = ?', meetingId).toArray()[0] ?? null;
  }

  /** Docs purged the transcript: the marker forgets its id and owner. */
  async completeErasure(meetingId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      'UPDATE erased_meetings SET transcript_document_id = NULL, document_owner_email = NULL WHERE meeting_id = ?',
      meetingId,
    );
  }

  /**
   * Every row that names the meeting: each table with a `meeting_id` column
   * (read from the schema, so a table added later is covered), and the
   * `meetings` row. The marker table keeps its own row.
   */
  private deleteMeetingRows(meetingId: string): void {
    const sql = this.ctx.storage.sql;
    const tables = sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name <> 'erased_meetings'",
    ).toArray().map((row) => row.name);
    for (const table of tables) {
      const columns = sql.exec<{ name: string }>(`PRAGMA table_info("${table}")`).toArray();
      if (columns.some((column) => column.name === 'meeting_id')) sql.exec(`DELETE FROM "${table}" WHERE meeting_id = ?`, meetingId);
    }
    sql.exec('DELETE FROM meetings WHERE id = ?', meetingId);
  }

  private meeting(meetingId: string): MeetingRow | undefined {
    // Include ended meetings: finalize/end need the LiveKit room name after
    // status flips to 'ended', and exchange still checks ended_at explicitly.
    return this.ctx.storage.sql.exec<MeetingRow>(
      `SELECT id, livekit_room, started_at, ended_at, title, summary, host_seen_at,
              chair_device_id, chair_identity, pending_chair_device_id, pending_chair_identity, chair_released_at,
              host_offer_identity, host_offer_email, host_offer_at, host_member_sub, host_member_email, host_badge_identity
       FROM meetings WHERE id = ?`,
      meetingId,
    ).toArray()[0];
  }

  private hostLeaseIsActive(meeting: MeetingRow | undefined): boolean {
    return Boolean(meeting && Date.now() - meeting.host_seen_at <= HOST_LEASE_MILLISECONDS);
  }

  /** Last host sighting relevant to this request; 0 when the meeting is gone. */
  private hostLastSeenAt(request: JoinRow): number {
    if (request.meeting_id === PRELIVE_MEETING_ID) {
      const room = this.room();
      const meeting = this.openMeeting();
      return Math.max(Number(room?.host_seen_at ?? 0), Number(meeting?.host_seen_at ?? 0));
    }
    return Number(this.meeting(request.meeting_id)?.host_seen_at ?? 0);
  }

  private softPresenceIsActive(): boolean {
    const room = this.room();
    return Boolean(room?.host_seen_at && Date.now() - room.host_seen_at <= HOST_LEASE_MILLISECONDS);
  }

  private touchSoftPresence(): void {
    this.ctx.storage.sql.exec('UPDATE room SET host_seen_at = ?', Date.now());
  }

  /** Move waiting knocks off the pre-live sentinel onto a live meeting. */
  private attachPreliveWaitingToMeeting(meetingId: string): number {
    const before = this.waitingCount(PRELIVE_MEETING_ID);
    if (before === 0) return 0;
    this.ctx.storage.sql.exec(
      `UPDATE join_requests SET meeting_id = ? WHERE meeting_id = ? AND status = 'waiting'`,
      meetingId,
      PRELIVE_MEETING_ID,
    );
    this.broadcastWaitingCount(meetingId);
    return before;
  }

  private assertHostLease(meeting: MeetingRow): void {
    if (!this.hostLeaseIsActive(meeting)) {
      throw new RoomError('The owner is no longer actively hosting this room.', 409, 'host_not_active');
    }
  }

  /** Lease may have lapsed, but the meeting is still inside the reclaim window. */
  private assertMeetingNotStale(meeting: MeetingRow): void {
    if (Date.now() - meeting.host_seen_at > STALE_MEETING_MILLISECONDS) {
      throw new RoomError('The owner is no longer actively hosting this room.', 409, 'host_not_active');
    }
  }

  private assertMeeting(meetingId: string): void {
    const row = this.ctx.storage.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM meetings WHERE id = ?',
      meetingId,
    ).one();
    if (row.count !== 1) throw new RoomError('Meeting not found.', 404, 'meeting_not_found');
  }

  private joinRequest(requestId: string): JoinRow | undefined {
    return this.ctx.storage.sql.exec<JoinRow>(
      `SELECT id, meeting_id, name, email, identity, status, created_at, lobby_token_hash, booking_token,
              client_app, client_device, on_behalf_of, recording, registered
       FROM join_requests WHERE id = ?`,
      requestId,
    ).toArray()[0];
  }

  private async authenticatedJoinRequest(requestId: string, lobbyToken: string): Promise<JoinRow> {
    // Hash before reading the row: awaiting crypto.subtle releases the DO
    // input gate, so a row read before an await can be stale by the time the
    // caller writes back (e.g. an admit landing between read and update). The
    // comparison itself must stay synchronous for the same reason.
    const providedHash = await sha256(lobbyToken);
    const request = this.joinRequest(requestId);
    if (!request || !constantTimeEqualSync(providedHash, request.lobby_token_hash)) {
      throw new RoomError('Invalid lobby credentials.', 401, 'lobby_credentials_invalid');
    }
    return request;
  }

  private artifact(meetingId: string): ArtifactMaterial {
    const meeting = this.ctx.storage.sql.exec<MeetingRow>(
      'SELECT id, livekit_room, started_at, ended_at, title, summary, host_seen_at FROM meetings WHERE id = ?',
      meetingId,
    ).toArray()[0];
    if (!meeting) throw new RoomError('Meeting not found.', 404, 'meeting_not_found');
    const transcript = this.ctx.storage.sql.exec<{
      id: string; meeting_id: string; speaker_id: string; speaker_name: string;
      language: 'en' | 'pt' | 'de' | 'und'; starts_at_ms: number; ends_at_ms: number; text: string; is_final: number;
    }>(
      `SELECT id, meeting_id, speaker_id, speaker_name, language, starts_at_ms, ends_at_ms, text, is_final
       FROM transcript_segments WHERE meeting_id = ? ORDER BY starts_at_ms, id`,
      meetingId,
    ).toArray().map((row) => ({ ...row, is_final: row.is_final === 1 }));
    return {
      roomSlug: this.requiredRoom().slug,
      meetingId,
      startedAt: meeting.started_at,
      endedAt: meeting.ended_at,
      title: meeting.title,
      summary: meeting.summary,
      transcript,
    };
  }

  private waitingCount(meetingId: string): number {
    return this.ctx.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM join_requests WHERE meeting_id = ? AND status = 'waiting'`,
      meetingId,
    ).one().count;
  }

  private broadcastWaitingCount(meetingId: string, count = this.waitingCount(meetingId)): void {
    this.broadcast({ type: 'lobby.waiting', waiting_count: count, meeting_id: meetingId }, 'guest');
    this.broadcast({ type: 'lobby.waiting', waiting_count: count, meeting_id: meetingId }, 'owner');
  }

  private pruneStaleLurkers(): void {
    // The abandons, counted before they are deleted.
    //
    // This is the one ledger write the Worker cannot make (docs/ADMIN.md §7).
    // Everywhere else the request layer can see the fact; here the fact *is*
    // the absence of one — a visitor who reached the join page and left
    // without ever knocking exists only as a presence row that stopped being
    // heartbeaten, and only this sweep ever sees it go.
    //
    // `stage = 'preview'` is deliberately not required: someone who left at
    // the naming step abandoned just as surely as someone who left at the
    // device check.
    const abandoned = this.ctx.storage.sql.exec<{ n: number; country: string | null; client_app: string | null }>(
      `SELECT COUNT(*) AS n, country, client_app FROM guest_presence
       WHERE seen_at < ? GROUP BY country, client_app`,
      Date.now() - GUEST_PRESENCE_TTL_MILLISECONDS,
    ).toArray();

    this.ctx.storage.sql.exec(
      'DELETE FROM guest_presence WHERE seen_at < ?',
      Date.now() - GUEST_PRESENCE_TTL_MILLISECONDS,
    );

    // After the delete, in one batch, and never awaited: this sweep runs on
    // the way to serving a lobby poll, and an abandon nobody counted is a much
    // smaller loss than a lobby that hung on D1. `recordUsageEvents` swallows
    // its own failures, so the floating promise has nothing to reject with.
    if (abandoned.length > 0) {
      const slug = this.room()?.slug ?? null;
      void recordUsageEvents(this.roomEnvironment, abandoned.flatMap((row) => Array.from(
        // One row per abandon: `usage_events` counts events, and giving it a
        // multiplier column would make every other kind lie by omission.
        // Capped because a sweep after a long idle period should not turn one
        // lobby poll into a thousand inserts.
        { length: Math.min(Math.max(0, row.n), ABANDON_EVENTS_PER_SWEEP) },
        () => ({
          kind: 'abandon' as const,
          room_slug: slug,
          actor_kind: 'guest' as const,
          client_app: row.client_app,
          country: row.country,
        }),
      )));
    }
    // The tokens are keyed by presence id, so they have to die with the rows or
    // the map grows for the lifetime of the object.
    if (this.guestPresenceTokens.size === 0) return;
    const live = new Set(
      this.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM guest_presence')
        .toArray().map((row) => row.id),
    );
    for (const id of this.guestPresenceTokens.keys()) {
      if (!live.has(id)) this.guestPresenceTokens.delete(id);
    }
  }

  private liveLurkers(): GuestPresenceRow[] {
    this.pruneStaleLurkers();
    return this.ctx.storage.sql.exec<GuestPresenceRowSql>(
      `SELECT id, stage, name, city, country, client_app, client_device, seen_at, created_at
       FROM guest_presence ORDER BY created_at ASC`,
    ).toArray().map((row) => guestPresenceToPublic(row, this.guestPresenceTokens.get(row.id) ?? null));
  }

  private broadcast(event: object, role?: SocketAttachment['role'], requestId?: string): void {
    const payload = JSON.stringify(event);
    const sockets = role ? this.ctx.getWebSockets(role) : this.ctx.getWebSockets();
    for (const socket of sockets) {
      if (requestId) {
        const attachment = socket.deserializeAttachment() as SocketAttachment | null;
        if (attachment?.requestId !== requestId) continue;
      }
      try {
        socket.send(payload);
      } catch {
        socket.close(1011, 'Delivery failed');
      }
    }
  }
}

function rowToConfiguration(row: RoomRow): RoomConfiguration {
  return {
    slug: row.slug,
    ownerSub: row.owner_sub,
    ownerEmail: row.owner_email,
    ownerName: row.owner_name,
    kind: row.kind === 'temporary' ? 'temporary' : 'permanent',
    expiresAt: row.expires_at,
  };
}

/**
 * Whether this caller is the recorded host: by signed install id when the
 * host was recorded with one, otherwise by identity with no install id.
 */
function holdsHost(env: Pick<Env, 'IDENTITY_DOMAINS'>, meeting: MeetingRow, deviceID: string | null, identity: string | null): boolean {
  if (meeting.chair_identity === null && meeting.chair_device_id === null) return true;
  if (meeting.chair_device_id !== null) return meeting.chair_device_id === deviceID;
  return deviceID === null && identity !== null && meeting.chair_identity !== null
    && isSameMember(env, meeting.chair_identity, identity);
}

function meetingConnection(row: MeetingRow, hostSeenAt = row.host_seen_at): MeetingConnection {
  return {
    id: row.id,
    livekitRoom: row.livekit_room,
    startedAt: row.started_at,
    hostLeaseExpiresAt: hostSeenAt + HOST_LEASE_MILLISECONDS,
    hostIdentity: row.chair_identity ?? null,
    pendingHostIdentity: row.pending_chair_identity ?? null,
    hostOfferIdentity: row.host_offer_identity !== null && row.host_offer_at !== null
      && Date.now() - row.host_offer_at <= HOST_OFFER_MILLISECONDS ? row.host_offer_identity : null,
    chairIdentity: row.chair_identity ?? null,
    pendingChairIdentity: row.pending_chair_identity ?? null,
  };
}

function joinRowToPublic(row: JoinRow): LobbyRequest {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    name: row.name,
    email: row.email,
    identity: row.identity,
    status: row.status,
    createdAt: row.created_at,
    bookingToken: row.booking_token || null,
    client: clientFromColumns(row.client_app, row.client_device),
    on_behalf_of: row.on_behalf_of,
    recording: row.recording === 1,
    ...(row.registered === 1 ? { registered: true } : {}),
  };
}

function displayNameFromEmail(email: string): string {
  const local = email.split('@', 1)[0]?.split('+', 1)[0] ?? '';
  const words = local.split(/[._-]+/u).filter(Boolean);
  if (words.length === 0) return 'the attendee';
  return words.map((word) => word[0]!.toLocaleUpperCase() + word.slice(1)).join(' ');
}

function guestPresenceToPublic(row: GuestPresenceRowSql, bookingToken: string | null): GuestPresenceRow {
  const stage = row.stage === 'naming' || row.stage === 'preview' ? row.stage : 'visit';
  return {
    id: row.id,
    stage,
    name: row.name,
    city: row.city,
    country: row.country,
    bookingToken,
    client: clientFromColumns(row.client_app, row.client_device),
    seenAt: row.seen_at,
    createdAt: row.created_at,
  };
}

/**
 * Rows written before migration 8 — and rows from clients that never sent the
 * field — have nulls here, so a partial pair is treated as no answer rather
 * than half of one.
 */
function clientFromColumns(app: string | null, device: string | null): GuestClient | null {
  return guestClientSchema.safeParse({ app, device }).data ?? null;
}

/** Domain only — admin must never surface a guest's full email. */
function emailDomain(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at < 1 || at === trimmed.length - 1) return null;
  const domain = trimmed.slice(at + 1);
  if (!domain.includes('.') || domain.includes('@')) return null;
  return domain;
}

const QUALITY_RANK: Record<string, number> = { excellent: 1, good: 2, poor: 3, lost: 4 };

function worseQuality(current: string | null, next: string): string {
  if (!current) return next;
  return (QUALITY_RANK[next] ?? 0) > (QUALITY_RANK[current] ?? 0) ? next : current;
}

/** The first non-empty line of a markdown summary, without its heading marks. */
function firstLine(summary: string | null): string | null {
  if (!summary) return null;
  for (const raw of summary.split('\n')) {
    const line = raw.replace(/^[#>\-*\s]+/u, '').trim();
    if (line) return line.slice(0, 200);
  }
  return null;
}

function normalizeMeetingKind(
  value: string | null,
): 'uncategorized' | 'status' | 'lead' | 'project' | 'internal' | 'partner' {
  switch (value) {
    case 'status':
    case 'lead':
    case 'project':
    case 'internal':
    case 'partner':
    case 'uncategorized':
      return value;
    default:
      return 'uncategorized';
  }
}

export class RoomError extends ControlError {}

/** Deletion markers last as long as the backups (MZ, 2026-10-11). */
export const ERASURE_MARKER_MILLISECONDS = 30 * 24 * 60 * 60_000;

export type ErasureMarker = {
  meeting_id: string;
  request_id: string;
  erased_at: number;
  transcript_document_id: string | null;
  document_owner_email: string | null;
};

function readDecisionCandidates(json: string | null): MeetingDecisionCandidate[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is MeetingDecisionCandidate => typeof item === 'object' && item !== null && typeof (item as MeetingDecisionCandidate).what === 'string')
      .map((item) => ({ ...item, decision_id: item.decision_id ?? null, dismissed: item.dismissed === true }));
  } catch {
    return [];
  }
}

function readActionItems(json: string | null): MeetingActionItem[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is MeetingActionItem => typeof item === 'object' && item !== null && typeof (item as MeetingActionItem).what === 'string');
  } catch {
    return [];
  }
}

/** Case, punctuation and spacing folded: the same commitment written twice matches. */
export function actionItemKey(what: string): string {
  return what.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
}
