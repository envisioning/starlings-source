import { z } from 'zod';

/*
 * The settings tables that move with the subjects group (,
 * docs/CORE_FOLD_PLAN.md §Before each group moves): the vocabulary of lead and
 * contact characteristics and where a contact came from. An admin edits them
 * in Admin › Records
 * (`/api/admin/records`). Until the subjects group answers from D1, Core holds
 * them and the page only says so.
 */

/** A characteristic's name is the key of the flag in a record's `characteristics`. */
export const characteristicNameSchema = z.string().trim().regex(/^[a-z][a-z0-9_]{0,99}$/u, 'Use lower case letters, digits and _ only.');

/** A source key, as Core checks it. */
export const contactSourceKeySchema = z.string().trim().regex(/^[a-z][a-z0-9_]{1,79}$/u, 'Use lower case letters, digits and _ only.');

export const CONTACT_SOURCE_CATEGORIES = ['manual', 'website', 'import', 'integration', 'inbound', 'legacy'] as const;
export const CONTACT_SOURCE_EVENT_TYPES = [
  'created', 'imported', 'subscribed', 'meeting_booked', 'form_submitted', 'event_registered', 'inbound_contact',
  'document_viewed',
] as const;

export const CHARACTERISTIC_KINDS = ['lead', 'contact'] as const;
export type CharacteristicKind = (typeof CHARACTERISTIC_KINDS)[number];


export const characteristicSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string().nullable(),
});
export type Characteristic = z.infer<typeof characteristicSchema>;

export const contactSourceDefinitionSchema = z.object({
  key: z.string(),
  label: z.string(),
  category: z.enum(CONTACT_SOURCE_CATEGORIES),
  description: z.string().nullable(),
  is_active: z.boolean(),
  manual_selectable: z.boolean(),
  import_selectable: z.boolean(),
  /** A system source keeps its key and category. */
  is_system: z.boolean(),
  sort_order: z.number().int(),
});
export type ContactSourceDefinition = z.infer<typeof contactSourceDefinitionSchema>;


/** `GET /api/admin/records`, and the answer to every write there. */
export const subjectSettingsResponseSchema = z.object({
  /** False while the subjects group answers from Core: Core holds these, and every list is empty. */
  editable: z.boolean(),
  lead_characteristics: z.array(characteristicSchema),
  contact_characteristics: z.array(characteristicSchema),
  contact_sources: z.array(contactSourceDefinitionSchema),
});
export type SubjectSettingsResponse = z.infer<typeof subjectSettingsResponseSchema>;

/**
 * `POST /api/admin/records`: one change. A save with no id adds a row. A
 * renamed characteristic renames its flag on every lead or contact.
 */
export const subjectSettingsWriteSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('characteristic.save'),
    kind: z.enum(CHARACTERISTIC_KINDS),
    id: z.string().min(1).max(64).optional(),
    name: characteristicNameSchema,
  }),
  z.strictObject({
    op: z.literal('characteristic.delete'),
    kind: z.enum(CHARACTERISTIC_KINDS),
    id: z.string().min(1).max(64),
  }),
  z.strictObject({
    op: z.literal('source.save'),
    key: contactSourceKeySchema,
    label: z.string().trim().min(1).max(100),
    category: z.enum(CONTACT_SOURCE_CATEGORIES),
    description: z.string().trim().max(500).nullable().optional(),
    is_active: z.boolean(),
    manual_selectable: z.boolean(),
    import_selectable: z.boolean(),
    sort_order: z.number().int().min(0).max(100_000),
  }),
]);
export type SubjectSettingsWrite = z.infer<typeof subjectSettingsWriteSchema>;
