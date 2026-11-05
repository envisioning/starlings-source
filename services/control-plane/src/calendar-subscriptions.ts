import { CalendarError } from './calendar';
import type { CalendarSubscription, SubscriptionEventSummary } from '@starlings/contracts/calendar';
import type { OwnerSession } from './contracts';
import { randomToken } from './crypto';
import { parseICS } from './ics';

/**
 * Subscribed calendars — a published `.ics` feed the owner wants drawn beside
 * their own calendars, read-only.
 *
 * These live here rather than on the devices on purpose. macOS and iOS each
 * have their own subscription mechanism and the two do not share, so a feed
 * added on the Mac would be invisible on the phone. Subscribing once, for the
 * owner, is the whole point.
 */

export type { CalendarSubscription, SubscriptionEventSummary };

interface CachedFeed {
  fetchedAt: number;
  title: string;
  events: SubscriptionEventSummary[];
}

const maxSubscriptions = 20;
/** A feed changes on the scale of a trip being booked, not a page being drawn. */
const feedTTL = 30 * 60 * 1000;
const maxFeedBytes = 4 * 1024 * 1024;
const fetchTimeoutMs = 10_000;

export async function listSubscriptions(env: Env, owner: OwnerSession): Promise<CalendarSubscription[]> {
  const raw = await env.CALENDAR_TOKENS.get(subscriptionsKey(owner.sub));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Stored blobs are only ever written by this file, but a missing colour or
    // timestamp should read as "unset" rather than drop the whole row.
    return parsed.filter(isSubscription).map((entry) => ({
      ...entry,
      color: typeof entry.color === 'string' ? entry.color : '',
      addedAt: typeof entry.addedAt === 'number' ? entry.addedAt : 0,
    }));
  } catch {
    return [];
  }
}

export async function addSubscription(
  env: Env,
  owner: OwnerSession,
  input: { url: string; title?: string | undefined; color?: string | undefined },
): Promise<CalendarSubscription> {
  const url = normalizeFeedURL(input.url);
  const existing = await listSubscriptions(env, owner);
  if (existing.length >= maxSubscriptions) {
    throw new CalendarError(`You can subscribe to at most ${maxSubscriptions} calendars.`, 400, 'invalid_request');
  }
  if (existing.some((entry) => entry.url === url)) {
    throw new CalendarError('You are already subscribed to that calendar.', 409, 'invalid_request');
  }

  // Fetched once here so a bad address fails while the reader is still looking
  // at the field they typed it into, rather than silently drawing nothing.
  const feed = await fetchFeed(url);
  const subscription: CalendarSubscription = {
    id: randomToken(12),
    url,
    title: (input.title ?? '').trim() || feed.title || hostLabel(url),
    color: (input.color ?? '').trim(),
    addedAt: Date.now(),
  };
  await env.CALENDAR_TOKENS.put(
    subscriptionsKey(owner.sub),
    JSON.stringify([...existing, subscription]),
  );
  await cacheFeed(env, owner, subscription, feed);
  return subscription;
}

export async function removeSubscription(env: Env, owner: OwnerSession, id: string): Promise<void> {
  const existing = await listSubscriptions(env, owner);
  const remaining = existing.filter((entry) => entry.id !== id);
  if (remaining.length === existing.length) {
    throw new CalendarError('That subscription is already gone.', 404, 'invalid_request');
  }
  await env.CALENDAR_TOKENS.put(subscriptionsKey(owner.sub), JSON.stringify(remaining));
  await env.CALENDAR_TOKENS.delete(feedCacheKey(owner.sub, id));
}

/**
 * Every subscribed event that touches the window. A feed that cannot be reached
 * falls back to its last good copy, and failing that contributes nothing: one
 * unreachable subscription is not a reason to fail somebody's week.
 */
export async function subscriptionEvents(
  env: Env,
  owner: OwnerSession,
  timeMin: Date,
  timeMax: Date,
  subscriptionIDs?: ReadonlySet<string>,
): Promise<SubscriptionEventSummary[]> {
  const subscriptions = (await listSubscriptions(env, owner))
    .filter((subscription) => !subscriptionIDs || subscriptionIDs.has(subscription.id));
  const feeds = await Promise.all(subscriptions.map((subscription) => loadFeed(env, owner, subscription)));
  return feeds
    .flatMap((feed) => feed?.events ?? [])
    .filter((event) => Date.parse(event.start) < timeMax.getTime() && Date.parse(event.end) > timeMin.getTime());
}

async function loadFeed(
  env: Env,
  owner: OwnerSession,
  subscription: CalendarSubscription,
): Promise<CachedFeed | null> {
  const cached = await readCachedFeed(env, owner, subscription.id);
  if (cached && Date.now() - cached.fetchedAt < feedTTL) return cached;
  try {
    const feed = await fetchFeed(subscription.url);
    await cacheFeed(env, owner, subscription, feed);
    return { fetchedAt: Date.now(), title: feed.title, events: withIds(subscription, feed.events) };
  } catch {
    return cached;
  }
}

async function cacheFeed(
  env: Env,
  owner: OwnerSession,
  subscription: CalendarSubscription,
  feed: { title: string; events: Omit<SubscriptionEventSummary, 'id' | 'subscriptionId'>[] },
): Promise<void> {
  const payload: CachedFeed = {
    fetchedAt: Date.now(),
    title: feed.title,
    events: withIds(subscription, feed.events),
  };
  await env.CALENDAR_TOKENS.put(
    feedCacheKey(owner.sub, subscription.id),
    JSON.stringify(payload),
    { expirationTtl: 60 * 60 * 24 * 7 },
  );
}

function withIds(
  subscription: CalendarSubscription,
  events: Omit<SubscriptionEventSummary, 'id' | 'subscriptionId'>[],
): SubscriptionEventSummary[] {
  return events.map((event, index) => ({
    ...event,
    subscriptionId: subscription.id,
    id: `sub:${subscription.id}:${index}`,
  }));
}

async function readCachedFeed(env: Env, owner: OwnerSession, id: string): Promise<CachedFeed | null> {
  const raw = await env.CALENDAR_TOKENS.get(feedCacheKey(owner.sub, id));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedFeed;
    return Array.isArray(parsed.events) ? parsed : null;
  } catch {
    return null;
  }
}

async function fetchFeed(url: string): Promise<{
  title: string;
  events: Omit<SubscriptionEventSummary, 'id' | 'subscriptionId'>[];
}> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' },
      signal: AbortSignal.timeout(fetchTimeoutMs),
    });
  } catch {
    throw new CalendarError('That calendar address could not be reached.', 502, 'calendar_failed');
  }
  if (!response.ok) {
    throw new CalendarError('That calendar address answered with an error.', 502, 'calendar_failed');
  }

  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxFeedBytes) {
    throw new CalendarError('That calendar is too large to subscribe to.', 413, 'invalid_request');
  }
  const text = await response.text();
  if (text.length > maxFeedBytes) {
    throw new CalendarError('That calendar is too large to subscribe to.', 413, 'invalid_request');
  }
  if (!text.includes('BEGIN:VCALENDAR')) {
    throw new CalendarError('That address is not a calendar feed.', 400, 'invalid_request');
  }

  return { title: feedTitle(text), events: parseICS(text) };
}

function feedTitle(text: string): string {
  const match = /^X-WR-CALNAME:(.+)$/m.exec(text);
  return (match?.[1] ?? '').trim().slice(0, 120);
}

/**
 * `webcal://` is the same feed under a scheme browsers invented; everything
 * else has to be plain HTTP(S) to a public host. The host checks matter: this
 * URL is fetched by the server on the owner's behalf, so an address pointing
 * back inside the network would be asking the Worker to read something the
 * owner cannot.
 */
export function normalizeFeedURL(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new CalendarError('Paste a calendar address first.', 400, 'invalid_request');

  let url: URL;
  try {
    url = new URL(trimmed.replace(/^webcal:\/\//i, 'https://'));
  } catch {
    throw new CalendarError('That does not look like a calendar address.', 400, 'invalid_request');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new CalendarError('A calendar address must start with https:// or webcal://.', 400, 'invalid_request');
  }
  if (url.username || url.password) {
    throw new CalendarError('Remove the username and password from the address.', 400, 'invalid_request');
  }
  if (isPrivateHost(url.hostname)) {
    throw new CalendarError('That address points inside a private network.', 400, 'invalid_request');
  }
  url.hash = '';
  return url.toString();
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (octets) {
    const [a, b] = [Number(octets[1]), Number(octets[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  // A name with no dot cannot be public, and is the usual way an internal host
  // is spelled.
  return !host.includes('.');
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'Subscribed calendar';
  }
}

function isSubscription(value: unknown): value is CalendarSubscription {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === 'string'
    && typeof entry.url === 'string'
    && typeof entry.title === 'string';
}

function subscriptionsKey(ownerSub: string): string {
  return `calendar:subs:${ownerSub}`;
}

function feedCacheKey(ownerSub: string, id: string): string {
  return `calendar:sub-feed:${ownerSub}:${id}`;
}
