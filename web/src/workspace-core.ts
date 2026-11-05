import { CORE_SUBJECT_COLLECTIONS, type CoreSubjectKind } from '@starlings/contracts/deployment';
import { coreCollectionGroup, isWorkGroup, WORK_GROUPS, type WorkGroup } from '@starlings/contracts/work-groups';

/** The descriptor's Core service, projected into the page by the Worker. Missing or off fails closed. */
export function workspaceCoreOrigin(): string | null {
  const page = (globalThis as { document?: { querySelector(selector: string): { content?: string } | null } }).document;
  const value = page?.querySelector('meta[name="workspace-core"]')?.content?.trim();
  if (!value || value === 'off') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The groups Core still holds, from the descriptor the Worker projects into
 * the page. A page from an older Worker has no such meta: every
 * group is still on Core there.
 */
export function workspaceCoreGroups(): ReadonlySet<WorkGroup> {
  const page = (globalThis as { document?: { querySelector(selector: string): { content?: string } | null } }).document;
  const value = page?.querySelector('meta[name="workspace-core-groups"]')?.content;
  if (value === undefined) return new Set(WORK_GROUPS);
  return new Set(value.split(',').map((group) => group.trim()).filter(isWorkGroup));
}

/** Whether Core's page for this dashboard collection still shows the record, not a stale copy. */
export function coreHoldsCollection(collection: string): boolean {
  const group = coreCollectionGroup(collection);
  return group === null || workspaceCoreGroups().has(group);
}

/** The collection a Core page path shows: `/dashboard/<collection>/…`, or `/contacts/…`. */
function collectionOfPath(pathname: string): string | null {
  const dashboard = /^\/dashboard\/([a-z_]+)/u.exec(pathname);
  if (dashboard) return dashboard[1]!;
  return pathname.startsWith('/contacts/') ? 'contacts' : null;
}

/**
 * A path on this workspace's Core, never an unrelated host returned in a
 * search result, and never a record whose group has moved to D1: Core
 * keeps only a stale copy of it.
 */
export function workspaceCoreURL(path: string): string | null {
  const origin = workspaceCoreOrigin();
  if (!origin) return null;
  try {
    const url = new URL(path, origin);
    if (url.origin !== origin) return null;
    const collection = collectionOfPath(url.pathname);
    return collection === null || coreHoldsCollection(collection) ? url.href : null;
  } catch {
    return null;
  }
}

export function coreDashboardURL(collection: string, id: string): string | null {
  return workspaceCoreURL(`/dashboard/${collection}/${id}`);
}

export function coreSubjectURL(kind: CoreSubjectKind, id: string): string | null {
  return coreDashboardURL(CORE_SUBJECT_COLLECTIONS[kind], encodeURIComponent(id));
}

/** Calendar contacts retain the same origin and path guard as the native clients. */
export function coreContactURL(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const origin = workspaceCoreOrigin();
  if (!origin) return null;
  try {
    const url = new URL(raw);
    return url.origin === origin && url.pathname.startsWith('/contacts/') && coreHoldsCollection('contacts') ? url.href : null;
  } catch {
    return null;
  }
}
