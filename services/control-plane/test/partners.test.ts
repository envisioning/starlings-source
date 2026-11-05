import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CrmSubjectsResponse, CrmSubjectDetailResponse } from '@starlings/contracts';

// Partners are a third subject kind, read-only, passed through to Core's
// meet-crm-subjects with kind=partner (PARTNERS (HQ Docs), meet#64). These pin
// the Worker's half: the kind is accepted on the list and detail reads, a
// partner's history reads by organization_id, and no write route exists.

const rosa = { email: 'partners-rosa@example.com', name: 'Rosa' };
const CORE_SECRET = 'core-test-secret-with-at-least-32-characters';
const partner = {
  id: 'c0ffee00-0000-4000-8000-0000000000aa', kind: 'partner', title: 'Acme Labs', subtitle: 'Berlin, DE · 2 projects',
  organization_logo_url: null, open_tasks: 0, overdue_tasks: 0, has_repo: false, related_projects: 2, related_leads: 0,
};

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
  const seen: URL[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    seen.push(url);
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('meet-crm-subjects') && url.searchParams.get('kind') === 'partner') {
      if (url.searchParams.get('id') === partner.id) {
        return json({ ok: true, subject: { ...partner, status: 'Partner', updated_at: null, industry: 'Research', related: { projects: [], leads: [], contacts: [] } }, subjects: [partner], has_more: false });
      }
      return json({ ok: true, subjects: [partner], has_more: false });
    }
    if (url.pathname.endsWith('meet-crm-interactions')) {
      return json({ ok: true, interactions: [] });
    }
    return new Response('{}', { status: 404 });
  });
  return { seen, restore: () => { (env as Env).INTERNAL_REQUEST_SECRET = configured ?? ''; } };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'partners-%'").run();
});

describe('partner subjects', () => {
  it('lists partners through Core with kind=partner', async () => {
    const core = withCore();
    const headers = await session();
    const response = await exports.default.fetch(new Request('http://local/api/crm/subjects?kind=partner&q=acme', { headers }));
    expect(response.status).toBe(200);
    const body = await response.json<CrmSubjectsResponse>();
    expect(body.subjects.map((subject) => subject.kind)).toEqual(['organization']);
    expect(core.seen.some((url) => url.searchParams.get('kind') === 'partner' && url.searchParams.get('q') === 'acme')).toBe(true);
    core.restore();
  });

  it('reads one partner with its related work', async () => {
    const core = withCore();
    const headers = await session();
    const response = await exports.default.fetch(new Request(`http://local/api/crm/subjects/partner/${partner.id}`, { headers }));
    expect(response.status).toBe(200);
    const body = await response.json<CrmSubjectDetailResponse>();
    expect(body.subject.kind).toBe('organization');
    expect(body.subject.related).toBeDefined();
    core.restore();
  });

  it('has no write route for a partner', async () => {
    const core = withCore();
    const headers = await session();
    const response = await exports.default.fetch(new Request(`http://local/api/crm/subjects/partner/${partner.id}`, {
      method: 'PATCH', headers: { ...headers, 'content-type': 'application/json', origin: 'http://local' }, body: '{"title":"x"}',
    }));
    expect(response.status).toBe(404);
    core.restore();
  });

  it('reads a partner’s history by organization', async () => {
    const core = withCore();
    const headers = await session();
    const response = await exports.default.fetch(new Request(`http://local/api/crm/interactions?organization_id=${partner.id}`, { headers }));
    expect(response.status).toBe(200);
    expect(core.seen.some((url) => url.pathname.endsWith('meet-crm-interactions') && url.searchParams.get('organization_id') === partner.id)).toBe(true);
    const both = await exports.default.fetch(new Request(`http://local/api/crm/interactions?organization_id=${partner.id}&lead_id=${partner.id}`, { headers }));
    expect(both.status).toBe(400);
    core.restore();
  });
});
