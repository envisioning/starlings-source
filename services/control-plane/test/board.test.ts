// The board read: every open card on every subject, in one answer.
import { coreTask } from './core-rows';
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { purgeAllCoreCache } from '../src/core-cache';
import { recordOwnerSignIn } from '../src/usage';
import type { CrmBoardResponse } from '../src/board';

const rosa = { sub: 'bd-rosa', email: 'bd-rosa@example.com', name: 'Rosa' };
const CORE_SECRET = 'core-test-secret-with-at-least-32-characters';
const project = { id: 'c0ffee00-0000-4000-8000-0000000000b0', kind: 'project', title: 'Acme rollout', subtitle: 'Acme', has_repo: true, open_tasks: 1 };
const lead = { id: 'c0ffee00-0000-4000-8000-0000000000b1', kind: 'lead', title: 'Beta talks', subtitle: null, open_tasks: 1 };
const idleLead = { id: 'c0ffee00-0000-4000-8000-0000000000b2', kind: 'lead', title: 'Idle lead', subtitle: null, open_tasks: 0, last_activity_at: '2026-01-01T00:00:00Z' };
const justFinishedLead = { id: 'c0ffee00-0000-4000-8000-0000000000b3', kind: 'lead', title: 'Just finished lead', subtitle: null, open_tasks: 0, last_activity_at: '2026-09-04T00:00:00Z' };
const partner = { id: 'c0ffee00-0000-4000-8000-0000000000b4', kind: 'partner', title: 'Gamma Partners', subtitle: null, open_tasks: 0 };
const quietPartner = { id: 'c0ffee00-0000-4000-8000-0000000000b5', kind: 'partner', title: 'Quiet Partners', subtitle: null, open_tasks: 0 };
const now = Date.parse('2026-09-05T12:00:00Z');
const since = '2026-09-01T00:00:00Z';

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

/** Core scripted: one project, one lead, their work, and one failing read. */
function withCore(options: { failTasksFor?: string; includeIdleLead?: boolean; includeJustFinishedLead?: boolean; capTasks?: boolean; partners?: boolean; failPartnerTasks?: boolean } = {}) {
  const configured = (env as Env).INTERNAL_REQUEST_SECRET;
  (env as Env).INTERNAL_REQUEST_SECRET = CORE_SECRET;
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname + url.search);
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('meet-crm-subjects')) {
      const kind = url.searchParams.get('kind');
      const status = url.searchParams.get('status');
      if (kind === 'project' && status === 'Active') return json({ ok: true, subjects: [project], has_more: false });
      if (kind === 'lead' && status === 'Proposal Out') return json({ ok: true, subjects: [lead], has_more: false });
      if (kind === 'lead' && status === 'Conversations' && (options.includeIdleLead || options.includeJustFinishedLead)) {
        return json({ ok: true, subjects: [
          ...(options.includeIdleLead ? [idleLead] : []),
          ...(options.includeJustFinishedLead ? [justFinishedLead] : []),
        ], has_more: false });
      }
      if (kind === 'partner' && options.partners) return json({ ok: true, subjects: [partner, quietPartner], has_more: false });
      return json({ ok: true, subjects: [], has_more: false });
    }
    if (url.pathname.endsWith('meet-crm-tasks') && url.searchParams.get('scope') === 'partner') {
      if (options.failPartnerTasks) return new Response('{}', { status: 500 });
      expect(url.searchParams.get('include_done')).toBe('1');
      return json({ ok: true, tasks: options.partners ? [
        coreTask({ id: 't-partner-open', title: 'Renew', status: 'pending', project_id: null, lead_id: null, organization_id: partner.id, due_date: null, updated_at: '2026-09-04T00:00:00Z' }),
        coreTask({ id: 't-partner-old', title: 'Long done', status: 'completed', project_id: null, lead_id: null, organization_id: partner.id, due_date: null, updated_at: '2026-01-01T00:00:00Z' }),
        coreTask({ id: 't-partner-proposed', title: 'Maybe', status: 'proposed', project_id: null, lead_id: null, organization_id: quietPartner.id, due_date: null, updated_at: '2026-09-04T00:00:00Z' }),
      ] : [] });
    }
    if (url.pathname.endsWith('meet-crm-tasks')) {
      const subjectId = url.searchParams.get('project_id') ?? url.searchParams.get('lead_id');
      if (options.failTasksFor === subjectId) return new Response('{}', { status: 500 });
      expect(url.searchParams.get('include_done')).toBe('1');
      if (options.capTasks) {
        return json({ ok: true, tasks: Array.from({ length: 100 }, (_, i) => (
          coreTask({ id: `t-cap-${subjectId}-${i}`, title: `Open ${i}`, status: 'pending', project_id: subjectId, lead_id: null, due_date: null, updated_at: '2026-09-04T00:00:00Z' })
        )) });
      }
      return json({ ok: true, tasks: [
        coreTask({ id: `t-open-${subjectId}`, title: 'Open one', status: 'pending', project_id: subjectId, lead_id: null, due_date: null, updated_at: '2026-09-04T00:00:00Z' }),
        coreTask({ id: `t-old-${subjectId}`, title: 'Long done', status: 'completed', project_id: subjectId, lead_id: null, due_date: null, updated_at: '2026-01-01T00:00:00Z' }),
        coreTask({ id: `t-new-${subjectId}`, title: 'Just done', status: 'completed', project_id: subjectId, lead_id: null, due_date: null, updated_at: '2026-09-04T00:00:00Z' }),
      ] });
    }
    if (url.pathname.endsWith('meet-github-issues')) {
      expect(url.searchParams.get('state')).toBe('all');
      return json({ ok: true, linked: true, issues: [
        { id: 'acme/site#7', number: 7, owner: 'acme', repo: 'site', title: 'Fix footer', state: 'open', url: 'https://github.com/acme/site/issues/7', labels: ['agent:building'], assignee_login: null, milestone: null, comments: 0, updated_at: '2026-09-04T00:00:00Z' },
        { id: 'acme/site#3', number: 3, owner: 'acme', repo: 'site', title: 'Old', state: 'closed', state_reason: 'completed', url: 'https://github.com/acme/site/issues/3', labels: [], assignee_login: null, milestone: null, comments: 0, updated_at: '2026-01-01T00:00:00Z' },
      ] });
    }
    return new Response('{}', { status: 404 });
  });
  return { calls, restore: () => { (env as Env).INTERNAL_REQUEST_SECRET = configured ?? ''; } };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await purgeAllCoreCache();
  await env.USAGE.prepare('DELETE FROM card_trace').run();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'bd-%'").run();
});

describe('GET /api/crm/board', () => {
  it('needs a member', async () => {
    // Refused the way every member route refuses a stranger here.
    const response = await exports.default.fetch(new Request('http://local/api/crm/board'));
    expect(response.status).toBe(401);
  });

  it('answers every open subject, its work inside the finished window, and each card\'s last line', async () => {
    const headers = await session(rosa);
    const core = withCore();
    await env.USAGE.prepare(
      'INSERT INTO card_trace (ref_kind, ref_id, thread_id, message_id, text, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    ).bind('issue', 'acme/site#7', 'prj_x', 'msg_x', 'Factory started on #7', now - 1000).run();

    try {
      const response = await exports.default.fetch(new Request(`http://local/api/crm/board?finished_since=${since}`, { headers }));
      expect(response.status).toBe(200);
      const body = await response.json<CrmBoardResponse>();

      expect(body.subjects.map((subject) => subject.title)).toEqual(['Acme rollout', 'Beta talks']);
      expect(body.partial).toEqual([]);
      // Open work and this week's finished work; the January task and issue stay in the archive.
      expect(body.tasks.map((task) => task.id).sort()).toEqual([
        `t-new-${lead.id}`, `t-new-${project.id}`, `t-open-${lead.id}`, `t-open-${project.id}`,
      ].sort());
      expect(body.issues.map((issue) => issue.id)).toEqual(['acme/site#7']);
      expect(body.issue_projects).toEqual({ 'acme/site#7': project.id });
      expect(body.traces).toEqual([
        { ref_kind: 'issue', ref_id: 'acme/site#7', thread_id: 'prj_x', message_id: 'msg_x', text: 'Factory started on #7', at: now - 1000 },
      ]);
      // A lead has no repository, so nothing asked GitHub about it.
      expect(core.calls.filter((call) => call.includes('meet-github-issues'))).toHaveLength(1);
    } finally {
      core.restore();
    }
  });

  it('draws partner tasks from one read and only the partners that hold one', async () => {
    const headers = await session(rosa);
    const core = withCore({ partners: true });
    try {
      const response = await exports.default.fetch(new Request(`http://local/api/crm/board?finished_since=${since}`, { headers }));
      const body = await response.json<CrmBoardResponse>();
      expect(body.subjects.map((subject) => subject.title)).toEqual(['Acme rollout', 'Beta talks', 'Gamma Partners']);
      expect(body.tasks.filter((task) => task.organization_id === partner.id).map((task) => task.id)).toEqual(['t-partner-open']);
      expect(body.tasks.some((task) => task.id === 't-partner-proposed')).toBe(false);
      expect(body.partial).toEqual([]);
      expect(core.calls.filter((call) => call.includes('scope=partner'))).toHaveLength(1);
      // No per-partner task read, and no GitHub read for a partner.
      expect(core.calls.filter((call) => call.includes(`organization_id=${partner.id}`))).toHaveLength(0);
      expect(core.calls.filter((call) => call.includes('meet-github-issues'))).toHaveLength(1);
    } finally {
      core.restore();
    }
  });

  it('a failed partner read is `partners` in partial, never a failed board', async () => {
    const headers = await session(rosa);
    const core = withCore({ partners: true, failPartnerTasks: true });
    try {
      const response = await exports.default.fetch(new Request(`http://local/api/crm/board?finished_since=${since}`, { headers }));
      expect(response.status).toBe(200);
      const body = await response.json<CrmBoardResponse>();
      expect(body.partial).toEqual(['partners']);
      expect(body.failed).toEqual([{ subject: 'partners', cause: 'upstream', status: 500 }]);
      expect(body.subjects.map((subject) => subject.title)).toEqual(['Acme rollout', 'Beta talks']);
    } finally {
      core.restore();
    }
  });

  it('names the subject it could not read instead of drawing it empty', async () => {
    const headers = await session(rosa);
    const core = withCore({ failTasksFor: lead.id });
    try {
      const response = await exports.default.fetch(new Request(`http://local/api/crm/board?finished_since=${since}`, { headers }));
      const body = await response.json<CrmBoardResponse>();
      expect(body.partial).toEqual(['Beta talks']);
      expect(body.failed).toEqual([{ subject: 'Beta talks', cause: 'upstream', status: 500 }]);
      expect(body.truncated).toEqual([]);
      expect(body.tasks.some((task) => task.id === `t-open-${project.id}`)).toBe(true);
      expect(body.tasks.some((task) => task.id === `t-open-${lead.id}`)).toBe(false);
    } finally {
      core.restore();
    }
  });

  it('does not spend a Core task read on a subject with no open tasks', async () => {
    const headers = await session(rosa);
    const core = withCore({ includeIdleLead: true });
    try {
      const response = await exports.default.fetch(new Request(`http://local/api/crm/board?finished_since=${since}`, { headers }));
      const body = await response.json<CrmBoardResponse>();
      expect(body.subjects.map((subject) => subject.title)).toContain('Idle lead');
      expect(body.partial).not.toContain('Idle lead');
      expect(core.calls.some((call) => call.includes(`lead_id=${idleLead.id}`))).toBe(false);
    } finally {
      core.restore();
    }
  });

  it('still reads a subject at zero open tasks when it moved inside the window (meet#190)', async () => {
    const headers = await session(rosa);
    const core = withCore({ includeJustFinishedLead: true });
    try {
      const response = await exports.default.fetch(new Request(`http://local/api/crm/board?finished_since=${since}`, { headers }));
      const body = await response.json<CrmBoardResponse>();
      expect(core.calls.some((call) => call.includes(`lead_id=${justFinishedLead.id}`))).toBe(true);
      expect(body.tasks.map((task) => task.id)).toContain(`t-new-${justFinishedLead.id}`);
    } finally {
      core.restore();
    }
  });

  // meet#1022: a cap hit is not a failure. It is `truncated`, and `partial`
  // (which every client draws red) stays empty.
  it('names a subject whose task read hit the ceiling as truncated, not failed (meet#190, meet#1022)', async () => {
    const headers = await session(rosa);
    const core = withCore({ capTasks: true });
    try {
      const response = await exports.default.fetch(new Request(`http://local/api/crm/board?finished_since=${since}`, { headers }));
      const body = await response.json<CrmBoardResponse>();
      expect(body.truncated).toContain('Acme rollout');
      expect(body.truncated).toContain('Beta talks');
      expect(body.partial).toEqual([]);
      expect(body.failed).toEqual([]);
    } finally {
      core.restore();
    }
  });

  it('answers 503 while the bridge is off', async () => {
    const headers = await session(rosa);
    const configured = (env as Env).INTERNAL_REQUEST_SECRET;
    (env as Env).INTERNAL_REQUEST_SECRET = '';
    try {
      const response = await exports.default.fetch(new Request('http://local/api/crm/board', { headers }));
      expect(response.status).toBe(503);
    } finally {
      (env as Env).INTERNAL_REQUEST_SECRET = configured ?? '';
    }
  });
});
