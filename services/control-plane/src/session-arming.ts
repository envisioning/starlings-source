/**
 * Arming a meeting as an event session at room start (docs/SESSIONS.md §7,
 *). The Worker asks the store seam for the session event that covers
 * now in this room. When one does, the room's Durable Object keeps the event
 * id and its window on the meeting.
 *
 * The failure direction is always the existing behaviour: a store that does
 * not answer leaves the meeting unarmed, and the room works as a plain
 * meeting with a manual lobby. Nothing here reads Core directly (fold rule F1).
 */
import { roomStub } from './do-jurisdiction';
import { sessionEventsCovering, sessionTokenHashes } from './event-signups';
import { workModelEnabled } from './crm';
import { isInternalRoomSlug } from './internal-rooms';

/** True when the meeting is (now) an event session. Never throws. */
export async function armSessionIfDue(env: Env, slug: string, meetingId: string, now: Date = new Date()): Promise<boolean> {
  try {
    const room = await roomStub(env, slug);
    if (await room.meetingSession(meetingId)) return true;
    // The internal room has no sign-up door, and a workspace without a work
    // store has no events to ask about.
    if (isInternalRoomSlug(env, slug) || !workModelEnabled(env)) return false;
    const [event] = await sessionEventsCovering(env, slug, now);
    if (!event) return false;
    // The roster: hashes of live tokens, never tokens or registrants (§7).
    const hashes = await sessionTokenHashes(env, event.id);
    await room.armSession(meetingId, {
      event_id: event.id,
      starts_at: Date.parse(event.starts_at),
      ends_at: Date.parse(event.ends_at),
    }, hashes);
    return true;
  } catch (error) {
    console.error(JSON.stringify({ level: 'warn', message: 'session.arm_failed', reason: error instanceof Error ? error.message : 'unknown' }));
    return false;
  }
}

/**
 * Before a knock that carries a token: fetch the roster again when the room
 * says it is due (at most once a minute, inside the window). A registration
 * made after arming gets in; one cancelled after arming stops. A store that
 * does not answer changes nothing: the roster the room has stays.
 */
export async function refreshRosterBeforeKnock(env: Env, slug: string, now: number = Date.now()): Promise<void> {
  if (!workModelEnabled(env)) return;
  try {
    const room = await roomStub(env, slug);
    const due = await room.sessionRosterRefreshDue(now);
    if (!due) return;
    await room.refreshSessionRoster(due.meeting_id, await sessionTokenHashes(env, due.event_id));
  } catch (error) {
    console.error(JSON.stringify({ level: 'warn', message: 'session.roster_refresh_failed', reason: error instanceof Error ? error.message : 'unknown' }));
  }
}
