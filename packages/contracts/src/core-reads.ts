import { z } from 'zod';
import { coreCommercialRowsSchema } from './core-commercial';
import { CORE_WRITE_ENTITIES } from './core-writes';

/*
 * Core's own flows, reading fold group 1 through Meet's Worker.
 *
 * Core's public flows (the website forms, the newsletter, email capture, the
 * public project page) read organizations, contacts, leads and projects from
 * Postgres. After the `subjects` group moves to D1, Core's copy is
 * frozen and goes stale. Core then reads here instead, signed with its own
 * inbound key (`x-internal-key-id: core`), as it writes through
 * `/api/internal/core-writes`. The answers use Core's column names, so a
 * caller reads the same row from either store.
 *
 * This door answers only while the group is on D1. While it is on Core, Core
 * reads its own tables, and the door refuses with 409 `not_configured`.
 */

/** The entities `subject_search` reads. Projects are not searched: Core's offer pages pick no project. */
export const CORE_SUBJECT_SEARCH_ENTITIES = ['leads', 'organizations', 'contacts'] as const;
export type CoreSubjectSearchEntity = (typeof CORE_SUBJECT_SEARCH_ENTITIES)[number];

const email = z.string().trim().toLowerCase().email().max(254);

export const coreReadRequestSchema = z.discriminatedUnion('op', [
  /** One row by id, every column, in Core's names. */
  z.strictObject({ op: z.literal('row'), entity: z.enum(CORE_WRITE_ENTITIES), id: z.uuid() }),
  /**
   * The contact with this address: its primary email, its corporate email, or
   * another address it holds. When two contacts hold it, the door refuses with
   * 409 `ambiguous_contact`, as Core's `findContactByEmail` fails closed.
   */
  z.strictObject({ op: z.literal('contact_by_email'), email }),
  /** The oldest organization with this name, compared without case: Core's find-or-create by name. */
  z.strictObject({ op: z.literal('organization_by_name'), name: z.string().trim().min(1).max(500) }),
  /** The oldest organization with this email domain (`organizations.domain`): Core's find-or-create by domain. */
  z.strictObject({ op: z.literal('organization_by_domain'), domain: z.string().trim().toLowerCase().min(1).max(253) }),
  /** The newest lead of this contact, with one of `statuses` when sent. */
  z.strictObject({
    op: z.literal('lead_by_contact'),
    contact_id: z.uuid(),
    statuses: z.array(z.string().trim().min(1).max(100)).min(1).max(20).optional(),
  }),
  /** The oldest project made from this lead: offer acceptance checks it before it creates one. */
  z.strictObject({ op: z.literal('project_by_lead'), lead_id: z.uuid() }),
  /** What the public project page shows from group 1, and whether `email` may be credited with a view. */
  z.strictObject({ op: z.literal('project_page'), id: z.uuid(), email: email.nullable().optional() }),
  /**
   * The group 1 addresses that may sign an offer, from the offer's lead and
   * organization. Core sends the two ids and applies its own rule (`public_offer_access_check`).
   */
  z.strictObject({ op: z.literal('offer_signers'), lead_id: z.uuid().nullable(), organization_id: z.uuid().nullable() }),
  /**
   * Leads, organizations or contacts for a picker or a list of names: the
   * dashboard's offer pages. `query` matches without case on a
   * lead's title or organization name, an organization's name or legal name,
   * and a contact's name or addresses; empty matches every row. `ids` keeps
   * only these rows. Sorted by name or title, `limit` rows at most.
   */
  z.strictObject({
    op: z.literal('subject_search'),
    entity: z.enum(CORE_SUBJECT_SEARCH_ENTITIES),
    query: z.string().trim().max(200).default(''),
    ids: z.array(z.uuid()).min(1).max(500).optional(),
    limit: z.number().int().min(1).max(1000).default(50),
  }),
  /**
   * Rows by id, every column, in Core's names. A missing id is not in the
   * answer. Core's lists use this instead of one `row` per id, because this door
   * takes 60 calls a minute.
   */
  z.strictObject({ op: z.literal('rows'), entity: z.enum(CORE_WRITE_ENTITIES), ids: z.array(z.uuid()).min(1).max(500) }),
  /** The contacts, leads or projects of an organization, every column, sorted by name or title without case. */
  z.strictObject({
    op: z.literal('organization_rows'),
    entity: z.enum(['contacts', 'leads', 'projects']),
    organization_id: z.uuid(),
    limit: z.number().int().min(1).max(1000).default(1000),
  }),
  /*
   * Fold group 2. These ops answer once the `tasks` group is on
   * D1, whatever store holds group 1.
   */
  /** One task by id, every column, in Core's names. */
  z.strictObject({ op: z.literal('task'), id: z.uuid() }),
  /** The task that carries this tag: Core's proposed task finds its event's proposal before it files one. */
  z.strictObject({ op: z.literal('task_by_tag'), tag: z.string().trim().min(1).max(200) }),
  /** The milestones and tasks the public project page shows. */
  z.strictObject({ op: z.literal('project_work'), id: z.uuid() }),
  /** Every milestone with its project's title, for Core's milestones.ics feed. */
  z.strictObject({ op: z.literal('milestones') }),
  /**
   * Tasks by every filter sent, every column in Core's names, by due date with
   * no due date last: the Signals lists. `signals_account_or_none` keeps the
   * tasks filed on that account or on no account. At least the organization or
   * the accounts.
   */
  z.strictObject({
    op: z.literal('tasks'),
    organization_id: z.uuid().optional(),
    signals_account_ids: z.array(z.uuid()).min(1).max(500).optional(),
    signals_account_or_none: z.uuid().optional(),
    statuses: z.array(z.string().trim().min(1).max(50)).min(1).max(20).optional(),
    limit: z.number().int().min(1).max(1000).default(100),
  }).refine((read) => Boolean(read.organization_id || read.signals_account_ids), 'tasks needs an organization or accounts'),
  /*
   * Fold group 4. These ops answer once the `interactions` group
   * is on D1. A row is in Core's names: `lead_id`, `project_id` and
   * `event_id` from its filing, `tags` a list, `metadata` an object, and
   * `contacts` (`{ id, name, email }`) from `interaction_contacts` and the
   * older `contact_id`.
   */
  /** One interaction by id. */
  z.strictObject({ op: z.literal('interaction'), id: z.uuid() }),
  /**
   * Interactions newest first, by every filter sent: the public project page
   * (`project_id`), the offer email's once-only check (`type` and the
   * `metadata` keys it must hold), and the Signals demo lists
   * (`organization_id`, `signals_account_ids`, `interaction_kind`). A
   * personal row is never in the list. At least one filter.
   */
  z.strictObject({
    op: z.literal('interactions'),
    project_id: z.uuid().optional(),
    lead_id: z.uuid().optional(),
    organization_id: z.uuid().optional(),
    signals_account_ids: z.array(z.uuid()).min(1).max(500).optional(),
    interaction_kind: z.string().trim().min(1).max(100).optional(),
    type: z.string().trim().min(1).max(50).optional(),
    /** Each key must hold this value in the row's metadata, as PostgREST's `contains` on a flat object. */
    metadata: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/u), z.union([z.string(), z.number(), z.boolean()])).optional(),
    limit: z.number().int().min(1).max(500).default(50),
  }).refine(
    (read) => Boolean(read.project_id || read.lead_id || read.organization_id || read.signals_account_ids || read.interaction_kind || read.type || read.metadata),
    'interactions needs a filter',
  ),
  /** The signature of this agreement by this contact, or null. */
  z.strictObject({ op: z.literal('partner_agreement_signature'), agreement_id: z.string().trim().min(1).max(200), contact_id: z.uuid() }),
  /* Fold group 5. Answers once the `commercial` group is on D1. */
  coreCommercialRowsSchema,
]);
export type CoreReadRequest = z.infer<typeof coreReadRequestSchema>;

/** Every op but `project_page`: the row, or null when none matches. */
export const coreReadRowResponseSchema = z.object({
  data: z.record(z.string(), z.json()).nullable(),
});
export type CoreReadRowResponse = z.infer<typeof coreReadRowResponseSchema>;

const nullableText = z.string().nullable();

/**
 * `project_page`: the project and its organization and lead, in the fields
 * Core's `/api/public/projects/[id]` answers. Null when no project has the id.
 */
export const coreProjectPageSchema = z.object({
  project: z.object({
    id: z.string(),
    title: z.string(),
    description: nullableText,
    specs: nullableText,
    technical: nullableText,
    research: nullableText,
    design: nullableText,
    contract: nullableText,
    analytics: nullableText,
    authentication: nullableText,
    status: z.string(),
    start_date: nullableText,
    end_date: nullableText,
    url: nullableText,
    evid: nullableText,
    lead_id: nullableText,
    created_at: z.string(),
    updated_at: z.string(),
  }),
  organization: z.object({
    id: z.string(),
    name: z.string(),
    legal_name: nullableText,
    country: nullableText,
    website: nullableText,
  }).nullable(),
  lead: z.object({ id: z.string(), title: z.string(), status: z.string() }).nullable(),
  /**
   * True when `email` belongs to the lead's contact or to any contact at the
   * project's organization: the rule of Core's `public_get_project`. False
   * when no email was sent.
   */
  email_has_access: z.boolean(),
});
export type CoreProjectPage = z.infer<typeof coreProjectPageSchema>;

export const coreProjectPageResponseSchema = z.object({ data: coreProjectPageSchema.nullable() });
export type CoreProjectPageResponse = z.infer<typeof coreProjectPageResponseSchema>;

/**
 * `offer_signers`: the part of Core's `public_offer_allowed_addresses` that
 * reads group 1. The lead's contact by its email, its corporate email and
 * every other address it holds, and every contact at the organization by its
 * email and corporate email. Lower case, trimmed, each once.
 */
export const coreOfferSignersResponseSchema = z.object({
  data: z.object({ addresses: z.array(z.string()) }),
});
export type CoreOfferSignersResponse = z.infer<typeof coreOfferSignersResponseSchema>;

/** A `subject_search` lead: its title and status, with its organization's and contact's names. */
export const coreLeadHitSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  organization_id: nullableText,
  organization_name: nullableText,
  contact_id: nullableText,
  contact_name: nullableText,
  contact_email: nullableText,
  contact_corporate_email: nullableText,
});

/** A `subject_search` organization. */
export const coreOrganizationHitSchema = z.object({
  id: z.string(),
  name: z.string(),
  legal_name: nullableText,
  country: nullableText,
});

/** A `subject_search` contact. */
export const coreContactHitSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: nullableText,
  corporate_email: nullableText,
  organization_id: nullableText,
});

export type CoreLeadHit = z.infer<typeof coreLeadHitSchema>;
export type CoreOrganizationHit = z.infer<typeof coreOrganizationHitSchema>;
export type CoreContactHit = z.infer<typeof coreContactHitSchema>;

/** `rows`, `organization_rows` and `tasks`: the matching rows in Core's names. */
export const coreRowsResponseSchema = z.object({
  data: z.array(z.record(z.string(), z.json())),
});
export type CoreRowsResponse = z.infer<typeof coreRowsResponseSchema>;

/** `subject_search`: the matching rows, in the hit shape of the entity. */
export const coreSubjectSearchResponseSchemas = {
  leads: z.object({ data: z.array(coreLeadHitSchema) }),
  organizations: z.object({ data: z.array(coreOrganizationHitSchema) }),
  contacts: z.object({ data: z.array(coreContactHitSchema) }),
} as const satisfies Record<CoreSubjectSearchEntity, z.ZodType>;
export type CoreSubjectSearchResponse = { data: CoreLeadHit[] | CoreOrganizationHit[] | CoreContactHit[] };
/**
 * A milestone in Core's names. `due_date` is Core's `date`
 * (`YYYY-MM-DD`); `start_at` and `created_at` are ISO times.
 */
export const coreMilestoneSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  title: z.string(),
  status: z.string(),
  notes: nullableText,
  due_date: nullableText,
  start_at: nullableText,
  start_time: nullableText,
  timezone: nullableText,
  location: nullableText,
  place: nullableText,
  created_at: z.string(),
});
export type CoreMilestone = z.infer<typeof coreMilestoneSchema>;

/** A project's task as the public project page shows it, in Core's names. */
export const coreProjectTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: nullableText,
  status: z.string(),
  due_date: nullableText,
  completed_at: nullableText,
  milestone_id: nullableText,
  responsible_party: z.string(),
  created_at: z.string(),
});
export type CoreProjectTask = z.infer<typeof coreProjectTaskSchema>;

/** `project_work`: milestones by due date, then tasks newest first, as Core's page orders them. */
export const coreProjectWorkResponseSchema = z.object({
  data: z.object({ milestones: z.array(coreMilestoneSchema), tasks: z.array(coreProjectTaskSchema) }),
});
export type CoreProjectWorkResponse = z.infer<typeof coreProjectWorkResponseSchema>;

/** `milestones`: every milestone with its project's title, by due date. */
export const coreMilestonesResponseSchema = z.object({
  data: z.array(coreMilestoneSchema.extend({ project_title: nullableText })),
});
export type CoreMilestonesResponse = z.infer<typeof coreMilestonesResponseSchema>;

/** `interactions`: the matching rows in Core's names, newest first. */
export const coreInteractionsResponseSchema = z.object({
  data: z.array(z.record(z.string(), z.json())),
});
export type CoreInteractionsResponse = z.infer<typeof coreInteractionsResponseSchema>;
