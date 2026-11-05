// The delivery ledger (meet#187): what Docs and Core are owed, written
// before anything is sent, retried per destination, confirmed by revision.
import { coreTask } from './core-rows';
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AmbientMeetingResponse, McpMeetingArtifactResponse, MeetingDelivery, TranscriptViewResponse } from '@starlings/contracts';
import { deliverMeeting, listDueDeliveries, requestDelivery, sweepDeliveries } from '../src/deliveries';
import { resetDocsTokenCache } from '../src/docs';
import { recordUsageEvent } from '../src/ledger';
import { queueFallbackRegeneration } from '../src/artifacts';

const CORE_SECRET = 'core-test-secret-with-at-least-32-characters';

async function owner() {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
  }));
  const session = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' };
}

/**
 * Core and Docs as scripts. `docs.up` / `core.up` flip each destination;
 * `docs.filed` counts documents created, `docs.patched` the updates, and
 * `docs.archived` the ones retired. Core keeps the last payload it took.
 */
function withDestinations() {
  const configured = { core: (env as Env).INTERNAL_REQUEST_SECRET, docs: (env as Env).DOCS_INTERNAL_SECRET };
  (env as Env).INTERNAL_REQUEST_SECRET = CORE_SECRET;
  (env as Env).DOCS_INTERNAL_SECRET = 'docs-test-secret-with-at-least-32-characters';
  resetDocsTokenCache();
  const state = {
    docs: { up: true, filed: 0, patched: 0, archived: 0, lastBody: '', slugs: [] as string[], taken: new Set<string>(), lastCreatedAt: null as string | null },
    core: { up: true, refuses: false, posts: 0, last: null as null | { transcript: unknown[]; transcript_url: string | null; title: string | null }, tasks: [] as Array<Record<string, unknown>>, decided: [] as Array<[string, string]> },
    restore: () => {
      (env as Env).INTERNAL_REQUEST_SECRET = configured.core ?? '';
      (env as Env).DOCS_INTERNAL_SECRET = configured.docs ?? '';
    },
  };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
    const body = init?.body ? String(init.body) : input instanceof Request ? await input.text() : '';
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/api/public/meet-meeting-logs') {
      if (!state.core.up) return new Response('down', { status: 503 });
      state.core.posts += 1;
      state.core.last = JSON.parse(body);
      return json({ ok: true });
    }
    if (url.pathname.endsWith('meet-crm-tasks') && method === 'POST') {
      if (!state.core.up) return new Response('down', { status: 503 });
      if (state.core.refuses) return json({ ok: false, error: 'Provide exactly one of project_id, lead_id, event_id, signals_account_id or organization_id' }, 400);
      const task = JSON.parse(body) as Record<string, unknown>;
      state.core.tasks.push(task);
      return json({ ok: true, task: coreTask({ id: `task-${state.core.tasks.length}`, title: task.title, status: task.status, project_id: task.project_id ?? null, lead_id: task.lead_id ?? null, due_date: task.due_date ?? null, updated_at: new Date().toISOString() }) });
    }
    const taskWrite = url.pathname.match(/meet-crm-tasks\/([^/]+)$/u);
    if (taskWrite && method === 'PATCH') {
      const patch = JSON.parse(body) as { status?: string };
      state.core.decided.push([taskWrite[1]!, patch.status ?? '']);
      return json({ ok: true, task: coreTask({ id: taskWrite[1]!, title: 'T', status: patch.status ?? 'pending', project_id: null, lead_id: null, due_date: null, updated_at: new Date().toISOString() }) });
    }
    if (url.pathname === '/api/tokens/meet-exchange') return json({ token: 'evd_test', scopes: [], expires_at: new Date(Date.now() + 3_600_000).toISOString(), email: 'rosa@example.com' });
    if (url.pathname === '/api/docs' && method === 'POST') {
      if (!state.docs.up) return new Response('down', { status: 503 });
      const sent = JSON.parse(body) as { body_md: string; slug?: string; created_at?: string };
      if (sent.slug) state.docs.slugs.push(sent.slug);
      state.docs.lastCreatedAt = sent.created_at ?? null;
      // A path already held by another meeting of the same name.
      if (sent.slug && state.docs.taken.has(sent.slug)) {
        return json({ error: 'A document already exists there.', code: 'conflict' }, 409);
      }
      state.docs.filed += 1;
      state.docs.lastBody = sent.body_md;
      return json({ id: `doc-${state.docs.filed}`, path: `/work/transcripts/doc-${state.docs.filed}`, title: 'T', subjects: [], updated_at: new Date().toISOString() }, 201);
    }
    const one = url.pathname.match(/^\/api\/docs\/([^/]+)$/u);
    if (one && method === 'PATCH') {
      if (!state.docs.up) return new Response('down', { status: 503 });
      const patch = JSON.parse(body) as { status?: string; body_md?: string };
      if (patch.status === 'archived') state.docs.archived += 1;
      else { state.docs.patched += 1; state.docs.lastBody = patch.body_md ?? ''; }
      return json({ id: one[1], path: `/work/transcripts/${one[1]}`, title: 'T', subjects: [], updated_at: new Date().toISOString() });
    }
    if (url.pathname.match(/^\/api\/docs\/[^/]+\/subjects$/u)) return json({ ok: true });
    if (url.pathname.endsWith('meet-crm-subjects')) return json({ ok: true, subjects: [], has_more: false });
    return new Response('{}', { status: 404 });
  });
  return state;
}

// Segment ids are global in the room: each meeting gets its own from its id.
const line = (meeting: string, n: number, text: string) => ({
  id: `${meeting.slice(0, 34)}${String(n).padStart(2, '0')}`, meeting_id: meeting, speaker_id: 'ambient:ana', speaker_name: 'Ana',
  language: 'en', starts_at_ms: n * 1000, ends_at_ms: n * 1000 + 900, text, is_final: true,
});

/** An ambient meeting with two lines, filed under a project so Core is owed. */
async function meeting(headers: Record<string, string>, { file = true, attendeeEmail = 'ana@acme.example' }: { file?: boolean; attendeeEmail?: string | null } = {}) {
  const created = await exports.default.fetch(new Request('http://local/api/rooms/rosa/meetings/ambient', {
    method: 'POST', headers,
    body: JSON.stringify({ started_at: '2026-09-16T09:00:00.000Z', ended_at: '2026-09-16T09:30:00.000Z', title: 'Delivery test', attendees: [{ name: 'Ana Silva', ...(attendeeEmail ? { email: attendeeEmail } : {}) }] }),
  }));
  const { meeting_id } = await created.json<AmbientMeetingResponse>();
  const appended = await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${meeting_id}/transcript`, {
    method: 'POST', headers, body: JSON.stringify({ segments: [line(meeting_id, 1, 'first'), line(meeting_id, 2, 'second')] }),
  }));
  expect(await appended.json()).toEqual({ accepted: 2 });
  // Filed on the room directly: the route would also ask for delivery in
  // the background, and these tests drive delivery by hand.
  if (file) {
    await env.ROOMS.getByName('rosa').setMeetingCategory(`dev:rosa@example.com`, meeting_id, {
      meetingKind: 'project', leadId: null, projectId: 'c0ffee00-0000-4000-8000-0000000000e1', partnerOrganizationId: null, subjectTitle: 'Acme', categorizedBy: 'rosa@example.com',
    });
  }
  return meeting_id;
}

/** The route asked for delivery in the background; wait for its row to be due and unleased. */
async function settled(meetingId: string, destination: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = await rows(meetingId);
    const row = current[destination];
    if (row && row.status !== 'delivered' && !row.leased_until) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no ${destination} row for ${meetingId}`);
}

async function rows(meetingId: string): Promise<Record<string, MeetingDelivery & { leased_until: number | null }>> {
  const { results } = await env.USAGE.prepare('SELECT * FROM meeting_deliveries WHERE meeting_id = ?1').bind(meetingId).all<MeetingDelivery & { requested_revision: number; delivered_revision: number; leased_until: number | null }>();
  return Object.fromEntries(results.map((row) => [row.destination, { ...row, status: row.delivered_revision >= row.requested_revision ? 'delivered' : row.last_error ? 'failed' : 'pending' }]));
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await env.USAGE.prepare('DELETE FROM meeting_deliveries').run();
  await env.USAGE.prepare("DELETE FROM usage_events WHERE kind = 'meeting_end' AND meeting_id LIKE 'once-%'").run();
});

describe('the ledger', () => {
  it('writes the rows before dispatch, and a queue that refuses still delivers inline', async () => {
    const dest = withDestinations();
    try {
      const headers = await owner();
      const id = await meeting(headers);
      const send = vi.spyOn(env.ARTIFACT_JOBS, 'send').mockRejectedValue(new Error('queue down'));
      const owed = await requestDelivery(env, 'rosa', id);
      expect(owed).toEqual(['docs', 'core']);
      expect(send).toHaveBeenCalledWith({ roomSlug: 'rosa', meetingId: id, kind: 'deliver' });
      const after = await rows(id);
      expect(after.docs?.status).toBe('delivered');
      expect(after.core?.status).toBe('delivered');
      expect(dest.docs.filed).toBe(1);
      expect(dest.core.last?.transcript_url).toContain('/work/transcripts/doc-1');
    } finally {
      dest.restore();
    }
  });

  it('dates the transcript by the meeting and files around a taken path', async () => {
    const dest = withDestinations();
    try {
      const headers = await owner();
      // Another meeting of the same name already holds the day's path.
      dest.docs.taken.add('delivery-test-transcript-2026-09-16');
      const id = await meeting(headers);
      await requestDelivery(env, 'rosa', id, { inline: true });

      expect(dest.docs.filed).toBe(1);
      expect(dest.docs.slugs[0]).toBe('delivery-test-transcript-2026-09-16');
      expect(dest.docs.slugs[1]).toBe('delivery-test-transcript-2026-09-16-0900');
      // The document belongs to the day of the meeting, not to the delivery.
      expect(dest.docs.lastCreatedAt).toBe('2026-09-16T09:00:00.000Z');
    } finally {
      dest.restore();
    }
  });

  it('keeps a partial success as such: Docs down, Core up, then Docs back and Core told the link', async () => {
    const dest = withDestinations();
    try {
      const headers = await owner();
      const id = await meeting(headers);
      dest.docs.up = false;
      await expect(requestDelivery(env, 'rosa', id, { inline: true })).rejects.toThrow(/owed to docs/u);
      let after = await rows(id);
      expect(after.docs?.status).toBe('failed');
      expect(after.docs?.last_error).toMatch(/Docs/u);
      expect(after.core?.status).toBe('delivered');
      expect(dest.core.last?.transcript_url).toBeNull();

      dest.docs.up = true;
      await deliverMeeting(env, 'rosa', id);
      after = await rows(id);
      expect(after.docs?.status).toBe('delivered');
      expect(after.core?.status).toBe('delivered');
      // Core was told again, now with the document.
      expect(dest.core.posts).toBe(2);
      expect(dest.core.last?.transcript_url).toContain('doc-1');
      expect(dest.docs.filed).toBe(1);
    } finally {
      dest.restore();
    }
  });

  it('after a lost acknowledgment the retry updates the same document, never a second one', async () => {
    const dest = withDestinations();
    try {
      const headers = await owner();
      const id = await meeting(headers);
      await requestDelivery(env, 'rosa', id, { inline: true });
      // The ack was lost: the row says nothing was delivered.
      await env.USAGE.prepare('UPDATE meeting_deliveries SET delivered_revision = 0 WHERE meeting_id = ?1').bind(id).run();
      await deliverMeeting(env, 'rosa', id);
      expect(dest.docs.filed).toBe(1);
      expect(dest.docs.patched).toBe(1);
      expect((await rows(id)).docs?.status).toBe('delivered');
    } finally {
      dest.restore();
    }
  });

  it('a correction that lands during a delivery keeps the row due, and the next attempt carries it', async () => {
    const dest = withDestinations();
    try {
      const headers = await owner();
      const id = await meeting(headers);
      await requestDelivery(env, 'rosa', id, { inline: true });
      // The next delivery is in flight when a rename lands: Docs takes the
      // old text first. Modelled by renaming inside Docs' own answer.
      const original = globalThis.fetch;
      let renamedDuring = false;
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
        if (!renamedDuring && /^\/api\/docs\/[^/]+$/u.test(url.pathname) && method === 'PATCH') {
          renamedDuring = true;
          await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${id}/transcript`, {
            method: 'PATCH', headers, body: JSON.stringify({ speaker_id: 'ambient:ana', speaker_name: 'Ana Silva' }),
          }));
        }
        return original(input, init);
      });
      await env.USAGE.prepare('UPDATE meeting_deliveries SET requested_revision = requested_revision + 1 WHERE meeting_id = ?1 AND destination = ?2').bind(id, 'docs').run();
      await deliverMeeting(env, 'rosa', id);
      expect(renamedDuring).toBe(true);
      // Still due: what went out predates the rename.
      expect((await rows(id)).docs?.status).toBe('pending');
      expect(dest.docs.lastBody).not.toContain('**Ana Silva**');
      await deliverMeeting(env, 'rosa', id);
      expect((await rows(id)).docs?.status).toBe('delivered');
      expect(dest.docs.lastBody).toContain('**Ana Silva**');
    } finally {
      dest.restore();
    }
  });

  it('deleting every line retires the document and tells Core the link is gone', async () => {
    const dest = withDestinations();
    try {
      const headers = await owner();
      const id = await meeting(headers);
      await requestDelivery(env, 'rosa', id, { inline: true });
      const struck = await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${id}/transcript`, {
        method: 'DELETE', headers, body: JSON.stringify({ segment_ids: [line(id, 1, '').id, line(id, 2, '').id] }),
      }));
      expect(await struck.json()).toEqual({ removed: 2 });
      // The route asked through the queue; drain by hand.
      await settled(id, 'docs');
      await deliverMeeting(env, 'rosa', id);
      expect(dest.docs.archived).toBe(1);
      expect(dest.core.last?.transcript_url).toBeNull();
      expect(dest.core.last?.transcript).toEqual([]);
      const view = await (await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${id}/transcript`, { headers: { authorization: headers.authorization } }))).json<TranscriptViewResponse>();
      expect(view.deliveries.map((row) => [row.destination, row.status])).toEqual([['core', 'delivered'], ['docs', 'delivered']]);
      expect(view.artifact.transcript).toEqual([]);
    } finally {
      dest.restore();
    }
  });

  it('an unfiled ambient meeting gets its Docs transcript and owes Core nothing until filed', async () => {
    const dest = withDestinations();
    try {
      const headers = await owner();
      const id = await meeting(headers, { file: false });
      expect(await requestDelivery(env, 'rosa', id, { inline: true })).toEqual(['docs']);
      expect(dest.docs.filed).toBe(1);
      expect(dest.core.posts).toBe(0);
      await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${id}/category`, {
        method: 'PUT', headers,
        body: JSON.stringify({ meeting_kind: 'project', project_id: 'c0ffee00-0000-4000-8000-0000000000e1', subject_title: 'Acme' }),
      }));
      await settled(id, 'core');
      await deliverMeeting(env, 'rosa', id);
      expect(dest.core.posts).toBe(1);
      expect(dest.core.last?.transcript_url).toContain('doc-1');
    } finally {
      dest.restore();
    }
  });

  it('finds the meetings the fallback model wrote, and queues them to be written again (meet#319)', async () => {
    const dest = withDestinations();
    try {
      const headers = await owner();
      const id = await meeting(headers);
      const room = env.ROOMS.getByName('rosa');
      await room.setSummary(id, 'Fallback test', '## Summary\n\nSmall model.', [], [], '@cf/meta/llama-3.1-8b-instruct');
      expect(await room.meetingsWrittenByFallback(0)).toContain(id);
      const sent = vi.spyOn(env.ARTIFACT_JOBS, 'sendBatch').mockResolvedValue(undefined as never);
      const report = await queueFallbackRegeneration(env, 0);
      expect(report.queued).toBeGreaterThanOrEqual(1);
      expect(sent.mock.calls.flatMap(([batch]) => [...batch].map((message) => message.body))).toContainEqual({ kind: 'regenerate', roomSlug: 'rosa', meetingId: id });
      await room.setSummary(id, 'Fallback test', '## Summary\n\nClaude.', [], [], 'claude-opus-5');
      expect(await room.meetingsWrittenByFallback(0)).not.toContain(id);
    } finally {
      dest.restore();
    }
  });

  it('the view says whether the notes predate the transcript', async () => {
    const dest = withDestinations();
    try {
      const headers = await owner();
      const id = await meeting(headers);
      const room = env.ROOMS.getByName('rosa');
      await room.setSummary(id, 'Delivery test', '## Summary\n\nTwo lines.');
      let view = await (await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${id}/transcript`, { headers: { authorization: headers.authorization } }))).json<TranscriptViewResponse>();
      expect(view.notes_stale).toBe(false);
      await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${id}/transcript`, {
        method: 'DELETE', headers, body: JSON.stringify({ segment_ids: [line(id, 2, '').id] }),
      }));
      view = await (await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${id}/transcript`, { headers: { authorization: headers.authorization } }))).json<TranscriptViewResponse>();
      expect(view.notes_stale).toBe(true);
    } finally {
      dest.restore();
    }
  });

  it('the sweep sends quiet rows again and the operator list shows them', async () => {
    const dest = withDestinations();
    try {
      const headers = await owner();
      const id = await meeting(headers);
      dest.core.up = false;
      dest.docs.up = false;
      await expect(requestDelivery(env, 'rosa', id, { inline: true })).rejects.toThrow();
      const due = await listDueDeliveries(env);
      expect(due.filter((row) => row.meeting_id === id).map((row) => row.status)).toEqual(['failed', 'failed']);
      const sendBatch = vi.spyOn(env.ARTIFACT_JOBS, 'sendBatch').mockResolvedValue(undefined as never);
      // Too fresh to sweep.
      expect((await sweepDeliveries(env)).requeued).toBe(0);
      // One failed attempt doubles the wait: ten minutes is not enough.
      expect((await sweepDeliveries(env, Date.now() + 11 * 60_000)).requeued).toBe(0);
      // Old enough.
      const swept = await sweepDeliveries(env, Date.now() + 21 * 60_000);
      expect(swept.requeued).toBe(1);
      expect(swept.oldestMs).toBeGreaterThan(20 * 60_000);
      expect(sendBatch).toHaveBeenCalledWith([{ body: { roomSlug: 'rosa', meetingId: id, kind: 'deliver' } }]);
      // Touched: the next sweep leaves them to the queue.
      expect((await sweepDeliveries(env, Date.now() + 21 * 60_000)).requeued).toBe(0);
    } finally {
      dest.restore();
    }
  });

  it('files the notes’ action items as proposed tasks once, with the quote and the meeting link (meet#143)', async () => {
    const dest = withDestinations();
    try {
      const headers = await owner();
      const id = await meeting(headers);
      const room = env.ROOMS.getByName('rosa');
      await room.setSummary(id, 'Delivery test', '## Action items\n- **Ana** — send the deck, by Friday\n- **Owner** — book the venue', [
        { what: 'Send the deck', who: 'Ana', by_when: 'Friday', quote: 'I will send the deck on Friday', at_ms: 1_000, task_id: null },
        { what: 'Book the venue', who: 'Rosa', by_when: null, quote: null, at_ms: null, task_id: null },
      ]);
      expect(await requestDelivery(env, 'rosa', id, { inline: true })).toEqual(['docs', 'core', 'proposals']);
      expect(dest.core.tasks.map((task) => [task.title, task.status, task.responsible_party, task.project_id])).toEqual([
        ['Send the deck', 'proposed', 'client', 'c0ffee00-0000-4000-8000-0000000000e1'],
        ['Book the venue', 'proposed', 'team', 'c0ffee00-0000-4000-8000-0000000000e1'],
      ]);
      expect(String(dest.core.tasks[0]!.notes)).toContain('Owner as said: Ana');
      expect(String(dest.core.tasks[0]!.notes)).toContain('“I will send the deck on Friday” at 0:01');
      expect(String(dest.core.tasks[0]!.notes)).toContain(`/meetings/rosa/${id}`);
      expect((await rows(id)).proposals?.status).toBe('delivered');

      // Filed ids are on the room; a second delivery, and rewritten notes
      // that still carry the item, propose nothing again.
      let view = await (await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${id}/transcript`, { headers: { authorization: headers.authorization } }))).json<TranscriptViewResponse>();
      expect(view.action_items.map((item) => item.task_id)).toEqual(['task-1', 'task-2']);
      await room.setSummary(id, 'Delivery test', '## Action items\n- send the deck\n- **Ana** — call the venue', [
        { what: 'Send the deck.', who: null, by_when: null, quote: null, at_ms: null, task_id: null },
        { what: 'Call the venue', who: 'Ana', by_when: null, quote: null, at_ms: null, task_id: null },
      ]);
      await requestDelivery(env, 'rosa', id, { inline: true });
      expect(dest.core.tasks.map((task) => task.title)).toEqual(['Send the deck', 'Book the venue', 'Call the venue']);
      view = await (await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${id}/transcript`, { headers: { authorization: headers.authorization } }))).json<TranscriptViewResponse>();
      expect(view.action_items.map((item) => item.task_id)).toEqual(['task-1', 'task-3']);
    } finally {
      dest.restore();
    }
  });

  it('a proposal Core refuses stays owed but does not fail the job, so the queue does not retry it', async () => {
    const dest = withDestinations();
    try {
      const headers = await owner();
      const id = await meeting(headers);
      await env.ROOMS.getByName('rosa').setSummary(id, 'Refused', '## Action items\n- send the deck', [
        { what: 'Send the deck', who: null, by_when: null, quote: null, at_ms: null, task_id: null },
      ]);
      dest.core.refuses = true;
      await expect(requestDelivery(env, 'rosa', id, { inline: true })).resolves.toContain('proposals');
      const proposals = (await rows(id)).proposals;
      expect(proposals?.status).toBe('failed');
      expect(proposals?.last_error).toContain('(400)');
      // Core taking it again files it on the next delivery.
      dest.core.refuses = false;
      await requestDelivery(env, 'rosa', id, { inline: true });
      expect((await rows(id)).proposals?.status).toBe('delivered');
    } finally {
      dest.restore();
    }
  });

  it('drafts a follow-up for a filed call with outside people; the host approves one revision, and only this call\'s tasks (meet#756)', async () => {
    const dest = withDestinations();
    try {
      const headers = await owner();
      const id = await meeting(headers);
      const room = env.ROOMS.getByName('rosa');
      const items = [
        { what: 'Send the deck', who: 'Ana', by_when: 'Friday', quote: null, at_ms: null, task_id: null },
        { what: 'Book the venue', who: 'Rosa', by_when: null, quote: null, at_ms: null, task_id: null },
      ];
      await room.setSummary(id, 'Delivery test', '## Action items\n- a\n- b', items, [], 'claude-sonnet-5', { subject: 'Next steps', body: 'Hi Ana, thanks for the call. You send the deck by Friday.' });
      expect(await requestDelivery(env, 'rosa', id, { inline: true })).toEqual(['docs', 'core', 'proposals', 'followup']);
      const pointer = await env.USAGE.prepare('SELECT host_email, subject_kind, state FROM meeting_follow_ups WHERE meeting_id = ?1').bind(id).first();
      expect(pointer).toEqual({ host_email: 'rosa@example.com', subject_kind: 'project', state: 'open' });

      const inbox = async () => (await (await exports.default.fetch(new Request('http://local/api/crm/inbox?followups=true', { headers: { authorization: headers.authorization } }))).json<{ items: Array<Record<string, unknown>> }>())
        .items.filter((item) => item.source === 'followup');
      const [row] = await inbox();
      expect(row).toMatchObject({
        key: `followup:${id}`,
        recipients: [{ name: 'Ana Silva', email: 'ana@acme.example' }],
        draft: { subject: 'Next steps' },
        revision: 1,
        tasks: [{ id: 'task-1', title: 'Send the deck' }, { id: 'task-2', title: 'Book the venue' }],
      });

      // The notes are rewritten: a new draft, and the old approval no longer fits.
      await room.setSummary(id, 'Delivery test', '## Action items\n- a\n- b', items, [], 'claude-sonnet-5', { subject: 'Next steps', body: 'Hi Ana, thanks. The deck comes Friday.' });
      const approve = (body: Record<string, unknown>) => exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${id}/follow-up`, {
        method: 'POST', headers, body: JSON.stringify({ subject: 'Next steps', body: 'Hi Ana, thanks. The deck comes Friday.', ...body }),
      }));
      expect((await approve({ revision: 1, accept_task_ids: ['task-1'], decline_task_ids: ['task-2'] })).status).toBe(409);
      // A task from anywhere else is refused before anything moves.
      expect((await approve({ revision: 2, accept_task_ids: ['task-elsewhere'], decline_task_ids: [] })).status).toBe(400);
      expect(dest.core.decided).toEqual([]);

      const approved = await approve({ revision: 2, accept_task_ids: ['task-1'], decline_task_ids: ['task-2'] });
      expect(approved.status).toBe(200);
      expect(await approved.json()).toEqual({
        ok: true,
        mail: { to: ['ana@acme.example'], subject: 'Next steps', body: 'Hi Ana, thanks. The deck comes Friday.' },
        failed_task_ids: [],
      });
      expect(dest.core.decided).toEqual([['task-1', 'pending'], ['task-2', 'declined']]);
      expect(await inbox()).toEqual([]);
      // Approved is the host's answer: rewritten notes leave it alone, and nothing is owed again.
      await room.setSummary(id, 'Delivery test', '## Action items\n- a', items, [], 'claude-sonnet-5', { subject: 'Other', body: 'Other.' });
      expect(await requestDelivery(env, 'rosa', id, { inline: true })).not.toContain('followup');
    } finally {
      dest.restore();
      await env.USAGE.prepare('DELETE FROM meeting_follow_ups').run();
    }
  });

  it('drafts no follow-up row for a call nobody filed, and a dismissed one leaves INBOX (meet#756)', async () => {
    const dest = withDestinations();
    try {
      const headers = await owner();
      const unfiled = await meeting(headers, { file: false });
      const room = env.ROOMS.getByName('rosa');
      await room.setSummary(unfiled, 'Delivery test', 'x', [], [], 'claude-sonnet-5', { subject: 'S', body: 'B' });
      expect(await requestDelivery(env, 'rosa', unfiled, { inline: true })).not.toContain('followup');

      const filed = await meeting(headers);
      await room.setSummary(filed, 'Delivery test', 'x', [], [], 'claude-sonnet-5', { subject: 'S', body: 'B' });
      await requestDelivery(env, 'rosa', filed, { inline: true });
      const dismissed = await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${filed}/follow-up`, { method: 'DELETE', headers }));
      expect(dismissed.status).toBe(200);
      const state = await env.USAGE.prepare('SELECT state FROM meeting_follow_ups WHERE meeting_id = ?1').bind(filed).first<{ state: string }>();
      expect(state?.state).toBe('dismissed');
    } finally {
      dest.restore();
      await env.USAGE.prepare('DELETE FROM meeting_follow_ups').run();
    }
  });

  it('serves a structured finalized artifact with doors only for filed items', async () => {
    const dest = withDestinations();
    try {
      const headers = await owner();
      const id = await meeting(headers, { attendeeEmail: null });
      const room = env.ROOMS.getByName('rosa');
      await room.setSummary(id, 'Artifact test', [
        '## Summary', 'A useful meeting.', '',
        '## Decisions', '- Use the new plan.', '',
        '## Open questions', '- Who owns launch?', '- When does it ship?',
      ].join('\n'), [
        { what: 'Send the plan', who: 'Ana', by_when: null, quote: null, at_ms: null, task_id: 'task-filed' },
        { what: 'Book the review', who: null, by_when: null, quote: null, at_ms: null, task_id: null },
      ], [
        { what: 'Use the new plan.', quote: null, at_ms: null, decision_id: 'decision-1', dismissed: false },
      ]);

      const structuredResponse = await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${id}/transcript?structured=true`, {
        headers: { authorization: headers.authorization },
      }));
      expect(structuredResponse.status).toBe(200);
      const artifact = await structuredResponse.json<McpMeetingArtifactResponse>();
      expect(artifact).toMatchObject({
        summary: expect.stringContaining('A useful meeting.'),
        action_items: [
          { text: 'Send the plan', owner_hint: 'Ana', task_id: 'task-filed', door: 'task:task-filed' },
          { text: 'Book the review', owner_hint: null },
        ],
        decisions: [{ text: 'Use the new plan.', decision_id: 'decision-1', door: 'subject:project:c0ffee00-0000-4000-8000-0000000000e1' }],
        open_questions: ['Who owns launch?', 'When does it ship?'],
        attendees: expect.arrayContaining([{ name: 'Ana Silva', kind: 'guest' }]),
        subject: { door: 'subject:project:c0ffee00-0000-4000-8000-0000000000e1' },
        started_at: Date.parse('2026-09-16T09:00:00.000Z'),
        ended_at: Date.parse('2026-09-16T09:30:00.000Z'),
        transcript: { segments: expect.arrayContaining([expect.objectContaining({ text: 'first' }), expect.objectContaining({ text: 'second' })]) },
      });
      expect(artifact.attendees.find((person) => person.name === 'Ana Silva')).not.toHaveProperty('email');
      expect(artifact.action_items[1]).not.toHaveProperty('door');

      // Existing clients keep the full transcript view unless they opt in.
      const legacy = await (await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${id}/transcript`, {
        headers: { authorization: headers.authorization },
      }))).json<TranscriptViewResponse>();
      expect(legacy).toHaveProperty('artifact');
      expect(legacy).toHaveProperty('deliveries');
      // The page's own view names who attended, by name only (meet#692):
      // strings, never the structured projection's people or an address.
      expect(legacy.attendees).toEqual(expect.arrayContaining(['Ana Silva']));
      expect(legacy.attendees?.every((name) => typeof name === 'string' && !name.includes('@'))).toBe(true);
    } finally {
      dest.restore();
    }
  });

  it('a lost answer from Core proposes the rest, never the one that landed', async () => {
    const dest = withDestinations();
    try {
      const headers = await owner();
      const id = await meeting(headers);
      const room = env.ROOMS.getByName('rosa');
      await room.setSummary(id, 'Delivery test', '## Action items\n- a\n- b', [
        { what: 'First', who: null, by_when: null, quote: null, at_ms: null, task_id: null },
        { what: 'Second', who: null, by_when: null, quote: null, at_ms: null, task_id: null },
      ]);
      // Core takes the first and dies on the second.
      const original = globalThis.fetch;
      let creates = 0;
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
        if (url.pathname.endsWith('meet-crm-tasks') && method === 'POST') {
          creates += 1;
          if (creates === 2) return new Response('down', { status: 503 });
        }
        return original(input, init);
      });
      await expect(requestDelivery(env, 'rosa', id, { inline: true })).rejects.toThrow(/proposals/u);
      expect((await rows(id)).proposals?.status).toBe('failed');
      await deliverMeeting(env, 'rosa', id);
      expect(dest.core.tasks.map((task) => task.title)).toEqual(['First', 'Second']);
      expect((await rows(id)).proposals?.status).toBe('delivered');
    } finally {
      dest.restore();
    }
  });

  it('a status meeting files its proposals on the meeting itself (meet#248); an unfiled capture files none', async () => {
    const dest = withDestinations();
    try {
      const headers = await owner();
      const id = await meeting(headers, { file: false });
      const room = env.ROOMS.getByName('rosa');
      await room.setSummary(id, 'Delivery test', '## Action items\n- a', [{ what: 'Something', who: null, by_when: null, quote: null, at_ms: null, task_id: null }]);
      // Uncategorized: nobody's yet.
      expect(await requestDelivery(env, 'rosa', id, { inline: true })).toEqual(['docs']);
      expect(dest.core.tasks).toEqual([]);
      await room.setMeetingCategory('dev:rosa@example.com', id, { meetingKind: 'status', leadId: null, projectId: null, partnerOrganizationId: null, subjectTitle: null, categorizedBy: 'rosa@example.com' });
      expect(await requestDelivery(env, 'rosa', id, { inline: true })).toEqual(['docs', 'core', 'proposals']);
      expect(dest.core.tasks.map((task) => [task.title, task.meeting_id, task.project_id ?? null])).toEqual([['Something', id, null]]);
    } finally {
      dest.restore();
    }
  });

  it('a meeting filed on a partner keeps the organization, refuses event, and files proposals on it', async () => {
    const dest = withDestinations();
    try {
      const headers = await owner();
      const id = await meeting(headers, { file: false });
      const room = env.ROOMS.getByName('rosa');
      await room.setSummary(id, 'Partner test', '## Action items\n- a', [{ what: 'Follow up', who: null, by_when: null, quote: null, at_ms: null, task_id: null }]);
      const org = 'c0ffee00-0000-4000-8000-0000000000f1';
      const put = (body: unknown) => exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${id}/category`, { method: 'PUT', headers, body: JSON.stringify(body) }));
      expect((await put({ meeting_kind: 'event', event_id: 'c0ffee00-0000-4000-8000-0000000000f2' })).status).toBe(400);
      const filed = await put({ meeting_kind: 'partner', partner_organization_id: org, subject_title: 'Acme Corp' });
      expect(filed.status).toBe(200);
      expect(await filed.json()).toMatchObject({ meeting_kind: 'partner', partner_organization_id: org, lead_id: null, project_id: null });
      const read = await exports.default.fetch(new Request(`http://local/api/rooms/rosa/meetings/${id}/category`, { headers: { authorization: headers.authorization } }));
      expect(await read.json()).toMatchObject({ meeting_kind: 'partner', partner_organization_id: org });
      expect((await room.meetingLogMaterial(id)).partnerOrganizationId).toBe(org);
      await settled(id, 'core');
      await deliverMeeting(env, 'rosa', id);
      expect(dest.core.tasks.map((task) => [task.title, task.organization_id])).toEqual([['Follow up', org]]);
    } finally {
      dest.restore();
    }
  });

  it('counts a meeting end once however often the job runs', async () => {
    await recordUsageEvent(env as Env, { kind: 'meeting_end', room_slug: 'rosa', meeting_id: 'once-1', actor_kind: 'system' });
    await recordUsageEvent(env as Env, { kind: 'meeting_end', room_slug: 'rosa', meeting_id: 'once-1', actor_kind: 'system' });
    const { results } = await env.USAGE.prepare("SELECT COUNT(*) AS n FROM usage_events WHERE kind = 'meeting_end' AND meeting_id = 'once-1'").all<{ n: number }>();
    expect(results[0]?.n).toBe(1);
  });
});
