import { z } from 'zod';
import { SERVICE_CATEGORIES, SERVICE_GROUP_TYPES, SERVICE_RECURRING_INTERVALS } from './offer-values';

/*
 * The member's offer and catalog routes ( to
 * #223, #226). Web, Mac and agents edit through them; the phones read, share,
 * duplicate and record. The server recomputes every total and enforces the
 * offer rules, so a body names no total and no status.
 *
 * The answers use Core's column names, as the group's tables do.
 */

const uuid = z.uuid();
const title = z.string().trim().min(1).max(500);
const text = z.string().max(20_000);
const percentage = z.number().min(0).max(100);
const money = z.number().min(0).max(100_000_000);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}/u).refine((value) => Number.isFinite(Date.parse(value)), 'not a date');
const email = z.email().max(320);
const currencyCode = z.string().regex(/^[A-Za-z]{3}$/u).transform((value) => value.toUpperCase());

// ── Requests ────────────────────────────────────────────────────────────────

const offerSubject = {
  lead_id: uuid.optional(),
  organization_id: uuid.optional(),
};

/** `POST /api/crm/offers`: a draft on a lead or an organization. A new offer takes the organization's standing discount. */
export const offerCreateSchema = z.strictObject({
  ...offerSubject,
  /** The person the offer is for: their address becomes `recipient_email`. */
  contact_id: uuid.optional(),
  title: title.optional(),
  currency: currencyCode.optional(),
  valid_until: day.optional(),
}).refine((body) => body.lead_id || body.organization_id, 'An offer needs a lead or an organization.');
export type OfferCreate = z.infer<typeof offerCreateSchema>;

/** `PATCH /api/crm/offers/:id`: only the fields that change. Null clears a field. */
export const offerPatchSchema = z.strictObject({
  title: title.nullable().optional(),
  currency: currencyCode.optional(),
  valid_until: day.nullable().optional(),
  global_discount_percentage: percentage.nullable().optional(),
  discount_reason: z.string().trim().max(500).nullable().optional(),
  tax_percentage: percentage.nullable().optional(),
  tax_reason: z.string().trim().max(500).nullable().optional(),
  payment_term_id: uuid.nullable().optional(),
  payment_terms_text: text.nullable().optional(),
  delivery_condition_id: uuid.nullable().optional(),
  delivery_conditions_text: text.nullable().optional(),
  corporate_entity_id: uuid.nullable().optional(),
  recipient_email: email.nullable().optional(),
  notes: text.nullable().optional(),
  /** The links the offer shows, whole. */
  link_ids: z.array(uuid).max(50).optional(),
}).refine((body) => Object.keys(body).length > 0, 'Nothing to change.');
export type OfferPatch = z.infer<typeof offerPatchSchema>;

/**
 * `POST /api/crm/offers/:id/lines`. A catalog line names a service, by id or
 * slug, and reads its name from the catalog; its price is the catalog's unless
 * the body says otherwise. A custom line names its own title and price.
 */
export const offerLineCreateSchema = z.strictObject({
  service_id: uuid.optional(),
  service_slug: z.string().trim().min(1).max(100).optional(),
  custom_title: title.optional(),
  custom_description: text.optional(),
  price: money.optional(),
  quantity: z.number().int().min(1).max(100_000).default(1),
  is_optional: z.boolean().default(false),
  hide_description: z.boolean().default(false),
}).superRefine((body, context) => {
  const named = [body.service_id, body.service_slug, body.custom_title].filter((value) => value !== undefined).length;
  if (named !== 1) context.addIssue({ code: 'custom', message: 'A line names one service, or a custom title.' });
  if (body.custom_title !== undefined && body.price === undefined) context.addIssue({ code: 'custom', message: 'A custom line needs a price.', path: ['price'] });
});
export type OfferLineCreate = z.infer<typeof offerLineCreateSchema>;

/** `PATCH /api/crm/offers/:id/lines/:lineId`. A catalog line keeps the catalog's name. */
export const offerLinePatchSchema = z.strictObject({
  custom_title: title.optional(),
  custom_description: text.nullable().optional(),
  price: money.optional(),
  quantity: z.number().int().min(1).max(100_000).optional(),
  is_optional: z.boolean().optional(),
  hide_description: z.boolean().optional(),
}).refine((body) => Object.keys(body).length > 0, 'Nothing to change.');
export type OfferLinePatch = z.infer<typeof offerLinePatchSchema>;

/** `POST /api/crm/offers/:id/duplicate`. Without a subject the copy stays on the offer's own. */
export const offerDuplicateSchema = z.strictObject({ ...offerSubject });
export type OfferDuplicate = z.infer<typeof offerDuplicateSchema>;

/** `POST /api/crm/offers/:id/decision`: what the buyer told a member. */
export const offerDecisionAcceptSchema = z.strictObject({
  decision: z.literal('accept'),
  accepted_by_name: z.string().trim().min(1).max(200).optional(),
  accepted_by_email: email.optional(),
  /** The optional lines the buyer took. They become regular lines. */
  selected_optional_ids: z.array(uuid).max(200).optional(),
});
export const offerDecisionRejectSchema = z.strictObject({ decision: z.literal('reject') });
export const offerDecisionSchema = z.discriminatedUnion('decision', [offerDecisionAcceptSchema, offerDecisionRejectSchema]);
export type OfferDecision = z.infer<typeof offerDecisionSchema>;

const serviceFields = {
  description: text.min(1),
  summary: text.min(1),
  price: money,
  is_recurring: z.boolean(),
  recurring_interval: z.enum(SERVICE_RECURRING_INTERVALS).nullable(),
  url: z.url().max(2_000).nullable(),
  icon: z.string().max(200).nullable(),
  group_type: z.enum(SERVICE_GROUP_TYPES),
  category: z.enum(SERVICE_CATEGORIES).nullable(),
  is_public: z.boolean(),
  is_listed: z.boolean(),
  allow_multiple: z.boolean(),
  is_default: z.boolean(),
  allow_description_override: z.boolean(),
  name_pt: z.string().max(500).nullable(),
  summary_pt: text.nullable(),
  description_pt: text.nullable(),
};
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(100);

/** `POST /api/crm/services`. A renamed service is a new record, so this is the only way a name is written. */
export const serviceCreateSchema = z.strictObject({
  name: title,
  slug: slug.nullable().optional(),
  ...Object.fromEntries(Object.entries(serviceFields).map(([key, schema]) => [key, schema.optional()])) as { [K in keyof typeof serviceFields]: z.ZodOptional<(typeof serviceFields)[K]> },
  description: serviceFields.description,
  summary: serviceFields.summary,
  price: serviceFields.price,
});
export type ServiceCreate = z.infer<typeof serviceCreateSchema>;

/**
 * `PATCH /api/crm/services/:id`. No `name`: never rename a service record,
 * create a new one and take the old one off the rate card. A slug is set once.
 */
export const servicePatchSchema = z.strictObject({
  slug: slug.optional(),
  ...Object.fromEntries(Object.entries(serviceFields).map(([key, schema]) => [key, schema.optional()])) as { [K in keyof typeof serviceFields]: z.ZodOptional<(typeof serviceFields)[K]> },
}).refine((body) => Object.keys(body).length > 0, 'Nothing to change.');
export type ServicePatch = z.infer<typeof servicePatchSchema>;

/** `PATCH /api/crm/organizations/:id/default-discount`. A null percentage clears it. */
export const organizationDiscountSchema = z.strictObject({
  default_discount_percentage: percentage.nullable(),
  default_discount_reason: z.string().trim().max(500).nullable().optional(),
});
export type OrganizationDiscount = z.infer<typeof organizationDiscountSchema>;

// ── Answers ─────────────────────────────────────────────────────────────────

export const offerTotalsSchema = z.object({
  currency: z.string(),
  rate: z.number(),
  rate_frozen: z.boolean(),
  indicative: z.boolean(),
  subtotal_eur: z.number(),
  discount_pct: z.number(),
  discount_eur: z.number(),
  total_eur: z.number(),
  tax_pct: z.number(),
  tax_eur: z.number(),
  grand_total_eur: z.number(),
  subtotal: z.number(),
  discount: z.number(),
  total: z.number(),
  tax: z.number(),
  grand_total: z.number(),
  optional_total_eur: z.number(),
  optional_total: z.number(),
  recurring_total_eur: z.number(),
  recurring_total: z.number(),
  /** No rate for the currency: the figures are EUR, and Send refuses. */
  rate_missing: z.boolean(),
});
export type OfferTotalsWire = z.infer<typeof offerTotalsSchema>;

export const offerLineSchema = z.object({
  id: z.string(),
  service_id: z.string().nullable(),
  is_custom: z.boolean(),
  /** The catalog's name when the line was added, or the custom title. */
  name: z.string().nullable(),
  description: z.string().nullable(),
  custom_title: z.string().nullable(),
  custom_description: z.string().nullable(),
  group_type: z.string().nullable(),
  is_recurring: z.boolean(),
  price: z.number(),
  quantity: z.number(),
  is_optional: z.boolean(),
  hide_description: z.boolean(),
  /** The line's price in the offer's currency, in whole units. */
  display_price: z.number(),
});
export type OfferLine = z.infer<typeof offerLineSchema>;

export const offerVersionSummarySchema = z.object({
  version: z.number().int(),
  sent_at: z.string(),
  sent_by: z.string().nullable(),
  currency: z.string(),
  rate: z.number(),
  total_eur: z.number().nullable(),
});
export type OfferVersionSummary = z.infer<typeof offerVersionSummarySchema>;

export const offerHeaderSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  /** As stored. */
  status: z.string(),
  /** What to show: `expired` is derived here. */
  shown_status: z.string(),
  /** Edits the buyer does not see until Send update. */
  has_unsent_changes: z.boolean(),
  /** Accepted: nothing changes any more. */
  locked: z.boolean(),
  /** Which action the editor offers, and the answer to `send` or `send-update`. */
  next_send: z.enum(['send', 'send_update']).nullable(),
  /** The link the member shares. Null until the first Send. */
  link: z.string().nullable(),
  lead_id: z.string().nullable(),
  organization_id: z.string().nullable(),
  recipient_email: z.string().nullable(),
  currency: z.string(),
  valid_until: z.string().nullable(),
  global_discount_percentage: z.number().nullable(),
  discount_reason: z.string().nullable(),
  tax_percentage: z.number().nullable(),
  tax_reason: z.string().nullable(),
  payment_term_id: z.string().nullable(),
  payment_terms_text: z.string().nullable(),
  delivery_condition_id: z.string().nullable(),
  delivery_conditions_text: z.string().nullable(),
  corporate_entity_id: z.string().nullable(),
  notes: z.string().nullable(),
  link_ids: z.array(z.string()),
  total_amount: z.number(),
  is_accepted: z.boolean(),
  accepted_at: z.string().nullable(),
  accepted_by_name: z.string().nullable(),
  accepted_by_email: z.string().nullable(),
  accepted_version: z.number().int().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
});
export type OfferHeader = z.infer<typeof offerHeaderSchema>;

/** Every offer route that names an offer answers this, with the server's totals. */
/** One open of the buyer's page: when, and by which address. */
export const offerViewSchema = z.object({ at: z.string(), email: z.string().nullable() });
export type OfferView = z.infer<typeof offerViewSchema>;

export const offerResponseSchema = z.object({
  offer: offerHeaderSchema,
  lines: z.array(offerLineSchema),
  totals: offerTotalsSchema,
  versions: z.array(offerVersionSummarySchema),
  /** Who opened the buyer's page, newest first. Only a read of one offer answers it. */
  views: z.array(offerViewSchema).optional(),
});
export type OfferResponse = z.infer<typeof offerResponseSchema>;

/** `GET /api/crm/offers/:id/versions/:version`: one earlier version, as the buyer saw it. */
export const offerVersionResponseSchema = z.object({
  version: offerVersionSummarySchema,
  /** The frozen row. Clients draw the title and the notes. */
  offer: z.looseObject({ title: z.string().nullable().optional(), notes: z.string().nullable().optional() }),
  lines: z.array(offerLineSchema),
  /** The totals frozen at Send, in EUR for a client to draw. */
  totals: z.looseObject({ subtotal_eur: z.number().optional(), discount_eur: z.number().optional(), total_eur: z.number().optional(), grand_total_eur: z.number().optional() }),
});
export type OfferVersionResponse = z.infer<typeof offerVersionResponseSchema>;

/**
 * `POST /api/crm/offers/:id/decision`. An accept answers the license and the
 * project so a client can open them. An id with `*_created` false already stood;
 * a null id means none: no recurring amount, no lead, or a reject.
 */
export const offerDecisionResponseSchema = offerResponseSchema.extend({
  license_id: z.string().nullable(),
  license_created: z.boolean(),
  project_id: z.string().nullable(),
  project_created: z.boolean(),
});
export type OfferDecisionResponse = z.infer<typeof offerDecisionResponseSchema>;

export const offerSendResponseSchema = offerResponseSchema.extend({
  version: z.number().int(),
  link: z.string(),
});
export type OfferSendResponse = z.infer<typeof offerSendResponseSchema>;

export const catalogServiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string().nullable(),
  description: z.string(),
  summary: z.string(),
  price: z.number(),
  is_recurring: z.boolean(),
  recurring_interval: z.string().nullable(),
  url: z.string().nullable(),
  icon: z.string().nullable(),
  group_type: z.string().nullable(),
  category: z.string().nullable(),
  is_public: z.boolean(),
  is_listed: z.boolean(),
  allow_multiple: z.boolean(),
  is_default: z.boolean(),
  allow_description_override: z.boolean(),
  name_pt: z.string().nullable(),
  summary_pt: z.string().nullable(),
  description_pt: z.string().nullable(),
});
export type CatalogService = z.infer<typeof catalogServiceSchema>;

export const catalogResponseSchema = z.object({ services: z.array(catalogServiceSchema) });
export type CatalogResponse = z.infer<typeof catalogResponseSchema>;
export const catalogServiceResponseSchema = z.object({ service: catalogServiceSchema });
export type CatalogServiceResponse = z.infer<typeof catalogServiceResponseSchema>;

/** `GET /api/crm/offer-options`: what the editor's pickers list. */
export const offerOptionsResponseSchema = z.object({
  currencies: z.array(z.object({ code: z.string(), symbol: z.string().nullable(), surcharge_percentage: z.number() })),
  payment_terms: z.array(z.object({ id: z.string(), title: z.string(), description: z.string(), is_default: z.boolean() })),
  delivery_conditions: z.array(z.object({ id: z.string(), title: z.string(), description: z.string(), is_default: z.boolean() })),
  corporate_entities: z.array(z.object({ id: z.string(), name: z.string(), is_default: z.boolean() })),
  links: z.array(z.object({ id: z.string(), title: z.string(), url: z.string(), is_default: z.boolean() })),
});
export type OfferOptionsResponse = z.infer<typeof offerOptionsResponseSchema>;

export const organizationDiscountResponseSchema = z.object({
  organization_id: z.string(),
  default_discount_percentage: z.number().nullable(),
  default_discount_reason: z.string().nullable(),
});
export type OrganizationDiscountResponse = z.infer<typeof organizationDiscountResponseSchema>;
