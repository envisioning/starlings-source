import { crmSubjectKindSchema, type CrmContact, type CrmSubject, type DocsDocumentSummary, type DocsFolder, type ThreadSummary } from './index';
import { searchDoorString, type SearchRow } from './search';

/**
 * The rows a subject, a conversation and a document become — on the Worker,
 * when `GET /api/search` answers, and on the web, when Work, Team or Docs
 * opens one by hand and writes it into the device's recents. One builder
 * each, so a row opened from a list and the same row opened from the palette
 * are one entry, not two. Swift: Sources/SearchRecentRows.swift.
 */

function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function subjectSearchRow(subject: Pick<CrmSubject, 'id' | 'kind' | 'title' | 'subtitle' | 'organization_logo_url'>): SearchRow {
  const kind = capitalized(subject.kind);
  const image = subject.organization_logo_url?.trim();
  return {
    kind: 'subject',
    id: subject.id,
    title: subject.title,
    subtitle: subject.subtitle ? `${kind} · ${subject.subtitle}` : kind,
    door: searchDoorString({ to: 'subject', subjectKind: subject.kind, id: subject.id }),
    ...(image ? { image } : {}),
  };
}

/**
 * A contact as a row: the name, then what they do, where, and
 * the primary address, so a query for the organization or the address finds
 * them too. The door is the contact's id; an address can change, the id
 * cannot.
 */
export function contactSearchRow(contact: Pick<CrmContact, 'id' | 'name' | 'title' | 'organization_name' | 'email'>): SearchRow {
  const name = contact.name?.trim();
  const context = [contact.title, contact.organization_name, name ? contact.email : null]
    .filter((part): part is string => Boolean(part?.trim()));
  return {
    kind: 'contact',
    id: contact.id,
    title: name || contact.email || 'Contact',
    subtitle: context.join(' · '),
    door: searchDoorString({ to: 'contact', id: contact.id }),
  };
}

export function threadSearchTitle(thread: ThreadSummary): string {
  if (thread.title) return thread.title;
  const peers = thread.peers ?? [];
  if (peers.length > 0) return peers.map((peer) => peer.name?.trim() || peer.email).join(', ');
  return thread.peer_name?.trim() || thread.peer_email || 'Conversation';
}

/**
 * A conversation as a row. A DM with one other peer is that peer's row
 * (`person:<email>` or `agent:<email>`), the same row the roster gives: one
 * face, one entry in the recents, one door. A group or a channel is a thread.
 */
export function threadSearchRow(thread: ThreadSummary): SearchRow {
  if (thread.kind === 'dm') {
    const peers = thread.peers ?? [];
    const only = peers.length === 1 ? peers[0] : peers.length === 0 && thread.peer_email
      ? { email: thread.peer_email, name: thread.peer_name, kind: 'human' as const }
      : null;
    if (only) {
      const agent = only.kind === 'agent';
      return {
        kind: agent ? 'agent' : 'person',
        id: only.email,
        title: only.name?.trim() || only.email,
        subtitle: agent ? 'Agent' : only.email,
        door: searchDoorString({ to: agent ? 'agent' : 'person', id: only.email }),
      };
    }
  }
  const subtitle = thread.kind === 'dm'
    ? ((thread.peers?.length ?? 0) > 1 ? 'Group' : 'Direct message')
    : thread.kind === 'team' ? 'The internal room' : 'Channel';
  return {
    kind: 'thread',
    id: thread.id,
    title: threadSearchTitle(thread),
    subtitle,
    door: searchDoorString({ to: 'thread', id: thread.id }),
  };
}

/**
 * A conversation as the row the device's recents keep. A subject's channel
 * is that subject's row: the conversation pane is one of the subject's
 * panes, so opening it after the subject is one entry, not a folder tile
 * beside a bubble tile with the same name. The thread knows the subject's
 * id and title, not its logo — `storeRecent` keeps a stored logo. Search
 * still uses `threadSearchRow`, where the channel is its own door. Swift:
 * `SearchRow.thread` in SearchRecentRows.swift.
 */
export function threadRecentRow(thread: ThreadSummary): SearchRow {
  const kind = crmSubjectKindSchema.safeParse(thread.kind);
  if (thread.parent_id && kind.success) {
    return subjectSearchRow({ id: thread.parent_id, kind: kind.data, title: threadSearchTitle(thread), subtitle: null });
  }
  return threadSearchRow(thread);
}

/**
 * A document's row. The subtitle is its category's label when the caller
 * has the workspace's categories at hand (they are data, read from Docs),
 * else where it came from.
 */
export function documentSearchRow(document: Pick<DocsDocumentSummary, 'id' | 'title' | 'source_system'>, categoryLabel?: string | null): SearchRow {
  return {
    kind: 'document',
    id: document.id,
    title: document.title,
    subtitle: categoryLabel || capitalized(document.source_system),
    door: searchDoorString({ to: 'document', id: document.id }),
  };
}

/** A document opened by id and title alone, before its summary is read. */
export function documentSearchRowByID(id: string, title: string, subtitle = 'Document'): SearchRow {
  return { kind: 'document', id, title, subtitle, door: searchDoorString({ to: 'document', id }) };
}

/** A folder is keyed by its durable Docs id; its mutable path is only its subtitle. */
export function folderSearchRow(folder: Pick<DocsFolder, 'id' | 'title' | 'path'>): SearchRow {
  return {
    kind: 'folder',
    id: folder.id,
    title: folder.title,
    subtitle: folder.path,
    door: searchDoorString({ to: 'folder', id: folder.id }),
  };
}
