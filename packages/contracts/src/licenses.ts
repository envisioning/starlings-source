import { z } from 'zod';
import { crmLicenseSchema, crmOfferSchema } from './crm';
import { OFFER_STATUSES } from './offer-values';

/*
 * The member's licence routes (decided by MZ, 2026-11-05). Web, Mac and agents
 * edit through them; iPhone and Android read. A Signals customer is a licence
 * with `product = 'signals'`: there is no Signals record, and Signals is a filter
 * on licences and leads.
 *
 * The usage and billing facts Signals produces land on the licence that names
 * their `signals_org_id` (`signalsUsageSnapshotSchema`, `signalsBillingEventSchema`).
 */

export const LICENSE_PRODUCTS = ['signals', 'other'] as const;
export const licenseProductSchema = z.enum(LICENSE_PRODUCTS);
export type LicenseProduct = z.infer<typeof licenseProductSchema>;
export const LICENSE_PLAN_TYPES = ['starter', 'pro', 'partner'] as const;
export const LICENSE_PAYMENT_TYPES = ['invoice', 'stripe'] as const;
export const LICENSE_BILLING_INTERVALS = ['month', 'year', 'one_time'] as const;
/** A lead whose `source` is this is a prospect for the Signals product. */
export const SIGNALS_LEAD_SOURCE = 'signals';

const uuid = z.uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).refine((value) => Number.isFinite(Date.parse(value)), 'not a date');
const licenseFields = {
  product: licenseProductSchema,
  plan_type: z.enum(LICENSE_PLAN_TYPES).nullable(),
  seats: z.number().int().min(0).max(1_000_000).nullable(),
  payment_type: z.enum(LICENSE_PAYMENT_TYPES).nullable(),
  billing_interval: z.enum(LICENSE_BILLING_INTERVALS).nullable(),
  amount_eur: z.number().min(0).max(100_000_000),
  start_date: day,
  renewal_date: day,
  is_active: z.boolean(),
  notes: z.string().max(20_000).nullable(),
  signals_org_id: z.string().trim().min(1).max(255).nullable(),
};

const datesInOrder = (body: { start_date?: string | undefined; renewal_date?: string | undefined }) =>
  !body.start_date || !body.renewal_date || body.renewal_date >= body.start_date;
const DATES_MESSAGE = 'The renewal date can’t be before the start date.';

/** `POST /api/crm/licenses`: a licence on a lead or an organization. */
export const licenseCreateSchema = z.strictObject({
  lead_id: uuid.optional(),
  organization_id: uuid.optional(),
  start_date: licenseFields.start_date,
  renewal_date: licenseFields.renewal_date,
  product: licenseFields.product.optional(),
  plan_type: licenseFields.plan_type.optional(),
  seats: licenseFields.seats.optional(),
  payment_type: licenseFields.payment_type.optional(),
  billing_interval: licenseFields.billing_interval.optional(),
  amount_eur: licenseFields.amount_eur.optional(),
  is_active: licenseFields.is_active.optional(),
  notes: licenseFields.notes.optional(),
  signals_org_id: licenseFields.signals_org_id.optional(),
}).refine((body) => body.lead_id || body.organization_id, 'A license needs a lead or an organization.')
  .refine(datesInOrder, DATES_MESSAGE);
export type LicenseCreate = z.infer<typeof licenseCreateSchema>;

/** `PATCH /api/crm/licenses/:id`: only the fields that change. Null clears a field. */
export const licensePatchSchema = z.strictObject({
  start_date: licenseFields.start_date.optional(),
  renewal_date: licenseFields.renewal_date.optional(),
  product: licenseFields.product.optional(),
  plan_type: licenseFields.plan_type.optional(),
  seats: licenseFields.seats.optional(),
  payment_type: licenseFields.payment_type.optional(),
  billing_interval: licenseFields.billing_interval.optional(),
  amount_eur: licenseFields.amount_eur.optional(),
  is_active: licenseFields.is_active.optional(),
  notes: licenseFields.notes.optional(),
  signals_org_id: licenseFields.signals_org_id.optional(),
}).refine((body) => Object.keys(body).length > 0, 'Nothing to change.')
  .refine(datesInOrder, DATES_MESSAGE);
export type LicensePatch = z.infer<typeof licensePatchSchema>;

/** `GET /api/crm/licenses`. A list across subjects, newest start first. */
export const licensesQuerySchema = z.object({
  product: licenseProductSchema.optional(),
  active: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type LicensesQuery = z.infer<typeof licensesQuerySchema>;

export const licenseResponseSchema = z.object({ license: crmLicenseSchema });
export type LicenseResponse = z.infer<typeof licenseResponseSchema>;

export const licensesResponseSchema = z.object({ licenses: z.array(crmLicenseSchema), truncated: z.boolean() });
export type LicensesResponse = z.infer<typeof licensesResponseSchema>;

/** `GET /api/crm/offers`. A list across subjects, newest first, by the status a reader sees. */
export const offersQuerySchema = z.object({
  status: z.enum(OFFER_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
export type OffersQuery = z.infer<typeof offersQuerySchema>;

export const offersResponseSchema = z.object({ offers: z.array(crmOfferSchema), truncated: z.boolean() });
export type OffersResponse = z.infer<typeof offersResponseSchema>;

// ── What Signals produces (signals-ai ADR-0049, Core's two public routes) ───

const utcTime = z.string().datetime({ offset: false }).refine((value) => value.endsWith('Z'), 'Timestamp must be UTC');
const count = z.number().int().min(0).nullable();
const credits = z.number().finite().min(0).nullable();

const creditBucketSchema = z.strictObject({
  bucket: z.enum(['persistent', 'cycle']),
  allowance_credits: credits,
  consumed_credits: credits,
  available_credits: z.number().finite().nullable(),
  period_start: utcTime.nullable(),
  period_end: utcTime.nullable(),
}).superRefine((bucket, context) => {
  if (bucket.bucket === 'persistent' && (bucket.period_start !== null || bucket.period_end !== null)) {
    context.addIssue({ code: 'custom', path: ['period_start'], message: 'Persistent credits have no cycle period' });
  }
  if (bucket.bucket === 'cycle') {
    if (!bucket.period_start || !bucket.period_end) {
      context.addIssue({ code: 'custom', path: ['period_start'], message: 'Cycle credits require period bounds' });
    } else if (Date.parse(bucket.period_end) <= Date.parse(bucket.period_start)) {
      context.addIssue({ code: 'custom', path: ['period_end'], message: 'Cycle period end must follow its start' });
    }
  }
});

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** A daily aggregate for one Signals organization, as Core's `POST /api/public/signals-usage` takes it. */
export const signalsUsageSnapshotSchema = z.strictObject({
  schema_version: z.literal(1),
  signals_org_id: z.string().trim().min(1).max(255),
  snapshot_at: utcTime,
  activity_window: z.strictObject({ starts_at: utcTime, ends_at: utcTime }),
  projects: z.strictObject({ non_deleted_count: count }),
  sessions: z.strictObject({ created_in_window: count, last_created_at: utcTime.nullable() }),
  workflow_runs: z.strictObject({ succeeded_in_window: count, last_succeeded_at: utcTime.nullable() }),
  results_first_viewed_at: utcTime.nullable(),
  credit_buckets: z.array(creditBucketSchema).max(2).nullable(),
}).superRefine((snapshot, context) => {
  const at = Date.parse(snapshot.snapshot_at);
  if (Date.parse(snapshot.activity_window.ends_at) !== at) {
    context.addIssue({ code: 'custom', path: ['activity_window', 'ends_at'], message: 'Activity window must end at snapshot_at' });
  }
  if (at - Date.parse(snapshot.activity_window.starts_at) !== THIRTY_DAYS_MS) {
    context.addIssue({ code: 'custom', path: ['activity_window', 'starts_at'], message: 'Activity window must cover exactly 30 days' });
  }
  const kinds = snapshot.credit_buckets?.map((bucket) => bucket.bucket) ?? [];
  if (new Set(kinds).size !== kinds.length) {
    context.addIssue({ code: 'custom', path: ['credit_buckets'], message: 'Each credit bucket may appear only once' });
  }
});
export type SignalsUsageSnapshot = z.infer<typeof signalsUsageSnapshotSchema>;

const nullableText = (max: number) => z.string().trim().min(1).max(max).nullable();
const minor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();

/** A normalized billing fact, as Core's `POST /api/public/signals-billing-events` takes it. */
export const signalsBillingEventSchema = z.strictObject({
  schema_version: z.literal(1),
  event_id: z.string().trim().min(1).max(255),
  event_type: z.enum([
    'subscription.created', 'subscription.updated', 'subscription.canceled',
    'invoice.paid', 'invoice.payment_failed', 'invoice.refunded',
    'promotion.issued', 'promotion.applied', 'promotion.redeemed', 'promotion.expired', 'promotion.reversed',
  ]),
  occurred_at: utcTime,
  signals_org_id: z.string().trim().min(1).max(255),
  subscription: z.strictObject({
    signals_license_id: nullableText(255),
    stripe_subscription_id: nullableText(255),
    status: z.enum(['active', 'trialing', 'past_due', 'canceled', 'incomplete', 'unpaid', 'paused']).nullable(),
    plan_key: nullableText(50),
    billing_interval: z.enum(LICENSE_BILLING_INTERVALS).nullable(),
    period_starts_at: utcTime.nullable(),
    period_ends_at: utcTime.nullable(),
  }),
  invoice: z.strictObject({
    stripe_invoice_id: nullableText(255),
    currency: z.string().regex(/^[A-Z]{3}$/u).nullable(),
    amount_due_minor: minor,
    amount_paid_minor: minor,
    amount_refunded_minor: minor,
    discount_minor: minor,
  }),
  promotion: z.strictObject({
    promotion_id: nullableText(255),
    campaign: nullableText(200),
    status: z.enum(['requested', 'issued', 'applied', 'redeemed', 'expired', 'reversed']).nullable(),
  }),
}).superRefine((event, context) => {
  const { subscription } = event;
  if (subscription.period_starts_at && subscription.period_ends_at && Date.parse(subscription.period_ends_at) <= Date.parse(subscription.period_starts_at)) {
    context.addIssue({ code: 'custom', path: ['subscription', 'period_ends_at'], message: 'Billing period end must follow its start' });
  }
  if (event.event_type.startsWith('subscription.') && !subscription.status) {
    context.addIssue({ code: 'custom', path: ['subscription', 'status'], message: 'Subscription events require a status' });
  }
});
export type SignalsBillingEvent = z.infer<typeof signalsBillingEventSchema>;

/** Both doors' answer. `applied: false` is a retry, a late delivery, or a fact the licence does not keep. */
export const signalsFactResponseSchema = z.object({
  ok: z.boolean(),
  applied: z.boolean(),
  reason: z.string().optional(),
});
export type SignalsFactResponse = z.infer<typeof signalsFactResponseSchema>;

// ── Mapping `signals_accounts` onto licences and leads ──────────────────────

/** One row of Core's table, as the script reads it. */
export const signalsAccountSourceSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  primary_contact_id: z.string().nullable(),
  stage: z.string(),
  notes: z.string().nullable(),
  seats: z.number().int().nullable(),
  started_on: z.string().nullable(),
  payment_type: z.string().nullable(),
  signals_org_id: z.string().nullable(),
  usage_schema_version: z.number().int().nullable(),
  usage_snapshot_at: z.string().nullable(),
  usage_window_starts_at: z.string().nullable(),
  usage_window_ends_at: z.string().nullable(),
  usage_projects_count: z.number().int().nullable(),
  usage_sessions_created_30d: z.number().int().nullable(),
  usage_last_session_created_at: z.string().nullable(),
  usage_workflow_runs_succeeded_30d: z.number().int().nullable(),
  usage_last_successful_workflow_run_at: z.string().nullable(),
  usage_results_first_viewed_at: z.string().nullable(),
  usage_credit_buckets: z.unknown().nullable(),
});
export type SignalsAccountSource = z.infer<typeof signalsAccountSourceSchema>;

/** `POST /api/admin/signals-accounts/map`. */
export const signalsAccountMapRequestSchema = z.strictObject({
  accounts: z.array(signalsAccountSourceSchema).max(1000),
  /** False or absent is the dry run: it writes nothing. */
  apply: z.boolean().optional(),
});
export type SignalsAccountMapRequest = z.infer<typeof signalsAccountMapRequestSchema>;

export type SignalsAccountAmbiguity = 'active_without_license' | 'several_licenses' | 'several_leads' | 'license_on_inactive_stage' | 'org_id_taken';

export interface SignalsPlanLicense { id: string; organization_id: string | null; product: string | null; is_active: boolean; signals_org_id?: string | null }
export interface SignalsPlanLead { id: string; organization_id: string | null; source: string | null }

/**
 * The accounts the rule could not place, decided by name (MZ, 2026-11-05). STIHL and
 * Einstein are customers: their one licence becomes a Signals licence, and takes the
 * account's seats and payment type. Nomads is still a prospect: its licence ends, and
 * a lead opens.
 */
export const SIGNALS_ACCOUNT_DECISIONS: Readonly<Record<string, 'license_becomes_signals' | 'prospect_ends_license'>> = {
  'f99bd2ae-dea7-43e2-9d2f-b98773ae55cc': 'license_becomes_signals',
  'e0f0d8e1-1e22-4f7f-a6ea-85bd01f2bd7b': 'license_becomes_signals',
  '67c2ea95-f380-4342-acc1-b238e375e7b7': 'prospect_ends_license',
};

export type SignalsAccountStep =
  | { account_id: string; action: 'license'; license_id: string; becomes_signals?: true }
  | { account_id: string; action: 'lead_found'; lead_id: string; end_license_id?: string }
  | { account_id: string; action: 'lead_create'; end_license_id?: string }
  | { account_id: string; action: 'ambiguous'; reason: SignalsAccountAmbiguity };

const stepCounts = (steps: readonly SignalsAccountStep[]) => ({
  accounts: steps.length,
  license: steps.filter((step) => step.action === 'license').length,
  lead_found: steps.filter((step) => step.action === 'lead_found').length,
  lead_create: steps.filter((step) => step.action === 'lead_create').length,
  ambiguous: steps.filter((step) => step.action === 'ambiguous').length,
});

/**
 * Where each account goes. Pure, so the script's dry run on Core and the admin
 * action on D1 read one rule, and neither guesses:
 *
 * - One Signals licence on the organization, active stage: that licence.
 * - No Signals licence and not an active stage: the organization's one Signals
 *   lead, or a new one. A prospect is a lead.
 * - An account in `SIGNALS_ACCOUNT_DECISIONS` follows its decision, and needs exactly
 *   one licence on its organization. A second run finds what the first did.
 * - Everything else stops and names its id: active with no licence, several
 *   licences or leads to choose from, a licence on a stage that says otherwise,
 *   or a licence that holds another org id. The admin action refuses to apply while
 *   any row stops here.
 */
export function planSignalsAccounts(
  accounts: ReadonlyArray<Pick<SignalsAccountSource, 'id' | 'organization_id' | 'stage' | 'signals_org_id'>>,
  licenses: readonly SignalsPlanLicense[],
  leads: readonly SignalsPlanLead[],
): { steps: SignalsAccountStep[]; counts: ReturnType<typeof stepCounts> } {
  const leadStep = (account: { id: string; organization_id: string }, endLicenseId?: string): SignalsAccountStep => {
    const end = endLicenseId ? { end_license_id: endLicenseId } : {};
    const found = leads.filter((lead) => lead.organization_id === account.organization_id && lead.source === SIGNALS_LEAD_SOURCE);
    if (found.length > 1) return { account_id: account.id, action: 'ambiguous', reason: 'several_leads' };
    return found[0] ? { account_id: account.id, action: 'lead_found', lead_id: found[0].id, ...end } : { account_id: account.id, action: 'lead_create', ...end };
  };
  const steps = accounts.map((account): SignalsAccountStep => {
    const decision = Object.hasOwn(SIGNALS_ACCOUNT_DECISIONS, account.id) ? SIGNALS_ACCOUNT_DECISIONS[account.id] : undefined;
    if (decision) {
      const all = licenses.filter((license) => license.organization_id === account.organization_id);
      if (all.length === 0) return { account_id: account.id, action: 'ambiguous', reason: 'active_without_license' };
      if (all.length > 1) return { account_id: account.id, action: 'ambiguous', reason: 'several_licenses' };
      return decision === 'license_becomes_signals'
        ? { account_id: account.id, action: 'license', license_id: all[0]!.id, becomes_signals: true }
        : leadStep(account, all[0]!.id);
    }
    const onOrganization = licenses.filter((license) => license.organization_id === account.organization_id && license.product === 'signals');
    const live = onOrganization.filter((license) => license.is_active);
    const candidates = live.length > 0 ? live : onOrganization;
    if (account.stage === 'active') {
      if (candidates.length === 0) return { account_id: account.id, action: 'ambiguous', reason: 'active_without_license' };
      if (candidates.length > 1) return { account_id: account.id, action: 'ambiguous', reason: 'several_licenses' };
      const held = candidates[0]!.signals_org_id;
      if (held && account.signals_org_id && held !== account.signals_org_id) return { account_id: account.id, action: 'ambiguous', reason: 'org_id_taken' };
      return { account_id: account.id, action: 'license', license_id: candidates[0]!.id };
    }
    if (onOrganization.length > 0) return { account_id: account.id, action: 'ambiguous', reason: 'license_on_inactive_stage' };
    return leadStep(account);
  });
  return { steps, counts: stepCounts(steps) };
}

export const signalsAccountMapResponseSchema = z.object({
  applied: z.boolean(),
  counts: z.object({ accounts: z.number().int(), license: z.number().int(), lead_found: z.number().int(), lead_create: z.number().int(), ambiguous: z.number().int() }),
  /** Ids only. */
  ambiguous: z.array(z.object({ account_id: z.string(), reason: z.string() })),
});
export type SignalsAccountMapResponse = z.infer<typeof signalsAccountMapResponseSchema>;

/** Core's stage as a lead's status, when an account becomes a new lead. */
export const SIGNALS_STAGE_LEAD_STATUS: Readonly<Record<string, string>> = {
  target: 'Opportunity Identified',
  contacted: 'Conversations',
  demoed: 'Conversations',
  testing: 'Active Negotiation',
  not_now: 'Waiting on External Factor',
  closed_lost: 'Closed Lost',
};
