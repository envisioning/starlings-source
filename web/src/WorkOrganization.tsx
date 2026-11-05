import { useCallback, useState } from 'react';
import type { CrmOrganizationUpdate } from '@starlings/contracts';
import { normalizeFormURL } from '@starlings/contracts/form-fields';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { ErrorNotice } from './ErrorNotice';
import { SearchablePicker } from './SearchablePicker';
import type { SearchablePickerOption } from './searchable-picker';
import { confirmDataLoss } from './ConfirmDataLoss';
import { SheetActions, SheetCard, SheetField } from './work-parts';
import { mergeCrmOrganizations, searchCrmOrganizations, updateCrmOrganization, type CrmSubjectDetail } from './crm-work';
import { t } from './i18n';

/*
 * Edit an organization in Work: the fields the the Core host
 * form edits most, on the subjects group's store. `PATCH
 * /api/crm/subjects/organization/:id` writes Core while the group is there
 * and D1 once it has moved. The rest of Core's columns are on the Fields pane.
 */

type TextField = 'url' | 'industry' | 'legal_name' | 'city' | 'country' | 'linkedin_url' | 'domain' | 'notes';
type FlagField = 'is_partner' | 'is_agency' | 'is_existing_client';

const TEXT_FIELDS: ReadonlyArray<{ id: TextField; label: () => string; url?: boolean; long?: boolean }> = [
  { id: 'url', label: () => t('Website'), url: true },
  { id: 'industry', label: () => t('Industry') },
  { id: 'legal_name', label: () => t('Legal name') },
  { id: 'city', label: () => t('City') },
  { id: 'country', label: () => t('Country') },
  { id: 'linkedin_url', label: () => t('LinkedIn'), url: true },
  { id: 'domain', label: () => t('Domain') },
  { id: 'notes', label: () => t('Notes'), long: true },
];

const FLAG_FIELDS: ReadonlyArray<{ id: FlagField; label: () => string }> = [
  { id: 'is_partner', label: () => t('Partner') },
  { id: 'is_agency', label: () => t('Agency') },
  { id: 'is_existing_client', label: () => t('Existing client') },
];

type Draft = { name: string } & Record<TextField, string> & Record<FlagField, boolean>;

function draftOf(detail: CrmSubjectDetail): Draft {
  const text = (value: string | null | undefined) => value ?? '';
  return {
    name: detail.title,
    url: text(detail.url),
    industry: text(detail.industry),
    legal_name: text(detail.legal_name),
    city: text(detail.city),
    country: text(detail.country),
    linkedin_url: text(detail.linkedin_url),
    domain: text(detail.domain),
    notes: text(detail.notes),
    is_partner: detail.is_partner === true,
    is_agency: detail.is_agency === true,
    is_existing_client: detail.is_existing_client === true,
  };
}

/** The fields the editor changed: a blank text clears, a name is never blanked. */
export function organizationPatch(before: Draft, after: Draft): CrmOrganizationUpdate {
  const patch: CrmOrganizationUpdate = {};
  if (after.name.trim() && after.name.trim() !== before.name.trim()) patch.name = after.name.trim();
  for (const field of TEXT_FIELDS) {
    if (after[field.id].trim() === before[field.id].trim()) continue;
    const value = field.url ? normalizeFormURL(after[field.id]) : after[field.id].trim();
    patch[field.id] = value || null;
  }
  for (const field of FLAG_FIELDS) {
    if (after[field.id] !== before[field.id]) patch[field.id] = after[field.id];
  }
  return patch;
}

export function OrganizationEditor({ detail, onCancel, onSaved }: {
  detail: CrmSubjectDetail;
  onCancel: () => void;
  onSaved: (detail: CrmSubjectDetail) => void;
}) {
  const [initial] = useState(() => draftOf(detail));
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canSave = draft.name.trim() !== '' && !busy;
  return (
    <section className="mt-2" aria-label={t('Edit organization')}>
      <SheetCard
        title={t('Edit organization')}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave) return;
          const patch = organizationPatch(initial, draft);
          if (Object.keys(patch).length === 0) { onCancel(); return; }
          setBusy(true);
          setError('');
          void updateCrmOrganization(detail.id, patch)
            .then(onSaved)
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t('Couldn’t save that organization.')))
            .finally(() => setBusy(false));
        }}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onCancel(); } }}
      >
        <SheetField label={`${t('Name')} *`}>
          <Input value={draft.name} autoFocus maxLength={200} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </SheetField>
        {TEXT_FIELDS.map((field) => (
          <SheetField key={field.id} label={field.label()}>
            {field.long
              ? <Textarea rows={3} value={draft[field.id]} onChange={(event) => setDraft({ ...draft, [field.id]: event.target.value })} />
              : <Input value={draft[field.id]} onChange={(event) => setDraft({ ...draft, [field.id]: event.target.value })} />}
          </SheetField>
        ))}
        <div className="flex flex-wrap gap-4">
          {FLAG_FIELDS.map((field) => (
            <Label key={field.id} className="flex items-center gap-2 text-xs font-normal">
              <Checkbox checked={draft[field.id]} onCheckedChange={(checked) => setDraft({ ...draft, [field.id]: checked === true })} />
              {field.label()}
            </Label>
          ))}
        </div>
        {error && <ErrorNotice message={error} copyText={error} />}
        <SheetActions>
          <Button type="button" variant="secondary" onClick={onCancel}>{t('Cancel')}</Button>
          <Button type="submit" disabled={!canSave}>{t('Save')}</Button>
        </SheetActions>
      </SheetCard>
    </section>
  );
}

/**
 * Merge a duplicate into this organization, as the Core host
 * does. The older of the two stays, whichever is open: the Worker answers
 * which one, and the page opens it.
 */
export function OrganizationMerger({ detail, onCancel, onMerged }: {
  detail: CrmSubjectDetail;
  onCancel: () => void;
  onMerged: (kept: { id: string; title: string }, merged: string[]) => void;
}) {
  const [options, setOptions] = useState<SearchablePickerOption[]>([]);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const search = useCallback(async (query: string) => {
    const matches = (await searchCrmOrganizations(query))
      .filter(({ id }) => id !== detail.id)
      .map(({ id, name }) => ({ id, title: name }));
    setOptions((current) => {
      const byID = new Map(current.map((option) => [option.id, option]));
      for (const option of matches) byID.set(option.id, option);
      return [...byID.values()];
    });
    return matches;
  }, [detail.id]);
  const otherName = options.find((option) => option.id === other)?.title ?? '';
  return (
    <section className="mt-2" aria-label={t('Merge organization')}>
      <SheetCard
        title={t('Merge organization')}
        onSubmit={(event) => {
          event.preventDefault();
          if (!other || busy) return;
          void (async () => {
            if (!await confirmDataLoss({
              title: t('Merge “{name}” and “{other}”?', { name: detail.title, other: otherName }),
              body: t('The older one keeps every link, and the other is deleted for good.'),
              action: t('Merge'),
            })) return;
            setBusy(true);
            setError('');
            try {
              const { kept, merged } = (await mergeCrmOrganizations([detail.id, other])).data;
              onMerged({ id: kept, title: kept === detail.id ? detail.title : otherName }, merged);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : t('Couldn’t merge those organizations.'));
            } finally {
              setBusy(false);
            }
          })();
        }}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onCancel(); } }}
      >
        <SearchablePicker
          label={t('Duplicate')}
          placeholder={t('Search organizations')}
          options={options}
          value={other}
          onChange={setOther}
          emptyMessage={t('No organizations match.')}
          onSearch={search}
        />
        {error && <ErrorNotice message={error} copyText={error} />}
        <SheetActions>
          <Button type="button" variant="secondary" onClick={onCancel}>{t('Cancel')}</Button>
          <Button type="submit" disabled={!other || busy}>{t('Merge')}</Button>
        </SheetActions>
      </SheetCard>
    </section>
  );
}
