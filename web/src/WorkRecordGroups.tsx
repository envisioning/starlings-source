import { useCallback, useEffect, useState } from 'react';
import type { CrmLicense, CrmOffer } from '@starlings/contracts';
import { BROWSE_RECORD_GROUPS } from '@starlings/contracts/browse-groups';
import { LICENSE_PRODUCTS, type LicensesResponse, type OffersResponse } from '@starlings/contracts/licenses';
import { OFFER_STATUSES, OFFER_STATUS_LABELS, type OfferStatus } from '@starlings/contracts/offer-values';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Button } from '@/ui/button';
import { apiFetch } from './api';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { LicenseForm, licenseProductLabel } from './LicenseForm';
import { navigate } from './navigation';
import { railListClass } from './rail-list';
import { readStored, writeStored } from './storage';
import { licenseRowText, offerRowText } from './SubjectOverview';
import { RailRow, RailRowsPlaceholder, RailSection } from './SurfaceShell';
import { workspaceCoreGroups } from './workspace-core';

/** The filter a link asked for, once: `/work/signals`, or `/work/licenses?product=`. */
function productFromLocation(): string | null {
  if (/^\/work\/signals\/?$/iu.test(window.location.pathname)) return 'signals';
  if (!/^\/work\/licenses\/?$/iu.test(window.location.pathname)) return null;
  const asked = new URLSearchParams(window.location.search).get('product') ?? '';
  return (LICENSE_PRODUCTS as readonly string[]).includes(asked) ? asked : '';
}

/** One read for a group: the page, its error, and a way to read again. */
function useRecordList<T>(key: string, fallbackError: string, read: () => Promise<{ rows: T[]; truncated: boolean }>) {
  const [page, setPage] = useState<{ rows: T[]; truncated: boolean } | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setPage(null);
    setError('');
    void read()
      .then((answer) => { if (live) setPage(answer); })
      .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : fallbackError); });
    return () => { live = false; };
    // `read` names only what `key` holds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);
  return { page, error, retry: useCallback(() => setAttempt((value) => value + 1), []) };
}

function GroupBody({ error, loaded, empty, retry, children }: { error: string; loaded: boolean; empty: boolean; retry: () => void; children: React.ReactNode }) {
  if (error) return <ErrorNotice message={error} copyText={error} action={<Button type="button" variant="outline" size="xs" onClick={retry}>{t('Retry')}</Button>} />;
  if (!loaded) return <RailRowsPlaceholder count={3} label={t('Loading…')} />;
  if (empty) return <p className="lede">{t('Nothing matches.')}</p>;
  return <>{children}</>;
}

/** The Offers group on Browse: every offer, by status. A row opens its editor where offers answer from this workspace. */
export function OffersBrowseGroup() {
  const spec = BROWSE_RECORD_GROUPS.offers;
  const [status, setStatus] = useState(() => readStored(`${spec.preferenceKey}.status`));
  const editable = !workspaceCoreGroups().has('commercial');
  const fallbackError = t('Couldn’t load offers.');
  const { page, error, retry } = useRecordList<CrmOffer>(status, fallbackError, async () => {
    const answer = await apiFetch<OffersResponse>(`/crm/offers${status ? `?${new URLSearchParams({ status })}` : ''}`, { fallbackError, noStore: true });
    return { rows: answer.offers, truncated: answer.truncated };
  });
  const rows = page?.rows ?? [];
  return (
    <div className="mt-[18px]">
      <RailSection
        title={t('Offers')}
        storageKey={spec.preferenceKey}
        accessory={(
          <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <NativeSelect
              value={status}
              aria-label={t('Filter offers by status')}
              onChange={(event) => { setStatus(event.target.value); writeStored(`${spec.preferenceKey}.status`, event.target.value); }}
            >
              <NativeSelectOption value="">{t('All statuses')}</NativeSelectOption>
              {OFFER_STATUSES.map((option: OfferStatus) => <NativeSelectOption key={option} value={option}>{t(OFFER_STATUS_LABELS[option])}</NativeSelectOption>)}
            </NativeSelect>
            {page && <small>{rows.length}{page.truncated ? '+' : ''}</small>}
          </span>
        )}
      >
        <GroupBody error={error} loaded={Boolean(page)} empty={rows.length === 0} retry={retry}>
          <ul className={railListClass} aria-label={t('Offers')}>
            {rows.map((offer) => (
              <RailRow
                key={offer.id}
                title={offer.title || t('Untitled offer')}
                subtitle={[offer.organization_name || offer.lead_title, offerRowText(offer)].filter(Boolean).join(' · ') || undefined}
                {...(editable ? { onSelect: () => navigate(`/work/offers/${offer.id}`) } : {})}
              />
            ))}
          </ul>
        </GroupBody>
      </RailSection>
    </div>
  );
}

/**
 * The Licenses group on Browse: every licence, by product and state. A Signals
 * customer is a licence with product Signals, so that filter is the customer list
 * (decided by MZ, 2026-11-05). A row opens its editor in place.
 */
export function LicensesBrowseGroup() {
  const spec = BROWSE_RECORD_GROUPS.licenses;
  const [linked] = useState(productFromLocation);
  const [product, setProduct] = useState(() => linked ?? readStored(`${spec.preferenceKey}.product`));
  const [active, setActive] = useState(() => readStored(`${spec.preferenceKey}.active`));
  const [open, setOpen] = useState<string | null>(null);
  const editable = !workspaceCoreGroups().has('commercial');
  const search = new URLSearchParams({ ...(product ? { product } : {}), ...(active ? { active } : {}) }).toString();
  const fallbackError = t('Couldn’t load licenses.');
  const { page, error, retry } = useRecordList<CrmLicense>(search, fallbackError, async () => {
    const answer = await apiFetch<LicensesResponse>(`/crm/licenses${search ? `?${search}` : ''}`, { fallbackError, noStore: true });
    return { rows: answer.licenses, truncated: answer.truncated };
  });
  const rows = page?.rows ?? [];
  const chosen = open ? rows.find((license) => license.id === open) : undefined;
  return (
    <div className="mt-[18px]">
      <RailSection
        title={t('Licenses')}
        storageKey={spec.preferenceKey}
        forcedOpen={linked !== null}
        accessory={(
          <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <NativeSelect
              value={product}
              aria-label={t('Filter licenses by product')}
              onChange={(event) => { setProduct(event.target.value); writeStored(`${spec.preferenceKey}.product`, event.target.value); setOpen(null); }}
            >
              <NativeSelectOption value="">{t('All products')}</NativeSelectOption>
              {LICENSE_PRODUCTS.map((option) => <NativeSelectOption key={option} value={option}>{licenseProductLabel(option)}</NativeSelectOption>)}
            </NativeSelect>
            <NativeSelect
              value={active}
              aria-label={t('Filter licenses by status')}
              onChange={(event) => { setActive(event.target.value); writeStored(`${spec.preferenceKey}.active`, event.target.value); setOpen(null); }}
            >
              <NativeSelectOption value="">{t('All statuses')}</NativeSelectOption>
              <NativeSelectOption value="true">{t('Active')}</NativeSelectOption>
              <NativeSelectOption value="false">{t('Ended')}</NativeSelectOption>
            </NativeSelect>
            {page && <small>{rows.length}{page.truncated ? '+' : ''}</small>}
          </span>
        )}
      >
        <GroupBody error={error} loaded={Boolean(page)} empty={rows.length === 0} retry={retry}>
          <ul className={railListClass} aria-label={t('Licenses')}>
            {rows.map((license) => (
              <RailRow
                key={license.id}
                title={license.organization_name || license.lead_title || t('License')}
                subtitle={licenseRowText(license) || undefined}
                active={open === license.id}
                {...(editable ? { onSelect: () => setOpen(license.id) } : {})}
              />
            ))}
          </ul>
          {chosen && (
            <div className="mt-2">
              <LicenseForm key={chosen.id} license={chosen} onSaved={() => { setOpen(null); retry(); }} onCancel={() => setOpen(null)} />
            </div>
          )}
        </GroupBody>
      </RailSection>
    </div>
  );
}
