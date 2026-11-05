import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CrmSubjectsResponse } from '@starlings/contracts';

// The organization edge (meet#147 slice 1, core#142): Core puts
// organization_id / organization_name on every subject row and `internal` on
// projects, and the Worker hands them through untouched. This pins the
// passthrough so a future re-mapping of the row cannot quietly drop the edge
// the rail groups by.

const rosa = { email: 'orgedge-rosa@example.com', name: 'Rosa' };
const CORE_SECRET = 'core-test-secret-with-at-least-32-characters';
const rows = [
  {
    id: 'c0ffee00-0000-4000-8000-000000000001', kind: 'project', title: 'Meet', subtitle: 'Active',
    organization_id: 'c0ffee00-0000-4000-8000-0000000000ee', organization_name: 'Envisioning', internal: true,
    organization_logo_url: null, open_tasks: 1, overdue_tasks: 0, has_repo: true, agent_email: null,
  },
  {
    id: 'c0ffee00-0000-4000-8000-000000000002', kind: 'project', title: 'Rollout', subtitle: 'Acme · Active',
    organization_id: null, organization_name: null, internal: false,
    organization_logo_url: null, open_tasks: 0, overdue_tasks: 0, has_repo: false, agent_email: null,
  },
];

async function session() {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rosa),
  }));
  const body = await response.json<{ access_token: string }>();
  return { authorization: `Bearer ${body.access_token}` };
}

function withCore() {
  const configured = (env as Env).INTERNAL_REQUEST_SECRET;
  (env as Env).INTERNAL_REQUEST_SECRET = CORE_SECRET;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith('meet-crm-subjects') && url.searchParams.get('kind') === 'project') {
      return new Response(JSON.stringify({ ok: true, subjects: rows, has_more: false }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  });
  return { restore: () => { (env as Env).INTERNAL_REQUEST_SECRET = configured ?? ''; } };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'orgedge-%'").run();
});

describe('subject organization edge', () => {
  it('passes organization_id, organization_name and internal through from Core', async () => {
    const core = withCore();
    try {
      const headers = await session();
      const response = await exports.default.fetch(new Request('http://local/api/crm/subjects?kind=project', { headers }));
      expect(response.status).toBe(200);
      const body = await response.json<CrmSubjectsResponse>();
      expect(body.subjects.map((subject) => [subject.organization_id, subject.organization_name, subject.internal])).toEqual([
        ['c0ffee00-0000-4000-8000-0000000000ee', 'Envisioning', true],
        // Null is a value: a project with no organization lists under NO ORGANIZATION.
        [null, null, false],
      ]);
    } finally {
      core.restore();
    }
  });
});
