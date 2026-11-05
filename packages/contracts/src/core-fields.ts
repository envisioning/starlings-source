import { z } from 'zod';

/*
 * Core's CRM registry as the web reads it through the Worker: a
 * subject's Fields pane and the palette's Core search. Mac and iOS read the
 * same registry directly with a device PAT (`core-kit`, docs/CORE_REGISTRY.md);
 * the browser holds no Core token, so the Worker answers as the member with
 * its broker PAT (`corePatFetch`), the arrangement `/api/cms/*` and the sales
 * inbox already use.
 *
 * Core owns the registry: which entities exist, their fields, the field
 * kinds and who may write. A client draws what the registry lists and sends
 * only what changed; Core's per-entity schema is the validator.
 *
 * Open where Core may grow: an unknown field kind decodes, and a client
 * shows that field read-only rather than failing the whole registry.
 */

/**
 * The Core entities a web Fields pane may read and write: the records behind
 * Work's subjects. A partner is an organization (PARTNERS (HQ Docs)). Events
 * are CMS rows and already edit through `/api/cms/events`. Anything else is
 * generic Core browsing, which the web does not do.
 */
export const CORE_FIELDS_ENTITIES = ['projects', 'leads', 'organizations'] as const;
export type CoreFieldsEntity = (typeof CORE_FIELDS_ENTITIES)[number];

export function isCoreFieldsEntity(value: string): value is CoreFieldsEntity {
  return (CORE_FIELDS_ENTITIES as readonly string[]).includes(value);
}

/** The Core entity behind a Work subject kind, or null when it has none on the web. */
export function coreFieldsEntityFor(kind: string): CoreFieldsEntity | null {
  switch (kind) {
    case 'project': return 'projects';
    case 'lead': return 'leads';
    case 'organization': return 'organizations';
    default: return null;
  }
}

/** A CRM column name, as Core's registry spells it. */
const coreColumnName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);

export const coreFieldOptionSchema = z.object({
  value: z.string(),
  label: z.string(),
}).loose();

/** `CrmFieldContract` in core-web, the parts a web form reads. */
export const coreFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  /** Open: `section`, `text`, `select`, `relation`, … (`CrmFieldKind` in core-web). */
  kind: z.string(),
  section: z.string().nullish(),
  required: z.boolean().nullish(),
  placeholder: z.string().nullish(),
  options: z.array(coreFieldOptionSchema).nullish(),
  relationEntity: z.string().nullish(),
  /** A junction or computed field is not a column and is never written as one. */
  storage: z.string().nullish(),
  maxLength: z.number().nullish(),
}).loose();
export type CoreField = z.infer<typeof coreFieldSchema>;

export const coreEntitySchema = z.object({
  id: coreColumnName,
  singularLabel: z.string(),
  pluralLabel: z.string(),
  primaryField: z.string(),
  capabilities: z.object({
    update: z.boolean().optional(),
    search: z.boolean().optional(),
  }).loose(),
  fields: z.array(coreFieldSchema),
  /** The member's grant under the broker PAT. AND `canWrite` with `capabilities.update`. */
  access: z.object({
    canRead: z.boolean(),
    canWrite: z.boolean(),
  }).loose(),
}).loose();
export type CoreEntity = z.infer<typeof coreEntitySchema>;

/** `GET /api/core/registry`: Core's envelope, forwarded whole. */
export const coreRegistryResponseSchema = z.object({
  data: z.object({
    entities: z.array(coreEntitySchema),
  }).loose(),
}).loose();
export type CoreRegistryResponse = z.infer<typeof coreRegistryResponseSchema>;

/** A CRM row. Core selects more than the registry lists; a form reads only the listed fields. */
export const coreRecordSchema = z.record(z.string(), z.unknown());
export type CoreRecord = z.infer<typeof coreRecordSchema>;

/** `GET` and `PATCH /api/core/fields/:entity/:id`. */
export const coreRecordResponseSchema = z.object({ data: coreRecordSchema }).loose();

/**
 * A Fields write through `PATCH /api/core/fields/:entity/:id`: a flat object
 * of column values. Core's schema decides which keys and types are valid;
 * this bounds the shape and size before the Worker forwards it.
 */
export const coreFieldsWriteBodySchema = z
  .record(
    coreColumnName,
    // A UUID list is a junction write, e.g. an interaction's `contact_ids`.
    z.union([z.string().max(200_000), z.number(), z.boolean(), z.null(), z.array(z.string().uuid()).max(100)]),
  )
  .refine((value) => Object.keys(value).length > 0, { message: 'A Fields write needs at least one field.' })
  .refine((value) => Object.keys(value).length <= 64, { message: 'Too many fields.' });
export type CoreFieldsWriteBody = z.infer<typeof coreFieldsWriteBodySchema>;

/**
 * The Core records a Claude reads and writes through the Worker
 * (`/api/core/records/:entity`, `/api/core/fields/:entity/:id`; docs/MCP.md,
 * the `cms` tool). Wider than `CORE_FIELDS_ENTITIES`, which is what the web's
 * Fields pane draws. A note is an interaction of type `note`.
 */
export const CORE_RECORD_ENTITIES = ['organizations', 'contacts', 'interactions', 'projects', 'leads'] as const;
export type CoreRecordEntity = (typeof CORE_RECORD_ENTITIES)[number];

export function isCoreRecordEntity(value: string): value is CoreRecordEntity {
  return (CORE_RECORD_ENTITIES as readonly string[]).includes(value);
}

/**
 * The records a member merges (`POST /api/core/merge/:entity`). While the
 * `subjects` group answers from Core, Core merges them
 * (`POST /api/agent/entities/:entity/merge`): it keeps the oldest record,
 * moves every link from the others onto it, keeps their emails as aliases,
 * deletes them, and writes an audit row naming the member. Core does not
 * merge leads. Once the group answers from D1, the Worker merges all three
 * the same way (`record-merges.ts`).
 */
export const CORE_MERGE_ENTITIES = ['organizations', 'contacts', 'leads'] as const;
export type CoreMergeEntity = (typeof CORE_MERGE_ENTITIES)[number];

export function isCoreMergeEntity(value: string): value is CoreMergeEntity {
  return (CORE_MERGE_ENTITIES as readonly string[]).includes(value);
}

export const coreMergeBodySchema = z.object({
  ids: z.array(z.string().uuid('Each id must be a UUID.')).min(2, 'A merge takes at least two records.').max(10, 'Merge at most ten records at a time.')
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, { message: 'The ids must be distinct.' }),
}).strict();
export type CoreMergeBody = z.infer<typeof coreMergeBodySchema>;

/**
 * `POST /api/core/merge/:entity`: the record that stays and the records
 * merged into it. The same fields on Core and on D1. Core's own
 * fields (`survivorId`, `mergedOrganizationIds`, …) travel beside them.
 */
export const coreMergeResponseSchema = z.object({
  data: z.looseObject({
    entity: z.enum(CORE_MERGE_ENTITIES),
    kept: z.string(),
    merged: z.array(z.string()),
  }),
});
export type CoreMergeResponse = z.infer<typeof coreMergeResponseSchema>;

/**
 * A lead created through `POST /api/core/records/:entity` names its
 * organization, the rule `crmSubjectCreateCommandSchema` holds for Work's own
 * create. A project may have none. Checked on top of
 * `coreFieldsWriteBodySchema`.
 */
export const CORE_RECORD_ORGANIZATION_REQUIRED = ['leads'] as const;

export const coreRecordOrganizationSchema = z.looseObject({
  organization_id: z.string({ error: 'Choose an organization before creating a lead.' })
    .uuid({ error: 'Choose an organization before creating a lead.' }),
});

export function coreRecordNeedsOrganization(entity: CoreRecordEntity): boolean {
  return (CORE_RECORD_ORGANIZATION_REQUIRED as readonly string[]).includes(entity);
}

/**
 * What `GET /api/core/records/:entity` passes on to Core: Core's own filters
 * (`q`, `limit`, `organization_id`, `type`, …), each a lowercase column-like
 * key with a bounded value.
 */
export const coreRecordListQuerySchema = z
  .record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u, 'Unknown filter.'), z.string().max(500))
  .refine((value) => Object.keys(value).length <= 20, { message: 'Too many filters.' });
export type CoreRecordListQuery = z.infer<typeof coreRecordListQuerySchema>;

/**
 * The filters each Core list route reads, besides `q`, `limit` and `offset`
 * (core-web `src/app/api/agent/<entity>/route.ts`). Core ignores any other
 * key, so a filter it does not read would answer with every row as if it had
 * matched: a lead list "for one organization" came back as the newest leads
 * of all of them. The Worker refuses those instead. Widen a list here when
 * Core's route starts reading the key.
 */
export const CORE_RECORD_LIST_FILTERS = {
  organizations: ['is_partner', 'is_agency', 'is_existing_client'],
  contacts: ['organization_id', 'source_key'],
  interactions: ['type', 'lead_id', 'project_id', 'organization_id', 'contact_id'],
  projects: [],
  leads: ['organization_id', 'contact_id'],
} as const satisfies Record<CoreRecordEntity, readonly string[]>;

const CORE_RECORD_LIST_PAGING = ['q', 'limit', 'offset'] as const;

/** `coreRecordListQuerySchema` for one entity: a key Core would drop is refused. */
export function coreRecordListQueryFor(entity: CoreRecordEntity) {
  const filters: readonly string[] = CORE_RECORD_LIST_FILTERS[entity];
  return coreRecordListQuerySchema.superRefine((value, context) => {
    const ignored = Object.keys(value).filter((key) => !filters.includes(key) && !(CORE_RECORD_LIST_PAGING as readonly string[]).includes(key));
    if (ignored.length === 0) return;
    const takes = filters.length > 0 ? `filters ${entity} by ${filters.join(', ')} only` : `has no filter for ${entity}, only q, limit and offset`;
    context.addIssue({ code: 'custom', message: `Core does not filter ${entity} by ${ignored.join(', ')}: it ${takes}.` });
  });
}

/** What `GET /api/core/search` takes, as the Worker reads the query string. */
export const coreSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type CoreSearchQuery = z.infer<typeof coreSearchQuerySchema>;

/** One Core search hit (`AgentSearchResultItem` in core-web). */
export const coreSearchHitSchema = z.object({
  entity: z.string(),
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  status: z.string().nullish(),
  /** Core's own page for the record, a path on Core's origin (`/dashboard/contacts/<id>`). */
  href: z.string(),
}).loose();
export type CoreSearchHit = z.infer<typeof coreSearchHitSchema>;

/** `GET /api/core/search`: Core's envelope, forwarded whole. */
export const coreSearchResponseSchema = z.object({
  data: z.array(coreSearchHitSchema),
}).loose();
export type CoreSearchResponse = z.infer<typeof coreSearchResponseSchema>;
