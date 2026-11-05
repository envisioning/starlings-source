// INBOX (meet#147 decision 4, slice 2b): resolvable sources merged newest
// first, a RECENT tail of listed subjects only, every failed read named in
// `partial`, and each source a person can turn off.
import { coreInteraction, coreTask, docsDocument } from './core-rows';
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INBOX_COMMENT_DOCUMENT_LIMIT, inboxItemMatchesFilter, type InboxResponse } from '@starlings/contracts/inbox';
import { purgeAllCoreCache } from '../src/core-cache';
import { resetRoleCache } from '../src/capabilities';
import { resetPeerRosterCache } from '../src/peers';
import { resetDocsTokenCache } from '../src/docs';
import { recordCardHold } from '../src/card-holds';
import { storePendingEvents } from '../src/pending-calendar-events';
import { withInboundMailbox } from './inbound-mailbox';
import { invitationsByStart } from '../src/inbox';

withInboundMailbox();

const rosa ={ email: 'inbox-rosa@example.com', name: 'Rosa' };
const CORE_SECRET = 'core-test-secret-with-at-least-32-characters';
const client = { id: 'c0ffee00-0000-4000-8000-0000000000c0', kind: 'project', title: 'Acme rollout', subtitle: 'Acme', has_repo: false, open_tasks: 0, internal: false, organization_id: 'org-a', organization_name: 'Acme' };
const lead = { id: 'c0ffee00-0000-4000-8000-0000000000c1', kind: 'lead', title: 'Beta talks', subtitle: null, open_tasks: 0, organization_id: 'org-b', organization_name: 'Beta' };
const partner = { id: 'c0ffee00-0000-4000-8000-0000000000c2', kind: 'partner', title: 'Gamma Partners', subtitle: null, open_tasks: 0 };
const DAY = 24 * 60 * 60 * 1000;
const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

describe('INBOX invitations', () => {
  it('lead in the order their events start, whatever Google last updated', () => {
    const invitation = (id: string, start: string, at: number) =>
      ({ key: `invitation:${id}`, at, source: 'invitation', event: { id, start } }) as unknown as Parameters<typeof invitationsByStart>[0][number];
    const ordered = invitationsByStart([
      invitation('later', '2026-10-27T13:00:00Z', 300),
      invitation('sooner', '2026-10-20T12:00:00Z', 100),
      invitation('same-b', '2026-10-22T09:00:00Z', 200),
      invitation('same-a', '2026-10-22T09:00:00Z', 200),
    ]);
    expect(ordered.map((item) => item.key)).toEqual(['invitation:sooner', 'invitation:same-a', 'invitation:same-b', 'invitation:later']);
  });
});

describe('INBOX contextual filters', () => {
  it('folds mentions into unread talk', () => {
    expect(inboxItemMatchesFilter({ source: 'mention' }, 'talk')).toBe(true);
    expect(inboxItemMatchesFilter({ source: 'mention' }, 'task')).toBe(false);
    expect(inboxItemMatchesFilter({ source: 'note' }, 'all')).toBe(true);
  });
});

async function session() {
  const response = await exports.default.fetch(new Request('http://local/api/dev/session', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rosa),
  }));
  const body = await response.json<{ access_token: string }>();
  const headers = { authorization: `Bearer ${body.access_token}` };
  await exports.default.fetch(new Request('http://local/api/peers', { headers }));
  // Sign-in gives every member a room (meet#878), and a room has a booking
  // read from Core that this suite does not script. Its member has none.
  await env.USAGE.batch([
    env.USAGE.prepare('UPDATE rooms SET retired_at = 1 WHERE owner_email = ?1').bind(rosa.email),
    env.USAGE.prepare('UPDATE people SET room_slug = NULL WHERE email = ?1').bind(rosa.email),
  ]);
  return headers;
}

async function hit(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return exports.default.fetch(new Request(`http://local${path}`, {
    method, headers: { ...headers, 'content-type': 'application/json' }, body: body === undefined ? null : JSON.stringify(body),
  }));
}

/**
 * `proposals` scripts Core's cross-subject proposed list: how many rows,
 * paged by `offset` (meet#190). `documentPages` scripts a
 * Docs that lists 200 a page with `total`, honouring `offset` or not.
 */
function withCore({ docs = false, manyDocuments = false, proposals, documentPages, cardIssues, responsible }: {
  docs?: boolean;
  /** Issues on the client project's repository, which then has one. */
  cardIssues?: Array<Record<string, unknown>>;
  /** Who is chosen as responsible for the client project. */
  responsible?: string | null;
  manyDocuments?: boolean;
  proposals?: { count: number };
  documentPages?: { count: number; pages: boolean };
} = {}) {
  const configured = (env as Env).INTERNAL_REQUEST_SECRET;
  (env as Env).INTERNAL_REQUEST_SECRET = CORE_SECRET;
  const docsConfigured = (env as Env).DOCS_INTERNAL_SECRET;
  (env as Env).DOCS_INTERNAL_SECRET = docs ? 'docs-test-secret-with-at-least-32-characters' : '';
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname + url.search);
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('meet-crm-subjects')) {
      const kind = url.searchParams.get('kind');
      const status = url.searchParams.get('status');
      if (kind === 'project' && status === 'Active') return json({ ok: true, subjects: [cardIssues ? { ...client, has_repo: true, responsible_email: responsible ?? null } : client], has_more: false });
      if (kind === 'lead' && status === 'Proposal Out') return json({ ok: true, subjects: [lead], has_more: false });
      if (kind === 'partner') return json({ ok: true, subjects: [partner], has_more: false });
      return json({ ok: true, subjects: [], has_more: false });
    }
    // Core answers across subjects (`status=`, `since=`) and per subject;
    // the stub scripts both so either read shape finds the same rows.
    if (url.pathname.endsWith('meet-crm-tasks')) {
      const subjectId = url.searchParams.get('project_id') ?? url.searchParams.get('lead_id');
      const status = url.searchParams.get('status');
      if (proposals && status === 'proposed' && !subjectId) {
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const rows = Array.from({ length: proposals.count }, (_, n) =>
          coreTask({ id: `t-p-${n}`, title: `Proposal ${n}`, status: 'proposed', project_id: client.id, lead_id: null, due_date: null, updated_at: iso(DAY + n) }));
        return json({ ok: true, tasks: rows.slice(offset, offset + limit) });
      }
      const all = [
        coreTask({ id: 't-proposed', title: 'Kick off delivery', status: 'proposed', project_id: client.id, lead_id: null, due_date: null, updated_at: iso(DAY) }),
        coreTask({ id: 't-open', title: 'Open one', status: 'pending', project_id: client.id, lead_id: null, due_date: null, updated_at: iso(DAY) }),
        // A partner's own proposal: an organization and nothing else.
        coreTask({ id: 't-partner-proposed', title: 'Renew the agreement', status: 'proposed', project_id: null, lead_id: null, organization_id: partner.id, due_date: null, updated_at: iso(2 * DAY) }),
        // Proposed on a subject that is not open: never in play.
        coreTask({ id: 't-orphan', title: 'Closed deal', status: 'proposed', project_id: 'c0ffee00-0000-4000-8000-00000000dead', lead_id: null, due_date: null, updated_at: iso(DAY) }),
      ];
      return json({ ok: true, tasks: all.filter((task) => (subjectId ? task.project_id === subjectId : task.status === status)) });
    }
    // Your own work: one task late, one fresh, one stale, one done; one
    // open issue and one closed.
    if (url.pathname.endsWith('meet-my-work')) {
      const mine = (id: string, title: string, due: string | null, updated: string, status = 'pending') =>
        ({ id, title, notes: null, status, responsible_party: 'Rosa', due_date: due, priority: null, project_id: client.id, lead_id: null, subject_title: client.title, github_owner: null, github_repo: null, github_issue_number: null, updated_at: updated });
      return json({
        tasks: [
          mine('m-late', 'Send the deck', iso(3 * DAY), iso(DAY)),
          mine('m-fresh', 'Draft the SOW', null, iso(2 * DAY)),
          mine('m-stale', 'Old ask', null, iso(20 * DAY)),
          mine('m-done', 'Done ask', iso(3 * DAY), iso(DAY), 'completed'),
          mine('m-proposed', 'Proposed ask', null, iso(DAY), 'proposed'),
        ],
        issues: [
          { id: 'envisioning/starlings#7', number: 7, owner: 'envisioning', repo: 'starlings', title: 'Fix the rail', state: 'open', url: 'https://github.com/envisioning/starlings-source/issues/7', labels: [], assignee_login: 'rosa', updated_at: iso(DAY), milestone: null, comments: 0 },
          { id: 'envisioning/starlings#8', number: 8, owner: 'envisioning', repo: 'starlings', title: 'Closed', state: 'closed', url: 'https://github.com/envisioning/starlings-source/issues/8', labels: [], assignee_login: 'rosa', updated_at: iso(DAY), milestone: null, comments: 0 },
        ],
        matched: true,
        github_login: 'rosa',
      });
    }
    if (cardIssues && url.pathname.endsWith('meet-github-issues')) return json({ ok: true, linked: true, issues: cardIssues });
    if (url.pathname.endsWith('meet-crm-interactions')) {
      const subjectId = url.searchParams.get('project_id') ?? url.searchParams.get('lead_id');
      const rowsFor = (id: string, kind: 'project' | 'lead') => [
        coreInteraction({ id: `i-fresh-${id}`, title: 'Kickoff call', type: 'call', occurred_at: iso(2 * DAY), created_at: iso(2 * DAY), project_id: kind === 'project' ? id : null, lead_id: kind === 'lead' ? id : null, url: null, contacts: [] }),
        coreInteraction({ id: `i-stale-${id}`, title: 'Old note', type: 'note', occurred_at: iso(9 * DAY), created_at: iso(9 * DAY), project_id: kind === 'project' ? id : null, lead_id: kind === 'lead' ? id : null, url: null, contacts: [] }),
      ];
      if (subjectId) return json({ ok: true, interactions: rowsFor(subjectId, subjectId === lead.id ? 'lead' : 'project') });
      const since = Date.parse(url.searchParams.get('since') ?? '');
      return json({ ok: true, interactions: [...rowsFor(client.id, 'project'), ...rowsFor(lead.id, 'lead')].filter((row) => Date.parse(row.occurred_at) >= since) });
    }
    if (docs) {
      if (url.pathname === '/api/tokens/meet-exchange') return json({ token: 'evd_inbox', scopes: [], expires_at: iso(-30 * DAY), email: rosa.email });
      if (url.pathname === '/api/docs' && documentPages) {
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const offset = documentPages.pages ? Number(url.searchParams.get('offset') ?? 0) : 0;
        const rows = Array.from({ length: documentPages.count }, (_, n) =>
          docsDocument({ id: `d-page-${n}`, title: `Paged ${n}`, path: `/work/paged/${n}`, subjects: [{ system: 'core', kind: 'project', subject_id: client.id }], updated_at: iso((2 + n) * DAY) }));
        return json({ documents: rows.slice(offset, offset + limit), total: documentPages.count });
      }
      if (url.pathname === '/api/docs') {
        return json({ documents: [
          docsDocument({ id: 'd-about-client', title: 'Radar update', path: '/work/project/acme/radar', subjects: [{ system: 'core', kind: 'project', subject_id: client.id }], updated_at: iso(DAY) }),
          docsDocument({ id: 'd-about-lead', title: 'Beta brief', path: '/work/lead/beta/brief', subjects: [{ system: 'core', kind: 'lead', subject_id: lead.id }], updated_at: iso(DAY) }),
          docsDocument({ id: 'd-stale', title: 'Old', path: '/work/old', subjects: [{ system: 'core', kind: 'project', subject_id: client.id }], updated_at: iso(30 * DAY) }),
          // Past the per-load cap: listed, older than every row above, so
          // they are the ones left unread.
          ...(manyDocuments
            ? Array.from({ length: 25 }, (_, n) => docsDocument({ id: `d-many-${n}`, title: `Many ${n}`, path: `/work/many/${n}`, subjects: [{ system: 'core', kind: 'project', subject_id: client.id }], updated_at: iso((40 + n) * DAY) }))
            : []),
        ], total: manyDocuments ? 28 : 3 });
      }
      const match = url.pathname.match(/^\/api\/docs\/([^/]+)\/annotations$/u);
      if (match) {
        const comment = (id: string, threadID: string, parentID: string | null, author: string, agoMs: number, status = 'open') => ({
          id, document_id: match[1], document_version: 1, thread_id: threadID, parent_id: parentID, author, author_name: null,
          author_kind: 'staff', body_md: `Comment ${id}`, anchor: { type: 'text', quote: 'radar' }, status,
          resolved_by: null, resolved_at: null, created_at: iso(agoMs), updated_at: iso(agoMs),
        });
        if (match[1] === 'd-about-client') return json([
          comment('a-open', 'a-open', null, 'ada@example.com', 3 * DAY),
          comment('a-reply', 'a-open', 'a-open', 'bo@example.com', 2 * DAY),
          comment('a-mine', 'a-mine', null, 'ada@example.com', 4 * DAY),
          comment('a-mine-reply', 'a-mine', 'a-mine', rosa.email, DAY),
          comment('a-done', 'a-done', null, 'ada@example.com', 5 * DAY, 'resolved'),
        ]);
        return json([]);
      }
    }
    return new Response('{}', { status: 404 });
  });
  return { calls, restore: () => { (env as Env).INTERNAL_REQUEST_SECRET = configured ?? ''; (env as Env).DOCS_INTERNAL_SECRET = docsConfigured ?? ''; } };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await purgeAllCoreCache();
  await env.USAGE.prepare("DELETE FROM subject_state WHERE sub IN (SELECT sub FROM people WHERE email LIKE 'inbox-%')").run();
  await env.USAGE.prepare("DELETE FROM work_preferences WHERE sub IN (SELECT sub FROM people WHERE email LIKE 'inbox-%')").run();
  await env.USAGE.prepare("DELETE FROM inbox_dismissed WHERE sub IN (SELECT sub FROM people WHERE email LIKE 'inbox-%')").run();
  await env.USAGE.prepare("DELETE FROM people WHERE email LIKE 'inbox-%'").run();
  await env.USAGE.prepare('DELETE FROM card_holds').run();
  await env.USAGE.prepare("DELETE FROM interest_submissions WHERE email LIKE 'inbox-%'").run();
  resetRoleCache();
  resetPeerRosterCache();
  resetDocsTokenCache();
});

describe('GET /api/crm/inbox', () => {
  it('needs a member', async () => {
    expect((await exports.default.fetch(new Request('http://local/api/crm/inbox'))).status).toBe(401);
  });

  it('without Core: unfiled notes, nothing partial, no tail', async () => {
    const configured = (env as Env).INTERNAL_REQUEST_SECRET;
    (env as Env).INTERNAL_REQUEST_SECRET = '';
    try {
      const headers = await session();
      await hit('POST', '/api/quick-notes', headers, { body: 'Call Ada back', source: 'work' });
      const body = await (await hit('GET', '/api/crm/inbox', headers)).json<InboxResponse>();
      expect(body.items.map((item) => item.source)).toEqual(['note']);
      expect(body.recent).toEqual([]);
      expect(body.partial).toEqual([]);
    } finally {
      (env as Env).INTERNAL_REQUEST_SECRET = configured ?? '';
    }
  });

  it('calendar: an event from forwarded mail is a row only for a client that asks; no calendar connected is no invitation, not a failed read', async () => {
    const configured = (env as Env).INTERNAL_REQUEST_SECRET;
    (env as Env).INTERNAL_REQUEST_SECRET = '';
    try {
      const headers = await session();
      const [id] = await storePendingEvents(env as Env, `dev:${rosa.email}`, { hash: 'inbox-forwarded', subject: 'Your flight', from: 'airline@example.net' }, [{
        title: 'Flight LIS → AMS',
        all_day: false,
        start: new Date(Date.now() + 2 * DAY).toISOString(),
        end: new Date(Date.now() + 2 * DAY + 3 * 60 * 60 * 1000).toISOString(),
        time_zone: null,
        location: null,
        notes: null,
        attendees: [],
        confidence: 0.95,
      }]);

      const old = await (await hit('GET', '/api/crm/inbox', headers)).json<InboxResponse>();
      expect(old.items.some((item) => item.source === 'forwarded')).toBe(false);

      const body = await (await hit('GET', '/api/crm/inbox?calendar=true', headers)).json<InboxResponse>();
      const row = body.items.find((item) => item.source === 'forwarded');
      expect(row).toMatchObject({ key: `forwarded:${id}`, source: 'forwarded', event: { id, title: 'Flight LIS → AMS' } });
      expect(body.items.some((item) => item.source === 'invitation')).toBe(false);
      expect(body.partial).toEqual([]);

      await hit('PATCH', '/api/crm/subject-state', headers, { inbox_sources: { forwarded: false } });
      const off = await (await hit('GET', '/api/crm/inbox?calendar=true', headers)).json<InboxResponse>();
      expect(off.items.some((item) => item.source === 'forwarded')).toBe(false);
      await hit('PATCH', '/api/crm/subject-state', headers, { inbox_sources: { forwarded: true } });

      // No inbound mail domain, no calendar@: the source is neither read nor offered (meet#1056).
      const inbound = (env as Env).INBOUND_EMAIL;
      (env as { INBOUND_EMAIL: string }).INBOUND_EMAIL = 'off';
      try {
        const closed = await (await hit('GET', '/api/crm/inbox?calendar=true', headers)).json<InboxResponse>();
        expect(closed.items.some((item) => item.source === 'forwarded')).toBe(false);
        const state = await (await hit('GET', '/api/crm/subject-state', headers)).json<{ inbox_available_sources: string[] }>();
        expect(state.inbox_available_sources).not.toContain('forwarded');
        expect(state.inbox_available_sources).toContain('invitation');
      } finally {
        (env as { INBOUND_EMAIL: string }).INBOUND_EMAIL = inbound ?? 'on';
      }
    } finally {
      (env as Env).INTERNAL_REQUEST_SECRET = configured ?? '';
    }
  });

  it('with Core: proposed tasks join the items; the tail holds listed subjects, seven days, never leads without Sales', async () => {
    const core = withCore();
    try {
      const headers = await session();
      const body = await (await hit('GET', '/api/crm/inbox', headers)).json<InboxResponse>();
      const task = body.items.find((item) => item.source === 'task');
      expect(task && task.source === 'task' ? task.task.id : null).toBe('t-proposed');
      expect(body.items.some((item) => item.source === 'task' && item.task.id === 't-open')).toBe(false);
      // Sales is off: the lead's history is never read, let alone shown; the
      // client's stale note is past the window.
      expect(body.recent.map((entry) => [entry.subject.id, entry.id, entry.subject.group])).toEqual([
        [client.id, `i-fresh-${client.id}`, 'clients'],
      ]);
      expect(core.calls.some((call) => call.includes('meet-crm-interactions') && call.includes(lead.id))).toBe(false);
      expect(body.items.some((item) => item.source === 'task' && item.task.id === 't-orphan')).toBe(false);
      // One read per source across every subject, not one per subject.
      expect(core.calls.filter((call) => call.includes('meet-crm-tasks')).length).toBe(1);
      expect(core.calls.filter((call) => call.includes('meet-crm-interactions')).length).toBe(1);
      // Sales is off, so no touches read was even attempted.
      expect(body.partial).toEqual([]);
    } finally {
      core.restore();
    }
  });

  it('a proposed partner task is an inbox item on the partner, from the one cross-subject read', async () => {
    const core = withCore();
    try {
      const headers = await session();
      const body = await (await hit('GET', '/api/crm/inbox', headers)).json<InboxResponse>();
      const item = body.items.find((row) => row.source === 'task' && row.task.id === 't-partner-proposed');
      expect(item && item.source === 'task' ? item.subject : null).toEqual({ kind: 'organization', id: partner.id, title: 'Gamma Partners' });
      // Still one task read, and one partner list read, never one per partner.
      expect(core.calls.filter((call) => call.includes('meet-crm-tasks')).length).toBe(1);
      expect(core.calls.filter((call) => call.includes('meet-crm-subjects') && call.includes('kind=partner')).length).toBe(1);
      expect(body.partial).toEqual([]);
    } finally {
      core.restore();
    }
  });

  it('proposals past one page are read page by page (meet#190)', async () => {
    const core = withCore({ proposals: { count: 230 } });
    try {
      const headers = await session();
      const body = await (await hit('GET', '/api/crm/inbox', headers)).json<InboxResponse>();
      expect(body.items.filter((item) => item.source === 'task').length).toBe(230);
      expect(body.partial).toEqual([]);
      const reads = core.calls.filter((call) => call.includes('meet-crm-tasks') && call.includes('status=proposed'));
      expect(reads.length).toBe(3);
      expect(reads[1]).toContain('offset=100');
      expect(reads[2]).toContain('offset=200');
    } finally {
      core.restore();
    }
  });

  it('proposals past the page ceiling are a short read, never a smaller complete inbox (meet#190)', async () => {
    const core = withCore({ proposals: { count: 620 } });
    try {
      const headers = await session();
      const body = await (await hit('GET', '/api/crm/inbox', headers)).json<InboxResponse>();
      expect(body.items.filter((item) => item.source === 'task').length).toBe(500);
      expect(body.partial).toEqual(['task']);
      expect(core.calls.filter((call) => call.includes('status=proposed')).length).toBe(5);
    } finally {
      core.restore();
    }
  });

  it('documents with open threads are listed page by page, asked for as such (meet#190)', async () => {
    let core = withCore({ docs: true, documentPages: { count: 350, pages: true } });
    try {
      const headers = await session();
      const body = await (await hit('GET', '/api/crm/inbox', headers)).json<InboxResponse>();
      const lists = core.calls.filter((call) => call.startsWith('/api/docs?'));
      expect(lists.length).toBe(2);
      expect(lists[0]).toContain('open_annotations=1');
      expect(lists[1]).toContain('offset=200');
      // Every listed document is a candidate; the per-document read cap
      // still cuts them, and says so as capped, not failed.
      expect(core.calls.filter((call) => /\/api\/docs\/[^/]+\/annotations$/u.test(call)).length).toBe(20);
      expect(body.partial).toEqual([]);
      expect(body.capped).toEqual(['comment']);
    } finally {
      core.restore();
    }
    await purgeAllCoreCache();
    resetDocsTokenCache();
    core = withCore({ docs: true, documentPages: { count: 350, pages: false } });
    try {
      const headers = await session();
      const body = await (await hit('GET', '/api/crm/inbox', headers)).json<InboxResponse>();
      // The same page twice: noticed, stopped, said.
      expect(core.calls.filter((call) => call.startsWith('/api/docs?')).length).toBe(2);
      expect(body.partial).toEqual([]);
      expect(body.capped).toEqual(['comment']);
    } finally {
      core.restore();
    }
  });

  it('a card you handed to an agent is a row while it waits in Review or Blocked (docs/OWNERSHIP.md decision 12)', async () => {
    const issue = (number: number, labels: string[]) => ({
      id: `envisioning/starlings#${number}`, number, owner: 'envisioning', repo: 'starlings', title: `Card ${number}`, state: 'open',
      url: `https://github.com/envisioning/starlings-source/issues/${number}`, labels, assignee_login: null, milestone: null, comments: 0, updated_at: iso(DAY),
    });
    const core = withCore({ cardIssues: [issue(42, ['agent:review']), issue(43, ['agent:building']), issue(44, ['agent:failed']), issue(45, ['agent:review'])] });
    try {
      const headers = await session();
      const now = Date.now();
      const hold = (number: number, holder: string) => recordCardHold(env as Env, {
        refKind: 'issue', refId: `envisioning/starlings#${number}`, holderEmail: holder, agentEmail: 'vocab@example.com',
        subject: { kind: 'project', id: client.id },
      }, now - number);
      await hold(42, rosa.email);
      await hold(43, rosa.email);
      await hold(44, rosa.email);
      // Somebody else handed this one off: their row, not yours.
      await hold(45, 'inbox-other@example.com');

      // An older client that did not ask for cards gets none.
      const before = await (await hit('GET', '/api/crm/inbox', headers)).json<InboxResponse>();
      expect(before.items.some((item) => item.source === 'card')).toBe(false);

      const body = await (await hit('GET', '/api/crm/inbox?cards=true', headers)).json<InboxResponse>();
      const cards = body.items.filter((item) => item.source === 'card');
      expect(cards.map((item) => [item.key, item.source === 'card' ? item.stage : null])).toEqual([
        ['card:issue:envisioning/starlings#42', 'review'],
        ['card:issue:envisioning/starlings#44', 'blocked'],
      ]);
      expect(cards[0]).toMatchObject({
        agent: { email: 'vocab@example.com' },
        subject: { kind: 'project', id: client.id, title: client.title },
        task: null,
        issue: { number: 42 },
      });
      expect(body.partial).not.toContain('card');

      // Turned off, it is not read at all.
      await hit('PATCH', '/api/crm/subject-state', headers, { inbox_sources: { card: false } });
      const off = await (await hit('GET', '/api/crm/inbox?cards=true', headers)).json<InboxResponse>();
      expect(off.items.some((item) => item.source === 'card')).toBe(false);
    } finally {
      core.restore();
    }
  });

  it('a card waits on the chosen responsible person, not on whoever handed it off (docs/OWNERSHIP.md decision 12)', async () => {
    const issue = (number: number) => ({
      id: `envisioning/starlings#${number}`, number, owner: 'envisioning', repo: 'starlings', title: `Card ${number}`, state: 'open',
      url: `https://github.com/envisioning/starlings-source/issues/${number}`, labels: ['agent:review'], assignee_login: null, milestone: null, comments: 0, updated_at: iso(DAY),
    });
    const hold = (number: number, holder: string) => recordCardHold(env as Env, {
      refKind: 'issue', refId: `envisioning/starlings#${number}`, holderEmail: holder, agentEmail: 'vocab@example.com',
      subject: { kind: 'project', id: client.id },
    });
    const keys = async (headers: Record<string, string>) => (await (await hit('GET', '/api/crm/inbox?cards=true', headers)).json<InboxResponse>())
      .items.filter((item) => item.source === 'card').map((item) => item.key);

    // Chosen: you. A colleague handed it off; it waits on you.
    let core = withCore({ cardIssues: [issue(51)], responsible: rosa.email });
    try {
      const headers = await session();
      await hold(51, 'inbox-other@example.com');
      expect(await keys(headers)).toEqual(['card:issue:envisioning/starlings#51']);
    } finally {
      core.restore();
    }

    // Chosen: somebody else. You handed it off; it no longer waits on you.
    vi.unstubAllGlobals();
    await purgeAllCoreCache();
    await env.USAGE.prepare('DELETE FROM card_holds').run();
    core = withCore({ cardIssues: [issue(52)], responsible: 'inbox-other@example.com' });
    try {
      const headers = await session();
      await hold(52, rosa.email);
      expect(await keys(headers)).toEqual([]);
    } finally {
      core.restore();
    }
  });

  it('your own work is never an INBOX item: MINE lists it', async () => {
    const core = withCore();
    try {
      const headers = await session();
      const body = await (await hit('GET', '/api/crm/inbox', headers)).json<InboxResponse>();
      expect(body.partial).toEqual([]);
      expect(body.items.map((item) => item.key).some((key) => key.startsWith('overdue:') || key.startsWith('assigned:'))).toBe(false);
      // INBOX does not read my-work at all.
      expect(core.calls.filter((call) => call.includes('meet-my-work'))).toHaveLength(0);
      // The old reminder keys are not dismissable any more.
      expect((await hit('POST', '/api/crm/inbox/assigned:issue:envisioning%2Fmeet%237/dismiss', headers)).status).toBe(400);
    } finally {
      core.restore();
    }
  });

  it('interest: a company that filled in /interest is a row for admins only, seen by hand', async () => {
    const configured = (env as Env).INTERNAL_REQUEST_SECRET;
    (env as Env).INTERNAL_REQUEST_SECRET = '';
    try {
      const headers = await session();
      const answers = {
        name: 'Ada', email: 'inbox-ada@example.net', company: 'Example Co', role: 'ops', company_size: '11-50', team_size: '2-10',
        deployment: 'self-hosted', reason: 'own-data', timeline: 'quarter', identity: 'google', devices: [],
        tools: { video: [], notes: [], booking: [], work: [], chat: [], agents: [] }, pains: [], parts: ['meetings', 'docs'], pilot: false, call: false,
      };
      await env.USAGE.prepare(
        'INSERT INTO interest_submissions (id, created_at, email, company, body) VALUES (?1, ?2, ?3, ?4, ?5)',
      ).bind('int_test', Date.now() - DAY, 'inbox-ada@example.net', 'Example Co', JSON.stringify(answers)).run();
      // A month-old one is the tracker's.
      await env.USAGE.prepare(
        'INSERT INTO interest_submissions (id, created_at, email, company, body) VALUES (?1, ?2, ?3, ?4, ?5)',
      ).bind('int_old', Date.now() - 40 * DAY, 'inbox-old@example.net', 'Old Co', JSON.stringify(answers)).run();

      // A member sees nothing: it is a sales signal, not their work.
      let inbox = await (await hit('GET', '/api/crm/inbox', headers)).json<InboxResponse>();
      expect(inbox.items.filter((item) => item.source === 'interest')).toEqual([]);

      await env.USAGE.prepare("UPDATE people SET role = 'admin' WHERE email = ?1").bind(rosa.email).run();
      resetRoleCache();
      inbox = await (await hit('GET', '/api/crm/inbox', headers)).json<InboxResponse>();
      const rows = inbox.items.filter((item) => item.source === 'interest');
      expect(rows.map((item) => item.key)).toEqual(['interest:int_test']);
      const [row] = rows;
      if (row?.source !== 'interest') throw new Error('expected an interest item');
      // Labels, not ids: the client carries no option list.
      expect(row.submission.team_size).toBe('2 to 10');
      expect(row.submission.deployment).toBe('On our own Cloudflare and Apple accounts');
      expect(row.submission.parts).toEqual(['Calls', 'Docs']);

      expect((await hit('POST', '/api/crm/inbox/interest:int_test/dismiss', headers)).status).toBe(200);
      inbox = await (await hit('GET', '/api/crm/inbox', headers)).json<InboxResponse>();
      expect(inbox.items.filter((item) => item.source === 'interest')).toEqual([]);

      // Off by preference: not read at all.
      await env.USAGE.prepare("DELETE FROM inbox_dismissed WHERE key = 'interest:int_test'").run();
      await hit('PATCH', '/api/crm/subject-state', headers, { inbox_sources: { interest: false } });
      inbox = await (await hit('GET', '/api/crm/inbox', headers)).json<InboxResponse>();
      expect(inbox.items.filter((item) => item.source === 'interest')).toEqual([]);
    } finally {
      (env as Env).INTERNAL_REQUEST_SECRET = configured ?? '';
    }
  });

  it('interest: the permanent-room owner gets the bootstrap-admin row even when D1 says member', async () => {
    const mutableEnv = env as unknown as { OWNER_ROOM_MAP: string };
    const configuredOwnerRoomMap = mutableEnv.OWNER_ROOM_MAP;
    mutableEnv.OWNER_ROOM_MAP = JSON.stringify({ [rosa.email]: 'rosa' });
    try {
      const headers = await session();
      const answers = {
        name: 'Ada', email: 'inbox-bootstrap@example.net', company: 'Bootstrap Co', role: 'ops', company_size: '11-50', team_size: '2-10',
        deployment: 'self-hosted', reason: 'own-data', timeline: 'quarter', identity: 'google', devices: [],
        tools: { video: [], notes: [], booking: [], work: [], chat: [], agents: [] }, pains: [], parts: ['meetings'], pilot: false, call: false,
      };
      await env.USAGE.prepare(
        'INSERT INTO interest_submissions (id, created_at, email, company, body) VALUES (?1, ?2, ?3, ?4, ?5)',
      ).bind('int_bootstrap', Date.now(), answers.email, answers.company, JSON.stringify(answers)).run();

      const inbox = await (await hit('GET', '/api/crm/inbox', headers)).json<InboxResponse>();
      expect(inbox.items.filter((item) => item.source === 'interest').map((item) => item.key)).toEqual(['interest:int_bootstrap']);
      const state = await (await hit('GET', '/api/crm/subject-state', headers)).json<{ inbox_available_sources: string[] }>();
      expect(state.inbox_available_sources).toContain('interest');
    } finally {
      mutableEnv.OWNER_ROOM_MAP = configuredOwnerRoomMap;
    }
  });

  it('mute and the Sales opt-in shape the read', async () => {
    const core = withCore();
    try {
      const headers = await session();
      await hit('PUT', `/api/crm/subject-state/project/${client.id}`, headers, { muted: true });
      await hit('PATCH', '/api/crm/subject-state', headers, { sales_enabled: true });
      const body = await (await hit('GET', '/api/crm/inbox', headers)).json<InboxResponse>();
      // Muted client drops out of the tail; with Sales on the lead comes in.
      expect(body.recent.map((entry) => entry.subject.id)).toEqual([lead.id]);
      // Sales on: the touches read and the offers-and-licenses read (meet#1261)
      // were attempted, and this scripted Core has no PAT door, so each is
      // named as a gap rather than silently empty.
      expect([...body.partial].sort()).toEqual(['commercial', 'sales']);
    } finally {
      core.restore();
    }
  });

  it('with Docs: more listed documents than the cap names `comment` in capped (meet#190)', async () => {
    const core = withCore({ docs: true, manyDocuments: true });
    try {
      const headers = await session();
      const body = await (await hit('GET', '/api/crm/inbox', headers)).json<InboxResponse>();
      expect(body.items.filter((item) => item.source === 'comment').map((item) => item.key)).toEqual(['comment:a-open']);
      expect(core.calls.filter((call) => call.includes('/annotations')).length).toBe(INBOX_COMMENT_DOCUMENT_LIMIT);
      expect(body.partial).toEqual([]);
      expect(body.capped).toEqual(['comment']);
    } finally {
      core.restore();
    }
  });

  it('with Docs: open comment threads on listed subjects join the items, unless the last word was yours (meet#175)', async () => {
    const core = withCore({ docs: true });
    try {
      const headers = await session();
      const body = await (await hit('GET', '/api/crm/inbox', headers)).json<InboxResponse>();
      const comments = body.items.filter((item) => item.source === 'comment');
      // One thread: `a-open` (Ada, Bo replied). `a-mine` ends with rosa, `a-done`
      // is resolved, the lead is hidden (Sales off). `d-stale` is a month
      // old and still read: a comment does not touch `updated_at` (meet#190).
      expect(comments.map((item) => item.key)).toEqual(['comment:a-open']);
      const item = comments[0]!;
      if (item.source !== 'comment') throw new Error('not a comment');
      expect(item.document.id).toBe('d-about-client');
      expect(item.subject?.title).toBe('Acme rollout');
      expect(item.latest.author).toBe('bo@example.com');
      expect(item.replies).toBe(1);
      expect(core.calls.some((call) => call.includes('/api/docs/d-about-lead/annotations'))).toBe(false);
      expect(core.calls.some((call) => call.includes('/api/docs/d-stale/annotations'))).toBe(true);
      expect(body.partial).toEqual([]);
    } finally {
      core.restore();
    }
  });
});
