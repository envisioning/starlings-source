/** The Docs systems a rail groups into its two shared halves. */
export const DOCS_SOURCE_SYSTEMS = ['native', 'core', 'obsidian'] as const;
export type DocsSourceSystem = (typeof DOCS_SOURCE_SYSTEMS)[number];

export type DocsRailHalf = 'work' | 'library';
export const DOCS_RAIL_HALF_SOURCES: Record<DocsRailHalf, readonly DocsSourceSystem[]> = {
  work: ['native'],
  library: ['core', 'obsidian'],
};

/**
 * How a document body names an image attached to it: `![caption](docs-image:<id>)`,
 * the id Docs gave the upload (`POST /api/docs/:id/images`). Every client
 * writes this form and resolves it with the member's own session, so a body
 * never carries a URL that only one client can open.
 */
export const DOCS_IMAGE_SCHEME = 'docs-image:';

export function docsRailHalf(source: DocsSourceSystem): DocsRailHalf {
  return source === 'native' ? 'work' : 'library';
}

/**
 * What each fixed Docs row is called, and the line its list shows when empty,
 * on every client. A subject, a folder, a category and a search take their
 * own words (the subject's title, the folder's name, the query). The web reads
 * this table; the generator writes `DocsSelectionWords` for Swift
 * (`Sources/Generated/DocsValuesRegistry.swift`).
 */
export const DOCS_SELECTION_WORDS = {
  graph: { title: 'Graph', empty: 'There are no documents to show yet.' },
  recent: { title: 'Recent', empty: 'Documents you write appear here, newest first.' },
  unfiled: { title: 'Unfiled', empty: 'Everything is filed.' },
  links: { title: 'Links', empty: 'Paste or drop a link to save it.' },
  subject: { title: 'Subject', empty: 'Nothing written about this yet.' },
  folder: { title: null, empty: 'Nothing filed here yet.' },
} as const;
