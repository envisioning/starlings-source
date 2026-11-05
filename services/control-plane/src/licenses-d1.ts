// The member's licences on D1 (decided by MZ, 2026-11-05). Web, Mac and agents
// edit through these; iPhone and Android read. Every write goes through
// `writeCoreCommercial`, the path Core's own flows use, so one list of columns,
// one trail and one freeze check hold. A Signals customer is a licence with
// `product = 'signals'`, and the facts Signals produces land here by
// `signals_org_id`.

import type { CrmLicense } from '@starlings/contracts';
import type { CrmLicenseUsage } from '@starlings/contracts/crm';
import { COMMERCIAL_D1_COLUMNS } from '@starlings/contracts/core-commercial';
import { derivedOfferStatus } from '@starlings/contracts/offer-values';
import {
  planSignalsAccounts,
  SIGNALS_LEAD_SOURCE,
  SIGNALS_STAGE_LEAD_STATUS,
  LICENSE_PLAN_TYPES,
  type LicenseCreate,
  type LicensePatch,
  type LicenseResponse,
  type LicensesQuery,
  type LicensesResponse,
  type OffersQuery,
  type OffersResponse,
  type SignalsAccountMapRequest,
  type SignalsAccountMapResponse,
  type SignalsBillingEvent,
  type SignalsFactResponse,
  type SignalsUsageSnapshot,
} from '@starlings/contracts/licenses';
import { commercialCell, memberCommercialRow, writeCoreCommercial, type CommercialRawRow, type CoreCommercialRow } from './core-commercial-d1';
import { listCrmCommercial } from './crm';
import { ControlError } from './errors';
import { personIdForEmail } from './person-ids';
import { recordWorkActivity, workActivityStatement } from './work-activity';
import { assertGroupWritable } from './work-freeze';
import { workModuleOn } from './work-modules';
import { usesCore, usesCoreFor } from './work-store';

/** What the routes need of the caller's access (`subject-access.ts`). */
export interface LicenseAccess {
  requireSee(kind: string, id: string): void;
  requireWrite(kind: string, id: string): void;
  canSee(kind: string, id: string): boolean;
}

const refuse = (message: string, status = 409) => new ControlError(message, status, 'invalid_request');

/**
 * Before any read or write here: the group's store, then the work module. A Core
 * workspace answers 409 until the group moves, because D1's tables are empty
 * then. Clients hide the editor while the descriptor's `core_groups` names it.
 */
export async function assertLicensesHere(env: Env): Promise<void> {
  if (usesCoreFor(env, 'commercial')) throw refuse('Licenses on this workspace can’t change here yet.');
  if (!(await workModuleOn(env, 'licenses'))) throw refuse('Licenses are off for this workspace.');
}

async function assertWritable(env: Env): Promise<void> {
  await assertLicensesHere(env);
  await assertGroupWritable(env, 'commercial');
}

/** The usage snapshot, or null before Signals reports one. */
function usageOf(row: CoreCommercialRow): CrmLicenseUsage | null {
  if (typeof row.usage_snapshot_at !== 'string') return null;
  const time = (column: string) => (typeof row[column] === 'string' ? row[column] as string : null);
  const count = (column: string) => (typeof row[column] === 'number' ? row[column] as number : null);
  return {
    snapshot_at: row.usage_snapshot_at,
    window_starts_at: time('usage_window_starts_at'),
    window_ends_at: time('usage_window_ends_at'),
    projects_count: count('usage_projects_count'),
    sessions_created_30d: count('usage_sessions_created_30d'),
    last_session_created_at: time('usage_last_session_created_at'),
    workflow_runs_succeeded_30d: count('usage_workflow_runs_succeeded_30d'),
    last_successful_workflow_run_at: time('usage_last_successful_workflow_run_at'),
    results_first_viewed_at: time('usage_results_first_viewed_at'),
  };
}

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** One licence row as the wire names it. */
export function wireLicense(raw: CommercialRawRow): CrmLicense {
  const row = memberCommercialRow('licenses', raw);
  return {
    id: String(row.id),
    product: textOf(row.product),
    plan_type: textOf(row.plan_type),
    seats: typeof row.seats === 'number' ? row.seats : null,
    amount_eur: typeof row.amount_eur === 'number' ? row.amount_eur : null,
    start_date: textOf(row.start_date),
    renewal_date: textOf(row.renewal_date),
    is_active: row.is_active === true,
    offer_id: textOf(row.offer_id),
    lead_id: textOf(row.lead_id),
    organization_id: textOf(row.organization_id),
    payment_type: textOf(row.payment_type),
    billing_interval: textOf(row.billing_interval),
    notes: textOf(row.notes),
    signals_org_id: textOf(row.signals_org_id),
    billing_status: textOf(row.billing_status),
    usage: usageOf(row),
    ...('organization_name' in raw ? { organization_name: textOf(raw.organization_name) } : {}),
    ...('lead_title' in raw ? { lead_title: textOf(raw.lead_title) } : {}),
  };
}

/** The subject a licence's access follows. A licence on neither is any member's. */
function subjectOf(row: { lead_id?: unknown; organization_id?: unknown }): { kind: 'lead' | 'organization'; id: string } | null {
  if (typeof row.lead_id === 'string') return { kind: 'lead', id: row.lead_id };
  if (typeof row.organization_id === 'string') return { kind: 'organization', id: row.organization_id };
  return null;
}

async function licenseRow(env: Env, id: string): Promise<CommercialRawRow> {
  const row = await env.USAGE.prepare('SELECT * FROM licenses WHERE id = ?1').bind(id).first<CommercialRawRow>();
  if (!row) throw refuse('No such license.', 404);
  return row;
}

const orgIdTaken = (error: unknown) => error instanceof Error && /UNIQUE constraint failed: licenses\.signals_org_id/u.test(error.message);
const ORG_ID_TAKEN = 'Another license has that Signals organization.';

/** `GET /api/crm/licenses`: across subjects, newest start first, with each subject's name. */
export async function listLicenses(env: Env, actor: string, access: LicenseAccess, query: LicensesQuery): Promise<LicensesResponse> {
  if (usesCoreFor(env, 'commercial')) return listLicensesOnCore(env, actor, access, query);
  await assertLicensesHere(env);
  const limit = query.limit ?? 200;
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (query.product) { binds.push(query.product); where.push(`l.product = ?${binds.length}`); }
  if (query.active) { binds.push(query.active === 'true' ? 1 : 0); where.push(`l.is_active = ?${binds.length}`); }
  const { results } = await env.USAGE.prepare(
    `SELECT l.*, o.name AS organization_name, d.title AS lead_title
       FROM licenses l LEFT JOIN organizations o ON o.id = l.organization_id LEFT JOIN leads d ON d.id = l.lead_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY l.start_date DESC, l.id LIMIT ${limit + 1}`,
  ).bind(...binds).all<CommercialRawRow>();
  const seen = results.slice(0, limit).filter((row) => {
    const subject = subjectOf(row);
    return !subject || access.canSee(subject.kind, subject.id);
  });
  return { licenses: seen.map(wireLicense), truncated: results.length > limit };
}

/**
 * While Core holds the group the list still reads, so Signals' customers have a
 * place before the flip. Core's list knows no product filter or subject name: the
 * filter runs here, and names come from D1 once the subjects moved.
 */
async function listLicensesOnCore(env: Env, actor: string, access: LicenseAccess, query: LicensesQuery): Promise<LicensesResponse> {
  if (!(await workModuleOn(env, 'licenses'))) throw refuse('Licenses are off for this workspace.');
  const limit = query.limit ?? 200;
  const { licenses } = await listCrmCommercial(env, actor, { limit: '500' }, { offers: false, licenses: true });
  const matching = (licenses ?? []).filter((license) => {
    if (query.product && license.product !== query.product) return false;
    if (query.active && license.is_active !== (query.active === 'true')) return false;
    const subject = subjectOf(license);
    return !subject || access.canSee(subject.kind, subject.id);
  });
  return { licenses: await withSubjectNames(env, matching.slice(0, limit)), truncated: matching.length > limit };
}

/** Each row with its subject's name, once the subjects answer from D1. */
async function withSubjectNames<T extends { organization_id: string | null; lead_id: string | null }>(
  env: Env,
  rows: T[],
): Promise<Array<T & { organization_name?: string | null; lead_title?: string | null }>> {
  if (usesCoreFor(env, 'subjects')) return rows;
  const named = async (sql: string, ids: Array<string | null>) => {
    const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (wanted.length === 0) return new Map<string, string>();
    const { results } = await env.USAGE.prepare(sql).bind(JSON.stringify(wanted)).all<{ id: string; name: string }>();
    return new Map(results.map((row) => [row.id, row.name]));
  };
  const [organizations, leads] = await Promise.all([
    named('SELECT id, name FROM organizations WHERE id IN (SELECT value FROM json_each(?1))', rows.map((row) => row.organization_id)),
    named('SELECT id, title AS name FROM leads WHERE id IN (SELECT value FROM json_each(?1))', rows.map((row) => row.lead_id)),
  ]);
  return rows.map((row) => ({
    ...row,
    organization_name: row.organization_id ? organizations.get(row.organization_id) ?? null : null,
    lead_title: row.lead_id ? leads.get(row.lead_id) ?? null : null,
  }));
}

/**
 * `GET /api/crm/offers`: Browse's Offers group. Reads either store, so the group
 * draws before the flip too. The filter is the status a reader sees, so an offer past
 * its date is expired whatever its row says.
 */
export async function listOffers(env: Env, actor: string, access: LicenseAccess, query: OffersQuery): Promise<OffersResponse> {
  if (!(await workModuleOn(env, 'offers'))) throw refuse('Offers are off for this workspace.');
  const limit = query.limit ?? 200;
  const { offers } = await listCrmCommercial(env, actor, { limit: '500' }, { offers: true, licenses: false });
  const matching = (offers ?? [])
    .map((offer) => ({ ...offer, shown_status: derivedOfferStatus({ status: offer.status, is_accepted: offer.is_accepted === true, valid_until: offer.valid_until }) }))
    .filter((offer) => {
      if (query.status && offer.shown_status !== query.status) return false;
      const subject = subjectOf(offer);
      return !subject || access.canSee(subject.kind, subject.id);
    });
  return { offers: await withSubjectNames(env, matching.slice(0, limit)), truncated: matching.length > limit };
}

export async function readLicense(env: Env, access: LicenseAccess, id: string): Promise<LicenseResponse> {
  await assertLicensesHere(env);
  const row = await licenseRow(env, id);
  const subject = subjectOf(row);
  if (subject) access.requireSee(subject.kind, subject.id);
  return { license: wireLicense(row) };
}

export async function createLicense(env: Env, access: LicenseAccess, actor: string, body: LicenseCreate): Promise<LicenseResponse> {
  await assertWritable(env);
  const { lead_id: leadId, organization_id: organizationId, ...fields } = body;
  const subject = subjectOf({ lead_id: leadId, organization_id: organizationId });
  if (subject) access.requireWrite(subject.kind, subject.id);
  // A licence on a lead also names the lead's organization, as an accepted offer's does.
  const lead = leadId ? await env.USAGE.prepare('SELECT organization_id FROM leads WHERE id = ?1').bind(leadId).first<{ organization_id: string | null }>() : null;
  if (leadId && !lead) throw refuse('No such lead.', 404);
  const organization = organizationId ?? lead?.organization_id ?? null;
  if (organization && !(await env.USAGE.prepare('SELECT 1 AS one FROM organizations WHERE id = ?1').bind(organization).first('one'))) throw refuse('No such organization.', 404);
  try {
    const created = await writeCoreCommercial(env, actor, {
      action: 'create', entity: 'commercial', table: 'licenses',
      values: { is_active: true, product: 'other', amount_eur: 0, ...fields, lead_id: leadId ?? null, organization_id: organization } as never,
    }, 'member');
    return { license: wireLicense(await licenseRow(env, String(created!.id))) };
  } catch (error) {
    if (orgIdTaken(error)) throw refuse(ORG_ID_TAKEN);
    throw error;
  }
}

export async function patchLicense(env: Env, access: LicenseAccess, actor: string, id: string, body: LicensePatch): Promise<LicenseResponse> {
  await assertWritable(env);
  const current = await licenseRow(env, id);
  const subject = subjectOf(current);
  if (subject) access.requireWrite(subject.kind, subject.id);
  const start = body.start_date ?? String(current.start_date);
  const renewal = body.renewal_date ?? String(current.renewal_date);
  if (renewal < start) throw refuse('The renewal date can’t be before the start date.', 400);
  try {
    await writeCoreCommercial(env, actor, { action: 'update', entity: 'commercial', table: 'licenses', id, values: body as never }, 'member');
  } catch (error) {
    if (orgIdTaken(error)) throw refuse(ORG_ID_TAKEN);
    throw error;
  }
  return { license: wireLicense(await licenseRow(env, id)) };
}

/** A licence stops: inactive from now on, and the record stays. Ending it twice changes nothing. */
export async function endLicense(env: Env, access: LicenseAccess, actor: string, id: string): Promise<LicenseResponse> {
  await assertWritable(env);
  const current = await licenseRow(env, id);
  const subject = subjectOf(current);
  if (subject) access.requireWrite(subject.kind, subject.id);
  if (current.is_active === 1) {
    await writeCoreCommercial(env, actor, { action: 'update', entity: 'commercial', table: 'licenses', id, values: { is_active: false } as never }, 'member');
  }
  return { license: wireLicense(await licenseRow(env, id)) };
}

// ── What Signals produces ───────────────────────────────────────────────────

const SIGNALS_WRITER = 'signals@internal';
const KINDS = COMMERCIAL_D1_COLUMNS.licenses!;

/**
 * Both doors, like the group's other doors: on a Core workspace only, and 409
 * while Core holds the group, so Core keeps writing its own table until then.
 */
export function assertSignalsFactsHere(env: Env): void {
  if (!usesCore(env)) throw new ControlError('This workspace keeps its CRM in D1.', 404, 'not_configured');
  if (usesCoreFor(env, 'commercial')) throw new ControlError('These records are still in Core. Write them there.', 409, 'not_configured');
}

const notLinked = () => new ControlError('Signals organization is not linked', 404, 'request_not_found');

/**
 * Core's `POST /api/public/signals-usage`, on the licence. Retries and
 * out-of-order deliveries are no-ops: only a strictly newer aggregate replaces
 * the current one.
 */
export async function applySignalsUsage(env: Env, snapshot: SignalsUsageSnapshot): Promise<SignalsFactResponse> {
  assertSignalsFactsHere(env);
  await assertGroupWritable(env, 'commercial');
  const values = {
    usage_schema_version: snapshot.schema_version,
    usage_snapshot_at: snapshot.snapshot_at,
    usage_window_starts_at: snapshot.activity_window.starts_at,
    usage_window_ends_at: snapshot.activity_window.ends_at,
    usage_projects_count: snapshot.projects.non_deleted_count,
    usage_sessions_created_30d: snapshot.sessions.created_in_window,
    usage_last_session_created_at: snapshot.sessions.last_created_at,
    usage_workflow_runs_succeeded_30d: snapshot.workflow_runs.succeeded_in_window,
    usage_last_successful_workflow_run_at: snapshot.workflow_runs.last_succeeded_at,
    usage_results_first_viewed_at: snapshot.results_first_viewed_at,
    usage_credit_buckets: snapshot.credit_buckets,
  };
  const names = Object.keys(values) as (keyof typeof values)[];
  const at = Date.parse(snapshot.snapshot_at);
  const now = Date.now();
  const updated = await env.USAGE.prepare(
    `UPDATE licenses SET ${names.map((name, index) => `${name} = ?${index + 4}`).join(', ')}, updated_at = ?3
      WHERE signals_org_id = ?1 AND (usage_snapshot_at IS NULL OR usage_snapshot_at < ?2) RETURNING id`,
  ).bind(snapshot.signals_org_id, at, now, ...names.map((name) => commercialCell(KINDS[name]!, values[name]))).first<{ id: string }>();
  if (updated) {
    await recordWorkActivity(env, { actor: SIGNALS_WRITER, table: 'licenses', id: updated.id, action: 'update', fields: names });
    return { ok: true, applied: true };
  }
  const linked = await env.USAGE.prepare('SELECT 1 AS one FROM licenses WHERE signals_org_id = ?1').bind(snapshot.signals_org_id).first('one');
  if (!linked) throw notLinked();
  return { ok: true, applied: false, reason: 'snapshot_not_newer' };
}

/** A plan key the licence's own list does not name stands as nothing: the editor stays right. */
const planOf = (key: string | null): string | null => ((LICENSE_PLAN_TYPES as readonly string[]).includes(key ?? '') ? key : null);

/**
 * Core's `POST /api/public/signals-billing-events`, on the licence. The events
 * table retires, so only what a licence keeps lands: a subscription's status,
 * plan, interval and period end, newest fact first. An invoice or promotion fact
 * has no column, and its answer says so. A late delivery is a no-op.
 */
export async function applySignalsBillingEvent(env: Env, event: SignalsBillingEvent): Promise<SignalsFactResponse> {
  assertSignalsFactsHere(env);
  await assertGroupWritable(env, 'commercial');
  const linked = await env.USAGE.prepare('SELECT id FROM licenses WHERE signals_org_id = ?1').bind(event.signals_org_id).first<{ id: string }>();
  if (!linked) throw notLinked();
  if (!event.event_type.startsWith('subscription.')) return { ok: true, applied: false, reason: 'not_kept_on_license' };
  const { status, plan_key: planKey, billing_interval: interval, period_ends_at: periodEnd } = event.subscription;
  const fields: Record<string, string | number | null> = { billing_status: status };
  if (status === 'canceled') fields.is_active = 0;
  if (status === 'active' || status === 'trialing') fields.is_active = 1;
  const plan = planOf(planKey);
  if (plan) fields.plan_type = plan;
  if (interval) fields.billing_interval = interval;
  if (periodEnd) fields.renewal_date = periodEnd.slice(0, 10);
  const names = Object.keys(fields);
  const at = Date.parse(event.occurred_at);
  const now = Date.now();
  const updated = await env.USAGE.prepare(
    `UPDATE licenses SET ${names.map((name, index) => `${name} = ?${index + 4}`).join(', ')}, billing_event_at = ?2, updated_at = ?3
      WHERE id = ?1 AND (billing_event_at IS NULL OR billing_event_at < ?2) RETURNING id`,
  ).bind(linked.id, at, now, ...names.map((name) => fields[name] ?? null)).first<{ id: string }>();
  if (!updated) return { ok: true, applied: false, reason: 'event_not_newer' };
  await recordWorkActivity(env, { actor: SIGNALS_WRITER, table: 'licenses', id: linked.id, action: 'update', fields: [...names, 'billing_event_at'] });
  return { ok: true, applied: true };
}

// ── The nine accounts ───────────────────────────────────────────────────────

/**
 * `POST /api/admin/signals-accounts/map`: each row of Core's `signals_accounts`
 * onto its licence or lead. A dry run unless `apply`, and an apply with any
 * ambiguous row refuses and changes nothing. A second apply finds what the first made.
 * A licence keeps a value it already has and only an empty field takes the account's,
 * except a licence decided to become Signals: it takes the account's seats and payment.
 */
export async function mapSignalsAccounts(env: Env, actor: string, request: SignalsAccountMapRequest): Promise<SignalsAccountMapResponse> {
  if (!usesCore(env)) throw new ControlError('This workspace keeps its CRM in D1.', 404, 'not_configured');
  if (usesCoreFor(env, 'commercial') || usesCoreFor(env, 'subjects')) throw refuse('Licenses on this workspace can’t change here yet.');
  const [licenses, leads] = await env.USAGE.batch([
    env.USAGE.prepare('SELECT id, organization_id, product, is_active, signals_org_id FROM licenses'),
    env.USAGE.prepare('SELECT id, organization_id, source FROM leads WHERE source = ?1').bind(SIGNALS_LEAD_SOURCE),
  ]);
  const plan = planSignalsAccounts(
    request.accounts,
    (licenses!.results as Array<{ id: string; organization_id: string | null; product: string | null; is_active: number; signals_org_id: string | null }>)
      .map((row) => ({ ...row, is_active: row.is_active === 1 })),
    leads!.results as Array<{ id: string; organization_id: string | null; source: string | null }>,
  );
  const answer = {
    counts: plan.counts,
    ambiguous: plan.steps.flatMap((step) => (step.action === 'ambiguous' ? [{ account_id: step.account_id, reason: step.reason }] : [])),
  };
  if (!request.apply) return { applied: false, ...answer };
  if (answer.counts.ambiguous > 0) {
    throw refuse(`${answer.counts.ambiguous} accounts are ambiguous. Nothing changed: ${answer.ambiguous.map((row) => row.account_id).join(', ')}.`);
  }

  await Promise.all([assertGroupWritable(env, 'commercial'), assertGroupWritable(env, 'subjects')]);
  const accounts = new Map(request.accounts.map((account) => [account.id, account]));
  const createdBy = await personIdForEmail(env, actor);
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const step of plan.steps) {
    const account = accounts.get(step.account_id)!;
    if (step.action === 'license') {
      const usage = Object.keys(KINDS).filter((column) => column.startsWith('usage_'));
      const decided = step.becomes_signals === true;
      statements.push(
        env.USAGE.prepare(
          `UPDATE licenses SET ${decided ? `product = 'signals', seats = coalesce(?3, seats), payment_type = coalesce(?4, payment_type),` : 'seats = coalesce(seats, ?3), payment_type = coalesce(payment_type, ?4),'}
             signals_org_id = coalesce(signals_org_id, ?2),
             notes = coalesce(notes, ?5), ${usage.map((column, index) => `${column} = coalesce(${column}, ?${index + 7})`).join(', ')}, updated_at = ?6 WHERE id = ?1`,
        ).bind(
          step.license_id, account.signals_org_id, account.seats, account.payment_type, account.notes, now,
          ...usage.map((column) => commercialCell(KINDS[column]!, account[column as keyof typeof account])),
        ),
        workActivityStatement(env, { actor, table: 'licenses', id: step.license_id, action: 'update', fields: [...(decided ? ['product'] : []), 'signals_org_id', 'seats', 'payment_type', 'notes', ...usage] }, now),
      );
      continue;
    }
    if (step.action === 'ambiguous') continue;
    if (step.end_license_id) {
      statements.push(
        env.USAGE.prepare('UPDATE licenses SET is_active = 0, updated_at = ?2 WHERE id = ?1 AND is_active = 1').bind(step.end_license_id, now),
        workActivityStatement(env, { actor, table: 'licenses', id: step.end_license_id, action: 'update', fields: ['is_active'] }, now),
      );
    }
    if (step.action === 'lead_create') {
      const id = crypto.randomUUID();
      const name = await env.USAGE.prepare('SELECT name FROM organizations WHERE id = ?1').bind(account.organization_id).first<string>('name');
      if (!name) continue;
      const contact = account.primary_contact_id
        ? await env.USAGE.prepare('SELECT id FROM contacts WHERE id = ?1').bind(account.primary_contact_id).first<string>('id')
        : null;
      const title = `${name} · Signals`;
      statements.push(
        env.USAGE.prepare(
          `INSERT INTO leads (id, organization_id, contact_id, title, status, start_date, notes, source, created_by, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
        ).bind(
          id, account.organization_id, contact ?? null, title, SIGNALS_STAGE_LEAD_STATUS[account.stage] ?? 'Conversations',
          account.started_on ?? new Date(now).toISOString().slice(0, 10), account.notes, SIGNALS_LEAD_SOURCE, createdBy, now,
        ),
        workActivityStatement(env, { actor, table: 'leads', id, action: 'insert', label: title, fields: ['contact_id', 'notes', 'organization_id', 'source', 'status', 'title'] }, now),
      );
    }
  }
  if (statements.length > 0) await env.USAGE.batch(statements);
  return { applied: true, ...answer };
}
