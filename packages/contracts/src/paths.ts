// Room path grammar and public permalink rules, shared verbatim by the Worker
// (document routing, invite/calendar links) and the web SPA (client routing).
// Deliberately zod-free so the browser bundle never pays for schema code.

/** Canonical path for a permanent room or one booking inside that room. */
export function canonicalRoomPath(slug: string, bookingToken?: string): string {
  const base = `/room/${slug}`;
  if (!bookingToken) return base;
  return `${base}/${encodeURIComponent(bookingToken)}`;
}

/**
 * A room's link on a workspace's public origin (the descriptor's
 * `public_web_origin`, the Worker's `PUBLIC_WEB_ORIGIN`). Every caller names
 * the origin: there is no compiled default, so no workspace hands out
 * another workspace's host.
 */
export function roomPermalink(origin: string, slug: string, bookingToken?: string): string {
  return `${trimOrigin(origin)}${canonicalRoomPath(slug, bookingToken)}`;
}

/**
 * Deep link to the booking surface for a room. The room permalink above is for
 * "join me now"; this one is for "find a time" — the link a website's `/meet/<slug>`
 * hands off to, and the one to paste in an email that is not an invite yet.
 */
export function bookPermalink(origin: string, slug: string): string {
  return `${trimOrigin(origin)}/book/${slug}`;
}

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/u, '');
}

export type RoomPathParts = {
  slug: string;
  /** Optional CRM booking token from /room/<slug>/<token>. */
  bookingToken?: string;
};

/** Parse the canonical /room/<slug>[/<token>] document route. */
export function parsePublicRoomPath(pathname: string): RoomPathParts | null {
  const room = pathname.match(/^\/room\/([a-z0-9-]{2,40})(?:\/([^/]+))?\/?$/iu);
  if (room?.[1]) {
    const slug = room[1].toLowerCase();
    const bookingToken = sanitizeBookingToken(room[2]);
    return bookingToken ? { slug, bookingToken } : { slug };
  }
  return null;
}

/**
 * Parse `/book/<slug>` — the booking surface, reachable without first landing
 * on the room. Deliberately has no token form: booking is how a token comes to
 * exist, so a token here would mean nothing.
 */
export function parsePublicBookPath(pathname: string): { slug: string } | null {
  const match = pathname.match(/^\/book\/([a-z0-9-]{2,40})\/?$/iu);
  return match?.[1] ? { slug: match[1].toLowerCase() } : null;
}

/**
 * Parse `/event/<slug>`: an event's sign-up page on the workspace host
 * (docs/SESSIONS.md §0 S2). The slug grammar is `sessionSlugSchema`'s.
 */
export function parsePublicEventPath(pathname: string): { slug: string } | null {
  const match = pathname.match(/^\/event\/([a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?)\/?$/u);
  return match?.[1] ? { slug: match[1] } : null;
}

function sanitizeBookingToken(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let value: string;
  try {
    value = decodeURIComponent(raw).trim();
  } catch {
    value = raw.trim();
  }
  if (!value || value.length > 128) return undefined;
  return value;
}

// ---------------------------------------------------------------------------
// The product site: the pages behind the join for a company evaluating Meet.
// One list, read by the web's ProductNav, the SPA router, the Worker's
// public-document allowlist and its test, so a new product page is one row
// here and nowhere else. The door (`/`, `/join`, `/room`, `/book`) is not
// part of it: a guest with a room code is Envisioning's client arriving for a
// call, and is never shown Pricing. See docs/AUDIENCES_AND_IA.md §Prospect.

export type ProductDestination = 'why' | 'features' | 'pricing' | 'changelog';

/**
 * The tabs, in nav order. Each answers one question, the way the member nav
 * does: Why *why*, Features *what*, Pricing *what it costs*, Changelog *what
 * changed*. Interest is the product site's one action, not a place, and sits
 * in the header beside the nav — the seat Search and Settings have for a member.
 */
export const PRODUCT_DESTINATIONS: ReadonlyArray<{ id: ProductDestination; path: string; label: string }> = [
  { id: 'why', path: '/why', label: 'Why Starlings' },
  { id: 'features', path: '/workspace', label: 'Workspace' },
  { id: 'pricing', path: '/pricing', label: 'Pricing' },
  { id: 'changelog', path: '/changelog', label: 'Changelog' },
];

/** The product site's call to action. Chrome on every product page, never a tab. */
export const PRODUCT_INTEREST_PATH = '/interest';

/*
 * The agent path into the form (docs/FORMS.md §Agents). Here, not in
 * ./interest, so the build config can name them without loading zod.
 */
/** The fill guide is the form's markdown twin. */
export const INTEREST_GUIDE_PATH = '/interest.md';
/** The JSON Schema of an agent's submission, written by the site build. */
export const INTEREST_SCHEMA_PATH = '/interest.schema.json';
export const INTEREST_AGENT_API_PATH = '/api/interest/agent';
export const INTEREST_CONFIRM_API_PATH = '/api/interest/confirm';
/** Where the confirm mail links: the token rides in the fragment, so no server log holds it. */
export const INTEREST_CONFIRM_PATH = '/interest/confirm';

/**
 * Every path the product shell serves: the tabs, their children, the action,
 * and the legal documents that share the shell without an active tab.
 */
export const PRODUCT_SITE_PATHS: readonly string[] = [
  ...PRODUCT_DESTINATIONS.map((d) => d.path),
  '/workspace/capabilities',
  '/workspace/status',
  PRODUCT_INTEREST_PATH,
  '/privacy',
  '/terms',
];

/** A product-site path, with or without its trailing slash; case-insensitive like the rest of the site's routes. */
export function isProductSitePath(pathname: string): boolean {
  const path = pathname.replace(/\/$/u, '').toLowerCase();
  return PRODUCT_SITE_PATHS.includes(path);
}
