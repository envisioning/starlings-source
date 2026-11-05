import { ControlRequestError } from './config';

/**
 * What a failed calendar read means, decided once for the web calendar and the
 * Team panel. The Mac and iOS keep the same cases in
 * `CalendarRefreshFailure`; the Worker's code is the source of truth.
 */
export type CalendarFailureKind =
  /** The load was abandoned. Not a failure. */
  | 'cancelled'
  /** Meet's own session was refused. */
  | 'sign_in'
  /** Google refused the stored grant: reconnect in Settings. */
  | 'google_expired'
  /** This person never connected Google Calendar. */
  | 'not_connected'
  /** Offline, no answer, 5xx or a rate limit: a second try can work. */
  | 'transient'
  | 'other';

export function classifyCalendarFailure(cause: unknown): CalendarFailureKind {
  if (cause instanceof DOMException && cause.name === 'AbortError') return 'cancelled';
  if (cause instanceof ControlRequestError) {
    // Only a refused Meet session is "sign in". A 401/403 that carries a
    // calendar code is Google's refusal and reads as the Worker wrote it.
    if (cause.code === 'owner_auth_required' || (cause.status === 401 && !cause.code)) return 'sign_in';
    if (cause.code === 'calendar_expired') return 'google_expired';
    if (cause.code === 'calendar_not_connected') return 'not_connected';
    if (cause.status >= 500 || cause.status === 408 || cause.status === 429) return 'transient';
    return 'other';
  }
  // fetch() rejects with a TypeError when the request never got an answer.
  if (cause instanceof TypeError) return 'transient';
  return 'other';
}

/**
 * What Copy carries: the message, the classified cause, and the Worker's code,
 * status and request id, whichever are known. No emails, no event data.
 */
export function calendarFailureDetail(cause: unknown, message: string): string {
  const parts = [message, `cause: ${classifyCalendarFailure(cause)}`];
  if (cause instanceof ControlRequestError) {
    if (cause.code) parts.push(`code: ${cause.code}`);
    parts.push(`status: ${cause.status}`);
    if (cause.requestId) parts.push(`request: ${cause.requestId}`);
  } else if (cause instanceof Error) {
    parts.push(`${cause.name}: ${cause.message}`);
  }
  return parts.join(' · ');
}

/** Waits between the quiet retries of a read that failed transiently. */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];

/**
 * Runs `operation`, and when it fails in a way a second try can fix, tries
 * again after each delay before the failure is allowed out. A device waking
 * from sleep reaches the page before its network does; the banner should only
 * appear when the retries have also failed.
 */
export async function withTransientRetry<T>(
  operation: () => Promise<T>,
  options: { delays?: readonly number[]; isStale?: () => boolean; onRetry?: (attempt: number, cause: unknown) => void } = {},
): Promise<T> {
  const delays = [...(options.delays ?? TRANSIENT_RETRY_DELAYS_MS)];
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (cause) {
      const delay = delays.shift();
      if (delay === undefined || classifyCalendarFailure(cause) !== 'transient' || options.isStale?.()) throw cause;
      options.onRetry?.(attempt, cause);
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (options.isStale?.()) throw cause;
    }
  }
}

/** One no-PII line for the console: class, status, code, request id, attempt. */
export function logCalendarFailure(surface: string, cause: unknown, attempt: number, outcome: 'retrying' | 'shown'): void {
  const fields: Record<string, string | number> = { kind: classifyCalendarFailure(cause), attempt, outcome };
  if (cause instanceof ControlRequestError) {
    fields.status = cause.status;
    if (cause.code) fields.code = cause.code;
    if (cause.requestId) fields.request = cause.requestId;
  }
  console.warn(`[meet] ${surface} read failed`, fields);
}
