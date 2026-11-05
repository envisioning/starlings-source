// The account-level meeting ledger (D1 `meet-usage`). See docs/ADMIN.md §6-§7
// and `migrations/0027_meetings_ledger.sql`.
//
// Two rules govern everything here, and they are the same two the CRM sync
// follows:
//
// 1. **Never throw.** A ledger write must not fail a join, an admission, a
//    finalize, or an email. The number on an operations page is worth less
//    than the meeting it describes.
// 2. **Written by the Worker, not the DO.** A room's Durable Object knows
//    about one room. Aggregation across rooms is a request-layer concern, and
//    `ctx.waitUntil` already carries best-effort side work there.

import { publicRoomSlugs } from './member-rooms';
import type { AdminMeetingRecord, AdminRoomSnapshot } from './room-coordinator';
import { MCP_CHANGES_PAGE_SIZE, parseMcpChangeCursor } from '@starlings/contracts/mcp';
import { ControlError } from './errors';
import type { MeetingChangesResponse } from './contracts';
import { roomStub } from './do-jurisdiction';

/** The closed set in `usage_events.kind`. */
export type UsageEventKind =
  | 'signin'
  | 'knock'
  | 'admit'
  | 'reject'
  | 'abandon'
  | 'join'
  | 'meeting_start'
  | 'meeting_end'
  | 'summary_generated'
  | 'crm_sync_failed'
  | 'feedback_filed';

export interface UsageEvent {
  kind: UsageEventKind;
  room_slug?: string | null;
  meeting_id?: string | null;
  actor_kind?: 'owner' | 'guest' | 'system' | null;
  client_app?: string | null;
  country?: string | null;
}

function warn(message: string, error: unknown): void {
  console.warn(JSON.stringify({
    level: 'warn',
    message,
    error: error instanceof Error ? error.message : 'Unknown error',
  }));
}

/** Country from the edge, never an IP. Same source guest presence already uses. */
export function eventCountry(request: Request): string | null {
  const country = request.cf?.country;
  return typeof country === 'string' && country.trim() ? country.trim() : null;
}

/** Events that happen once per meeting: a retried job must not count them twice. */
const ONCE_PER_MEETING = new Set<UsageEvent['kind']>(['meeting_end']);

export async function recordUsageEvent(env: Env, event: UsageEvent): Promise<void> {
  try {
    const once = event.meeting_id && ONCE_PER_MEETING.has(event.kind);
    await env.USAGE.prepare(
      once
        ? `INSERT INTO usage_events (ts, kind, room_slug, meeting_id, actor_kind, client_app, country)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
            WHERE NOT EXISTS (SELECT 1 FROM usage_events WHERE kind = ?2 AND meeting_id = ?4)`
        : `INSERT INTO usage_events (ts, kind, room_slug, meeting_id, actor_kind, client_app, country)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      Date.now(),
      event.kind,
      event.room_slug ?? null,
      event.meeting_id ?? null,
      event.actor_kind ?? null,
      event.client_app ?? null,
      event.country ?? null,
    ).run();
  } catch (error) {
    warn('ledger.event.write.failed', error);
  }
}

/**
 * Several events in one round trip.
 *
 * The presence sweep in the Durable Object can produce a handful of abandons
 * at once, and it fires this without awaiting it — so this swallows its own
 * failures like everything else here, and the floating promise it returns has
 * nothing to reject with.
 */
export async function recordUsageEvents(env: Env, events: UsageEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    const statement = env.USAGE.prepare(
      `INSERT INTO usage_events (ts, kind, room_slug, meeting_id, actor_kind, client_app, country)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    );
    const ts = Date.now();
    await env.USAGE.batch(events.map((event) => statement.bind(
      ts,
      event.kind,
      event.room_slug ?? null,
      event.meeting_id ?? null,
      event.actor_kind ?? null,
      event.client_app ?? null,
      event.country ?? null,
    )));
  } catch (error) {
    warn('ledger.events.write.failed', error);
  }
}

/**
 * Open the ledger row when the host starts hosting.
 *
 * Deliberately does not overwrite: a re-start of the same meeting id must not
 * reset counters a completion has already filled in. The completion upsert
 * below owns every column but these.
 */
/**
 * Funnel and meeting-count events are kept 13 months (MZ, 2026-10-01,
 *): a year over year comparison, and no longer.
 */
export async function pruneUsageEvents(env: Env): Promise<number> {
  const result = await env.USAGE.prepare(
    "DELETE FROM usage_events WHERE ts < CAST(strftime('%s', 'now', '-13 months') AS INTEGER) * 1000",
  ).run();
  return result.meta.changes ?? 0;
}

export async function recordMeetingStart(
  env: Env,
  input: { meetingId: string; roomSlug: string; hostEmail: string; startedAt: number },
): Promise<void> {
  try {
    await env.USAGE.prepare(
      `INSERT INTO meetings_ledger (meeting_id, room_slug, host_email, started_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(meeting_id) DO NOTHING`,
    ).bind(input.meetingId, input.roomSlug, input.hostEmail, input.startedAt).run();
  } catch (error) {
    warn('ledger.meeting.start.failed', error);
  }
}

/**
 * Write the finished shape of a meeting.
 *
 * Idempotent by construction — the same record written twice produces the same
 * row — which is what lets the backfill re-run and a queue message retry
 * without anybody reasoning about ordering.
 */
/** A discarded meeting (under a minute) leaves the ledger; its start row was provisional. */
export async function forgetMeetingRecord(env: Env, meetingId: string): Promise<void> {
  try {
    await env.USAGE.prepare('DELETE FROM meetings_ledger WHERE meeting_id = ?1').bind(meetingId).run();
  } catch (error) {
    warn('ledger.meeting.forget.failed', error);
  }
}

export async function recordMeetingRecord(env: Env, record: AdminMeetingRecord): Promise<void> {
  try {
    await env.USAGE.prepare(
      `INSERT INTO meetings_ledger (
         meeting_id, room_slug, host_email, title, started_at, ended_at,
         participant_count, guest_count, guest_domains, client_seconds,
         was_booked, meeting_kind, summary_generated, crm_synced,
         worst_quality
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
       ON CONFLICT(meeting_id) DO UPDATE SET
         room_slug = excluded.room_slug,
         host_email = excluded.host_email,
         title = excluded.title,
         started_at = excluded.started_at,
         ended_at = excluded.ended_at,
         participant_count = excluded.participant_count,
         guest_count = excluded.guest_count,
         guest_domains = excluded.guest_domains,
         client_seconds = excluded.client_seconds,
         was_booked = excluded.was_booked,
         meeting_kind = excluded.meeting_kind,
         summary_generated = excluded.summary_generated,
         crm_synced = excluded.crm_synced,
         worst_quality = excluded.worst_quality`,
    ).bind(
      record.meeting_id,
      record.room_slug,
      record.host_email,
      record.title,
      record.started_at,
      record.ended_at,
      record.participant_count,
      record.guest_count,
      JSON.stringify(record.guest_domains),
      record.client_seconds,
      record.was_booked ? 1 : 0,
      record.meeting_kind,
      record.summary_generated ? 1 : 0,
      record.crm_synced ? 1 : 0,
      record.worst_quality,
    ).run();
  } catch (error) {
    warn('ledger.meeting.record.failed', error);
  }
}

/**
 * Every meeting the account has a record of, newest first.
 *
 * Returns the same `AdminMeetingRecord` the fan-out produces, so `/admin` can
 * change where its history comes from without changing what it renders — and
 * so the fallback in `adminOverview` is a swap rather than a second code path.
 *
 * An empty array is an honest answer for an empty ledger *and* for an
 * unreachable D1; the caller distinguishes them by falling back, never by
 * treating this as an error.
 */
export async function ledgerMeetings(env: Env, limit = 2000): Promise<AdminMeetingRecord[]> {
  try {
    const { results } = await env.USAGE.prepare(
      `SELECT meeting_id, room_slug, host_email, title, started_at, ended_at,
              participant_count, guest_count, guest_domains, webhook_seconds,
              client_seconds, was_booked, meeting_kind, summary_generated,
              crm_synced, worst_quality
       FROM meetings_ledger ORDER BY started_at DESC LIMIT ?1`,
    ).bind(limit).all<{
      meeting_id: string;
      room_slug: string;
      host_email: string;
      title: string | null;
      started_at: number;
      ended_at: number | null;
      participant_count: number;
      guest_count: number;
      guest_domains: string;
      webhook_seconds: number | null;
      client_seconds: number;
      was_booked: number;
      meeting_kind: string | null;
      summary_generated: number;
      crm_synced: number;
      worst_quality: string | null;
    }>();
    return results.map((row) => ({
      meeting_id: row.meeting_id,
      room_slug: row.room_slug,
      host_email: row.host_email,
      title: row.title,
      started_at: row.started_at,
      ended_at: row.ended_at,
      duration_ms: row.ended_at == null ? null : Math.max(0, row.ended_at - row.started_at),
      participant_count: row.participant_count,
      guest_count: row.guest_count,
      guest_domains: parseDomains(row.guest_domains),
      was_booked: row.was_booked === 1,
      meeting_kind: row.meeting_kind,
      worst_quality: row.worst_quality,
      summary_generated: row.summary_generated === 1,
      crm_synced: row.crm_synced === 1,
      // Phase 3 fills `webhook_seconds` from LiveKit itself; until a row has
      // one, the client-reported figure is the only figure. Preferring the
      // webhook here is what makes that migration a data change, not a code
      // change.
      client_seconds: row.webhook_seconds ?? row.client_seconds,
    }));
  } catch (error) {
    warn('ledger.meetings.query.failed', error);
    return [];
  }
}

/** The owner's finalized meetings, ordered by the same cursor as thread changes. */
export async function ledgerMeetingChanges(
  env: Env,
  roomSlug: string,
  since: string,
  limit = MCP_CHANGES_PAGE_SIZE,
): Promise<MeetingChangesResponse> {
  const cursor = parseMcpChangeCursor(since);
  if (!cursor) throw new ControlError('The change cursor is invalid.', 400, 'invalid_request');
  const boundedLimit = Math.min(Math.max(limit, 1), MCP_CHANGES_PAGE_SIZE);
  const where = cursor.id === null
    ? 'room_slug = ?1 AND ended_at IS NOT NULL AND ended_at > ?2'
    : 'room_slug = ?1 AND ended_at IS NOT NULL AND (ended_at > ?2 OR (ended_at = ?2 AND meeting_id > ?3))';
  const query = cursor.id === null
    ? env.USAGE.prepare(
      `SELECT meeting_id, room_slug, host_email, title, ended_at AS changed_at
         FROM meetings_ledger WHERE ${where}
        ORDER BY ended_at ASC, meeting_id ASC LIMIT ?3`,
    ).bind(roomSlug, cursor.changed_at, boundedLimit + 1)
    : env.USAGE.prepare(
      `SELECT meeting_id, room_slug, host_email, title, ended_at AS changed_at
         FROM meetings_ledger WHERE ${where}
        ORDER BY ended_at ASC, meeting_id ASC LIMIT ?4`,
    ).bind(roomSlug, cursor.changed_at, cursor.id, boundedLimit + 1);
  const { results } = await query.all<{
    meeting_id: string;
    room_slug: string;
    host_email: string;
    title: string | null;
    changed_at: number;
  }>();
  return {
    meetings: results.slice(0, boundedLimit),
    has_more: results.length > boundedLimit,
  };
}

function parseDomains(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Fill the ledger from the rooms that still exist.
 *
 * Idempotent, so it is safe to run again — and it must be run at least once,
 * because the ledger's day one is otherwise the account's day one. It can only
 * reach the public rooms (member-rooms.ts): a slug already removed from the
 * map is exactly the history this table exists to preserve, and exactly the
 * history that is already unreachable.
 */
export async function backfillLedgerFromRooms(
  env: Env,
): Promise<{ rooms: number; meetings: number; degraded: string[] }> {
  const slugs = [...(await publicRoomSlugs(env))];
  const degraded: string[] = [];
  let meetings = 0;

  for (const slug of slugs) {
    let snapshot: AdminRoomSnapshot;
    try {
      const room = await roomStub(env, slug);
      snapshot = await room.adminSnapshot(slug);
    } catch (error) {
      warn('ledger.backfill.room.failed', error);
      degraded.push(slug);
      continue;
    }
    for (const record of snapshot.meetings) {
      await recordMeetingRecord(env, record);
      meetings += 1;
    }
  }

  return { rooms: slugs.length - degraded.length, meetings, degraded: degraded.sort() };
}
