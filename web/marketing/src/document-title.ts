import { useEffect } from 'react';

/**
 * A page title with the site's name after it, unless the title already names
 * Starlings ("Why Starlings", not "Why Starlings · Starlings"). The prerender
 * (agent-surface.ts `pageTitle`) and the tab title after hydration both use it.
 */
export function withSiteName(title: string): string {
  return /\bStarlings\b/u.test(title) ? title : `${title} · Starlings`;
}

/**
 * The tab title after hydration, most specific part first. A page listed in
 * agent-surface.ts passes the same title as its entry there.
 */
export function useDocumentTitle(...parts: Array<string | null | undefined | false>) {
  const title = withSiteName(parts.filter(Boolean).join(' · ') || 'Starlings');
  useEffect(() => { document.title = title; }, [title]);
}
