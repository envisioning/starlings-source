import { env } from 'cloudflare:workers';
import { coreTask } from './core-rows';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThreadMessagesResponse } from '@starlings/contracts';
import worker from '../src/index';
import { announceCalendarFilings, openSubjectThread } from '../src/threads';
import { recordOwnerSignIn } from '../src/usage';

import { requireCapability } from '../src/capabilities';
// The person a route's gate has already read: what a thread function takes now.
const memberOf = (request: Request) => requireCapability(request, env as Env, 'conversations');

/**
 * Phase 2 of docs/TIMELINE.md: two more producers on the same quiet-event
 * pipe `postIssueEvent` and the meeting-filed lines already use. Two
 * properties are worth pinning for each — the line only fires on the change
 * that actually matters, and it lands on the right subject's channel.
 */

const rosa = { sub: 'timeline-evt-rosa', email: 'timeline-evt-rosa@example.com', name: 'Rosa' };

const configured = {
  ...env,
  CRM_SYNC_MODE: 'on',
  INTERNAL_REQUEST_SECRET: 'a-shared-test-secret-with-at-least-32-characters',
} as Env;

// One project/lead per test: D1 is wiped between tests, a Durable Object's
// storage is not, so two tests on one subject would share a channel.
const taskProject = 'c1d2e3f4-0000-4a00-8000-00000000b001';
const taskProjectUnchanged = 'c1d2e3f4-0000-4a00-8000-00000000b002';
const calendarProject = 'c1d2e3f4-0000-4a00-8000-00000000b003';
const calendarLead = 'c1d2e3f4-0000-4a00-8000-00000000b004';
const calendarProjectUnfiled = 'c1d2e3f4-0000-4a00-8000-00000000b005';

function coreReturns(options: {
  title: string;
  task?: { id: string; project_id?: string | null; lead_id?: string | null; title: string };
}) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.includes('meet-crm-tasks/') && options.task) {
      return Response.json({ task: coreTask(options.task) });
    }
    return Response.json({
      ok: true,
      subjects: [{ id: url.searchParams.get('id'), kind: url.searchParams.get('kind'), title: options.title, subtitle: null }],
    });
  });
}

async function member(context: ReturnType<typeof createExecutionContext>) {
  const response = await worker.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: rosa.name, email: rosa.email }),
  }), configured, context);
  const body = await response.json<{ access_token: string }>();
  await recordOwnerSignIn(configured, { sub: `dev:${rosa.email}`, email: rosa.email, name: rosa.name }, 'mac');
  return { authorization: `Bearer ${body.access_token}`, 'content-type': 'application/json' };
}

async function channelMessages(
  context: ReturnType<typeof createExecutionContext>,
  headers: Record<string, string>,
  kind: 'project' | 'lead',
  id: string,
) {
  const thread = await openSubjectThread(
    await memberOf(new Request('http://local/api/threads', { method: 'POST', headers })), configured, kind, id,
  );
  const response = await worker.fetch(
    new Request(`http://local/api/threads/${thread.id}/messages`, { headers }), configured, context,
  );
  return (await response.json<ThreadMessagesResponse>()).messages;
}

afterEach(() => vi.unstubAllGlobals());

describe('a task finishing, in its subject’s channel', () => {
  it('names who finished it and carries a ref the client can open', async () => {
    const context = createExecutionContext();
    const mine = await member(context);
    coreReturns({
      title: 'Acme rollout',
      task: { id: '11111111-1111-4111-8111-111111111111', project_id: taskProject, title: 'Ship the deck' },
    });

    const response = await worker.fetch(new Request('http://local/api/crm/tasks/11111111-1111-4111-8111-111111111111', {
      method: 'PATCH',
      headers: mine,
      body: JSON.stringify({ status: 'completed' }),
    }), configured, context);
    expect(response.status).toBe(200);
    await waitOnExecutionContext(context);

    const messages = await channelMessages(context, mine, 'project', taskProject);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'event',
      text: 'Rosa completed: Ship the deck',
      sender_email: 'meet@org.example',
      refs: [{ kind: 'task', id: '11111111-1111-4111-8111-111111111111' }],
    });
  });

  it('writes nothing for an edit that does not complete the task', async () => {
    const context = createExecutionContext();
    const mine = await member(context);
    coreReturns({
      title: 'Someone else’s project',
      task: { id: '22222222-2222-4222-8222-222222222222', project_id: taskProjectUnchanged, title: 'Rename the deck' },
    });

    const response = await worker.fetch(new Request('http://local/api/crm/tasks/22222222-2222-4222-8222-222222222222', {
      method: 'PATCH',
      headers: mine,
      body: JSON.stringify({ title: 'Rename the deck' }),
    }), configured, context);
    expect(response.status).toBe(200);
    await waitOnExecutionContext(context);

    expect(await channelMessages(context, mine, 'project', taskProjectUnchanged)).toHaveLength(0);
  });
});

describe('a calendar filing, in its subject’s channel', () => {
  it('announces a key that is new or points at a different subject', async () => {
    const context = createExecutionContext();
    const mine = await member(context);
    coreReturns({ title: 'Acme rollout' });
    const project = { kind: 'project' as const, id: calendarProject, title: 'Acme rollout' };
    const lead = { kind: 'lead' as const, id: calendarLead, title: 'A prospective lead' };

    await announceCalendarFilings(
      configured,
      { sub: rosa.sub, email: rosa.email, name: rosa.name } as never,
      { 'event:g:primary:kickoff': project },
      {
        // Unchanged — must announce nothing.
        'event:g:primary:kickoff': project,
        // New key — announces.
        'event:g:primary:standup': lead,
      },
    );

    expect(await channelMessages(context, mine, 'project', calendarProject)).toHaveLength(0);
    const leadMessages = await channelMessages(context, mine, 'lead', calendarLead);
    expect(leadMessages).toHaveLength(1);
    expect(leadMessages[0]).toMatchObject({
      type: 'event',
      text: 'Rosa filed a calendar event here',
      sender_email: 'meet@org.example',
    });
  });

  it('says nothing when a key’s subject is unset — unfiling is silent', async () => {
    const context = createExecutionContext();
    const mine = await member(context);
    coreReturns({ title: 'Acme rollout' });
    const project = { kind: 'project' as const, id: calendarProjectUnfiled, title: 'Acme rollout' };

    await announceCalendarFilings(
      configured,
      { sub: rosa.sub, email: rosa.email, name: rosa.name } as never,
      { 'event:g:primary:kickoff': project },
      {},
    );

    expect(await channelMessages(context, mine, 'project', calendarProjectUnfiled)).toHaveLength(0);
  });
});
