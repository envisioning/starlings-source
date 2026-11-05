/**
 * The path of the page being drawn. The prerender has no window, so it sets
 * `globalThis.MEET_PAGE_PATH` before it renders each page.
 */
export function currentPath(): string | undefined {
  const pathname = typeof window === 'undefined'
    ? (globalThis as { MEET_PAGE_PATH?: string }).MEET_PAGE_PATH
    : window.location.pathname;
  return pathname === undefined ? undefined : pathname.replace(/(.)\/$/u, '$1');
}
