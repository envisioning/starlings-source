/**
 * The internal room — one permanent room whose audience is Envisioning rather
 * than the public. `docs/adr/0001-internal-room.md` is the decision; this file
 * is the whole mechanism.
 *
 * **An internal room is a room with the lobby removed: membership is the
 * admission.** There is no waiting room because there is nobody to admit. A
 * verified member walks in through the admission rule that already exists
 * (`memberAdmission` in the room coordinator, the same one that makes Call a
 * call rather than a request); everybody else gets the 404 an unconfigured
 * slug already gets.
 *
 * **404, never 403.** A refusal that distinguishes "no such room" from "not for
 * you" tells a visitor the room exists, which is the one fact the internal room
 * is keeping. Every guard here answers with the ordinary not-found.
 */

import { internalRoomMap, internalRoomSlugs } from './contracts';
import { roomObjectSlugs } from './member-rooms';

/** True when this slug is the internal room rather than somebody's public room. */
export function isInternalRoomSlug(env: Env, slug: string): boolean {
  return internalRoomSlugs(env.INTERNAL_ROOM_MAP).has(slug);
}

/** The internal room this address may host, if any. `*` means every member. */
export function internalRoomFor(env: Env, email: string): string | null {
  const map = internalRoomMap(env.INTERNAL_ROOM_MAP);
  return map[email.trim().toLowerCase()] ?? map['*'] ?? null;
}

/**
 * Every room object this deployment holds: the public rooms, the retired
 * ones (their Durable Objects keep their history), and the internal room.
 * For sweeps, backups and moves, which act on objects. Do **not** use it
 * where the question is "is this a public room": booking, presence and the
 * ledger mean the narrower set, and `publicRoomSlugs` stays theirs.
 */
export async function knownRoomSlugs(env: Env): Promise<Set<string>> {
  const slugs = await roomObjectSlugs(env);
  for (const slug of internalRoomSlugs(env.INTERNAL_ROOM_MAP)) slugs.add(slug);
  return slugs;
}
