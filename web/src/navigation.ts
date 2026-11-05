import { useEffect, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

/**
 * In-document navigation between the pages App draws (docs/agents/areas/web.md, Navigation).
 *
 * Links stay real `<a href>`: an address can still be bookmarked, shared, or
 * opened in a second tab with ⌘-click. A plain click on one that App can draw
 * is taken here instead of by the browser, so the document, the chrome and
 * the session stay loaded and only the page under the header changes.
 *
 * App owns the route table and registers it with `configureRoutes`; this
 * module owns the history entries and the click. Anything App cannot draw
 * (a room, a booking, `/api`, another origin) stays a full page load, and
 * so does every link out of a room: a meeting owns its document from the
 * first byte to `pagehide`.
 */

export type RouteTable = {
  /** True when App draws this path without a page load. */
  handles(pathname: string): boolean;
  /** Fetch the page's code, so the page draws in one frame when it is shown. */
  preload(pathname: string): Promise<unknown>;
  /** True when App draws both paths with the same page (`/docs` and `/docs/document/<id>`). */
  samePage(a: string, b: string): boolean;
};

let routes: RouteTable | null = null;
/**
 * Changes on every navigation App draws. App keys the page with it, so a new
 * address mounts the page fresh, the way the page load before it did.
 */
const browser = typeof window !== 'undefined';
let pageKey = browser ? `${window.location.pathname}#0` : '/#0';
let sequence = 0;
/** The path a click asked for while its page code loads. */
let pending: string | null = null;
let committedPath = browser ? window.location.pathname : '/';
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The current page's key. App re-renders when it changes. */
export function usePageKey(): string {
  return useSyncExternalStore(subscribe, () => pageKey, () => pageKey);
}

/** The path a navigation is loading, for the nav to mark at once; null otherwise. */
export function usePendingPath(): string | null {
  return useSyncExternalStore(subscribe, () => pending, () => null);
}

/** Load a path's page code ahead of a click. Errors are the click's to handle. */
export function preloadPath(pathname: string): void {
  if (routes?.handles(pathname)) void routes.preload(pathname).catch(() => undefined);
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Show the new page. The header does not move; the page under it crosses
 * over in a view transition where the browser has one and motion is allowed.
 */
function show(apply: () => void) {
  const commit = () => {
    apply();
    committedPath = window.location.pathname;
    pending = null;
    sequence += 1;
    pageKey = `${window.location.pathname}#${sequence}`;
    emit();
  };
  const transition = (document as Document & { startViewTransition?: (update: () => void) => unknown }).startViewTransition;
  if (typeof transition === 'function' && !prefersReducedMotion() && document.visibilityState === 'visible') {
    transition.call(document, () => flushSync(commit));
  } else {
    commit();
  }
}

let latest = 0;

/**
 * Write the address of what the page shows: a record opened, or
 * closed. The page stays mounted. `push` adds a history entry; without it
 * the current entry changes. Every page write that changes the path goes
 * through here, so Back knows which path is on screen.
 */
export function writeAddress(href: string, { push = false }: { push?: boolean } = {}): void {
  const url = new URL(href, window.location.href);
  if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash === window.location.hash) return;
  if (push) window.history.pushState({ meetNav: true }, '', url.href);
  else window.history.replaceState({ ...(window.history.state ?? {}), meetNav: true }, '', url.href);
  committedPath = window.location.pathname;
}

/** Pages that answer Back and Forward between their own addresses. */
const historyOwners = new Set<object>();

/**
 * While mounted, Back or Forward between two paths this page draws is the
 * page's own `popstate` to answer (Docs, from one document to the one
 * before). A page without this is mounted fresh on that address instead,
 * and reads the record from it the way a page load does.
 */
export function useOwnsHistory(): void {
  useEffect(() => {
    const owner = {};
    historyOwners.add(owner);
    return () => { historyOwners.delete(owner); };
  }, []);
}

/** Pages holding something a page load would lose (Docs with unsaved text). */
const leaveGuards = new Set<object>();

/**
 * While `active`, leaving this page is a real page load, so the browser's own
 * "leave this page?" prompt (the page's `beforeunload`) still gets its say.
 */
export function useLeaveGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const guard = {};
    leaveGuards.add(guard);
    return () => { leaveGuards.delete(guard); };
  }, [active]);
}

/** App draws both ends in place: the page we are on, and the one asked for. */
function inPlace(url: URL): boolean {
  return url.origin === window.location.origin
    && leaveGuards.size === 0
    && Boolean(routes?.handles(window.location.pathname))
    && Boolean(routes?.handles(url.pathname));
}

/**
 * Go to `href`. A path App draws changes in place; anything else is a normal
 * page load. `replace` swaps the current history entry instead of adding one.
 */
export function navigate(href: string, { replace = false }: { replace?: boolean } = {}): void {
  const url = new URL(href, window.location.href);
  if (!routes || !inPlace(url)) {
    if (replace) window.location.replace(url.href);
    else window.location.assign(url.href);
    return;
  }
  if (url.pathname === window.location.pathname && url.search === window.location.search) {
    if (url.hash) window.location.hash = url.hash;
    else window.scrollTo({ top: 0 });
    return;
  }
  const request = ++latest;
  pending = url.pathname;
  emit();
  routes.preload(url.pathname).then(
    () => {
      if (request !== latest) return;
      show(() => {
        if (replace) window.history.replaceState({ meetNav: true }, '', url.href);
        else window.history.pushState({ meetNav: true }, '', url.href);
        window.scrollTo({ top: 0 });
      });
    },
    () => {
      // The page's code did not arrive (a deploy replaced the chunk, or the
      // network dropped). A page load fetches the new build, or says why not.
      if (request === latest) window.location.assign(url.href);
    },
  );
}

/** A click the browser should keep: modified, not the main button, or not ours. */
function linkToTake(event: MouseEvent): HTMLAnchorElement | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!(target instanceof HTMLAnchorElement)) return null;
  if (target.target && target.target !== '_self') return null;
  if (target.hasAttribute('download') || target.dataset.reload !== undefined) return null;
  const url = new URL(target.href, window.location.href);
  if (!inPlace(url)) return null;
  // Same page and only the fragment differs: the browser scrolls to it.
  if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return null;
  return target;
}

/**
 * Register App's routes and take clicks on links to them. Called once, before
 * the first render.
 */
export function configureRoutes(table: RouteTable): void {
  // The prerender (scripts/prerender.mjs) imports App with no window.
  if (routes || !browser) return;
  routes = table;
  // The first entry was made by a page load; mark it so Back to it is ours.
  const state: unknown = window.history.state;
  window.history.replaceState({ ...(state && typeof state === 'object' ? state : {}), meetNav: true }, '');

  // Bubble phase on the document: React's own handlers, and any
  // `preventDefault` in them, have already run.
  document.addEventListener('click', (event) => {
    const link = linkToTake(event);
    if (!link) return;
    event.preventDefault();
    navigate(link.href);
  });

  // Hover and focus are a click's early warning: fetch the page's code then.
  const warm = (event: Event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement)) return;
    const url = new URL(link.href, window.location.href);
    if (url.origin === window.location.origin) preloadPath(url.pathname);
  };
  document.addEventListener('pointerover', warm, { passive: true });
  document.addEventListener('focusin', warm);

  window.addEventListener('popstate', () => {
    const pathname = window.location.pathname;
    // Same path, different query: the page made this entry itself (Docs
    // keeps its open document in the query) and answers Back on its own.
    if (pathname === committedPath) return;
    // Another record on the same page, and the page answers Back itself.
    if (historyOwners.size > 0 && routes?.handles(pathname) && routes.samePage(pathname, committedPath)) {
      committedPath = pathname;
      return;
    }
    if (!routes?.handles(pathname) || leaveGuards.size > 0) {
      window.location.reload();
      return;
    }
    const request = ++latest;
    pending = pathname;
    emit();
    routes.preload(pathname).then(
      () => { if (request === latest) show(() => undefined); },
      () => { if (request === latest) window.location.reload(); },
    );
  });
}
