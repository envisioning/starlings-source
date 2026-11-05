// Recently finished: the member's own work closed this week, read across subjects (docs/BOARD.md).
import { coreTask } from './core-rows';
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CrmRecentlyClosedWorkResponse } from '@starlings/contracts/crm';
import { purgeAllCoreCache } from '../src/core-cache';
import { recordOwnerSignIn } from '../src/usage';

const member = { sub: 'rc-rosa', email: 'rc-rosa@example.com', name: 'Rosa' };
const CORE_SECRET = 'core-test-secret-with-at-least-32-characters';
const project = { id: 'c0ffee00-0000-4000-8000-0000000000d0', kind: 'project', title: 'Acme rollout', subtitle: 'Acme', has_repo: true, open_tasks: 0 };
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();

async function session(person: { email: string; name: string }) {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(person),
  }));
  const body = await response.json<{ access_token: string }>();
  await recordOwnerSignIn(env as Env, { sub: `dev:${person.email}`, ...person }, 'mac');
  return { authorization: `Bearer ${body.access_token}` };
}

function withCore() {
  const configured = (env as Env).INTERNAL_REQUEST_SECRET;
  (env as Env).INTERNAL_REQUEST_SECRET = CORE_SECRET;
  const statusReads: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('meet-my-work')) {
      return json({ ok: true, tasks: [], issues: [], matched: true, github_login: 'rosa-gh' });
    }
    if (url.pathname.endsWith('meet-crm-subjects')) {
      const kind = url.searchParams.get('kind');
      const status = url.searchParams.get('status');
      return json({ ok: true, subjects: kind === 'project' && status === 'Active' ? [project] : [], has_more: false });
    }
    if (url.pathname.endsWith('meet-crm-tasks')) {
      // Never one subject at a time: one read per finished status, newest first.
      expect(url.searchParams.get('project_id') ?? '').toBe('');
      const status = url.searchParams.get('status');
      if (status === null) return new Response('{}', { status: 400 });
      statusReads.push(`${status}@${url.searchParams.get('offset') ?? '0'}`);
      const task = (fields: object) => coreTask({ project_id: project.id, lead_id: null, due_date: null, ...fields });
      const rows = [
        task({ id: 't-mine-done', title: 'Mine, done', status: 'completed', assignee_email: member.email, updated_at: daysAgo(1) }),
        task({ id: 't-other-done', title: 'Someone else’s', status: 'completed', assignee_email: 'ada@example.test', updated_at: daysAgo(2) }),
        task({ id: 't-mine-old', title: 'Mine, last month', status: 'completed', assignee_email: member.email, updated_at: daysAgo(30) }),
        task({ id: 't-mine-cancelled', title: 'Mine, cancelled', status: 'cancelled', assignee_email: member.email, updated_at: daysAgo(3) }),
      ];
      return json({ ok: true, tasks: rows.filter((row) => row.status === status) });
    }
    if (url.pathname.endsWith('meet-github-issues')) {
      const issue = (number: number, fields: object) => ({
        id: `acme/site#${number}`, number, owner: 'acme', repo: 'site', title: `Issue ${number}`, state: 'closed', state_reason: 'completed',
        url: `https://github.com/acme/site/issues/${number}`, labels: [], assignee_login: null, milestone: null, comments: 0, ...fields,
      });
      return json({ ok: true, linked: true, issues: [
        issue(1, { assignee_login: 'rosa-gh', updated_at: daysAgo(2) }),
        issue(2, { assignee_login: 'octo', updated_at: daysAgo(1) }),
        issue(3, { assignee_login: 'rosa-gh', state: 'open', state_reason: null, updated_at: daysAgo(1) }),
      ] });
    }
    return new Response('{}', { status: 404 });
  });
  return { statusReads, restore: () => { (env as Env).INTERNAL_REQUEST_SECRET = configured ?? ''; } };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await purgeAllCoreCache();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'rc-%'").run();
});

describe('GET /api/crm/recently-closed', () => {
  it('answers the member’s own work finished this week, newest first, from one read per status', async () => {
    const headers = await session(member);
    const core = withCore();
    try {
      const response = await exports.default.fetch(new Request('http://local/api/crm/recently-closed', { headers }));
      expect(response.status).toBe(200);
      const body = await response.json<CrmRecentlyClosedWorkResponse>();
      // Someone else's task, last month's, the other login's issue and the open issue stay out.
      expect(body.items.map((item) => `${item.kind}:${item.id}`)).toEqual([
        'task:t-mine-done', 'issue:acme/site#1', 'task:t-mine-cancelled',
      ]);
      expect(body.items[1]).toMatchObject({ subject_title: 'Acme rollout', project_id: project.id });
      expect(body.partial).toEqual([]);
      expect(core.statusReads.sort()).toEqual(['cancelled@0', 'completed@0']);
    } finally {
      core.restore();
    }
  });
});
