import { z } from 'zod';

/*
 * Fold group 5, commercial (decided by MZ, 2026-11-04). Every table
 * keeps Core's name and every Core column, so Core reads one row shape from
 * either store. This file is the one list of those columns: the group copy
 * (`work-group-moves.ts`), the Worker's repository (`core-commercial-d1.ts`)
 * and the two doors read it.
 *
 * Core sends these reads and writes only once the group moved. While the group
 * is on Core, the doors refuse with 409 and Core uses its own tables.
 */

/**
 * How a column is stored. Core's `timestamptz` is epoch milliseconds in D1 and
 * an ISO time on the wire. A `date` stays `YYYY-MM-DD` text in both, because
 * it is a day with no time zone. `flag` is 0 or 1 in D1 and a boolean on the
 * wire. `real` is Core's `numeric`. `json` is Core's `jsonb` as text with sorted keys.
 */
export type CoreColumnKind = 'uuid' | 'text' | 'time' | 'date' | 'flag' | 'real' | 'integer' | 'json';
export type CommercialColumnKind = CoreColumnKind;

/** Parents first, as in `WORK_GROUP_TABLES.commercial`; a test keeps the two the same. */
export const COMMERCIAL_TABLES = [
  'corporate_entities', 'currency_settings', 'exchange_rates_cache', 'settings_payment_terms', 'settings_delivery_conditions',
  'settings_offer_links', 'services', 'offers', 'offer_services', 'offer_selected_links', 'offer_access_logs', 'licenses',
  'license_offers', 'policies',
] as const;
export type CommercialTable = (typeof COMMERCIAL_TABLES)[number];

/** Every Core column D1 keeps. Not kept: the generated `search_vector` of `offers` and `services`. */
export const COMMERCIAL_COLUMNS: Record<CommercialTable, Readonly<Record<string, CommercialColumnKind>>> = {
  corporate_entities: {
    id: 'uuid', created_at: 'time', name: 'text', legal_name: 'text', address: 'text', postcode: 'text', city: 'text', country: 'text',
    vat_id: 'text', tax_id: 'text', logo_url: 'text', is_default: 'flag', billing_iban: 'text', signatory_name: 'text', signatory_title: 'text',
  },
  currency_settings: { id: 'uuid', currency_code: 'text', symbol: 'text', is_enabled: 'flag', surcharge_percentage: 'real', created_at: 'time' },
  exchange_rates_cache: { id: 'uuid', base_currency: 'text', target_currency: 'text', rate: 'real', last_updated: 'time', created_at: 'time' },
  settings_payment_terms: { id: 'uuid', title: 'text', description: 'text', is_active: 'flag', is_default: 'flag', created_at: 'time', updated_at: 'time' },
  settings_delivery_conditions: { id: 'uuid', title: 'text', description: 'text', is_active: 'flag', is_default: 'flag', created_at: 'time', updated_at: 'time' },
  settings_offer_links: { id: 'uuid', title: 'text', url: 'text', icon: 'text', is_active: 'flag', is_default: 'flag', created_at: 'time', updated_at: 'time' },
  services: {
    id: 'uuid', created_at: 'time', name: 'text', description: 'text', price: 'real', is_recurring: 'flag', recurring_interval: 'text', summary: 'text',
    url: 'text', icon: 'text', group_type: 'text', is_public: 'flag', allow_multiple: 'flag', is_default: 'flag', category: 'text', allow_description_override: 'flag',
  },
  offers: {
    id: 'uuid', created_at: 'time', organization_id: 'uuid', corporate_entity_id: 'uuid', valid_until: 'time', status: 'text', total_amount: 'real',
    updated_at: 'time', currency: 'text', global_discount_percentage: 'real', title: 'text', lead_id: 'uuid', is_self_submitted: 'flag', exchange_rate: 'real',
    payment_term_id: 'uuid', delivery_condition_id: 'uuid', payment_terms_text: 'text', delivery_conditions_text: 'text', accepted_at: 'time',
    accepted_by_name: 'text', accepted_by_email: 'text', accepted_ip: 'text', accepted_user_agent: 'text', accepted_metadata: 'json', creator_token_id: 'uuid',
    discount_reason: 'text', is_accepted: 'flag', tax_percentage: 'real', tax_reason: 'text', agreement_date: 'date', agreement_start_date: 'date',
    agreement_end_date: 'date', agreement_terms_override: 'text', agreement_notice_email: 'text', agreement_include_annex: 'flag', billing_contact_email: 'text',
    billing_po_number: 'text', service_inputs: 'json', billing_vat_id: 'text', recipient_email: 'text',
  },
  offer_services: {
    id: 'uuid', offer_id: 'uuid', service_id: 'uuid', quantity: 'integer', price: 'real', custom_description: 'text', discount: 'integer',
    discount_percentage: 'real', custom_title: 'text', is_custom: 'flag', hide_description: 'flag', snapshot_name: 'text', snapshot_description: 'text',
    snapshot_group_type: 'text', snapshot_is_recurring: 'flag', is_optional: 'flag',
  },
  offer_selected_links: { id: 'uuid', offer_id: 'uuid', link_id: 'uuid', is_enabled: 'flag', created_at: 'time' },
  offer_access_logs: {
    id: 'uuid', created_at: 'time', offer_id: 'uuid', accessed_email: 'text', accessed_at: 'time', ip_address: 'text', user_agent: 'text', referer: 'text', metadata: 'json',
  },
  licenses: {
    id: 'uuid', created_at: 'time', updated_at: 'time', organization_id: 'uuid', lead_id: 'uuid', offer_id: 'uuid', start_date: 'date', renewal_date: 'date',
    is_active: 'flag', notes: 'text', amount_eur: 'real', product: 'text', plan_type: 'text', seats: 'integer', payment_type: 'text', billing_interval: 'text',
  },
  license_offers: { license_id: 'uuid', offer_id: 'uuid', created_at: 'time' },
  policies: {
    id: 'uuid', created_at: 'time', updated_at: 'time', title: 'text', description: 'text', effective_date: 'date', organization_id: 'uuid', url: 'text',
  },
};

/**
 * Columns D1 holds that Core has not (migrations 0140, 0141). The group's copy and
 * verify read `COMMERCIAL_COLUMNS` only, so a copied row takes each column's
 * default and a second copy keeps what D1 wrote. Core's two doors never name
 * them. Member routes write them through the same repository.
 */
export const COMMERCIAL_D1_COLUMNS: Readonly<Partial<Record<CommercialTable, Readonly<Record<string, CommercialColumnKind>>>>> = {
  services: { slug: 'text', is_listed: 'flag', name_pt: 'text', summary_pt: 'text', description_pt: 'text' },
  offers: { unsent_draft: 'flag', has_unsent_changes: 'flag', accepted_version: 'integer', notes: 'text' },
  licenses: {
    signals_org_id: 'text', usage_schema_version: 'integer', usage_snapshot_at: 'time', usage_window_starts_at: 'time', usage_window_ends_at: 'time',
    usage_projects_count: 'integer', usage_sessions_created_30d: 'integer', usage_last_session_created_at: 'time',
    usage_workflow_runs_succeeded_30d: 'integer', usage_last_successful_workflow_run_at: 'time', usage_results_first_viewed_at: 'time',
    usage_credit_buckets: 'json', billing_status: 'text', billing_event_at: 'time',
  },
};

const commercialTable = z.enum(COMMERCIAL_TABLES);
export const coreColumnName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);
const columnName = coreColumnName;

/** A time Core sends: anything `Date.parse` reads, as Postgres would cast it. */
const timeValue = z.string().refine((value) => Number.isFinite(Date.parse(value)), 'not a time');

const VALUE_SCHEMAS: Record<CoreColumnKind, z.ZodType> = {
  uuid: z.uuid(),
  text: z.string().max(200_000),
  time: timeValue,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}/u),
  flag: z.boolean(),
  real: z.number(),
  integer: z.number().int(),
  json: z.json(),
};

/** What is wrong with a value of one column, or null. Null on a NOT NULL column is D1's refusal, as it is Postgres'. */
export function coreColumnValueIssue(table: string, kinds: Readonly<Record<string, CoreColumnKind>>, column: string, value: unknown): string | null {
  const kind = kinds[column];
  if (!kind) return `${table} has no column ${column}`;
  if (value === null) return null;
  return VALUE_SCHEMAS[kind].safeParse(value).success ? null : `${table}.${column} is not a ${kind}`;
}

function valueIssue(table: CommercialTable, column: string, value: unknown): string | null {
  return coreColumnValueIssue(table, COMMERCIAL_COLUMNS[table], column, value);
}

export const coreRowScalar = z.union([z.string().max(2_000), z.number(), z.boolean()]);
const scalar = coreRowScalar;

const CORE_ROWS_LIMIT = 1000;

/**
 * The filtered read of one group's tables, in Core's names, by every filter
 * sent. `not` is null-safe (`IS NOT`), so `{ is_accepted: true }` keeps a row
 * with no value, as PostgREST's `not.is.true` does. A list longer than the
 * limit pages by `offset`. Each column is checked against the group's list.
 */
function coreGroupRowsShape<const Op extends string, const Table extends string>(op: Op, tables: readonly [Table, ...Table[]]) {
  return {
    op: z.literal(op),
    table: z.enum(tables),
    eq: z.record(columnName, scalar.nullable()).optional(),
    not: z.record(columnName, scalar.nullable()).optional(),
    in: z.record(columnName, z.array(scalar).min(1).max(CORE_ROWS_LIMIT)).optional(),
    gte: z.record(columnName, scalar).optional(),
    lte: z.record(columnName, scalar).optional(),
    order: z.array(z.strictObject({ column: columnName, descending: z.boolean().default(false) })).max(4).optional(),
    limit: z.number().int().min(1).max(CORE_ROWS_LIMIT).default(CORE_ROWS_LIMIT),
    offset: z.number().int().min(0).default(0),
  };
}

interface GroupRowsFilters {
  table: unknown;
  eq?: Record<string, unknown> | undefined;
  not?: Record<string, unknown> | undefined;
  in?: Record<string, unknown> | undefined;
  gte?: Record<string, unknown> | undefined;
  lte?: Record<string, unknown> | undefined;
  order?: ReadonlyArray<{ column: string }> | undefined;
}

/** Every column a read names must be on the group's list. */
function checkGroupRowsColumns(read: GroupRowsFilters, columns: Readonly<Record<string, Readonly<Record<string, CoreColumnKind>>>>, context: z.RefinementCtx): void {
  const named = [
    ...Object.keys(read.eq ?? {}), ...Object.keys(read.not ?? {}), ...Object.keys(read.in ?? {}),
    ...Object.keys(read.gte ?? {}), ...Object.keys(read.lte ?? {}), ...(read.order ?? []).map((entry) => entry.column),
  ];
  const kinds = columns[read.table as string]!;
  for (const column of named) {
    if (!kinds[column]) context.addIssue({ code: 'custom', message: `${String(read.table)} has no column ${column}`, path: [column] });
  }
}

export function coreGroupRowsSchema<const Op extends string, const Table extends string>(
  op: Op,
  tables: readonly [Table, ...Table[]],
  columns: Readonly<Record<Table, Readonly<Record<string, CoreColumnKind>>>>,
) {
  return z.strictObject(coreGroupRowsShape(op, tables)).superRefine((read, context) => checkGroupRowsColumns(read, columns, context));
}

/**
 * `commercial_rows`: rows of one commercial table. `version` is one earlier
 * version of an offer, as the buyer saw it: `?v=<n>` on the offer page. Without
 * it a read of an offer, its lines or its links answers the latest sent version,
 * never unsent edits. It needs `eq.id` on `offers` and `eq.offer_id` on
 * `offer_services` and `offer_selected_links`.
 */
export const coreCommercialRowsSchema = z.strictObject({
  ...coreGroupRowsShape('commercial_rows', COMMERCIAL_TABLES),
  version: z.number().int().min(1).optional(),
}).superRefine((read, context) => {
  if (read.version !== undefined) {
    const key = read.table === 'offers' ? 'id' : read.table === 'offer_services' || read.table === 'offer_selected_links' ? 'offer_id' : null;
    if (key === null || typeof read.eq?.[key] !== 'string') {
      context.addIssue({ code: 'custom', message: 'A version read names one offer.', path: ['version'] });
    }
  }
  checkGroupRowsColumns(read, COMMERCIAL_COLUMNS, context);
});
export type CoreCommercialRowsRequest = z.infer<typeof coreCommercialRowsSchema>;

/** `commercial_rows`: the rows in Core's names. */
export const coreCommercialRowsResponseSchema = z.object({
  data: z.array(z.record(z.string(), z.json())),
});
export type CoreCommercialRowsResponse = { data: Array<Record<string, unknown>> };

const commercialValues = z.record(columnName, z.json()).refine((record) => Object.keys(record).length > 0, 'values names no column');

/**
 * One commercial write from Core's own flows. The answer is the whole row in
 * Core's names, or null when an update or delete matched no row. An `update`
 * applies only while every `only_if` column holds that value and no `unless`
 * column does: the accept path's `is_accepted IS NOT TRUE`, and sent to viewed.
 * A create names no `id`; the Worker makes it.
 */
export const coreCommercialWriteSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), entity: z.literal('commercial'), table: commercialTable, values: commercialValues }),
  z.strictObject({
    action: z.literal('update'),
    entity: z.literal('commercial'),
    table: commercialTable,
    id: z.uuid(),
    values: commercialValues,
    only_if: z.record(columnName, scalar.nullable()).optional(),
    unless: z.record(columnName, scalar.nullable()).optional(),
  }),
  /** The pricing request's undo: an offer whose lines failed goes again. */
  z.strictObject({ action: z.literal('delete'), entity: z.literal('commercial'), table: commercialTable, id: z.uuid() }),
]).superRefine((write, context) => {
  if (write.action === 'delete') return;
  for (const [column, value] of Object.entries(write.values)) {
    const issue = column === 'id' ? `${write.table}.id is not written` : valueIssue(write.table, column, value);
    if (issue) context.addIssue({ code: 'custom', message: issue, path: ['values', column] });
  }
  if (write.action === 'update') {
    for (const column of [...Object.keys(write.only_if ?? {}), ...Object.keys(write.unless ?? {})]) {
      if (!COMMERCIAL_COLUMNS[write.table][column]) context.addIssue({ code: 'custom', message: `${write.table} has no column ${column}`, path: [column] });
    }
  }
});
export type CoreCommercialWriteRequest = z.infer<typeof coreCommercialWriteSchema>;
