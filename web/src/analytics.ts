/**
 * Usage counts for the web app, in Plausible (docs/ANALYTICS.md).
 *
 * The Worker writes `<meta name="analytics" content="on">` only where it names
 * a Plausible site (PLAUSIBLE_DOMAIN: Envisioning). Without it, as on every
 * other workspace and the Vite dev server, nothing here sends anything.
 *
 * An event goes to this origin's `/api/event`, never to Plausible. Its page is
 * a page name (`/work`, `/room`), never the address: record ids, room slugs
 * and tokens stay in the browser.
 */
import { ANALYTICS_EVENT_PATH, campaignQuery, type AnalyticsEvent, type AnalyticsEventName } from '@starlings/contracts/analytics';

let enabled: boolean | null = null;
let page = '/other';
let first = true;

function counting(): boolean {
  enabled ??= typeof document !== 'undefined'
    && document.querySelector('meta[name="analytics"]')?.getAttribute('content') === 'on'
    && !navigator.webdriver;
  return enabled;
}

function send(event: AnalyticsEvent): void {
  if (!counting()) return;
  // same-origin: under the app's no-referrer policy a POST carries
  // `Origin: null`, and the route's web-origin gate refuses that.
  void fetch(ANALYTICS_EVENT_PATH, {
    method: 'POST',
    keepalive: true,
    credentials: 'omit',
    referrerPolicy: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
  }).catch(() => undefined);
}

/**
 * Count a page view. The first one of a document load carries where the
 * visitor came from; later ones are moves inside the app.
 */
export function trackPageview(name: string): void {
  page = name;
  const arrival = first ? { referrer: document.referrer || undefined, campaign: campaignQuery(window.location.search) || undefined } : {};
  first = false;
  send({ name: 'pageview', path: name, ...arrival });
}

/** Count one thing a person did, on the page they did it on. */
export function track(name: Exclude<AnalyticsEventName, 'pageview'>, props?: Record<string, string>): void {
  send({ name, path: page, ...(props ? { props } : {}) });
}
