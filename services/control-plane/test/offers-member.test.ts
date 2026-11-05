// A member's offers and catalog (meet#1282, envisioning/core#221 to #223): the
// routes, the offer rules, the frozen versions a buyer reads through Core's door,
// the refusal while Core holds the group, the settings in Admin and the MCP tools.
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMERCIAL_D1_COLUMNS, COMMERCIAL_TABLES } from '@starlings/contracts/core-commercial';
import { commercialSettingsResponseSchema, type CommercialSettingsResponse } from '@starlings/contracts/commercial-settings';
import { computeOfferTotals, OFFER_STATUSES, OFFER_STATUS_LABELS, SERVICE_CATEGORIES, SERVICE_GROUP_LABELS, SERVICE_GROUP_TYPES, SERVICE_RECURRING_INTERVALS } from '@starlings/contracts/offer-values';
import {
  catalogResponseSchema,
  catalogServiceResponseSchema,
  offerOptionsResponseSchema,
  offerDecisionResponseSchema,
  offerResponseSchema,
  offerSendResponseSchema,
  offerVersionResponseSchema,
  type CatalogServiceResponse,
  type OfferResponse,
  type OfferSendResponse,
} from '@starlings/contracts/offers';
import offerValues from '../../../fixtures/offer-values.json';
import { hmacSHA256Hex } from '../src/crypto';
import worker from '../src/index';
import { inboundKeyEnvName } from '../src/inbound-keys';
import { handleMcp } from '../src/mcp';
import { offerLink } from '../src/offers-d1';
import { copyGroup, freezeGroup, TABLE_SPECS } from '../src/work-group-moves';
import { workspaceServices } from '../src/workspace-descriptor';

const CORE_KEY = 'core-key-for-the-offer-tests-0123456789abcd';
const SECRET = 'meet-core-shared-secret-at-least-32-chars';
const EMAIL = 'offers-ana@example.com';
const ORG = '0a000000-0000-4000-8000-0000000000b1';
const OTHER_ORG = '0a000000-0000-4000-8000-0000000000b2';
const LEAD = '1e000000-0000-4000-8000-0000000000b1';
const CONTACT = '2c000000-0000-4000-8000-0000000000b1';

/** A workspace with its own D1, Offers on. */
const d1 = { ...env, WORK_STORE: 'd1', [inboundKeyEnvName('core')]: CORE_KEY, INTERNAL_REQUEST_SECRET: SECRET } as Env;
/** Envisioning before the flip: Core holds the commercial group. */
const coreHolds = { ...d1, WORK_STORE: 'core', WORK_STORE_SUBJECTS: 'd1', WORK_STORE_TASKS: 'd1', WORK_STORE_GOALS: 'd1', WORK_STORE_INTERACTIONS: 'd1' } as Env;
/** Envisioning after the flip. */
const flipped = { ...coreHolds, WORK_STORE_COMMERCIAL: 'd1' } as Env;

const one = (sql: string, ...binds: unknown[]) => env.USAGE.prepare(sql).bind(...binds).first<Record<string, unknown>>();
const run = (sql: string, ...binds: unknown[]) => env.USAGE.prepare(sql).bind(...binds).run();

async function invoke(request: Request, workspace: Env): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, workspace, context);
  await waitOnExecutionContext(context);
  return response;
}

let token = '';

async function hit(method: string, path: string, body?: unknown, workspace: Env = d1): Promise<Response> {
  return invoke(new Request(`http://local${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), workspace);
}

async function ok<T>(method: string, path: string, body?: unknown, workspace: Env = d1): Promise<T> {
  const response = await hit(method, path, body, workspace);
  expect(response.status, `${method} ${path}: ${await response.clone().text()}`).toBeLessThan(300);
  return response.json<T>();
}

const refused = async (status: number, method: string, path: string, body?: unknown, workspace: Env = d1) => {
  const response = await hit(method, path, body, workspace);
  expect(response.status, `${method} ${path}: ${await response.clone().text()}`).toBe(status);
  return (await response.json<{ error: string }>()).error;
};

/** Core's door, signed with Core's key. */
async function door(path: 'core-reads' | 'core-writes', body: unknown, workspace: Env = flipped): Promise<Response> {
  const raw = JSON.stringify(body);
  const timestamp = String(Date.now());
  return invoke(new Request(`http://local/api/internal/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-timestamp': timestamp,
      'x-internal-signature': await hmacSHA256Hex(CORE_KEY, `${timestamp}.${raw}`),
      'x-internal-key-id': 'core',
    },
    body: raw,
  }), workspace);
}

type Row = Record<string, unknown>;
async function buyerReads(table: string, eq: Row, version?: number, workspace: Env = flipped): Promise<Row[]> {
  const response = await door('core-reads', { op: 'commercial_rows', table, eq, ...(version ? { version } : {}) }, workspace);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json<{ data: Row[] }>()).data;
}

async function coreWrites(body: Row, workspace: Env = flipped): Promise<Row | null> {
  const response = await door('core-writes', { entity: 'commercial', ...body }, workspace);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json<{ data: Row | null }>()).data;
}

async function clear(): Promise<void> {
  await env.USAGE.batch([
    ...[...COMMERCIAL_TABLES].reverse(), 'tasks', 'projects', 'leads', 'contacts', 'organizations', 'work_activity', 'work_group_moves', 'workspace_settings',
  ].map((table) => env.USAGE.prepare(`DELETE FROM "${table}"`)));
}

const FUTURE = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

async function seed(): Promise<void> {
  await env.USAGE.batch([
    env.USAGE.prepare(`INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?1, 'Acme', 1, 1), (?2, 'Other', 2, 2)`).bind(ORG, OTHER_ORG),
    env.USAGE.prepare(`INSERT INTO contacts (id, organization_id, name, email, created_at, updated_at) VALUES (?1, ?2, 'Buyer', 'buyer@acme.test', 1, 1)`).bind(CONTACT, ORG),
    env.USAGE.prepare(`INSERT INTO leads (id, organization_id, contact_id, title, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'Pilot', 'Proposal', 1, 1)`).bind(LEAD, ORG, CONTACT),
    env.USAGE.prepare(`INSERT INTO workspace_settings (key, value, updated_by, updated_at) VALUES ('work_modules', '{"on":["sales","offers"]}', 'test', 1)`),
    env.USAGE.prepare(`INSERT INTO currency_settings (id, currency_code, symbol, is_enabled, surcharge_percentage, created_at) VALUES ('c0000000-0000-4000-8000-000000000001', 'SAR', 'SAR', 1, 10, 1)`),
    env.USAGE.prepare(`INSERT INTO exchange_rates_cache (id, base_currency, target_currency, rate, last_updated, created_at) VALUES ('c0000000-0000-4000-8000-000000000002', 'EUR', 'SAR', 4, 1, 1)`),
    env.USAGE.prepare(`INSERT INTO settings_payment_terms (id, title, description, is_active, is_default, created_at, updated_at) VALUES ('de000000-0000-4000-8000-000000000001', 'Thirty days', 'Pay within 30 days.', 1, 1, 1, 1)`),
    env.USAGE.prepare(`INSERT INTO corporate_entities (id, name, is_default) VALUES ('ce000000-0000-4000-8000-000000000001', 'Envisioning', 1)`),
  ]);
}

const newService = (name = 'Signals Session', extra: Row = {}) => ok<CatalogServiceResponse>('POST', '/api/crm/services', {
  name, description: `${name}, whole.`, summary: `${name}.`, price: 7500, is_public: true, group_type: 'Research', ...extra,
});

async function draftWithLine(): Promise<{ id: string; service: string; line: string }> {
  const { service } = await newService();
  const created = await ok<OfferResponse>('POST', '/api/crm/offers', { lead_id: LEAD, title: 'First', valid_until: FUTURE });
  const withLine = await ok<OfferResponse>('POST', `/api/crm/offers/${created.offer.id}/lines`, { service_id: service.id });
  return { id: created.offer.id, service: service.id, line: withLine.lines[0]!.id };
}

beforeEach(async () => {
  await clear();
  await seed();
  const session = await invoke(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, name: 'Ana' }),
  }), d1);
  token = (await session.json<{ access_token: string }>()).access_token;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await clear();
});

describe('the migration and the group copy', () => {
  it('keeps D1\'s own columns out of the copy, and a copied row takes their defaults', async () => {
    for (const [table, columns] of Object.entries(COMMERCIAL_D1_COLUMNS)) {
      for (const column of Object.keys(columns)) expect(TABLE_SPECS[table]!.columns, `${table}.${column}`).not.toContain(column);
    }
    expect(TABLE_SPECS.organizations!.columns).not.toContain('default_discount_percentage');
    expect(await one(`SELECT 1 AS found FROM sqlite_master WHERE name = 'offer_versions'`)).toEqual({ found: 1 });

    const offers = [{ id: '0f000000-0000-4000-8000-0000000000c1', status: 'sent', total_amount: '10', organization_id: ORG, created_at: '2025-01-01T00:00:00+00:00' }];
    const services = [{ id: '5e000000-0000-4000-8000-0000000000c1', name: 'Radar', description: 'Radar.', price: '1', summary: 'Radar.', is_public: true, allow_multiple: false, is_default: false, allow_description_override: false }];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(new Request(input).url);
      const table = url.searchParams.get('table');
      return Response.json({ rows: table === 'offers' ? offers : table === 'services' ? services : [], has_more: false });
    });
    const onCore = { ...coreHolds, CORE_API_ORIGIN: 'https://core.test', CRM_SYNC_MODE: 'on' } as Env;
    await freezeGroup(onCore, 'commercial');
    await copyGroup(onCore, 'commercial');
    expect(await one('SELECT status, unsent_draft, has_unsent_changes, accepted_version, notes FROM offers WHERE id = ?1', offers[0]!.id))
      .toEqual({ status: 'sent', unsent_draft: 0, has_unsent_changes: 0, accepted_version: null, notes: null });
    expect(await one('SELECT slug, is_listed, name_pt FROM services WHERE id = ?1', services[0]!.id)).toEqual({ slug: null, is_listed: 0, name_pt: null });

    // A second copy keeps what D1 wrote.
    await run('UPDATE services SET slug = ?2 WHERE id = ?1', services[0]!.id, 'radar');
    await copyGroup(onCore, 'commercial');
    expect(await one('SELECT slug FROM services WHERE id = ?1', services[0]!.id)).toEqual({ slug: 'radar' });
  });

  it('pins the registry to its fixture', () => {
    expect(offerValues).toEqual({
      version: 1,
      statuses: [...OFFER_STATUSES],
      statusLabels: OFFER_STATUS_LABELS,
      serviceGroups: [...SERVICE_GROUP_TYPES],
      serviceGroupLabels: SERVICE_GROUP_LABELS,
      serviceCategories: [...SERVICE_CATEGORIES],
      recurringIntervals: [...SERVICE_RECURRING_INTERVALS],
    });
  });

  it('computes Core\'s totals', () => {
    const totals = computeOfferTotals([
      { price: 1000, quantity: 2, is_recurring: true },
      { price: 500, quantity: 1, is_optional: true },
    ], { globalDiscountPct: 50, taxPct: 21, currency: 'SAR', rate: 4.4 });
    expect(totals).toMatchObject({ subtotal_eur: 2000, discount_eur: 1000, total_eur: 1000, tax_eur: 210, grand_total_eur: 1210, optional_total_eur: 500, recurring_total_eur: 1000, indicative: true, subtotal: 8800, discount: 4400, total: 4400 });
  });
});

describe('on a Core workspace while Core holds the group', () => {
  it('refuses every route with 409 before any write, and the descriptor names the group', async () => {
    const before = await one('SELECT COUNT(*) AS n FROM offers');
    for (const [method, path, body] of [
      ['GET', '/api/crm/services'],
      ['POST', '/api/crm/services', { name: 'X', description: 'X', summary: 'X', price: 1 }],
      ['GET', '/api/crm/offer-options'],
      ['POST', '/api/crm/offers', { organization_id: ORG }],
      ['GET', `/api/crm/offers/${LEAD}`],
      ['POST', `/api/crm/offers/${LEAD}/send`],
    ] as const) {
      const error = await refused(409, method, path, body, coreHolds);
      expect(error).not.toMatch(/core/iu);
    }
    expect(await one('SELECT COUNT(*) AS n FROM offers')).toEqual(before);
    expect(await one('SELECT COUNT(*) AS n FROM services')).toEqual({ n: 0 });
    const onCore = { ...coreHolds, CRM_SYNC_MODE: 'on', CORE_API_ORIGIN: 'https://core.test' } as Env;
    expect(workspaceServices(onCore).core_groups).toContain('commercial');
    expect(workspaceServices({ ...onCore, WORK_STORE_COMMERCIAL: 'd1' } as Env).core_groups).not.toContain('commercial');
  });

  it('refuses the read door while Core holds the group, and writes after the flip', async () => {
    const closed = await door('core-reads', { op: 'commercial_rows', table: 'offers' }, coreHolds);
    expect(closed.status).toBe(409);
    await run(`UPDATE workspace_settings SET value = '{"on":["offers"]}'`);
    const created = await hit('POST', '/api/crm/offers', { organization_id: ORG }, flipped);
    expect(created.status).toBe(201);
  });

  it('answers 503 during the freeze, so no write lands', async () => {
    await run(`INSERT INTO work_group_moves (work_group, frozen, updated_at) VALUES ('commercial', 1, 1)`);
    expect((await hit('POST', '/api/crm/offers', { organization_id: ORG }, flipped)).status).toBe(503);
  });
});

describe('the work module', () => {
  it('refuses when Offers is off', async () => {
    await run(`UPDATE workspace_settings SET value = '{"on":[]}'`);
    await refused(409, 'GET', '/api/crm/services');
  });

  it('lists a subject\'s offers on a D1 workspace once the module is on', async () => {
    const { offer } = await ok<OfferResponse>('POST', '/api/crm/offers', { lead_id: LEAD });
    const list = await ok<{ offers: Array<{ id: string; status: string }> }>('GET', `/api/crm/subjects/lead/${LEAD}/commercial`);
    expect(list.offers?.map((row) => [row.id, row.status])).toEqual([[offer.id, 'draft']]);
  });
});

describe('creating a draft', () => {
  it('takes the contact, the trigger\'s defaults and the partner discount', async () => {
    await ok('PATCH', `/api/crm/organizations/${ORG}/default-discount`, { default_discount_percentage: 50 });
    const answer = offerResponseSchema.parse(await ok('POST', '/api/crm/offers', { lead_id: LEAD }));
    expect(answer.offer).toMatchObject({
      status: 'draft', shown_status: 'draft', link: null, next_send: 'send', locked: false,
      organization_id: ORG, recipient_email: 'buyer@acme.test',
      global_discount_percentage: 50, discount_reason: 'Partner Discount',
      payment_terms_text: 'Pay within 30 days.', corporate_entity_id: 'ce000000-0000-4000-8000-000000000001',
    });
    expect(await one(`SELECT actor, table_name, action FROM work_activity WHERE table_name = 'offers'`)).toEqual({ actor: EMAIL, table_name: 'offers', action: 'insert' });
    const elsewhere = await ok<OfferResponse>('POST', '/api/crm/offers', { organization_id: OTHER_ORG });
    expect(elsewhere.offer.global_discount_percentage).toBeNull();
    expect((await one('SELECT default_discount_reason AS reason FROM organizations WHERE id = ?1', ORG))!.reason).toBe('Partner Discount');
  });

  it('refuses a body with no subject, a total, a status, or a currency that is off', async () => {
    await refused(400, 'POST', '/api/crm/offers', {});
    await refused(400, 'POST', '/api/crm/offers', { organization_id: ORG, total_amount: 1 });
    await refused(400, 'POST', '/api/crm/offers', { organization_id: ORG, status: 'sent' });
    await refused(422, 'POST', '/api/crm/offers', { organization_id: ORG, currency: 'USD' });
    await refused(404, 'POST', '/api/crm/offers', { lead_id: ORG });
  });
});

describe('lines and totals', () => {
  it('recomputes every total on the server', async () => {
    const { id, line } = await draftWithLine();
    let answer = await ok<OfferResponse>('GET', `/api/crm/offers/${id}`);
    expect(answer.lines[0]).toMatchObject({ name: 'Signals Session', price: 7500, group_type: 'Research', is_custom: false });
    expect(answer.totals.total_eur).toBe(7500);
    expect(answer.offer.total_amount).toBe(7500);

    answer = await ok<OfferResponse>('PATCH', `/api/crm/offers/${id}/lines/${line}`, { quantity: 2 });
    expect(answer.offer.total_amount).toBe(15000);
    answer = await ok<OfferResponse>('POST', `/api/crm/offers/${id}/lines`, { custom_title: 'Travel', price: 1000, is_optional: true });
    expect(answer.totals).toMatchObject({ total_eur: 15000, optional_total_eur: 1000 });
    answer = await ok<OfferResponse>('PATCH', `/api/crm/offers/${id}`, { global_discount_percentage: 10, tax_percentage: 21 });
    expect(answer.totals).toMatchObject({ discount_eur: 1500, total_eur: 13500, tax_eur: 2835 });
    expect(answer.offer.total_amount).toBe(13500);

    answer = await ok<OfferResponse>('DELETE', `/api/crm/offers/${id}/lines/${line}`);
    expect(answer.offer.total_amount).toBe(0);
    expect(answer.lines).toHaveLength(1);
  });

  it('holds the offer rules', async () => {
    const { id, service, line } = await draftWithLine();
    await refused(409, 'PATCH', `/api/crm/offers/${id}/lines/${line}`, { custom_title: 'Renamed' });
    await refused(409, 'POST', `/api/crm/offers/${id}/lines`, { service_id: service }, d1);
    await refused(409, 'POST', `/api/crm/offers/${id}/lines`, { service_id: (await newService('Other')).service.id, custom_description: 'Mine' });
    await refused(400, 'POST', `/api/crm/offers/${id}/lines`, { custom_title: 'No price' });
    await refused(400, 'POST', `/api/crm/offers/${id}/lines`, { service_id: service, custom_title: 'Both', price: 1 });
    await refused(400, 'POST', `/api/crm/offers/${id}/lines`, { service_id: service, quantity: 0 });
    await refused(404, 'PATCH', `/api/crm/offers/${id}/lines/${LEAD}`, { quantity: 2 });
    await refused(400, 'PATCH', `/api/crm/offers/${id}`, { total_amount: 1 });
  });

  it('finds a catalog line by slug, and leaves a line\'s words alone when the catalog changes', async () => {
    const { service } = await newService('Slugged', { slug: 'slugged', allow_description_override: true });
    const { offer } = await ok<OfferResponse>('POST', '/api/crm/offers', { lead_id: LEAD });
    const answer = await ok<OfferResponse>('POST', `/api/crm/offers/${offer.id}/lines`, { service_slug: 'slugged', custom_description: 'Mine' });
    expect(answer.lines[0]).toMatchObject({ service_id: service.id, description: 'Mine' });
    await ok('PATCH', `/api/crm/services/${service.id}`, { price: 1, description: 'New words.' });
    const read = await ok<OfferResponse>('GET', `/api/crm/offers/${offer.id}`);
    expect(read.lines[0]).toMatchObject({ price: 7500, description: 'Mine' });
  });
});

describe('Send, versions and the buyer\'s door', () => {
  it('checks before it sends, and a draft is closed to a buyer', async () => {
    const { offer } = await ok<OfferResponse>('POST', '/api/crm/offers', { organization_id: OTHER_ORG });
    expect(await buyerReads('offers', { id: offer.id })).toEqual([]);
    await refused(422, 'POST', `/api/crm/offers/${offer.id}/send`);
    const { service } = await newService();
    await ok('POST', `/api/crm/offers/${offer.id}/lines`, { service_id: service.id });
    expect(await buyerReads('offer_services', { offer_id: offer.id })).toEqual([]);
    expect(await refused(422, 'POST', `/api/crm/offers/${offer.id}/send`)).toMatch(/who the offer is for/u);
    await ok('PATCH', `/api/crm/offers/${offer.id}`, { recipient_email: 'x@other.test' });
    expect(await refused(422, 'POST', `/api/crm/offers/${offer.id}/send`)).toMatch(/valid-until/u);
    await ok('PATCH', `/api/crm/offers/${offer.id}`, { valid_until: '2020-01-01' });
    await refused(422, 'POST', `/api/crm/offers/${offer.id}/send`);
    await ok('PATCH', `/api/crm/offers/${offer.id}`, { valid_until: FUTURE, currency: 'SAR' });
    await run(`DELETE FROM exchange_rates_cache`);
    expect(await refused(422, 'POST', `/api/crm/offers/${offer.id}/send`)).toMatch(/no rate/u);
    expect((await door('core-writes', { entity: 'commercial', action: 'update', table: 'offers', id: offer.id, values: { is_accepted: true } })).status).toBe(409);
  });

  it('freezes on Send, an edit stays unsent, and Send update is a new version on the same link', async () => {
    const { id, line } = await draftWithLine();
    const sent = offerSendResponseSchema.parse(await ok<OfferSendResponse>('POST', `/api/crm/offers/${id}/send`));
    expect(sent).toMatchObject({ version: 1, link: offerLink(d1, id) });
    expect(sent.link).toContain(`/private/offer/${id}`);
    expect(offerLink({ ...d1, CORE_WEB_ORIGIN: 'https://www.org.example' } as Env, id)).toBe(`https://www.org.example/private/offer/${id}`);
    expect(sent.offer).toMatchObject({ status: 'sent', has_unsent_changes: false, next_send: null, link: sent.link });
    expect(sent.versions).toMatchObject([{ version: 1, sent_by: EMAIL, total_eur: 7500, currency: 'EUR', rate: 1 }]);
    await refused(409, 'POST', `/api/crm/offers/${id}/send`);
    await refused(409, 'POST', `/api/crm/offers/${id}/send-update`);
    expect(await one(`SELECT actor, label FROM work_activity WHERE table_name = 'offer_versions'`)).toEqual({ actor: EMAIL, label: 'Version 1' });

    const servedBefore = await buyerReads('offers', { id });
    expect(servedBefore[0]).toMatchObject({ title: 'First', total_amount: 7500, served_version: 1 });

    const edited = await ok<OfferResponse>('PATCH', `/api/crm/offers/${id}`, { title: 'Second', valid_until: '2099-01-01', notes: 'Unsent' });
    expect(edited.offer).toMatchObject({ has_unsent_changes: true, next_send: 'send_update', status: 'sent' });
    await ok('PATCH', `/api/crm/offers/${id}/lines/${line}`, { quantity: 3 });
    await ok('POST', `/api/crm/offers/${id}/lines`, { custom_title: 'Added', price: 100 });

    // The edit changes nothing a buyer reads.
    const served = (await buyerReads('offers', { id }))[0]!;
    expect(served).toMatchObject({ title: 'First', total_amount: 7500, served_version: 1, notes: null });
    expect(served.valid_until).toBe(servedBefore[0]!.valid_until);
    const lines = await buyerReads('offer_services', { offer_id: id });
    expect(lines.map((row) => [row.snapshot_name, row.quantity])).toEqual([['Signals Session', 1]]);
    expect(lines[0]!.is_optional).toBe(false);

    const update = await ok<OfferSendResponse>('POST', `/api/crm/offers/${id}/send-update`);
    expect(update).toMatchObject({ version: 2, link: sent.link });
    expect(update.offer.has_unsent_changes).toBe(false);
    expect((await buyerReads('offers', { id }))[0]).toMatchObject({ title: 'Second', served_version: 2, total_amount: 22600, notes: 'Unsent' });
    expect(await buyerReads('offer_services', { offer_id: id })).toHaveLength(2);

    // An earlier version stays readable, to a buyer and a member.
    expect((await buyerReads('offers', { id }, 1))[0]).toMatchObject({ title: 'First', served_version: 1 });
    expect(await buyerReads('offer_services', { offer_id: id }, 1)).toHaveLength(1);
    expect(await buyerReads('offers', { id }, 9)).toEqual([]);
    const v1 = offerVersionResponseSchema.parse(await ok('GET', `/api/crm/offers/${id}/versions/1`));
    expect(v1.offer.title).toBe('First');
    expect(v1.lines).toHaveLength(1);
    await refused(404, 'GET', `/api/crm/offers/${id}/versions/9`);
  });

  it('freezes the rate on Send: EUR is binding, the other currency indicative', async () => {
    const { id } = await draftWithLine();
    const before = await ok<OfferResponse>('PATCH', `/api/crm/offers/${id}`, { currency: 'SAR' });
    expect(before.totals).toMatchObject({ currency: 'SAR', rate: 4.4, rate_frozen: false, indicative: true, total_eur: 7500, total: 33000 });
    const sent = await ok<OfferSendResponse>('POST', `/api/crm/offers/${id}/send`);
    expect(sent.totals).toMatchObject({ rate_frozen: true, rate: 4.4, total_eur: 7500 });
    expect(sent.offer.total_amount).toBe(7500);
    await run(`UPDATE exchange_rates_cache SET rate = 9`);
    const later = await ok<OfferResponse>('GET', `/api/crm/offers/${id}`);
    expect(later.totals.rate).toBe(4.4);
  });

  it('a buyer\'s own writes stay live, an extension reaches the version, and Core\'s draft stays open', async () => {
    const { id } = await draftWithLine();
    await ok(`POST`, `/api/crm/offers/${id}/send`);
    await ok('PATCH', `/api/crm/offers/${id}`, { title: 'Unsent' });
    await coreWrites({ action: 'update', table: 'offers', id, values: { status: 'viewed' }, only_if: { status: 'sent' } });
    await coreWrites({ action: 'update', table: 'offers', id, values: { billing_po_number: 'PO-1' } });
    const extended = new Date(Date.now() + 90 * 86_400_000).toISOString();
    await coreWrites({ action: 'update', table: 'offers', id, values: { valid_until: extended } });
    expect((await buyerReads('offers', { id }))[0]).toMatchObject({ status: 'viewed', billing_po_number: 'PO-1', title: 'First', valid_until: extended });

    // A self-submitted pricing request is a draft its buyer reads and accepts.
    const pricing = await coreWrites({ action: 'create', table: 'offers', values: { status: 'draft', total_amount: 5, is_self_submitted: true, organization_id: ORG } });
    expect((await buyerReads('offers', { id: pricing!.id }))[0]).toMatchObject({ status: 'draft', served_version: null });
  });

  it('a Core-sent offer with no version gets one before its first edit', async () => {
    const copied = await coreWrites({ action: 'create', table: 'offers', values: { status: 'sent', total_amount: 100, title: 'Legacy', organization_id: ORG, valid_until: new Date(Date.now() + 86_400_000).toISOString() } });
    const id = String(copied!.id);
    const line = await coreWrites({ action: 'create', table: 'offer_services', values: { offer_id: id, is_custom: true, custom_title: 'Old', quantity: 1, price: 100 } });
    let read = await ok<OfferResponse>('GET', `/api/crm/offers/${id}`);
    expect(read.offer).toMatchObject({ next_send: 'send_update', link: offerLink(d1, id) });
    expect(read.versions).toEqual([]);

    read = await ok<OfferResponse>('PATCH', `/api/crm/offers/${id}/lines/${String(line!.id)}`, { price: 900 });
    expect(read.versions).toMatchObject([{ version: 1, sent_by: null }]);
    const lines = await buyerReads('offer_services', { offer_id: id });
    expect(lines.map((row) => [row.snapshot_name, row.price])).toEqual([['Old', 100]]);
    expect((await buyerReads('offers', { id }))[0]).toMatchObject({ title: 'Legacy', total_amount: 100, served_version: 1 });
  });
});

describe('accept and reject', () => {
  it('locks on accept, on the version the buyer read, and unsent edits go back', async () => {
    const { id, service } = await draftWithLine();
    await ok('POST', `/api/crm/offers/${id}/lines`, { custom_title: 'Maybe', price: 500, is_optional: true });
    const sent = await ok<OfferSendResponse>('POST', `/api/crm/offers/${id}/send`);
    const optional = sent.lines.find((line) => line.is_optional)!;
    await ok('PATCH', `/api/crm/offers/${id}`, { title: 'Unsent title', notes: 'Unsent' });
    await ok('POST', `/api/crm/offers/${id}/lines`, { custom_title: 'Unsent line', price: 1 });

    const accepted = await ok<OfferResponse>('POST', `/api/crm/offers/${id}/decision`, {
      decision: 'accept', accepted_by_name: 'Buyer', accepted_by_email: 'buyer@acme.test', selected_optional_ids: [optional.id, LEAD],
    });
    expect(accepted.offer).toMatchObject({
      status: 'accepted', is_accepted: true, locked: true, next_send: null, accepted_version: 1, has_unsent_changes: false,
      title: 'First', notes: null, accepted_by_name: 'Buyer', total_amount: 8000,
    });
    expect(accepted.lines.map((line) => [line.name, line.is_optional])).toEqual(expect.arrayContaining([['Signals Session', false], ['Maybe', false]]));
    expect(accepted.lines).toHaveLength(2);

    for (const [method, path, body] of [
      ['PATCH', `/api/crm/offers/${id}`, { title: 'Late' }],
      ['POST', `/api/crm/offers/${id}/lines`, { service_id: service }],
      ['PATCH', `/api/crm/offers/${id}/lines/${optional.id}`, { quantity: 9 }],
      ['DELETE', `/api/crm/offers/${id}/lines/${optional.id}`],
      ['POST', `/api/crm/offers/${id}/send-update`],
      ['POST', `/api/crm/offers/${id}/decision`, { decision: 'reject' }],
    ] as const) await refused(409, method, path, body);

    // Any offer can be duplicated, an accepted one too.
    const copy = await ok<OfferResponse>('POST', `/api/crm/offers/${id}/duplicate`, {});
    expect(copy.offer).toMatchObject({ status: 'draft', title: null });
  });

  it('records a version on Core\'s accept too, and refuses a draft', async () => {
    const { id } = await draftWithLine();
    await refused(409, 'POST', `/api/crm/offers/${id}/decision`, { decision: 'accept' });
    await refused(409, 'POST', `/api/crm/offers/${id}/decision`, { decision: 'reject' });
    await ok('POST', `/api/crm/offers/${id}/send`);
    await ok('PATCH', `/api/crm/offers/${id}`, { title: 'Unsent' });
    await coreWrites({ action: 'update', table: 'offers', id, values: { is_accepted: true, status: 'accepted' }, unless: { is_accepted: true } });
    expect(await one('SELECT accepted_version, has_unsent_changes, title FROM offers WHERE id = ?1', id)).toEqual({ accepted_version: 1, has_unsent_changes: 0, title: 'First' });
  });

  it('records a reject, and Send update reopens it', async () => {
    const { id } = await draftWithLine();
    await ok('POST', `/api/crm/offers/${id}/send`);
    const declined = await ok<OfferResponse>('POST', `/api/crm/offers/${id}/decision`, { decision: 'reject' });
    expect(declined.offer).toMatchObject({ status: 'declined', shown_status: 'declined', locked: false });
    await ok('PATCH', `/api/crm/offers/${id}`, { title: 'Better' });
    expect((await ok<OfferSendResponse>('POST', `/api/crm/offers/${id}/send-update`)).offer.status).toBe('sent');
  });
});

describe('an accept makes the license and the project', () => {
  type Decision = OfferResponse & { license_id: string | null; license_created: boolean; project_id: string | null; project_created: boolean };
  const yearly = (name = 'Platform') => newService(name, { is_recurring: true, recurring_interval: 'yearly', price: 10000, group_type: 'License' }).then((answer) => answer.service.id);

  async function sentOffer(subject: Row, lines: Row[]): Promise<string> {
    const { offer } = await ok<OfferResponse>('POST', '/api/crm/offers', { ...subject, title: 'Deal', valid_until: FUTURE, ...('organization_id' in subject ? {} : {}) });
    for (const line of lines) await ok('POST', `/api/crm/offers/${offer.id}/lines`, line);
    if ('organization_id' in subject) await ok('PATCH', `/api/crm/offers/${offer.id}`, { recipient_email: 'x@other.test' });
    await ok('POST', `/api/crm/offers/${offer.id}/send`);
    return offer.id;
  }

  it('answers the ids, with Core\'s license fields, project and Closed Won, and a kick-off task', async () => {
    const service = await yearly();
    await run(`UPDATE leads SET title = 'Pilot deal', status = 'Proposal' WHERE id = ?1`, LEAD);
    const id = await sentOffer({ lead_id: LEAD }, [{ service_id: service }, { custom_title: 'Setup', price: 500 }]);
    await ok('PATCH', `/api/crm/offers/${id}`, { global_discount_percentage: 10 });
    await ok('POST', `/api/crm/offers/${id}/send-update`);
    const answer = offerDecisionResponseSchema.parse(await ok<Decision>('POST', `/api/crm/offers/${id}/decision`, { decision: 'accept' }));
    expect(answer).toMatchObject({ license_created: true, project_created: true });
    expect(answer.offer.locked).toBe(true);

    const created = String((await one('SELECT created_at FROM offers WHERE id = ?1', id))!.created_at);
    const start = new Date(Number(created)).toISOString().slice(0, 10);
    expect(await one('SELECT id, organization_id, lead_id, offer_id, amount_eur, is_active, product, start_date, renewal_date FROM licenses')).toEqual({
      id: answer.license_id, organization_id: ORG, lead_id: LEAD, offer_id: id, amount_eur: 9000, is_active: 1, product: 'other',
      start_date: start, renewal_date: `${Number(start.slice(0, 4)) + 1}${start.slice(4)}`,
    });
    expect(await one('SELECT license_id, offer_id FROM license_offers')).toEqual({ license_id: answer.license_id, offer_id: id });
    expect(await one('SELECT id, title, organization_id, lead_id, status FROM projects')).toEqual({ id: answer.project_id, title: 'Pilot deal', organization_id: ORG, lead_id: LEAD, status: 'Active' });
    expect(await one('SELECT status FROM leads WHERE id = ?1', LEAD)).toEqual({ status: 'Closed Won' });
    const task = await one('SELECT title, status, responsible_party, priority, project_id, lead_id, tags FROM tasks');
    expect(task).toMatchObject({ title: 'Kick off delivery: Deal', status: 'proposed', responsible_party: 'team', priority: 'high', project_id: answer.project_id, lead_id: null });
    expect(JSON.parse(String(task!.tags))).toEqual(['proposed', `crm-event:offer:${id}:offer.accepted`]);
    for (const table of ['licenses', 'license_offers', 'projects', 'leads', 'tasks']) {
      expect((await one('SELECT COUNT(*) AS n FROM work_activity WHERE table_name = ?1', table))!.n, table).toBe(1);
    }
  });

  it('a repeated decision answers 409 and makes nothing twice', async () => {
    const id = await sentOffer({ lead_id: LEAD }, [{ service_id: await yearly() }]);
    await ok('POST', `/api/crm/offers/${id}/decision`, { decision: 'accept' });
    expect(await refused(409, 'POST', `/api/crm/offers/${id}/decision`, { decision: 'accept' })).toMatch(/accepted/u);
    await refused(409, 'POST', `/api/crm/offers/${id}/decision`, { decision: 'reject' });
    for (const table of ['licenses', 'license_offers', 'projects', 'tasks']) {
      expect((await one(`SELECT COUNT(*) AS n FROM "${table}"`))!.n, table).toBe(1);
    }
    // Core's door, racing the same accept, matches no row and answers null.
    expect(await coreWrites({ action: 'update', table: 'offers', id, values: { is_accepted: true, status: 'accepted' }, unless: { is_accepted: true } })).toBeNull();
    expect((await one('SELECT COUNT(*) AS n FROM licenses'))!.n).toBe(1);
  });

  it('keeps a license and a project that stand, and leaves the lead\'s status', async () => {
    const id = await sentOffer({ lead_id: LEAD }, [{ service_id: await yearly() }]);
    const licenseId = '11000000-0000-4000-8000-0000000000d1';
    const projectId = '9a000000-0000-4000-8000-0000000000d1';
    await run(`INSERT INTO licenses (id, created_at, updated_at, offer_id, start_date, renewal_date) VALUES (?1, 1, 1, ?2, '2026-01-01', '2027-01-01')`, licenseId, id);
    await run(`INSERT INTO projects (id, lead_id, title, status, created_at, updated_at) VALUES (?1, ?2, 'By hand', 'Active', 1, 1)`, projectId, LEAD);
    const answer = await ok<Decision>('POST', `/api/crm/offers/${id}/decision`, { decision: 'accept' });
    expect(answer).toMatchObject({ license_id: licenseId, license_created: false, project_id: projectId, project_created: false });
    expect((await one('SELECT COUNT(*) AS n FROM licenses'))!.n).toBe(1);
    expect((await one('SELECT COUNT(*) AS n FROM projects'))!.n).toBe(1);
    expect(await one('SELECT status FROM leads WHERE id = ?1', LEAD)).toEqual({ status: 'Proposal' });
    expect(await one('SELECT project_id, lead_id FROM tasks')).toEqual({ project_id: null, lead_id: LEAD });
  });

  it('a license linked through license_offers stands too', async () => {
    const id = await sentOffer({ lead_id: LEAD }, [{ service_id: await yearly() }]);
    const licenseId = '11000000-0000-4000-8000-0000000000d2';
    await run(`INSERT INTO licenses (id, created_at, updated_at, start_date, renewal_date) VALUES (?1, 1, 1, '2026-01-01', '2027-01-01')`, licenseId);
    await run(`INSERT INTO license_offers (license_id, offer_id, created_at) VALUES (?1, ?2, 1)`, licenseId, id);
    const answer = await ok<Decision>('POST', `/api/crm/offers/${id}/decision`, { decision: 'accept' });
    expect(answer).toMatchObject({ license_id: licenseId, license_created: false });
    expect((await one('SELECT COUNT(*) AS n FROM licenses'))!.n).toBe(1);
  });

  it('makes no license with no recurring amount, and no project or task with no lead', async () => {
    const id = await sentOffer({ organization_id: OTHER_ORG }, [{ custom_title: 'Once', price: 100 }]);
    const answer = await ok<Decision>('POST', `/api/crm/offers/${id}/decision`, { decision: 'accept' });
    expect(answer).toMatchObject({ license_id: null, license_created: false, project_id: null, project_created: false });
    for (const table of ['licenses', 'projects', 'tasks']) expect((await one(`SELECT COUNT(*) AS n FROM "${table}"`))!.n, table).toBe(0);
  });

  it('counts a taken optional line, leaves one not taken, and starts from the agreement', async () => {
    const taken = await yearly('Taken');
    const skipped = await yearly('Skipped');
    const id = await sentOffer({ lead_id: LEAD }, [{ service_id: taken, is_optional: true }, { service_id: skipped, is_optional: true }, { custom_title: 'Base', price: 50 }]);
    await run(`UPDATE offers SET agreement_start_date = '2028-02-29' WHERE id = ?1`, id);
    const lines = (await ok<OfferResponse>('GET', `/api/crm/offers/${id}`)).lines;
    const takenLine = lines.find((line) => line.name === 'Taken')!;
    const answer = await ok<Decision>('POST', `/api/crm/offers/${id}/decision`, { decision: 'accept', selected_optional_ids: [takenLine.id] });
    expect(answer.lines.find((line) => line.name === 'Taken')!.is_optional).toBe(false);
    expect(answer.lines.find((line) => line.name === 'Skipped')!.is_optional).toBe(true);
    expect(await one('SELECT amount_eur, start_date, renewal_date FROM licenses')).toEqual({ amount_eur: 10000, start_date: '2028-02-29', renewal_date: '2029-02-28' });
  });

  it('prices the license from the version the buyer read, not unsent edits', async () => {
    const id = await sentOffer({ lead_id: LEAD }, [{ service_id: await yearly() }]);
    await ok('PATCH', `/api/crm/offers/${id}`, { global_discount_percentage: 90, title: 'Unsent' });
    await ok<Decision>('POST', `/api/crm/offers/${id}/decision`, { decision: 'accept' });
    expect(await one('SELECT amount_eur FROM licenses')).toEqual({ amount_eur: 10000 });
    expect(await one('SELECT title, global_discount_percentage FROM offers WHERE id = ?1', id)).toEqual({ title: 'Deal', global_discount_percentage: null });
  });

  it('leaves nothing locked when any part fails, and a retry lands', async () => {
    const id = await sentOffer({ lead_id: LEAD }, [{ service_id: await yearly() }]);
    await run(`CREATE TRIGGER no_project BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT, 'no project'); END`);
    try {
      const failed = await hit('POST', `/api/crm/offers/${id}/decision`, { decision: 'accept' }).catch(() => null);
      expect(failed?.ok ?? false).toBe(false);
    } finally {
      await run(`DROP TRIGGER no_project`);
    }
    expect(await one('SELECT is_accepted, status FROM offers WHERE id = ?1', id)).toEqual({ is_accepted: 0, status: 'sent' });
    for (const table of ['licenses', 'license_offers', 'projects', 'tasks']) expect((await one(`SELECT COUNT(*) AS n FROM "${table}"`))!.n, table).toBe(0);
    expect(await one('SELECT status FROM leads WHERE id = ?1', LEAD)).toEqual({ status: 'Proposal' });
    expect((await ok<Decision>('POST', `/api/crm/offers/${id}/decision`, { decision: 'accept' })).project_created).toBe(true);
  });

  it('Core\'s accept through the door is the same accept, and Core\'s later steps find the rows', async () => {
    const id = await sentOffer({ lead_id: LEAD }, [{ service_id: await yearly() }]);
    const answer = await coreWrites({
      action: 'update', table: 'offers', id,
      values: { is_accepted: true, status: 'accepted', accepted_at: new Date().toISOString(), accepted_by_name: 'Signer', accepted_metadata: { selected_optional_ids: [], accepted_source: 'public' }, total_amount: 10000 },
      unless: { is_accepted: true },
    });
    expect(answer).toMatchObject({ is_accepted: true, status: 'accepted' });
    const license = (await buyerReads('licenses', { offer_id: id }))[0]!;
    expect(license.amount_eur).toBe(10000);
    expect(String((await one('SELECT notes FROM tasks'))!.notes)).toContain('Signer accepted');
    expect((await one('SELECT COUNT(*) AS n FROM projects WHERE lead_id = ?1', LEAD))!.n).toBe(1);
    const refused409 = await hit('POST', `/api/crm/offers/${id}/decision`, { decision: 'accept' });
    expect(refused409.status).toBe(409);
  });

  it('a reject makes nothing and answers no ids', async () => {
    const id = await sentOffer({ lead_id: LEAD }, [{ service_id: await yearly() }]);
    const answer = await ok<Decision>('POST', `/api/crm/offers/${id}/decision`, { decision: 'reject' });
    expect(answer).toMatchObject({ license_id: null, license_created: false, project_id: null, project_created: false });
    expect((await one('SELECT COUNT(*) AS n FROM licenses'))!.n).toBe(0);
  });

  it('answers the ids through MCP', async () => {
    const signed = { ...d1, SESSION_SIGNING_SECRET: 'offers-mcp-signing-secret-at-least-32-chars' } as Env;
    const id = await sentOffer({ lead_id: LEAD }, [{ service_id: await yearly() }]);
    const context = createExecutionContext();
    const response = await worker.fetch(new Request('http://local/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${await mcpBearer(signed)}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'offer_record_decision', arguments: { offer: id, decision: 'accept' } } }),
    }), signed, context);
    await waitOnExecutionContext(context);
    const body = await response.json<{ result: { content: Array<{ text: string }> } }>();
    const answer = JSON.parse(body.result.content[0]!.text) as Decision;
    expect(answer.license_created).toBe(true);
    expect(answer.project_id).toBe((await one('SELECT id FROM projects'))!.id);
  });
});

describe('duplicate', () => {
  it('copies lines, discount, notes, terms and entity to a draft on another organization', async () => {
    const { id } = await draftWithLine();
    await ok('PATCH', `/api/crm/offers/${id}`, { global_discount_percentage: 50, discount_reason: 'Partner Discount', notes: 'Keep', currency: 'SAR' });
    const sent = await ok<OfferSendResponse>('POST', `/api/crm/offers/${id}/send`);
    const copy = offerResponseSchema.parse(await ok('POST', `/api/crm/offers/${id}/duplicate`, { organization_id: OTHER_ORG }));
    expect(copy.offer).toMatchObject({
      status: 'draft', title: null, organization_id: OTHER_ORG, lead_id: null, recipient_email: null, valid_until: null,
      global_discount_percentage: 50, discount_reason: 'Partner Discount', notes: 'Keep', currency: 'SAR', link: null, next_send: 'send',
      payment_terms_text: sent.offer.payment_terms_text, corporate_entity_id: sent.offer.corporate_entity_id,
    });
    expect(copy.versions).toEqual([]);
    expect(copy.totals.rate_frozen).toBe(false);
    expect(copy.lines.map((line) => line.name)).toEqual(['Signals Session']);
    expect(copy.lines[0]!.id).not.toBe(sent.lines[0]!.id);
    expect(await buyerReads('offers', { id: copy.offer.id })).toEqual([]);
  });

  it('keeps the recipient on the same subject', async () => {
    const { id } = await draftWithLine();
    const copy = await ok<OfferResponse>('POST', `/api/crm/offers/${id}/duplicate`, {});
    expect(copy.offer).toMatchObject({ lead_id: LEAD, recipient_email: 'buyer@acme.test' });
  });
});

describe('the catalog', () => {
  it('lists, creates and edits, and never renames', async () => {
    const { service } = catalogServiceResponseSchema.parse(await newService('Build Session', { slug: 'build-session', is_listed: true, name_pt: 'Sessão' }));
    expect(service).toMatchObject({ name: 'Build Session', slug: 'build-session', is_listed: true, is_public: true, name_pt: 'Sessão' });
    const listed = catalogResponseSchema.parse(await ok('GET', '/api/crm/services'));
    expect(listed.services.map((row) => row.slug)).toEqual(['build-session']);

    await refused(400, 'PATCH', `/api/crm/services/${service.id}`, { name: 'Renamed' });
    await refused(409, 'PATCH', `/api/crm/services/${service.id}`, { slug: 'other' });
    await refused(409, 'POST', '/api/crm/services', { name: 'Twin', slug: 'build-session', description: 'D', summary: 'S', price: 1 });
    await refused(400, 'POST', '/api/crm/services', { name: 'Bad', description: 'D', summary: 'S', price: -1 });
    await refused(400, 'POST', '/api/crm/services', { name: 'Bad', description: 'D', summary: 'S', price: 1, group_type: 'Core' });
    await refused(404, 'PATCH', `/api/crm/services/${LEAD}`, { price: 1 });

    const edited = await ok<CatalogServiceResponse>('PATCH', `/api/crm/services/${service.id}`, { price: 8000, is_public: false, summary_pt: 'Resumo' });
    expect(edited.service).toMatchObject({ name: 'Build Session', price: 8000, is_public: false, summary_pt: 'Resumo' });
    expect(await one(`SELECT COUNT(*) AS n FROM work_activity WHERE table_name = 'services'`)).toEqual({ n: 2 });
  });

  it('answers the editor\'s pickers', async () => {
    const options = offerOptionsResponseSchema.parse(await ok('GET', '/api/crm/offer-options'));
    expect(options.currencies.map((row) => row.code)).toEqual(['SAR']);
    expect(options.payment_terms[0]).toMatchObject({ title: 'Thirty days', is_default: true });
    expect(options.corporate_entities[0]).toMatchObject({ name: 'Envisioning', is_default: true });
  });
});

describe('Admin › Records', () => {
  let adminToken = '';
  const admin = { ...d1, ROOT_ADMIN_EMAILS: 'offers-admin@example.com' } as unknown as Env;

  const asAdmin = async (method: string, body?: unknown, workspace: Env = admin) => invoke(new Request('http://local/api/admin/records/commercial', {
    method,
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), workspace);

  beforeEach(async () => {
    const session = await invoke(new Request('http://local/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'offers-admin@example.com', name: 'Admin' }),
    }), admin);
    adminToken = (await session.json<{ access_token: string }>()).access_token;
  });

  it('refuses a member, and says not editable while Core holds the group', async () => {
    expect((await hit('GET', '/api/admin/records/commercial')).status).toBe(403);
    const onCore = { ...admin, WORK_STORE: 'core' } as Env;
    const page = await (await asAdmin('GET', undefined, onCore)).json<CommercialSettingsResponse>();
    expect(page).toMatchObject({ editable: false, settings_payment_terms: [] });
    const refusal = await asAdmin('POST', { op: 'save', table: 'policies', values: { title: 'P', description: null, effective_date: null, url: null } }, onCore);
    expect(refusal.status).toBe(409);
  });

  it('reads and saves the settings when the group is on D1', async () => {
    const read = await asAdmin('GET');
    expect(read.status).toBe(200);
    const page = commercialSettingsResponseSchema.parse(await read.json()) as CommercialSettingsResponse;
    expect(page.editable).toBe(true);
    const saved = await asAdmin('POST', { op: 'save', table: 'settings_delivery_conditions', values: { title: 'Remote', description: 'Delivered online.', is_active: true, is_default: true } });
    expect(saved.status).toBe(200);
    const after = await saved.json<CommercialSettingsResponse>();
    expect(after.settings_delivery_conditions).toHaveLength(1);
    expect(after.settings_delivery_conditions[0]).toMatchObject({ title: 'Remote', is_default: true });
    expect((await asAdmin('POST', { op: 'save', table: 'currency_settings', values: { currency_code: 'SAR', symbol: 'SAR', is_enabled: true, surcharge_percentage: 5 } })).status).toBe(409);
    expect((await asAdmin('POST', { op: 'delete', table: 'currency_settings', id: LEAD })).status).toBe(400);
    const other = await (await asAdmin('POST', { op: 'save', table: 'settings_delivery_conditions', values: { title: 'Onsite', description: 'At your office.', is_active: true, is_default: true } })).json<CommercialSettingsResponse>();
    expect(other.settings_delivery_conditions.filter((row) => row.is_default === true).map((row) => row.title)).toEqual(['Onsite']);
    const id = String(other.settings_delivery_conditions[0]!.id);
    const gone = await (await asAdmin('POST', { op: 'delete', table: 'settings_delivery_conditions', id })).json<CommercialSettingsResponse>();
    expect(gone.settings_delivery_conditions).toHaveLength(1);
  });
});

describe('MCP', () => {
  it('lists the tools only where the group answers from D1, and points at the offer guide', async () => {
    const tools = async (workspace: Env) => {
      const context = createExecutionContext();
      const response = await handleMcp(new Request('http://local/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${await mcpBearer(workspace)}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }), workspace, context, (request) => worker.fetch(request, workspace, context) as Promise<Response>);
      await waitOnExecutionContext(context);
      return (await response.json<{ result: { tools: Array<{ name: string; description: string }> } }>()).result.tools;
    };
    const signed = { ...d1, SESSION_SIGNING_SECRET: 'offers-mcp-signing-secret-at-least-32-chars' } as Env;
    const here = await tools(signed);
    expect(here.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'offer_get', 'offer_create', 'offer_add_line', 'offer_update', 'offer_duplicate', 'offer_send', 'offer_record_decision', 'service_list', 'service_create', 'service_update',
    ]));
    expect(here.find((tool) => tool.name === 'offer_create')!.description).toContain('/house/offer-style-guide');
    const onCore = await tools({ ...signed, WORK_STORE: 'core', CRM_SYNC_MODE: 'on', CORE_API_ORIGIN: 'https://core.test' } as Env);
    expect(onCore.map((tool) => tool.name)).not.toContain('offer_create');
  });

  it('builds and sends an offer end to end, without database access', async () => {
    const signed = { ...d1, SESSION_SIGNING_SECRET: 'offers-mcp-signing-secret-at-least-32-chars' } as Env;
    const bearer = await mcpBearer(signed);
    const call = async <T>(name: string, args: Row): Promise<T> => {
      const context = createExecutionContext();
      const response = await worker.fetch(new Request('http://local/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      }), signed, context);
      await waitOnExecutionContext(context);
      const body = await response.json<{ result: { isError?: boolean; content: Array<{ text: string }> } }>();
      expect(body.result.isError, body.result.content[0]!.text).toBeFalsy();
      return JSON.parse(body.result.content[0]!.text) as T;
    };
    const { service } = await call<CatalogServiceResponse>('service_create', { name: 'Signals Session', slug: 'signals-session', description: 'Session.', summary: 'S.', price: 7500, is_public: true });
    const created = await call<OfferResponse>('offer_create', { subject: `subject:lead:${LEAD}`, title: 'By agent', valid_until: FUTURE });
    const withLine = await call<OfferResponse>('offer_add_line', { offer: created.offer.id, service_slug: 'signals-session' });
    expect(withLine.lines[0]!.service_id).toBe(service.id);
    const sent = await call<OfferSendResponse>('offer_send', { offer: created.offer.id, updated_at: withLine.offer.updated_at });
    expect(sent.version).toBe(1);
    const changed = await call<OfferResponse>('offer_update', { offer: created.offer.id, title: 'Changed' });
    expect((await call<OfferSendResponse>('offer_send', { offer: created.offer.id, updated_at: changed.offer.updated_at })).version).toBe(2);
    const read = await call<OfferResponse>('offer_get', { offer: created.offer.id });
    expect(read.versions.map((version) => version.version)).toEqual([2, 1]);
    const copy = await call<OfferResponse>('offer_duplicate', { offer: created.offer.id, subject: `subject:organization:${OTHER_ORG}` });
    expect(copy.offer.organization_id).toBe(OTHER_ORG);
  });
});

async function mcpBearer(workspace: Env): Promise<string> {
  const { SignJWT } = await import('jose');
  const { signingKey } = await import('../src/crypto');
  const now = Date.now();
  await workspace.USAGE.prepare(
    `INSERT OR REPLACE INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at) VALUES ('client-offers', 'claude.ai', NULL, '["https://claude.ai/api/mcp/auth_callback"]', ?1)`,
  ).bind(now).run();
  await workspace.USAGE.prepare(
    `INSERT OR REPLACE INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at)
     VALUES ('grant-offers', 'client-offers', ?1, ?2, 'read write', 'jti', NULL, ?3, ?3, NULL, NULL)`,
  ).bind(`dev:${EMAIL}`, EMAIL, now).run();
  return new SignJWT({ email: EMAIL, name: 'Ana', scope: 'read write', grant: 'grant-offers', client: 'client-offers' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('starlings.example')
    .setAudience('meet-mcp')
    .setSubject(`dev:${EMAIL}`)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey(workspace.SESSION_SIGNING_SECRET!));
}
