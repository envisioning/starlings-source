import { z } from 'zod';
/**
 * The compact commercial Home card. Core remains the source of truth for
 * offer state and amounts; Meet only carries the 12-month projection needed
 * by the Home surfaces.
 */
export const commercialHistogramPointSchema = z.object({
  key: z.string(),
  label: z.string(),
  total: z.number(),
  positive: z.number(),
  negative: z.number(),
});
export type CommercialHistogramPoint = z.infer<typeof commercialHistogramPointSchema>;

/** `GET /api/crm/commercial-summary`: the numbers Home's commercial module draws. */
export const commercialSummarySchema = z.object({
  lookback_months: z.number().int(),
  offers: z.number().int(),
  sales_amount: z.number(),
  pipeline_amount: z.number(),
  new_licenses: z.number().int().nullable(),
  currency_code: z.string(),
  points: z.array(commercialHistogramPointSchema),
});
export type CommercialSummary = z.infer<typeof commercialSummarySchema>;

/** Core's per-person outreach states (`SIGNALS_OUTREACH_STATUS_VALUES`), in funnel order. */
export const SIGNALS_OUTREACH_STATUSES = ['to_notify', 'notified', 'replied', 'interested', 'not_interested'] as const;
export const signalsOutreachStatusSchema = z.enum(SIGNALS_OUTREACH_STATUSES);
export type SignalsOutreachStatus = z.infer<typeof signalsOutreachStatusSchema>;
