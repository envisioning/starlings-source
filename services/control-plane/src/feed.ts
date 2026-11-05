// The cross-subject feed — docs/TIMELINE.md Phase 3: "everything relevant to
// me, across every subject I touch," which nothing before this answered. Home
// answers *today* (dated rows only); Mine answers *what is on me* (open items
// only). This is the first surface that answers *what happened*.
//
// Interactions and quiet event lines share one newest-first read. Events
// are projected into D1 when appended; existing threads are rebuilt in
// batches of five, so a catch-up never opens every conversation at once.
// The DO remains the history authority, D1 holds event previews only.
//
// Same subject universe the board reads (`openSubjects`), same reasoning:
// every open project and lead is a small-company-sized fan-out, capped and
// reported as `partial` rather than allowed to fail the whole read.

import type { CrmInteractionRow, RecentFeedEntry, RecentFeedResponse } from '@starlings/contracts/crm';
export type { RecentFeedEntry, RecentFeedResponse } from '@starlings/contracts/crm';
import type { CrmSubject } from './contracts';
import { fetchCrmInteractions, fetchCrmInteractionsSince } from './crm';
import { openSubjects } from './board';
import { cachedRead } from './core-cache';
import { readSubjectActivity } from './subject-activity';

const FEED_SUBJECT_CONCURRENCY = 5;
const FEED_DEFAULT_LIMIT = 30;
const FEED_MAX_LIMIT = 100;

export async function fetchRecentFeed(
  env: Env,
  options: {
    limit?: number;
    /** Narrow the fan-out — INBOX's tail reads only the subjects one person follows. */
    include?: (subject: CrmSubject) => boolean;
    /**
     * Epoch ms. With a floor the feed is one Core read across every subject
     * instead of one per subject: eighty of those beside INBOX's eighty task
     * reads spent the invocation's subrequest budget (2026-09-16). Rows older
     * than the floor are never answered.
     */
    since?: number;
  } = {},
): Promise<RecentFeedResponse> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? FEED_DEFAULT_LIMIT), 1), FEED_MAX_LIMIT);
  const partial: string[] = [];
  const every = await openSubjects(env, partial);
  const subjects = options.include ? every.filter(options.include) : every;

  const activity = readSubjectActivity(env, subjects, partial, limit, options.since).catch(() => {
    partial.push(...subjects.map((subject) => subject.title));
    return [] as RecentFeedEntry[];
  });
  const finish = async (interactions: RecentFeedEntry[]): Promise<RecentFeedResponse> => {
    const merged = [...interactions, ...await activity]
      .filter((entry) => options.since === undefined || entryTimeMs(entry.interaction) >= options.since)
      .sort((a, b) => entryTimeMs(b.interaction) - entryTimeMs(a.interaction) || a.interaction.id.localeCompare(b.interaction.id));
    return { entries: merged.slice(0, limit), partial: [...new Set(partial)] };
  };
  const entries: RecentFeedEntry[] = [];
  if (options.since !== undefined) {
    // A Core without `since` (400) still answers per subject, below.
    const rows = await fetchCrmInteractionsSince(env, new Date(options.since), FEED_MAX_LIMIT).catch((error: unknown) => {
      if ((error as { status?: number }).status === 400) return null;
      partial.push(...subjects.map((subject) => subject.title));
      return [];
    });
    if (rows) {
      const bySubject = new Map(subjects.map((subject) => [`${subject.kind}:${subject.id}`, subject]));
      for (const interaction of rows) {
        const subject = interaction.project_id
          ? bySubject.get(`project:${interaction.project_id}`)
          : interaction.lead_id ? bySubject.get(`lead:${interaction.lead_id}`)
            : interaction.event_id ? bySubject.get(`event:${interaction.event_id}`) : undefined;
        if (subject) entries.push({ subject: { kind: subject.kind, id: subject.id, title: subject.title }, interaction });
      }
      // The upstream ceiling is applied before our visibility filter. If
      // too few visible rows survive, say that the unseen page may contain
      // more; never claim a quiet week based on hidden rows filling a page.
      if (rows.length >= FEED_MAX_LIMIT && entries.length < limit) partial.push(...subjects.map((subject) => subject.title));
      return finish(entries);
    }
  }
  for (let start = 0; start < subjects.length; start += FEED_SUBJECT_CONCURRENCY) {
    const batch = subjects.slice(start, start + FEED_SUBJECT_CONCURRENCY);
    const results = await Promise.all(batch.map(async (subject) => {
      // The old per-subject Core route understands projects and leads only.
      // An event with no such id would read every interaction and attribute
      // someone else's history to it. Keep its event trail and say partial.
      if (subject.kind !== 'project' && subject.kind !== 'lead') {
        partial.push(subject.title);
        return { subject, interactions: [] as CrmInteractionRow[] };
      }
      try {
        // Cached for a minute (core-cache.ts). On Core, Meet does not file
        // interactions itself; on a D1 workspace the meeting log purges the
        // subject's key when it writes (`postMeetingLog`).
        const interactions = await cachedRead(
          `interactions/${subject.kind === 'lead' ? 'lead' : 'project'}/${subject.id}`,
          () => fetchCrmInteractions(env, {
            projectId: subject.kind === 'project' ? subject.id : null,
            leadId: subject.kind === 'lead' ? subject.id : null,
          }, FEED_MAX_LIMIT),
        );
        return { subject, interactions };
      } catch (error) {
        partial.push(subject.title);
        console.warn(JSON.stringify({
          level: 'warn',
          message: 'feed.interactions.failed',
          subjectKind: subject.kind,
          subjectId: subject.id,
          subjectTitle: subject.title,
          error: error instanceof Error ? error.message : 'Unknown error',
        }));
        return { subject, interactions: [] as CrmInteractionRow[] };
      }
    }));
    for (const { subject, interactions } of results) {
      for (const interaction of interactions) {
        entries.push({
          subject: { kind: subject.kind, id: subject.id, title: subject.title },
          interaction,
        });
      }
    }
  }

  entries.sort((a, b) => entryTimeMs(b.interaction) - entryTimeMs(a.interaction));
  return finish(entries);
}

export function entryTimeMs(interaction: Pick<RecentFeedEntry['interaction'], 'occurred_at' | 'created_at'>): number {
  const raw = interaction.occurred_at || interaction.created_at || '';
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? 0 : ms;
}
