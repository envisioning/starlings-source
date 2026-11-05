// Permanent rooms (docs/ONBOARDING.md decision 10, AGENTS.md
// invariant 4). Every member gets a room with no deploy: the `rooms` table in
// this workspace's D1 is read first, and `OWNER_ROOM_MAP` is the read
// fallback, so a workspace with no rows (Envisioning) resolves every room as
// it did when the map was the only source.
//
// The rules:
//
// - A room belongs to an address (any of the member's identity addresses),
//   never to a submitted host email or a slug alone.
// - A slug comes from the person's name (`first-last`, diacritics folded),
//   with `-2`, `-3` on a clash. A slug in the map or the internal room map is
//   taken too.
// - A row is never deleted. Revoking a person retires their room
//   (`retired_at`); a retired slug stays taken, so nobody else gets it. The
//   same person, restored, gets their own room back.
// - A room is not admin. Admin is `people.role`, root admins and the map's
//   bootstrap (auth.ts `isOrgAdmin`).
//
// Reads fail narrow: a D1 error leaves the map's answer, never a wider one.
// Writes throw. Logs never name an address.

import { internalRoomSlugs, ownerRoomMap } from './contracts';
import { mappedRoomFor, memberAddresses } from './workspace-identity';

const ROOM_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/u;
const ROOM_SLUG_MAX = 40;

/** Letters NFKD does not split into a base letter and a mark. */
const FOLDS: Record<string, string> = { ß: 'ss', ø: 'o', æ: 'ae', œ: 'oe', đ: 'd', ð: 'd', ł: 'l', þ: 'th', ı: 'i' };

/** Lowercase, diacritics folded, split on every other character. */
function foldToSlugWords(value: string): string[] {
  const folded = value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[ßøæœđðłþı]/gu, (char) => FOLDS[char] ?? char);
  return folded.split(/[^a-z0-9]+/u).filter(Boolean);
}

function trimSlug(value: string, max = ROOM_SLUG_MAX): string {
  return value.slice(0, max).replace(/^-+|-+$/gu, '');
}

/**
 * A person's room slug, from their name (MZ, 2026-10-11): first and last
 * name, diacritics folded, `first-last`. The slug rules (`roomSlugSchema`)
 * allow no dot. A one-word name is that word. A name that folds to nothing
 * usable falls back to the address's local part, then to `room`.
 */
export function roomSlugFromName(name: string, email: string): string {
  const words = foldToSlugWords(name);
  const picked = words.length <= 1 ? words : [words[0]!, words[words.length - 1]!];
  const fromName = trimSlug(picked.join('-'));
  if (ROOM_SLUG_PATTERN.test(fromName)) return fromName;
  const local = email.slice(0, Math.max(0, email.lastIndexOf('@')));
  const fromAddress = trimSlug(foldToSlugWords(local).join('-'));
  if (ROOM_SLUG_PATTERN.test(fromAddress)) return fromAddress;
  return 'room';
}

/**
 * The `n`th choice for a base slug: the base itself, then `base-2`, `base-3`.
 * The base is shortened so the suffix still fits the 40-character limit.
 */
export function roomSlugVariant(base: string, n: number): string {
  if (n <= 1) return base;
  const suffix = `-${n}`;
  return `${trimSlug(base, ROOM_SLUG_MAX - suffix.length)}${suffix}`;
}

/** How many name variants to try before giving up (`ana-silva-2` … `-50`). */
const MAX_VARIANTS = 50;
/** Insert attempts when another write takes the slug or the address first. */
const MAX_ATTEMPTS = 3;

function warn(message: string, error: unknown): void {
  console.warn(JSON.stringify({ level: 'warn', message, error: error instanceof Error ? error.message : 'Unknown error' }));
}

/** The map, or nothing when it does not parse: an unreadable map grants no room. */
function mapRooms(env: Pick<Env, 'OWNER_ROOM_MAP'>): Record<string, string> {
  try {
    return ownerRoomMap(env.OWNER_ROOM_MAP ?? '{}');
  } catch (error) {
    warn('rooms.map.invalid', error);
    return {};
  }
}

function placeholders(count: number, from = 1): string {
  return Array.from({ length: count }, (_, index) => `?${index + from}`).join(', ');
}

/** The live D1 room of any of these addresses. Throws on a D1 error. */
async function liveRoomOf(env: Env, addresses: string[]): Promise<string | null> {
  const row = await env.USAGE.prepare(
    `SELECT slug FROM rooms WHERE owner_email IN (${placeholders(addresses.length)}) AND retired_at IS NULL
      ORDER BY created_at LIMIT 1`,
  ).bind(...addresses).first<{ slug: string }>();
  return row?.slug ?? null;
}

/**
 * The member's permanent room: their live D1 room, else the map's. This is
 * the one lookup every caller uses for "my room".
 */
export async function roomOfMember(env: Env, email: string): Promise<string | null> {
  try {
    const live = await liveRoomOf(env, memberAddresses(env, email));
    if (live) return live;
  } catch (error) {
    warn('rooms.read.failed', error);
  }
  return mappedRoomFor(env, email);
}

/**
 * The address that owns a public room, or null. A retired slug has no owner,
 * so its room answers as no room at all.
 */
export async function roomOwnerEmail(env: Env, slug: string): Promise<string | null> {
  try {
    const row = await env.USAGE.prepare('SELECT owner_email, retired_at FROM rooms WHERE slug = ?1')
      .bind(slug)
      .first<{ owner_email: string; retired_at: number | null }>();
    if (row) return row.retired_at == null ? row.owner_email : null;
  } catch (error) {
    warn('rooms.read.failed', error);
  }
  return Object.entries(mapRooms(env)).find(([, mapped]) => mapped === slug)?.[0] ?? null;
}

/** True for a public permanent room. Not the internal room (`internal-rooms.ts`). */
export async function isPublicRoom(env: Env, slug: string): Promise<boolean> {
  return (await roomOwnerEmail(env, slug)) !== null;
}

/**
 * Every public room with its owner's address: the live D1 rows, then each map
 * room. A D1 error leaves the map's rooms.
 */
export async function publicRooms(env: Env): Promise<Array<{ slug: string; email: string }>> {
  const rooms = new Map<string, string>();
  try {
    const { results } = await env.USAGE.prepare('SELECT slug, owner_email FROM rooms WHERE retired_at IS NULL ORDER BY slug')
      .all<{ slug: string; owner_email: string }>();
    for (const row of results) rooms.set(row.slug, row.owner_email);
  } catch (error) {
    warn('rooms.read.failed', error);
  }
  for (const [email, slug] of Object.entries(mapRooms(env))) {
    if (!rooms.has(slug)) rooms.set(slug, email);
  }
  return [...rooms].map(([slug, email]) => ({ slug, email }));
}

/** The public room slugs, as a set. */
export async function publicRoomSlugs(env: Env): Promise<Set<string>> {
  return new Set((await publicRooms(env)).map((room) => room.slug));
}

/** Every room slug with an object: the public rooms and the retired D1 ones. */
export async function roomObjectSlugs(env: Env): Promise<Set<string>> {
  const slugs = await publicRoomSlugs(env);
  try {
    const { results } = await env.USAGE.prepare('SELECT slug FROM rooms WHERE retired_at IS NOT NULL').all<{ slug: string }>();
    for (const row of results) slugs.add(row.slug);
  } catch (error) {
    warn('rooms.read.failed', error);
  }
  return slugs;
}

/**
 * A free slug for this person: their name's slug, else the first free
 * variant. Taken means any D1 row (live or retired), a slug in the meetings
 * ledger, a map room, or the internal room.
 */
export async function allocateRoomSlug(env: Env, person: { name: string; email: string }): Promise<string> {
  const base = roomSlugFromName(person.name, person.email);
  const prefix = base.slice(0, 30);
  // A slug that ever held a meeting is taken too: its Durable Object keeps
  // that owner and that history, even after the slug left the map.
  const { results } = await env.USAGE.prepare(
    `SELECT slug FROM rooms WHERE slug LIKE ?1
     UNION SELECT DISTINCT room_slug AS slug FROM meetings_ledger WHERE room_slug LIKE ?1`,
  ).bind(`${prefix}%`).all<{ slug: string }>();
  const taken = new Set(results.map((row) => row.slug));
  for (const slug of Object.values(mapRooms(env))) taken.add(slug);
  for (const slug of internalRoomSlugs(env.INTERNAL_ROOM_MAP)) taken.add(slug);
  for (let n = 1; n <= MAX_VARIANTS; n += 1) {
    const candidate = roomSlugVariant(base, n);
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error('No free room slug for this name.');
}

/** The insert for a new room. Batch it with the write that admits the person. */
export function insertRoomStatement(env: Env, room: { slug: string; email: string; createdBy: string | null; now: number }): D1PreparedStatement {
  return env.USAGE.prepare('INSERT INTO rooms (slug, owner_email, created_at, created_by) VALUES (?1, ?2, ?3, ?4)')
    .bind(room.slug, room.email.trim().toLowerCase(), room.now, room.createdBy);
}

/**
 * What a member's room needs: nothing (`existing`), their own retired room
 * back (`restore`), or a new slug (`create`). Throws on a D1 error, because
 * a read that failed open here would hand out a second room.
 */
export async function planMemberRoom(
  env: Env,
  person: { name: string; email: string },
): Promise<{ kind: 'existing'; slug: string } | { kind: 'restore'; slug: string } | { kind: 'create'; slug: string }> {
  const addresses = memberAddresses(env, person.email);
  const live = await liveRoomOf(env, addresses);
  if (live) return { kind: 'existing', slug: live };
  const mapped = mappedRoomFor(env, person.email);
  if (mapped) return { kind: 'existing', slug: mapped };
  const retired = await env.USAGE.prepare(
    `SELECT slug FROM rooms WHERE owner_email IN (${placeholders(addresses.length)}) AND retired_at IS NOT NULL
      ORDER BY retired_at DESC LIMIT 1`,
  ).bind(...addresses).first<{ slug: string }>();
  if (retired) return { kind: 'restore', slug: retired.slug };
  return { kind: 'create', slug: await allocateRoomSlug(env, person) };
}

/** The write that carries out a plan, or none for an existing room. */
export function roomPlanStatement(
  env: Env,
  plan: Awaited<ReturnType<typeof planMemberRoom>>,
  person: { email: string; createdBy: string | null; now: number },
): D1PreparedStatement | null {
  if (plan.kind === 'existing') return null;
  if (plan.kind === 'restore') {
    return env.USAGE.prepare('UPDATE rooms SET retired_at = NULL WHERE slug = ?1 AND retired_at IS NOT NULL').bind(plan.slug);
  }
  return insertRoomStatement(env, { slug: plan.slug, email: person.email, createdBy: person.createdBy, now: person.now });
}

/**
 * Give a member their room if they have none (sign-in). Agents
 * and revoked people get none. Retries when a concurrent write took the slug
 * or gave the person a room first. Throws on a D1 error.
 */
export async function ensureMemberRoom(
  env: Env,
  person: { sub: string; name: string; email: string },
  now = Date.now(),
): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const plan = await planMemberRoom(env, person);
    if (plan.kind === 'existing') return plan.slug;
    if (attempt === 1) {
      const blocked = await env.USAGE.prepare(
        `SELECT 1 AS found FROM people WHERE (sub = ?1 OR lower(email) = ?2)
           AND (kind = 'agent' OR revoked_at IS NOT NULL) LIMIT 1`,
      ).bind(person.sub, person.email.trim().toLowerCase()).first();
      if (blocked) return null;
    }
    const statement = roomPlanStatement(env, plan, { email: person.email, createdBy: person.sub, now });
    try {
      const result = await statement!.run();
      if ((result.meta?.changes ?? 0) > 0) return plan.slug;
    } catch (error) {
      // A unique-key conflict: another write took the slug or the address.
      if (attempt === MAX_ATTEMPTS) throw error;
    }
  }
  return null;
}

/**
 * Retire a member's live D1 room (revocation). The statement for a batch;
 * a map room is configuration and is not touched.
 */
export function retireRoomStatement(env: Env, email: string, now: number): D1PreparedStatement {
  const addresses = memberAddresses(env, email);
  return env.USAGE.prepare(
    `UPDATE rooms SET retired_at = ?1 WHERE owner_email IN (${placeholders(addresses.length, 2)}) AND retired_at IS NULL`,
  ).bind(now, ...addresses);
}
