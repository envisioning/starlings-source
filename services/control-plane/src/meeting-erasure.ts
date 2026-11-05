// Erase one meeting from every copy Starlings can reach (,
// docs/DATA_REQUESTS.md). The room goes first, in one transaction, and leaves
// a deletion marker with no content; the copies outside the room follow. Each
// step is idempotent, so a failed step is finished by sending the same request
// again, and a restore inside 30 days re-applies the marker
// (RoomCoordinator.importState). Tasks and decisions are a member's own work
// records: they are counted and kept, and the receipt says so.

import { eraseMeetingRequestSchema, type EraseMeetingResponse, type OwnerSession } from './contracts';
import { recordAdminAction } from './admin-audit';
import { crmSyncEnabled } from './crm';
import { roomStub } from './do-jurisdiction';
import { docsEnabled, purgeDocsDocument } from './docs';
import { ERASURE_MARKER_MILLISECONDS } from './room-coordinator';

type Step = EraseMeetingResponse['steps'][number];

export async function eraseMeeting(env: Env, actor: OwnerSession, raw: unknown): Promise<EraseMeetingResponse> {
  const input = eraseMeetingRequestSchema.parse(raw);
  const room = await roomStub(env, input.room_slug);
  const marker = await room.eraseMeeting(input.meeting_id, input.request_id);
  const steps: Step[] = [{ store: 'room', result: 'erased' }];

  steps.push(await step('ledger', async () => {
    const results = await env.USAGE.batch([
      env.USAGE.prepare('DELETE FROM meetings_ledger WHERE meeting_id = ?1').bind(input.meeting_id),
      env.USAGE.prepare('DELETE FROM meeting_deliveries WHERE meeting_id = ?1').bind(input.meeting_id),
      env.USAGE.prepare('DELETE FROM notes_owed WHERE room_slug = ?1 AND meeting_id = ?2').bind(input.room_slug, input.meeting_id),
      env.USAGE.prepare('DELETE FROM meeting_follow_ups WHERE meeting_id = ?1').bind(input.meeting_id),
    ]);
    return results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
  }));

  // The meeting's record on its subjects (D1 workspaces; Envisioning keeps it in Core).
  steps.push(await step('subject_records', async () => {
    const [links, rows] = await env.USAGE.batch([
      env.USAGE.prepare(`DELETE FROM interaction_subjects WHERE interaction_id IN
        (SELECT id FROM interactions WHERE source = 'meet' AND external_id = ?1)`).bind(input.meeting_id),
      env.USAGE.prepare(`DELETE FROM interactions WHERE source = 'meet' AND external_id = ?1`).bind(input.meeting_id),
    ]);
    return (links!.meta.changes ?? 0) + (rows!.meta.changes ?? 0);
  }));

  if (!marker.transcript_document_id || !marker.document_owner_email) {
    steps.push({ store: 'docs', result: 'none' });
  } else if (!docsEnabled(env)) {
    steps.push({ store: 'docs', result: 'failed' });
  } else {
    const ownerEmail = marker.document_owner_email;
    const documentId = marker.transcript_document_id;
    steps.push(await step('docs', async () => {
      await purgeDocsDocument(env, ownerEmail, documentId);
      await room.completeErasure(input.meeting_id);
      return 1;
    }));
  }

  steps.push({ store: 'core', result: crmSyncEnabled(env) ? 'not_reachable' : 'none' });

  const [tasks, decisions] = await env.USAGE.batch<{ n: number }>([
    env.USAGE.prepare('SELECT COUNT(*) AS n FROM tasks WHERE meeting_id = ?1').bind(input.meeting_id),
    env.USAGE.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE source = 'meeting' AND source_ref = ?1`).bind(input.meeting_id),
  ]);
  for (const [store, result] of [['tasks', tasks], ['decisions', decisions]] as const) {
    const count = result?.results[0]?.n ?? 0;
    steps.push(count > 0 ? { store, result: 'kept', count } : { store, result: 'none' });
  }
  steps.push({ store: 'backups', result: 'kept' });

  const failed = steps.filter((item) => item.result === 'failed').map((item) => item.store);
  await recordAdminAction(env, actor, 'meeting.erase', `${input.room_slug}/${input.meeting_id}`,
    `${input.request_id}${failed.length > 0 ? `; failed: ${failed.join(', ')}` : ''}`);
  return {
    request_id: marker.request_id,
    room_slug: input.room_slug,
    meeting_id: input.meeting_id,
    erased_at: marker.erased_at,
    backups_end_at: marker.erased_at + ERASURE_MARKER_MILLISECONDS,
    steps,
  };
}

/** One copy outside the room. A failure is reported, never thrown: the receipt names it and a retry finishes it. */
async function step(store: Step['store'], run: () => Promise<number>): Promise<Step> {
  try {
    const count = await run();
    return { store, result: count > 0 ? 'erased' : 'none' };
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', message: 'meeting.erase.step_failed', store, error: error instanceof Error ? error.message : 'Unknown error' }));
    return { store, result: 'failed' };
  }
}
