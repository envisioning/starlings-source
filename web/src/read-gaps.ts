import type { CrmReadFailure, CrmReadFailureCause } from '@starlings/contracts';
import { t } from './i18n';

/**
 * What a Work read could not give in full, in words. A failure
 * is red with its cause and a Retry; a subject that only hit the row cap is
 * quiet grey copy. The Mac and the phone say the same in `WorkReadGaps`.
 */
function causeLabel(cause: CrmReadFailureCause | string): string {
  switch (cause) {
    case 'rate_limited': return t('busy, try again in a moment');
    case 'auth': return t('access refused');
    case 'timeout': return t('no answer in time');
    default: return t('the read failed');
  }
}

/** "Couldn’t read Envisioning Core: busy, try again in a moment (429)." — null when nothing failed. */
export function readFailureLine(read: { partial: string[]; failed?: CrmReadFailure[] }): string | null {
  // A Worker from before the split sends only names.
  const failed: CrmReadFailure[] = read.failed ?? read.partial.map((subject) => ({ subject, cause: 'upstream' }));
  if (failed.length === 0) return null;
  const list = failed
    .map((failure) => `${failure.subject}: ${causeLabel(failure.cause)}${failure.status ? ` (${failure.status})` : ''}`)
    .join('; ');
  return t('Couldn’t read {list}.', { list });
}

/** "Showing the first rows of Envisioning Meet." — null when nothing hit the cap. */
export function truncatedLine(read: { truncated?: string[] }): string | null {
  const truncated = read.truncated ?? [];
  if (truncated.length === 0) return null;
  return t('Showing the first rows of {names}.', { names: truncated.join(', ') });
}
