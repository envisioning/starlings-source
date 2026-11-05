import type {
  ThreadArchiveInput,
  ThreadArchiveResponse,
  ThreadMuteInput,
  ThreadMuteResponse,
  ThreadReadInput,
  ThreadReadResponse,
  ThreadSummary,
  ThreadsResponse,
} from '@starlings/contracts';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from './api';
import { subscribePoll, THREADS_POLL_KEY } from './shared-poll';
import { loadSnapshot, saveSnapshot } from './snapshot-store';
import { t } from './i18n';

export type { ThreadSummary };

/** The last list read, so MESSAGES and the badges draw on the first frame (docs/CACHING.md). */
const THREADS_SNAPSHOT = 'threads';

/**
 * Every conversation you are in, newest first.
 *
 * The Worker has already dropped the ones that are not conversations — a DM
 * nobody has spoken in, and anything archived that has said nothing since —
 * so this list is what a sidebar draws without further filtering.
 */
export async function fetchThreads(): Promise<ThreadSummary[]> {
  const body = await apiFetch<ThreadsResponse>('/threads', {
    fallbackError: t('Couldn’t load your messages.'),
    noStore: true,
  });
  const threads = body.threads
    .sort((left, right) => (right.last_message_at ?? 0) - (left.last_message_at ?? 0));
  saveSnapshot(THREADS_SNAPSHOT, threads);
  return threads;
}

/** Record that the member has read through this point in one conversation. */
export function markThreadRead(threadID: string, input: ThreadReadInput = {}): Promise<ThreadReadResponse> {
  return apiFetch<ThreadReadResponse>(`/threads/${encodeURIComponent(threadID)}/read`, {
    method: 'POST',
    body: input,
    fallbackError: t('Couldn’t mark this conversation read.'),
  });
}

/** Mute for a bounded period, or clear the mute with `until: null`. */
export function setThreadMuted(threadID: string, input: ThreadMuteInput): Promise<ThreadMuteResponse> {
  return apiFetch<ThreadMuteResponse>(`/threads/${encodeURIComponent(threadID)}/mute`, {
    method: 'POST',
    body: input,
    fallbackError: t('Couldn’t change that.'),
  });
}

/** Archive or restore one member's conversation list entry. */
export function setThreadArchived(threadID: string, input: ThreadArchiveInput): Promise<ThreadArchiveResponse> {
  return apiFetch<ThreadArchiveResponse>(`/threads/${encodeURIComponent(threadID)}/archive`, {
    method: 'POST',
    body: input,
    fallbackError: t('Couldn’t change that.'),
  });
}

export { threadLastSenderName, threadTitle, threadHref } from './conversation-model';

/**
 * Poll the unread list, sharing one timer and one request with every other
 * thing on the page watching the same list — the home card and the Team page
 * header both mount this, and neither should cost its own round trip.
 *
 * Cadence and hidden-tab behaviour live in `shared-poll`: full stop while the
 * tab is hidden, a slower background beat while Meet is behind another app,
 * and a deliberately slower unread cadence than the presence roster.
 *
 * A failed read leaves the last answer alone: an unread signal that blinks off
 * because one request timed out is worse than one that is a poll late.
 */
export function useThreads(enabled: boolean): ThreadSummary[] {
  const [threads, setThreads] = useState<ThreadSummary[]>(
    () => (enabled ? loadSnapshot<ThreadSummary[]>(THREADS_SNAPSHOT)?.value : undefined) ?? [],
  );

  useEffect(() => {
    if (!enabled) {
      setThreads([]);
      return;
    }
    return subscribePoll(THREADS_POLL_KEY, fetchThreads, {
      onValue: setThreads,
      // Already recorded by apiFetch for the Debug report. Nothing on this
      // card is worth an error banner over — it is a signal, not a screen.
    });
  }, [enabled]);

  return threads;
}

/**
 * The unread subset, derived rather than fetched. The sidebar wants every
 * conversation and the home card wants the loud ones; asking twice would be
 * two polls of the same list.
 */
export function useUnreadMessages(enabled: boolean): ThreadSummary[] {
  const threads = useThreads(enabled);
  return useMemo(() => threads.filter((thread) => thread.unread), [threads]);
}
