import { z } from 'zod';
import { coreCommercialWriteSchema, type CoreCommercialWriteRequest } from './core-commercial';
import { CRM_RESPONSIBLE_PARTIES, CRM_TASK_STATUSES } from './task-values';

/*
 * Core's own writers, through Meet's Worker (CORE_FOLD_PLAN Phase 2).
 *
 * Core's public forms, webhooks and flows (the website contact form, pricing
 * requests, the newsletter, NDA signing, bookings, Luma registrations, offer
 * acceptance) wrote the CRM straight to Postgres. Under the fold plan the
 * Worker is the one write path: Core sends each write here, signed with its
 * own inbound key (`x-internal-key-id: core`), and the Worker
 * forwards it to the store that holds the table group. While the group is on
 * Core, that is Core's `POST /api/public/meet-crm-writes`; when the group
 * flips to D1, only the Worker changes.
 *
 * One write is one row: a create, or an update by id. Core's receiving route
 * owns the column list per table and refuses a column it does not list.
 */

/** Fold group 1: the tables these writes may touch. */
export const CORE_WRITE_ENTITIES = ['organizations', 'contacts', 'leads', 'projects'] as const;
export type CoreWriteEntity = (typeof CORE_WRITE_ENTITIES)[number];

const column = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u);

/** The columns to write. Keys are column names; Core checks them against the table. */
const values = z.record(column, z.json())
  .refine((record) => Object.keys(record).length > 0, 'values names no column')
  .refine((record) => Object.keys(record).length <= 64, 'values names more than 64 columns');

/** The columns to read back from the written row, as PostgREST's `select` takes them. `id` when not named. */
const select = z.string().regex(/^[a-z][a-z0-9_]{0,62}(, ?[a-z][a-z0-9_]{0,62}){0,31}$/u).optional();

const subjectWriteSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create'),
    entity: z.enum(CORE_WRITE_ENTITIES),
    values,
    select,
  }),
  z.strictObject({
    action: z.literal('update'),
    entity: z.enum(CORE_WRITE_ENTITIES),
    id: z.uuid(),
    values,
    select,
  }),
]);

/**
 * A task in Core's column names, for Core's own task writers:
 * the proposed task an offer files, and the Signals demo debrief's next
 * task. Core sends these only once the `tasks` group moved to D1; before
 * that it writes its own table, and the Worker refuses with 409.
 */
const nullableUuid = z.uuid().nullable();
export const coreTaskValuesSchema = z.strictObject({
  title: z.string().trim().min(1).max(500),
  notes: z.string().max(20_000).nullable(),
  status: z.enum(CRM_TASK_STATUSES),
  responsible_party: z.enum(CRM_RESPONSIBLE_PARTIES),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).nullable(),
  due_date: z.iso.datetime({ offset: true }).nullable(),
  assigned_to: nullableUuid,
  project_id: nullableUuid,
  lead_id: nullableUuid,
  organization_id: nullableUuid,
  contact_id: nullableUuid,
  signals_account_id: nullableUuid,
  milestone_id: nullableUuid,
  tags: z.array(z.string().trim().min(1).max(200)).max(20),
}).partial();
export type CoreTaskValues = z.infer<typeof coreTaskValuesSchema>;

const taskValues = coreTaskValuesSchema.refine((record) => Object.keys(record).length > 0, 'values names no column');

const taskWriteSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), entity: z.literal('tasks'), values: coreTaskValuesSchema.extend({ title: z.string().trim().min(1).max(500) }), select }),
  z.strictObject({ action: z.literal('update'), entity: z.literal('tasks'), id: z.uuid(), values: taskValues, select }),
  /** The debrief's undo: a task it created goes again when the call it files fails. */
  z.strictObject({ action: z.literal('delete'), entity: z.literal('tasks'), id: z.uuid() }),
]);

/**
 * An interaction in Core's column names, for Core's own interaction writers
 *: the NDA, pricing-request, lead and Luma intake rows, the offer
 * emails and reminders, and the Signals demo debrief. Core sends these only
 * once the `interactions` group moved to D1; before that it writes its own
 * table, and the Worker refuses with 409.
 *
 * `lead_id`, `project_id` and `event_id` file the row, as Core's mirror
 * trigger reads them; D1 keeps them as `interaction_subjects` rows.
 * `organization_id` is the organization the row concerns.
 */
export const coreInteractionValuesSchema = z.strictObject({
  title: z.string().trim().min(1).max(500),
  type: z.string().trim().min(1).max(50),
  description: z.string().max(100_000).nullable(),
  summary_markdown: z.string().max(100_000).nullable(),
  occurred_at: z.iso.datetime({ offset: true }).nullable(),
  source: z.string().trim().min(1).max(100),
  channel: z.string().trim().min(1).max(100).nullable(),
  status: z.string().trim().min(1).max(100).nullable(),
  url: z.string().max(2_000).nullable(),
  external_id: z.string().trim().min(1).max(500).nullable(),
  metadata: z.record(z.string(), z.json()).nullable(),
  tags: z.array(z.string().trim().min(1).max(200)).max(50),
  transcript_url: z.string().max(2_000).nullable(),
  transcript_preview: z.string().max(5_000).nullable(),
  lead_id: nullableUuid,
  project_id: nullableUuid,
  event_id: nullableUuid,
  organization_id: nullableUuid,
  contact_id: nullableUuid,
  signals_account_id: nullableUuid,
  signals_evaluation_id: nullableUuid,
  gmail_email_id: z.string().trim().min(1).max(500).nullable(),
  interaction_kind: z.string().trim().min(1).max(100).nullable(),
  is_personal: z.boolean(),
  owner_email: z.string().trim().toLowerCase().email().max(254).nullable(),
  created_by: nullableUuid,
}).partial();
export type CoreInteractionValues = z.infer<typeof coreInteractionValuesSchema>;

/** The contacts on the row, as `interaction_contacts`. On an update the list replaces the old one; absent leaves it. */
const contactIds = z.array(z.uuid()).max(100).optional();

const interactionWriteSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create'),
    entity: z.literal('interactions'),
    values: coreInteractionValuesSchema.extend({ title: z.string().trim().min(1).max(500), type: z.string().trim().min(1).max(50) }),
    contact_ids: contactIds,
    select,
  }),
  z.strictObject({ action: z.literal('update'), entity: z.literal('interactions'), id: z.uuid(), values: coreInteractionValuesSchema, contact_ids: contactIds, select }),
  /** The debrief's undo: an interaction it created goes again when a later step fails. */
  z.strictObject({ action: z.literal('delete'), entity: z.literal('interactions'), id: z.uuid() }),
]);

/**
 * A partner agreement signature (: kept, moves with `interactions`).
 * One per contact and agreement: a second signature replaces the first.
 */
export const corePartnerSignatureValuesSchema = z.strictObject({
  agreement_id: z.string().trim().min(1).max(200),
  contact_id: z.uuid(),
  signer_name: z.string().trim().min(1).max(500),
  signer_email: z.string().trim().toLowerCase().email().max(254),
  signing_for: z.string().trim().min(1).max(50),
  organization_name: z.string().trim().max(500).nullable(),
  signed_at: z.iso.datetime({ offset: true }),
  metadata: z.record(z.string(), z.json()),
});
export type CorePartnerSignatureValues = z.infer<typeof corePartnerSignatureValuesSchema>;

const partnerSignatureWriteSchema = z.strictObject({
  action: z.literal('upsert'),
  entity: z.literal('partner_agreement_signatures'),
  values: corePartnerSignatureValuesSchema,
  select,
});

export const coreWriteRequestSchema = z.union([subjectWriteSchema, taskWriteSchema, interactionWriteSchema, partnerSignatureWriteSchema, coreCommercialWriteSchema]);
export type CoreWriteRequest = z.infer<typeof coreWriteRequestSchema>;
export type CoreSubjectWriteRequest = z.infer<typeof subjectWriteSchema>;
export type CoreTaskWriteRequest = z.infer<typeof taskWriteSchema>;
export type CoreInteractionWriteRequest = z.infer<typeof interactionWriteSchema>;
export type CorePartnerSignatureWriteRequest = z.infer<typeof partnerSignatureWriteSchema>;
export type { CoreCommercialWriteRequest };

/**
 * The written row, with the `select` columns. Null on an update whose id
 * matched no row: the same answer Postgres gives an update with no match.
 */
export const coreWriteResponseSchema = z.looseObject({
  data: z.record(z.string(), z.json()).nullable(),
});
export type CoreWriteResponse = z.infer<typeof coreWriteResponseSchema>;

/**
 * A refusal, as Core's route and the Worker answer it. `code` is the Postgres
 * error code when the database refused the row (`23505` for a unique
 * violation), so a caller that branched on it before still can.
 */
export const coreWriteRefusalSchema = z.looseObject({
  error: z.string(),
  code: z.string().nullish(),
});
export type CoreWriteRefusal = z.infer<typeof coreWriteRefusalSchema>;

/*
 * A merge on D1 leaves merged ids in the tables that stay in Core. The Worker
 * sends this to Core's `POST /api/public/meet-fold-merge-repoint`,
 * with `dry_run` before the merge and without it after. Each merge has its own
 * result. `code` is the Postgres code; `23505` is a conflict a person resolves.
 */
const coreMergeEntity = z.enum(['organizations', 'contacts', 'leads']);
const coreMergeRepointSchema = z.strictObject({
  entity: coreMergeEntity,
  into_id: z.uuid(),
  from_ids: z.array(z.uuid()).min(1).max(100),
});
export type CoreMergeRepoint = z.infer<typeof coreMergeRepointSchema>;

export const coreMergeRepointRequestSchema = z.strictObject({
  merges: z.array(coreMergeRepointSchema).min(1).max(50),
  dry_run: z.boolean().optional(),
});
export type CoreMergeRepointRequest = z.infer<typeof coreMergeRepointRequestSchema>;

const coreMergeRepointResultSchema = z.discriminatedUnion('ok', [
  z.object({ entity: coreMergeEntity, into_id: z.string(), ok: z.literal(true), moved: z.number().int() }),
  z.object({ entity: coreMergeEntity, into_id: z.string(), ok: z.literal(false), code: z.string(), error: z.string() }),
]);
export type CoreMergeRepointResult = z.infer<typeof coreMergeRepointResultSchema>;

export const coreMergeRepointResponseSchema = z.looseObject({ results: z.array(coreMergeRepointResultSchema) });
export type CoreMergeRepointResponse = z.infer<typeof coreMergeRepointResponseSchema>;
