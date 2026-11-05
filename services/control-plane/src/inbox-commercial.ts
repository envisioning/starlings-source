// INBOX's commercial rows: an open offer that expires within a
// week, and an active license that renews within 30 days or is past its
// renewal, on a lead or organization the reader can see. Derived on each
// read from Core's offer and license lists, the way Sales touches are; no
// webhook, nothing stored but a dismissal. The key carries the date, so a
// moved date is news again.

import type { CrmLicense, CrmOffer, CrmSubject } from '@starlings/contracts';
import type { InboxCommercialItem, InboxItem } from '@starlings/contracts/inbox';
import { fetchCrmSubjectDetail, listCrmCommercial } from './crm';
import type { SubjectAccessView } from './subject-access';

function warn(message: string, error: unknown): void {
  console.warn(JSON.stringify({ level: 'warn', message, error: error instanceof Error ? error.message : 'Unknown error' }));
}

const DAY_MS = 86_400_000;
export const OFFER_EXPIRY_DAYS = 7;
export const LICENSE_RENEWAL_DAYS = 30;
/** Organizations named by no open subject are read one by one; a few at most. */
const ORGANIZATION_READS = 10;
/** Core's latest; an open offer is a recent one. */
const LIST_LIMIT = '200';
/** Core's statuses that end an offer. */
const DECIDED = new Set(['accepted', 'rejected', 'expired', 'declined', 'cancelled', 'canceled']);

/** YYYY-MM-DD of a date or a timestamp, or null. */
function dayOf(value: string | null): string | null {
  const day = value?.trim().slice(0, 10) ?? '';
  return /^\d{4}-\d{2}-\d{2}$/u.test(day) ? day : null;
}

/** Whole days from today (UTC) to `day`; negative when it has passed. */
function daysUntil(day: string, now: number): number {
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  return Math.round((Date.parse(`${day}T00:00:00Z`) - today) / DAY_MS);
}

export function offerComingDue(offer: CrmOffer, now: number): string | null {
  if (offer.is_accepted === true || DECIDED.has((offer.status ?? '').toLowerCase())) return null;
  const due = dayOf(offer.valid_until);
  if (!due) return null;
  const days = daysUntil(due, now);
  return days >= 0 && days <= OFFER_EXPIRY_DAYS ? due : null;
}

export function licenseComingDue(license: CrmLicense, now: number): string | null {
  if (!license.is_active) return null;
  const due = dayOf(license.renewal_date);
  if (!due) return null;
  return daysUntil(due, now) <= LICENSE_RENEWAL_DAYS ? due : null;
}

export async function commercialInboxItems(
  env: Env,
  actorEmail: string,
  input: {
    on: { offers: boolean; licenses: boolean };
    subjects: readonly CrmSubject[];
    access: SubjectAccessView;
    shown: (kind: 'lead' | 'organization') => boolean;
    dismissed: Set<string>;
    now?: number;
  },
): Promise<InboxItem[]> {
  const now = input.now ?? Date.now();
  const { offers, licenses } = await listCrmCommercial(env, actorEmail, { limit: LIST_LIMIT }, input.on);

  // Titles from the open subjects: a lead by id, an organization by the name
  // any open subject carries for it.
  const leads = new Map<string, string>();
  const organizations = new Map<string, string>();
  for (const subject of input.subjects) {
    if (subject.kind === 'lead') leads.set(subject.id, subject.title);
    if (subject.organization_id && subject.organization_name) organizations.set(subject.organization_id, subject.organization_name);
  }

  type Due = { event: InboxCommercialItem['event']; id: string; due: string; leadId: string | null; organizationId: string | null; offer?: CrmOffer; license?: CrmLicense };
  const due: Due[] = [
    ...(offers ?? []).flatMap((offer): Due[] => {
      const day = offerComingDue(offer, now);
      return day ? [{ event: 'offer_expiring', id: offer.id, due: day, leadId: offer.lead_id, organizationId: offer.organization_id, offer }] : [];
    }),
    ...(licenses ?? []).flatMap((license): Due[] => {
      const day = licenseComingDue(license, now);
      return day ? [{ event: 'license_renewal', id: license.id, due: day, leadId: license.lead_id, organizationId: license.organization_id, license }] : [];
    }),
  ];

  // An offer is the lead's business when it has one; a license belongs to
  // the organization. Either falls back to the other.
  const missing = [...new Set(due
    .map((row) => row.organizationId)
    .filter((id): id is string => id !== null && !organizations.has(id)))].slice(0, ORGANIZATION_READS);
  await Promise.all(missing.map(async (id) => {
    try {
      const detail = await fetchCrmSubjectDetail(env, 'organization', id);
      organizations.set(id, detail.title);
    } catch (error) {
      warn('inbox.commercial.organization', error);
    }
  }));

  const items: InboxItem[] = [];
  for (const row of due) {
    const asLead = row.leadId && leads.has(row.leadId) ? { kind: 'lead' as const, id: row.leadId, title: leads.get(row.leadId)! } : null;
    const asOrganization = row.organizationId && organizations.has(row.organizationId)
      ? { kind: 'organization' as const, id: row.organizationId, title: organizations.get(row.organizationId)! }
      : null;
    const subject = row.event === 'offer_expiring' ? asLead ?? asOrganization : asOrganization ?? asLead;
    if (!subject || !input.shown(subject.kind) || !input.access.canSee(subject.kind, subject.id)) continue;
    const key = `commercial:${row.event === 'offer_expiring' ? 'offer' : 'license'}:${row.id}:${row.due}`;
    if (input.dismissed.has(key)) continue;
    items.push({
      key,
      at: Date.parse(`${row.due}T00:00:00Z`),
      source: 'commercial',
      event: row.event,
      subject,
      due: row.due,
      ...(row.offer ? { offer: row.offer } : {}),
      ...(row.license ? { license: row.license } : {}),
    });
  }
  return items;
}
