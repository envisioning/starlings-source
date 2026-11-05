/* Counts visits to the product site in Plausible (docs/ANALYTICS.md).
 *
 * Each page is its own document load, and the static home ships no React, so
 * this is a plain script in every prerendered page head, like appearance.js.
 * It posts to this origin's /api/event; the site Worker checks the event
 * against packages/contracts/src/analytics.ts and forwards it. No cookie, no
 * storage, and no third-party origin.
 *
 * A link marked `data-event="Download"` counts a click, with each
 * `data-event-<key>` attribute as a property (`data-event-platform="mac"`).
 */
(() => {
  if (navigator.webdriver) return;
  const campaign = () => {
    const kept = new URLSearchParams();
    for (const [key, value] of new URLSearchParams(location.search)) {
      if (key === 'ref' || key.startsWith('utm_')) kept.append(key, value);
    }
    return kept.toString();
  };
  const path = (location.pathname.replace(/(.)\/$/u, '$1').toLowerCase().match(/^\/[a-z0-9/_-]{0,80}$/u) ?? ['/other'])[0];
  const send = (name, props) => {
    const body = { name, path, campaign: campaign(), referrer: document.referrer || undefined, props };
    // same-origin: under the site's no-referrer policy a POST would carry `Origin: null`, which the Worker refuses.
    fetch('/api/event', { method: 'POST', keepalive: true, referrerPolicy: 'same-origin', credentials: 'omit',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  };
  send('pageview');
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest('[data-event]') : null;
    if (!link) return;
    const props = {};
    for (const [key, value] of Object.entries(link.dataset)) {
      if (key.startsWith('event') && key !== 'event') props[key.slice(5).toLowerCase()] = value;
    }
    send(link.dataset.event, Object.keys(props).length ? props : undefined);
  });
  document.addEventListener('meet:assessment-completed', () => send('Assessment completed'));
})();
