import { z } from 'zod';

/*
 * Core's CMS registry and records, as Meet reads them through `/api/cms/*`
 *. Core owns the registry: which entities exist, their fields,
 * the field kinds, and who may write. A Meet editor draws the fields the
 * registry lists and sends only what changed; Core's strict per-entity
 * schema (`cmsWriteSchema` in core-web) is the validator. The write body is
 * `cmsWriteBodySchema` in index.ts.
 *
 * Open where Core may grow: an unknown field kind decodes, and a client
 * shows that field read-only instead of failing the whole registry.
 */

/** A CMS column name, as Core's registry spells it. */
const cmsColumnName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);

/** The field kinds Core's registry uses today (`CmsFieldKind` in core-web). */
export const CMS_FIELD_KINDS = [
  'text',
  'textarea',
  'markdown',
  'url',
  'email',
  'toggle',
  'select',
  'number',
  'date',
  'datetime',
  'relation',
  'readOnly',
  'image',
  'svg',
  /** A list of email addresses (a text[] column), such as an event's `host_emails`. */
  'emails',
] as const;
export type CmsFieldKind = (typeof CMS_FIELD_KINDS)[number];

export function isCmsFieldKind(value: string): value is CmsFieldKind {
  return (CMS_FIELD_KINDS as readonly string[]).includes(value);
}

export const cmsFieldSchema = z.object({
  name: cmsColumnName,
  label: z.string(),
  /** Open: see `CMS_FIELD_KINDS`. */
  kind: z.string(),
  /** The group the field sits in, such as `basics` or `schedule`. */
  section: z.string().optional(),
  readOnly: z.boolean().optional(),
  /** For `relation`: the entity id the column points at. */
  relationEntity: z.string().optional(),
}).loose();
export type CmsField = z.infer<typeof cmsFieldSchema>;

export const cmsEntitySchema = z.object({
  id: cmsColumnName,
  singularLabel: z.string(),
  pluralLabel: z.string(),
  primaryField: cmsColumnName,
  capabilities: z.object({
    create: z.boolean(),
    update: z.boolean(),
  }).loose(),
  fields: z.array(cmsFieldSchema),
  /** The person's grant. Core says to AND `canWrite` with `capabilities`. */
  access: z.object({
    canRead: z.boolean(),
    canWrite: z.boolean(),
  }).loose(),
}).loose();
export type CmsEntity = z.infer<typeof cmsEntitySchema>;

/** `GET /api/cms/registry`: Core's envelope, forwarded whole. */
export const cmsRegistryResponseSchema = z.object({
  data: z.object({
    entities: z.array(cmsEntitySchema),
  }).loose(),
}).loose();
export type CmsRegistryResponse = z.infer<typeof cmsRegistryResponseSchema>;

/**
 * A CMS row. Core selects every column, so a row can carry arrays and JSON
 * the registry does not list; an editor reads only the listed fields.
 */
export const cmsRecordSchema = z.record(z.string(), z.unknown());
export type CmsRecord = z.infer<typeof cmsRecordSchema>;

/** `GET`, `PATCH` and `DELETE /api/cms/:entity/:id` (delete answers the removed row). */
export const cmsRecordResponseSchema = z.object({ data: cmsRecordSchema }).loose();

/** `GET /api/cms/:entity`: one page of rows. */
export const cmsListResponseSchema = z.object({
  data: z.array(cmsRecordSchema),
  meta: z.object({ count: z.number(), limit: z.number(), offset: z.number() }).loose(),
}).loose();

/**
 * Columns the registry types as `text` that hold a fixed format. Core
 * validates them (`columnFormats` in core-web's write-schema.ts); a client
 * reads this to draw a date or a 24-hour time control instead of free text.
 */
export const CMS_COLUMN_FORMATS: Partial<Record<string, Record<string, 'date' | 'time' | 'timezone'>>> = {
  events: { event_date: 'date', start_time: 'time', timezone: 'timezone' },
};
