// A member's licences (decided by MZ, 2026-11-05): the routes, the freeze, the
// 409 while Core holds the group, the facts Signals produces, the MCP tools, the
// mapping of Core's accounts, and the expiry reminder's one sender.
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMERCIAL_TABLES } from '@starlings/contracts/core-commercial';
import {
  licenseResponseSchema,
  licensesResponseSchema,
  planSignalsAccounts,
  signalsAccountMapResponseSchema,
  type LicenseResponse,
  type LicensesResponse,
  type OffersResponse,
} from '@starlings/contracts/licenses';
import { hmacSHA256Hex } from '../src/crypto';
import worker from '../src/index';
import { inboundKeyEnvName } from '../src/inbound-keys';
import { isReminderTick, offerReminderMail, sendOfferExpiryReminders } from '../src/offer-expiry-reminders';
import { freezeGroup } from '../src/work-group-moves';

const CORE_KEY = 'core-key-for-the-licence-tests-0123456789ab';
const ORG = '0a000000-0000-4000-8000-0000000000d1';
const LEAD = '1e000000-0000-4000-8000-0000000000d1';
const CONTACT = '2c000000-0000-4000-8000-0000000000d1';

const d1 = { ...env, WORK_STORE: 'd1', [inboundKeyEnvName('core')]: CORE_KEY } as Env;
const coreHolds = { ...d1, WORK_STORE: 'core', WORK_STORE_SUBJECTS: 'd1', WORK_STORE_TASKS: 'd1', WORK_STORE_GOALS: 'd1', WORK_STORE_INTERACTIONS: 'd1' } as Env;
const flipped = { ...coreHolds, WORK_STORE_COMMERCIAL: 'd1' } as Env;

const one = (sql: string, ...binds: unknown[]) => env.USAGE.prepare(sql).bind(...binds).first<Record<string, unknown>>();

async function invoke(request: Request, workspace: Env): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request, workspace, context);
  await waitOnExecutionContext(context);
  return response;
}

let token = '';

function hit(method: string, path: string, body?: unknown, workspace: Env = d1): Promise<Response> {
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

async function door(path: string, body: unknown, workspace: Env = flipped): Promise<Response> {
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

async function sessionFor(email: string, workspace: Env): Promise<string> {
  const session = await invoke(new Request('http://local/api/dev/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, name: 'Ana' }),
  }), workspace);
  return (await session.json<{ access_token: string }>()).access_token;
}

async function clear(): Promise<void> {
  await env.USAGE.batch([
    ...[...COMMERCIAL_TABLES].reverse(), 'interaction_contacts', 'interaction_subjects', 'interactions', 'leads', 'contacts', 'organizations', 'work_activity', 'work_group_moves', 'workspace_settings',
  ].map((table) => env.USAGE.prepare(`DELETE FROM "${table}"`)));
}

const usage = (at = '2026-11-01T00:00:00.000Z') => ({
  schema_version: 1,
  signals_org_id: 'org_1',
  snapshot_at: at,
  activity_window: { starts_at: new Date(Date.parse(at) - 30 * 86_400_000).toISOString(), ends_at: at },
  projects: { non_deleted_count: 2 },
  sessions: { created_in_window: 5, last_created_at: at },
  workflow_runs: { succeeded_in_window: 3, last_succeeded_at: null },
  results_first_viewed_at: null,
  credit_buckets: null,
});

const billing = (event: string, at: string, status: string | null = 'active') => ({
  schema_version: 1,
  event_id: `${event}-${at}`,
  event_type: event,
  occurred_at: at,
  signals_org_id: 'org_1',
  subscription: { signals_license_id: null, stripe_subscription_id: null, status, plan_key: 'pro', billing_interval: 'year', period_starts_at: null, period_ends_at: '2027-11-01T00:00:00.000Z' },
  invoice: { stripe_invoice_id: 'in_1', currency: 'EUR', amount_due_minor: 100, amount_paid_minor: 100, amount_refunded_minor: null, discount_minor: null },
  promotion: { promotion_id: null, campaign: null, status: null },
});

const created = () => ok<LicenseResponse>('POST', '/api/crm/licenses', {
  organization_id: ORG, start_date: '2026-01-01', renewal_date: '2027-01-01', product: 'signals', plan_type: 'pro', seats: 3, amount_eur: 1200,
  payment_type: 'invoice', billing_interval: 'year', notes: 'First.',
});

beforeEach(async () => {
  await clear();
  await env.USAGE.batch([
    env.USAGE.prepare(`INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?1, 'Acme', 1, 1)`).bind(ORG),
    env.USAGE.prepare(`INSERT INTO contacts (id, organization_id, name, email, created_at, updated_at) VALUES (?1, ?2, 'Buyer', 'buyer@acme.test', 1, 1)`).bind(CONTACT, ORG),
    env.USAGE.prepare(`INSERT INTO leads (id, organization_id, contact_id, title, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'Pilot', 'Proposal Out', 1, 1)`).bind(LEAD, ORG, CONTACT),
    env.USAGE.prepare(`INSERT INTO workspace_settings (key, value, updated_by, updated_at) VALUES ('work_modules', '{"on":["sales","offers","licenses"]}', 'test', 1)`),
  ]);
  token = await sessionFor('licences-ana@example.com', d1);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await clear();
});

describe('the routes', () => {
  it('creates, edits and ends, with a trail', async () => {
    const { license } = licenseResponseSchema.parse(await created());
    expect(license).toMatchObject({ product: 'signals', plan_type: 'pro', seats: 3, amount_eur: 1200, is_active: true, organization_id: ORG, payment_type: 'invoice', billing_interval: 'year', notes: 'First.', usage: null });

    const edited = await ok<LicenseResponse>('PATCH', `/api/crm/licenses/${license.id}`, { seats: 5, renewal_date: '2027-06-01', notes: null, product: 'other' });
    expect(edited.license).toMatchObject({ seats: 5, renewal_date: '2027-06-01', notes: null, product: 'other' });
    expect((await hit('PATCH', `/api/crm/licenses/${license.id}`, { renewal_date: '2025-01-01' })).status).toBe(400);

    const ended = await ok<LicenseResponse>('POST', `/api/crm/licenses/${license.id}/end`, {});
    expect(ended.license.is_active).toBe(false);
    const again = await ok<LicenseResponse>('POST', `/api/crm/licenses/${license.id}/end`, {});
    expect(again.license.is_active).toBe(false);

    const trail = await env.USAGE.prepare(`SELECT action FROM work_activity WHERE table_name = 'licenses' AND row_id = ?1 ORDER BY id`).bind(license.id).all();
    expect(trail.results.map((row) => row.action)).toEqual(['insert', 'update', 'update']);
  });

  it('takes a lead\'s organization, and needs a subject', async () => {
    const { license } = await ok<LicenseResponse>('POST', '/api/crm/licenses', { lead_id: LEAD, start_date: '2026-01-01', renewal_date: '2027-01-01' });
    expect(license).toMatchObject({ lead_id: LEAD, organization_id: ORG, product: 'other', is_active: true });
    expect((await hit('POST', '/api/crm/licenses', { start_date: '2026-01-01', renewal_date: '2027-01-01' })).status).toBe(400);
  });

  it('filters across subjects by product, with the subject\'s name', async () => {
    const signals = await created();
    await ok<LicenseResponse>('POST', '/api/crm/licenses', { lead_id: LEAD, start_date: '2025-01-01', renewal_date: '2026-01-01', product: 'other' });
    const all = licensesResponseSchema.parse(await ok<LicensesResponse>('GET', '/api/crm/licenses'));
    expect(all.licenses).toHaveLength(2);
    const only = await ok<LicensesResponse>('GET', '/api/crm/licenses?product=signals&active=true');
    expect(only.licenses.map((license) => license.id)).toEqual([signals.license.id]);
    expect(only.licenses[0]).toMatchObject({ organization_name: 'Acme' });
  });

  it('refuses a second licence on one Signals organization', async () => {
    await ok<LicenseResponse>('POST', '/api/crm/licenses', { organization_id: ORG, start_date: '2026-01-01', renewal_date: '2027-01-01', signals_org_id: 'org_1' });
    expect((await hit('POST', '/api/crm/licenses', { organization_id: ORG, start_date: '2026-01-01', renewal_date: '2027-01-01', signals_org_id: 'org_1' })).status).toBe(409);
  });

  it('answers 409 while Core holds the group, and 503 while the group is frozen', async () => {
    const body = { organization_id: ORG, start_date: '2026-01-01', renewal_date: '2027-01-01' };
    expect((await hit('POST', '/api/crm/licenses', body, coreHolds)).status).toBe(409);
    expect((await hit('GET', `/api/crm/licenses/${ORG}`, undefined, coreHolds)).status).toBe(409);
    await freezeGroup(flipped, 'commercial');
    const refused = await hit('POST', '/api/crm/licenses', body, flipped);
    expect(refused.status).toBe(503);
    expect((await refused.json<{ code: string }>()).code).toBe('records_moving');
  });

  it('serves the MCP tools with the same rules', async () => {
    const signed = { ...d1, SESSION_SIGNING_SECRET: 'licence-mcp-signing-secret-at-least-32-chars' } as Env;
    const bearer = await mcpBearer(signed);
    const call = async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
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
    const made = await call<LicenseResponse>('license_create', { subject: `subject:organization:${ORG}`, start_date: '2026-01-01', renewal_date: '2027-01-01', product: 'signals' });
    const changed = await call<LicenseResponse>('license_update', { license: made.license.id, seats: 4 });
    expect(changed.license.seats).toBe(4);
    expect((await call<LicensesResponse>('license_list', { product: 'signals', active: true })).licenses).toHaveLength(1);
    expect((await call<LicenseResponse>('license_end', { license: made.license.id })).license.is_active).toBe(false);
    expect((await call<LicenseResponse>('license_get', { license: made.license.id })).license.seats).toBe(4);
  });
});

describe('Browse\'s Offers group and an offer\'s views', () => {
  const OFFER = '0f000000-0000-4000-8000-0000000000d2';
  beforeEach(async () => {
    await env.USAGE.batch([
      env.USAGE.prepare(`INSERT INTO offers (id, created_at, updated_at, organization_id, title, status, total_amount, valid_until, is_accepted) VALUES (?1, 1, 1, ?2, 'Late', 'sent', 10, ?3, 0)`).bind(OFFER, ORG, Date.parse('2020-01-01T00:00:00Z')),
      env.USAGE.prepare(`INSERT INTO offer_access_logs (id, created_at, offer_id, accessed_email, accessed_at) VALUES ('0f100000-0000-4000-8000-000000000001', 1, ?1, 'buyer@acme.test', ?2)`).bind(OFFER, Date.parse('2026-11-01T10:00:00Z')),
    ]);
  });

  it('lists across subjects, filters by the status a reader sees, and names the subject', async () => {
    const all = await ok<OffersResponse>('GET', '/api/crm/offers');
    expect(all.offers[0]).toMatchObject({ id: OFFER, organization_name: 'Acme', shown_status: 'expired' });
    expect((await ok<OffersResponse>('GET', '/api/crm/offers?status=expired')).offers).toHaveLength(1);
    expect((await ok<OffersResponse>('GET', '/api/crm/offers?status=sent')).offers).toHaveLength(0);
  });

  it('answers who viewed it on a read of one offer', async () => {
    const answer = await ok<{ views: unknown[] }>('GET', `/api/crm/offers/${OFFER}`);
    expect(answer.views).toEqual([{ at: '2026-11-01T10:00:00.000Z', email: 'buyer@acme.test' }]);
  });
});

describe('what Signals produces', () => {
  const link = async () => {
    const { license } = await created();
    await ok('PATCH', `/api/crm/licenses/${license.id}`, { signals_org_id: 'org_1' });
    return license.id;
  };

  it('lands usage on the licence, and only a newer snapshot replaces it', async () => {
    const id = await link();
    expect(await (await door('signals-usage', usage())).json()).toEqual({ ok: true, applied: true });
    expect(await (await door('signals-usage', usage())).json()).toEqual({ ok: true, applied: false, reason: 'snapshot_not_newer' });
    expect((await door('signals-usage', usage('2026-10-01T00:00:00.000Z'))).status).toBe(200);
    const { license } = await ok<LicenseResponse>('GET', `/api/crm/licenses/${id}`, undefined, flipped);
    expect(license.usage).toMatchObject({ snapshot_at: '2026-11-01T00:00:00.000Z', sessions_created_30d: 5, projects_count: 2, last_successful_workflow_run_at: null });
  });

  it('answers 404 for an org id no licence names, and 409 while Core holds the group', async () => {
    expect((await door('signals-usage', usage())).status).toBe(404);
    expect((await door('signals-usage', usage(), coreHolds)).status).toBe(409);
    expect((await door('signals-billing-events', billing('subscription.updated', '2026-11-01T00:00:00.000Z'), coreHolds)).status).toBe(409);
    expect((await door('signals-usage', { ...usage(), snapshot_at: 'nope' })).status).toBe(400);
  });

  it('lands a subscription\'s facts, newest first, and keeps no invoice', async () => {
    const id = await link();
    expect(await (await door('signals-billing-events', billing('subscription.canceled', '2026-11-02T00:00:00.000Z', 'canceled'))).json()).toEqual({ ok: true, applied: true });
    expect(await (await door('signals-billing-events', billing('subscription.updated', '2026-11-01T00:00:00.000Z'))).json()).toEqual({ ok: true, applied: false, reason: 'event_not_newer' });
    expect(await (await door('signals-billing-events', billing('invoice.paid', '2026-11-03T00:00:00.000Z', null))).json()).toEqual({ ok: true, applied: false, reason: 'not_kept_on_license' });
    const { license } = await ok<LicenseResponse>('GET', `/api/crm/licenses/${id}`, undefined, flipped);
    expect(license).toMatchObject({ billing_status: 'canceled', is_active: false, plan_type: 'pro', billing_interval: 'year', renewal_date: '2027-11-01' });
  });
});

describe('the nine accounts', () => {
  const account = (id: string, stage: string, organization = ORG) => ({ id, organization_id: organization, stage, signals_org_id: null });

  it('never guesses', () => {
    const licence = { id: 'l1', organization_id: 'o1', product: 'signals', is_active: true };
    const other = { id: 'l2', organization_id: 'o1', product: 'other', is_active: true };
    const { steps, counts } = planSignalsAccounts(
      [account('a', 'active', 'o1'), account('b', 'active', 'o2'), account('c', 'testing', 'o1'), account('d', 'target', 'o3'), account('e', 'target', 'o4'), account('f', 'active', 'o5')],
      [licence, other, { ...licence, id: 'l3', organization_id: 'o5' }, { ...licence, id: 'l4', organization_id: 'o5' }],
      [{ id: 'd1', organization_id: 'o4', source: 'signals' }],
    );
    expect(steps).toEqual([
      { account_id: 'a', action: 'license', license_id: 'l1' },
      { account_id: 'b', action: 'ambiguous', reason: 'active_without_license' },
      { account_id: 'c', action: 'ambiguous', reason: 'license_on_inactive_stage' },
      { account_id: 'd', action: 'lead_create' },
      { account_id: 'e', action: 'lead_found', lead_id: 'd1' },
      { account_id: 'f', action: 'ambiguous', reason: 'several_licenses' },
    ]);
    expect(counts).toEqual({ accounts: 6, license: 1, lead_found: 1, lead_create: 1, ambiguous: 3 });
  });
});

describe('the three accounts MZ named', () => {
  const STIHL = 'f99bd2ae-dea7-43e2-9d2f-b98773ae55cc';
  const NOMADS = '67c2ea95-f380-4342-acc1-b238e375e7b7';
  it('follows the decision, and stops when the organization does not have exactly one licence', () => {
    const accounts = [{ id: STIHL, organization_id: 'o1', stage: 'active', signals_org_id: null }, { id: NOMADS, organization_id: 'o2', stage: 'testing', signals_org_id: null }];
    const licenses = [
      { id: 'l1', organization_id: 'o1', product: 'other', is_active: true },
      { id: 'l2', organization_id: 'o2', product: 'signals', is_active: true },
    ];
    expect(planSignalsAccounts(accounts, licenses, []).steps).toEqual([
      { account_id: STIHL, action: 'license', license_id: 'l1', becomes_signals: true },
      { account_id: NOMADS, action: 'lead_create', end_license_id: 'l2' },
    ]);
    expect(planSignalsAccounts(accounts, [...licenses, { ...licenses[0]!, id: 'l3' }], []).steps[0]).toEqual({ account_id: STIHL, action: 'ambiguous', reason: 'several_licenses' });
    expect(planSignalsAccounts(accounts, [], []).steps[0]).toEqual({ account_id: STIHL, action: 'ambiguous', reason: 'active_without_license' });
  });
});

describe('the expiry reminder', () => {
  const offer = async (validUntil: number) => {
    await env.USAGE.prepare(
      `INSERT INTO offers (id, created_at, updated_at, organization_id, lead_id, title, status, total_amount, valid_until, is_accepted) VALUES ('0f000000-0000-4000-8000-0000000000d1', 1, 1, ?1, ?2, 'Pilot', 'sent', 1200, ?3, 0)`,
    ).bind(ORG, LEAD, validUntil).run();
  };

  it('keeps Core\'s words and Core\'s schedule', () => {
    const mail = offerReminderMail({ to: 'a@b.test', name: 'Ana', title: 'Pilot', link: 'https://x.test/private/offer/1', validUntil: '2026-11-08T00:00:00.000Z', amount: 1200 });
    expect(mail.subject).toBe('Your offer expires on November 8, 2026');
    expect(mail.text).toContain('This is a friendly reminder that your offer is expiring soon.\n\nOffer: Pilot\nAmount: €1,200\nExpires on: November 8, 2026');
    expect(isReminderTick(Date.parse('2026-11-05T08:00:00Z'))).toBe(true);
    expect(isReminderTick(Date.parse('2026-11-05T08:05:00Z'))).toBe(false);
  });

  it('sends only once the group moved, once per offer, and files the interaction', async () => {
    const now = Date.parse('2026-11-05T08:00:00Z');
    await offer(now + 3 * 86_400_000);
    const sent: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      sent.push(String(new Request(input, init).url));
      return Response.json({});
    });
    const mailing = { ...flipped, POSTMARK_API_KEY: 'test-key', MAIL_FROM: 'Test <t@example.test>' } as unknown as Env;

    expect(await sendOfferExpiryReminders({ ...coreHolds, POSTMARK_API_KEY: 'test-key' } as Env, now)).toBeNull();
    expect(await sendOfferExpiryReminders({ ...d1, POSTMARK_API_KEY: 'test-key' } as Env, now)).toBeNull();
    expect(sent).toEqual([]);

    expect(await sendOfferExpiryReminders(mailing, now)).toEqual({ sent: 1, skipped: 0, errors: 0 });
    expect(sent).toHaveLength(1);
    expect(await sendOfferExpiryReminders(mailing, now)).toEqual({ sent: 0, skipped: 1, errors: 0 });
    expect(sent).toHaveLength(1);
    expect(await one(`SELECT title, type FROM interactions WHERE title LIKE ?1`, 'Offer expiration%')).toEqual({ title: 'Offer expiration reminder: Pilot', type: 'email' });
  });
});

describe('the mapping action', () => {
  const STIHL = 'f99bd2ae-dea7-43e2-9d2f-b98773ae55cc';
  const NOMADS = '67c2ea95-f380-4342-acc1-b238e375e7b7';
  const source = (id: string, stage: string, organization: string) => ({
    id, organization_id: organization, primary_contact_id: CONTACT, stage, notes: 'From the account.', seats: 9, started_on: '2026-02-01', payment_type: 'stripe',
    signals_org_id: null, usage_schema_version: null, usage_snapshot_at: null, usage_window_starts_at: null, usage_window_ends_at: null, usage_projects_count: null,
    usage_sessions_created_30d: null, usage_last_session_created_at: null, usage_workflow_runs_succeeded_30d: null, usage_last_successful_workflow_run_at: null,
    usage_results_first_viewed_at: null, usage_credit_buckets: null,
  });
  const NOMADS_ORG = '0a000000-0000-4000-8000-0000000000d2';
  const OPEN_ORG = '0a000000-0000-4000-8000-0000000000d3';
  const admin = { ...flipped, ROOT_ADMIN_EMAILS: 'licences-admin@example.com' } as unknown as Env;
  const map = (body: unknown) => hit('POST', '/api/admin/signals-accounts/map', body, admin);

  beforeEach(async () => {
    await env.USAGE.batch([
      env.USAGE.prepare(`INSERT INTO organizations (id, name, created_at, updated_at) VALUES (?1, 'Nomads', 1, 1), (?2, 'Open', 1, 1)`).bind(NOMADS_ORG, OPEN_ORG),
      env.USAGE.prepare(`INSERT INTO licenses (id, created_at, updated_at, organization_id, start_date, renewal_date, product, seats, payment_type) VALUES ('1c000000-0000-4000-8000-000000000001', 1, 1, ?1, '2026-01-01', '2027-01-01', 'other', 2, 'invoice'), ('1c000000-0000-4000-8000-000000000002', 1, 1, ?2, '2026-01-01', '2027-01-01', 'signals', 2, 'invoice')`).bind(ORG, NOMADS_ORG),
    ]);
    token = await sessionFor('licences-admin@example.com', admin);
  });

  it('is a dry run unless the body applies it, and an apply makes each thing once', async () => {
    const accounts = [source(STIHL, 'active', ORG), source(NOMADS, 'testing', NOMADS_ORG), source('a4', 'target', OPEN_ORG)];
    const dry = signalsAccountMapResponseSchema.parse(await (await map({ accounts })).json());
    expect(dry).toMatchObject({ applied: false, counts: { license: 1, lead_create: 2, ambiguous: 0 } });
    expect(await one(`SELECT product FROM licenses WHERE id = '1c000000-0000-4000-8000-000000000001'`)).toEqual({ product: 'other' });

    expect((await map({ accounts, apply: true })).status).toBe(200);
    expect(await one(`SELECT product, seats, payment_type, notes FROM licenses WHERE id = '1c000000-0000-4000-8000-000000000001'`)).toEqual({ product: 'signals', seats: 9, payment_type: 'stripe', notes: 'From the account.' });
    expect(await one(`SELECT is_active FROM licenses WHERE id = '1c000000-0000-4000-8000-000000000002'`)).toEqual({ is_active: 0 });
    expect(await one(`SELECT title, status, contact_id FROM leads WHERE organization_id = ?1 AND source = 'signals'`, NOMADS_ORG)).toEqual({ title: 'Nomads · Signals', status: 'Active Negotiation', contact_id: CONTACT });
    expect(await one(`SELECT COUNT(*) AS n FROM licenses`)).toEqual({ n: 2 });

    const again = signalsAccountMapResponseSchema.parse(await (await map({ accounts, apply: true })).json());
    expect(again.counts).toMatchObject({ license: 1, lead_found: 2, lead_create: 0 });
    expect(await one(`SELECT COUNT(*) AS n FROM leads WHERE source = 'signals'`)).toEqual({ n: 2 });
  });

  it('refuses the whole apply while any other row is ambiguous, and names it', async () => {
    const accounts = [source(STIHL, 'active', ORG), source('stray', 'active', OPEN_ORG)];
    const refused = await map({ accounts, apply: true });
    expect(refused.status).toBe(409);
    expect((await refused.json<{ error: string }>()).error).toContain('stray');
    expect(await one(`SELECT product FROM licenses WHERE id = '1c000000-0000-4000-8000-000000000001'`)).toEqual({ product: 'other' });
  });
});

async function mcpBearer(workspace: Env): Promise<string> {
  const email = 'licences-ana@example.com';
  const { SignJWT } = await import('jose');
  const { signingKey } = await import('../src/crypto');
  const now = Date.now();
  await workspace.USAGE.prepare(
    `INSERT OR REPLACE INTO mcp_clients (client_id, client_name, client_uri, redirect_uris, created_at) VALUES ('client-licences', 'claude.ai', NULL, '["https://claude.ai/api/mcp/auth_callback"]', ?1)`,
  ).bind(now).run();
  await workspace.USAGE.prepare(
    `INSERT OR REPLACE INTO mcp_grants (id, client_id, sub, email, scope, refresh_jti, previous_refresh_jti, renewed_at, created_at, last_call_at, revoked_at)
     VALUES ('grant-licences', 'client-licences', ?1, ?2, 'read write', 'jti', NULL, ?3, ?3, NULL, NULL)`,
  ).bind(`dev:${email}`, email, now).run();
  return new SignJWT({ email, name: 'Ana', scope: 'read write', grant: 'grant-licences', client: 'client-licences' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('starlings.example')
    .setAudience('meet-mcp')
    .setSubject(`dev:${email}`)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(signingKey(workspace.SESSION_SIGNING_SECRET!));
}
