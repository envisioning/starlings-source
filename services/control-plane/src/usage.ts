// Account-level usage ledger (D1 `meet-usage`). The Durable Object stays the
// source of truth for one room's live meeting; this is the durable aggregate
// across rooms. Writes are best-effort — a failed upsert must never fail a
// session mint. See docs/ADMIN.md.

import { activateManagedAgentAfterSignIn } from './managed-agent-provisioning';
import { isCalendarConnected } from './calendar';
import { recordUsageEvent } from './ledger';
import { ensurePersonId } from './person-ids';
import { ensureMemberRoom } from './member-rooms';
import { mappedRoomFor } from './workspace-identity';
import type { OwnerSession } from './contracts';

export type OwnerClient = 'web' | 'mac' | 'ios' | 'android';

/**
 * Which column a client's own check-in moves. A literal map rather than a
 * computed name: the column is interpolated into SQL, so the set of possible
 * values has to be closed here and not at the call site.
 */
const CLIENT_SEEN_COLUMN: Record<OwnerClient, string> = {
  mac: 'last_seen_mac',
  ios: 'last_seen_ios',
  android: 'last_seen_android',
  web: 'last_seen_web',
};

/** Which column holds the version a client reported. Closed for the same reason. */
const CLIENT_VERSION_COLUMN: Record<OwnerClient, string> = {
  mac: 'version_mac',
  ios: 'version_ios',
  android: 'version_android',
  web: 'version_web',
};

/**
 * Upsert the signing-in member. `first_seen_at` sticks; everything else
 * follows the latest mint. A member with no room gets one here (,
 * docs/ONBOARDING.md decision 10), and `room_slug` names it. Never throws.
 */
export async function recordOwnerSignIn(
  env: Env,
  owner: OwnerSession,
  lastClient: OwnerClient,
  now = Date.now(),
): Promise<void> {
  try {
    const roomSlug = await ensureMemberRoom(env, owner, now).catch((error: unknown) => {
      console.warn(JSON.stringify({
        level: 'warn',
        message: 'usage.people.room.failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      return mappedRoomFor(env, owner.email);
    });
    const calendarConnected = (await isCalendarConnected(env, owner.sub)) ? 1 : 0;
    const seen = CLIENT_SEEN_COLUMN[lastClient];
    await env.USAGE.prepare(
      `INSERT INTO people (
         sub, email, name, first_seen_at, last_seen_at, room_slug, calendar_connected, last_client, ${seen}
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?5)
       ON CONFLICT(sub) DO UPDATE SET
         email = excluded.email,
         name = excluded.name,
         last_seen_at = excluded.last_seen_at,
         room_slug = excluded.room_slug,
         calendar_connected = excluded.calendar_connected,
         last_client = excluded.last_client,
         ${seen} = excluded.${seen}`,
    ).bind(
      owner.sub,
      owner.email,
      owner.name,
      now,
      now,
      roomSlug,
      calendarConnected,
      lastClient,
    ).run();
    await activateManagedAgentAfterSignIn(env, owner);
    // A D1 workspace names people by a Meet id from their first sign-in.
    await ensurePersonId(env, owner.sub);
    // A sign-in is the one fact about a person that the `people` row cannot
    // carry: the row keeps the latest, the event keeps the sequence.
    await recordUsageEvent(env, { kind: 'signin', actor_kind: 'owner', client_app: lastClient });
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'usage.people.upsert.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/**
 * Move `last_seen_at` for a member who is using the app right now. Sign-in
 * alone is a poor presence signal — a token minted in March made someone look
 * "last seen March" for the rest of the year — so every client beats on this
 * while it is foregrounded. Insert-if-absent is deliberate: a long-lived
 * session that predates the people ledger still earns a row.
 *
 * Never throws: presence is not worth failing a request over.
 */
export async function recordOwnerHeartbeat(
  env: Env,
  owner: OwnerSession,
  lastClient: OwnerClient,
  now = Date.now(),
  timezone?: string | undefined,
  version?: string | undefined,
): Promise<void> {
  try {
    const roomSlug = mappedRoomFor(env, owner.email);
    const seen = CLIENT_SEEN_COLUMN[lastClient];
    const versionColumn = CLIENT_VERSION_COLUMN[lastClient];
    // Only this client's own column moves. The other devices keep whatever
    // they last proved, which is the whole point: a beat from the phone must
    // not make the Mac look present.
    await env.USAGE.prepare(
      `INSERT INTO people (
         sub, email, name, first_seen_at, last_seen_at, room_slug, calendar_connected, last_client, ${seen},
         ${versionColumn}
       ) VALUES (?1, ?2, ?3, ?4, ?5,
         COALESCE((SELECT slug FROM rooms WHERE owner_email = lower(?2) AND retired_at IS NULL), ?6),
         0, ?7, ?5, ?8)
       ON CONFLICT(sub) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         last_client = excluded.last_client,
         ${seen} = excluded.${seen},
         ${versionColumn} = COALESCE(excluded.${versionColumn}, ${versionColumn})`,
    ).bind(owner.sub, owner.email, owner.name, now, now, roomSlug, lastClient, version ?? null).run();
    if (timezone) await recordReportedTimezone(env, owner.sub, timezone);
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'usage.people.heartbeat.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/**
 * Take the zone a device reported, unless the person set their own.
 *
 * The `timezone_source` guard is the whole of it: a check-in writes `client`
 * and may overwrite `client`, but never `self`. Somebody who lives in Lisbon
 * and spends a fortnight in Tokyo said something deliberate about where to
 * find them, and a laptop clock is not an argument against it.
 *
 * Never throws, like everything else here: presence is not worth failing a
 * heartbeat over.
 */
export async function recordReportedTimezone(
  env: Env,
  sub: string,
  timezone: string,
): Promise<void> {
  try {
    await env.USAGE.prepare(
      `UPDATE people SET timezone = ?2, timezone_source = 'client'
        WHERE sub = ?1 AND COALESCE(timezone_source, 'client') != 'self'
          AND COALESCE(timezone, '') != ?2`,
    ).bind(sub, timezone).run();
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'usage.people.timezone.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}
