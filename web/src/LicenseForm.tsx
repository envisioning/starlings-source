import { useState } from 'react';
import type { CrmLicense } from '@starlings/contracts';
import {
  LICENSE_BILLING_INTERVALS,
  LICENSE_PAYMENT_TYPES,
  LICENSE_PLAN_TYPES,
  LICENSE_PRODUCTS,
  type LicenseCreate,
  type LicensePatch,
  type LicenseResponse,
} from '@starlings/contracts/licenses';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Textarea } from '@/ui/textarea';
import { apiFetch } from './api';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { formatDay } from './meeting-time';
import { SheetField } from './work-parts';

/** The words for a licence's values: one place, for the rows, the filter and the form. */
export function licenseProductLabel(product: string | null | undefined): string {
  switch (product) {
    case 'signals': return t('Signals');
    case 'other': return t('Other');
    default: return product ?? t('Other');
  }
}

function planLabel(plan: string): string {
  switch (plan) {
    case 'starter': return t('Starter');
    case 'pro': return t('Pro');
    case 'partner': return t('Partner');
    default: return plan;
  }
}

function paymentLabel(payment: string): string {
  switch (payment) {
    case 'invoice': return t('Invoice');
    case 'stripe': return t('Stripe');
    default: return payment;
  }
}

function intervalLabel(interval: string): string {
  switch (interval) {
    case 'month': return t('Monthly');
    case 'year': return t('Yearly');
    case 'one_time': return t('One time');
    default: return interval;
  }
}

type Draft = {
  product: string;
  plan_type: string;
  seats: string;
  payment_type: string;
  billing_interval: string;
  amount_eur: string;
  start_date: string;
  renewal_date: string;
  is_active: boolean;
  notes: string;
  signals_org_id: string;
};

/** One calendar year from `day`, for a new licence's renewal. */
function nextYear(day: string): string {
  const year = Number(day.slice(0, 4)) + 1;
  return `${year}${day.slice(4)}`;
}

function draftOf(license: CrmLicense | undefined): Draft {
  const today = new Date().toISOString().slice(0, 10);
  return {
    product: license?.product ?? 'other',
    plan_type: license?.plan_type ?? '',
    seats: license?.seats === null || license?.seats === undefined ? '' : String(license.seats),
    payment_type: license?.payment_type ?? '',
    billing_interval: license?.billing_interval ?? '',
    amount_eur: license?.amount_eur === null || license?.amount_eur === undefined ? '' : String(license.amount_eur),
    start_date: license?.start_date ?? today,
    renewal_date: license?.renewal_date ?? nextYear(today),
    is_active: license?.is_active ?? true,
    notes: license?.notes ?? '',
    signals_org_id: license?.signals_org_id ?? '',
  };
}

/** The draft as the routes name it. An empty field is null, and an empty amount is zero. */
function bodyOf(draft: Draft): Required<Pick<LicenseCreate, 'start_date' | 'renewal_date'>> & Omit<LicensePatch, 'start_date' | 'renewal_date'> {
  return {
    product: draft.product as LicensePatch['product'],
    plan_type: (draft.plan_type || null) as LicensePatch['plan_type'],
    seats: draft.seats === '' ? null : Number(draft.seats),
    payment_type: (draft.payment_type || null) as LicensePatch['payment_type'],
    billing_interval: (draft.billing_interval || null) as LicensePatch['billing_interval'],
    amount_eur: draft.amount_eur === '' ? 0 : Number(draft.amount_eur),
    start_date: draft.start_date,
    renewal_date: draft.renewal_date,
    is_active: draft.is_active,
    notes: draft.notes.trim() || null,
    signals_org_id: draft.signals_org_id.trim() || null,
  };
}

/** Only what changed. */
function patchOf(license: CrmLicense, draft: Draft): LicensePatch {
  const body = bodyOf(draft) as Record<string, unknown>;
  const before = bodyOf(draftOf(license)) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(body).filter(([key, value]) => value !== before[key])) as LicensePatch;
}

/**
 * A licence's fields: a new one on `subject`, or `license`. The same form on the
 * subject's Licenses group and on `/work/licenses`.
 */
export function LicenseForm({ license, subject, onSaved, onCancel }: {
  license?: CrmLicense;
  subject?: { kind: 'lead' | 'organization'; id: string };
  onSaved: (license: CrmLicense) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(license));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const fallbackError = t('Couldn’t save the license.');
  const complete = draft.start_date !== '' && draft.renewal_date !== '' && draft.renewal_date >= draft.start_date;

  const run = async (request: () => Promise<LicenseResponse>) => {
    setBusy(true);
    setError('');
    try {
      onSaved((await request()).license);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallbackError);
    } finally {
      setBusy(false);
    }
  };
  const save = () => run(async () => {
    if (license) {
      const patch = patchOf(license, draft);
      if (Object.keys(patch).length === 0) return { license };
      return apiFetch<LicenseResponse>(`/crm/licenses/${license.id}`, { method: 'PATCH', body: patch, fallbackError, noStore: true });
    }
    const on = subject ? { [subject.kind === 'lead' ? 'lead_id' : 'organization_id']: subject.id } : {};
    return apiFetch<LicenseResponse>('/crm/licenses', { method: 'POST', body: { ...bodyOf(draft), ...on }, fallbackError, noStore: true });
  });
  const end = () => run(() => apiFetch<LicenseResponse>(`/crm/licenses/${license!.id}/end`, { method: 'POST', body: {}, fallbackError, noStore: true }));

  const choice = (label: string, value: string, options: readonly string[], name: (option: string) => string, onChange: (value: string) => void, none?: boolean) => (
    <SheetField label={label}>
      <NativeSelect value={value} disabled={busy} onChange={(event) => onChange(event.target.value)}>
        {none && <NativeSelectOption value="">{t('None')}</NativeSelectOption>}
        {options.map((option) => <NativeSelectOption key={option} value={option}>{name(option)}</NativeSelectOption>)}
      </NativeSelect>
    </SheetField>
  );

  return (
    <div className="grid gap-3">
      <div className="grid gap-3 min-[601px]:grid-cols-2">
        {choice(t('Product'), draft.product, LICENSE_PRODUCTS, licenseProductLabel, (value) => set('product', value))}
        {choice(t('Plan'), draft.plan_type, LICENSE_PLAN_TYPES, planLabel, (value) => set('plan_type', value), true)}
        <SheetField label={t('Seats')}><Input type="number" inputMode="numeric" min={0} value={draft.seats} disabled={busy} onChange={(event) => set('seats', event.target.value)} /></SheetField>
        <SheetField label={t('Amount, EUR')}><Input type="number" inputMode="decimal" min={0} value={draft.amount_eur} disabled={busy} onChange={(event) => set('amount_eur', event.target.value)} /></SheetField>
        <SheetField label={t('Start')}><Input type="date" value={draft.start_date} disabled={busy} onChange={(event) => set('start_date', event.target.value)} /></SheetField>
        <SheetField label={t('Renewal')}><Input type="date" value={draft.renewal_date} disabled={busy} onChange={(event) => set('renewal_date', event.target.value)} /></SheetField>
        {choice(t('Payment'), draft.payment_type, LICENSE_PAYMENT_TYPES, paymentLabel, (value) => set('payment_type', value), true)}
        {choice(t('Billing'), draft.billing_interval, LICENSE_BILLING_INTERVALS, intervalLabel, (value) => set('billing_interval', value), true)}
      </div>
      {draft.product === 'signals' && (
        <SheetField label={t('Signals organization')}><Input value={draft.signals_org_id} disabled={busy} onChange={(event) => set('signals_org_id', event.target.value)} /></SheetField>
      )}
      <SheetField label={t('Notes')}><Textarea rows={3} value={draft.notes} disabled={busy} onChange={(event) => set('notes', event.target.value)} /></SheetField>
      <Label className="flex items-center gap-2 text-[13px] font-normal">
        <Checkbox checked={draft.is_active} disabled={busy} onCheckedChange={(value) => set('is_active', value === true)} />
        {t('Active')}
      </Label>
      {license?.usage && <UsageFacts usage={license.usage} />}
      {error && <ErrorNotice message={error} copyText={error} />}
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={busy || !complete} onClick={() => void save()}>{t('Save')}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{t('Cancel')}</Button>
        {license?.is_active && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void end()}>{t('End license')}</Button>}
      </div>
    </div>
  );
}

/** What Signals last reported. Unknown stays out, never zero. */
function UsageFacts({ usage }: { usage: NonNullable<CrmLicense['usage']> }) {
  const rows = [
    [t('Usage on'), formatDay(usage.snapshot_at)],
    [t('Sessions, 30 days'), usage.sessions_created_30d],
    [t('Runs, 30 days'), usage.workflow_runs_succeeded_30d],
    [t('Projects'), usage.projects_count],
  ].filter(([, value]) => value !== null && value !== '');
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
      {rows.map(([label, value]) => (
        <div key={String(label)} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
