// Profile pictures: one face per Envisioning person, stored once and drawn by
// the Mac, the phone and the browser from the same bytes.
//
// Envisioning-only by route, exactly like presence: a picture is a person, and
// `docs/PRIVACY.md` says a guest never learns who else is on the team. Guests
// keep initials, which is what every surface already draws when there is no
// picture — the fallback is not an error path, it is the ordinary state of a
// person who has not uploaded one.
//
// The Worker owns no image pipeline. Clients square and downscale before they
// upload (they all have a canvas, an NSImage or a UIImage to hand), and this
// stores the frame it is given after proving it really is one of three
// formats. That keeps a route that accepts bytes from a person as small as it
// can be: sniff, bound, store.

import { AVATAR_CONTENT_TYPES, AVATAR_MAX_BYTES, type AvatarContentType, type AvatarResponse, type OwnerSession } from './contracts';
import { ControlError } from './errors';
import { readBoundedBytes } from './http';

/** One object per person, overwritten in place. See `avatarKey`. */
function avatarKey(sub: string): string {
  return `avatars/${sub}`;
}

interface AvatarRow {
  sub: string;
  avatar_updated_at: number | null;
  avatar_content_type: string | null;
}

/**
 * The picture the caller sent, after proving it is an image.
 *
 * The stored object key never changes — `people.avatar_updated_at` is the
 * cache key instead. An immutable URL per version would leave every previous
 * picture readable at its old address forever, which is the wrong default for
 * something a person can change their mind about.
 */
export async function storeOwnAvatar(request: Request, env: Env, owner: OwnerSession): Promise<AvatarResponse> {
  const bucket = requireBucket(env);
  const bytes = await readBoundedBytes(request, AVATAR_MAX_BYTES);
  if (bytes.byteLength === 0) throw new ControlError('Send the image bytes as the request body.', 400, 'invalid_request');

  const contentType = sniffImageType(bytes);
  if (!contentType) {
    throw new ControlError('A profile picture must be a JPEG, PNG or WebP image.', 415, 'invalid_request');
  }

  const now = Date.now();
  await bucket.put(avatarKey(owner.sub), bytes, {
    httpMetadata: { contentType },
    customMetadata: { email: owner.email, updated_at: String(now) },
  });
  await markAvatar(env, owner, { updatedAt: now, contentType, source: 'upload' });
  return { email: owner.email, avatar_updated_at: now };
}

/** Back to initials. The object goes with the row — a picture nobody points at is just bytes about a person. */
export async function removeOwnAvatar(env: Env, owner: OwnerSession): Promise<AvatarResponse> {
  const bucket = requireBucket(env);
  await bucket.delete(avatarKey(owner.sub));
  await markAvatar(env, owner, { updatedAt: null, contentType: null, source: null });
  return { email: owner.email, avatar_updated_at: null };
}

/**
 * One person's picture, by address rather than by `sub`: every client already
 * holds the roster, and email is the key it is keyed on.
 *
 * Answers 404 for somebody who has no picture, which is not a failure — it is
 * the client's cue to draw initials, and it is deliberately the same answer as
 * for an address that is not on the team, so this route cannot be used to
 * enumerate who exists.
 */
export async function serveAvatar(env: Env, email: string, version: string | null): Promise<Response> {
  const bucket = env.AVATARS;
  if (!bucket) return avatarMissing();

  const row = await avatarRow(env, email);
  if (!row || row.avatar_updated_at === null) return avatarMissing();

  const object = await bucket.get(avatarKey(row.sub));
  if (!object) return avatarMissing();

  const updatedAt = row.avatar_updated_at;
  const contentType = normalizeContentType(row.avatar_content_type ?? object.httpMetadata?.contentType);
  return new Response(object.body, {
    headers: {
      'content-type': contentType,
      etag: `"${updatedAt}"`,
      // `private` throughout: this is a member-only image, and no shared cache
      // between here and the person reading it may keep a copy. A caller that
      // asked for the version it was told about gets to keep it for a year —
      // that URL cannot come to mean different bytes, because a new picture
      // means a new `avatar_updated_at` and therefore a new URL.
      'cache-control': version === String(updatedAt)
        ? 'private, max-age=31536000, immutable'
        : 'private, max-age=60',
    },
  });
}

/**
 * Give a new member the face their colleagues already know, once.
 *
 * Google hands us a picture URL in the id token, so the alternative to this is
 * an app where everybody is two grey letters until they think to go looking
 * for a setting. Seeded only when the row has no picture at all, so it can
 * never overwrite an upload — and never re-seeded after a removal, because
 * deleting your picture is an answer, not an absence.
 *
 * Best-effort by construction: this runs behind a sign-in and a sign-in must
 * not fail because Google's CDN was slow.
 */
export async function seedAvatarFromGoogle(env: Env, owner: OwnerSession): Promise<void> {
  const bucket = env.AVATARS;
  const picture = owner.picture?.trim();
  if (!bucket || !picture) return;

  try {
    const row = await avatarRow(env, owner.email);
    // No row yet means the sign-in upsert has not landed; the next one seeds.
    if (!row || row.avatar_updated_at !== null || row.avatar_content_type !== null) return;

    const source = googlePictureURL(picture);
    if (!source) return;

    const response = await fetch(source, {
      headers: { accept: 'image/*' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > AVATAR_MAX_BYTES) return;
    const contentType = sniffImageType(bytes);
    if (!contentType) return;

    const now = Date.now();
    await bucket.put(avatarKey(owner.sub), bytes, {
      httpMetadata: { contentType },
      customMetadata: { email: owner.email, updated_at: String(now) },
    });
    await markAvatar(env, owner, { updatedAt: now, contentType, source: 'google' });
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'avatars.google.seed.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
}

/**
 * The one host a seeded picture may come from, rebuilt from parts so nothing a
 * token happened to carry travels on. `s512-c` is Google's own square crop at
 * the size clients upload at, which keeps a seeded face and an uploaded one
 * the same shape.
 */
export function googlePictureURL(raw: string): URL | null {
  let source: URL;
  try {
    source = new URL(raw);
  } catch {
    return null;
  }
  if (source.protocol !== 'https:' || !source.hostname.endsWith('.googleusercontent.com')) return null;
  const rebuilt = new URL(`https://${source.hostname}${source.pathname}`);
  rebuilt.searchParams.set('sz', '512');
  return rebuilt;
}

/**
 * What the bytes actually are. Magic numbers rather than the `content-type`
 * header: this route stores what one person sent and serves it back to their
 * colleagues, so a claim in a header is not evidence — and `nosniff` on the
 * way out only helps if what goes in was checked on the way in.
 */
export function sniffImageType(bytes: Uint8Array): AvatarContentType | null {
  if (bytes.byteLength < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png';
  const ascii = (offset: number, text: string): boolean =>
    [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  return null;
}

function normalizeContentType(raw: string | undefined | null): AvatarContentType {
  const match = AVATAR_CONTENT_TYPES.find((candidate) => candidate === raw);
  // Anything else predates the sniff or came back from R2 without metadata.
  // JPEG is the safe guess and, with `nosniff`, the worst case is a broken
  // image rather than a browser deciding for itself what it was sent.
  return match ?? 'image/jpeg';
}

async function avatarRow(env: Env, email: string): Promise<AvatarRow | null> {
  try {
    return await env.USAGE.prepare(
      'SELECT sub, avatar_updated_at, avatar_content_type FROM people WHERE email = ?1',
    ).bind(email.trim().toLowerCase()).first<AvatarRow>();
  } catch (error) {
    console.warn(JSON.stringify({
      level: 'warn',
      message: 'avatars.row.read.failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return null;
  }
}

async function markAvatar(
  env: Env,
  owner: OwnerSession,
  next: { updatedAt: number | null; contentType: AvatarContentType | null; source: 'upload' | 'google' | null },
): Promise<void> {
  await env.USAGE.prepare(
    `UPDATE people
        SET avatar_updated_at = ?2, avatar_content_type = ?3, avatar_source = ?4
      WHERE sub = ?1`,
  ).bind(owner.sub, next.updatedAt, next.contentType, next.source).run();
}

function requireBucket(env: Env): R2Bucket {
  const bucket = env.AVATARS;
  if (!bucket) {
    throw new ControlError('Profile pictures are not configured.', 503, 'not_configured');
  }
  return bucket;
}

/**
 * No picture, no such person: the same answer either way, and cheap to repeat.
 * A short cache here is what stops a roster of twenty initials from asking
 * twenty questions again every time a window opens.
 */
function avatarMissing(): Response {
  return new Response(null, { status: 404, headers: { 'cache-control': 'private, max-age=30' } });
}
