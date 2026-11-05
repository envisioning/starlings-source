import { z } from 'zod';

/*
 * Admin › Records for the commercial group (decided by MZ on
 * 2026-11-04): payment terms, currencies, corporate entities, delivery
 * conditions, offer links and policies. The service catalog is a page in Work,
 * not a setting. Each table keeps Core's name and columns, and a change goes
 * through the commercial write path, so it lands in the trail and the admin audit.
 */

const short = z.string().trim().min(1).max(500);
const long = z.string().trim().min(1).max(20_000);
const optional = z.string().trim().max(2_000).nullable();

const flags = { is_active: z.boolean(), is_default: z.boolean() };

export const COMMERCIAL_SETTINGS_TABLES = [
  'settings_payment_terms', 'currency_settings', 'corporate_entities', 'settings_delivery_conditions', 'settings_offer_links', 'policies',
] as const;
export type CommercialSettingsTable = (typeof COMMERCIAL_SETTINGS_TABLES)[number];

/** The values one row of each table takes. */
const VALUES = {
  settings_payment_terms: z.strictObject({ title: short, description: long, ...flags }),
  settings_delivery_conditions: z.strictObject({ title: short, description: long, ...flags }),
  settings_offer_links: z.strictObject({ title: short, url: z.url().max(2_000), icon: optional, ...flags }),
  currency_settings: z.strictObject({
    currency_code: z.string().regex(/^[A-Za-z]{3}$/u).transform((value) => value.toUpperCase()),
    symbol: z.string().trim().min(1).max(8),
    is_enabled: z.boolean(),
    surcharge_percentage: z.number().min(0).max(100),
  }),
  corporate_entities: z.strictObject({
    name: short,
    legal_name: optional,
    address: optional,
    postcode: optional,
    city: optional,
    country: optional,
    vat_id: optional,
    tax_id: optional,
    logo_url: optional,
    billing_iban: optional,
    signatory_name: optional,
    signatory_title: optional,
    is_default: z.boolean(),
  }),
  policies: z.strictObject({
    title: short,
    description: optional,
    effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable(),
    url: z.url().max(2_000).nullable(),
  }),
} as const;

const save = <T extends CommercialSettingsTable>(table: T) => z.strictObject({
  op: z.literal('save'),
  table: z.literal(table),
  /** Absent: a new row. */
  id: z.uuid().optional(),
  values: VALUES[table],
});

/** `POST /api/admin/records/commercial`: one change, then the whole page again. A currency is turned off, never deleted. */
export const commercialSettingsWriteSchema = z.union([
  save('settings_payment_terms'),
  save('settings_delivery_conditions'),
  save('settings_offer_links'),
  save('currency_settings'),
  save('corporate_entities'),
  save('policies'),
  z.strictObject({
    op: z.literal('delete'),
    table: z.enum(['settings_payment_terms', 'settings_delivery_conditions', 'settings_offer_links', 'corporate_entities', 'policies']),
    id: z.uuid(),
  }),
]);
export type CommercialSettingsWrite = z.infer<typeof commercialSettingsWriteSchema>;

const row = z.record(z.string(), z.json());

/** `GET /api/admin/records/commercial`. `editable` is false while Core holds the group, and every list is empty then. */
export const commercialSettingsResponseSchema = z.object({
  editable: z.boolean(),
  settings_payment_terms: z.array(row),
  currency_settings: z.array(row),
  corporate_entities: z.array(row),
  settings_delivery_conditions: z.array(row),
  settings_offer_links: z.array(row),
  policies: z.array(row),
});
export type CommercialSettingsResponse = z.infer<typeof commercialSettingsResponseSchema>;
