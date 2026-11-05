// What a fan-out read could not give in full. Two different
// things used to share one `partial` list: a subject that answered but hit
// the row cap (nothing failed; the first rows are there), and a subject whose
// read failed (Core 429, GitHub refused, a timeout). Clients drew both red.
//
// `partial` stays on the wire as the failed titles, so a client from before
// the split shows red only for a real failure; `truncated` and `failed` are
// the new fields (`@starlings/contracts/crm`).

import type { CrmReadFailure, CrmReadFailureCause } from '@starlings/contracts/crm';
import { ControlError } from './errors';

export interface ReadGaps {
  /** Answered, but hit the row cap. */
  truncated: string[];
  /** Did not answer, with the cause. */
  failed: CrmReadFailure[];
}

export function emptyReadGaps(): ReadGaps {
  return { truncated: [], failed: [] };
}

/** The cause a client can name, from whatever the read threw. */
export function readFailureOf(subject: string, error: unknown): CrmReadFailure {
  const status = error instanceof ControlError ? error.status : undefined;
  let cause: CrmReadFailureCause = 'upstream';
  if (status === 429 || (error instanceof ControlError && error.code === 'rate_limited')) cause = 'rate_limited';
  else if (status === 401 || status === 403) cause = 'auth';
  else if (status === 504 || isTimeout(error)) cause = 'timeout';
  return { subject, cause, ...(status !== undefined && status >= 400 ? { status } : {}) };
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'TimeoutError' || error.name === 'AbortError' || /timed? ?out/i.test(error.message);
}

/** One failure per subject, the first cause kept; truncation names each subject once and never one that failed. */
export function settleReadGaps(gaps: ReadGaps): { partial: string[]; truncated: string[]; failed: CrmReadFailure[] } {
  const failed: CrmReadFailure[] = [];
  const seen = new Set<string>();
  for (const failure of gaps.failed) {
    if (seen.has(failure.subject)) continue;
    seen.add(failure.subject);
    failed.push(failure);
  }
  const truncated = [...new Set(gaps.truncated)].filter((subject) => !seen.has(subject));
  return { partial: failed.map((failure) => failure.subject), truncated, failed };
}
