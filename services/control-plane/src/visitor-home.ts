// What a signed-out visitor sees at the workspace root, set by an admin
// (packages/contracts/src/visitor-home.ts). Stored as the admin wrote it,
// resolved on every read: the booker is a person, and the room and name are
// read from `people` each time, so a renamed room or a revoked member never
// leaves the root offering a booking page that does not open.

import {
  VISITOR_HOME_DEFAULT,
  visitorHomeUpdateSchema,
  type VisitorHomeAdminResponse,
  type VisitorHomeResponse,
  type VisitorHomeUpdate,
} from '@starlings/contracts/visitor-home';
import { recordAdminAction } from './admin-audit';
import type { OwnerSession } from './contracts';
import { ControlError } from './errors';

const KEY = 'visitor_home';

function parseStored(raw: string): VisitorHomeUpdate {
  try {
    const parsed = visitorHomeUpdateSchema.safeParse(JSON.parse(raw));
    // A row nobody can read is the default, not a 500 at the root.
    return parsed.success ? parsed.data : VISITOR_HOME_DEFAULT;
  } catch {
    return VISITOR_HOME_DEFAULT;
  }
}

/** A human member with a room and access, or null. */
async function bookablePerson(env: Env, email: string): Promise<{ room: string; name: string | null } | null> {
  const row = await env.USAGE.prepare(
    `SELECT room_slug, name FROM people
     WHERE lower(email) = ?1 AND room_slug IS NOT NULL AND revoked_at IS NULL AND (kind IS NULL OR kind != 'agent')`,
  ).bind(email).first<{ room_slug: string; name: string | null }>();
  return row ? { room: row.room_slug, name: row.name } : null;
}

async function resolve(env: Env, setting: VisitorHomeUpdate, updatedAt: number | null): Promise<VisitorHomeAdminResponse> {
  const person = setting.booking_email ? await bookablePerson(env, setting.booking_email) : null;
  return { join: setting.join, booking: person, booking_email: setting.booking_email, updated_at: updatedAt };
}

/** The admin's read: what was chosen, and what the root draws from it. */
export async function readVisitorHomeSetting(env: Env): Promise<VisitorHomeAdminResponse> {
  const row = await env.USAGE.prepare('SELECT value, updated_at FROM workspace_settings WHERE key = ?1')
    .bind(KEY)
    .first<{ value: string; updated_at: number }>();
  return resolve(env, row ? parseStored(row.value) : VISITOR_HOME_DEFAULT, row?.updated_at ?? null);
}

/** The public read: what the root draws, and nothing that names a member's address. */
export async function readVisitorHome(env: Env): Promise<VisitorHomeResponse> {
  const { join, booking } = await readVisitorHomeSetting(env);
  return { join, booking };
}

export async function writeVisitorHome(env: Env, actor: OwnerSession, setting: VisitorHomeUpdate): Promise<VisitorHomeAdminResponse> {
  // Refuse a booker the root could not offer, rather than save it and draw nothing.
  if (setting.booking_email && !(await bookablePerson(env, setting.booking_email))) {
    throw new ControlError('That member has no booking page.', 404, 'person_not_found');
  }
  const now = Date.now();
  await env.USAGE.prepare(
    `INSERT INTO workspace_settings (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(KEY, JSON.stringify(setting), actor.sub, now).run();
  await recordAdminAction(env, actor, 'workspace.visitor_home', setting.booking_email,
    `join ${setting.join ? 'on' : 'off'}`);
  return resolve(env, setting, now);
}
