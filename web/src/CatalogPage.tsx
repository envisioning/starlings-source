import { useCallback, useEffect, useState } from 'react';
import type { CatalogResponse, CatalogService, CatalogServiceResponse, ServiceCreate, ServicePatch } from '@starlings/contracts/offers';
import { SERVICE_CATEGORIES, SERVICE_GROUP_LABELS, SERVICE_GROUP_TYPES, type ServiceGroupType } from '@starlings/contracts/offer-values';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { PlaceholderRows } from '@/ui/placeholder-rows';
import { Textarea } from '@/ui/textarea';
import { apiFetch } from './api';
import { useDocumentTitle } from './document-title';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { useOwnerSession } from './owner-session';
import { RailRow, RailSection } from './SurfaceShell';
import { railListClass } from './rail-list';
import { Note } from './SectionCard';
import { SignInGate } from './SignInGate';
import { AppShell, MemberLoadingShell } from './SiteChrome';
import { formatMoney } from './SubjectOverview';
import { SheetField, detailTitleClass } from './work-parts';

/**
 * `/work/catalog`: the service catalog (decided by MZ, 2026-11-04). A name is
 * set once: to rename a service, create a new one and take the old one off
 * the rate card.
 */
export function CatalogPage() {
  const session = useOwnerSession();
  useDocumentTitle(t('Catalog'), t('Work'));
  if (session.kind === 'loading') return <MemberLoadingShell />;
  if (session.kind === 'visitor') return <SignInGate title={t('Work')} />;
  return (
    <AppShell variant="wide" member="work">
      <Catalog />
    </AppShell>
  );
}

type Draft = {
  name: string;
  slug: string;
  summary: string;
  description: string;
  price: string;
  group_type: ServiceGroupType;
  category: string;
  is_recurring: boolean;
  is_public: boolean;
  is_listed: boolean;
  allow_multiple: boolean;
  allow_description_override: boolean;
  name_pt: string;
  summary_pt: string;
  description_pt: string;
};

const EMPTY: Draft = {
  name: '', slug: '', summary: '', description: '', price: '', group_type: 'Optional', category: '', is_recurring: false,
  is_public: true, is_listed: false, allow_multiple: false, allow_description_override: false, name_pt: '', summary_pt: '', description_pt: '',
};

const draftOf = (service: CatalogService): Draft => ({
  name: service.name,
  slug: service.slug ?? '',
  summary: service.summary,
  description: service.description,
  price: String(service.price),
  group_type: (SERVICE_GROUP_TYPES as readonly string[]).includes(service.group_type ?? '') ? service.group_type as ServiceGroupType : 'Optional',
  category: service.category ?? '',
  is_recurring: service.is_recurring,
  is_public: service.is_public,
  is_listed: service.is_listed,
  allow_multiple: service.allow_multiple,
  allow_description_override: service.allow_description_override,
  name_pt: service.name_pt ?? '',
  summary_pt: service.summary_pt ?? '',
  description_pt: service.description_pt ?? '',
});

const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

function bodyOf(draft: Draft): Omit<ServiceCreate, 'name'> {
  return {
    ...(draft.slug.trim() ? { slug: draft.slug.trim() } : {}),
    summary: draft.summary,
    description: draft.description,
    price: Number(draft.price),
    group_type: draft.group_type,
    category: orNull(draft.category) as ServiceCreate['category'] ?? null,
    is_recurring: draft.is_recurring,
    recurring_interval: draft.is_recurring ? 'yearly' : null,
    is_public: draft.is_public,
    is_listed: draft.is_listed,
    allow_multiple: draft.allow_multiple,
    allow_description_override: draft.allow_description_override,
    name_pt: orNull(draft.name_pt),
    summary_pt: orNull(draft.summary_pt),
    description_pt: orNull(draft.description_pt),
  };
}

function Catalog() {
  const [services, setServices] = useState<CatalogService[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | 'new' | null>(null);

  const load = useCallback(() => {
    setError('');
    const fallbackError = t('Couldn’t load the catalog.');
    void apiFetch<CatalogResponse>('/crm/services', { fallbackError, noStore: true })
      .then((body) => setServices(body.services))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : fallbackError));
  }, []);
  useEffect(load, [load]);

  const saved = (service: CatalogService) => {
    setServices((current) => {
      const rest = (current ?? []).filter((row) => row.id !== service.id);
      return [...rest, service].sort((a, b) => a.name.localeCompare(b.name));
    });
    setOpen(null);
  };

  if (error) return <ErrorNotice message={error} action={<Button type="button" variant="outline" size="xs" onClick={load}>{t('Retry')}</Button>} />;
  if (!services) return <PlaceholderRows count={6} label={t('Opening…')} />;

  const chosen = open && open !== 'new' ? services.find((service) => service.id === open) ?? null : null;
  return (
    <div className="grid w-full gap-4 text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className={detailTitleClass}>{t('Catalog')}</h1>
        <Button type="button" size="sm" onClick={() => setOpen('new')}>{t('New service')}</Button>
      </header>
      {services.length === 0 && open === null && <Note>{t('No services.')}</Note>}
      <div className="grid gap-4 min-[901px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          {SERVICE_GROUP_TYPES.map((group) => {
            const rows = services.filter((service) => (service.group_type ?? 'Optional') === group);
            return (
              <RailSection key={group} title={t(SERVICE_GROUP_LABELS[group])} storageKey={`work.catalog.${group}`} count={rows.length} hidesWhenEmpty>
                <ul className={railListClass}>
                  {rows.map((service) => (
                    <RailRow
                      key={service.id}
                      title={service.name}
                      subtitle={[formatMoney(service.price, 'EUR'), service.is_public ? null : t('Off the rate card'), service.is_listed ? t('Listed') : null].filter(Boolean).join(' · ')}
                      active={open === service.id}
                      onSelect={() => setOpen(service.id)}
                    />
                  ))}
                </ul>
              </RailSection>
            );
          })}
        </div>
        <div className="min-w-0">
          {open === 'new' && <ServiceForm key="new" onSaved={saved} onCancel={() => setOpen(null)} />}
          {chosen && <ServiceForm key={chosen.id} service={chosen} onSaved={saved} onCancel={() => setOpen(null)} />}
        </div>
      </div>
    </div>
  );
}

function ServiceForm({ service, onSaved, onCancel }: { service?: CatalogService; onSaved: (service: CatalogService) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<Draft>(service ? draftOf(service) : EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const complete = draft.name.trim() !== '' && draft.summary.trim() !== '' && draft.description.trim() !== '' && draft.price !== '' && Number(draft.price) >= 0;

  const save = async () => {
    setBusy(true);
    setError('');
    const fallbackError = t('Couldn’t save the service.');
    try {
      const body = bodyOf(draft);
      const answer = service
        ? await apiFetch<CatalogServiceResponse>(`/crm/services/${service.id}`, { method: 'PATCH', body: patchOf(service, body), fallbackError, noStore: true })
        : await apiFetch<CatalogServiceResponse>('/crm/services', { method: 'POST', body: { name: draft.name.trim(), ...body }, fallbackError, noStore: true });
      onSaved(answer.service);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallbackError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-3">
      <div className="grid gap-3 min-[601px]:grid-cols-2">
        <SheetField label={t('Name')}><Input value={draft.name} disabled={busy || Boolean(service)} onChange={(event) => set('name', event.target.value)} /></SheetField>
        <SheetField label={t('Slug')}><Input value={draft.slug} disabled={busy || Boolean(service?.slug)} placeholder="signals-session" onChange={(event) => set('slug', event.target.value)} /></SheetField>
        <SheetField label={t('Price, EUR')}><Input type="number" inputMode="decimal" min={0} value={draft.price} disabled={busy} onChange={(event) => set('price', event.target.value)} /></SheetField>
        <SheetField label={t('Group')}>
          <NativeSelect value={draft.group_type} disabled={busy} onChange={(event) => set('group_type', event.target.value as ServiceGroupType)}>
            {SERVICE_GROUP_TYPES.map((group) => <NativeSelectOption key={group} value={group}>{t(SERVICE_GROUP_LABELS[group])}</NativeSelectOption>)}
          </NativeSelect>
        </SheetField>
        <SheetField label={t('Category')}>
          <NativeSelect value={draft.category} disabled={busy} onChange={(event) => set('category', event.target.value)}>
            <NativeSelectOption value="">{t('None')}</NativeSelectOption>
            {SERVICE_CATEGORIES.map((category) => <NativeSelectOption key={category} value={category}>{category}</NativeSelectOption>)}
          </NativeSelect>
        </SheetField>
      </div>
      {service && <Note>{t('To rename a service, create a new one and take this one off the rate card.')}</Note>}
      <SheetField label={t('Summary')}><Textarea rows={2} value={draft.summary} disabled={busy} onChange={(event) => set('summary', event.target.value)} /></SheetField>
      <SheetField label={t('Description')}><Textarea rows={5} value={draft.description} disabled={busy} onChange={(event) => set('description', event.target.value)} /></SheetField>
      <div className="grid gap-1.5">
        <Flag label={t('On the rate card')} checked={draft.is_public} disabled={busy} onChange={(value) => set('is_public', value)} />
        <Flag label={t('Listed on the services page')} checked={draft.is_listed} disabled={busy} onChange={(value) => set('is_listed', value)} />
        <Flag label={t('Recurring, yearly')} checked={draft.is_recurring} disabled={busy} onChange={(value) => set('is_recurring', value)} />
        <Flag label={t('Can be on an offer more than once')} checked={draft.allow_multiple} disabled={busy} onChange={(value) => set('allow_multiple', value)} />
        <Flag label={t('An offer can change its description')} checked={draft.allow_description_override} disabled={busy} onChange={(value) => set('allow_description_override', value)} />
      </div>
      <SheetField label={t('Name, Portuguese')}><Input value={draft.name_pt} disabled={busy} onChange={(event) => set('name_pt', event.target.value)} /></SheetField>
      <SheetField label={t('Summary, Portuguese')}><Textarea rows={2} value={draft.summary_pt} disabled={busy} onChange={(event) => set('summary_pt', event.target.value)} /></SheetField>
      <SheetField label={t('Description, Portuguese')}><Textarea rows={3} value={draft.description_pt} disabled={busy} onChange={(event) => set('description_pt', event.target.value)} /></SheetField>
      {error && <ErrorNotice message={error} />}
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={busy || !complete} onClick={() => void save()}>{t('Save')}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>{t('Cancel')}</Button>
      </div>
    </div>
  );
}

/** The body of an edit: the fields, without a slug once one is set. */
function patchOf(service: CatalogService, body: Omit<ServiceCreate, 'name'>): ServicePatch {
  const { slug, ...rest } = body;
  return { ...rest, ...(!service.slug && slug ? { slug } : {}) } as ServicePatch;
}

function Flag({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return (
    <Label className="flex items-center gap-2 text-[13px] font-normal">
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => onChange(value === true)} />
      {label}
    </Label>
  );
}
