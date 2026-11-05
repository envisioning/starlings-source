// Record permalinks: one address per record a member page opens,
// shared by the Worker (which paths get the SPA shell) and the web (which
// page draws a path, and what it opens there). Zod-free, so the browser
// entry pays nothing for it.
//
// The path names the record: `/<surface>/<kind>/<id>`. The query adds only
// context (Docs' `view`, Calendar's `day`, Work's `pane`) or a one-time verb
// (`new`, `edit`, `do`). A person or an agent is named by the local part of
// their address (`/team/person/ada`, `/team/agent/vocab`); every other
// record by its id.

import { SEARCH_SUBJECT_KINDS } from './search-values';
import { SUBJECT_KIND_ALIASES } from './subject-kinds';

export const PERMALINK_KINDS = {
  team: ['person', 'agent', 'thread'],
  // A contact is a Work record with a page of its own, not a subject.
  work: ['task', 'issue', 'contact', ...SEARCH_SUBJECT_KINDS],
  docs: ['document'],
  calendar: ['event'],
} as const;

export type PermalinkSurface = keyof typeof PERMALINK_KINDS;

export type Permalink = {
  [S in PermalinkSurface]: { surface: S; kind: (typeof PERMALINK_KINDS)[S][number]; id: string };
}[PermalinkSurface];

const MAX_ID_LENGTH = 512;

/** `owner/repo#n`, the id an issue door carries. Its path spells it `/work/issue/owner/repo/n`. */
const ISSUE_ID = /^([^/#\s]+)\/([^/#\s]+)#(\d+)$/u;

export function permalinkPath(link: Permalink): string {
  if (link.surface === 'work' && link.kind === 'issue') {
    const issue = ISSUE_ID.exec(link.id);
    if (issue) return `/work/issue/${encodeURIComponent(issue[1]!)}/${encodeURIComponent(issue[2]!)}/${issue[3]}`;
  }
  return `/${link.surface}/${link.kind}/${encodeURIComponent(link.id)}`;
}

function decodeSegment(raw: string): string | null {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  if (value.length === 0 || value.length > MAX_ID_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value;
}

/** The record a path names, or null when the path is not a permalink. */
export function parsePermalinkPath(pathname: string): Permalink | null {
  const issue = /^\/work\/issue\/([^/]+)\/([^/]+)\/(\d+)\/?$/u.exec(pathname);
  if (issue) {
    const owner = decodeSegment(issue[1]!);
    const repo = decodeSegment(issue[2]!);
    const id = owner && repo ? `${owner}/${repo}#${issue[3]}` : null;
    return id && ISSUE_ID.test(id) ? { surface: 'work', kind: 'issue', id } : null;
  }
  const match = /^\/([a-z]+)\/([a-z]+)\/([^/]+)\/?$/u.exec(pathname);
  if (!match) return null;
  const surface = match[1]!;
  // `/work/partner/<id>`, linked before ADR 0006, opens the organization.
  const kind = surface === 'work' && Object.hasOwn(SUBJECT_KIND_ALIASES, match[2]!) ? SUBJECT_KIND_ALIASES[match[2]!]! : match[2]!;
  if (!Object.hasOwn(PERMALINK_KINDS, surface)) return null;
  const kinds: readonly string[] = PERMALINK_KINDS[surface as PermalinkSurface];
  // An issue is only ever the three-segment form above.
  if (!kinds.includes(kind) || (surface === 'work' && kind === 'issue')) return null;
  const id = decodeSegment(match[3]!);
  return id ? ({ surface, kind, id } as Permalink) : null;
}

/** A person's or an agent's permalink name: the local part of the address, `vocab` for `vocab@example.com`. */
export function peerPermalinkName(email: string): string {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  return at > 0 ? address.slice(0, at) : address;
}
