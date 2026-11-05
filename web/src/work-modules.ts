import { useSyncExternalStore, useEffect } from 'react';
import type { WorkModule } from '@starlings/contracts/work-modules';
import type { SubjectStateResponse } from '@starlings/contracts/subject-state';
import { fetchSubjectState } from './crm-work';
import { loadSnapshot, saveSnapshot } from './snapshot-store';

/** The Mac keeps the same answer under the same name. */
const SUBJECT_STATE_SNAPSHOT = 'crm/subject-state';

/**
 * The work modules this workspace has on (docs/WORK_MODEL.md), from the work
 * state the Worker already serves (`GET /api/crm/subject-state`). Last known
 * first (docs/CACHING.md), then read once per page. `known` is false until
 * either answers; `modules` null once known means an older Worker, which a
 * caller reads as every work module on.
 */
interface WorkModulesState {
  known: boolean;
  modules: readonly WorkModule[] | null;
}

function fromSnapshot(): WorkModulesState {
  const cached = loadSnapshot<SubjectStateResponse>(SUBJECT_STATE_SNAPSHOT);
  return cached ? { known: true, modules: cached.value.work_modules ?? null } : { known: false, modules: null };
}

let state: WorkModulesState = fromSnapshot();
let read = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const UNKNOWN: WorkModulesState = { known: false, modules: null };

export function useWorkModulesState(): WorkModulesState {
  const current = useSyncExternalStore(subscribe, () => state, () => UNKNOWN);
  useEffect(() => {
    if (read) return;
    read = true;
    void fetchSubjectState()
      .then((next) => {
        saveSnapshot(SUBJECT_STATE_SNAPSHOT, next);
        state = { known: true, modules: next.work_modules ?? null };
      })
      // Unknown keeps every module drawn, as before work modules existed.
      .catch(() => { if (!state.known) state = { known: true, modules: null }; })
      .finally(() => listeners.forEach((listener) => listener()));
  }, []);
  return current;
}

/** Null until known, and for an older Worker: every work module on. */
export function useWorkModules(): readonly WorkModule[] | null {
  return useWorkModulesState().modules;
}
