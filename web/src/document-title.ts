import { useEffect } from 'react';

/**
 * The tab title, the way the Mac titles a window by surface
 * (`StarlingsWindowChrome.apply`): `Docs · Starlings`, and the open item first when
 * there is one — `Board notes · Docs · Starlings`. Home is the product name.
 *
 * A navigation mounts the new page fresh (navigation.ts), so a page sets
 * its title once on mount and again when what it shows changes. Every
 * routed page sets one: a page that did not would keep the last one's. Blank parts drop out,
 * so a page can pass the open item's title before it has loaded.
 */

const PRODUCT = 'Starlings';
const SHORT = 'Starlings';

type TitlePart = string | null | undefined | false;

export function formatDocumentTitle(parts: TitlePart[]): string {
  const clean = parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part.length > 0);
  return clean.length === 0 ? PRODUCT : `${clean.join(' · ')} · ${SHORT}`;
}

/** Most specific part first: `useDocumentTitle(document?.title, 'Docs')`. */
export function useDocumentTitle(...parts: TitlePart[]): void {
  const title = formatDocumentTitle(parts);
  useEffect(() => {
    document.title = title;
  }, [title]);
}
