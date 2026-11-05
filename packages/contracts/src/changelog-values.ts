/**
 * The changelog as data. One update is one file, `changelog/updates/<id>.md`:
 * a flat frontmatter block, then the update's Markdown. The first bold
 * sentence is its headline. A reader starts at the area, opens an update's
 * headline, then its detail and refs.
 *
 * `changelog/releases.json` lists every release, newest first, with its date
 * and, for some early releases, a one-paragraph summary.
 *
 * These tables carry no zod, so a page can import them without the
 * validator. The wire schemas are in `changelog.ts`. See changelog/README.md.
 */

/**
 * The area tags. The first six roots are the product areas, in the order of
 * `PRODUCT_AREAS` (web/marketing/src/features.tsx). `agents` and `foundation`
 * are that file's cross-area groups. `site` and `ops` are outside the app.
 * A child is `<root>/<child>`.
 */
export const CHANGELOG_AREAS = [
  { id: 'work', title: 'Work', scope: 'Projects, tasks, issues, the Board, goals, decisions, clients, leads and organizations.' },
  { id: 'work/events', title: 'Events', scope: 'Events, sign-up pages, reminders and follow-ups.' },
  { id: 'messages', title: 'Messages', scope: 'Chat, channels, INBOX, guest messages and email.' },
  { id: 'calls', title: 'Calls', scope: 'Rooms, the waiting room, recording, transcripts, captions, presence and waves.' },
  { id: 'docs', title: 'Docs', scope: 'Documents, categories, quick notes and sharing a document.' },
  { id: 'calendar', title: 'Calendar', scope: 'Calendars, feeds and bookings.' },
  { id: 'keep', title: 'Keep', scope: 'Sealed vaults for credentials.' },
  { id: 'agents', title: 'Agents', scope: 'MCP, agents on the Team, the attention queue and agent requests.' },
  { id: 'foundation', title: 'Foundation', scope: 'Home, search, Help, sign-in, settings, workspace look, the apps themselves, performance and language.' },
  { id: 'site', title: 'Site', scope: 'The public website: home, features, pricing, help pages and this changelog.' },
  { id: 'ops', title: 'Ops', scope: 'The operator console and what it reports.' },
] as const;

export type ChangelogArea = (typeof CHANGELOG_AREAS)[number]['id'];
export const CHANGELOG_AREA_IDS = CHANGELOG_AREAS.map((area) => area.id) as [ChangelogArea, ...ChangelogArea[]];

/** The root of an area: `work/events` → `work`. */
export function changelogAreaRoot(area: ChangelogArea): ChangelogArea {
  return area.replace(/\/.*$/u, '') as ChangelogArea;
}

/** What kind of change an update is. */
export const CHANGELOG_KINDS = ['new', 'improved', 'fixed', 'removed'] as const;
export type ChangelogKind = (typeof CHANGELOG_KINDS)[number];

/**
 * An update's two levels: the headline a reader scans, and the detail they
 * open. The headline is the leading bold run, or else the first sentence.
 */
export function changelogHeadline(body: string): { headline: string; detail: string } {
  const none = '';
  const lead = /^\*\*([\s\S]+?)\*\*\s*/u.exec(body) ?? /^([\s\S]+?[.!?])(?:\s+|$)/u.exec(body);
  if (!lead) return { headline: body.replace(/\s+/gu, ' '), detail: none };
  return { headline: (lead[1] ?? none).replace(/\s+/gu, ' ').trim(), detail: body.slice(lead[0].length).trim() };
}

/**
 * The order of updates inside one release. A backfilled id is
 * `<version>-<position>` and keeps its old order. A later id starts with its
 * date, and the newest comes first.
 */
export function changelogReleaseOrder(a: { id: string }, b: { id: string }): number {
  const position = (id: string) => Number(/^\d+\.\d+\.\d+-(\d+)$/u.exec(id)?.[1] ?? 0);
  return position(a.id) - position(b.id) || b.id.localeCompare(a.id);
}
