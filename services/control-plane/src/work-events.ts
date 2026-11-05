/**
 * Creating and editing an event in Work (docs/SESSIONS.md §0 S8,
 * docs/EVENTS.md §An event on a `d1` workspace). One form for both stores: on
 * a `d1` workspace the event is the workspace's own D1 row; on Envisioning
 * (`core`) it is the CMS event, written through Core as the person.
 * The route and the form do not know which store answered (fold rule F1).
 */
import { workspaceSiteOrigin } from './workspace-origins';
import { cmsEntitySchema, cmsRecordResponseSchema, type CmsRecord } from '@starlings/contracts/cms';
import {
  cmsEventSlug,
  eventAttendanceSchema,
  isTimeZone,
  zonedInstant,
  zonedWallClock,
  type WorkEvent,
  type WorkEventCreate,
  type WorkEventUpdate,
} from '@starlings/contracts/event-signups';
import { publicRoomSlugs } from './member-rooms';
import { ControlError } from './errors';
import { isInternalRoomSlug } from './internal-rooms';
import { personIdForEmail } from './person-ids';
import { usesCore } from './work-store';
import type { RoleSession } from './capabilities';
import { createCmsRecord, crmSyncEnabled, fetchCmsRecord, fetchCmsRegistry, updateCmsRecord } from './crm';
import { subjectAccessFor } from './subject-access';

interface EventRow {
  id: string;
  title: string;
  description: string | null;
  body: string | null;
  starts_on: string;
  location: string | null;
  url: string | null;
  notes: string | null;
  public_slug: string | null;
  starts_at: number | null;
  ends_at: number | null;
  time_zone: string | null;
  room_slug: string | null;
  cta_url: string | null;
  cta_label: string | null;
  follow_up_note: string | null;
  attendance: string | null;
  /** JSON array of lowercase emails. */
  host_emails: string;
}

const SELECT = `SELECT id, title, description, body, starts_on, location, url, notes, public_slug, starts_at, ends_at, time_zone, room_slug,
                       cta_url, cta_label, follow_up_note, attendance, host_emails
                  FROM events`;

/** An attendance value the contract knows, or null. */
function attendanceOf(value: unknown): WorkEvent['attendance'] {
  const parsed = eventAttendanceSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A host list from a D1 JSON column or a CMS text[]: strings only. */
function hostEmailsOf(value: unknown): string[] {
  let list = value;
  if (typeof value === 'string') {
    try { list = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
}

/** The rooms an event may run in: the workspace's public rooms. The internal room has no sign-up door. */
export async function workEventRooms(env: Env): Promise<string[]> {
  return [...(await publicRoomSlugs(env))].filter((slug) => !isInternalRoomSlug(env, slug)).sort();
}

/** The sign-up page's address, on the workspace host (SESSIONS.md S2). */
export function signUpPageURL(env: Env, slug: string): string {
  return `${workspaceSiteOrigin(env)}/event/${slug}`;
}

function toWorkEvent(env: Env, row: EventRow): WorkEvent {
  const zone = row.time_zone && isTimeZone(row.time_zone) ? row.time_zone : 'UTC';
  const start = row.starts_at === null ? null : new Date(row.starts_at).toISOString();
  const end = row.ends_at === null ? null : new Date(row.ends_at).toISOString();
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    body: row.body,
    date: row.starts_on,
    start_time: start ? zonedWallClock(start, zone).time : null,
    end_time: end ? zonedWallClock(end, zone).time : null,
    time_zone: row.time_zone,
    starts_at: start,
    ends_at: end,
    location: row.location,
    url: row.url,
    notes: row.notes,
    public_slug: row.public_slug,
    room_slug: row.room_slug,
    cta_url: row.cta_url,
    cta_label: row.cta_label,
    follow_up_note: row.follow_up_note,
    attendance: attendanceOf(row.attendance),
    host_emails: hostEmailsOf(row.host_emails),
    public_url: row.public_slug && row.room_slug ? signUpPageURL(env, row.public_slug) : null,
  };
}

/** The instants a day, two clock times and a zone name. The end must come after the start, on the same day. */
export function eventWindow(date: string, startTime: string, endTime: string, zone: string): { startsAt: number; endsAt: number } {
  if (!isTimeZone(zone)) throw new ControlError('That time zone is not one we know.', 400, 'invalid_request');
  const startsAt = Date.parse(zonedInstant(date, startTime, zone));
  const endsAt = Date.parse(zonedInstant(date, endTime, zone));
  if (!(endsAt > startsAt)) throw new ControlError('The end must come after the start.', 400, 'invalid_request');
  return { startsAt, endsAt };
}

/** A room must be one of the workspace's rooms. */
export async function assertEventRoom(env: Env, room: string | null | undefined): Promise<void> {
  if (room && !(await workEventRooms(env)).includes(room)) {
    throw new ControlError('Pick one of this workspace’s rooms.', 400, 'invalid_request');
  }
}

function slugTaken(error: unknown): boolean {
  return error instanceof Error && /UNIQUE/u.test(error.message) && /public_slug/u.test(error.message);
}

async function d1GetWorkEvent(env: Env, id: string): Promise<WorkEvent | null> {
  const row = await env.USAGE.prepare(`${SELECT} WHERE id = ?1`).bind(id).first<EventRow>();
  return row ? toWorkEvent(env, row) : null;
}

async function d1CreateWorkEvent(env: Env, input: WorkEventCreate, actorEmail: string): Promise<WorkEvent> {
  const { startsAt, endsAt } = eventWindow(input.date, input.start_time, input.end_time, input.time_zone);
  await assertEventRoom(env, input.room_slug);
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.USAGE.prepare(`
      INSERT INTO events (id, title, starts_on, location, url, notes, public_slug, starts_at, ends_at, time_zone, room_slug,
                          cta_url, cta_label, follow_up_note, created_by, created_at, updated_at, description, body,
                          attendance, host_emails)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16, ?17, ?18, ?19, ?20)`)
      .bind(
        id, input.title, input.date, input.location ?? null, input.url ?? null, input.notes ?? null, input.public_slug ?? null,
        startsAt, endsAt, input.time_zone, input.room_slug ?? null, input.cta_url ?? null, input.cta_label ?? null,
        input.follow_up_note ?? null, await personIdForEmail(env, actorEmail), now, input.description ?? null, input.body ?? null,
        input.attendance ?? null, JSON.stringify(input.host_emails ?? []),
      )
      .run();
  } catch (error) {
    if (slugTaken(error)) throw new ControlError('Another event has that address.', 409, 'invalid_request');
    throw error;
  }
  const created = await d1GetWorkEvent(env, id);
  if (!created) throw new ControlError('The event was not saved.', 500);
  return created;
}

async function d1UpdateWorkEvent(env: Env, id: string, patch: WorkEventUpdate): Promise<WorkEvent> {
  const current = await d1GetWorkEvent(env, id);
  if (!current) throw new ControlError('No event here.', 404);
  const date = patch.date ?? current.date;
  const startTime = patch.start_time ?? current.start_time ?? '09:00';
  const endTime = patch.end_time ?? current.end_time ?? startTime;
  const zone = patch.time_zone ?? current.time_zone ?? 'UTC';
  const { startsAt, endsAt } = eventWindow(date, startTime, endTime, zone);
  const room = patch.room_slug === undefined ? current.room_slug : patch.room_slug;
  await assertEventRoom(env, room);
  const keep = <T>(value: T | undefined, previous: T): T => (value === undefined ? previous : value);
  try {
    await env.USAGE.prepare(`
      UPDATE events SET title = ?2, starts_on = ?3, location = ?4, url = ?5, notes = ?6, public_slug = ?7, starts_at = ?8,
                        ends_at = ?9, time_zone = ?10, room_slug = ?11, cta_url = ?12, cta_label = ?13, follow_up_note = ?14,
                        updated_at = ?15, description = ?16, body = ?17, attendance = ?18, host_emails = ?19
       WHERE id = ?1`)
      .bind(
        id, patch.title ?? current.title, date, keep(patch.location, current.location), keep(patch.url, current.url),
        keep(patch.notes, current.notes), keep(patch.public_slug, current.public_slug), startsAt, endsAt, zone, room,
        keep(patch.cta_url, current.cta_url), keep(patch.cta_label, current.cta_label),
        keep(patch.follow_up_note, current.follow_up_note), Date.now(), keep(patch.description, current.description),
        keep(patch.body, current.body), keep(patch.attendance, current.attendance),
        JSON.stringify(keep(patch.host_emails, current.host_emails)),
      )
      .run();
  } catch (error) {
    if (slugTaken(error)) throw new ControlError('Another event has that address.', 409, 'invalid_request');
    throw error;
  }
  const updated = await d1GetWorkEvent(env, id);
  if (!updated) throw new ControlError('No event here.', 404);
  return updated;
}

// ---------------------------------------------------------------------------
// Envisioning (`core`): the CMS event, through Core as the person.
// Core's registry decides permission: no `capabilities.create` or no write
// grant means no create. A new CMS event starts unpublished; the sign-up page
// needs a room and the page slug, not the website listing. The CMS slug is
// derived from the title and the id (`cmsEventSlug`, fold rule F7), so a
// `public_slug` the form sends is not stored there. The form's `body` is the
// CMS body; the CMS has no notes column, so `notes` reads null and a notes
// value is refused (assertNoCoreNotes). The website fields (image, listing) stay in the full
// CMS editor.

/** Whether this person may create a CMS event through Core. Never throws. */
async function coreCanCreate(env: Env, owner: RoleSession): Promise<boolean> {
  if (!crmSyncEnabled(env)) return false;
  try {
    const registry = await fetchCmsRegistry(env, owner.email) as { data?: { entities?: unknown[] } } | null;
    const entity = (registry?.data?.entities ?? [])
      .map((row) => cmsEntitySchema.safeParse(row))
      .find((parsed) => parsed.success && parsed.data.id === 'events');
    return Boolean(entity?.success && entity.data.capabilities.create && entity.data.access.canWrite);
  } catch {
    return false;
  }
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

function fromCmsRecord(env: Env, record: CmsRecord): WorkEvent {
  const id = String(record.id);
  const title = text(record.title) ?? 'Event';
  const zone = text(record.timezone);
  const start = text(record.start_at) ? new Date(String(record.start_at)).toISOString() : null;
  const minutes = typeof record.duration_minutes === 'number' && record.duration_minutes > 0 ? record.duration_minutes : 60;
  const end = start ? new Date(Date.parse(start) + minutes * 60_000).toISOString() : null;
  const clock = zone && isTimeZone(zone) ? zone : 'UTC';
  const room = text(record.meet_room_slug);
  const slug = cmsEventSlug(title, id);
  return {
    id,
    title,
    description: text(record.description),
    date: text(record.event_date) ?? (start ? zonedWallClock(start, clock).date : ''),
    start_time: start ? zonedWallClock(start, clock).time : (text(record.start_time)?.slice(0, 5) ?? null),
    end_time: end ? zonedWallClock(end, clock).time : null,
    time_zone: zone,
    starts_at: start,
    ends_at: end,
    body: text(record.body),
    location: text(record.venue) ?? text(record.location),
    url: null,
    notes: null,
    public_slug: slug,
    room_slug: room,
    cta_url: text(record.cta_url),
    cta_label: text(record.cta_label),
    follow_up_note: text(record.follow_up_note),
    attendance: attendanceOf(record.attendance),
    host_emails: hostEmailsOf(record.host_emails),
    public_url: room ? signUpPageURL(env, slug) : null,
  };
}

interface CmsWindow { date: string; start: string; zone: string; minutes: number }

/** The CMS columns for the form's fields that are present. */
function cmsBody(fields: WorkEventUpdate, window?: CmsWindow): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (fields.title !== undefined) body.title = fields.title;
  if (fields.description !== undefined) body.description = fields.description;
  if (window) {
    body.event_date = window.date;
    body.start_time = window.start;
    body.timezone = window.zone;
    body.duration_minutes = window.minutes;
  }
  if (fields.location !== undefined) body.venue = fields.location;
  if (fields.body !== undefined) body.body = fields.body;
  if (fields.room_slug !== undefined) body.meet_room_slug = fields.room_slug;
  if (fields.cta_url !== undefined) body.cta_url = fields.cta_url;
  if (fields.cta_label !== undefined) body.cta_label = fields.cta_label;
  if (fields.follow_up_note !== undefined) body.follow_up_note = fields.follow_up_note;
  // The CMS column is required once set: a null never clears it there.
  if (fields.attendance) body.attendance = fields.attendance;
  if (fields.host_emails !== undefined) body.host_emails = fields.host_emails;
  return body;
}

function cmsRecordOf(value: unknown): CmsRecord {
  const parsed = cmsRecordResponseSchema.safeParse(value);
  if (!parsed.success) throw new ControlError('Core answered without the event.', 502);
  return parsed.data.data;
}

async function coreGetWorkEvent(env: Env, id: string, owner: RoleSession): Promise<WorkEvent | null> {
  (await subjectAccessFor(env, owner)).requireSee('event', id);
  try {
    return fromCmsRecord(env, cmsRecordOf(await fetchCmsRecord(env, owner.email, 'events', id)));
  } catch (error) {
    if (error instanceof ControlError && error.status === 404) return null;
    throw error;
  }
}

/**
 * The CMS has no notes column. A notes value on Envisioning is refused, so the
 * person sees it and nothing they typed is lost without a word.
 */
function assertNoCoreNotes(notes: string | null | undefined): void {
  if (notes?.trim()) {
    throw new ControlError('This workspace’s events have no Notes. Put the text in About.', 400, 'invalid_request');
  }
}

async function coreCreateWorkEvent(env: Env, input: WorkEventCreate, owner: RoleSession): Promise<WorkEvent> {
  if (!(await coreCanCreate(env, owner))) {
    throw new ControlError('Your Core access does not create website events.', 403, 'capability_denied');
  }
  assertNoCoreNotes(input.notes);
  const { startsAt, endsAt } = eventWindow(input.date, input.start_time, input.end_time, input.time_zone);
  await assertEventRoom(env, input.room_slug);
  const body = {
    ...cmsBody(input, { date: input.date, start: input.start_time, zone: input.time_zone, minutes: Math.round((endsAt - startsAt) / 60_000) }),
    title: input.title,
    is_published: false,
  };
  return fromCmsRecord(env, cmsRecordOf(await createCmsRecord(env, owner.email, 'events', body)));
}

async function coreUpdateWorkEvent(env: Env, id: string, patch: WorkEventUpdate, owner: RoleSession): Promise<WorkEvent> {
  (await subjectAccessFor(env, owner)).requireWrite('event', id);
  const current = await coreGetWorkEvent(env, id, owner);
  if (!current) throw new ControlError('No event here.', 404);
  assertNoCoreNotes(patch.notes);
  const timing = patch.date !== undefined || patch.start_time !== undefined || patch.end_time !== undefined || patch.time_zone !== undefined;
  let window: CmsWindow | undefined;
  if (timing) {
    const date = patch.date ?? current.date;
    const start = patch.start_time ?? current.start_time ?? '09:00';
    const end = patch.end_time ?? current.end_time ?? start;
    const zone = patch.time_zone ?? current.time_zone ?? 'UTC';
    const { startsAt, endsAt } = eventWindow(date, start, end, zone);
    window = { date, start, zone, minutes: Math.round((endsAt - startsAt) / 60_000) };
  }
  if (patch.room_slug !== undefined) await assertEventRoom(env, patch.room_slug);
  const body = cmsBody(patch, window);
  if (Object.keys(body).length === 0) return current;
  return fromCmsRecord(env, cmsRecordOf(await updateCmsRecord(env, owner.email, 'events', id, body)));
}

// ---------------------------------------------------------------------------
// The seam the routes call. The store decides; the caller does not know it.

/** Whether this person may create an event with the form here. */
export async function workEventsWritable(env: Env, owner: RoleSession): Promise<boolean> {
  return usesCore(env) ? coreCanCreate(env, owner) : true;
}

export function getWorkEvent(env: Env, id: string, owner: RoleSession): Promise<WorkEvent | null> {
  return usesCore(env) ? coreGetWorkEvent(env, id, owner) : d1GetWorkEvent(env, id);
}

export function createWorkEvent(env: Env, input: WorkEventCreate, owner: RoleSession): Promise<WorkEvent> {
  return usesCore(env) ? coreCreateWorkEvent(env, input, owner) : d1CreateWorkEvent(env, input, owner.email);
}

export function updateWorkEvent(env: Env, id: string, patch: WorkEventUpdate, owner: RoleSession): Promise<WorkEvent> {
  return usesCore(env) ? coreUpdateWorkEvent(env, id, patch, owner) : d1UpdateWorkEvent(env, id, patch);
}
