/* Runs in every prerendered page head, before CSS and React: no theme flash.
 * Dark is the app and public-site default. The same preference key as the app keeps
 * the choice stable without loading workspace settings or sessions.
 *
 * It also marks the main-nav link a click asked for, so the underline moves
 * before the next page arrives. Each page is its own document load, and the
 * static home ships no React, so this lives here and not in SiteHeader.
 *
 * It also puts the wordmark's flock on the wall clock (gathering-dots.css), so
 * the dots keep their place from one page load to the next.
 */
(() => {
  const key = 'meet.appearance.mode';
  const valid = value => value === 'auto' || value === 'light' || value === 'dark';
  const read = () => {
    try {
      const saved = window.localStorage.getItem(key);
      return valid(saved) ? saved : 'dark';
    } catch { return 'dark'; }
  };
  const sync = preference => {
    document.documentElement.dataset.theme = preference;
    for (const select of document.querySelectorAll('[data-site-appearance]')) select.value = preference;
    // Both theme-color metas (dark and light media) take the canvas the page draws.
    const canvas = window.getComputedStyle(document.documentElement).getPropertyValue('--surface-bg').trim();
    if (canvas) for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.content = canvas;
  };
  document.documentElement.dataset.theme = read();
  // Seconds modulo one day keep the value small; the flock skips once at the wrap.
  document.documentElement.style.setProperty('--gathering-clock', `${(Date.now() / 1000) % 86400}s`);
  // The showcase wallpaper follows the visitor's local hour (house.css).
  const hour = new Date().getHours();
  document.documentElement.dataset.daypart = hour >= 5 && hour < 11 ? 'morning' : hour >= 11 && hour < 17 ? 'day' : hour >= 17 && hour < 20 ? 'evening' : 'night';
  document.addEventListener('DOMContentLoaded', () => sync(read()), { once: true });
  document.addEventListener('change', event => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !select.hasAttribute('data-site-appearance') || !valid(select.value)) return;
    try { window.localStorage.setItem(key, select.value); } catch { /* Session-only when storage is unavailable. */ }
    sync(select.value);
  });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) sync(read());
  });
  const nav = () => document.querySelectorAll('nav[aria-label="Main navigation"] a[href^="/"]');
  const mark = path => {
    for (const link of nav()) {
      const href = link.getAttribute('href');
      if (path === href || path.startsWith(`${href}/`)) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  };
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest('nav[aria-label="Main navigation"] a[href^="/"]') : null;
    if (link) mark(link.getAttribute('href'));
  });
  // Back restores a page from the browser cache with the click's mark on it.
  window.addEventListener('pageshow', event => {
    if (event.persisted) mark(window.location.pathname.replace(/\/$/, ''));
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => sync(document.documentElement.dataset.theme));
})();
