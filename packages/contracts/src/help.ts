import helpIndex from './help-index.json';

/**
 * The help pages, as `scripts/gen-doc-map.mjs` wrote them from the docs'
 * frontmatter: which page covers which capability. The Worker uses it to
 * point an MCP tool at the pages for the capabilities it reaches; the web
 * renders the pages themselves from the build-time module.
 */
export type HelpPage = {
  slug: string;
  kind: 'reference' | 'howto';
  summary: string;
  surface?: string;
  capabilities: string[];
};

export const HELP_PAGES: HelpPage[] = helpIndex.pages as HelpPage[];

/** The site path of a help page. */
export function helpPath(slug: string): string {
  return `/help/${slug}`;
}

/** Every help page that covers one of these capability ids, surfaces first, in index order. */
export function helpPagesFor(capabilityIds: readonly string[]): HelpPage[] {
  const wanted = new Set(capabilityIds);
  return HELP_PAGES
    .filter((page) => page.capabilities.some((id) => wanted.has(id)))
    .sort((a, b) => Number(b.kind === 'reference') - Number(a.kind === 'reference'));
}
