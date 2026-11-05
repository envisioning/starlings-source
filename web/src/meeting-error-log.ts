import { ControlRequestError } from './config';

/**
 * A rolling in-memory copy of the failures this tab hits, so the Debug control's
 * report can carry them alongside the statistics.
 *
 * Guests report "it wouldn't let me in" and the report says everything about
 * bitrates and nothing about the 409 that actually stopped them. Control-plane
 * calls and room-level failures record here; the report prints the tail.
 *
 * Only the request path (no query string), HTTP status, and the server's stable
 * error code are kept — never bodies, tokens, or lobby credentials, so the dump
 * stays as safe to paste as it was.
 */

/** Enough for a rough join sequence, small enough to stay pasteable. */
const CAPACITY = 50;

type Entry = {
  context: string;
  detail: string;
  firstAt: number;
  lastAt: number;
  count: number;
};

const entries: Entry[] = [];

/**
 * Records a failure under a short operation name ("join request", "room").
 * Anything can be passed as `error`; only its safe parts are kept.
 */
export function recordMeetError(context: string, error: unknown): void {
  append(context, describe(error), Date.now());
}

/** Report lines, oldest first. Empty until something has actually failed. */
export function meetErrorLogLines(): string[] {
  return entries.map((entry) => {
    let line = `${new Date(entry.firstAt).toISOString()} ${entry.context} — ${entry.detail}`;
    if (entry.count > 1) {
      // A poll failing for ten minutes is one line with a count, not 120
      // identical ones pushing everything else out of the buffer.
      line += ` (×${entry.count}, last ${new Date(entry.lastAt).toISOString()})`;
    }
    return line;
  });
}

/** Test seam — the buffer is module state that outlives a single room. */
export function resetMeetErrorLog(): void {
  entries.length = 0;
}

function append(context: string, detail: string, now: number): void {
  const last = entries[entries.length - 1];
  if (last && last.context === context && last.detail === detail) {
    last.lastAt = now;
    last.count += 1;
    return;
  }

  entries.push({ context, detail, firstAt: now, lastAt: now, count: 1 });
  if (entries.length > CAPACITY) entries.splice(0, entries.length - CAPACITY);
}

function describe(error: unknown): string {
  if (error instanceof ControlRequestError) {
    // The stable code is the greppable half; the prose is written for people
    // and is already safe to show.
    const code = error.code ? ` ${error.code}` : '';
    const requestId = error.requestId ? ` request_id=${error.requestId}` : '';
    return `HTTP ${error.status}${code}${requestId} — ${error.message}`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return typeof error === 'string' ? error : 'Unknown error';
}
