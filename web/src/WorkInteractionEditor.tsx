import { useCallback, useEffect, useState } from 'react';
import { CRM_INTERACTION_MANUAL_TYPES } from '@starlings/contracts';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { ErrorNotice } from './ErrorNotice';
import { LocalDateTimeField } from './LocalDateTimeField';
import { SearchablePicker } from './SearchablePicker';
import type { SearchablePickerOption } from './searchable-picker';
import { SubjectContactsField } from './WorkContact';
import { SheetActions, SheetCard, SheetField, cancelOnEscape } from './work-parts';
import {
  fetchSubjectDetail,
  fetchSubjects,
  interactionDraftFor,
  interactionLinksFor,
  searchCrmOrganizations,
  subjectDisplayTitle,
  type CrmInteraction,
  type CrmSubject,
  type CrmSubjectDetail,
  type InteractionDraft,
} from './crm-work';
import { t } from './i18n';

/** A History row's type, in words. */
export function interactionTypeName(type: CrmInteraction['type']): string {
  switch (type) {
    case 'meeting': return t('Meeting');
    case 'email': return t('Email');
    case 'call': return t('Call');
    case 'web': return t('Web');
    case 'note': return t('Note');
  }
}

type LinkKind = 'organization' | 'lead' | 'project';
type LinkField = 'organization_id' | 'lead_id' | 'project_id';
const LINK_FIELD: Record<LinkKind, LinkField> = { organization: 'organization_id', lead: 'lead_id', project: 'project_id' };

/** The names the open subject already knows: itself, its organization, and an organization's projects and leads. */
function knownLinks(subject: CrmSubject, detail: CrmSubjectDetail | null): Record<LinkKind, SearchablePickerOption[]> {
  const known: Record<LinkKind, Map<string, SearchablePickerOption>> = { organization: new Map(), lead: new Map(), project: new Map() };
  const add = (kind: LinkKind, id: string | null | undefined, title: string | null | undefined) => {
    if (id && title?.trim() && !known[kind].has(id)) known[kind].set(id, { id, title: title.trim() });
  };
  if (subject.kind === 'organization' || subject.kind === 'lead' || subject.kind === 'project') add(subject.kind, subject.id, subjectDisplayTitle(subject));
  add('organization', subject.organization_id, subject.organization_name);
  if (detail?.id === subject.id) {
    add('organization', detail.organization_id, detail.organization_name);
    for (const project of detail.related?.projects ?? []) add('project', project.id, project.title);
    for (const lead of detail.related?.leads ?? []) add('lead', lead.id, lead.title);
  }
  return { organization: [...known.organization.values()], lead: [...known.lead.values()], project: [...known.project.values()] };
}

/**
 * Log, and Edit on the reader: a call, meeting or note filed on
 * an organization, a lead or a project, with the contacts who were there.
 * It reads in the History pane, where the row reads. `onSave` throws the
 * Worker's refusal; the sheet shows it and stays open.
 */
export function InteractionEditor({ interaction, subject, detail, onCancel, onSave }: {
  /** Null logs a new row. */
  interaction: CrmInteraction | null;
  subject: CrmSubject;
  detail: CrmSubjectDetail | null;
  onCancel: () => void;
  onSave: (draft: InteractionDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<InteractionDraft>(() => interactionDraftFor(interaction, interactionLinksFor(subject)));
  const [options, setOptions] = useState(() => knownLinks(subject, detail));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const remember = useCallback((kind: LinkKind, found: SearchablePickerOption[]) => {
    setOptions((current) => {
      const byID = new Map(current[kind].map((option) => [option.id, option]));
      for (const option of found) byID.set(option.id, option);
      return { ...current, [kind]: [...byID.values()] };
    });
  }, []);

  // A row filed somewhere this page has no name for: read the name once.
  useEffect(() => {
    let live = true;
    for (const kind of ['organization', 'lead', 'project'] as const) {
      const id = draft[LINK_FIELD[kind]];
      if (!id || options[kind].some((option) => option.id === id)) continue;
      void fetchSubjectDetail({ kind, id, title: '', subtitle: null })
        .then((found) => { if (live) remember(kind, [{ id, title: subjectDisplayTitle(found) }]); })
        .catch(() => undefined);
    }
    return () => { live = false; };
    // Only the links the row opened with; a pick comes with its name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const searchOrganizations = useCallback(async (query: string) => {
    const found = (await searchCrmOrganizations(query)).map(({ id, name }) => ({ id, title: name }));
    remember('organization', found);
    return found;
  }, [remember]);
  const searchLeads = useCallback(async (query: string) => {
    const found = (await fetchSubjects('lead', query, 'all')).subjects.map((row) => ({ id: row.id, title: subjectDisplayTitle(row), subtitle: row.organization_name ?? null }));
    remember('lead', found);
    return found;
  }, [remember]);
  const searchProjects = useCallback(async (query: string) => {
    const found = (await fetchSubjects('project', query, 'all')).subjects.map((row) => ({ id: row.id, title: subjectDisplayTitle(row), subtitle: row.organization_name ?? null }));
    remember('project', found);
    return found;
  }, [remember]);

  // An email or web row keeps its own type unless the edit names another.
  const types: CrmInteraction['type'][] = interaction && !(CRM_INTERACTION_MANUAL_TYPES as readonly string[]).includes(interaction.type)
    ? [interaction.type, ...CRM_INTERACTION_MANUAL_TYPES]
    : [...CRM_INTERACTION_MANUAL_TYPES];
  const filed = Boolean(draft.organization_id || draft.lead_id || draft.project_id);
  const canSave = draft.title.trim().length > 0 && Boolean(draft.occurred_at) && filed && !saving;
  const typeName = interactionTypeName(draft.type).toLowerCase();
  const none = { id: '', title: t('None') };

  return (
    <section className="mt-2" aria-label={interaction ? t('Edit {type}', { type: typeName }) : t('Log {type}', { type: typeName })}>
      <SheetCard
        title={interaction ? t('Edit {type}', { type: typeName }) : t('Log {type}', { type: typeName })}
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSave) return;
          setSaving(true);
          setError('');
          onSave(draft)
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t('Couldn’t save that.')))
            .finally(() => setSaving(false));
        }}
        onKeyDown={cancelOnEscape(onCancel)}
      >
        <SheetField label={t('Type')}>
          <NativeSelect value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as CrmInteraction['type'] })}>
            {types.map((type) => <NativeSelectOption key={type} value={type}>{interactionTypeName(type)}</NativeSelectOption>)}
          </NativeSelect>
        </SheetField>
        <SheetField label={t('Title')}>
          <Input value={draft.title} autoFocus maxLength={200} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        </SheetField>
        <LocalDateTimeField className="my-0" label={t('Date and time')} value={draft.occurred_at} onChange={(occurred_at) => setDraft({ ...draft, occurred_at })} />
        <SheetField label={t('Summary')}>
          <Textarea rows={5} maxLength={10_000} value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} />
        </SheetField>
        {/* Text, not type="url": a bare host is sent with https://, as the subject editor's URL is. */}
        <SheetField label={t('Link')}>
          <Input
            inputMode="url"
            autoCapitalize="off"
            spellCheck={false}
            value={draft.url}
            placeholder="https://…"
            onChange={(event) => setDraft({ ...draft, url: event.target.value })}
          />
        </SheetField>
        <SearchablePicker
          label={t('Organization')}
          placeholder={t('Search organizations')}
          options={[none, ...options.organization]}
          value={draft.organization_id}
          onChange={(organization_id) => setDraft({ ...draft, organization_id })}
          emptyMessage={t('No organizations match.')}
          onSearch={searchOrganizations}
        />
        <SearchablePicker
          label={t('Lead')}
          placeholder={t('Search leads')}
          options={[none, ...options.lead]}
          value={draft.lead_id}
          onChange={(lead_id) => setDraft({ ...draft, lead_id })}
          emptyMessage={t('No leads match.')}
          onSearch={searchLeads}
        />
        <SearchablePicker
          label={t('Project')}
          placeholder={t('Search projects')}
          options={[none, ...options.project]}
          value={draft.project_id}
          onChange={(project_id) => setDraft({ ...draft, project_id })}
          emptyMessage={t('No projects match.')}
          onSearch={searchProjects}
        />
        <SubjectContactsField multiple value={draft.contact_ids} onChange={(contact_ids) => setDraft({ ...draft, contact_ids })} />
        {!filed && <ErrorNotice inline message={t('Choose an organization, a lead or a project.')} />}
        {error && <ErrorNotice message={error} copyText={error} />}
        <SheetActions>
          <Button type="button" variant="secondary" onClick={onCancel}>{t('Cancel')}</Button>
          <Button type="submit" disabled={!canSave}>{t('Save')}</Button>
        </SheetActions>
      </SheetCard>
    </section>
  );
}
