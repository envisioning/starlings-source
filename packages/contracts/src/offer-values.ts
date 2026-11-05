/**
 * The offer's values and its one totals calculation (,
 * #221). Rule input, not a wire shape: no zod, so the web's entry
 * path may import it. `fixtures/offer-values.json` and Swift's
 * `OfferValuesRegistry.swift` are generated from the tables (`pnpm registries:gen`).
 *
 * Every figure comes from the server: a client draws the totals an answer
 * carries, and never adds a line.
 */

/**
 * Core's CHECK on `offers.status`, every value (read 2026-11-04). `expired` is
 * never written: it is derived. `rejected` is a legacy value no row holds.
 */
export const OFFER_STATUSES = ['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'rejected'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const OFFER_STATUS_LABELS: Readonly<Record<OfferStatus, string>> = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
  rejected: 'Rejected',
};

/** Core's CHECK on `services.group_type`, every value (read 2026-11-04). */
export const SERVICE_GROUP_TYPES = ['Base', 'License', 'Research', 'Optional'] as const;
export type ServiceGroupType = (typeof SERVICE_GROUP_TYPES)[number];

export const SERVICE_GROUP_LABELS: Readonly<Record<ServiceGroupType, string>> = {
  Base: 'Base',
  License: 'License',
  Research: 'Research',
  Optional: 'Optional',
};

/** Core's CHECK on `services.category`. A service may have none. */
export const SERVICE_CATEGORIES = ['visualization', 'architecture', 'signals'] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

/** Core holds `yearly` only (read 2026-11-04). */
export const SERVICE_RECURRING_INTERVALS = ['yearly', 'monthly'] as const;

/** The reason a new offer carries for the organization's standing discount. */
export const DEFAULT_DISCOUNT_REASON = 'Partner Discount';

/**
 * The status to show. Accepted wins; an offer past `valid_until` and not
 * accepted reads as expired, unless it was declined. Core's rule, as it answers
 * the public page.
 */
export function derivedOfferStatus(
  offer: { status?: string | null; is_accepted?: boolean | null; valid_until?: string | null },
  now: Date = new Date(),
): OfferStatus {
  if (offer.is_accepted) return 'accepted';
  const stored: OfferStatus = (OFFER_STATUSES as readonly string[]).includes(offer.status ?? '') ? offer.status as OfferStatus : 'draft';
  if (stored === 'declined' || stored === 'draft') return stored;
  if (offer.valid_until && new Date(offer.valid_until) < now) return 'expired';
  return stored === 'accepted' ? 'sent' : stored;
}

export interface OfferTotalsLine {
  price: number | string | null | undefined;
  quantity: number | string | null | undefined;
  is_optional?: boolean | null;
  is_recurring?: boolean | null;
}

export interface OfferTotalsInput {
  globalDiscountPct?: number | string | null;
  taxPct?: number | string | null;
  /** The display currency. EUR when absent. */
  currency?: string | null;
  /** EUR to the display currency. 1 when absent. */
  rate?: number | null;
  /** True when the rate is stored on the offer, not read live. */
  rateFrozen?: boolean;
}

export interface OfferTotals {
  currency: string;
  rate: number;
  rate_frozen: boolean;
  /** True on a non-EUR offer: EUR is binding, the other figures are indicative. */
  indicative: boolean;
  subtotal_eur: number;
  discount_pct: number;
  discount_eur: number;
  total_eur: number;
  tax_pct: number;
  tax_eur: number;
  grand_total_eur: number;
  subtotal: number;
  discount: number;
  total: number;
  tax: number;
  grand_total: number;
  optional_total_eur: number;
  optional_total: number;
  recurring_total_eur: number;
  recurring_total: number;
}

const num = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const cents = (value: number): number => Math.round(value * 100) / 100;
const percent = (value: unknown): number => {
  const parsed = num(value);
  return parsed <= 0 ? 0 : Math.min(parsed, 100);
};

/** A line price in the display currency, in whole units. */
export function displayPrice(price: unknown, rate: number): number {
  return Math.round(num(price) * rate);
}

/**
 * Core's totals (`src/lib/offers/totals.ts`), the same rule for a row Core
 * accepted and a row D1 wrote: prices are EUR, a line is price times quantity,
 * only the global discount applies, an optional line does not count, tax sits
 * on top and is display only, and the display subtotal is the sum of the
 * rounded lines so the rows a buyer sees add up.
 */
export function computeOfferTotals(lines: ReadonlyArray<OfferTotalsLine>, input: OfferTotalsInput = {}): OfferTotals {
  const currency = (input.currency || 'EUR').toUpperCase();
  const rawRate = num(input.rate ?? 1);
  const rate = rawRate > 0 ? rawRate : 1;
  const discountPct = percent(input.globalDiscountPct);
  const taxPct = percent(input.taxPct);

  let subtotalEur = 0;
  let optionalEur = 0;
  let recurringEur = 0;
  let subtotalDisplay = 0;
  let optionalDisplay = 0;
  for (const line of lines) {
    const amount = num(line.price) * num(line.quantity);
    const shown = displayPrice(line.price, rate) * num(line.quantity);
    if (line.is_optional) {
      optionalEur += amount;
      optionalDisplay += shown;
      continue;
    }
    subtotalEur += amount;
    subtotalDisplay += shown;
    if (line.is_recurring) recurringEur += amount;
  }

  subtotalEur = cents(subtotalEur);
  const discountEur = Math.round((subtotalEur * discountPct) / 100);
  const totalEur = cents(subtotalEur - discountEur);
  const taxEur = Math.round((totalEur * taxPct) / 100);
  recurringEur = cents(recurringEur);
  const recurringTotalEur = cents(recurringEur - Math.round((recurringEur * discountPct) / 100));

  const subtotal = Math.round(subtotalDisplay);
  const discount = Math.round(discountEur * rate);
  const total = subtotal - discount;
  const tax = Math.round(taxEur * rate);
  return {
    currency,
    rate,
    rate_frozen: Boolean(input.rateFrozen),
    indicative: currency !== 'EUR',
    subtotal_eur: subtotalEur,
    discount_pct: discountPct,
    discount_eur: discountEur,
    total_eur: totalEur,
    tax_pct: taxPct,
    tax_eur: taxEur,
    grand_total_eur: cents(totalEur + taxEur),
    subtotal,
    discount,
    total,
    tax,
    grand_total: total + tax,
    optional_total_eur: cents(optionalEur),
    optional_total: Math.round(optionalDisplay),
    recurring_total_eur: recurringTotalEur,
    recurring_total: Math.round(recurringTotalEur * rate),
  };
}

/** `offers.total_amount`: the pre-tax EUR total of the lines that count, in whole euros. */
export function offerTotalAmountEur(lines: ReadonlyArray<OfferTotalsLine>, globalDiscountPct: number | string | null | undefined): number {
  return Math.max(0, Math.round(computeOfferTotals(lines, { globalDiscountPct: globalDiscountPct ?? null }).total_eur));
}
