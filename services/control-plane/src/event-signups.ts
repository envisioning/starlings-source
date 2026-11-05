/**
 * The event sign-up store seam (docs/SESSIONS.md §0,
 * docs/WORKSPACE_STORE.md §The seam).
 *
 * Each exported function sends a `d1` workspace to its own D1 and a `core`
 * workspace (Envisioning) to Core's signed `meet-session-*` routes
 * (envisioning/core). Both answer the shapes in
 * `@starlings/contracts/event-signups` (fold rule F1), so the page, the register
 * endpoint, the mails, the join card and auto-admit do not know which store
 * answered.
 *
 * A store that cannot answer is an error, never an empty answer: a page for a
 * real event must not read as "no such event" because Core is down.
 *
 * Never log a token, a token hash, an address or a registration list here.
 */
import { z } from 'zod';
import {
  SESSION_REGISTRATION_CAP,
  eventRegistrationMailRecordSchema,
  eventRegistrationRecordSchema,
  eventRegistrationResolutionSchema,
  sessionClosedReason,
  sessionClosedReasonSchema,
  sessionCovers,
  sessionEventRecordSchema,
  type EventRegistrationMailRecord,
  type EventRegistrationRecord,
  type EventRegistrationResolution,
  type SessionEventRecord,
  type SessionMailKind,
  type SessionRegisterResult,
} from '@starlings/contracts/event-signups';
import { CrmSyncError, coreFailure, readCoreJson, signedCoreFetch } from './crm';
import { usesCore } from './work-store';
import { sha256Hex } from './crypto';

/** An event without an end runs one hour. */
const DEFAULT_SESSION_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** What a register call carries: Meet mints the token and the calendar id. */
export interface SessionRegisterInput {
  /** A caller-given id keeps ids across stores (fold rule F3). */
  id?: string;
  name: string;
  email: string;
  join_token: string;
  ics_uid: string;
}

/** SHA-256 as lower-case hex, the form both stores give token hashes in. */
export { sha256Hex };

function storeDown(): CrmSyncError {
  return new CrmSyncError('Couldn’t reach the event store. Try again.', 503);
}

/** A read that lost its connection goes again once, after this pause. */
const READ_RETRY_PAUSE_MS = 500;

/**
 * One signed Core call. A network failure is a 503: the store did not answer.
 * A GET goes again once first: on 2026-10-18 one lost connection in the
 * reminder sweep counted `event.reminders.failed` and mailed MZ.
 */
async function core(env: Env, path: string, init: { method: string; body?: unknown; searchParams?: Record<string, string> }): Promise<Response> {
  const send = () => signedCoreFetch(env, path, {
    method: init.method,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.searchParams ? { searchParams: init.searchParams } : {}),
  });
  try {
    return await send();
  } catch (error) {
    if (error instanceof CrmSyncError) throw error;
    if (init.method !== 'GET') throw storeDown();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, READ_RETRY_PAUSE_MS));
  try {
    return await send();
  } catch (error) {
    if (error instanceof CrmSyncError) throw error;
    throw storeDown();
  }
}

const eventsBody = z.object({ events: z.array(sessionEventRecordSchema) });

async function coreEvents(env: Env, searchParams: Record<string, string>, route: string): Promise<SessionEventRecord[]> {
  const response = await core(env, '/api/public/meet-session-events', { method: 'GET', searchParams });
  if (response.status === 404) return [];
  if (!response.ok) throw coreFailure('session event read', response);
  return (await readCoreJson(response, eventsBody, route)).events;
}

// ---------------------------------------------------------------------------
// D1. Rows as the tables hold them; times are milliseconds.

interface EventRow {
  id: string;
  title: string;
  description: string | null;
  body: string | null;
  image_url: string | null;
  public_slug: string | null;
  starts_at: number | null;
  ends_at: number | null;
  time_zone: string | null;
  room_slug: string | null;
  cta_url: string | null;
  cta_label: string | null;
  follow_up_note: string | null;
  registration_count: number;
  created_by: string | null;
}

interface RegistrationRow {
  id: string;
  event_id: string;
  name: string;
  email: string | null;
  join_token: string;
  source: 'meet' | 'luma';
  status: 'registered' | 'cancelled';
  ics_uid: string;
  ics_sequence: number;
  confirmation_sent_at: number | null;
  reminder_sent_at: number | null;
  follow_up_sent_at: number | null;
  created_at: number;
}

const EVENT_SELECT = `
  SELECT e.id, e.title, e.description, e.body, e.image_url, e.public_slug, e.starts_at, e.ends_at, e.time_zone, e.room_slug,
         e.cta_url, e.cta_label, e.follow_up_note, e.created_by,
         (SELECT count(*) FROM event_registrations r
           WHERE r.event_id = e.id AND r.source = 'meet' AND r.status = 'registered') AS registration_count
    FROM events e
   WHERE e.public_slug IS NOT NULL AND e.room_slug IS NOT NULL AND e.starts_at IS NOT NULL`;

const REGISTRATION_SELECT = `
  SELECT id, event_id, name, email, join_token, source, status, ics_uid, ics_sequence,
         confirmation_sent_at, reminder_sent_at, follow_up_sent_at, created_at
    FROM event_registrations`;

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

function eventRecord(row: EventRow): SessionEventRecord {
  const startsAt = row.starts_at as number;
  return {
    id: row.id,
    slug: row.public_slug as string,
    title: row.title,
    description: row.description,
    body: row.body,
    image_url: row.image_url,
    // A D1 event is a call in one of the workspace's rooms.
    attendance: 'online',
    // The page reads the length from the start and the end.
    duration_minutes: null,
    starts_at: new Date(startsAt).toISOString(),
    ends_at: new Date(row.ends_at && row.ends_at > startsAt ? row.ends_at : startsAt + DEFAULT_SESSION_MS).toISOString(),
    time_zone: row.time_zone,
    room_slug: row.room_slug as string,
    cta_url: row.cta_url,
    cta_label: row.cta_label,
    follow_up_note: row.follow_up_note,
    registration_count: Number(row.registration_count),
    created_by: row.created_by,
  };
}

function registrationRecord(row: RegistrationRow): EventRegistrationRecord {
  return {
    id: row.id,
    event_id: row.event_id,
    name: row.name,
    join_token: row.join_token,
    source: row.source,
    status: row.status,
    ics_uid: row.ics_uid,
    ics_sequence: Number(row.ics_sequence),
    confirmation_sent_at: iso(row.confirmation_sent_at),
    reminder_sent_at: iso(row.reminder_sent_at),
    follow_up_sent_at: iso(row.follow_up_sent_at),
    created_at: iso(row.created_at) as string,
  };
}

async function d1Events(env: Env, where: string, binds: unknown[]): Promise<SessionEventRecord[]> {
  const { results } = await env.USAGE.prepare(`${EVENT_SELECT} ${where}`).bind(...binds).all<EventRow>();
  return results.map(eventRecord);
}

async function d1RegistrationByEmail(env: Env, eventId: string, email: string): Promise<RegistrationRow | null> {
  return env.USAGE.prepare(`${REGISTRATION_SELECT} WHERE event_id = ?1 AND source = 'meet' AND email = ?2`)
    .bind(eventId, email)
    .first<RegistrationRow>();
}

// ---------------------------------------------------------------------------
// The seam.

/** A session event by its page slug, or null when there is none. */
export async function sessionEventBySlug(env: Env, slug: string): Promise<SessionEventRecord | null> {
  if (usesCore(env)) {
    const [event] = await coreEvents(env, { slug }, 'GET /api/public/meet-session-events?slug=');
    return event ?? null;
  }
  const [event] = await d1Events(env, 'AND e.public_slug = ?1', [slug]);
  return event ?? null;
}

/** A session event by id, or null when there is none. */
export async function sessionEventById(env: Env, id: string): Promise<SessionEventRecord | null> {
  if (usesCore(env)) {
    const [event] = await coreEvents(env, { id }, 'GET /api/public/meet-session-events?id=');
    return event ?? null;
  }
  const [event] = await d1Events(env, 'AND e.id = ?1', [id]);
  return event ?? null;
}

/** The session events in a room whose window covers `at` (SESSIONS.md §7). */
export async function sessionEventsCovering(env: Env, room: string, at: Date): Promise<SessionEventRecord[]> {
  const events = usesCore(env)
    ? await coreEvents(env, { room, at: at.toISOString() }, 'GET /api/public/meet-session-events?room=')
    : await d1Events(env, 'AND e.room_slug = ?1 AND e.starts_at BETWEEN ?2 AND ?3', [room, at.getTime() - DAY_MS, at.getTime() + DAY_MS]);
  return events.filter((event) => sessionCovers(event, at));
}

/** The session events that start in [from, to). */
export async function sessionEventsStarting(env: Env, from: Date, to: Date): Promise<SessionEventRecord[]> {
  if (usesCore(env)) {
    return coreEvents(env, { from: from.toISOString(), to: to.toISOString() }, 'GET /api/public/meet-session-events?from=');
  }
  return d1Events(env, 'AND e.starts_at >= ?1 AND e.starts_at < ?2 ORDER BY e.starts_at', [from.getTime(), to.getTime()]);
}

/**
 * Sign one address up. Idempotent by address: a second call returns the first
 * registration and its token, and a cancelled one comes back with the same
 * token. Closed at the start; full at the cap, except for an address that
 * already signed up, which gets its link again.
 */
export async function registerForSession(
  env: Env,
  event: SessionEventRecord,
  input: SessionRegisterInput,
  now: Date = new Date(),
): Promise<SessionRegisterResult> {
  const email = input.email.trim().toLowerCase();
  if (usesCore(env)) {
    const response = await core(env, `/api/public/meet-session-events/${encodeURIComponent(event.id)}/registrations`, {
      method: 'POST',
      body: { ...(input.id ? { id: input.id } : {}), name: input.name, email, join_token: input.join_token, ics_uid: input.ics_uid },
    });
    if (response.status === 409) {
      const body = await readCoreJson(response, z.object({ reason: sessionClosedReasonSchema }), 'POST /api/public/meet-session-events/:id/registrations (409)');
      return { kind: 'refused', reason: body.reason };
    }
    if (response.status === 404) return { kind: 'refused', reason: 'started' };
    if (!response.ok) throw coreFailure('session register', response);
    const body = await readCoreJson(
      response,
      z.object({ created: z.boolean(), registration: eventRegistrationRecordSchema }),
      'POST /api/public/meet-session-events/:id/registrations',
    );
    return { kind: 'registered', created: body.created, registration: body.registration };
  }

  if (sessionClosedReason({ starts_at: event.starts_at, registration_count: 0 }, now) === 'started') {
    return { kind: 'refused', reason: 'started' };
  }
  const existing = await d1RegistrationByEmail(env, event.id, email);
  if (existing) {
    if (existing.status === 'cancelled') {
      await env.USAGE.prepare(`UPDATE event_registrations SET status = 'registered', name = ?2 WHERE id = ?1`)
        .bind(existing.id, input.name)
        .run();
      return { kind: 'registered', created: false, registration: registrationRecord({ ...existing, status: 'registered', name: input.name }) };
    }
    return { kind: 'registered', created: false, registration: registrationRecord(existing) };
  }
  // One statement checks the cap and inserts, so two sign-ups at once cannot
  // pass it. The unique index keeps one row per address.
  const result = await env.USAGE.prepare(`
    INSERT INTO event_registrations (id, event_id, name, email, join_token, source, status, ics_uid, ics_sequence, created_at)
    SELECT ?1, ?2, ?3, ?4, ?5, 'meet', 'registered', ?6, 0, ?7
     WHERE (SELECT count(*) FROM event_registrations
             WHERE event_id = ?2 AND source = 'meet' AND status = 'registered') < ?8
    ON CONFLICT DO NOTHING`)
    .bind(input.id ?? crypto.randomUUID(), event.id, input.name, email, input.join_token, input.ics_uid, now.getTime(), SESSION_REGISTRATION_CAP)
    .run();
  const row = await d1RegistrationByEmail(env, event.id, email);
  if (row) return { kind: 'registered', created: result.meta.changes > 0, registration: registrationRecord(row) };
  return { kind: 'refused', reason: 'full' };
}

/** SHA-256 hex of each live token on an event, sorted. Never a token, never an address. */
export async function sessionTokenHashes(env: Env, eventId: string): Promise<string[]> {
  if (usesCore(env)) {
    const response = await core(env, `/api/public/meet-session-events/${encodeURIComponent(eventId)}/token-hashes`, { method: 'GET' });
    if (response.status === 404) return [];
    if (!response.ok) throw coreFailure('session token read', response);
    return (await readCoreJson(response, z.object({ hashes: z.array(z.string()) }), 'GET /api/public/meet-session-events/:id/token-hashes')).hashes;
  }
  const { results } = await env.USAGE.prepare(
    `SELECT join_token FROM event_registrations WHERE event_id = ?1 AND source = 'meet' AND status = 'registered'`,
  ).bind(eventId).all<{ join_token: string }>();
  return (await Promise.all(results.map((row) => sha256Hex(row.join_token)))).sort();
}

/**
 * A token, for the join card and auto-admit. A registration whose event is no
 * longer a session event reads as cancelled. Null for an unknown token.
 */
export async function resolveSessionToken(env: Env, token: string): Promise<EventRegistrationResolution | null> {
  if (usesCore(env)) {
    const response = await core(env, '/api/public/meet-session-registrations/resolve', { method: 'POST', body: { token } });
    if (response.status === 404) return null;
    if (!response.ok) throw coreFailure('session token read', response);
    return (await readCoreJson(response, z.object({ registration: eventRegistrationResolutionSchema }), 'POST /api/public/meet-session-registrations/resolve')).registration;
  }
  const row = await env.USAGE.prepare(`${REGISTRATION_SELECT} WHERE join_token = ?1 AND source = 'meet'`)
    .bind(token)
    .first<RegistrationRow>();
  if (!row) return null;
  const event = await sessionEventById(env, row.event_id);
  return { id: row.id, event_id: row.event_id, status: event && row.status === 'registered' ? 'registered' : 'cancelled', name: row.name };
}

const STAMP_COLUMN: Record<SessionMailKind, string> = {
  confirmation: 'confirmation_sent_at',
  reminder: 'reminder_sent_at',
  follow_up: 'follow_up_sent_at',
};

/** Live registrations on an event that have not had a mail of this kind. The one read with addresses. */
export async function registrationsNeedingMail(env: Env, eventId: string, kind: SessionMailKind): Promise<EventRegistrationMailRecord[]> {
  if (usesCore(env)) {
    const response = await core(env, `/api/public/meet-session-events/${encodeURIComponent(eventId)}/mail-due`, { method: 'GET', searchParams: { kind } });
    if (response.status === 404) return [];
    if (!response.ok) throw coreFailure('session mail read', response);
    return (await readCoreJson(response, z.object({ registrations: z.array(eventRegistrationMailRecordSchema) }), 'GET /api/public/meet-session-events/:id/mail-due')).registrations;
  }
  const { results } = await env.USAGE.prepare(
    `${REGISTRATION_SELECT} WHERE event_id = ?1 AND source = 'meet' AND status = 'registered' AND ${STAMP_COLUMN[kind]} IS NULL ORDER BY created_at`,
  ).bind(eventId).all<RegistrationRow>();
  return results.map((row) => ({ ...registrationRecord(row), email: row.email ?? '' }));
}

/**
 * Mark one mail sent. The confirmation stamp moves on every send (a repeat
 * sign-up sends it again); the reminder and the follow-up stamp once, so
 * `false` means another sender got there first.
 */
export async function stampSessionMail(env: Env, id: string, kind: SessionMailKind, at: Date = new Date()): Promise<boolean> {
  if (usesCore(env)) {
    const response = await core(env, '/api/public/meet-session-registrations/stamp', { method: 'POST', body: { id, kind } });
    if (!response.ok) throw coreFailure('session mail stamp', response);
    return (await readCoreJson(response, z.object({ stamped: z.boolean() }), 'POST /api/public/meet-session-registrations/stamp')).stamped;
  }
  const column = STAMP_COLUMN[kind];
  const once = kind === 'confirmation' ? '' : ` AND ${column} IS NULL`;
  const result = await env.USAGE.prepare(`UPDATE event_registrations SET ${column} = ?2 WHERE id = ?1 AND source = 'meet'${once}`)
    .bind(id, at.getTime())
    .run();
  return result.meta.changes > 0;
}

/** Cancel by token. Null for an unknown token. */
export async function cancelSessionRegistration(env: Env, token: string): Promise<EventRegistrationRecord | null> {
  if (usesCore(env)) {
    const response = await core(env, '/api/public/meet-session-registrations/cancel', { method: 'POST', body: { token } });
    if (response.status === 404) return null;
    if (!response.ok) throw coreFailure('session cancel', response);
    return (await readCoreJson(response, z.object({ registration: eventRegistrationRecordSchema }), 'POST /api/public/meet-session-registrations/cancel')).registration;
  }
  await env.USAGE.prepare(`UPDATE event_registrations SET status = 'cancelled' WHERE join_token = ?1 AND source = 'meet'`).bind(token).run();
  const row = await env.USAGE.prepare(`${REGISTRATION_SELECT} WHERE join_token = ?1 AND source = 'meet'`).bind(token).first<RegistrationRow>();
  return row ? registrationRecord(row) : null;
}
