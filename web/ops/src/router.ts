// The dashboard's pages, one URL each, so a page can be linked, reloaded and
// opened in a new tab (docs/OPS_CONSOLE.md §Dashboard). History API only.
// The pages are `opsDashboardRoute` in the contract; the Worker answers each
// with index.html.
import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { opsDashboardRoute, type OpsDashboardRoute } from '@starlings/contracts/ops';

export type Route = OpsDashboardRoute | { page: 'not-found' };

export function parseRoute(pathname: string): Route {
  return opsDashboardRoute(pathname) ?? { page: 'not-found' };
}

interface Location { pathname: string; search: string }

const current = (): Location => ({ pathname: window.location.pathname, search: window.location.search });

/** The current location, and a way to move to another page or to change the query in place. */
export function useLocation() {
  const [location, setLocation] = useState<Location>(current);

  useEffect(() => {
    const onPop = () => setLocation(current());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((href: string) => {
    const url = new URL(href, window.location.origin);
    if (url.pathname + url.search === window.location.pathname + window.location.search) return;
    window.history.pushState(null, '', url.pathname + url.search);
    setLocation(current());
    window.scrollTo(0, 0);
  }, []);

  /** Set or clear one query value without a new history entry: a view setting, not a new page. */
  const setParam = useCallback((name: string, value: string | null) => {
    const url = new URL(window.location.href);
    if (value === null) url.searchParams.delete(name);
    else url.searchParams.set(name, value);
    window.history.replaceState(null, '', url.pathname + url.search);
    setLocation(current());
  }, []);

  return { location, route: parseRoute(location.pathname), navigate, setParam };
}

/** A plain click on an in-app link moves in place; a modified click (new tab, new window) is left to the browser. */
export function inAppClick(event: MouseEvent<HTMLAnchorElement>, navigate: (href: string) => void): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(event.currentTarget.getAttribute('href') ?? '/');
}
