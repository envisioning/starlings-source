/**
 * The event page's server half (docs/SESSIONS.md §0): who hosts
 * the event, the host's photo, and the `<head>` a link preview reads.
 *
 * The host is the owner of the event's room, from Meet's own room map and
 * `people` rows, on both stores. Never free text from the store, and never an
 * address: a person without a name is no host on the page.
 *
 * The head reads the event through the store seam (fold rule F1). It carries
 * the title, the description and the image only: no personal data, no counts.
 * A head that cannot be written leaves the generic one; it never fails the
 * page.
 */
import { workspacePublicOrigin } from './workspace-origins';
import { roomOwnerEmail } from './member-rooms';
import { sessionDescription, sessionImageURL, type SessionEventRecord, type SessionHost } from '@starlings/contracts/event-signups';
import { serveAvatar } from './avatars';
import { sessionTimeLine } from './event-invite';
import { sessionEventBySlug } from './event-signups';
import { publicNotFound } from './public-pages';
import { workspaceDisplayName, workspaceShareImagePath } from './workspace-profile';
import { signUpPageURL } from './work-events';
import { memberAddresses } from './workspace-identity';
import { parsePublicEventPath, parsePublicRoomPath } from './contracts';

interface HostRow {
  email: string;
  name: string | null;
  avatar_updated_at: number | null;
}

/** The `people` row of the room's owner, or null. */
async function roomOwner(env: Env, room: string): Promise<HostRow | null> {
  const owner = await roomOwnerEmail(env, room);
  if (!owner) return null;
  const addresses = memberAddresses(env, owner);
  return env.USAGE.prepare(
    `SELECT email, name, avatar_updated_at FROM people
      WHERE lower(email) IN (${addresses.map((_, index) => `?${index + 1}`).join(', ')})
        AND revoked_at IS NULL
      ORDER BY last_seen_at DESC LIMIT 1`,
  ).bind(...addresses).first<HostRow>();
}

/** The host's photo path on this origin, versioned like every avatar URL. */
export function hostPhotoPath(slug: string, version: number): string {
  return `/api/events/${encodeURIComponent(slug)}/host-photo?v=${version}`;
}

/** Who hosts the event: the room owner's name and photo. Null when there is none, or when the read fails. */
export async function sessionHost(env: Env, event: Pick<SessionEventRecord, 'slug' | 'room_slug'>): Promise<SessionHost | null> {
  try {
    const row = await roomOwner(env, event.room_slug);
    const name = row?.name?.trim();
    if (!row || !name) return null;
    return { name, image_url: row.avatar_updated_at === null ? null : hostPhotoPath(event.slug, row.avatar_updated_at) };
  } catch {
    return null;
  }
}

/** The room owner's photo for a session event. 404 for anything else, the same answer as no photo. */
export async function serveSessionHostPhoto(request: Request, env: Env, slug: string, version: string | null): Promise<Response> {
  const event = await sessionEventBySlug(env, slug);
  const row = event ? await roomOwner(env, event.room_slug) : null;
  if (!row?.name?.trim()) return publicNotFound(request);
  return serveAvatar(env, row.email, version);
}

const escapeAttribute = (value: string) => value.replace(/[&"<>]/gu, (char) => `&#${char.charCodeAt(0)};`);

/** A page's link preview: the document title to set, when it has one, and the tags. */
export type ShareHead = { title: string | null; meta: string };

/**
 * Open Graph and Twitter tags for one link preview. Pure. With a description,
 * the page's own `meta name="description"` gives way to it; without one, a
 * reader falls back to the shell's.
 */
export function shareHeadTags(input: {
  title: string;
  description?: string;
  url: string;
  site: string;
  image: string;
  /** A wide picture of the subject, not the workspace's square mark. */
  large?: boolean;
}): string {
  const tag = (attribute: 'name' | 'property', key: string, value: string) =>
    `<meta ${attribute}="${key}" content="${escapeAttribute(value)}">`;
  return [
    input.description ? tag('name', 'description', input.description) : '',
    tag('property', 'og:title', input.title),
    input.description ? tag('property', 'og:description', input.description) : '',
    tag('property', 'og:type', 'website'),
    tag('property', 'og:url', input.url),
    tag('property', 'og:site_name', input.site),
    tag('property', 'og:image', input.image),
    tag('property', 'og:image:alt', ''),
    tag('name', 'twitter:card', input.large ? 'summary_large_image' : 'summary'),
  ].join('');
}

/** The head tags for one event. Pure, for the test. */
export function eventHeadTags(input: {
  event: Pick<SessionEventRecord, 'title' | 'description' | 'image_url' | 'starts_at' | 'ends_at' | 'time_zone'>;
  workspace: string;
  url: string;
  fallbackImage: string;
}): { title: string; meta: string } {
  const description = sessionDescription(input.event.description) ?? sessionTimeLine(input.event);
  const eventImage = sessionImageURL(input.event.image_url);
  return {
    title: `${input.event.title} · ${input.workspace}`,
    meta: shareHeadTags({ title: input.event.title, description, url: input.url, site: input.workspace, image: eventImage ?? input.fallbackImage, large: eventImage !== null }),
  };
}

/** The room preview's line: a guest joins from a browser, without the app. */
export const ROOM_SHARE_DESCRIPTION = 'Join the call from your browser.';

/** The head tags for a member's room. Pure, for the test. */
export function roomHeadTags(input: { owner: string; workspace: string; url: string; image: string }): ShareHead {
  const title = `${input.owner}’s room`;
  return {
    title: `${title} · ${input.workspace}`,
    meta: shareHeadTags({ title, description: ROOM_SHARE_DESCRIPTION, url: input.url, site: input.workspace, image: input.image }),
  };
}

/**
 * The link preview for any page the shell answers ( for events): an
 * event shows the event, a room shows whose room it is, and every other page
 * shows the workspace with its mark. Never throws; a read that fails falls
 * back to the workspace preview, and that one to none.
 */
export async function pageShareHead(env: Env, url: URL): Promise<ShareHead | null> {
  try {
    const origin = workspacePublicOrigin(env);
    const workspace = await workspaceDisplayName(env);
    const image = new URL(await workspaceShareImagePath(env), origin).toString();
    const event = parsePublicEventPath(url.pathname);
    if (event) {
      const head = await eventPageHead(env, event.slug);
      if (head) return head;
    }
    const room = parsePublicRoomPath(url.pathname);
    if (room) {
      const owner = (await roomOwner(env, room.slug).catch(() => null))?.name?.trim();
      if (owner) return roomHeadTags({ owner, workspace, url: `${origin}/room/${room.slug}`, image });
    }
    return { title: null, meta: shareHeadTags({ title: workspace, url: new URL(url.pathname, origin).toString(), site: workspace, image }) };
  } catch {
    return null;
  }
}

/** The head for `/event/<slug>`, or null to keep the generic head. Never throws. */
export async function eventPageHead(env: Env, slug: string): Promise<{ title: string; meta: string } | null> {
  try {
    const event = await sessionEventBySlug(env, slug);
    if (!event) return null;
    return eventHeadTags({
      event,
      workspace: await workspaceDisplayName(env),
      url: signUpPageURL(env, event.slug),
      fallbackImage: new URL(await workspaceShareImagePath(env), workspacePublicOrigin(env)).toString(),
    });
  } catch {
    return null;
  }
}
