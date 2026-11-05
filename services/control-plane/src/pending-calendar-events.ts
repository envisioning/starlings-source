// Events proposed from mail forwarded to calendar@ (migration 0040).
//
// A row is the extractor's answer waiting on Home: Add writes it to the
// calendar through the same create path the editors use and deletes the
// row; Discard deletes it; a week unanswered and the sweep deletes it. The
// owner reads only their own rows. The mail's text never reaches this file —
// `inbound-email.ts` hands over the extracted rows and one digest of the
// source, so the same mail forwarded twice adds nothing while its rows are
// pending.

import type { PendingCalendarEvent } from '@starlings/contracts';
import { PENDING_CALENDAR_EVENT_TTL_MILLISECONDS } from '@starlings/contracts/limits';
import { createCalendarEvent, type CalendarEventSummary } from './calendar';
import type { ExtractedEvent } from './calendar-extract';
import type { OwnerSession } from './contracts';
import { randomToken } from './crypto';
import { ControlError } from './errors';

interface Row {
  id: string;
  owner_sub: string;
  source_hash: string;
  title: string;
  start: string;
  end: string;
  all_day: number;
  time_zone: string | null;
  location: string | null;
  notes: string | null;
  attendees: string;
  source_subject: string | null;
  source_from: string | null;
  confidence: number;
  created_at: number;
  expires_at: number;
}

export interface PendingSource {
  hash: string;
  subject: string | null;
  from: string | null;
}

/** True when this mail's rows are already pending for this owner. */
export async function hasPendingSource(env: Env, ownerSub: string, hash: string): Promise<boolean> {
  const row = await env.USAGE.prepare(
    'SELECT 1 AS present FROM pending_calendar_events WHERE owner_sub = ?1 AND source_hash = ?2 AND expires_at > ?3 LIMIT 1',
  ).bind(ownerSub, hash, Date.now()).first<{ present: number }>();
  return row !== null;
}

/** Write one row per event; the ids come back in the order given. */
export async function storePendingEvents(
  env: Env,
  ownerSub: string,
  source: PendingSource,
  events: ExtractedEvent[],
  now = Date.now(),
): Promise<string[]> {
  if (events.length === 0) return [];
  const statement = env.USAGE.prepare(`
    INSERT INTO pending_calendar_events
      (id, owner_sub, source_hash, title, start, end, all_day, time_zone, location, notes, attendees,
       source_subject, source_from, confidence, created_at, expires_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
  `);
  const ids = events.map(() => `pce_${randomToken(12)}`);
  await env.USAGE.batch(events.map((event, index) => statement.bind(
    ids[index],
    ownerSub,
    source.hash,
    event.title,
    event.start,
    event.end,
    event.all_day ? 1 : 0,
    event.time_zone,
    event.location,
    event.notes,
    JSON.stringify(event.attendees),
    source.subject,
    source.from,
    event.confidence,
    now,
    now + PENDING_CALENDAR_EVENT_TTL_MILLISECONDS,
  )));
  return ids;
}

/** The owner's rows, soonest first. Expired rows are not returned; the sweep removes them. */
export async function listPendingEvents(env: Env, ownerSub: string, now = Date.now()): Promise<PendingCalendarEvent[]> {
  const { results } = await env.USAGE.prepare(
    'SELECT * FROM pending_calendar_events WHERE owner_sub = ?1 AND expires_at > ?2 ORDER BY start ASC, created_at ASC LIMIT 50',
  ).bind(ownerSub, now).all<Row>();
  return results.map(wire);
}

async function pendingRow(env: Env, ownerSub: string, id: string): Promise<Row> {
  const row = await env.USAGE.prepare(
    'SELECT * FROM pending_calendar_events WHERE id = ?1 AND owner_sub = ?2 AND expires_at > ?3',
  ).bind(id, ownerSub, Date.now()).first<Row>();
  if (!row) throw new ControlError('That proposed event is gone.', 404);
  return row;
}

/**
 * Write the row to the calendar and drop it. The people the mail named go
 * into the description, not the guest list: an invitation from a forwarded
 * confirmation would reach people who did not ask for one.
 */
export async function addPendingEvent(
  env: Env,
  owner: OwnerSession,
  id: string,
  calendarId?: string,
): Promise<CalendarEventSummary> {
  const row = await pendingRow(env, owner.sub, id);
  const attendees = readAttendees(row.attendees);
  const description = [
    row.notes,
    attendees.length > 0 ? `With: ${attendees.join(', ')}` : null,
    row.source_subject ? `From email: ${row.source_subject}` : null,
  ].filter((line): line is string => Boolean(line)).join('\n\n');
  const event = await createCalendarEvent(env, owner, {
    title: row.title,
    start: row.start,
    end: row.end,
    attendees: [],
    ...(calendarId ? { calendarId } : {}),
    ...(row.all_day ? { allDay: true } : {}),
    ...(description ? { description } : {}),
    ...(row.location ? { location: row.location } : {}),
    ...(row.time_zone && !row.all_day ? { timeZone: row.time_zone } : {}),
  });
  await deleteRow(env, owner.sub, id);
  return event;
}

export async function discardPendingEvent(env: Env, ownerSub: string, id: string): Promise<void> {
  await pendingRow(env, ownerSub, id);
  await deleteRow(env, ownerSub, id);
}

async function deleteRow(env: Env, ownerSub: string, id: string): Promise<void> {
  await env.USAGE.prepare('DELETE FROM pending_calendar_events WHERE id = ?1 AND owner_sub = ?2').bind(id, ownerSub).run();
}

/** Rows past their week, for the scheduled sweep. */
export async function sweepPendingEvents(env: Env, now = Date.now()): Promise<number> {
  const result = await env.USAGE.prepare('DELETE FROM pending_calendar_events WHERE expires_at <= ?1').bind(now).run();
  return result.meta.changes ?? 0;
}

function wire(row: Row): PendingCalendarEvent {
  return {
    id: row.id,
    title: row.title,
    start: row.start,
    end: row.end,
    all_day: row.all_day === 1,
    time_zone: row.time_zone,
    location: row.location,
    notes: row.notes,
    attendees: readAttendees(row.attendees),
    source_subject: row.source_subject,
    source_from: row.source_from,
    confidence: row.confidence,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

function readAttendees(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
