import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrmLicense, CrmOffer, CrmSubject } from '@starlings/contracts';
import type { InboxCommercialItem } from '@starlings/contracts/inbox';
import { forgetCoreMemo } from '../src/core-gate';
import { resetCorePatCache } from '../src/crm';
import { commercialInboxItems, licenseComingDue, offerComingDue } from '../src/inbox-commercial';
import type { SubjectAccessView } from '../src/subject-access';

/**
 * INBOX's offers and licenses coming due (meet#1261): derived from Core's
 * lists on each read, filed on the lead or organization, gone once decided,
 * renewed or dismissed.
 */

const now = Date.parse('2026-10-31T12:00:00Z');
const leadID = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b';
const orgID = '3f0c8a52-6a55-4b0e-9a1f-0a5c6f1d2e77';
const configured = {
  ...env,
  CRM_SYNC_MODE: 'on',
  CORE_API_BASE_URL: 'https://core.test',
  INTERNAL_REQUEST_SECRET: 'a-shared-test-secret-with-at-least-32-characters',
} as Env;

const offer = (patch: Partial<CrmOffer>): CrmOffer => ({
  id: 'o1', title: 'Annual', status: 'sent', total_amount: 9000, currency: 'EUR', valid_until: '2026-11-04T00:00:00Z',
  is_accepted: null, created_at: '2026-10-20T00:00:00Z', lead_id: leadID, organization_id: orgID, ...patch,
});
const license = (patch: Partial<CrmLicense>): CrmLicense => ({
  id: 'l1', product: 'radar', plan_type: 'team', seats: 12, amount_eur: 24000, start_date: '2025-11-15',
  renewal_date: '2026-11-15', is_active: true, offer_id: null, lead_id: null, organization_id: orgID, ...patch,
});

describe('what comes due', () => {
  it('an open offer within a week of its end', () => {
    expect(offerComingDue(offer({}), now)).toBe('2026-11-04');
    expect(offerComingDue(offer({ valid_until: '2026-11-08' }), now)).toBeNull();
    expect(offerComingDue(offer({ valid_until: '2026-10-30' }), now)).toBeNull();
    expect(offerComingDue(offer({ status: 'accepted' }), now)).toBeNull();
    expect(offerComingDue(offer({ is_accepted: true }), now)).toBeNull();
  });

  it('an active license within 30 days of renewal, or past it', () => {
    expect(licenseComingDue(license({}), now)).toBe('2026-11-15');
    expect(licenseComingDue(license({ renewal_date: '2026-10-01' }), now)).toBe('2026-10-01');
    expect(licenseComingDue(license({ renewal_date: '2027-01-15' }), now)).toBeNull();
    expect(licenseComingDue(license({ is_active: false }), now)).toBeNull();
  });
});

describe('commercialInboxItems', () => {
  beforeEach(async () => {
    await resetCorePatCache();
    forgetCoreMemo();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === '/api/public/meet-owner-exchange') {
        return Response.json({ ok: true, token: 'pat', scopes: [], expires_at: new Date(Date.now() + 86_400_000).toISOString(), email: 'rosa@example.com' });
      }
      if (url.pathname === '/api/agent/offers') return Response.json({ data: [offer({}), offer({ id: 'o2', valid_until: '2027-01-01' })] });
      if (url.pathname === '/api/agent/licenses') return Response.json({ data: [license({})] });
      return Response.json({ error: 'unmocked' }, { status: 500 });
    });
  });

  afterEach(() => vi.restoreAllMocks());

  const subjects = [{ kind: 'lead', id: leadID, title: 'Acme pilot', organization_id: orgID, organization_name: 'Acme' }] as CrmSubject[];
  const seeAll = { canSee: () => true } as unknown as SubjectAccessView;

  it('files an offer on its lead and a license on its organization', async () => {
    const items = await commercialInboxItems(configured, 'rosa@example.com', {
      on: { offers: true, licenses: true }, subjects, access: seeAll, shown: () => true, dismissed: new Set(), now,
    }) as InboxCommercialItem[];
    expect(items.map((item) => [item.key, item.event, item.subject.kind, item.subject.title, item.due])).toEqual([
      ['commercial:offer:o1:2026-11-04', 'offer_expiring', 'lead', 'Acme pilot', '2026-11-04'],
      ['commercial:license:l1:2026-11-15', 'license_renewal', 'organization', 'Acme', '2026-11-15'],
    ]);
  });

  it('leaves out a dismissed row, a subject the reader cannot see, and a module that is off', async () => {
    const dismissed = await commercialInboxItems(configured, 'rosa@example.com', {
      on: { offers: true, licenses: true }, subjects, access: seeAll, shown: () => true, dismissed: new Set(['commercial:offer:o1:2026-11-04']), now,
    });
    expect(dismissed.map((item) => item.key)).toEqual(['commercial:license:l1:2026-11-15']);

    const hidden = await commercialInboxItems(configured, 'rosa@example.com', {
      on: { offers: true, licenses: true }, subjects, access: { canSee: (kind: string) => kind !== 'organization' } as unknown as SubjectAccessView,
      shown: () => true, dismissed: new Set(), now,
    });
    expect(hidden.map((item) => item.key)).toEqual(['commercial:offer:o1:2026-11-04']);

    const licensesOnly = await commercialInboxItems(configured, 'rosa@example.com', {
      on: { offers: false, licenses: true }, subjects, access: seeAll, shown: () => true, dismissed: new Set(), now,
    });
    expect(licensesOnly.map((item) => item.key)).toEqual(['commercial:license:l1:2026-11-15']);
  });
});
