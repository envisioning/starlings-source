// The table-group move from Core to D1 (meet#757, docs/CORE_FOLD_PLAN.md
// §The group move): the per-group store switch, the write freeze, a copy
// that verifies, a verify that catches a mismatch, and the foreign-key order.
//
// The pool's env is Envisioning, a WORK_STORE=core workspace. Core is a fake
// here: `fetch` answers the read-only export route
// (`/api/public/meet-fold-export`) from the `core` tables below, and the
// other Core routes a case needs. Nothing leaves the test.
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORK_GROUPS, WORK_GROUP_TABLES, type WorkGroupMoveResponse, type WorkGroupStatus } from '@starlings/contracts';
import worker from '../src/index';
import { createCrmGoal, createCrmSubject, fetchCrmContactDetail, fetchCrmSubjectDetail, createCrmTask, fetchCrmGoals, fetchCrmInteractions, postMeetingLog, fetchCrmPartnerTasks, fetchCrmSubjects, fetchCrmTask, fetchCrmTasks, updateCrmTask } from '../src/crm';
import { ControlError } from '../src/errors';
import { copyGroup, diffGroup, freezeGroup, isEmptySession, TABLE_SPECS, unfreezeGroup, verifyGroup } from '../src/work-group-moves';
import { groupStore, usesCoreFor, usesCoreForKind } from '../src/work-store';

const SECRET = 'meet-core-shared-secret-at-least-32-chars';
/** Envisioning with Core reachable: every group on Core. */
const coreEnv = { ...env, INTERNAL_REQUEST_SECRET: SECRET, CRM_SYNC_MODE: 'on' } as Env;
/** The same workspace after the first group's flip. */
const subjectsOnD1 = { ...coreEnv, WORK_STORE_SUBJECTS: 'd1' } as Env;

const ORG = '0a000000-0000-4000-8000-000000000001';
const PARTNER = '0a000000-0000-4000-8000-000000000002';
const CONTACT = '0c000000-0000-4000-8000-000000000001';
const LEAD = '1e000000-0000-4000-8000-000000000001';
const PROJECT = '9a000000-0000-4000-8000-000000000001';
/** ADR 0008: a Core lead and project can share an id. They are separate tables in D1 too. */
const SHARED_ID = '5a000000-0000-4000-8000-000000000005';

type CoreRow = Record<string, unknown>;

/** Core's tables as PostgREST sends them: ISO times, booleans, Core's column names. */
function coreFixture(): Record<string, CoreRow[]> {
  return {
    organizations: [
      {
        id: ORG, name: 'Acme', is_partner: false, industry: 'Retail', website: 'https://acme.test', profile_image_url: null, logo_url: 'https://acme.test/logo.png', created_at: '2025-01-02T03:04:05.678+00:00',
        // Every other column Core keeps (meet#1209).
        legal_name: 'Acme BV', address: 'Dam 1', postcode: '1012 JS', city: 'Amsterdam', country: 'NL', vat_id: 'NL000', tax_id: 'T-1',
        size: '11-50', notes: 'Key account', owner_id: 'b0000000-0000-4000-8000-000000000001', founded: '2010', hq_location: 'Amsterdam',
        company_type: 'Private', linkedin_url: 'https://linkedin.test/acme', logo_image_url: 'https://acme.test/image.png', entity: 'EU',
        domain: 'acme.test', is_agency: true, is_existing_client: true, search_vector: "'acme':1",
      },
      { id: PARTNER, name: 'Partner Co', is_partner: true, industry: null, website: null, profile_image_url: 'https://partner.test/p.png', created_at: '2025-02-01T00:00:00+00:00' },
    ],
    contacts: [
      {
        id: CONTACT, organization_id: ORG, name: 'Ana', email: 'ana@acme.test', company_role: 'CTO', created_at: '2025-01-03T00:00:00+00:00',
        // Every other column Core keeps (meet#1209).
        notes: 'Met in Lisbon', linkedin_url: 'https://linkedin.test/ana', phone: '+31 20 000 0000', headline: 'CTO at Acme', location: 'Amsterdam',
        connection_count: '500+', country: 'NL', corporate_email: 'ana@corp.test', profile_image_url: 'https://acme.test/ana.png',
        characteristics: { speaker: true, newsletter_subscriber: false }, preferred_language: 'pt', signals_outreach_status: 'contacted',
        signals_notified_at: '2025-05-01T00:00:00+00:00', birthday_month: 12, birthday_day: 10, birthday_year: 1990,
        futurist: true, corporate: false, academic: true, independent: false, government: false, ngo: true, media: false, intelligence: true,
        search_vector: "'ana':1",
      },
    ],
    leads: [
      { id: LEAD, organization_id: ORG, contact_id: CONTACT, title: 'Acme pilot', status: 'Proposal', start_date: '2025-03-01T00:00:00+00:00', notes: null, created_at: '2025-03-01T10:00:00+00:00', updated_at: '2025-03-02T10:00:00+00:00', responsible_email: 'rosa@example.com', responsible_set_by: 'rosa@example.com', responsible_set_at: '2025-03-02T10:00:00+00:00' },
      { id: SHARED_ID, organization_id: PARTNER, contact_id: null, title: null, status: 'Won', start_date: '2025-04-01T00:00:00+00:00', created_at: '2025-04-01T00:00:00+00:00', updated_at: '2025-04-01T00:00:00+00:00' },
    ],
    projects: [
      { id: PROJECT, organization_id: ORG, lead_id: LEAD, title: 'Acme radar', status: 'Active', description: 'Radar', url: null, start_date: '2025-04-01', end_date: null, is_internal: false, agent_email: null, created_at: '2025-04-01T00:00:00+00:00', updated_at: '2025-05-01T00:00:00+00:00', evid: 'EV-1' },
      { id: SHARED_ID, organization_id: PARTNER, lead_id: SHARED_ID, title: 'Same id as its lead', status: 'Planning', is_internal: true, created_at: '2025-04-02T00:00:00+00:00', updated_at: '2025-04-02T00:00:00+00:00' },
    ],
    project_contacts: [
      { id: 'pc-1', project_id: PROJECT, contact_id: CONTACT, created_at: '2025-04-01T00:00:00+00:00' },
      // A duplicate junction row: one D1 row.
      { id: 'pc-2', project_id: PROJECT, contact_id: CONTACT, created_at: '2025-04-02T00:00:00+00:00' },
    ],
    milestones: [
      {
        id: 'ab000000-0000-4000-8000-000000000001', project_id: PROJECT, title: 'Kickoff', status: 'planned', due_date: '2025-06-01',
        created_at: '2025-04-01T00:00:00+00:00', updated_at: '2025-04-01T00:00:00+00:00',
        notes: 'Bring the deck.', place: 'Studio', location: 'Amsterdam', start_time: '09:30:00', timezone: 'Europe/Amsterdam',
        start_at: '2025-06-01T07:30:00+00:00', search_vector: "'kickoff':1",
      },
    ],
    tasks: [],
    // The settings tables (meet#1228). Core holds the three sources migration 0132 seeds, with its own times.
    lead_characteristics_config: [{ id: 'lc000000-0000-4000-8000-000000000001', name: 'project_fit', created_at: '2025-01-01T00:00:00+00:00' }],
    contact_characteristics_config: [{ id: 'cc000000-0000-4000-8000-000000000001', name: 'speaker', created_at: '2025-01-01T00:00:00+00:00' }],
    contact_source_definitions: [
      { key: 'crm_manual', label: 'Added manually', category: 'manual', description: 'Contact created directly in the CRM.', is_active: true, manual_selectable: true, import_selectable: false, is_system: true, sort_order: 10, created_at: '2026-07-19T00:00:00+00:00', updated_at: '2026-07-19T00:00:00+00:00' },
      { key: 'agent_api', label: 'Agent/API', category: 'integration', description: null, is_active: true, manual_selectable: false, import_selectable: false, is_system: true, sort_order: 20, created_at: '2026-07-19T00:00:00+00:00', updated_at: '2026-07-19T00:00:00+00:00' },
      { key: 'website_contact', label: 'Website contact form', category: 'website', description: null, is_active: true, manual_selectable: false, import_selectable: false, is_system: true, sort_order: 70, created_at: '2026-07-19T00:00:00+00:00', updated_at: '2026-07-19T00:00:00+00:00' },
      { key: 'substack', label: 'Substack import', category: 'import', description: null, is_active: true, manual_selectable: false, import_selectable: true, is_system: true, sort_order: 50, created_at: '2026-07-19T00:00:00+00:00', updated_at: '2026-07-20T00:00:00+00:00' },
    ],
    contact_source_events: [
      { id: 'ce000000-0000-4000-8000-000000000001', contact_id: CONTACT, event_type: 'imported', source_key: 'substack', occurred_at: '2025-01-03T00:00:00+00:00', metadata: { original_source: 'substack-import', subscriber_status: 'active' }, dedupe_key: 'newsletter_subscriber:1', created_at: '2026-07-19T00:00:00+00:00' },
    ],
    // Core's merge aliases (meet#1216): none until a case adds one.
    organization_merge_aliases: [],
    contact_merge_aliases: [],
  };
}

let core = coreFixture();
let calls: string[] = [];

function coreAnswer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mockCore(other: (url: URL, method: string) => Response = () => coreAnswer({ error: 'not here' }, 404)): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.pathname}`);
    if (url.pathname === '/api/public/meet-fold-export') {
      const rows = core[url.searchParams.get('table') ?? ''];
      if (!rows) return coreAnswer({ error: 'unknown table' }, 400);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 500);
      return coreAnswer({ rows: rows.slice(offset, offset + limit), has_more: offset + limit < rows.length });
    }
    return other(url, request.method);
  });
}

async function clearD1(): Promise<void> {
  const tables = [...WORK_GROUPS].reverse().flatMap((group) => [...WORK_GROUP_TABLES[group]].reverse());
  await env.USAGE.batch([
    // The sources migration 0132 seeds stay: a D1 contact write records one.
    ...tables.map((table) => env.USAGE.prepare(table === 'contact_source_definitions'
      ? `DELETE FROM contact_source_definitions WHERE key NOT IN ('crm_manual', 'agent_api', 'website_contact')`
      : `DELETE FROM "${table}"`)),
    env.USAGE.prepare('DELETE FROM work_group_moves'),
  ]);
}

async function rejection(call: Promise<unknown>): Promise<ControlError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof ControlError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

beforeEach(async () => {
  core = coreFixture();
  calls = [];
  await clearD1();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the store switch per group', () => {
  it('follows WORK_STORE until a group var says d1', () => {
    for (const group of WORK_GROUPS) expect(groupStore(coreEnv, group)).toBe('core');
    expect(groupStore(subjectsOnD1, 'subjects')).toBe('d1');
    expect(groupStore(subjectsOnD1, 'tasks')).toBe('core');
    // Only the exact `d1` moves a group.
    expect(groupStore({ ...coreEnv, WORK_STORE_SUBJECTS: 'D1' } as Env, 'subjects')).toBe('core');
    // A D1 workspace is D1 for every group, whatever a var says.
    const d1Workspace = { ...env, WORK_STORE: 'd1', WORK_STORE_TASKS: 'core' } as Env;
    for (const group of WORK_GROUPS) expect(groupStore(d1Workspace, group)).toBe('d1');
  });

  it('routes a subject kind to the subjects group, and an event to the workspace', () => {
    expect(usesCoreForKind(subjectsOnD1, 'project')).toBe(false);
    expect(usesCoreForKind(subjectsOnD1, 'organization')).toBe(false);
    expect(usesCoreForKind(subjectsOnD1, 'event')).toBe(true);
    expect(usesCoreFor(subjectsOnD1, 'goals')).toBe(true);
  });

  it('reads a moved group from D1 and a group still on Core from Core', async () => {
    mockCore((url) => (url.pathname === '/api/public/meet-crm-goals' ? coreAnswer({ goals: [] }) : coreAnswer({}, 404)));
    await env.USAGE.prepare(
      `INSERT INTO projects (id, title, status, created_at, updated_at) VALUES (?1, 'In D1', 'Active', 1, 1)`,
    ).bind(PROJECT).run();
    const { subjects } = await fetchCrmSubjects(subjectsOnD1, 'project', '', 'all');
    expect(subjects.map((subject) => subject.title)).toEqual(['In D1']);
    expect(calls).toEqual([]);
    await fetchCrmGoals(subjectsOnD1, PROJECT);
    expect(calls).toEqual(['GET /api/public/meet-crm-goals']);
  });
});

describe('the write freeze', () => {
  it('refuses writes to the frozen group with 503 records_moving, and keeps reads', async () => {
    mockCore((url, method) => {
      if (url.pathname === '/api/public/meet-crm-subjects' && method === 'GET') return coreAnswer({ ok: true, subjects: [], has_more: false });
      if (url.pathname === '/api/public/meet-crm-goals' && method === 'POST') {
        return coreAnswer({ goal: { id: 'ad000000-0000-4000-8000-000000000001', project_id: PROJECT, title: 'Ship', status: 'open', target_date: null, owner: null, owner_name: null, owner_email: null, created_by: null, created_by_email: null, created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z' } });
      }
      return coreAnswer({}, 404);
    });
    await freezeGroup(coreEnv, 'subjects');

    const refused = await rejection(createCrmSubject(coreEnv, { kind: 'lead', title: 'New' }, 'rosa@example.com'));
    expect(refused.status).toBe(503);
    expect(refused.code).toBe('records_moving');
    // The refusal is before any request: the write reached neither store.
    expect(calls).toEqual([]);

    // Reads still answer.
    await fetchCrmSubjects(coreEnv, 'lead', '');
    expect(calls).toEqual(['GET /api/public/meet-crm-subjects']);

    // Another group is not frozen.
    await createCrmGoal(coreEnv, { project_id: PROJECT, title: 'Ship', actor_email: 'rosa@example.com' });
    expect(calls.at(-1)).toBe('POST /api/public/meet-crm-goals');

    await unfreezeGroup(coreEnv, 'subjects');
    const after = await rejection(createCrmSubject(coreEnv, { kind: 'lead', title: 'New' }, 'rosa@example.com'));
    // Unfrozen, the write goes to Core (which answers 404 here).
    expect(after.code).not.toBe('records_moving');
  });

  it('is set and read through the admin route', async () => {
    const context = createExecutionContext();
    const signIn = await worker.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: 'rosa@example.com' }),
    }), coreEnv, context);
    const { access_token: token } = await signIn.json<{ access_token: string }>();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: env.WEB_ORIGIN };
    const frozen = await worker.fetch(new Request('http://local/api/admin/work-groups', {
      method: 'POST', headers, body: JSON.stringify({ action: 'freeze', group: 'tasks' }),
    }), coreEnv, context);
    expect(frozen.status).toBe(200);
    expect(await frozen.json<WorkGroupMoveResponse>()).toMatchObject({ group: 'tasks', action: 'freeze', frozen: true, store: 'core' });
    const status = await worker.fetch(new Request('http://local/api/admin/work-groups', { headers }), coreEnv, context);
    const body = await status.json<WorkGroupStatus>();
    expect(body.groups.find((group) => group.group === 'tasks')?.frozen).toBe(true);
    expect(body.groups.find((group) => group.group === 'subjects')?.frozen).toBe(false);
    await waitOnExecutionContext(context);
  });
});

describe('copy and verify', () => {
  it('copies the subjects group into D1 and verifies it', async () => {
    mockCore();
    await freezeGroup(coreEnv, 'subjects');
    const copy = await copyGroup(coreEnv, 'subjects');
    expect(copy.next).toBeNull();
    expect(copy.copied).toEqual({
      lead_characteristics_config: 1, contact_characteristics_config: 1, contact_source_definitions: 4,
      organizations: 2, contacts: 1, contact_source_events: 1, leads: 2, projects: 2, project_contacts: 1, record_merges: 0,
    });

    const verify = await verifyGroup(coreEnv, 'subjects');
    expect(verify.ok).toBe(true);
    expect(verify.tables.map((table) => [table.table, table.core_rows, table.d1_rows, table.match])).toEqual([
      ['lead_characteristics_config', 1, 1, true],
      ['contact_characteristics_config', 1, 1, true],
      ['contact_source_definitions', 4, 4, true],
      ['organizations', 2, 2, true],
      ['contacts', 1, 1, true],
      ['contact_source_events', 1, 1, true],
      ['leads', 2, 2, true],
      ['projects', 2, 2, true],
      ['project_contacts', 1, 1, true],
    ]);
    expect(verify.tables.find((table) => table.table === 'project_contacts')?.collapsed).toBe(1);

    // D1's types: epoch ms and 0/1, the wire's ISO strings on the way out.
    const acme = await env.USAGE.prepare('SELECT * FROM organizations WHERE id = ?1').bind(ORG).first<Record<string, unknown>>();
    expect(acme).toMatchObject({ name: 'Acme', is_partner: 0, url: 'https://acme.test', logo_url: 'https://acme.test/logo.png', created_at: Date.parse('2025-01-02T03:04:05.678Z') });
    // A lead and a project with one id both land (ADR 0008).
    expect(await env.USAGE.prepare('SELECT title FROM leads WHERE id = ?1').bind(SHARED_ID).first('title')).toBe('');
    expect(await env.USAGE.prepare('SELECT internal FROM projects WHERE id = ?1').bind(SHARED_ID).first('internal')).toBe(1);

    // After the flip, Meet reads the copied rows from D1, without Core.
    calls = [];
    const { subjects } = await fetchCrmSubjects(subjectsOnD1, 'project', '', 'all');
    expect(subjects.map((subject) => subject.id).sort()).toEqual([PROJECT, SHARED_ID].sort());
    expect(calls).toEqual([]);

    // The copy is idempotent: a second run writes the same rows.
    await copyGroup(coreEnv, 'subjects');
    expect((await verifyGroup(coreEnv, 'subjects')).ok).toBe(true);
  });

  it('refuses a copy before the freeze, and after the flip', async () => {
    mockCore();
    expect((await rejection(copyGroup(coreEnv, 'subjects'))).message).toMatch(/Freeze the subjects group/u);
    await freezeGroup(coreEnv, 'subjects');
    expect((await rejection(copyGroup(subjectsOnD1, 'subjects'))).message).toMatch(/answers from D1 already/u);
    expect(calls).toEqual([]);
  });

  it('refuses a move on a D1 workspace', async () => {
    const d1Workspace = { ...env, WORK_STORE: 'd1' } as Env;
    expect((await rejection(freezeGroup(d1Workspace, 'subjects'))).status).toBe(409);
  });

  it('detects a mismatch, and diff names the rows', async () => {
    mockCore();
    await freezeGroup(coreEnv, 'subjects');
    await copyGroup(coreEnv, 'subjects');

    // A changed value with the same row count.
    await env.USAGE.prepare("UPDATE projects SET title = 'Edited in D1' WHERE id = ?1").bind(PROJECT).run();
    const changed = await verifyGroup(coreEnv, 'subjects');
    expect(changed.ok).toBe(false);
    const projects = changed.tables.find((table) => table.table === 'projects')!;
    expect(projects).toMatchObject({ core_rows: 2, d1_rows: 2, match: false });
    expect(projects.core_sha256).not.toBe(projects.d1_sha256);
    expect(changed.tables.filter((table) => !table.match).map((table) => table.table)).toEqual(['projects']);

    // A row Core has and D1 does not.
    core.contacts!.push({ id: '0c000000-0000-4000-8000-000000000002', organization_id: ORG, name: 'Bo', created_at: '2025-01-04T00:00:00+00:00' });
    const missing = await verifyGroup(coreEnv, 'subjects', 'contacts');
    expect(missing.tables).toMatchObject([{ table: 'contacts', core_rows: 2, d1_rows: 1, match: false }]);

    const diff = await diffGroup(coreEnv, 'subjects');
    expect(diff.find((table) => table.table === 'projects')?.added_or_changed.map((row) => row.title)).toEqual(['Edited in D1']);
    expect(diff.find((table) => table.table === 'contacts')?.removed).toEqual(['0c000000-0000-4000-8000-000000000002']);
    expect(diff.find((table) => table.table === 'organizations')).toEqual({ table: 'organizations', added_or_changed: [], removed: [] });

    const status = await env.USAGE.prepare("SELECT verified_ok FROM work_group_moves WHERE work_group = 'subjects'").first('verified_ok');
    expect(status).toBe(0);
  });
});

describe('every Core column of organizations and contacts (meet#1209)', () => {
  it('copies each kept column, and the verify fails when any one of them differs', async () => {
    mockCore();
    await freezeGroup(coreEnv, 'subjects');
    await copyGroup(coreEnv, 'subjects');
    expect((await verifyGroup(coreEnv, 'subjects')).ok).toBe(true);

    const acme = await env.USAGE.prepare('SELECT * FROM organizations WHERE id = ?1').bind(ORG).first<Record<string, unknown>>();
    expect(acme).toMatchObject({ legal_name: 'Acme BV', city: 'Amsterdam', country: 'NL', is_agency: 1, is_existing_client: 1, domain: 'acme.test' });
    const ana = await env.USAGE.prepare('SELECT * FROM contacts WHERE id = ?1').bind(CONTACT).first<Record<string, unknown>>();
    expect(ana).toMatchObject({
      title: 'CTO', phone: '+31 20 000 0000', country: 'NL', preferred_language: 'pt', birthday_month: 12, futurist: 1, media: 0,
      // Keys sorted, whatever order Core sent.
      characteristics: '{"newsletter_subscriber":false,"speaker":true}',
      signals_notified_at: Date.parse('2025-05-01T00:00:00Z'),
    });

    for (const [table, id] of [['organizations', ORG], ['contacts', CONTACT]] as const) {
      const spec = TABLE_SPECS[table]!;
      for (const column of spec.columns.filter((name) => !spec.key.includes(name))) {
        const before = await env.USAGE.prepare(`SELECT "${column}" AS value FROM ${table} WHERE id = ?1`).bind(id).first('value');
        // A value of the column's own type that differs from the copied one.
        const other = column === 'organization_id' ? PARTNER : typeof before === 'number' ? before + 1 : `${String(before ?? '')}-changed`;
        await env.USAGE.prepare(`UPDATE ${table} SET "${column}" = ?1 WHERE id = ?2`).bind(other, id).run();
        const verify = await verifyGroup(coreEnv, 'subjects', table);
        expect(verify.ok, `${table}.${column}`).toBe(false);
        await env.USAGE.prepare(`UPDATE ${table} SET "${column}" = ?1 WHERE id = ?2`).bind(before, id).run();
      }
      expect((await verifyGroup(coreEnv, 'subjects', table)).ok, table).toBe(true);
    }
  });
});

describe('the settings tables of the subjects group (meet#1228)', () => {
  it('copies the characteristics and sources, and verifies them', async () => {
    mockCore();
    await freezeGroup(coreEnv, 'subjects');
    const { copied } = await copyGroup(coreEnv, 'subjects');
    expect(copied).toMatchObject({
      lead_characteristics_config: 1, contact_characteristics_config: 1, contact_source_definitions: 4,
      contact_source_events: 1,
    });
    expect((await verifyGroup(coreEnv, 'subjects')).ok).toBe(true);
    expect(await env.USAGE.prepare('SELECT source_key, metadata FROM contact_source_events').first()).toEqual({
      source_key: 'substack', metadata: '{"original_source":"substack-import","subscriber_status":"active"}',
    });
    await env.USAGE.prepare("UPDATE contact_source_definitions SET label = 'Changed' WHERE key = 'substack'").run();
    expect((await verifyGroup(coreEnv, 'subjects', 'contact_source_definitions')).ok).toBe(false);
    // Currencies and rates move with the commercial group (meet#1229): the subjects copy leaves them in Core.
    expect(copied).not.toHaveProperty('currency_settings');
  });
});

describe('Core merge aliases (meet#1216)', () => {
  it('copies each alias into record_merges, so a merged Core id opens its survivor on D1', async () => {
    const OLD_ORG = '0a000000-0000-4000-8000-0000000000aa';
    const OLD_CONTACT = '0c000000-0000-4000-8000-0000000000aa';
    core.organization_merge_aliases = [{ old_organization_id: OLD_ORG, survivor_id: ORG, merge_audit_id: 'audit-1', created_at: '2025-06-01T00:00:00+00:00' }];
    core.contact_merge_aliases = [{ old_contact_id: OLD_CONTACT, survivor_id: CONTACT, merge_audit_id: 'audit-2', created_at: '2025-06-02T00:00:00+00:00' }];
    mockCore();
    await freezeGroup(coreEnv, 'subjects');
    expect((await copyGroup(coreEnv, 'subjects')).copied.record_merges).toBe(2);
    const { results } = await env.USAGE.prepare('SELECT entity, from_id, into_id, merged_at FROM record_merges ORDER BY entity').all();
    expect(results).toEqual([
      { entity: 'contacts', from_id: OLD_CONTACT, into_id: CONTACT, merged_at: Date.parse('2025-06-02T00:00:00Z') },
      { entity: 'organizations', from_id: OLD_ORG, into_id: ORG, merged_at: Date.parse('2025-06-01T00:00:00Z') },
    ]);
    // After the flip, the old ids answer the survivors and say so.
    calls = [];
    expect(await fetchCrmSubjectDetail(subjectsOnD1, 'organization', OLD_ORG)).toMatchObject({ id: ORG, title: 'Acme', merged_from: OLD_ORG });
    expect(await fetchCrmContactDetail(subjectsOnD1, 'rosa@example.com', OLD_CONTACT)).toMatchObject({ id: CONTACT, name: 'Ana', merged_from: OLD_CONTACT });
    expect(await fetchCrmSubjectDetail(subjectsOnD1, 'organization', ORG)).not.toHaveProperty('merged_from');
    expect(calls).toEqual([]);
    // A second copy writes the same aliases again.
    expect((await copyGroup(coreEnv, 'subjects')).copied.record_merges).toBe(2);
    await env.USAGE.prepare('DELETE FROM record_merges').run();
  });
});

describe('the foreign-key order', () => {
  it('lists every parent table before its children, in the group or an earlier one', async () => {
    const order = WORK_GROUPS.flatMap((group) => WORK_GROUP_TABLES[group]);
    for (const [index, table] of order.entries()) {
      const { results } = await env.USAGE.prepare(`PRAGMA foreign_key_list("${table}")`).all<{ table: string }>();
      for (const parent of results.map((row) => row.table)) {
        expect(order.indexOf(parent), `${table} references ${parent}`).toBeGreaterThanOrEqual(0);
        expect(order.indexOf(parent), `${table} references ${parent}`).toBeLessThan(index);
      }
    }
    // Every table the groups name has a copy spec, and every spec's columns exist in D1.
    for (const table of order) {
      const { results } = await env.USAGE.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>();
      const columns = new Set(results.map((row) => row.name));
      for (const column of TABLE_SPECS[table]!.columns) expect(columns.has(column), `${table}.${column}`).toBe(true);
    }
  });

  it('refuses a child group copied before its parent group', async () => {
    mockCore();
    // Milestones reference projects, which are not in D1 yet: D1's foreign key refuses the copy.
    await freezeGroup(coreEnv, 'tasks');
    await expect(copyGroup(coreEnv, 'tasks')).rejects.toThrow(/FOREIGN KEY/u);
    expect(await env.USAGE.prepare('SELECT COUNT(*) AS n FROM milestones').first('n')).toBe(0);

    // In order, it lands.
    await freezeGroup(coreEnv, 'subjects');
    await copyGroup(coreEnv, 'subjects');
    expect((await copyGroup(coreEnv, 'tasks')).copied).toEqual({ milestones: 1, tasks: 0 });
    expect((await verifyGroup(coreEnv, 'tasks')).ok).toBe(true);
  });

  it('copies every milestone column the public project page shows (meet#1222)', async () => {
    mockCore();
    await freezeGroup(coreEnv, 'subjects');
    await copyGroup(coreEnv, 'subjects');
    await freezeGroup(coreEnv, 'tasks');
    await copyGroup(coreEnv, 'tasks');
    expect(await env.USAGE.prepare('SELECT title, due_at, notes, place, location, start_time, timezone, start_at FROM milestones').first()).toEqual({
      title: 'Kickoff', due_at: Date.parse('2025-06-01'), notes: 'Bring the deck.', place: 'Studio', location: 'Amsterdam',
      start_time: '09:30:00', timezone: 'Europe/Amsterdam', start_at: Date.parse('2025-06-01T07:30:00+00:00'),
    });
    // A changed place is a mismatch the verify names.
    await env.USAGE.prepare(`UPDATE milestones SET place = 'Office'`).run();
    const verify = await verifyGroup(coreEnv, 'tasks');
    expect(verify.ok).toBe(false);
    expect(verify.tables.find((report) => report.table === 'milestones')?.match).toBe(false);
  });

  it('copies a task on an event, a Signals account and a contact, with its tags (meet#1201)', async () => {
    const EVENT = 'e0000000-0000-4000-8000-000000000001';
    const ACCOUNT = '5a000000-0000-4000-8000-0000000000aa';
    const base = { status: 'pending', responsible_party: 'team', created_at: '2026-10-01T00:00:00+00:00', updated_at: '2026-10-02T00:00:00+00:00' };
    core.tasks = [
      { ...base, id: 'ac000000-0000-4000-8000-000000000001', title: 'Book the venue', event_id: EVENT, tags: ['venue', 'ops'] },
      // Core echoes the account's organization on a Signals task: it is not a partner's own task.
      { ...base, id: 'ac000000-0000-4000-8000-000000000002', title: 'Send the scan', signals_account_id: ACCOUNT, organization_id: PARTNER, tags: [] },
      { ...base, id: 'ac000000-0000-4000-8000-000000000003', title: 'Call Ana', organization_id: PARTNER, contact_id: CONTACT },
    ];
    mockCore();
    await freezeGroup(coreEnv, 'subjects');
    await copyGroup(coreEnv, 'subjects');
    await freezeGroup(coreEnv, 'tasks');
    expect((await copyGroup(coreEnv, 'tasks')).copied).toEqual({ milestones: 1, tasks: 3 });
    const verified = await verifyGroup(coreEnv, 'tasks');
    expect(verified.ok).toBe(true);
    expect(verified.tables.find((report) => report.table === 'tasks')?.unknown_assignees).toBe(0);
    const stored = await env.USAGE.prepare('SELECT event_id, signals_account_id, contact_id, tags FROM tasks ORDER BY id').all();
    expect(stored.results).toEqual([
      { event_id: EVENT, signals_account_id: null, contact_id: null, tags: '["venue","ops"]' },
      { event_id: null, signals_account_id: ACCOUNT, contact_id: null, tags: null },
      { event_id: null, signals_account_id: null, contact_id: CONTACT, tags: null },
    ]);

    // A changed tag is a mismatch the verify names.
    await env.USAGE.prepare(`UPDATE tasks SET tags = '["venue"]' WHERE event_id = ?1`).bind(EVENT).run();
    expect((await verifyGroup(coreEnv, 'tasks')).ok).toBe(false);
    await copyGroup(coreEnv, 'tasks');

    // After the flip, each place reads its task from D1, without Core.
    const tasksOnD1 = { ...subjectsOnD1, WORK_STORE_TASKS: 'd1' } as Env;
    calls = [];
    expect((await fetchCrmTasks(tasksOnD1, { eventId: EVENT })).map((task) => [task.title, task.event_id, task.tags])).toEqual([['Book the venue', EVENT, ['venue', 'ops']]]);
    expect((await fetchCrmTasks(tasksOnD1, { signalsAccountId: ACCOUNT })).map((task) => task.signals_account_id)).toEqual([ACCOUNT]);
    expect((await fetchCrmTasks(tasksOnD1, { organizationId: PARTNER })).map((task) => [task.title, task.contact_id])).toEqual([['Call Ana', CONTACT]]);
    expect((await fetchCrmPartnerTasks(tasksOnD1)).map((task) => task.title)).toEqual(['Call Ana']);
    expect(calls).toEqual([]);

    // A new task on an event or a Signals account lands in D1, and a move clears the place it left.
    await unfreezeGroup(coreEnv, 'tasks');
    const created = await createCrmTask(tasksOnD1, { title: 'Print badges', event_id: EVENT });
    expect(created).toMatchObject({ event_id: EVENT, signals_account_id: null, project_id: null });
    expect(await createCrmTask(tasksOnD1, { title: 'Rescan', signals_account_id: ACCOUNT })).toMatchObject({ signals_account_id: ACCOUNT, event_id: null });
    expect(await updateCrmTask(tasksOnD1, created.id, { organization_id: PARTNER })).toMatchObject({ event_id: null, organization_id: PARTNER });
    // A write keeps the columns it does not name.
    await updateCrmTask(tasksOnD1, 'ac000000-0000-4000-8000-000000000001', { title: 'Book the hall' });
    expect(await fetchCrmTask(tasksOnD1, 'ac000000-0000-4000-8000-000000000001')).toMatchObject({ title: 'Book the hall', event_id: EVENT, tags: ['venue', 'ops'] });
    expect(calls).toEqual([]);
  });

  it('leaves empty hosted sessions and their junction rows out of the copy, the verify and the diff', async () => {
    const EMPTY = 'a1000000-0000-4000-8000-0000000000e1';
    const LONG = 'a1000000-0000-4000-8000-0000000000e2';
    const NOTE = 'Hosted Envisioning Meet session in /mz.\nParticipants: Rosa.\nNo finalized transcript segments.\nAudio and video were not recorded.';
    const session = { type: 'meeting', source: 'meet_envisioning', occurred_at: '2026-10-02T09:00:00+00:00', created_at: '2026-10-02T09:00:00+00:00', tags: [], description: NOTE };
    core.interactions = [
      { ...session, id: EMPTY, title: 'Meet — mz', external_id: 'mtg-e', metadata: { duration_minutes: 0 } },
      // A long session with no transcript was a real call. It moves.
      { ...session, id: LONG, title: 'Meet — mz', external_id: 'mtg-l', metadata: { duration_minutes: 66 } },
    ];
    core.interaction_subjects = [];
    core.interaction_contacts = [{ interaction_id: EMPTY, contact_id: CONTACT }, { interaction_id: LONG, contact_id: CONTACT }];
    core.partner_agreement_signatures = [];
    mockCore();
    await freezeGroup(coreEnv, 'subjects');
    await copyGroup(coreEnv, 'subjects');
    await freezeGroup(coreEnv, 'interactions');
    expect((await copyGroup(coreEnv, 'interactions')).copied).toEqual({ interactions: 1, interaction_subjects: 0, interaction_contacts: 1, partner_agreement_signatures: 0 });
    const verify = await verifyGroup(coreEnv, 'interactions');
    expect(verify.ok).toBe(true);
    expect(verify.tables.find((table) => table.table === 'interactions')?.core_rows).toBe(1);
    expect(await env.USAGE.prepare('SELECT id FROM interactions').all()).toMatchObject({ results: [{ id: LONG }] });
    for (const table of await diffGroup(coreEnv, 'interactions')) expect(table.removed).toEqual([]);
  });

  it('keeps a session with a transcript, an organization or another source', () => {
    const empty = { source: 'meet_envisioning', description: 'No finalized transcript segments.', metadata: { duration_minutes: 1 } };
    expect(isEmptySession(empty)).toBe(true);
    expect(isEmptySession({ ...empty, source: 'granola' })).toBe(false);
    expect(isEmptySession({ ...empty, organization_id: 'o1' })).toBe(false);
    expect(isEmptySession({ ...empty, description: 'Transcript: 359 finalized segments.' })).toBe(false);
    expect(isEmptySession({ ...empty, metadata: { transcript_document_id: 'd1' } })).toBe(false);
    expect(isEmptySession({ ...empty, metadata: { duration_minutes: 5 } })).toBe(false);
  });

  it('copies an interaction with its description, tags, metadata, Signals account and contacts (meet#1202)', async () => {
    const NOTE = 'a1000000-0000-4000-8000-000000000001';
    const CALL = 'a1000000-0000-4000-8000-000000000002';
    const ACCOUNT = '5a000000-0000-4000-8000-0000000000aa';
    core.interactions = [
      {
        id: NOTE, type: 'note', title: 'Pricing email', source: 'manual', occurred_at: '2026-10-01T10:00:00+00:00',
        created_at: '2026-10-01T10:00:00+00:00', description: 'They asked for the annual price.', tags: ['pricing'],
        metadata: { thread: { b: 2, a: 1 }, gmail_id: 'g-1' }, signals_account_id: ACCOUNT,
      },
      {
        id: CALL, type: 'meeting', title: 'Kickoff', source: 'meet_envisioning', external_id: 'mtg-1', occurred_at: '2026-10-02T09:00:00+00:00',
        created_at: '2026-10-02T09:00:00+00:00', description: 'Booked from the site.', tags: [], metadata: {},
      },
    ];
    core.interaction_subjects = [
      { interaction_id: NOTE, subject_kind: 'project', subject_id: PROJECT },
      { interaction_id: CALL, subject_kind: 'project', subject_id: PROJECT },
    ];
    core.interaction_contacts = [
      { interaction_id: NOTE, contact_id: CONTACT },
      // A duplicate junction row: one D1 row.
      { interaction_id: NOTE, contact_id: CONTACT },
    ];
    core.partner_agreement_signatures = [];
    mockCore();
    await freezeGroup(coreEnv, 'subjects');
    await copyGroup(coreEnv, 'subjects');
    await freezeGroup(coreEnv, 'interactions');
    expect((await copyGroup(coreEnv, 'interactions')).copied).toEqual({ interactions: 2, interaction_subjects: 2, interaction_contacts: 1, partner_agreement_signatures: 0 });
    const verify = await verifyGroup(coreEnv, 'interactions');
    expect(verify.ok).toBe(true);
    expect(verify.tables.find((table) => table.table === 'interaction_contacts')?.collapsed).toBe(1);
    expect(await env.USAGE.prepare('SELECT description, tags, metadata, signals_account_id FROM interactions WHERE id = ?1').bind(NOTE).first()).toEqual({
      description: 'They asked for the annual price.',
      tags: '["pricing"]',
      metadata: '{"gmail_id":"g-1","thread":{"a":1,"b":2}}',
      signals_account_id: ACCOUNT,
    });

    // A changed description is a mismatch the verify names.
    await env.USAGE.prepare("UPDATE interactions SET description = 'Edited' WHERE id = ?1").bind(NOTE).run();
    expect((await verifyGroup(coreEnv, 'interactions', 'interactions')).ok).toBe(false);
    await copyGroup(coreEnv, 'interactions');

    // After the flip, the History reads it from D1: the description stands in for a missing summary.
    const interactionsOnD1 = { ...subjectsOnD1, WORK_STORE_TASKS: 'd1', WORK_STORE_GOALS: 'd1', WORK_STORE_INTERACTIONS: 'd1' } as Env;
    calls = [];
    const history = await fetchCrmInteractions(interactionsOnD1, { projectId: PROJECT });
    expect(history.find((row) => row.id === NOTE)).toMatchObject({
      summary_markdown: 'They asked for the annual price.', description: 'They asked for the annual price.', tags: ['pricing'],
      signals_account_id: ACCOUNT, contacts: [{ id: CONTACT, name: 'Ana', email: 'ana@acme.test' }],
    });

    // A meeting-log redelivery onto a copied call keeps what the log does not write.
    await unfreezeGroup(coreEnv, 'interactions');
    await postMeetingLog(interactionsOnD1, {
      phase: 'ended', meeting_id: 'mtg-1', room_slug: 'rosa', host_email: 'rosa@example.com', source: 'meet_envisioning',
      started_at: '2026-10-02T09:00:00.000Z', ended_at: '2026-10-02T09:30:00.000Z', title: 'Kickoff', summary_markdown: '## Summary',
      transcript: [], participants: [], booking_token: null, permalink: 'https://envisioning.starlings.example/room/rosa',
      meeting_kind: 'project', lead_id: null, project_id: PROJECT, partner_organization_id: null, categorized_by: 'rosa@example.com',
      transcript_document_id: null, transcript_url: null,
    });
    expect(await env.USAGE.prepare('SELECT summary_markdown, description FROM interactions WHERE id = ?1').bind(CALL).first())
      .toEqual({ summary_markdown: '## Summary', description: 'Booked from the site.' });
    expect(calls).toEqual([]);
  });

  it('copies every Core interaction column, the junction columns and partner agreements (meet#1223)', async () => {
    const ROW = 'a1000000-0000-4000-8000-000000000011';
    const MINE = 'a1000000-0000-4000-8000-000000000012';
    const ACCOUNT = '5a000000-0000-4000-8000-0000000000ab';
    const EVALUATION = '5e000000-0000-4000-8000-0000000000ab';
    const EVENT = 'e0000000-0000-4000-8000-0000000000ab';
    core.interactions = [
      {
        id: ROW, type: 'meeting', title: 'Signals demo', source: 'meet_envisioning', external_id: 'mtg-9', occurred_at: '2026-10-03T09:00:00+00:00',
        created_at: '2026-10-03T09:00:00+00:00', updated_at: '2026-10-03T10:00:00+00:00', description: null, tags: ['demo'],
        metadata: { meeting_kind: 'partner', transcript_document_id: 'doc-9', ended_at: '2026-10-03T09:45:00+00:00' },
        project_id: PROJECT, lead_id: LEAD, event_id: EVENT, organization_id: PARTNER, contact_id: CONTACT,
        created_by: 'b0000000-0000-4000-8000-000000000001', url: 'https://example.test/r', gmail_email_id: 'gm-1', channel: 'meet',
        status: 'logged', summary_markdown: '## Demo', transcript_url: 'https://docs.test/t', transcript_preview: 'Hello',
        support_case_id: null, search_vector: "'demo':1", is_personal: false, owner_email: null, interaction_kind: 'signals_demo',
        signals_account_id: ACCOUNT, signals_evaluation_id: EVALUATION,
      },
      {
        id: MINE, type: 'meeting', title: 'Dentist', source: 'granola', external_id: 'not_9', occurred_at: '2026-10-04T09:00:00+00:00',
        created_at: '2026-10-04T09:00:00+00:00', is_personal: true, owner_email: 'rosa@example.com', metadata: { meeting_kind: 'personal' },
      },
    ];
    core.interaction_subjects = [
      { id: 's-1', interaction_id: ROW, subject_kind: 'lead', subject_id: LEAD, is_primary: true, source: 'mirror', created_at: '2026-10-03T09:00:00+00:00', created_by: null, via_contact_id: null },
      { id: 's-2', interaction_id: ROW, subject_kind: 'project', subject_id: PROJECT, is_primary: false, source: 'mirror', created_at: '2026-10-03T09:00:00+00:00' },
      { id: 's-3', interaction_id: ROW, subject_kind: 'event', subject_id: EVENT, is_primary: false, source: 'mirror', created_at: '2026-10-03T09:00:00+00:00' },
      { id: 's-4', interaction_id: ROW, subject_kind: 'partner', subject_id: PARTNER, is_primary: false, source: 'auto', created_at: '2026-10-03T09:00:00+00:00', via_contact_id: CONTACT },
    ];
    core.interaction_contacts = [{ id: 'ic-1', interaction_id: ROW, contact_id: CONTACT, created_at: '2026-10-03T09:01:00+00:00' }];
    core.partner_agreement_signatures = [{
      id: 'pa000000-0000-4000-8000-000000000001', agreement_id: 'partners-2026', contact_id: CONTACT, signer_name: 'Ana', signer_email: 'ana@acme.test',
      signing_for: 'both', organization_name: 'Acme', signed_at: '2026-09-01T10:00:00+00:00', metadata: { ip: '192.0.2.1', source: 'public-partner-agreement' },
      created_at: '2026-09-01T10:00:00+00:00', updated_at: '2026-09-01T10:00:00+00:00',
    }];
    mockCore();
    await freezeGroup(coreEnv, 'subjects');
    await copyGroup(coreEnv, 'subjects');
    await freezeGroup(coreEnv, 'interactions');
    expect((await copyGroup(coreEnv, 'interactions')).copied).toEqual({ interactions: 2, interaction_subjects: 4, interaction_contacts: 1, partner_agreement_signatures: 1 });
    expect((await verifyGroup(coreEnv, 'interactions')).ok).toBe(true);
    expect(await env.USAGE.prepare(
      `SELECT organization_id, contact_id, is_personal, interaction_kind, gmail_email_id, signals_evaluation_id, meeting_kind,
              transcript_document_id, ended_at, host_person_id FROM interactions WHERE id = ?1`,
    ).bind(ROW).first()).toEqual({
      organization_id: PARTNER, contact_id: CONTACT, is_personal: 0, interaction_kind: 'signals_demo', gmail_email_id: 'gm-1',
      signals_evaluation_id: EVALUATION, meeting_kind: 'partner', transcript_document_id: 'doc-9',
      ended_at: Date.parse('2026-10-03T09:45:00+00:00'), host_person_id: 'b0000000-0000-4000-8000-000000000001',
    });
    expect(await env.USAGE.prepare("SELECT subject_kind, is_primary, source, via_contact_id FROM interaction_subjects WHERE interaction_id = ?1 ORDER BY subject_kind").bind(ROW).all())
      .toMatchObject({ results: [
        { subject_kind: 'event', is_primary: 0, source: 'mirror', via_contact_id: null },
        { subject_kind: 'lead', is_primary: 1, source: 'mirror', via_contact_id: null },
        { subject_kind: 'organization', is_primary: 0, source: 'auto', via_contact_id: CONTACT },
        { subject_kind: 'project', is_primary: 0, source: 'mirror', via_contact_id: null },
      ] });
    expect(await env.USAGE.prepare('SELECT signing_for, metadata FROM partner_agreement_signatures').first())
      .toEqual({ signing_for: 'both', metadata: '{"ip":"192.0.2.1","source":"public-partner-agreement"}' });

    // A column the copy carries is a column the verify compares.
    await env.USAGE.prepare("UPDATE interactions SET interaction_kind = NULL WHERE id = ?1").bind(ROW).run();
    expect((await verifyGroup(coreEnv, 'interactions', 'interactions')).ok).toBe(false);
    await env.USAGE.prepare("UPDATE partner_agreement_signatures SET signing_for = 'individual'").run();
    expect((await verifyGroup(coreEnv, 'interactions', 'partner_agreement_signatures')).ok).toBe(false);

    // After the flip, the personal row is in no History.
    const interactionsOnD1 = { ...subjectsOnD1, WORK_STORE_TASKS: 'd1', WORK_STORE_GOALS: 'd1', WORK_STORE_INTERACTIONS: 'd1' } as Env;
    expect((await fetchCrmInteractions(interactionsOnD1, { organizationId: PARTNER })).map((row) => row.id)).toEqual([ROW]);
    expect(await env.USAGE.prepare('SELECT is_personal, owner_email FROM interactions WHERE id = ?1').bind(MINE).first())
      .toEqual({ is_personal: 1, owner_email: 'rosa@example.com' });
  });

  it('resumes a copy at the table and offset it stopped at', async () => {
    mockCore();
    await freezeGroup(coreEnv, 'subjects');
    await copyGroup(coreEnv, 'subjects', { table: 'lead_characteristics_config', offset: 0 });
    await env.USAGE.prepare('DELETE FROM project_contacts').run();
    const resumed = await copyGroup(coreEnv, 'subjects', { table: 'project_contacts', offset: 0 });
    expect(resumed).toEqual({ copied: { project_contacts: 1, record_merges: 0 }, next: null });
  });
});
