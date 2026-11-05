import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CrmContact, CrmIssue, CrmIssuesResponse, CrmLicense, CrmOffer, CrmSubjectCommercialResponse } from '@starlings/contracts';
import { OFFER_STATUS_LABELS, type OfferStatus } from '@starlings/contracts/offer-values';
import type { OfferResponse, OrganizationDiscountResponse } from '@starlings/contracts/offers';
import { navigate } from './navigation';
import { workspaceCoreGroups } from './workspace-core';
import { LicenseForm, licenseProductLabel } from './LicenseForm';
import type { FormSubmission, SubjectSubmissionResponse } from '@starlings/contracts/forms';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { cn } from '@/lib/utils';
import { apiFetch } from './api';
import { ControlRequestError } from './config';
import { ErrorNotice } from './ErrorNotice';
import { NoteIcon, PlusIcon } from './action-icons';
import { railListClass } from './rail-list';
import { RailEmpty, RailRow, RailRowsPlaceholder, RailSection, SCROLLBAR_AFFORDANCE_CLASS } from './SurfaceShell';
import { contactDisplayName, contactsByID, searchContacts } from './contacts';
import { GlyphMark } from './SubjectMark';
import { Tip } from './Tip';
import { IssueRow, issueMeta } from './WorkRows';
import { documentsSnapshotKey, fetchDocsDocuments, rowDatesLabel, type DocsDocumentSummary } from './docs';
import { loadSnapshot } from './snapshot-store';
import type { CrmSubject } from './crm-work';
import { dayTitle } from './conversation-model';
import { plural, t, uiLocale } from './i18n';
import { formatDay, parseDay } from './meeting-time';

/** Rows a group shows before Show all, as on the Mac (WorkSubjectOverviewView). */
export const OVERVIEW_GROUP_ROWS = 5;

/** One half of a two-column Work page: its own scroller above 900px. */
export const overviewHalfClass = cn(
  'min-w-0 min-[901px]:min-h-0 min-[901px]:overflow-y-auto min-[901px]:overscroll-contain min-[901px]:pr-1',
  SCROLLBAR_AFFORDANCE_CLASS,
);

/**
 * A subject's Overview: Talk beside the subject's work groups, the Mac's
 * `WorkSubjectOverviewView`. Above 900px the two halves stand the column's
 * height and scroll on their own (SurfaceShell reads `subject-overview-columns`
 * to hand the column's scroll to them). Narrower, there is no Talk here — it
 * is the Talk tab, as it is a pushed pane on the phone — and the groups flow
 * in the page.
 */
export function SubjectOverviewLayout({ talk, children }: { talk?: ReactNode; children: ReactNode }) {
  return (
    <section
      className={cn(
        'subject-overview-columns mt-3 grid grid-cols-1 gap-7',
        'min-[901px]:min-h-0 min-[901px]:flex-1 min-[901px]:grid-rows-[minmax(0,1fr)] min-[901px]:items-stretch',
        talk && 'min-[901px]:grid-cols-2',
      )}
      aria-label={t('Overview')}
    >
      {talk && <div className="min-w-0 min-[901px]:min-h-0">{talk}</div>}
      <div className={overviewHalfClass}>{children}</div>
    </section>
  );
}

/**
 * One foldable group of the work half: a header with its count, Show all once
 * there are more rows than fit, and a + where the group can take a new item.
 * Each group owns its loading and error state, so one failed read never
 * blanks the others. A group that cannot take an item and has nothing to say
 * draws nothing, unless it has an `empty` line to say. A group without Show
 * all shows every row it has.
 */
export function OverviewGroup({ subject, group, title, rows, lead, loading = false, error = '', onRetry, onShowAll, onNew, newLabel, empty, children }: {
  subject: CrmSubject;
  group: string;
  title: string;
  rows: ReactNode[];
  /** A row above the list that the count and the empty line ignore. */
  lead?: ReactNode;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onShowAll?: () => void;
  onNew?: () => void;
  newLabel?: string;
  /** The line a loaded group with no rows draws; with it, the group always draws. */
  empty?: string;
  /** Replaces the row list, for a group with its own body. */
  children?: ReactNode;
}) {
  if (!onNew && !empty && !loading && rows.length === 0 && !error && !children) return null;
  const accessory = (onShowAll && rows.length > OVERVIEW_GROUP_ROWS) || onNew ? (
    <span className="flex flex-none items-center gap-1">
      {onShowAll && rows.length > OVERVIEW_GROUP_ROWS && (
        <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" aria-label={t('Show all {group}', { group: title.toLowerCase() })} onClick={onShowAll}>{t('Show all')}</Button>
      )}
      {onNew && newLabel && (
        <Tip label={newLabel}>
          <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label={newLabel} onClick={onNew}><PlusIcon /></Button>
        </Tip>
      )}
    </span>
  ) : undefined;
  return (
    <RailSection title={title} storageKey={`work.subject-overview.${subject.kind}.${subject.id}.${group}`} count={rows.length} accessory={accessory}>
      {children ?? (
        <>
          {lead && <ul className={railListClass}>{lead}</ul>}
          {error && <ErrorNotice message={error} copyText={error} action={onRetry ? <Button type="button" variant="outline" size="xs" onClick={onRetry}>{t('Retry')}</Button> : undefined} />}
          {loading && rows.length === 0 && !error && <RailRowsPlaceholder count={2} mark="square" label={t('Loading…')} />}
          {empty && !loading && !error && rows.length === 0 && <RailEmpty>{empty}</RailEmpty>}
          {rows.length > 0 && <ul className={railListClass} aria-label={title}>{onShowAll ? rows.slice(0, OVERVIEW_GROUP_ROWS) : rows}</ul>}
        </>
      )}
    </RailSection>
  );
}

/** A project's open issues, read from GitHub through Core; the newest few. */
export function OverviewIssues({ subject, onOpen, onShowAll, onNew }: {
  subject: CrmSubject;
  onOpen: (issue: CrmIssue) => void;
  onShowAll: () => void;
  onNew: () => void;
}) {
  const [issues, setIssues] = useState<CrmIssue[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    let cancelled = false;
    setLoaded(false); setError('');
    const query = new URLSearchParams({ project_id: subject.id, state: 'open', sort: 'updated', direction: 'desc', page: '1' });
    void apiFetch<CrmIssuesResponse>(`/crm/issues?${query}`, { noStore: true, fallbackError: t('Couldn’t load issues.') })
      .then((result) => { if (!cancelled) setIssues(result.issues); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t reach GitHub.')); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [subject.id]);
  useEffect(() => load(), [load]);
  return (
    <OverviewGroup
      subject={subject}
      group="issues"
      title={t('Issues')}
      loading={!loaded}
      error={error}
      onRetry={() => { void load(); }}
      onShowAll={onShowAll}
      onNew={onNew}
      newLabel={t('New issue')}
      rows={issues.map((issue) => <IssueRow key={issue.id} issue={issue} metadata={issueMeta(issue)} onOpen={() => onOpen(issue)} />)}
    />
  );
}

/**
 * The people on a subject: an organization's contacts,
 * or the contacts a project or lead names in its detail. `contactIDs` is null
 * until that detail has loaded. The group draws empty too, so a person sees
 * there is no one yet.
 */
export function OverviewContacts({ subject, contactIDs, detailError = '', version = 0, onOpen }: {
  subject: CrmSubject;
  contactIDs: readonly string[] | null;
  detailError?: string;
  version?: number;
  onOpen: (contactID: string) => void;
}) {
  const byOrganization = subject.kind === 'organization';
  const idsKey = contactIDs ? contactIDs.join(',') : null;
  const [contacts, setContacts] = useState<CrmContact[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const load = useCallback(() => {
    const ticket = ++request.current;
    setError('');
    if (!byOrganization && idsKey === null) { setLoaded(false); return; }
    setLoaded(false);
    const ids = idsKey ? idsKey.split(',') : [];
    const read = byOrganization ? searchContacts({ organizationId: subject.id, limit: 50 }) : contactsByID(ids);
    void read
      .then((result) => { if (ticket === request.current) setContacts(result); })
      .catch((cause: unknown) => { if (ticket === request.current) setError(cause instanceof Error ? cause.message : t('Couldn’t load contacts.')); })
      .finally(() => { if (ticket === request.current) setLoaded(true); });
  }, [byOrganization, subject.id, idsKey]);
  useEffect(() => {
    load();
    return () => { request.current += 1; };
  }, [load, version]);
  const shownError = error || (!byOrganization && idsKey === null ? detailError : '');
  return (
    <OverviewGroup
      subject={subject}
      group="contacts"
      title={t('Contacts')}
      loading={!loaded && !shownError}
      error={shownError}
      onRetry={error ? load : undefined}
      empty={t('No contacts.')}
      rows={contacts.map((contact) => (
        <RailRow
          key={contact.id}
          title={contactDisplayName(contact)}
          subtitle={(byOrganization ? [contact.title] : [contact.title, contact.organization_name]).filter(Boolean).join(' · ') || undefined}
          onSelect={() => onOpen(contact.id)}
        />
      ))}
    />
  );
}

/**
 * A lead's or an organization's offers and licences: one read of
 * `/crm/subjects/:kind/:id/commercial` for both groups, so they share one
 * wait, one error and one Retry. `kind` null reads nothing (another kind, or
 * both work modules off). A response for a subject that is no longer the one
 * asked for is dropped.
 */
export interface SubjectCommercial {
  /** The answer for this subject; null until it has loaded. */
  response: CrmSubjectCommercialResponse | null;
  loading: boolean;
  error: string;
  retry: () => void;
}

export function useSubjectCommercial(kind: 'lead' | 'organization' | null, id: string | null): SubjectCommercial {
  const key = kind && id ? `${kind}:${id}` : null;
  const [state, setState] = useState<{ key: string | null; response: CrmSubjectCommercialResponse | null; loaded: boolean; error: string }>({ key: null, response: null, loaded: false, error: '' });
  const request = useRef(0);
  const load = useCallback(() => {
    const ticket = ++request.current;
    setState({ key, response: null, loaded: false, error: '' });
    if (!kind || !id) return;
    void apiFetch<CrmSubjectCommercialResponse>(`/crm/subjects/${kind}/${encodeURIComponent(id)}/commercial`, { noStore: true, fallbackError: t('Couldn’t load offers and licenses.') })
      .then((response) => { if (ticket === request.current) setState({ key, response, loaded: true, error: '' }); })
      .catch((cause: unknown) => { if (ticket === request.current) setState({ key, response: null, loaded: true, error: cause instanceof Error ? cause.message : t('Couldn’t load offers and licenses.') }); });
  }, [key, kind, id]);
  useEffect(() => {
    load();
    return () => { request.current += 1; };
  }, [load]);
  const current = state.key === key;
  return {
    response: current ? state.response : null,
    loading: !current || !state.loaded,
    error: current ? state.error : '',
    retry: load,
  };
}

/** The offer's status from the shared table; a value it does not hold reads capitalised. */
function offerStatusLabel(status: string): string {
  const label = OFFER_STATUS_LABELS[status as OfferStatus];
  if (label) return t(label);
  const words = status.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatMoney(value: number, currency: string | null): string {
  if (!currency) return new Intl.NumberFormat(uiLocale).format(value);
  try {
    return new Intl.NumberFormat(uiLocale, { style: 'currency', currency }).format(value);
  } catch {
    // A code Intl does not know: the figure and the code as Core sent it.
    return `${new Intl.NumberFormat(uiLocale).format(value)} ${currency}`;
  }
}

/** Days a licence’s renewal stands out before it comes; a passed renewal stands out too, as on Mac, iPhone and Android. */
const RENEWAL_SOON_DAYS = 30;

function renewsSoon(license: CrmLicense, now: Date = new Date()): boolean {
  if (!license.is_active) return false;
  const renewal = parseDay(license.renewal_date);
  if (!renewal) return false;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((renewal.getTime() - today.getTime()) / 86_400_000);
  return days <= RENEWAL_SOON_DAYS;
}

/** An offer's total in its currency, or null when Core holds none. Overview and the INBOX `commercial` row. */
export function offerAmount(offer: CrmOffer): string | null {
  return offer.total_amount !== null ? formatMoney(offer.total_amount, offer.currency) : null;
}

/** A licence's amount in euros, or null when Core holds none. Overview and the INBOX `commercial` row. */
export function licenseAmount(license: CrmLicense): string | null {
  return license.amount_eur !== null ? formatMoney(license.amount_eur, 'EUR') : null;
}

/** An offer row's line: status, unsent changes, amount and date. */
export function offerRowText(offer: CrmOffer): string {
  return [
    offer.status ? offerStatusLabel(offer.status) : null,
    offer.has_unsent_changes ? t('Unsent changes') : null,
    offerAmount(offer),
    offer.valid_until && formatDay(offer.valid_until) ? t('Valid until {date}', { date: formatDay(offer.valid_until) }) : null,
  ].filter(Boolean).join(' · ');
}

function offerRow(offer: CrmOffer, onOpen?: (id: string) => void) {
  const subtitle = offerRowText(offer);
  return <RailRow key={offer.id} title={offer.title || t('Untitled offer')} subtitle={subtitle || undefined} {...(onOpen ? { onSelect: () => onOpen(offer.id) } : {})} />;
}

/** A licence row's line: seats, amount, renewal, and Inactive when it is. */
export function licenseRowText(license: CrmLicense): string {
  return [
    license.seats !== null ? plural(license.seats, { one: '{count} seat', other: '{count} seats' }) : null,
    licenseAmount(license),
    license.renewal_date && formatDay(license.renewal_date) ? t('Renews {date}', { date: formatDay(license.renewal_date) }) : null,
    license.is_active ? null : t('Inactive'),
  ].filter(Boolean).join(' · ');
}

function licenseRow(license: CrmLicense, active: boolean, onOpen?: (id: string) => void) {
  const title = license.product ? [licenseProductLabel(license.product), license.plan_type].filter(Boolean).join(' · ') : t('License');
  const subtitle = licenseRowText(license);
  // Attention is neutral ink at bold weight, never a hue (docs/DESIGN.md, the colour budget).
  return (
    <RailRow
      key={license.id}
      title={title}
      subtitle={subtitle ? (renewsSoon(license) ? <span className="font-bold text-foreground">{subtitle}</span> : subtitle) : undefined}
      active={active}
      {...(onOpen ? { onSelect: () => onOpen(license.id) } : {})}
    />
  );
}

/**
 * A lead's or an organization's offers, newest first. Hidden when the module is
 * off. While another store holds the commercial group the rows are read only
 * and there is no way to a new one.
 */
export function OverviewOffers({ subject, commercial }: { subject: CrmSubject; commercial: SubjectCommercial }) {
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  if (commercial.response && commercial.response.offers === null) return null;
  const editable = !workspaceCoreGroups().has('commercial');
  const create = () => {
    if (creating) return;
    setCreating(true);
    setCreateError('');
    const fallbackError = t('Couldn’t create the offer.');
    void apiFetch<OfferResponse>('/crm/offers', {
      method: 'POST',
      body: { [subject.kind === 'lead' ? 'lead_id' : 'organization_id']: subject.id },
      fallbackError,
      noStore: true,
    }).then((answer) => navigate(`/work/offers/${answer.offer.id}`))
      .catch((cause: unknown) => setCreateError(cause instanceof Error ? cause.message : fallbackError))
      .finally(() => setCreating(false));
  };
  return (
    <OverviewGroup
      subject={subject}
      group="offers"
      title={t('Offers')}
      loading={commercial.loading}
      error={commercial.error || createError}
      onRetry={commercial.retry}
      empty={t('No offers.')}
      {...(editable ? { onNew: create, newLabel: t('New offer') } : {})}
      lead={editable && subject.kind === 'organization' && !workspaceCoreGroups().has('subjects') ? <PartnerDiscountRow organizationId={subject.id} /> : undefined}
      rows={(commercial.response?.offers ?? []).map((offer) => offerRow(offer, editable ? (id) => navigate(`/work/offers/${id}`) : undefined))}
    />
  );
}

/** An organization's standing discount: a new offer on it starts with this. */
function PartnerDiscountRow({ organizationId }: { organizationId: string }) {
  const [saved, setSaved] = useState<OrganizationDiscountResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    const fallbackError = t('Couldn’t load the partner discount.');
    setError('');
    void apiFetch<OrganizationDiscountResponse>(`/crm/organizations/${organizationId}/default-discount`, { fallbackError, noStore: true })
      .then((answer) => { if (current) setSaved(answer); })
      .catch((cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : fallbackError); });
    return () => { current = false; };
  }, [organizationId]);
  const percent = saved?.default_discount_percentage ?? null;
  const value = draft.trim() === '' ? null : Number(draft);
  const valid = value === null || (Number.isFinite(value) && value >= 0 && value <= 100);
  const save = () => {
    const fallbackError = t('Couldn’t save the partner discount.');
    setBusy(true);
    setError('');
    void apiFetch<OrganizationDiscountResponse>(`/crm/organizations/${organizationId}/default-discount`, {
      method: 'PATCH',
      body: { default_discount_percentage: value },
      fallbackError,
      noStore: true,
    }).then((answer) => {
      setSaved(answer);
      setEditing(false);
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : fallbackError))
      .finally(() => setBusy(false));
  };
  return (
    <li className="grid gap-1.5 px-2 py-1 text-[13px]">
      <div className="flex items-center justify-between gap-2">
        <span>{t('Partner discount')}</span>
        {editing ? (
          <span className="flex items-center gap-1.5">
            <Input className="h-7 w-16" type="number" inputMode="decimal" min={0} max={100} value={draft} disabled={busy} aria-label={t('Partner discount, %')} onChange={(event) => setDraft(event.target.value)} />
            <Button type="button" size="xs" variant="secondary" disabled={busy || !valid} onClick={save}>{t('Save')}</Button>
            <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>{t('Cancel')}</Button>
          </span>
        ) : (
          <Button type="button" size="xs" variant="ghost" disabled={!saved} onClick={() => { setDraft(percent === null ? '' : String(percent)); setEditing(true); }}>{percent === null ? t('None') : `${percent}%`}</Button>
        )}
      </div>
      {error && <ErrorNotice message={error} copyText={error} />}
    </li>
  );
}

/**
 * A lead's or an organization's licences, newest first. Hidden when the module is
 * off. A row opens its editor in place, and New opens an empty one. While another
 * store holds the commercial group the rows only read.
 */
export function OverviewLicenses({ subject, commercial }: { subject: CrmSubject; commercial: SubjectCommercial }) {
  const [open, setOpen] = useState<string | null>(null);
  if (commercial.response && commercial.response.licenses === null) return null;
  const editable = !workspaceCoreGroups().has('commercial') && (subject.kind === 'lead' || subject.kind === 'organization');
  const licenses = commercial.response?.licenses ?? [];
  const chosen = open && open !== 'new' ? licenses.find((license) => license.id === open) : undefined;
  const saved = () => {
    setOpen(null);
    commercial.retry();
  };
  return (
    <>
      <OverviewGroup
        subject={subject}
        group="licenses"
        title={t('Licenses')}
        loading={commercial.loading}
        error={commercial.error}
        onRetry={commercial.retry}
        empty={t('No licenses.')}
        {...(editable ? { onNew: () => setOpen('new'), newLabel: t('New license') } : {})}
        rows={licenses.map((license) => licenseRow(license, open === license.id, editable ? setOpen : undefined))}
      />
      {open === 'new' && (
        <div className="mt-2">
          <LicenseForm key="new" subject={{ kind: subject.kind as 'lead' | 'organization', id: subject.id }} onSaved={saved} onCancel={() => setOpen(null)} />
        </div>
      )}
      {chosen && (
        <div className="mt-2">
          <LicenseForm key={chosen.id} license={chosen} onSaved={saved} onCancel={() => setOpen(null)} />
        </div>
      )}
    </>
  );
}

/** The documents filed about a subject; a row opens in Docs, beside the subject's own list. */
export function OverviewDocuments({ subject, onShowAll, onNew }: {
  subject: CrmSubject;
  onShowAll: () => void;
  onNew?: () => void;
}) {
  const selection = { kind: 'subject', subjectKind: subject.kind, subjectID: subject.id, title: subject.title } as const;
  const [documents, setDocuments] = useState<DocsDocumentSummary[]>(() => loadSnapshot<DocsDocumentSummary[]>(documentsSnapshotKey(selection))?.value ?? []);
  const [loaded, setLoaded] = useState(documents.length > 0);
  const [error, setError] = useState('');
  const [configured, setConfigured] = useState(true);
  const load = useCallback(() => {
    let cancelled = false;
    setError('');
    void fetchDocsDocuments({ kind: 'subject', subjectKind: subject.kind, subjectID: subject.id, title: subject.title })
      .then((result) => { if (!cancelled) setDocuments(result); })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof ControlRequestError && cause.code === 'not_configured') setConfigured(false);
        else setError(cause instanceof Error ? cause.message : t('Couldn’t load documents.'));
      })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [subject.kind, subject.id, subject.title]);
  useEffect(() => load(), [load]);
  if (!configured) return null;
  const view = `subject:${subject.kind}:${subject.id}`;
  return (
    <OverviewGroup
      subject={subject}
      group="documents"
      title={t('Documents')}
      loading={!loaded}
      error={error}
      onRetry={() => { void load(); }}
      onShowAll={onShowAll}
      onNew={onNew}
      newLabel={t('New document')}
      rows={documents.map((document) => (
        <RailRow
          key={document.id}
          leading={<GlyphMark shape="square"><NoteIcon /></GlyphMark>}
          title={document.title}
          subtitle={rowDatesLabel(document)}
          onSelect={() => navigate(`/docs?view=${encodeURIComponent(view)}&doc=${encodeURIComponent(document.id)}`)}
        />
      ))}
    />
  );
}

/**
 * The form answers that filed a lead (docs/FORMS.md): every question in the
 * form's order, in the words the person saw. A lead a member made has none,
 * and the group draws nothing.
 */
export function OverviewSubmission({ subject }: { subject: CrmSubject }) {
  const [submission, setSubmission] = useState<FormSubmission | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    let cancelled = false;
    setLoaded(false); setError('');
    void apiFetch<SubjectSubmissionResponse>(`/crm/subjects/lead/${encodeURIComponent(subject.id)}/submission`, { noStore: true, fallbackError: t('Couldn’t load the answers.') })
      .then((result) => { if (!cancelled) setSubmission(result.submission); })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t load the answers.')); })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [subject.id]);
  useEffect(() => load(), [load]);
  if (!loaded || (!submission && !error)) return null;
  return (
    <OverviewGroup
      subject={subject}
      group="submission"
      title={submission?.title ?? t('Answers')}
      rows={[]}
      error={error}
      onRetry={() => { void load(); }}
    >
      {error ? undefined : submission && (
        <div className="mx-2.5 mb-2 text-[13px]">
          <p className="mt-0 mb-2 text-muted-foreground">{t('Sent {day}', { day: dayTitle(Date.parse(submission.submitted_at)) })}</p>
          {submission.sections.map((section) => (
            <section key={section.title} className="mb-3" aria-label={section.title}>
              <h3 className="m-0 mb-1 text-xs font-medium text-muted-foreground">{section.title}</h3>
              <dl className="m-0 grid gap-1.5">
                {section.answers.map((item) => (
                  <div key={item.question}>
                    <dt className="text-muted-foreground">{item.question}</dt>
                    <dd className="m-0 whitespace-pre-line">{item.answer}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}
    </OverviewGroup>
  );
}
