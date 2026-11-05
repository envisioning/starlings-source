import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { CalendarStatus } from '@starlings/contracts/calendar';
import { visibleSurfaces } from '@starlings/contracts/surface-visibility';
import type { MemberSurfaceId } from '@starlings/contracts/member-surfaces';
import { apiFetch } from './api';
import { readStored, StorageKeys, writeStored } from './storage';
import { workspaceHasDocs } from './workspace-brand';

/**
 * Whether the member has a calendar source: `sources` from
 * `GET /api/calendar/status`, read once per page. The web adds a source only
 * through Google's consent screen, which comes back as a new page load, so
 * one read is current. The last answer is kept on this browser so the first
 * frame draws the nav it will keep. Null while unknown, which shows Calendar.
 */
let sources: boolean | null = readSnapshot();
let fetched = false;
const listeners = new Set<() => void>();

function readSnapshot(): boolean | null {
  const stored = readStored(StorageKeys.calendarSources);
  return stored === '1' ? true : stored === '0' ? false : null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useCalendarSources(): boolean | null {
  const current = useSyncExternalStore(subscribe, () => sources, () => null);
  useEffect(() => {
    if (fetched) return;
    fetched = true;
    apiFetch<CalendarStatus>('/calendar/status', { fallbackError: '', noStore: true })
      .then((status) => {
        // An older Worker has no `sources`; its `connected` is the best it knows.
        sources = status.sources ?? status.connected;
        writeStored(StorageKeys.calendarSources, sources ? '1' : '0');
      })
      // Unknown keeps the last answer, or shows Calendar when there is none.
      .catch(() => {})
      .finally(() => listeners.forEach((listener) => listener()));
  }, []);
  return current;
}

/** The member destinations this page lists, in the contract's order (`surface-visibility.ts`). */
export function useVisibleSurfaces(): ReadonlySet<MemberSurfaceId> {
  const calendarSources = useCalendarSources();
  return useMemo(() => new Set(visibleSurfaces({ calendarSources, docs: workspaceHasDocs() })), [calendarSources]);
}
