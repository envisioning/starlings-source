import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorsResponse, CrmContactResponse, CrmInteractionsResponse, CrmSubjectMutationResponse, OrphanChannelsResponse, ThreadSummary } from '@starlings/contracts';
import type { CrmTask } from '@starlings/contracts/crm';
import worker from '../src/index';
import { fetchCrmCalendarContacts, postMeetingLog, type MeetingLogPayload } from '../src/crm';
import { listCalendarEventsInRange, writeTokenRecord } from '../src/calendar';
import { hmacSHA256Hex } from '../src/crypto';
import { resetRoleCache } from '../src/capabilities';
import { resetPeerRosterCache } from '../src/peers';
import { purgeAllCoreCache } from '../src/core-cache';

const d1 = { ...env, WORK_STORE: 'd1', GOOGLE_NATIVE_CLIENT_ID: 'test-native-client' } as unknown as Env;
const EMAIL = 'd1-gaps@example.com';
const AGENT = 'agent-vocab@example.com';

async function hit(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`http://local${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? null : JSON.stringify(body),
  }), d1, context);
  await waitOnExecutionContext(context);
  return response;
}

async function json<T>(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<T> {
  const response = await hit(method, path, headers, body);
  expect(response.status, `${method} ${path}: ${await response.clone().text()}`).toBeLessThan(300);
  return response.json<T>();
}

async function member(admin = false) {
  const session = await json<{ access_token: string }>('POST', '/api/dev/session', {}, { email: EMAIL, name: 'Ana' });
  if (admin) {
    await d1.USAGE.prepare("UPDATE people SET role = 'admin' WHERE email = ?1").bind(EMAIL).run();
    resetRoleCache();
  }
  return { authorization: `Bearer ${session.access_token}`, origin: env.WEB_ORIGIN };
}

const project = async (headers: Record<string, string>) =>
  (await json<CrmSubjectMutationResponse>('POST', '/api/crm/subjects', headers, { kind: 'project', title: 'D1 rollout' })).subject;

beforeEach(async () => {
  await purgeAllCoreCache();
  resetRoleCache();
  resetPeerRosterCache();
  await d1.USAGE.batch([
    'card_trace', 'thread_members', 'threads', 'interaction_contacts', 'interaction_subjects', 'interactions',
    'contact_emails', 'project_contacts', 'project_github_repos', 'decisions', 'goals', 'tasks', 'milestones', 'projects', 'leads', 'contacts', 'organizations',
  ].map((table) => d1.USAGE.prepare(`DELETE FROM ${table}`)));
  await d1.USAGE.prepare('DELETE FROM people WHERE email = ?1').bind(EMAIL).run();
});

afterEach(() => vi.unstubAllGlobals());

describe('D1 routes without the Core bridge', () => {
  it('checks local subjects before removing an orphan channel, and refuses live subjects', async () => {
    const headers = await member(true);
    const subject = await project(headers);
    const live = (await json<{ thread: ThreadSummary }>('POST', '/api/threads', headers, { kind: 'project', subject_id: subject.id })).thread;
    const goneId = `prj_${crypto.randomUUID()}`;
    await d1.USAGE.prepare("INSERT INTO threads (id, kind, parent_id, title, created_at, audience) VALUES (?1, 'project', ?2, 'Gone', ?3, 'everyone')")
      .bind(goneId, crypto.randomUUID(), Date.now()).run();

    const checked = await json<OrphanChannelsResponse>('GET', '/api/admin/channels/orphans', headers);
    expect(checked).toMatchObject({ checked: 2, check_failed: 0 });
    expect(checked.orphans.map((row) => row.thread_id)).toEqual([goneId]);
    expect((await hit('POST', '/api/admin/channels/remove', headers, { thread_id: live.id })).status).toBe(409);
    expect((await hit('POST', '/api/admin/channels/remove', headers, { thread_id: goneId })).status).toBe(200);
    expect((await json<OrphanChannelsResponse>('GET', '/api/admin/channels/orphans', headers)).removed.map((row) => row.thread_id)).toContain(goneId);
  });

  it('moves a task through an authenticated agent reply and records the human actor', async () => {
    const headers = await member();
    const subject = await project(headers);
    const { task } = await json<{ task: CrmTask }>('POST', '/api/crm/tasks', headers, { title: 'Start work', project_id: subject.id });
    const { thread } = await json<{ thread: ThreadSummary }>('POST', '/api/threads', headers, { peer_email: AGENT });
    const { message } = await json<{ message: { id: string } }>('POST', `/api/threads/${thread.id}/messages`, headers, { text: 'Start this task.' });
    const body = {
      thread_id: thread.id, type: 'event', sender: AGENT, text: 'Work started',
      move: { ref: { kind: 'task', id: task.id }, stage: 'doing' },
      in_reply_to: { thread_id: thread.id, message_id: message.id },
      idempotency_key: crypto.randomUUID(),
    };
    const timestamp = String(Date.now());
    const signature = await hmacSHA256Hex('vocab-inbound-test-key-with-at-least-32-characters', `${timestamp}.${JSON.stringify(body)}`);
    const signed = { 'x-internal-key-id': AGENT, 'x-internal-timestamp': timestamp, 'x-internal-signature': signature };
    expect((await hit('POST', '/api/internal/channel-events', signed, body)).status).toBe(200);
    expect((await json<{ task: CrmTask }>('GET', `/api/crm/tasks/${task.id}`, headers)).task.status).toBe('in_progress');
    const row = await d1.USAGE.prepare('SELECT t.updated_by, p.person_id FROM tasks t JOIN people p ON p.email = ?2 WHERE t.id = ?1')
      .bind(task.id, EMAIL).first<{ updated_by: string; person_id: string }>();
    expect(row?.updated_by).toBe(row?.person_id);

    // GitHub remains unavailable without the workspace's GitHub App.
    const issue = { ...body, move: { ref: { kind: 'issue', id: 'northwind/web#1' }, stage: 'review' }, idempotency_key: crypto.randomUUID() };
    const issueSignature = await hmacSHA256Hex('vocab-inbound-test-key-with-at-least-32-characters', `${timestamp}.${JSON.stringify(issue)}`);
    expect((await hit('POST', '/api/internal/channel-events', { ...signed, 'x-internal-signature': issueSignature }, issue)).status).toBe(503);
  });

  it('returns linked contacts on the subject history and contact page', async () => {
    const headers = await member();
    const subject = await project(headers);
    const { contact } = await json<CrmContactResponse>('POST', '/api/crm/contacts', headers, {
      name: 'Grace Hopper', emails: ['grace@example.test', 'alias@example.test'],
    });
    const payload: MeetingLogPayload = {
      phase: 'ended', meeting_id: crypto.randomUUID(), room_slug: 'rosa', host_email: EMAIL,
      started_at: '2026-10-13T09:00:00Z', ended_at: '2026-10-13T09:30:00Z', title: 'Review',
      summary_markdown: 'Agreed the next step.', transcript: [], booking_token: null, permalink: null,
      meeting_kind: 'project', project_id: subject.id, lead_id: null, partner_organization_id: null,
      categorized_by: EMAIL, transcript_document_id: null, transcript_url: null,
      participants: [{ identity: 'guest', name: 'Grace', email: 'alias@example.test', role: 'guest', booking_token: null }],
    };
    await postMeetingLog(d1, payload);
    const linked = [{ id: contact.id, name: 'Grace Hopper', email: 'grace@example.test' }];
    const history = await json<CrmInteractionsResponse>('GET', `/api/crm/interactions?project_id=${subject.id}`, headers);
    expect(history.interactions[0]?.contacts).toEqual(linked);
    const detail = await json<CrmContactResponse>('GET', `/api/crm/contacts/${contact.id}`, headers);
    expect(detail.contact.interactions[0]?.contacts).toEqual(linked);
  });

  it('resolves calendar primary addresses and aliases locally, without a Core link', async () => {
    const headers = await member();
    const { contact } = await json<CrmContactResponse>('POST', '/api/crm/contacts', headers, {
      name: 'Grace Hopper', emails: ['grace@example.test', 'alias@example.test'],
    });
    expect(await fetchCrmCalendarContacts(d1, ['GRACE@example.test', 'alias@example.test', 'missing@example.test'], { sub: `dev:${EMAIL}`, email: EMAIL, name: 'Ana' }))
      .toEqual(expect.arrayContaining([
        { id: contact.id, name: 'Grace Hopper', email: 'grace@example.test' },
        { id: contact.id, name: 'Grace Hopper', email: 'alias@example.test' },
      ]));
    await writeTokenRecord(d1, `calendar:refresh:dev:${EMAIL}`, 'refresh', EMAIL, 'native');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'calendar-access' });
      if (url.includes('/users/me/calendarList')) return Response.json({ items: [{ id: EMAIL, summary: 'Calendar', primary: true, accessRole: 'owner' }] });
      if (url.includes('/events?')) return Response.json({ items: [{
        id: 'review', status: 'confirmed', summary: 'Review', start: { dateTime: '2026-10-13T09:00:00Z' }, end: { dateTime: '2026-10-13T10:00:00Z' },
        attendees: [{ email: 'alias@example.test', responseStatus: 'accepted' }],
      }] });
      throw new Error(`Unexpected request: ${url}`);
    });
    const events = await listCalendarEventsInRange(d1, { sub: `dev:${EMAIL}`, email: EMAIL, name: 'Ana' }, '2026-10-13T00:00:00Z', '2026-10-14T00:00:00Z');
    expect(events[0]?.attendees[0]).toMatchObject({ name: 'Grace Hopper', email: 'alias@example.test', inCrm: true });
    expect(events[0]?.attendees[0]).not.toHaveProperty('crmUrl');
  });

  it('leaves Granola out of the D1 connector inventory', async () => {
    // The connector inventory is Admin's, so an admin reads it.
    const headers = await member(true);
    const status = await json<ConnectorsResponse>('GET', '/api/connectors', headers);
    expect(status.connectors.map((row) => row.id)).not.toContain('granola');
  });

  it('does not decorate a calendar guest with a contact from an inaccessible organization', async () => {
    const headers = await member();
    const { organization } = await json<{ organization: { id: string } }>('POST', '/api/crm/organizations', headers, { name: 'Private organization' });
    await json<CrmContactResponse>('POST', '/api/crm/contacts', headers, {
      name: 'Private contact', organization_id: organization.id, emails: ['private@example.test'],
    });
    const owner = { sub: `dev:${EMAIL}`, email: EMAIL, name: 'Ana' };
    expect(await fetchCrmCalendarContacts(d1, ['private@example.test'], owner)).toHaveLength(1);
    await d1.USAGE.prepare("INSERT INTO subject_visibility (kind, subject_id, visibility, updated_by, updated_at) VALUES ('organization', ?1, 'restricted', 'test', ?2)")
      .bind(organization.id, Date.now()).run();
    try {
      expect(await fetchCrmCalendarContacts(d1, ['private@example.test'], { ...owner })).toEqual([]);
      expect(await fetchCrmCalendarContacts(d1, ['private@example.test'])).toEqual([]);
    } finally {
      await d1.USAGE.prepare("DELETE FROM subject_visibility WHERE kind = 'organization' AND subject_id = ?1").bind(organization.id).run();
    }
  });
});
