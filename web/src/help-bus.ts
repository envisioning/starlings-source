/*
 * Help: one panel, opened from the header's Help button, an INBOX
 * row or an error notice. This module is the one way to open it, and it
 * remembers the request id of the last failed request, so Help can name the
 * error a member came from without them typing it.
 */

const RECENT_MS = 10 * 60 * 1000;

let lastRequest: { id: string; at: number } | null = null;
const openers = new Set<(detail: HelpOpen) => void>();

export interface HelpOpen {
  /** Open this conversation instead of the list. */
  conversationId?: string;
}

/** Called where a failed request's answer names its request id. */
export function noteRequestId(requestId: string | undefined): void {
  if (requestId) lastRequest = { id: requestId, at: Date.now() };
}

/** The request id of a failure in the last ten minutes, if any. */
export function recentRequestId(): string | undefined {
  return lastRequest && Date.now() - lastRequest.at < RECENT_MS ? lastRequest.id : undefined;
}

export function openHelp(detail: HelpOpen = {}): void {
  for (const open of openers) open(detail);
}

/** True when a Help panel is mounted: only a signed-in member page has one. */
export function helpAvailable(): boolean {
  return openers.size > 0;
}

export function onOpenHelp(open: (detail: HelpOpen) => void): () => void {
  openers.add(open);
  return () => { openers.delete(open); };
}
