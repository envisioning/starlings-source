/**
 * A lead's qualification checklist: the five checks Core's own New Lead form
 * has, decided once.
 *
 * Core stores them in the lead's `characteristics` record, a map of check key
 * to boolean, beside whatever other characteristics the lead carries. A write
 * replaces the whole record, so every client sends the record it read with
 * the five keys changed (`mergeLeadQualification`) and never just the five.
 *
 * It is rule input, not a wire shape: no zod. Swift mirrors the keys
 * (`Sources/Generated/LeadQualificationRegistry.swift`) and
 * `fixtures/lead-qualification.json` pins the mirror. Labels are Core's names
 * and stay with each client, so a client can localize them.
 */

export const LEAD_QUALIFICATION_CHECKS = [
  { key: 'budget_availability', label: 'Budget Availability' },
  { key: 'event_timeline', label: 'Event Timeline' },
  { key: 'previous_engagement', label: 'Previous Engagement' },
  { key: 'project_fit', label: 'Project Fit' },
  { key: 'stakeholder_buy_in', label: 'Stakeholder Buy In' },
] as const;

export type LeadQualificationKey = (typeof LEAD_QUALIFICATION_CHECKS)[number]['key'];

export const LEAD_QUALIFICATION_KEYS: readonly LeadQualificationKey[] = LEAD_QUALIFICATION_CHECKS.map((check) => check.key);

/** Each of the five, true or false. */
export type LeadQualification = Record<LeadQualificationKey, boolean>;

type Characteristics = Record<string, boolean> | null | undefined;

/** The five checks as a lead's characteristics hold them; absent is false. */
export function leadQualification(characteristics: Characteristics): LeadQualification {
  return Object.fromEntries(
    LEAD_QUALIFICATION_KEYS.map((key) => [key, characteristics?.[key] === true]),
  ) as LeadQualification;
}

/** "3/5": how many of the five are checked. */
export function leadQualificationCount(characteristics: Characteristics): { done: number; total: number } {
  const checks = leadQualification(characteristics);
  return { done: LEAD_QUALIFICATION_KEYS.filter((key) => checks[key]).length, total: LEAD_QUALIFICATION_KEYS.length };
}

/**
 * The record to write: `existing` (other characteristics kept) with the
 * named checks changed. Keys that are not one of the five are ignored.
 */
export function mergeLeadQualification(
  existing: Characteristics,
  changes: Partial<Record<string, boolean>>,
): Record<string, boolean> {
  const merged: Record<string, boolean> = { ...(existing ?? {}) };
  for (const key of LEAD_QUALIFICATION_KEYS) {
    const value = changes[key];
    if (typeof value === 'boolean') merged[key] = value;
  }
  return merged;
}
