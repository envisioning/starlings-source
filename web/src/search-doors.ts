import { t } from './i18n';
import { MEMBER_SURFACES, type MemberSurfaceId } from '@starlings/contracts/member-surfaces';
import {
  rememberSearchRecent,
  isSearchRow,
  parseSearchDoor,
  searchDoorString,
  searchRowKey,
  type SearchDoor,
  type SearchRow,
  type SearchRowVerb,
} from '@starlings/contracts/search-values';
import { workspaceCoreOrigin, workspaceCoreURL } from './workspace-core';
import { StorageKeys, readStored, writeStored } from './storage';
import { contactHref, documentHref, eventHref, issueHref, peerHref, subjectHref, taskHref, teamThreadHref } from './work-hrefs';

/**
 * The half of ⌘K every page can import without loading the palette: the
 * open event, where a door goes on this client, and this device's recents.
 * The palette itself (SearchPalette.tsx: cmdk and a Radix dialog) loads the
 * first time it opens (SearchPaletteHost.tsx), so it stays off the guest
 * entry path.
 */

export const OPEN_EVENT = 'meet:search-open';

/**
 * What a caller hands the palette as it opens: words already in the field,
 * and a scope that narrows it to one surface's kinds. Work's rail tail opens
 * it this way ("Search Docs for …").
 */
export interface SearchPaletteRequest {
  query?: string;
  scope?: 'docs';
}

/** The header icon and anything else that wants the palette up. */
export function openSearchPalette(request: SearchPaletteRequest = {}): void {
  window.dispatchEvent(new CustomEvent<SearchPaletteRequest>(OPEN_EVENT, { detail: request }));
}

const DESTINATION_HREFS = Object.fromEntries(MEMBER_SURFACES.map((surface) => [surface.id, surface.path])) as Record<MemberSurfaceId, string>;

/**
 * Where a door goes on this client. A record's door is its permalink
 *. A Core entity is Core's own page for it. A Core entity is Core's own page for it.
 */
export function hrefForDoor(door: SearchDoor, context: { roomSlug: string | null; verb?: SearchRowVerb }): string | null {
  switch (door.to) {
    case 'destination': return DESTINATION_HREFS[door.destination];
    case 'settings': return `/settings#settings-${door.page}`;
    case 'verb':
      switch (door.verb) {
        case 'new-document': return '/docs?new=document';
        case 'start-room': return context.roomSlug ? `/room/${encodeURIComponent(context.roomSlug)}` : null;
        case 'open-internal-room': return '/room/team';
        default: return null;
      }
    case 'subject': {
      // A subject verb opens the subject's own editor, read by
      // WorkPage the way Calendar reads `?new=meeting`.
      const subject = { kind: door.subjectKind, id: door.id };
      if (context.verb === 'new-task') return subjectHref(subject, { pane: 'tasks', new: 'task' });
      if (context.verb === 'new-issue') return subjectHref(subject, { pane: 'issues', new: 'issue' });
      if (context.verb === 'new-document') return subjectHref(subject, { pane: 'documents', new: 'document' });
      return subjectHref(subject);
    }
    case 'person':
    case 'agent': {
      const path = peerHref({ email: door.id, kind: door.to });
      return context.verb === 'wave' || context.verb === 'call' ? `${path}?do=${context.verb}` : path;
    }
    // A person outside the team: their page in Work.
    case 'contact': return contactHref(door.id);
    case 'thread': return teamThreadHref(door.id);
    case 'document': return documentHref(door.id);
    case 'folder': return `/docs?folder=${encodeURIComponent(door.id)}`;
    // Calendar loads the week, then opens the event. The id is
    // `calendarId:eventId`, matched whole or by its Google tail.
    case 'event': return eventHref(door.id);
    case 'task': return taskHref(door.id);
    // Work reads the issue in its own column; GitHub stays one click away
    // from there. The id is `owner/repo#n` and Work parses it.
    case 'issue': return issueHref(door.id);
    // The web does not browse Core: an entity's door is Core's
    // own list of it, opened beside the app (`isExternalDoor`).
    case 'core': return workspaceCoreURL(`/dashboard/${encodeURIComponent(door.id)}`);
  }
}

/** A door whose page is not Meet's: it opens in a new tab, never over the app. */
export function isExternalDoor(door: SearchDoor): boolean {
  return door.to === 'core';
}

// MARK: - Recents, per device

/** Fired on `window` after a row lands, so Home's Quick Access module redraws. */
export const SEARCH_RECENTS_EVENT = 'meet:search-recents';

/** How many rows Home's Quick Access module draws; the palette ranks by the whole list. */
export const HOME_RECENT_LIMIT = 8;

export function loadRecents(): SearchRow[] {
  try {
    const parsed: unknown = JSON.parse(readStored(StorageKeys.searchRecents) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      return isSearchRow(entry) && (entry.kind !== 'core' || workspaceCoreOrigin()) ? [entry] : [];
    });
  } catch {
    return [];
  }
}

/**
 * Old browsers may have saved an agent as a person before the thread carried
 * its peer kind. The roster is authoritative, so promote those cached rows
 * and write the corrected identity back to the one per-device recent list.
 */
export function reconcileAgentRecents(agentEmails: ReadonlySet<string>): SearchRow[] {
  const current = loadRecents();
  const next: SearchRow[] = [];
  const seen = new Set<string>();

  for (const row of current) {
    const door = parseSearchDoor(row.door);
    let resolved = row;
    if (
      (row.kind === 'person' || row.kind === 'agent')
      && door && (door.to === 'person' || door.to === 'agent')
      && agentEmails.has(door.id.toLowerCase())
    ) {
      resolved = {
        ...row,
        kind: 'agent',
        subtitle: t('Agent'),
        door: searchDoorString({ to: 'agent', id: door.id }),
      };
    }

    const key = searchRowKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(resolved);
  }

  if (JSON.stringify(current) !== JSON.stringify(next)) {
    writeStored(StorageKeys.searchRecents, JSON.stringify(next));
    window.dispatchEvent(new Event(SEARCH_RECENTS_EVENT));
  }
  return next;
}

/**
 * A thing was opened — from the palette, or by hand in Work, Team or Docs.
 * One list, so Home's Quick Access and the palette's Recent agree.
 */
export function storeRecent(row: SearchRow): SearchRow[] {
  const current = loadRecents().filter((entry) => {
    const bothArePeers = (row.kind === 'person' || row.kind === 'agent')
      && (entry.kind === 'person' || entry.kind === 'agent');
    return !bothArePeers || entry.id.toLowerCase() !== row.id.toLowerCase() || entry.kind === row.kind;
  });
  const keys = rememberSearchRecent(current.map(searchRowKey), row);
  const byKey = new Map(current.map((entry) => [searchRowKey(entry), entry]));
  // A row written again keeps a mark the newer write does not know: a
  // subject's channel knows its id and title, not its logo.
  const stored = byKey.get(searchRowKey(row));
  byKey.set(searchRowKey(row), !row.image && stored?.image ? { ...row, image: stored.image } : row);
  const next = keys.flatMap((key) => {
    const found = byKey.get(key);
    return found ? [found] : [];
  });
  writeStored(StorageKeys.searchRecents, JSON.stringify(next));
  window.dispatchEvent(new Event(SEARCH_RECENTS_EVENT));
  return next;
}
