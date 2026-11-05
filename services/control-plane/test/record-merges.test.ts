// Merges of organizations, contacts and leads over D1 (meet#1203,
// docs/CORE_FOLD_PLAN.md Phase 4): the switch between Core's merge and the
// Worker's, every link moved in one batch, the freeze, and a later group's
// copy that maps a merged id to its survivor.
//
// The pool's env is Envisioning, a WORK_STORE=core workspace. `subjectsOnD1`
// is the same workspace after the `subjects` flip. Core is a fake: `fetch`
// answers the export route and Core's merge route. Nothing leaves the test.
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORK_GROUPS, WORK_GROUP_TABLES } from '@starlings/contracts';
import worker from '../src/index';
import { mergeCoreRecords, resetCorePatCache } from '../src/crm';
import { ControlError } from '../src/errors';
import { MERGE_COLUMNS, MERGE_PAIRS, SUBJECT_REFERENCES } from '../src/record-merges';
import { copyGroup, freezeGroup, remapMerged, runWorkGroupMove, unfreezeGroup, verifyGroup } from '../src/work-group-moves';

const SECRET = 'meet-core-shared-secret-at-least-32-chars';
const coreEnv = { ...env, INTERNAL_REQUEST_SECRET: SECRET, CRM_SYNC_MODE: 'on' } as Env;
const subjectsOnD1 = { ...coreEnv, WORK_STORE_SUBJECTS: 'd1' } as Env;
const ACTOR = 'rosa@example.com';

const OLD_ORG = '0a000000-0000-4000-8000-000000000001';
const NEW_ORG = '0a000000-0000-4000-8000-000000000002';
const OLD_CONTACT = '0c000000-0000-4000-8000-000000000001';
const NEW_CONTACT = '0c000000-0000-4000-8000-000000000002';
const OLD_LEAD = '1e000000-0000-4000-8000-000000000001';
const NEW_LEAD = '1e000000-0000-4000-8000-000000000002';
const PROJECT = '9a000000-0000-4000-8000-000000000001';
const INTERACTION = 'a1000000-0000-4000-8000-000000000001';

let calls: string[] = [];
let repoints: Array<{ merges: Array<{ entity: string; into_id: string; from_ids: string[] }>; dry_run?: boolean }> = [];
let repointAnswer: ((body: { merges: Array<{ entity: string; into_id: string }>; dry_run?: boolean }) => Response) | null = null;
let core: Record<string, Array<Record<string, unknown>>> = {};

function mockCore(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.pathname}`);
    if (url.pathname === '/api/public/meet-fold-export') {
      const rows = core[url.searchParams.get('table') ?? ''] ?? [];
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return Response.json({ rows: rows.slice(offset, offset + 500), has_more: offset + 500 < rows.length });
    }
    if (url.pathname === '/api/public/meet-owner-exchange') {
      return Response.json({ ok: true, token: 'core_pat_merge', scopes: ['organizations:write'], expires_at: '2099-01-01T00:00:00.000Z', email: ACTOR });
    }
    if (url.pathname === '/api/public/meet-fold-merge-repoint') {
      const body = await request.clone().json() as { merges: Array<{ entity: string; into_id: string; from_ids: string[] }>; dry_run?: boolean };
      repoints.push(body);
      if (repointAnswer) return repointAnswer(body);
      return Response.json({ ok: true, results: body.merges.map((merge) => ({ entity: merge.entity, into_id: merge.into_id, ok: true, moved: 2 })) });
    }
    // Core's merge_organizations answer (core-web migrations/20260717_120000).
    return Response.json({ data: { survivorId: OLD_ORG, mergedOrganizationIds: [NEW_ORG] } });
  });
}

async function clearD1(): Promise<void> {
  const tables = [...WORK_GROUPS].reverse().flatMap((group) => [...WORK_GROUP_TABLES[group]].reverse());
  await env.USAGE.batch([
    env.USAGE.prepare('DELETE FROM contact_emails'),
    env.USAGE.prepare('DELETE FROM subject_grants'),
    env.USAGE.prepare('DELETE FROM subject_visibility'),
    env.USAGE.prepare('DELETE FROM peer_credentials'),
    // The sources migration 0132 seeds stay: a D1 contact write records one.
    ...tables.map((table) => env.USAGE.prepare(table === 'contact_source_definitions'
      ? `DELETE FROM contact_source_definitions WHERE key NOT IN ('crm_manual', 'agent_api', 'website_contact')`
      : `DELETE FROM "${table}"`)),
    env.USAGE.prepare('DELETE FROM work_group_moves'),
    env.USAGE.prepare('DELETE FROM record_merges'),
    env.USAGE.prepare("DELETE FROM ops_failures WHERE kind IN ('core_merge_repoint', 'signals_lead_ensure')"),
  ]);
}

/** Two of each, the older first, with links on the newer ones. */
async function seed(): Promise<void> {
  const run = (sql: string, ...binds: unknown[]) => env.USAGE.prepare(sql).bind(...binds);
  await env.USAGE.batch([
    run(`INSERT INTO organizations (id, name, is_partner, created_at, updated_at) VALUES (?1, 'Acme', 0, 1, 1), (?2, 'Acme BV', 1, 2, 2)`, OLD_ORG, NEW_ORG),
    run(`INSERT INTO contacts (id, organization_id, name, email, created_at, updated_at) VALUES (?1, ?3, 'Ana', 'ana@acme.test', 1, 1), (?2, ?4, 'Ana S', 'ana.s@acme.test', 2, 2)`, OLD_CONTACT, NEW_CONTACT, OLD_ORG, NEW_ORG),
    run(`INSERT INTO contact_emails (email, contact_id, created_at) VALUES ('ana@acme.test', ?1, 1)`, OLD_CONTACT),
    run(`INSERT INTO leads (id, organization_id, contact_id, title, status, created_at, updated_at) VALUES (?1, ?3, ?4, 'Pilot', 'Proposal', 1, 1), (?2, ?5, ?6, 'Pilot again', 'Proposal', 2, 2)`, OLD_LEAD, NEW_LEAD, OLD_ORG, OLD_CONTACT, NEW_ORG, NEW_CONTACT),
    run(`INSERT INTO projects (id, organization_id, lead_id, title, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'Radar', 'Active', 1, 1)`, PROJECT, NEW_ORG, NEW_LEAD),
    run(`INSERT INTO project_contacts (project_id, contact_id) VALUES (?1, ?2), (?1, ?3)`, PROJECT, OLD_CONTACT, NEW_CONTACT),
    run(`INSERT INTO tasks (id, title, organization_id, contact_id, created_at, updated_at) VALUES ('t-1', 'Call', ?1, ?2, 1, 1)`, NEW_ORG, NEW_CONTACT),
    run(`INSERT INTO tasks (id, title, lead_id, created_at, updated_at) VALUES ('t-2', 'Quote', ?1, 1, 1)`, NEW_LEAD),
    run(`INSERT INTO interactions (id, title, source, external_id, occurred_at, created_at, updated_at) VALUES (?1, 'Kickoff', 'manual', ?1, 1, 1, 1)`, INTERACTION),
    run(`INSERT INTO interaction_subjects (interaction_id, subject_kind, subject_id) VALUES (?1, 'organization', ?2), (?1, 'organization', ?3), (?1, 'lead', ?4)`, INTERACTION, OLD_ORG, NEW_ORG, NEW_LEAD),
    run(`INSERT INTO interaction_contacts (interaction_id, contact_id) VALUES (?1, ?2)`, INTERACTION, NEW_CONTACT),
    run(`INSERT INTO decisions (id, subject_kind, subject_id, body, decided_at) VALUES ('d-1', 'lead', ?1, 'Go', 1)`, NEW_LEAD),
    run(`INSERT INTO favorites (person_id, kind, target_ref, created_at) VALUES ('p-1', 'crm.partner', ?1, 1), ('p-1', 'crm.partner', ?2, 1), ('p-2', 'core.record', 'contacts:' || ?3, 1)`, OLD_ORG, NEW_ORG, NEW_CONTACT),
    run(`INSERT INTO subject_visibility (kind, subject_id, visibility, updated_by, updated_at) VALUES ('organization', ?1, 'restricted', 'sub-rosa', 1)`, NEW_ORG),
    run(`INSERT INTO subject_grants (id, kind, subject_id, principal_kind, principal_id, role, granted_by, granted_at)
         VALUES ('g-1', 'organization', ?1, 'member', 'sub-ana', 'read', 'sub-rosa', 1), ('g-2', 'organization', ?2, 'member', 'sub-ana', 'write', 'sub-rosa', 1),
                ('g-3', 'organization', ?2, 'member', 'sub-bo', 'read', 'sub-rosa', 1)`, OLD_ORG, NEW_ORG),
  ]);
}

const one = (sql: string, ...binds: unknown[]) => env.USAGE.prepare(sql).bind(...binds).first<Record<string, unknown>>();
const all = async (sql: string, ...binds: unknown[]) => (await env.USAGE.prepare(sql).bind(...binds).all<Record<string, unknown>>()).results;

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
  await resetCorePatCache();
  calls = [];
  repoints = [];
  repointAnswer = null;
  core = {};
  await clearD1();
  await seed();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('which store merges', () => {
  it('sends a merge to Core while the subjects group is on Core, and refuses a lead there', async () => {
    mockCore();
    // The answer names the kept and merged records as D1's does (meet#1215).
    expect(await mergeCoreRecords(coreEnv, ACTOR, 'organizations', [OLD_ORG, NEW_ORG])).toMatchObject({
      data: { entity: 'organizations', kept: OLD_ORG, merged: [NEW_ORG], survivorId: OLD_ORG },
    });
    expect(calls).toEqual(['POST /api/public/meet-owner-exchange', 'POST /api/agent/entities/organizations/merge']);
    // D1 is untouched.
    expect(await one('SELECT COUNT(*) AS n FROM organizations')).toEqual({ n: 2 });
    expect((await rejection(mergeCoreRecords(coreEnv, ACTOR, 'leads', [OLD_LEAD, NEW_LEAD]))).status).toBe(400);
  });

  it('merges on D1 after the flip, and asks Core only about its kept tables', async () => {
    mockCore();
    const answer = await mergeCoreRecords(subjectsOnD1, ACTOR, 'organizations', [NEW_ORG, OLD_ORG]);
    expect(answer).toEqual({ data: { entity: 'organizations', kept: OLD_ORG, merged: [NEW_ORG] } });
    expect(calls).toEqual(['POST /api/public/meet-fold-merge-repoint', 'POST /api/public/meet-fold-merge-repoint']);
  });

  it('refuses while any group is frozen, before it writes', async () => {
    await freezeGroup(coreEnv, 'interactions');
    const refused = await rejection(mergeCoreRecords(subjectsOnD1, ACTOR, 'organizations', [OLD_ORG, NEW_ORG]));
    expect(refused).toMatchObject({ status: 503, code: 'records_moving' });
    expect(await one('SELECT COUNT(*) AS n FROM organizations')).toEqual({ n: 2 });
    await unfreezeGroup(coreEnv, 'interactions');
  });
});

describe('a merge over D1', () => {
  beforeEach(mockCore);

  it('moves every link of an organization onto the oldest and deletes the other', async () => {
    await mergeCoreRecords(subjectsOnD1, ACTOR, 'organizations', [NEW_ORG, OLD_ORG]);
    expect(await all('SELECT id, is_partner FROM organizations')).toEqual([{ id: OLD_ORG, is_partner: 1 }]);
    expect(await one('SELECT organization_id FROM contacts WHERE id = ?1', NEW_CONTACT)).toEqual({ organization_id: OLD_ORG });
    expect(await one('SELECT organization_id FROM leads WHERE id = ?1', NEW_LEAD)).toEqual({ organization_id: OLD_ORG });
    expect(await one('SELECT organization_id FROM projects WHERE id = ?1', PROJECT)).toEqual({ organization_id: OLD_ORG });
    expect(await one(`SELECT organization_id FROM tasks WHERE id = 't-1'`)).toEqual({ organization_id: OLD_ORG });
    // One subject link per pair; the lead's stays.
    expect(await all('SELECT subject_kind, subject_id FROM interaction_subjects ORDER BY subject_kind')).toEqual([
      { subject_kind: 'lead', subject_id: NEW_LEAD },
      { subject_kind: 'organization', subject_id: OLD_ORG },
    ]);
    // One favorite per person.
    expect(await all(`SELECT person_id, target_ref FROM favorites WHERE kind = 'crm.partner'`)).toEqual([{ person_id: 'p-1', target_ref: OLD_ORG }]);
    // A restriction either record had holds on the survivor.
    expect(await all('SELECT subject_id FROM subject_visibility')).toEqual([{ subject_id: OLD_ORG }]);
    // Ana's survivor grant stays live; her merged one is revoked; Bo's moves.
    expect(await all('SELECT id, subject_id, revoked_at IS NOT NULL AS revoked FROM subject_grants ORDER BY id')).toEqual([
      { id: 'g-1', subject_id: OLD_ORG, revoked: 0 },
      { id: 'g-2', subject_id: OLD_ORG, revoked: 1 },
      { id: 'g-3', subject_id: OLD_ORG, revoked: 0 },
    ]);
    expect(await all('SELECT entity, from_id, into_id FROM record_merges')).toEqual([{ entity: 'organizations', from_id: NEW_ORG, into_id: OLD_ORG }]);
  });

  it('merges contacts with their addresses and junction rows', async () => {
    await mergeCoreRecords(subjectsOnD1, ACTOR, 'contacts', [OLD_CONTACT, NEW_CONTACT]);
    expect(await all('SELECT id FROM contacts')).toEqual([{ id: OLD_CONTACT }]);
    expect(await all('SELECT email, contact_id FROM contact_emails ORDER BY email')).toEqual([
      { email: 'ana.s@acme.test', contact_id: OLD_CONTACT },
      { email: 'ana@acme.test', contact_id: OLD_CONTACT },
    ]);
    expect(await all('SELECT contact_id FROM project_contacts')).toEqual([{ contact_id: OLD_CONTACT }]);
    expect(await all('SELECT contact_id FROM interaction_contacts')).toEqual([{ contact_id: OLD_CONTACT }]);
    expect(await one('SELECT contact_id FROM leads WHERE id = ?1', NEW_LEAD)).toEqual({ contact_id: OLD_CONTACT });
    expect(await one(`SELECT contact_id FROM tasks WHERE id = 't-1'`)).toEqual({ contact_id: OLD_CONTACT });
    expect(await all(`SELECT target_ref FROM favorites WHERE kind = 'core.record'`)).toEqual([{ target_ref: `contacts:${OLD_CONTACT}` }]);
  });

  it('merges leads, and a second merge follows the chain', async () => {
    await mergeCoreRecords(subjectsOnD1, ACTOR, 'leads', [OLD_LEAD, NEW_LEAD]);
    expect(await one('SELECT lead_id FROM projects WHERE id = ?1', PROJECT)).toEqual({ lead_id: OLD_LEAD });
    expect(await one(`SELECT lead_id FROM tasks WHERE id = 't-2'`)).toEqual({ lead_id: OLD_LEAD });
    expect(await one(`SELECT subject_id FROM decisions WHERE id = 'd-1'`)).toEqual({ subject_id: OLD_LEAD });
    expect(await one(`SELECT subject_id FROM interaction_subjects WHERE subject_kind = 'lead'`)).toEqual({ subject_id: OLD_LEAD });

    // OLD_LEAD is merged into an even older lead: NEW_LEAD's record follows.
    const OLDEST = '1e000000-0000-4000-8000-000000000000';
    await env.USAGE.prepare(`INSERT INTO leads (id, title, status, created_at, updated_at) VALUES (?1, 'First', 'Proposal', 0, 0)`).bind(OLDEST).run();
    await mergeCoreRecords(subjectsOnD1, ACTOR, 'leads', [OLD_LEAD, OLDEST]);
    expect(await all('SELECT from_id, into_id FROM record_merges ORDER BY from_id')).toEqual([
      { from_id: OLD_LEAD, into_id: OLDEST },
      { from_id: NEW_LEAD, into_id: OLDEST },
    ]);
  });

  it('refuses an unknown id and a peer organization, and writes nothing', async () => {
    expect((await rejection(mergeCoreRecords(subjectsOnD1, ACTOR, 'organizations', [OLD_ORG, crypto.randomUUID()]))).status).toBe(404);
    await env.USAGE.prepare(`INSERT INTO peer_credentials (organization_id, created_by, created_at) VALUES (?1, 'sub-rosa', 1)`).bind(NEW_ORG).run();
    expect((await rejection(mergeCoreRecords(subjectsOnD1, ACTOR, 'organizations', [OLD_ORG, NEW_ORG]))).status).toBe(409);
    expect(await one('SELECT COUNT(*) AS n FROM organizations')).toEqual({ n: 2 });
  });

  it('is reached through the merge route', async () => {
    const context = createExecutionContext();
    const signIn = await worker.fetch(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Rosa', email: ACTOR }),
    }), subjectsOnD1, context);
    const { access_token: token } = await signIn.json<{ access_token: string }>();
    const response = await worker.fetch(new Request('http://local/api/core/merge/leads', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: env.WEB_ORIGIN },
      body: JSON.stringify({ ids: [NEW_LEAD, OLD_LEAD] }),
    }), subjectsOnD1, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { entity: 'leads', kept: OLD_LEAD, merged: [NEW_LEAD] } });
    await waitOnExecutionContext(context);
  });

  it('names only tables and columns D1 has', async () => {
    const columns = async (table: string) => new Set((await all(`PRAGMA table_info("${table}")`)).map((row) => row.name));
    for (const [table, column] of Object.values(MERGE_COLUMNS).flat().concat(Object.values(MERGE_PAIRS).flat())) {
      expect((await columns(table)).has(column), `${table}.${column}`).toBe(true);
    }
    for (const ref of SUBJECT_REFERENCES) {
      const names = await columns(ref.table);
      expect(names.has(ref.kind) && names.has(ref.id), ref.table).toBe(true);
    }
  });
});

describe('the tables that stay in Core after a D1 merge (meet#757)', () => {
  const ORG_MERGE = { entity: 'organizations', into_id: OLD_ORG, from_ids: [NEW_ORG] };
  const failures = () => one("SELECT count, last_detail FROM ops_failures WHERE kind = 'core_merge_repoint'");
  it('asks Core for a dry run before the merge and the repoint after it', async () => {
    mockCore();
    await mergeCoreRecords(subjectsOnD1, ACTOR, 'organizations', [OLD_ORG, NEW_ORG]);
    expect(repoints).toEqual([{ merges: [ORG_MERGE], dry_run: true }, { merges: [ORG_MERGE] }]);
    expect(await failures()).toBeNull();
  });

  it('refuses the merge with Core\'s reason when Core sees a conflict, and writes nothing', async () => {
    mockCore();
    const reason = 'Each organization has a Signals account (2 found). Resolve them by hand before merging: keep one account and delete the other.';
    repointAnswer = (body) => Response.json({ ok: true, results: body.merges.map((merge) => ({ entity: merge.entity, into_id: merge.into_id, ok: false, code: '23505', error: reason })) });
    const refused = await rejection(mergeCoreRecords(subjectsOnD1, ACTOR, 'organizations', [OLD_ORG, NEW_ORG]));
    expect(refused.status).toBe(409);
    expect(refused.message).toBe(reason);
    expect(repoints).toHaveLength(1);
    expect(await one('SELECT COUNT(*) AS n FROM organizations')).toEqual({ n: 2 });
    expect(await one('SELECT COUNT(*) AS n FROM record_merges')).toEqual({ n: 0 });
  });

  it('keeps the merge and counts the failure when Core fails after it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCore();
    repointAnswer = (body) => (body.dry_run
      ? Response.json({ ok: true, results: body.merges.map((merge) => ({ entity: merge.entity, into_id: merge.into_id, ok: true, moved: 0 })) })
      : Response.json({ ok: false }, { status: 500 }));
    await mergeCoreRecords(subjectsOnD1, ACTOR, 'organizations', [OLD_ORG, NEW_ORG]);
    expect(await one('SELECT COUNT(*) AS n FROM organizations')).toEqual({ n: 1 });
    const failed = await failures();
    expect(failed?.count).toBe(1);
    expect(String(failed?.last_detail)).toContain(NEW_ORG);
  });

  it('merges when the dry run fails for another reason, and counts the repoint that fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCore();
    repointAnswer = (body) => Response.json({ ok: true, results: body.merges.map((merge) => ({ entity: merge.entity, into_id: merge.into_id, ok: false, code: '42883', error: 'Failed to repoint' })) });
    await mergeCoreRecords(subjectsOnD1, ACTOR, 'organizations', [OLD_ORG, NEW_ORG]);
    expect(await one('SELECT COUNT(*) AS n FROM organizations')).toEqual({ n: 1 });
    expect((await failures())?.count).toBe(1);
  });

  it('sends a WORK_STORE=d1 workspace nothing', async () => {
    mockCore();
    await mergeCoreRecords({ ...coreEnv, WORK_STORE: 'd1' } as Env, ACTOR, 'contacts', [OLD_CONTACT, NEW_CONTACT]);
    expect(calls).toEqual([]);
  });

  it('gives the survivor the merged contact\'s outreach state when it has none, and makes the lead', async () => {
    mockCore();
    await env.USAGE.prepare("UPDATE contacts SET signals_outreach_status = 'notified', signals_notified_at = 5 WHERE id = ?1").bind(NEW_CONTACT).run();
    await mergeCoreRecords(subjectsOnD1, ACTOR, 'contacts', [OLD_CONTACT, NEW_CONTACT]);
    expect(await one('SELECT signals_outreach_status, signals_notified_at FROM contacts WHERE id = ?1', OLD_CONTACT))
      .toEqual({ signals_outreach_status: 'notified', signals_notified_at: 5 });
    expect(await one("SELECT COUNT(*) AS n FROM leads WHERE source = 'signals'")).toEqual({ n: 1 });
  });

  it('keeps the survivor\'s own outreach state', async () => {
    mockCore();
    await env.USAGE.batch([
      env.USAGE.prepare("UPDATE contacts SET signals_outreach_status = 'replied', signals_notified_at = 3 WHERE id = ?1").bind(OLD_CONTACT),
      env.USAGE.prepare("UPDATE contacts SET signals_outreach_status = 'notified', signals_notified_at = 5 WHERE id = ?1").bind(NEW_CONTACT),
    ]);
    await mergeCoreRecords(subjectsOnD1, ACTOR, 'contacts', [OLD_CONTACT, NEW_CONTACT]);
    expect(await one('SELECT signals_outreach_status, signals_notified_at FROM contacts WHERE id = ?1', OLD_CONTACT))
      .toEqual({ signals_outreach_status: 'replied', signals_notified_at: 3 });
  });

  it('an organization merge makes no new Signals lead', async () => {
    mockCore();
    await env.USAGE.prepare("UPDATE contacts SET signals_outreach_status = 'notified' WHERE id = ?1").bind(NEW_CONTACT).run();
    await mergeCoreRecords(subjectsOnD1, ACTOR, 'organizations', [OLD_ORG, NEW_ORG]);
    expect(await one("SELECT COUNT(*) AS n FROM leads WHERE source = 'signals'")).toEqual({ n: 0 });
  });

  it('replays every merge since the copy, and says which Core refused', async () => {
    mockCore();
    const run = (sql: string, ...binds: unknown[]) => env.USAGE.prepare(sql).bind(...binds);
    await env.USAGE.batch([
      run("INSERT INTO work_group_moves (work_group, frozen, copied_at, updated_at) VALUES ('subjects', 0, 100, 100)"),
      // Core's own merge, from the copy: Core moved its rows then.
      run("INSERT INTO record_merges (entity, from_id, into_id, merged_at) VALUES ('organizations', ?1, ?2, 50)", 'aaaaaaaa-0000-4000-8000-000000000050', OLD_ORG),
      run("INSERT INTO record_merges (entity, from_id, into_id, merged_at) VALUES ('organizations', ?1, ?2, 200), ('organizations', ?3, ?2, 201)", NEW_ORG, OLD_ORG, 'aaaaaaaa-0000-4000-8000-000000000051'),
      run("INSERT INTO record_merges (entity, from_id, into_id, merged_at) VALUES ('contacts', ?1, ?2, 300)", NEW_CONTACT, OLD_CONTACT),
    ]);
    repointAnswer = (body) => Response.json({
      ok: true,
      results: body.merges.map((merge) => (merge.entity === 'contacts'
        ? { entity: merge.entity, into_id: merge.into_id, ok: false, code: '23505', error: 'A row conflicts' }
        : { entity: merge.entity, into_id: merge.into_id, ok: true, moved: 2 })),
    });
    const answer = await runWorkGroupMove(subjectsOnD1, { action: 'repoint_merges', group: 'subjects' });
    expect(repoints).toHaveLength(1);
    expect(repoints[0]!.merges).toEqual([
      { entity: 'contacts', into_id: OLD_CONTACT, from_ids: [NEW_CONTACT] },
      { entity: 'organizations', into_id: OLD_ORG, from_ids: ['aaaaaaaa-0000-4000-8000-000000000051', NEW_ORG].sort() },
    ]);
    expect(answer.ok).toBe(false);
    expect(answer.repoint).toEqual({ merges: 2, moved: 2, failed: [{ entity: 'contacts', into_id: OLD_CONTACT, code: '23505', error: 'A row conflicts' }] });
    expect((await rejection(runWorkGroupMove(subjectsOnD1, { action: 'repoint_merges', group: 'tasks' }))).status).toBe(400);
    expect((await rejection(runWorkGroupMove({ ...coreEnv, WORK_STORE: 'd1' } as Env, { action: 'repoint_merges', group: 'subjects' }))).status).toBe(404);
  });
});

describe('a later group after a merge', () => {
  it('copies Core rows that name a merged id onto the survivor, and verifies', async () => {
    mockCore();
    await mergeCoreRecords(subjectsOnD1, ACTOR, 'organizations', [OLD_ORG, NEW_ORG]);
    await mergeCoreRecords(subjectsOnD1, ACTOR, 'contacts', [OLD_CONTACT, NEW_CONTACT]);
    await env.USAGE.batch([env.USAGE.prepare('DELETE FROM tasks'), env.USAGE.prepare('DELETE FROM interaction_contacts')]);
    // Core still holds the tasks group, on the ids it knew.
    core = {
      milestones: [],
      tasks: [
        { id: 'ac000000-0000-4000-8000-000000000001', title: 'Call', status: 'pending', organization_id: NEW_ORG, contact_id: NEW_CONTACT, created_at: '2026-10-01T00:00:00Z' },
      ],
    };
    await freezeGroup(coreEnv, 'tasks');
    // Without the map, D1's foreign key would refuse a task on the deleted organization.
    expect((await copyGroup(subjectsOnD1, 'tasks')).copied).toEqual({ milestones: 0, tasks: 1 });
    expect(await one('SELECT organization_id, contact_id FROM tasks')).toEqual({ organization_id: OLD_ORG, contact_id: OLD_CONTACT });
    expect((await verifyGroup(subjectsOnD1, 'tasks')).ok).toBe(true);
  });

  it('maps subject references and pinned records', () => {
    const merges = new Map([[`organizations:${NEW_ORG}`, OLD_ORG], [`contacts:${NEW_CONTACT}`, OLD_CONTACT]]);
    expect(remapMerged('decisions', { subject_kind: 'organization', subject_id: NEW_ORG }, merges)).toEqual({ subject_kind: 'organization', subject_id: OLD_ORG });
    expect(remapMerged('decisions', { subject_kind: 'project', subject_id: NEW_ORG }, merges)).toEqual({ subject_kind: 'project', subject_id: NEW_ORG });
    expect(remapMerged('favorites', { kind: 'crm.partner', target_ref: NEW_ORG }, merges)).toEqual({ kind: 'crm.partner', target_ref: OLD_ORG });
    expect(remapMerged('favorites', { kind: 'core.record', target_ref: `contacts:${NEW_CONTACT}` }, merges)).toEqual({ kind: 'core.record', target_ref: `contacts:${OLD_CONTACT}` });
    expect(remapMerged('interaction_contacts', { interaction_id: 'i', contact_id: NEW_CONTACT }, merges)).toEqual({ interaction_id: 'i', contact_id: OLD_CONTACT });
  });
});
