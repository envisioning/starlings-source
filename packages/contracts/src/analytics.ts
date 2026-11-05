// Usage counts in Plausible (docs/ANALYTICS.md). Two Plausible sites, one per
// surface: `the product site` for the product site and `the workspace domain` for the
// app. A browser never talks to Plausible. It posts an event to its own
// origin's `ANALYTICS_EVENT_PATH`, and that Worker forwards it with the
// Plausible domain from its own configuration. So both CSPs stay `'self'`, and
// a workspace whose Worker names no domain sends nothing.
//
// No imports and no zod: the site Worker (services/marketing/src/index.js)
// imports this file by path and runs it under plain Node in its test.

export const ANALYTICS_EVENT_PATH = '/api/event';

/** The largest event body a Worker reads. An event is a few hundred bytes. */
export const ANALYTICS_BODY_MAX_BYTES = 2048;

/**
 * Every event either surface sends. A Worker forwards no other name, so a
 * Plausible goal is set up for each name here and nothing else turns up.
 * `pageview` is Plausible's own name for a page view.
 */
export const ANALYTICS_EVENTS = [
  'pageview',
  // The product site.
  'Interest sent',
  'Assessment started',
  'Assessment completed',
  'Assessment interest opened',
  'Signup sent',
  'Download',
  'Plan picked',
  // The app.
  'Meeting joined',
  'Task created',
  'Doc created',
  'Message sent',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

/**
 * One event as a browser sends it. `path` is a page name, never the address
 * as typed: the app sends `/work`, not `/work/<task id>`, so no record id, room
 * slug or token reaches Plausible. `campaign` holds only the `utm_*` and `ref`
 * parameters of the address the visitor arrived on.
 */
export interface AnalyticsEvent {
  name: AnalyticsEventName;
  path: string;
  referrer?: string;
  campaign?: string;
  props?: Record<string, string>;
}

const PATH = /^\/[a-z0-9/_-]{0,80}$/u;
const CAMPAIGN_KEYS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref']);
const PROP_KEY = /^[a-z][a-z0-9_]{0,29}$/u;
const PROP_VALUE_MAX = 60;
const PROPS_MAX = 5;

/** The `utm_*` and `ref` parameters of a query string, and nothing else. */
export function campaignQuery(search: string): string {
  const kept = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(search)) {
    if (CAMPAIGN_KEYS.has(key) && value.length <= 100) kept.append(key, value);
  }
  return kept.toString();
}

/** A referrer's origin and path; its query and fragment can carry anything. */
function referrerOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? `${url.origin}${url.pathname}`.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

/** The event a body describes, or null when any part of it is not one this file allows. */
export function parseAnalyticsEvent(value: unknown): AnalyticsEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!(ANALYTICS_EVENTS as readonly unknown[]).includes(body.name)) return null;
  if (typeof body.path !== 'string' || !PATH.test(body.path)) return null;
  const event: AnalyticsEvent = { name: body.name as AnalyticsEventName, path: body.path };
  const referrer = referrerOf(body.referrer);
  if (referrer) event.referrer = referrer;
  if (typeof body.campaign === 'string' && body.campaign !== '') {
    const campaign = campaignQuery(body.campaign);
    if (campaign) event.campaign = campaign;
  }
  if (body.props !== undefined) {
    if (!body.props || typeof body.props !== 'object' || Array.isArray(body.props)) return null;
    const entries = Object.entries(body.props as Record<string, unknown>);
    if (entries.length > PROPS_MAX) return null;
    const props: Record<string, string> = {};
    for (const [key, prop] of entries) {
      if (!PROP_KEY.test(key) || typeof prop !== 'string' || prop.length > PROP_VALUE_MAX) return null;
      props[key] = prop;
    }
    if (entries.length > 0) event.props = props;
  }
  return event;
}

/**
 * The request to Plausible's Events API for one event seen on `request`.
 * Plausible counts a visitor from the user agent and the client address, so
 * both come from the browser's own request; the page address is this origin
 * and the event's page name.
 */
export function plausibleRequest(event: AnalyticsEvent, request: Request, domain: string): Request {
  const url = new URL(event.path, new URL(request.url).origin);
  if (event.campaign) url.search = event.campaign;
  const headers = new Headers({ 'content-type': 'application/json', 'user-agent': request.headers.get('user-agent') ?? '' });
  const ip = request.headers.get('cf-connecting-ip');
  if (ip) headers.set('x-forwarded-for', ip);
  return new Request('https://plausible.io/api/event', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      domain,
      name: event.name,
      url: url.toString(),
      ...(event.referrer ? { referrer: event.referrer } : {}),
      ...(event.props ? { props: event.props } : {}),
    }),
  });
}
