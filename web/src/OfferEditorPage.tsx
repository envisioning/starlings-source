import { useCallback, useEffect, useState } from 'react';
import type {
  CatalogResponse,
  CatalogService,
  OfferDecisionResponse,
  OfferHeader,
  OfferLine,
  OfferLineCreate,
  OfferOptionsResponse,
  OfferPatch,
  OfferResponse,
  OfferSendResponse,
  OfferVersionResponse,
} from '@starlings/contracts/offers';
import { OFFER_STATUS_LABELS, type OfferStatus } from '@starlings/contracts/offer-values';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { PlaceholderRows } from '@/ui/placeholder-rows';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { Textarea } from '@/ui/textarea';
import { apiFetch } from './api';
import { fetchSubjects, searchCrmOrganizations } from './crm-work';
import { useDocumentTitle } from './document-title';
import { ErrorNotice } from './ErrorNotice';
import { formatDay } from './meeting-time';
import { t } from './i18n';
import { navigate } from './navigation';
import { useOwnerSession } from './owner-session';
import { RailSection } from './SurfaceShell';
import { SearchablePicker } from './SearchablePicker';
import type { SearchablePickerOption } from './searchable-picker';
import { Note, TableFrame } from './SectionCard';
import { SignInGate } from './SignInGate';
import { AppShell, MemberLoadingShell } from './SiteChrome';
import { formatMoney } from './SubjectOverview';
import { SheetField } from './work-parts';

/** `/work/offers/<id>`: the offer editor. Every total comes from the server. */
export function OfferEditorPage() {
  const session = useOwnerSession();
  const id = /^\/work\/offers\/([0-9a-f-]{36})\/?$/iu.exec(window.location.pathname)?.[1] ?? '';
  useDocumentTitle(t('Offer'), t('Work'));
  if (session.kind === 'loading') return <MemberLoadingShell />;
  if (session.kind === 'visitor') return <SignInGate title={t('Work')} />;
  return (
    <AppShell variant="wide" member="work">
      <OfferEditor key={id} id={id} />
    </AppShell>
  );
}

const SAVE_ERROR = t('Couldn’t save the offer.');

function statusLabel(status: string): string {
  const label = OFFER_STATUS_LABELS[status as OfferStatus];
  return label ? t(label) : status;
}

function OfferEditor({ id }: { id: string }) {
  const [data, setData] = useState<OfferResponse | null>(null);
  const [options, setOptions] = useState<OfferOptionsResponse | null>(null);
  const [catalog, setCatalog] = useState<CatalogService[]>([]);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentLink, setSentLink] = useState('');

  const load = useCallback(() => {
    setLoadError('');
    const fallbackError = t('Couldn’t load the offer.');
    void Promise.all([
      apiFetch<OfferResponse>(`/crm/offers/${id}`, { fallbackError, noStore: true }),
      apiFetch<OfferOptionsResponse>('/crm/offer-options', { fallbackError, noStore: true }),
      apiFetch<CatalogResponse>('/crm/services', { fallbackError, noStore: true }),
    ]).then(([offer, picks, services]) => {
      setData(offer);
      setOptions(picks);
      setCatalog(services.services);
    }).catch((cause: unknown) => setLoadError(cause instanceof Error ? cause.message : fallbackError));
  }, [id]);
  useEffect(load, [load]);

  /** One change: busy while it runs, its answer replaces the page, its failure shows here. */
  const run = useCallback(async (action: () => Promise<OfferResponse>) => {
    setBusy(true);
    setError('');
    try {
      setData(await action());
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : SAVE_ERROR);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const write = useCallback((path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) =>
    apiFetch<OfferResponse>(`/crm/offers/${id}${path}`, { method, ...(body === undefined ? {} : { body }), fallbackError: SAVE_ERROR, noStore: true }), [id]);

  const send = () => void run(async () => {
    const answer = await apiFetch<OfferSendResponse>(`/crm/offers/${id}/${data?.offer.next_send === 'send' ? 'send' : 'send-update'}`, { method: 'POST', fallbackError: t('Couldn’t send the offer.'), noStore: true });
    setSentLink(answer.link);
    return answer;
  });

  if (loadError) return <ErrorNotice message={loadError} action={<Button type="button" variant="outline" size="xs" onClick={load}>{t('Retry')}</Button>} />;
  if (!data || !options) return <PlaceholderRows count={6} label={t('Opening…')} />;

  const { offer, lines, totals, versions } = data;
  const readOnly = offer.locked || busy;
  return (
    <div className="grid w-full gap-4 text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="m-0 text-lg font-medium">{offer.title || t('Untitled offer')}</h1>
          <Badge variant="secondary">{statusLabel(offer.shown_status)}</Badge>
          {offer.has_unsent_changes && <Badge variant="outline">{t('Unsent changes')}</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {offer.link && <CopyLink link={offer.link} />}
          {offer.next_send && (
            <Button type="button" size="sm" disabled={busy} onClick={send}>
              {offer.next_send === 'send' ? t('Send') : t('Send update')}
            </Button>
          )}
        </div>
      </header>
      {sentLink && <Note>{t('Sent. Share the link: {link}', { link: sentLink })}</Note>}
      {offer.locked && <Note>{t('Accepted. Duplicate it to change it.')}</Note>}
      {error && <ErrorNotice message={error} />}

      <div className="grid gap-4 min-[901px]:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
        <div className="grid min-w-0 content-start">
          <RailSection title={t('Lines')} storageKey="work.offer.lines">
            <LinesTable lines={lines} currency={totals.currency} readOnly={readOnly} onChange={(lineId, change) => run(() => write(`/lines/${lineId}`, 'PATCH', change))} onRemove={(lineId) => run(() => write(`/lines/${lineId}`, 'DELETE'))} />
            {!offer.locked && <AddLine catalog={catalog} busy={busy} onAdd={(line) => run(() => write('/lines', 'POST', line))} />}
          </RailSection>
          <RailSection title={t('Details')} storageKey="work.offer.details">
            <HeaderForm key={offer.updated_at} offer={offer} options={options} readOnly={readOnly} onSave={(patch) => run(() => write('', 'PATCH', patch))} />
          </RailSection>
        </div>
        <div className="grid min-w-0 content-start">
          <RailSection title={t('Totals')} storageKey="work.offer.totals">
            <TotalsTable data={data} />
          </RailSection>
          {versions.length > 0 && (
            <RailSection title={t('Versions')} storageKey="work.offer.versions">
              <Versions offerId={id} data={data} />
            </RailSection>
          )}
          {(data.views?.length ?? 0) > 0 && (
            <RailSection title={t('Viewed')} storageKey="work.offer.views" count={data.views!.length}>
              <ul className="grid gap-1 text-[13px]">
                {data.views!.map((view) => (
                  <li key={`${view.at}:${view.email ?? ''}`} className="flex justify-between gap-3">
                    <span>{view.email ?? t('No address')}</span>
                    <span className="text-muted-foreground">{formatDay(view.at)}</span>
                  </li>
                ))}
              </ul>
            </RailSection>
          )}
          <RailSection title={t('Actions')} storageKey="work.offer.actions">
            <Actions offer={offer} lines={lines} busy={busy} run={run} write={write} />
          </RailSection>
        </div>
      </div>
    </div>
  );
}

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button type="button" size="sm" variant="secondary" onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}>
      {copied ? t('Copied') : t('Copy link')}
    </Button>
  );
}

function LinesTable({ lines, currency, readOnly, onChange, onRemove }: {
  lines: OfferLine[];
  currency: string;
  readOnly: boolean;
  onChange: (lineId: string, change: { quantity?: number; price?: number; is_optional?: boolean }) => Promise<boolean>;
  onRemove: (lineId: string) => Promise<boolean>;
}) {
  if (lines.length === 0) return <Note>{t('No lines.')}</Note>;
  return (
    <TableFrame>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('Line')}</TableHead>
            <TableHead scope="col">{t('Quantity')}</TableHead>
            <TableHead scope="col">{t('Price, EUR')}</TableHead>
            {currency !== 'EUR' && <TableHead scope="col">{currency}</TableHead>}
            <TableHead scope="col">{t('Optional')}</TableHead>
            <TableHead scope="col"><span className="sr-only">{t('Actions')}</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.map((line) => <LineRow key={line.id} line={line} currency={currency} readOnly={readOnly} onChange={onChange} onRemove={onRemove} />)}
        </TableBody>
      </Table>
    </TableFrame>
  );
}

function LineRow({ line, currency, readOnly, onChange, onRemove }: {
  line: OfferLine;
  currency: string;
  readOnly: boolean;
  onChange: (lineId: string, change: { quantity?: number; price?: number; is_optional?: boolean }) => Promise<boolean>;
  onRemove: (lineId: string) => Promise<boolean>;
}) {
  const [quantity, setQuantity] = useState(String(line.quantity));
  const [price, setPrice] = useState(String(line.price));
  useEffect(() => { setQuantity(String(line.quantity)); setPrice(String(line.price)); }, [line.quantity, line.price]);
  const commit = () => {
    const nextQuantity = Number.parseInt(quantity, 10);
    const nextPrice = Number(price);
    const change: { quantity?: number; price?: number } = {};
    if (nextQuantity >= 1 && nextQuantity !== line.quantity) change.quantity = nextQuantity;
    if (Number.isFinite(nextPrice) && nextPrice >= 0 && nextPrice !== line.price) change.price = nextPrice;
    if (Object.keys(change).length > 0) void onChange(line.id, change);
  };
  return (
    <TableRow>
      <TableCell className="min-w-[200px] whitespace-normal">
        <div className="font-medium">{line.name}</div>
        {line.description && !line.hide_description && <div className="line-clamp-2 text-[13px] text-muted-foreground">{line.description}</div>}
      </TableCell>
      <TableCell>
        <Input className="w-16" type="number" inputMode="numeric" min={1} value={quantity} disabled={readOnly} aria-label={t('Quantity')} onChange={(event) => setQuantity(event.target.value)} onBlur={commit} />
      </TableCell>
      <TableCell>
        <Input className="w-24" type="number" inputMode="decimal" min={0} value={price} disabled={readOnly} aria-label={t('Price, EUR')} onChange={(event) => setPrice(event.target.value)} onBlur={commit} />
      </TableCell>
      {currency !== 'EUR' && <TableCell className="text-muted-foreground">{formatMoney(line.display_price, currency)}</TableCell>}
      <TableCell>
        <Checkbox checked={line.is_optional} disabled={readOnly} aria-label={t('Optional')} onCheckedChange={(checked) => void onChange(line.id, { is_optional: checked === true })} />
      </TableCell>
      <TableCell>
        <Button type="button" size="sm" variant="ghost" disabled={readOnly} onClick={() => void onRemove(line.id)}>{t('Remove')}</Button>
      </TableCell>
    </TableRow>
  );
}

function AddLine({ catalog, busy, onAdd }: { catalog: CatalogService[]; busy: boolean; onAdd: (line: Partial<OfferLineCreate>) => Promise<boolean> }) {
  const [serviceId, setServiceId] = useState('');
  const [customTitle, setCustomTitle] = useState('');
  const [customPrice, setCustomPrice] = useState('');
  const offered = catalog.filter((service) => service.is_public);
  const addCustom = async () => {
    const price = Number(customPrice);
    if (await onAdd({ custom_title: customTitle.trim(), price })) {
      setCustomTitle('');
      setCustomPrice('');
    }
  };
  return (
    <div className="mt-3 grid gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <SheetField label={t('From the catalog')} className="min-w-[220px] flex-1">
          <NativeSelect value={serviceId} disabled={busy} onChange={(event) => setServiceId(event.target.value)}>
            <NativeSelectOption value="">{t('Choose a service')}</NativeSelectOption>
            {offered.map((service) => <NativeSelectOption key={service.id} value={service.id}>{service.name} · {formatMoney(service.price, 'EUR')}</NativeSelectOption>)}
          </NativeSelect>
        </SheetField>
        <Button type="button" size="sm" variant="secondary" disabled={busy || !serviceId} onClick={() => void onAdd({ service_id: serviceId }).then((added) => { if (added) setServiceId(''); })}>{t('Add')}</Button>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <SheetField label={t('Custom line')} className="min-w-[220px] flex-1">
          <Input value={customTitle} disabled={busy} onChange={(event) => setCustomTitle(event.target.value)} />
        </SheetField>
        <SheetField label={t('Price, EUR')} className="w-28">
          <Input type="number" inputMode="decimal" min={0} value={customPrice} disabled={busy} onChange={(event) => setCustomPrice(event.target.value)} />
        </SheetField>
        <Button type="button" size="sm" variant="secondary" disabled={busy || !customTitle.trim() || customPrice === '' || !(Number(customPrice) >= 0)} onClick={() => void addCustom()}>{t('Add')}</Button>
      </div>
    </div>
  );
}

const dayOf = (value: string | null) => value?.slice(0, 10) ?? '';
const numberOrNull = (value: string) => (value.trim() === '' ? null : Number(value));
const textOrNull = (value: string) => (value.trim() === '' ? null : value);

function HeaderForm({ offer, options, readOnly, onSave }: { offer: OfferHeader; options: OfferOptionsResponse; readOnly: boolean; onSave: (patch: OfferPatch) => Promise<boolean> }) {
  const initial = {
    title: offer.title ?? '',
    recipient_email: offer.recipient_email ?? '',
    valid_until: dayOf(offer.valid_until),
    currency: offer.currency,
    global_discount_percentage: offer.global_discount_percentage === null ? '' : String(offer.global_discount_percentage),
    discount_reason: offer.discount_reason ?? '',
    tax_percentage: offer.tax_percentage === null ? '' : String(offer.tax_percentage),
    tax_reason: offer.tax_reason ?? '',
    payment_term_id: offer.payment_term_id ?? '',
    payment_terms_text: offer.payment_terms_text ?? '',
    delivery_condition_id: offer.delivery_condition_id ?? '',
    delivery_conditions_text: offer.delivery_conditions_text ?? '',
    corporate_entity_id: offer.corporate_entity_id ?? '',
    notes: offer.notes ?? '',
  };
  const [draft, setDraft] = useState(initial);
  const [links, setLinks] = useState<string[]>(offer.link_ids);
  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const dirtyLinks = [...links].sort().join() !== [...offer.link_ids].sort().join();

  const save = () => {
    const patch: Record<string, unknown> = {};
    const changed = <K extends keyof typeof draft>(key: K) => draft[key] !== initial[key];
    if (changed('title')) patch.title = textOrNull(draft.title);
    if (changed('recipient_email')) patch.recipient_email = textOrNull(draft.recipient_email);
    if (changed('valid_until')) patch.valid_until = textOrNull(draft.valid_until);
    if (changed('currency')) patch.currency = draft.currency;
    if (changed('global_discount_percentage')) patch.global_discount_percentage = numberOrNull(draft.global_discount_percentage);
    if (changed('discount_reason')) patch.discount_reason = textOrNull(draft.discount_reason);
    if (changed('tax_percentage')) patch.tax_percentage = numberOrNull(draft.tax_percentage);
    if (changed('tax_reason')) patch.tax_reason = textOrNull(draft.tax_reason);
    if (changed('payment_term_id')) patch.payment_term_id = textOrNull(draft.payment_term_id);
    if (changed('payment_terms_text')) patch.payment_terms_text = textOrNull(draft.payment_terms_text);
    if (changed('delivery_condition_id')) patch.delivery_condition_id = textOrNull(draft.delivery_condition_id);
    if (changed('delivery_conditions_text')) patch.delivery_conditions_text = textOrNull(draft.delivery_conditions_text);
    if (changed('corporate_entity_id')) patch.corporate_entity_id = textOrNull(draft.corporate_entity_id);
    if (changed('notes')) patch.notes = textOrNull(draft.notes);
    if (dirtyLinks) patch.link_ids = links;
    void onSave(patch as OfferPatch);
  };
  const dirty = dirtyLinks || (Object.keys(draft) as Array<keyof typeof draft>).some((key) => draft[key] !== initial[key]);
  const currencies = ['EUR', ...options.currencies.map((currency) => currency.code).filter((code) => code !== 'EUR')];

  return (
    <div className="grid gap-3">
      <div className="grid gap-3 min-[601px]:grid-cols-2">
        <SheetField label={t('Title')}><Input value={draft.title} disabled={readOnly} onChange={(event) => set('title', event.target.value)} /></SheetField>
        <SheetField label={t('For')}><Input type="email" value={draft.recipient_email} disabled={readOnly} onChange={(event) => set('recipient_email', event.target.value)} /></SheetField>
        <SheetField label={t('Valid until')}><Input type="date" value={draft.valid_until} disabled={readOnly} onChange={(event) => set('valid_until', event.target.value)} /></SheetField>
        <SheetField label={t('Currency')}>
          <NativeSelect value={draft.currency} disabled={readOnly} onChange={(event) => set('currency', event.target.value)}>
            {currencies.map((code) => <NativeSelectOption key={code} value={code}>{code}</NativeSelectOption>)}
          </NativeSelect>
        </SheetField>
        <SheetField label={t('Discount, %')}><Input type="number" inputMode="decimal" min={0} max={100} value={draft.global_discount_percentage} disabled={readOnly} onChange={(event) => set('global_discount_percentage', event.target.value)} /></SheetField>
        <SheetField label={t('Discount reason')}><Input value={draft.discount_reason} disabled={readOnly} onChange={(event) => set('discount_reason', event.target.value)} /></SheetField>
        <SheetField label={t('Tax, %')}><Input type="number" inputMode="decimal" min={0} max={100} value={draft.tax_percentage} disabled={readOnly} onChange={(event) => set('tax_percentage', event.target.value)} /></SheetField>
        <SheetField label={t('Tax reason')}><Input value={draft.tax_reason} disabled={readOnly} onChange={(event) => set('tax_reason', event.target.value)} /></SheetField>
        <SheetField label={t('Payment term')}>
          <NativeSelect value={draft.payment_term_id} disabled={readOnly} onChange={(event) => {
            const term = options.payment_terms.find((row) => row.id === event.target.value);
            setDraft((current) => ({ ...current, payment_term_id: event.target.value, payment_terms_text: term?.description ?? current.payment_terms_text }));
          }}>
            <NativeSelectOption value="">{t('None')}</NativeSelectOption>
            {options.payment_terms.map((row) => <NativeSelectOption key={row.id} value={row.id}>{row.title}</NativeSelectOption>)}
          </NativeSelect>
        </SheetField>
        <SheetField label={t('Delivery condition')}>
          <NativeSelect value={draft.delivery_condition_id} disabled={readOnly} onChange={(event) => {
            const term = options.delivery_conditions.find((row) => row.id === event.target.value);
            setDraft((current) => ({ ...current, delivery_condition_id: event.target.value, delivery_conditions_text: term?.description ?? current.delivery_conditions_text }));
          }}>
            <NativeSelectOption value="">{t('None')}</NativeSelectOption>
            {options.delivery_conditions.map((row) => <NativeSelectOption key={row.id} value={row.id}>{row.title}</NativeSelectOption>)}
          </NativeSelect>
        </SheetField>
        <SheetField label={t('Corporate entity')}>
          <NativeSelect value={draft.corporate_entity_id} disabled={readOnly} onChange={(event) => set('corporate_entity_id', event.target.value)}>
            <NativeSelectOption value="">{t('None')}</NativeSelectOption>
            {options.corporate_entities.map((row) => <NativeSelectOption key={row.id} value={row.id}>{row.name}</NativeSelectOption>)}
          </NativeSelect>
        </SheetField>
      </div>
      <SheetField label={t('Payment terms')}><Textarea rows={3} value={draft.payment_terms_text} disabled={readOnly} onChange={(event) => set('payment_terms_text', event.target.value)} /></SheetField>
      <SheetField label={t('Delivery conditions')}><Textarea rows={3} value={draft.delivery_conditions_text} disabled={readOnly} onChange={(event) => set('delivery_conditions_text', event.target.value)} /></SheetField>
      <SheetField label={t('Notes')}><Textarea rows={3} value={draft.notes} disabled={readOnly} onChange={(event) => set('notes', event.target.value)} /></SheetField>
      {options.links.length > 0 && (
        <div className="grid gap-1.5">
          <span className="text-xs text-muted-foreground">{t('Links')}</span>
          {options.links.map((link) => (
            <Label key={link.id} className="flex items-center gap-2 text-[13px] font-normal">
              <Checkbox checked={links.includes(link.id)} disabled={readOnly} onCheckedChange={(checked) => setLinks((current) => (checked === true ? [...current, link.id] : current.filter((id) => id !== link.id)))} />
              {link.title}
            </Label>
          ))}
        </div>
      )}
      {!offer.locked && (
        <div>
          <Button type="button" size="sm" variant="secondary" disabled={readOnly || !dirty} onClick={save}>{t('Save')}</Button>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? 'font-medium' : undefined}>{value}</span>
    </div>
  );
}

function TotalsTable({ data }: { data: OfferResponse }) {
  const { totals } = data;
  const eur = (value: number) => formatMoney(value, 'EUR');
  return (
    <div className="grid gap-1.5">
      <Row label={t('Subtotal')} value={eur(totals.subtotal_eur)} />
      {totals.discount_eur > 0 && <Row label={t('Discount, {percent}%', { percent: totals.discount_pct })} value={`-${eur(totals.discount_eur)}`} />}
      <Row label={t('Total')} value={eur(totals.total_eur)} strong />
      {totals.tax_eur > 0 && <Row label={t('Tax, {percent}%', { percent: totals.tax_pct })} value={eur(totals.tax_eur)} />}
      {totals.optional_total_eur > 0 && <Row label={t('Optional')} value={eur(totals.optional_total_eur)} />}
      {totals.recurring_total_eur > 0 && <Row label={t('Recurring')} value={eur(totals.recurring_total_eur)} />}
      {totals.indicative && (
        <>
          <Row label={t('Indicative, {currency}', { currency: totals.currency })} value={formatMoney(totals.total, totals.currency)} />
          <Note>{t('EUR is binding.')}</Note>
        </>
      )}
      {totals.rate_missing && <ErrorNotice message={t('No rate for {currency}.', { currency: data.offer.currency })} />}
    </div>
  );
}

function Versions({ offerId, data }: { offerId: string; data: OfferResponse }) {
  const [open, setOpen] = useState<OfferVersionResponse | null>(null);
  const [error, setError] = useState('');
  const show = (version: number) => {
    setError('');
    const fallbackError = t('Couldn’t load that version.');
    void apiFetch<OfferVersionResponse>(`/crm/offers/${offerId}/versions/${version}`, { fallbackError, noStore: true })
      .then(setOpen)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : fallbackError));
  };
  return (
    <div className="grid gap-2">
      {data.versions.map((version) => (
        <div key={version.version} className="flex items-center justify-between gap-2 text-[13px]">
          <span>
            {t('Version {version}', { version: version.version })}
            <span className="text-muted-foreground"> · {formatDay(version.sent_at)}{data.offer.accepted_version === version.version ? ` · ${t('Accepted')}` : ''}</span>
          </span>
          <Button type="button" size="xs" variant="ghost" onClick={() => (open?.version.version === version.version ? setOpen(null) : show(version.version))}>
            {open?.version.version === version.version ? t('Close') : t('Read')}
          </Button>
        </div>
      ))}
      {error && <ErrorNotice message={error} />}
      {open && (
        <div className="grid gap-1 rounded-md border border-border p-2 text-[13px]">
          <div className="font-medium">{open.offer.title ?? t('Untitled offer')}</div>
          {open.lines.map((line) => (
            <div key={line.id} className="flex justify-between gap-2">
              <span>{line.quantity} × {line.name}{line.is_optional ? ` (${t('optional')})` : ''}</span>
              <span>{formatMoney(line.price, 'EUR')}</span>
            </div>
          ))}
          {open.version.total_eur !== null && <Row label={t('Total')} value={formatMoney(open.version.total_eur, 'EUR')} strong />}
        </div>
      )}
    </div>
  );
}

function Actions({ offer, lines, busy, run, write }: {
  offer: OfferHeader;
  lines: OfferLine[];
  busy: boolean;
  run: (action: () => Promise<OfferResponse>) => Promise<boolean>;
  write: (path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) => Promise<OfferResponse>;
}) {
  const [organization, setOrganization] = useState('');
  const [organizationOptions, setOrganizationOptions] = useState<SearchablePickerOption[]>([]);
  const [lead, setLead] = useState('');
  const [leadOptions, setLeadOptions] = useState<SearchablePickerOption[]>([]);
  const [recording, setRecording] = useState(false);
  const [signer, setSigner] = useState('');
  const [signerEmail, setSignerEmail] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [made, setMade] = useState<{ license: boolean; project: string | null } | null>(null);
  const optional = lines.filter((line) => line.is_optional);
  const canRecord = !offer.locked && offer.next_send !== 'send';

  const search = useCallback(async (query: string) => {
    const matches = (await searchCrmOrganizations(query)).map(({ id, name }) => ({ id, title: name }));
    setOrganizationOptions(matches);
    return matches;
  }, []);

  const searchLeads = useCallback(async (query: string) => {
    const matches = (await fetchSubjects('lead', query)).subjects.map(({ id, title }) => ({ id, title }));
    setLeadOptions(matches);
    return matches;
  }, []);

  const duplicate = () => void run(async () => {
    const copy = await write('/duplicate', 'POST', lead ? { lead_id: lead } : organization ? { organization_id: organization } : {});
    navigate(`/work/offers/${copy.offer.id}`);
    return copy;
  });

  return (
    <div className="grid gap-3">
      <div className="grid gap-2">
        <SearchablePicker
          label={t('Duplicate to')}
          placeholder={t('This subject')}
          options={organizationOptions}
          value={organization}
          onChange={(id) => { setOrganization(id); if (id) setLead(''); }}
          onSearch={search}
          emptyMessage={t('No organizations.')}
          disabled={busy}
        />
        <SearchablePicker
          label={t('Or to a lead')}
          placeholder={t('This subject')}
          options={leadOptions}
          value={lead}
          onChange={(id) => { setLead(id); if (id) setOrganization(''); }}
          onSearch={searchLeads}
          emptyMessage={t('No leads.')}
          disabled={busy}
        />
        <div><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={duplicate}>{t('Duplicate')}</Button></div>
      </div>
      {canRecord && !recording && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => setRecording(true)}>{t('Record accept')}</Button>
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => write('/decision', 'POST', { decision: 'reject' }))}>{t('Record reject')}</Button>
        </div>
      )}
      {canRecord && recording && (
        <div className="grid gap-2">
          <SheetField label={t('Accepted by')}><Input value={signer} disabled={busy} onChange={(event) => setSigner(event.target.value)} /></SheetField>
          <SheetField label={t('Email')}><Input type="email" value={signerEmail} disabled={busy} onChange={(event) => setSignerEmail(event.target.value)} /></SheetField>
          {optional.map((line) => (
            <Label key={line.id} className="flex items-center gap-2 text-[13px] font-normal">
              <Checkbox checked={chosen.includes(line.id)} disabled={busy} onCheckedChange={(checked) => setChosen((current) => (checked === true ? [...current, line.id] : current.filter((id) => id !== line.id)))} />
              {line.name}
            </Label>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={busy} onClick={() => void run(() => write('/decision', 'POST', {
              decision: 'accept',
              ...(signer.trim() ? { accepted_by_name: signer.trim() } : {}),
              ...(signerEmail.trim() ? { accepted_by_email: signerEmail.trim() } : {}),
              ...(chosen.length > 0 ? { selected_optional_ids: chosen } : {}),
            }).then((answer) => {
              const made = answer as OfferDecisionResponse;
              setMade({ license: made.license_created, project: made.project_id });
              return answer;
            }))}>{t('Record accept')}</Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setRecording(false)}>{t('Cancel')}</Button>
          </div>
        </div>
      )}
      {made?.license && <Note>{t('License created.')}</Note>}
      {made?.project && (
        <div><Button type="button" size="sm" variant="secondary" onClick={() => navigate(`/work/project/${made.project}`)}>{t('Open project')}</Button></div>
      )}
      {offer.is_accepted && offer.accepted_at && (
        <Note>{t('Accepted {date}', { date: formatDay(offer.accepted_at) })}{offer.accepted_by_name ? ` · ${offer.accepted_by_name}` : ''}</Note>
      )}
    </div>
  );
}
