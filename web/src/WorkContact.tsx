import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { SIGNALS_OUTREACH_STATUSES, type CrmContact, type CrmContactDetail, type CrmInteraction, type CrmSubject } from '@starlings/contracts';
import { missingFormField } from '@starlings/contracts/form-fields';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { Checkbox } from '@/ui/checkbox';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { PlaceholderRows } from '@/ui/placeholder-rows';
import { ErrorNotice } from './ErrorNotice';
import { confirmDataLoss } from './ConfirmDataLoss';
import { SearchablePicker } from './SearchablePicker';
import type { SearchablePickerOption } from './searchable-picker';
import { RailRow, RailSection } from './SurfaceShell';
import { railListClass } from './rail-list';
import { DetailHead, SheetActions, SheetCard, SheetField, detailTitleClass, fieldCaption, fieldProps } from './work-parts';
import { createCrmOrganization, searchCrmOrganizations } from './crm-work';
import {
  characteristicLabel,
  characteristicNames,
  contactDisplayName,
  contactProfile,
  contactProfileProblem,
  contactsByID,
  createContact,
  deleteContact,
  fetchContact,
  fetchContactOptions,
  mergeContacts,
  searchContacts,
  updateContact,
  type ContactDraft,
  type ContactProfile, outreachLabel } from './contacts';
import { dateLocale, plural, t } from './i18n';
import { formatBirthday, monthNames } from './meeting-time';
import { cn } from '@/lib/utils';

/**
 * A contact's page in Work (docs/RELATIONSHIPS.md slice 2): who
 * they are and where, their addresses, the projects and leads they are on,
 * the calls they were in and the members who met them. It reads in Work's
 * column at `/work/contact/<id>`, as an issue does.
 */
export function ContactDetail({ id, onOpenSubject, renderCall, onClose, onChanged, onMerged, onDeleted }: {
  id: string;
  /**
   * The id was merged into another contact, or the member merged
   * a duplicate here: open the survivor by its own id.
   */
  onMerged?: (survivorID: string) => void;
  onOpenSubject: (subject: CrmSubject) => void;
  /** A call as Work's History draws it, so a call reads the same everywhere. */
  renderCall: (interaction: CrmInteraction) => ReactNode;
  onClose: () => void;
  onChanged?: (contact: CrmContactDetail) => void;
  /** The member deleted the contact. */
  onDeleted?: (id: string) => void;
}) {
  const [contact, setContact] = useState<CrmContactDetail | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [actionError, setActionError] = useState('');

  const load = useCallback(() => {
    let cancelled = false;
    setError('');
    fetchContact(id)
      .then((found) => {
        if (cancelled) return;
        setContact(found);
        if (found.merged_from && found.id !== id) onMerged?.(found.id);
      })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t load that contact.')); });
    return () => { cancelled = true; };
    // `onMerged` is a callback for one answer; a new one is not a reason to read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => load(), [load]);

  if (editing && contact) {
    return (
      <ContactEditor
        contact={contact}
        onCancel={() => setEditing(false)}
        onSaved={(saved) => { setContact(saved); setEditing(false); onChanged?.(saved); }}
      />
    );
  }
  if (merging && contact) {
    return (
      <ContactMerger
        contact={contact}
        onCancel={() => setMerging(false)}
        onMerged={(kept) => { setMerging(false); onMerged?.(kept); }}
      />
    );
  }

  /** Delete: asks first. The Worker refuses while a call or a task references the contact, and says which. */
  const remove = async () => {
    if (!contact) return;
    if (!await confirmDataLoss({
      title: t('Delete “{name}”?', { name: contactDisplayName(contact) }),
      body: t('Its leads and projects stay. This can’t be undone.'),
      action: t('Delete'),
    })) return;
    setActionError('');
    try {
      await deleteContact(contact.id);
      onDeleted?.(contact.id);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t('Couldn’t delete that contact.'));
    }
  };

  const name = contact ? contactDisplayName(contact) : t('Contact');
  const subjectRows = (rows: CrmContactDetail['projects'], kind: 'project' | 'lead') => rows.map((row) => {
    const target: CrmSubject = { id: row.id, kind, title: row.title?.trim() || t('Untitled'), subtitle: row.status };
    return <RailRow key={`${kind}:${row.id}`} title={target.title} subtitle={row.status ?? undefined} onSelect={() => onOpenSubject(target)} />;
  });

  return (
    <div>
      <DetailHead>
        <h2 className={cn(detailTitleClass, 'min-w-0 truncate')}>{name}</h2>
        <div className="flex flex-none items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>{t('← Back')}</Button>
          <Button type="button" variant="outline" size="sm" disabled={!contact} onClick={() => setEditing(true)}>{t('Edit')}</Button>
          <Button type="button" variant="outline" size="sm" disabled={!contact} onClick={() => setMerging(true)}>{t('Merge…')}</Button>
          <Button type="button" variant="ghost" size="sm" className="text-destructive" disabled={!contact} onClick={() => { void remove(); }}>{t('Delete')}</Button>
        </div>
      </DetailHead>
      {error && <ErrorNotice message={error} copyText={error} action={<Button type="button" variant="outline" size="xs" onClick={load}>{t('Retry')}</Button>} />}
      {actionError && <ErrorNotice message={actionError} copyText={actionError} />}
      {!contact && !error && <PlaceholderRows glyph={false} label={t('Loading contact…')} />}
      {contact && (
        <>
          {(contact.title || contact.organization_id) && (
            <p className="mt-1.5 mb-3 text-[15px] text-muted-foreground">
              {contact.title}
              {contact.title && contact.organization_id ? ' · ' : null}
              {contact.organization_id && (
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-[15px] text-foreground"
                  onClick={() => onOpenSubject({ id: contact.organization_id!, kind: 'organization', title: contact.organization_name ?? t('Organization'), subtitle: null })}
                >
                  {contact.organization_name ?? t('Organization')}
                </Button>
              )}
            </p>
          )}
          <ContactProfileRows contact={contact} />
          <RailSection title={t('Addresses')} storageKey="work.contact.addresses" count={contact.emails.length} empty={t('No addresses.')}>
            <ul className={railListClass} aria-label={t('Addresses')}>
              {contact.emails.map((email, index) => (
                <RailRow key={email} title={email} subtitle={index === 0 && contact.emails.length > 1 ? t('Primary') : undefined} onSelect={() => { window.location.href = `mailto:${email}`; }} />
              ))}
            </ul>
          </RailSection>
          <RailSection title={t('Projects')} storageKey="work.contact.projects" count={contact.projects.length} empty={t('On no project.')}>
            <ul className={railListClass} aria-label={t('Projects')}>{subjectRows(contact.projects, 'project')}</ul>
          </RailSection>
          <RailSection title={t('Leads')} storageKey="work.contact.leads" count={contact.leads.length} empty={t('On no lead.')}>
            <ul className={railListClass} aria-label={t('Leads')}>{subjectRows(contact.leads, 'lead')}</ul>
          </RailSection>
          <RailSection title={t('Calls')} storageKey="work.contact.calls" count={contact.interactions.length} empty={t('No calls yet.')}>
            <ul className={railListClass} aria-label={t('Calls')}>{contact.interactions.map(renderCall)}</ul>
          </RailSection>
          <RailSection title={t('Met by')} storageKey="work.contact.met-by" count={contact.met_by.length} hidesWhenEmpty>
            <ul className={railListClass} aria-label={t('Met by')}>
              {contact.met_by.map((member) => (
                <RailRow
                  key={member.email}
                  title={member.name || member.email}
                  subtitle={plural(member.calls, { one: '{count} call', other: '{count} calls' })}
                />
              ))}
            </ul>
          </RailSection>
        </>
      )}
    </div>
  );
}

/**
 * Add a contact, or edit one: name, title, organization and addresses, one
 * per line, the primary first. Adding from an organization's page fixes the
 * organization.
 */
export function ContactEditor({ contact, organization, onCancel, onSaved }: {
  contact: CrmContactDetail | null;
  organization?: { id: string; name: string };
  onCancel: () => void;
  onSaved: (contact: CrmContactDetail) => void;
}) {
  const [draft, setDraft] = useState<ContactDraft>(() => ({
    name: contact?.name ?? '',
    title: contact?.title ?? '',
    organization_id: contact?.organization_id ?? organization?.id ?? '',
    emails: (contact?.emails ?? []).join('\n'),
    profile: contactProfile(contact),
    baseProfile: contact ? contactProfile(contact) : null,
  }));
  const [options, setOptions] = useState<{ characteristics: string[]; languages: string[] }>({ characteristics: [], languages: ['en', 'pt'] });
  useEffect(() => {
    let live = true;
    // Without the options the editor still edits what the contact carries.
    fetchContactOptions().then((found) => { if (live) setOptions(found); }).catch(() => {});
    return () => { live = false; };
  }, []);
  const [organizationOptions, setOrganizationOptions] = useState<SearchablePickerOption[]>(() => {
    const id = contact?.organization_id ?? organization?.id;
    const title = contact?.organization_name ?? organization?.name;
    return id ? [{ id, title: title ?? id }] : [];
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const searchOrganizations = useCallback(async (query: string) => {
    const matches = (await searchCrmOrganizations(query)).map(({ id, name }) => ({ id, title: name }));
    setOrganizationOptions((current) => {
      const byID = new Map(current.map((option) => [option.id, option]));
      for (const option of matches) byID.set(option.id, option);
      return [...byID.values()];
    });
    return matches;
  }, []);
  const createOrganizationOption = useCallback(async (name: string) => {
    const created = await createCrmOrganization(name);
    const option = { id: created.id, title: created.name };
    setOrganizationOptions((current) => [...current.filter((item) => item.id !== option.id), option]);
    return option;
  }, []);

  const profile = draft.profile ?? contactProfile(null);
  const setProfile = (next: Partial<ContactProfile>) => setDraft({ ...draft, profile: { ...profile, ...next } });
  const profileProblem = contactProfileProblem(profile);
  const canSave = !missingFormField('contact', { name: draft.name }) && !busy && !profileProblem;
  return (
    <section className="mt-2" aria-label={contact ? t('Edit contact') : t('Add contact')}>
      <SheetCard
        title={contact ? t('Edit contact') : t('Add contact')}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave) return;
          setBusy(true);
          setError('');
          void (contact ? updateContact(contact.id, draft) : createContact(draft))
            .then(onSaved)
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t('Couldn’t save that contact.')))
            .finally(() => setBusy(false));
        }}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onCancel(); } }}
      >
        <SheetField label={fieldCaption('contact', 'name')}>
          <Input value={draft.name} autoFocus {...fieldProps('contact', 'name')} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </SheetField>
        <SheetField label={fieldCaption('contact', 'title')}>
          <Input value={draft.title} {...fieldProps('contact', 'title')} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        </SheetField>
        <SearchablePicker
          label={fieldCaption('contact', 'organization')}
          placeholder={t('Search organizations')}
          options={organizationOptions}
          value={draft.organization_id}
          onChange={(organization_id) => setDraft({ ...draft, organization_id })}
          emptyMessage={t('No organizations match.')}
          onSearch={searchOrganizations}
          onCreate={createOrganizationOption}
        />
        <SheetField label={fieldCaption('contact', 'emails')}>
          <Textarea rows={3} value={draft.emails} placeholder="name@example.com" onChange={(event) => setDraft({ ...draft, emails: event.target.value })} />
        </SheetField>
        <ContactProfileFields profile={profile} options={options} onChange={setProfile} />
        {profileProblem && <ErrorNotice message={profileProblem} copyText={profileProblem} inline />}
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
 * The contacts on a project, or the one contact on a lead, in the subject
 * editor: typeahead over the workspace's contacts, never a list.
 */
export function SubjectContactsField({ multiple, value, onChange }: {
  multiple: boolean;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const [named, setNamed] = useState<Map<string, CrmContact>>(() => new Map());
  const [error, setError] = useState('');

  useEffect(() => {
    const missing = value.filter((id) => !named.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    contactsByID(missing)
      .then((found) => {
        if (cancelled) return;
        setNamed((current) => new Map([...current, ...found.map((contact) => [contact.id, contact] as const)]));
      })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : t('Couldn’t load contacts.')); });
    return () => { cancelled = true; };
    // `named` is the cache this effect fills; reading it is not a reason to run again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const option = (contact: CrmContact): SearchablePickerOption => ({
    id: contact.id,
    title: contactDisplayName(contact),
    subtitle: [contact.title, contact.organization_name].filter(Boolean).join(' · ') || null,
  });
  const search = useCallback(async (query: string) => {
    const found = await searchContacts({ q: query, limit: 20 });
    setNamed((current) => new Map([...current, ...found.map((contact) => [contact.id, contact] as const)]));
    return found.map(option);
  }, []);

  const chosen = value.map((id) => named.get(id)).map((contact, index) => contact ? option(contact) : { id: value[index]!, title: value[index]! });
  if (!multiple) {
    return (
      <SearchablePicker
        label={fieldCaption('lead', 'contact')}
        placeholder={t('Search contacts')}
        options={chosen}
        value={value[0] ?? ''}
        onChange={(id) => onChange(id ? [id] : [])}
        emptyMessage={t('No contacts match.')}
        onSearch={search}
      />
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <SearchablePicker
        label={fieldCaption('project', 'contacts')}
        placeholder={t('Add a contact')}
        options={chosen}
        value=""
        onChange={(id) => { if (id && !value.includes(id)) onChange([...value, id]); }}
        emptyMessage={t('No contacts match.')}
        onSearch={search}
      />
      {chosen.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label={t('Contacts')}>
          {chosen.map((contact) => (
            <li key={contact.id}>
              <Button type="button" variant="outline" size="xs" aria-label={t('Remove {name}', { name: contact.title })} onClick={() => onChange(value.filter((id) => id !== contact.id))}>
                {contact.title} ×
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && <ErrorNotice message={error} copyText={error} inline />}
    </div>
  );
}

function languageText(code: string): string {
  try {
    return new Intl.DisplayNames([dateLocale], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The fields added, as the page reads them. A row shows only when it has a value. */
function ContactProfileRows({ contact }: { contact: CrmContactDetail }) {
  const birthday = formatBirthday(contact.birthday_month, contact.birthday_day, contact.birthday_year);
  const language = contact.preferred_language?.trim();
  const status = contact.signals_outreach_status?.trim();
  const characteristics = Object.entries(contact.characteristics ?? {}).filter(([, on]) => on).map(([name]) => characteristicLabel(name));
  const rows = [
    birthday ? { label: t('Birthday'), value: birthday } : null,
    language ? { label: t('Language'), value: languageText(language) } : null,
    status ? { label: t('Signals status'), value: outreachLabel(status) } : null,
    characteristics.length > 0 ? { label: t('Characteristics'), value: characteristics.join(', ') } : null,
  ].filter((row): row is { label: string; value: string } => row !== null);
  return (
    <RailSection title={t('Details')} storageKey="work.contact.details" count={rows.length} hidesWhenEmpty>
      <ul className={railListClass} aria-label={t('Details')}>
        {rows.map((row) => <RailRow key={row.label} title={row.value} subtitle={row.label} />)}
      </ul>
    </RailSection>
  );
}

/** The editor's birthday, language, Signals status and characteristics. */
function ContactProfileFields({ profile, options, onChange }: {
  profile: ContactProfile;
  options: { characteristics: string[]; languages: string[] };
  onChange: (next: Partial<ContactProfile>) => void;
}) {
  const number = (value: string) => (value.trim() === '' ? null : Number.parseInt(value, 10));
  const languages = [...new Set([...options.languages, profile.preferred_language])];
  const names = characteristicNames(options.characteristics, profile.characteristics);
  return (
    <>
      <div className="grid grid-cols-[2fr_1fr_1fr] gap-2">
        <SheetField label={t('Birthday')}>
          <NativeSelect value={profile.birthday_month ?? ''} onChange={(event) => onChange({ birthday_month: number(event.target.value) })} aria-label={t('Birthday month')}>
            <NativeSelectOption value="">{t('None')}</NativeSelectOption>
            {monthNames().map((name, index) => <NativeSelectOption key={name} value={index + 1}>{name}</NativeSelectOption>)}
          </NativeSelect>
        </SheetField>
        <SheetField label={t('Day')}>
          <Input type="number" min={1} max={31} value={profile.birthday_day ?? ''} onChange={(event) => onChange({ birthday_day: number(event.target.value) })} />
        </SheetField>
        <SheetField label={t('Year')}>
          <Input type="number" min={1900} max={2100} value={profile.birthday_year ?? ''} onChange={(event) => onChange({ birthday_year: number(event.target.value) })} />
        </SheetField>
      </div>
      <SheetField label={t('Language')}>
        <NativeSelect value={profile.preferred_language} onChange={(event) => onChange({ preferred_language: event.target.value })}>
          {languages.map((code) => <NativeSelectOption key={code} value={code}>{languageText(code)}</NativeSelectOption>)}
        </NativeSelect>
      </SheetField>
      <SheetField label={t('Signals status')}>
        <NativeSelect value={profile.signals_outreach_status ?? ''} onChange={(event) => onChange({ signals_outreach_status: event.target.value || null })}>
          <NativeSelectOption value="">{t('None')}</NativeSelectOption>
          {profile.signals_outreach_status && !(SIGNALS_OUTREACH_STATUSES as readonly string[]).includes(profile.signals_outreach_status) && (
            <NativeSelectOption value={profile.signals_outreach_status}>{outreachLabel(profile.signals_outreach_status)}</NativeSelectOption>
          )}
          {SIGNALS_OUTREACH_STATUSES.map((status) => <NativeSelectOption key={status} value={status}>{outreachLabel(status)}</NativeSelectOption>)}
        </NativeSelect>
      </SheetField>
      {names.length > 0 && (
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1 text-xs text-muted-foreground">{t('Characteristics')}</legend>
          {names.map((name) => (
            <Label key={name} className="flex items-center gap-2 text-sm text-foreground font-normal leading-normal">
              <Checkbox
                checked={profile.characteristics[name] === true}
                onCheckedChange={(checked) => onChange({ characteristics: { ...profile.characteristics, [name]: checked === true } })}
              />
              {characteristicLabel(name)}
            </Label>
          ))}
        </fieldset>
      )}
    </>
  );
}

/**
 * Merge a duplicate into this contact, as the Core host
 * does. The older of the two stays, whichever is open: the Worker answers
 * which one, and the page opens it.
 */
function ContactMerger({ contact, onCancel, onMerged }: {
  contact: CrmContactDetail;
  onCancel: () => void;
  onMerged: (keptID: string) => void;
}) {
  const [options, setOptions] = useState<SearchablePickerOption[]>([]);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const search = useCallback(async (query: string) => {
    const matches = (await searchContacts({ q: query, limit: 20 }))
      .filter(({ id }) => id !== contact.id)
      .map((found) => ({
        id: found.id,
        title: contactDisplayName(found),
        subtitle: [found.email, found.organization_name].filter(Boolean).join(' · ') || null,
      }));
    setOptions((current) => {
      const byID = new Map(current.map((option) => [option.id, option]));
      for (const option of matches) byID.set(option.id, option);
      return [...byID.values()];
    });
    return matches;
  }, [contact.id]);
  const name = contactDisplayName(contact);
  const otherName = options.find((option) => option.id === other)?.title ?? '';
  return (
    <section className="mt-2" aria-label={t('Merge contact')}>
      <SheetCard
        title={t('Merge contact')}
        onSubmit={(event) => {
          event.preventDefault();
          if (!other || busy) return;
          void (async () => {
            if (!await confirmDataLoss({
              title: t('Merge “{name}” and “{other}”?', { name, other: otherName }),
              body: t('The older one keeps every link and address, and the other is deleted for good.'),
              action: t('Merge'),
            })) return;
            setBusy(true);
            setError('');
            try {
              onMerged((await mergeContacts([contact.id, other])).data.kept);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : t('Couldn’t merge those contacts.'));
            } finally {
              setBusy(false);
            }
          })();
        }}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onCancel(); } }}
      >
        <SearchablePicker
          label={t('Duplicate')}
          placeholder={t('Search contacts')}
          options={options}
          value={other}
          onChange={setOther}
          emptyMessage={t('No contacts match.')}
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
