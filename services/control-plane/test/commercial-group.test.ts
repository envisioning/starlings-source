// Fold group 5, commercial (meet#1229): the copy and verify, the two doors in
// Core's names, the store switch, and a merge over the moved rows.
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMERCIAL_COLUMNS, COMMERCIAL_D1_COLUMNS, COMMERCIAL_TABLES, type CommercialTable } from '@starlings/contracts/core-commercial';
import { coreReadRequestSchema } from '@starlings/contracts/core-reads';
import { coreWriteRequestSchema } from '@starlings/contracts/core-writes';
import { WORK_GROUP_TABLES } from '@starlings/contracts/work-groups';
import { d1CommercialSummary } from '../src/core-commercial-d1';
import { fetchCrmCommercialSummary, listCrmCommercial } from '../src/crm';
import { hmacSHA256Hex } from '../src/crypto';
import worker from '../src/index';
import { inboundKeyEnvName } from '../src/inbound-keys';
import { d1MergeRecords } from '../src/record-merges';
import { copyGroup, freezeGroup, TABLE_SPECS, verifyGroup } from '../src/work-group-moves';
import { groupStore } from '../src/work-store';

const SECRET = 'meet-core-shared-secret-at-least-32-chars';
const CORE_KEY = 'core-key-for-the-commercial-tests-0123456789';
const ORG = '0a000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '0a000000-0000-4000-8000-0000000000a2';
const LEAD = '1e000000-0000-4000-8000-0000000000e1';
const PROJECT = '9a000000-0000-4000-8000-0000000000f1';
const MILESTONE = '3a000000-0000-4000-8000-000000000001';
const ENTITY = 'ce000000-0000-4000-8000-000000000001';
const TERM = 'de000000-0000-4000-8000-000000000001';
const SERVICE = '5e000000-0000-4000-8000-000000000001';
const OFFER = '0f000000-0000-4000-8000-000000000001';
const LINE = '0f000000-0000-4000-8000-000000000002';
const LICENSE = '11000000-0000-4000-8000-000000000001';

/** Envisioning with Core: Core for the workspace, and for the group. */
const onCore = { ...env, WORK_STORE: 'core', INTERNAL_REQUEST_SECRET: SECRET, [inboundKeyEnvName('core')]: CORE_KEY } as Env;
/** The same workspace after the commercial flip. */
const onD1 = {
  ...onCore,
  WORK_STORE_SUBJECTS: 'd1', WORK_STORE_TASKS: 'd1', WORK_STORE_GOALS: 'd1', WORK_STORE_INTERACTIONS: 'd1', WORK_STORE_COMMERCIAL: 'd1',
} as Env;

const one = (sql: string, ...binds: unknown[]) => env.USAGE.prepare(sql).bind(...binds).first<Record<string, unknown>>();

async function door(path: 'core-writes' | 'core-reads', body: unknown, workspace: Env = onD1): Promise<Response> {
  const raw = JSON.stringify(body);
  const timestamp = String(Date.now());
  const context = createExecutionContext();
  const response = await worker.fetch(new Request(`http://local/api/internal/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-timestamp': timestamp,
      'x-internal-signature': await hmacSHA256Hex(CORE_KEY, `${timestamp}.${raw}`),
      'x-internal-key-id': 'core',
    },
    body: raw,
  }), workspace, context);
  await waitOnExecutionContext(context);
  return response;
}

const write = (body: Record<string, unknown>, workspace?: Env) => door('core-writes', { entity: 'commercial', ...body }, workspace);
const read = (body: Record<string, unknown>, workspace?: Env) => door('core-reads', { op: 'commercial_rows', ...body }, workspace);
const dataOf = async <T = Record<string, unknown>>(response: Response) => (await response.json<{ data: T }>()).data;

async function clear(): Promise<void> {
  await env.USAGE.batch([
    ...[...COMMERCIAL_TABLES].reverse(), 'tasks', 'milestones', 'projects', 'leads', 'organizations', 'record_merges', 'work_activity', 'work_group_moves',
  ].map((table) => env.USAGE.prepare(`DELETE FROM "${table}"`)));
}

async function seedSubjects(): Promise<void> {
  const run = (sql: string, ...binds: unknown[]) => env.USAGE.prepare(sql).bind(...binds);
  await env.USAGE.batch([
    run(`INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?1, 'Acme', 1, 1), (?2, 'Other', 2, 2)`, ORG, OTHER_ORG),
    run(`INSERT INTO leads (id, organization_id, title, status, created_at, updated_at) VALUES (?1, ?2, 'Pilot', 'Proposal', 1, 1)`, LEAD, ORG),
    run(`INSERT INTO projects (id, organization_id, title, status, created_at, updated_at) VALUES (?1, ?2, 'Radar', 'Active', 1, 1)`, PROJECT, ORG),
    run(`INSERT INTO milestones (id, project_id, title, status, created_at, updated_at) VALUES (?1, ?2, 'Kickoff', 'planned', 1, 1)`, MILESTONE, PROJECT),
  ]);
}

/** Core's rows as PostgREST sends them: numerics as strings, `jsonb` in any key order. */
function coreRows(): Record<CommercialTable, Array<Record<string, unknown>>> {
  return {
    corporate_entities: [{ id: ENTITY, created_at: '2025-01-01T00:00:00+00:00', name: 'Envisioning BV', legal_name: 'Envisioning Technology', is_default: true, billing_iban: 'NL00', country: 'NL' }],
    currency_settings: [{ id: '2c000000-0000-4000-8000-000000000001', created_at: null, currency_code: 'USD', is_enabled: null, surcharge_percentage: '3.5', symbol: '$' }],
    exchange_rates_cache: [{ id: '2c000000-0000-4000-8000-000000000002', created_at: '2025-01-01T00:00:00+00:00', base_currency: 'EUR', target_currency: 'USD', rate: '1.08', last_updated: '2025-01-02T00:00:00+00:00' }],
    settings_payment_terms: [{ id: TERM, title: '30 days', description: 'Net 30', is_active: true, is_default: true, created_at: '2025-01-01T00:00:00+00:00', updated_at: '2025-01-01T00:00:00+00:00' }],
    settings_delivery_conditions: [{ id: 'de000000-0000-4000-8000-000000000002', title: 'Remote', description: 'Online', is_active: true, is_default: false, created_at: '2025-01-01T00:00:00+00:00', updated_at: '2025-01-01T00:00:00+00:00' }],
    settings_offer_links: [{ id: 'de000000-0000-4000-8000-000000000003', title: 'Deck', url: 'https://example.test/deck', icon: null, is_active: true, is_default: false, created_at: '2025-01-01T00:00:00+00:00', updated_at: '2025-01-01T00:00:00+00:00' }],
    services: [{ id: SERVICE, created_at: '2025-01-01T00:00:00+00:00', name: 'Radar', description: 'A radar', price: '1000.50', is_recurring: true, recurring_interval: 'year', summary: 'Radar', group_type: 'Core', is_public: true, allow_multiple: false, is_default: false, category: null, allow_description_override: false, search_vector: "'radar':1" }],
    offers: [{
      id: OFFER, created_at: '2025-02-01T00:00:00.123+00:00', organization_id: ORG, corporate_entity_id: ENTITY, valid_until: '2025-03-01T00:00:00+00:00', status: 'sent', total_amount: '1000.50',
      updated_at: '2025-02-01T00:00:00+00:00', currency: 'USD', global_discount_percentage: '10.0', title: 'Acme', lead_id: LEAD, is_self_submitted: false, exchange_rate: '1.08',
      payment_term_id: TERM, delivery_condition_id: null, payment_terms_text: 'Net 30', delivery_conditions_text: null, accepted_metadata: { z: 1, a: { d: [1, { c: 2, b: 3 }] } },
      creator_token_id: null, is_accepted: false, tax_percentage: '0', agreement_date: '2025-02-01', agreement_include_annex: true, service_inputs: {}, recipient_email: 'ana@acme.test', search_vector: "'acme':1",
    }],
    offer_services: [{ id: LINE, offer_id: OFFER, service_id: SERVICE, quantity: 2, price: '500.25', discount: null, discount_percentage: '0', is_custom: false, hide_description: false, snapshot_name: 'Radar', snapshot_is_recurring: true, is_optional: true }],
    offer_selected_links: [{ id: 'de000000-0000-4000-8000-000000000004', offer_id: OFFER, link_id: 'de000000-0000-4000-8000-000000000003', is_enabled: true, created_at: '2025-02-01T00:00:00+00:00' }],
    offer_access_logs: [{ id: 'de000000-0000-4000-8000-000000000005', created_at: '2025-02-02T00:00:00+00:00', offer_id: OFFER, accessed_email: 'ana@acme.test', accessed_at: '2025-02-02T00:00:00+00:00', ip_address: '192.0.2.1', metadata: null }],
    licenses: [{ id: LICENSE, created_at: '2025-02-03T00:00:00+00:00', updated_at: '2025-02-03T00:00:00+00:00', organization_id: ORG, lead_id: LEAD, offer_id: OFFER, start_date: '2025-02-03', renewal_date: '2026-02-03', is_active: true, amount_eur: '1000.5', product: 'signals', seats: 5 }],
    license_offers: [{ license_id: LICENSE, offer_id: OFFER, created_at: '2025-02-03T00:00:00+00:00' }],
    policies: [{ id: '70000000-0000-4000-8000-000000000001', created_at: '2025-01-01T00:00:00+00:00', updated_at: '2025-01-01T00:00:00+00:00', title: 'Privacy', effective_date: '2025-01-01', organization_id: ORG, url: null }],
  };
}

function mockCore(rows = coreRows()): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL((input instanceof Request ? input : new Request(String(input), init)).url);
    if (url.pathname !== '/api/public/meet-fold-export') return new Response('{}', { status: 404 });
    const table = rows[url.searchParams.get('table') as CommercialTable];
    if (!table) return new Response('{}', { status: 400 });
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 500);
    return new Response(JSON.stringify({ rows: table.slice(offset, offset + limit), has_more: offset + limit < table.length }));
  });
}

/** The group copied, as the doors find it after the flip. */
async function copied(): Promise<void> {
  mockCore();
  await freezeGroup(onCore, 'commercial');
  await copyGroup(onCore, 'commercial');
  await env.USAGE.prepare("UPDATE work_group_moves SET frozen = 0 WHERE work_group = 'commercial'").run();
}

beforeEach(async () => {
  await clear();
  await seedSubjects();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await clear();
});

describe('the Home commercial card after the flip (meet#1286)', () => {
  it('reads D1 with no call to Core, in Core\'s series', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no call to Core'));
    const now = new Date('2026-11-15T12:00:00.000Z');
    const at = (iso: string) => Date.parse(iso);
    const insert = (id: string, amount: number, accepted: number, validUntil: number | null, createdAt: number, draft = 0) => env.USAGE.prepare(
      `INSERT INTO offers (id, status, total_amount, is_accepted, valid_until, created_at, unsent_draft) VALUES (?1, 'sent', ?2, ?3, ?4, ?5, ?6)`,
    ).bind(id, amount, accepted, validUntil, createdAt, draft);
    await env.USAGE.batch([
      insert(OFFER, 1000, 1, null, at('2026-11-02T00:00:00Z')),
      insert('0f000000-0000-4000-8000-0000000000e1', 300, 0, at('2026-11-01T00:00:00Z'), at('2026-10-02T00:00:00Z')),
      insert('0f000000-0000-4000-8000-0000000000e2', 200, 0, at('2027-01-01T00:00:00Z'), at('2026-10-03T00:00:00Z')),
      insert('0f000000-0000-4000-8000-0000000000e3', 900, 0, null, at('2026-11-03T00:00:00Z'), 1),
      insert('0f000000-0000-4000-8000-0000000000e4', 700, 1, null, at('2020-01-03T00:00:00Z')),
      env.USAGE.prepare(`INSERT INTO licenses (id, created_at, updated_at, start_date, renewal_date) VALUES ('11000000-0000-4000-8000-0000000000e1', 1, 1, '2026-06-01', '2027-06-01'), ('11000000-0000-4000-8000-0000000000e2', 1, 1, '2019-06-01', '2020-06-01')`),
    ]);
    const summary = await d1CommercialSummary(env, 12, now);
    expect(summary).toMatchObject({ lookback_months: 12, offers: 3, sales_amount: 1000, pipeline_amount: 200, new_licenses: 1, currency_code: 'EUR' });
    expect(summary.points).toHaveLength(12);
    expect(summary.points.at(-1)).toMatchObject({ key: '2026-11', total: 1000, positive: 1000, negative: 0 });
    expect(summary.points.at(-2)).toMatchObject({ key: '2026-10', total: 500, positive: 0, negative: 300 });
    expect(await fetchCrmCommercialSummary(onD1, 'rosa@example.com')).toMatchObject({ lookback_months: 12 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still asks Core with the var unset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 500 }));
    await expect(fetchCrmCommercialSummary({ ...onCore, CORE_API_ORIGIN: 'https://core.test', CRM_SYNC_MODE: 'on' } as Env, 'rosa@example.com')).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalled();
  });
});

describe('the commercial group', () => {
  it('names one table list in both registries, and every Core column in D1', async () => {
    expect([...WORK_GROUP_TABLES.commercial]).toEqual([...COMMERCIAL_TABLES]);
    for (const table of COMMERCIAL_TABLES) {
      const { results } = await env.USAGE.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>();
      expect(results.map((column) => column.name).sort(), table).toEqual(Object.keys({ ...COMMERCIAL_COLUMNS[table], ...COMMERCIAL_D1_COLUMNS[table] }).sort());
      expect(TABLE_SPECS[table]!.core, table).toBe(table);
    }
  });

  it('stays on Core until its var says d1', () => {
    expect(groupStore(onCore, 'commercial')).toBe('core');
    expect(groupStore({ ...onCore, WORK_STORE_COMMERCIAL: 'D1' } as Env, 'commercial')).toBe('core');
    expect(groupStore(onD1, 'commercial')).toBe('d1');
  });

  it('copies every table in foreign key order and verifies it, twice over', async () => {
    mockCore();
    await freezeGroup(onCore, 'commercial');
    const first = await copyGroup(onCore, 'commercial');
    expect(first.next).toBeNull();
    expect(Object.keys(first.copied)).toEqual([...COMMERCIAL_TABLES]);
    const verified = await verifyGroup(onCore, 'commercial');
    expect(verified.tables.filter((report) => !report.match)).toEqual([]);
    expect(verified.ok).toBe(true);
    // Idempotent: a second run writes the same rows.
    await copyGroup(onCore, 'commercial');
    expect((await verifyGroup(onCore, 'commercial')).ok).toBe(true);

    const offer = await one('SELECT * FROM offers WHERE id = ?1', OFFER);
    expect(offer).toMatchObject({ total_amount: 1000.5, is_accepted: 0, agreement_date: '2025-02-01', created_at: Date.parse('2025-02-01T00:00:00.123Z'), service_inputs: '{}' });
    // Keys sorted at every level, arrays kept.
    expect(offer?.accepted_metadata).toBe('{"a":{"d":[1,{"b":3,"c":2}]},"z":1}');
    // Migration 0132's NOT NULL columns take Core's defaults for a null.
    expect(await one('SELECT is_enabled, surcharge_percentage, created_at FROM currency_settings')).toEqual({ is_enabled: 1, surcharge_percentage: 3.5, created_at: 0 });
  });

  it('reports a changed row', async () => {
    mockCore();
    await freezeGroup(onCore, 'commercial');
    await copyGroup(onCore, 'commercial');
    await env.USAGE.prepare('UPDATE offers SET title = ?1 WHERE id = ?2').bind('Changed', OFFER).run();
    const verified = await verifyGroup(onCore, 'commercial');
    expect(verified.ok).toBe(false);
    expect(verified.tables.find((report) => report.table === 'offers')?.match).toBe(false);
  });

  it('maps a merged organization to its survivor in the copy (record_merges)', async () => {
    const rows = coreRows();
    await env.USAGE.prepare(`INSERT INTO record_merges (entity, from_id, into_id, merged_by, merged_at) VALUES ('organizations', 'merged-org', ?1, NULL, 1)`).bind(ORG).run();
    rows.policies[0]!.organization_id = 'merged-org';
    mockCore(rows);
    await freezeGroup(onCore, 'commercial');
    await copyGroup(onCore, 'commercial');
    expect((await one('SELECT organization_id FROM policies'))?.organization_id).toBe(ORG);
    expect((await verifyGroup(onCore, 'commercial')).ok).toBe(true);
  });

  it('moves offers, licences and policies when a D1 merge removes their subject', async () => {
    await copied();
    await env.USAGE.prepare('UPDATE offers SET organization_id = ?1 WHERE id = ?2').bind(OTHER_ORG, OFFER).run();
    await d1MergeRecords(onD1, 'rosa@example.com', 'organizations', [ORG, OTHER_ORG]);
    expect((await one('SELECT organization_id FROM offers WHERE id = ?1', OFFER))?.organization_id).toBe(ORG);
  });
});

describe('the read door', () => {
  it('refuses while the group is on Core', async () => {
    expect((await read({ table: 'offers' }, onCore)).status).toBe(409);
    await copied();
    expect((await read({ table: 'offers' })).status).toBe(200);
  });

  it('answers in Core names, by every filter', async () => {
    await copied();
    const [offer] = await dataOf<Array<Record<string, unknown>>>(await read({ table: 'offers', eq: { id: OFFER } }));
    expect(offer).toMatchObject({
      id: OFFER, is_accepted: false, created_at: '2025-02-01T00:00:00.123Z', total_amount: 1000.5, agreement_date: '2025-02-01',
      accepted_metadata: { z: 1, a: { d: [1, { c: 2, b: 3 }] } }, service_inputs: {}, delivery_condition_id: null,
    });
    const count = async (filter: Record<string, unknown>) => (await dataOf<unknown[]>(await read({ table: 'offers', ...filter }))).length;
    expect(await count({ eq: { is_accepted: false } })).toBe(1);
    expect(await count({ eq: { is_accepted: true } })).toBe(0);
    expect(await count({ not: { is_accepted: true } })).toBe(1);
    expect(await count({ gte: { valid_until: '2025-02-15T00:00:00Z' }, lte: { valid_until: '2025-03-15T00:00:00Z' } })).toBe(1);
    expect(await count({ gte: { valid_until: '2025-04-01T00:00:00Z' } })).toBe(0);
    expect(await count({ in: { id: [OFFER, LINE] } })).toBe(1);
    expect(await count({ eq: { delivery_condition_id: null } })).toBe(1);
  });

  it('refuses a column the table does not have', async () => {
    await copied();
    expect((await read({ table: 'offers', eq: { 'id = 1 OR 1': 'x' } })).status).toBe(400);
    expect((await read({ table: 'offers', eq: { secret: 'x' } })).status).toBe(400);
    expect((await read({ table: 'offers', order: [{ column: 'secret' }] })).status).toBe(400);
    expect(coreReadRequestSchema.safeParse({ op: 'commercial_rows', table: 'nda_signatures' }).success).toBe(false);
  });
});

describe('the write door', () => {
  it('refuses while the group is on Core, and while it is frozen', async () => {
    const values = { title: 'x', status: 'draft', total_amount: 0 };
    expect((await write({ action: 'create', table: 'offers', values }, onCore)).status).toBe(409);
    await copied();
    await freezeGroup(onD1, 'commercial');
    const frozen = await write({ action: 'create', table: 'offers', values });
    expect(frozen.status).toBe(503);
    expect(await frozen.json()).toMatchObject({ code: 'records_moving' });
  });

  it('creates an offer with the defaults of Core\'s trigger', async () => {
    await copied();
    const created = await dataOf<Record<string, unknown>>(await write({
      action: 'create', table: 'offers',
      values: { title: 'New', status: 'draft', total_amount: 10, organization_id: ORG, service_inputs: { b: 1, a: 2 } },
    }));
    expect(created).toMatchObject({
      title: 'New', payment_term_id: TERM, payment_terms_text: 'Net 30', corporate_entity_id: ENTITY, currency: 'EUR', is_accepted: false, exchange_rate: 1, agreement_include_annex: true,
    });
    expect(typeof created.created_at).toBe('string');
    expect((await one('SELECT service_inputs FROM offers WHERE id = ?1', created.id))?.service_inputs).toBe('{"a":2,"b":1}');
    expect((await one("SELECT table_name, action FROM work_activity WHERE row_id = ?1", created.id))).toEqual({ table_name: 'offers', action: 'insert' });
  });

  it('applies an update only while its guards hold: the accept path closes the race', async () => {
    await copied();
    const accept = () => write({ action: 'update', table: 'offers', id: OFFER, values: { is_accepted: true, status: 'accepted' }, unless: { is_accepted: true } });
    expect(await dataOf(await accept())).toMatchObject({ is_accepted: true, status: 'accepted' });
    expect(await dataOf(await accept())).toBeNull();
    const viewed = await write({ action: 'update', table: 'offers', id: OFFER, values: { status: 'viewed' }, only_if: { status: 'sent' } });
    expect(await dataOf(viewed)).toBeNull();
    expect((await one('SELECT status FROM offers WHERE id = ?1', OFFER))?.status).toBe('accepted');
  });

  it('answers null for an update or delete with no row', async () => {
    await copied();
    const missing = '0f000000-0000-4000-8000-0000000000ff';
    expect(await dataOf(await write({ action: 'update', table: 'offers', id: missing, values: { title: 'x' } }))).toBeNull();
    expect(await dataOf(await write({ action: 'delete', table: 'offers', id: missing }))).toBeNull();
  });

  it('carries Postgres codes: a second licence on an offer, a line on no offer, a missing column', async () => {
    await copied();
    const second = await write({ action: 'create', table: 'licenses', values: { offer_id: OFFER, start_date: '2025-02-03', renewal_date: '2026-02-03' } });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: '23505' });
    const orphan = await write({ action: 'create', table: 'offer_services', values: { offer_id: LINE, quantity: 1, price: 1 } });
    expect(await orphan.json()).toMatchObject({ code: '23503' });
    const bare = await write({ action: 'create', table: 'offers', values: { title: 'No status' } });
    expect(bare.status).toBe(400);
    expect(await bare.json()).toMatchObject({ code: '23502' });
  });

  it('deleting an offer takes its lines and keeps its licence', async () => {
    await copied();
    await write({ action: 'delete', table: 'offers', id: OFFER });
    expect(await one('SELECT id FROM offer_services WHERE id = ?1', LINE)).toBeNull();
    expect((await one('SELECT offer_id FROM licenses WHERE id = ?1', LICENSE))?.offer_id).toBeNull();
  });

  it('writes the junction by its pair, and a view log with no activity row', async () => {
    await copied();
    await env.USAGE.prepare('DELETE FROM license_offers').run();
    expect(await dataOf(await write({ action: 'create', table: 'license_offers', values: { license_id: LICENSE, offer_id: OFFER } }))).toMatchObject({ license_id: LICENSE, offer_id: OFFER });
    const before = (await one('SELECT COUNT(*) AS n FROM work_activity'))?.n;
    const log = await dataOf<Record<string, unknown>>(await write({ action: 'create', table: 'offer_access_logs', values: { offer_id: OFFER, accessed_email: 'ana@acme.test' } }));
    expect(typeof log.accessed_at).toBe('string');
    expect((await one('SELECT COUNT(*) AS n FROM work_activity'))?.n).toBe(before);
  });

  it('refuses a column, a wrong type, an id and an unknown table before the door', () => {
    const parse = (body: Record<string, unknown>) => coreWriteRequestSchema.safeParse({ entity: 'commercial', ...body }).success;
    expect(parse({ action: 'create', table: 'offers', values: { title: 'ok', status: 'draft', total_amount: 1 } })).toBe(true);
    expect(parse({ action: 'create', table: 'offers', values: { secret: 'x' } })).toBe(false);
    expect(parse({ action: 'create', table: 'offers', values: { total_amount: 'many' } })).toBe(false);
    expect(parse({ action: 'create', table: 'offers', values: { id: OFFER } })).toBe(false);
    expect(parse({ action: 'create', table: 'nda_signatures', values: { signer_name: 'x' } })).toBe(false);
    expect(parse({ action: 'update', table: 'offers', id: OFFER, values: { title: 'x' }, unless: { secret: true } })).toBe(false);
  });
});

describe("Starlings' own lists", () => {
  it('read D1 once the group moved, with no call to Core', async () => {
    await copied();
    const spy = vi.spyOn(globalThis, 'fetch');
    spy.mockClear();
    const { offers, licenses } = await listCrmCommercial(onD1, 'rosa@example.com', { organization_id: ORG, limit: '100' }, { offers: true, licenses: true });
    expect(spy).not.toHaveBeenCalled();
    expect(offers?.[0]).toMatchObject({ id: OFFER, total_amount: 1000.5, is_accepted: false, lead_id: LEAD });
    expect(licenses?.[0]).toMatchObject({ id: LICENSE, seats: 5, is_active: true, start_date: '2025-02-03' });
    const off = await listCrmCommercial(onD1, 'rosa@example.com', { lead_id: LEAD }, { offers: false, licenses: true });
    expect(off.offers).toBeNull();
  });
});
