/// <reference types="vite/client" />

declare module 'virtual:meet-help' {
  /** The product docs (reference and how-to) with their frontmatter, for /help. */
  export const helpDocs: Array<{
    path: string;
    slug: string;
    kind: 'reference' | 'howto';
    status: string;
    verified: string;
    summary: string;
    surface?: string;
    capabilities: string[];
    body: string;
  }>;
}

declare module 'virtual:meet-standard' {
  /** `standard/` (ADR 0005): agent instructions, portable skills and the MCP tool list, for /agents and /skills. */
  export const standard: {
    agents: { title: string; body: string };
    spec: { title: string; body: string; version: string; schema: Record<string, unknown>; conformance: { passed: number; failed: number; cases: string; runner: string; adapter: string } };
    skills: Array<{ name: string; description: string; title: string; body: string; source: string }>;
    tools: Array<{ name: string; summary: string }>;
  };
}

declare module 'virtual:meet-changelog' {
  /** changelog/: every release, newest first, and every update; an update with no version waits. */
  export const meetChangelog: {
    releases: import('@starlings/contracts/changelog').ChangelogRelease[];
    updates: import('@starlings/contracts/changelog').ChangelogUpdate[];
  };
}

declare module 'virtual:meet-styles-source' {
  /** `styles.css` as text. Only the vitest config answers this module. */
  export const stylesSource: string;
}

declare module 'virtual:meet-version' {
  export const meetVersion: string;
  export const meetBuild: string;
  /** `[YYYY-MM-DD, commits]` per day with at least one commit, oldest first. */
  export const meetActivity: Array<[string, number]>;
}
