// Overview's UNOWNED list: the board's read through the shared rule (docs/BOARD.md §Unowned).
import { coreTask } from './core-rows';
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CrmUnownedWorkResponse } from '@starlings/contracts/crm';
import { purgeAllCoreCache } from '../src/core-cache';
import { recordOwnerSignIn } from '../src/usage';

const member = { sub: 'uo-rosa', email: 'uo-rosa@example.com', name: 'Rosa' };
const CORE_SECRET = 'core-test-secret-with-at-least-32-characters';
const project = { id: 'c0ffee00-0000-4000-8000-0000000000c0', kind: 'project', title: 'Acme rollout', subtitle: 'Acme', has_repo: true, open_tasks: 4 };
const ada = '11111111-1111-4111-8111-111111111111';

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
  const statusReads: string[] = [];
  const configured = (env as Env).INTERNAL_REQUEST_SECRET;
  (env as Env).INTERNAL_REQUEST_SECRET = CORE_SECRET;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('meet-crm-subjects')) {
      const kind = url.searchParams.get('kind');
      const status = url.searchParams.get('status');
      return json({ ok: true, subjects: kind === 'project' && status === 'Active' ? [project] : [], has_more: false });
    }
    if (url.pathname.endsWith('meet-crm-tasks')) {
      // UNOWNED reads tasks across subjects, one status at a time; never one subject at a time.
      expect(url.searchParams.get('project_id') ?? '').toBe('');
      expect(url.searchParams.get('lead_id') ?? '').toBe('');
      const status = url.searchParams.get('status');
      if (status === null) return new Response('{}', { status: 400 });
      statusReads.push(status);
      const task = (fields: object) => coreTask({ project_id: project.id, lead_id: null, due_date: null, updated_at: '2026-09-04T00:00:00Z', ...fields });
      const rows = [
        task({ id: 't-nobody', title: 'Nobody', status: 'pending', responsible_party: 'team', assignee_id: null, assignee_email: null, due_date: '2026-09-01T00:00:00Z' }),
        task({ id: 't-no-side', title: 'No side', status: 'in_progress', responsible_party: 'unassigned', assignee_id: null, assignee_email: null }),
        task({ id: 't-client', title: 'Client owes it', status: 'pending', responsible_party: 'client', assignee_id: null, assignee_email: null }),
        task({ id: 't-ada', title: 'Ada has it', status: 'pending', responsible_party: 'team', assignee_id: ada, assignee_email: 'ada@example.test' }),
        task({ id: 't-closed-subject', title: 'On a lead nobody has open', status: 'pending', project_id: null, lead_id: 'c0ffee00-0000-4000-8000-0000000000c9', responsible_party: 'team', assignee_id: null, assignee_email: null }),
      ];
      return json({ ok: true, tasks: rows.filter((row) => row.status === status) });
    }
    if (url.pathname.endsWith('meet-github-issues')) {
      const issue = (number: number, fields: object) => ({
        id: `acme/site#${number}`, number, owner: 'acme', repo: 'site', title: `Issue ${number}`, state: 'open',
        url: `https://github.com/acme/site/issues/${number}`, labels: [], assignee_login: null, milestone: null, comments: 0,
        updated_at: '2026-09-03T00:00:00Z', ...fields,
      });
      return json({ ok: true, linked: true, issues: [
        issue(1, {}),
        issue(2, { assignee_login: 'octo' }),
        issue(3, { labels: ['agent:building'] }),
      ] });
    }
    return new Response('{}', { status: 404 });
  });
  return { statusReads, restore: () => { (env as Env).INTERNAL_REQUEST_SECRET = configured ?? ''; } };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await purgeAllCoreCache();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'uo-%'").run();
});

describe('GET /api/crm/unowned', () => {
  it('needs a member', async () => {
    const response = await exports.default.fetch(new Request('http://local/api/crm/unowned'));
    expect(response.status).toBe(401);
  });

  it('answers the work nobody on our side holds, in Mine\'s shapes and the plan\'s order', async () => {
    const headers = await session(member);
    const core = withCore();
    try {
      const response = await exports.default.fetch(new Request('http://local/api/crm/unowned', { headers }));
      expect(response.status).toBe(200);
      const body = await response.json<CrmUnownedWorkResponse>();
      // Late first, then undated by movement; the client's task, Ada's, the
      // assigned issue and the agent's are held, and a task on a subject
      // that is not open is not in play.
      expect(body.tasks.map((task) => task.id)).toEqual(['t-nobody', 't-no-side']);
      expect(body.tasks[0]!.subject_title).toBe('Acme rollout');
      expect(body.issues.map((issue) => issue.id)).toEqual(['acme/site#1']);
      // An issue names no subject of its own; the project it was read for rides beside it.
      expect(body.issue_subjects).toEqual({ 'acme/site#1': { kind: 'project', id: project.id, title: 'Acme rollout' } });
      expect(body.partial).toEqual([]);
      expect(core.statusReads.sort()).toEqual(['blocked', 'in_progress', 'pending', 'review']);
    } finally {
      core.restore();
    }
  });
});
