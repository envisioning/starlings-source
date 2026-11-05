import { useState } from 'react';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import type { DocsSubject, GranolaFilingSuggestion, MeetingCategoryResponse, MeetingKind } from '@starlings/contracts';
import { createSubject, type SubjectKind } from './crm-work';
import { ErrorNotice } from './ErrorNotice';
import { LEDGER } from './SectionCard';
import { SubjectPicker } from './SubjectPicker';
import { MEETING_FILING_KINDS } from './subject-pickers';
import { MEETING_KIND_SPECS } from '@starlings/contracts/meeting-kinds';
import { t } from './i18n';

export const KIND_LABEL = Object.fromEntries(
  MEETING_KIND_SPECS.map((spec) => [spec.kind, t(spec.label)]),
) as Record<MeetingKind, string>;

export type FilingBody = {
  meeting_kind: MeetingKind;
  lead_id?: string | null;
  project_id?: string | null;
  event_id?: string | null;
  partner_organization_id?: string | null;
};

/** The kinds that take a subject, and which picker tab each opens. */
const SUBJECT_KIND: Partial<Record<MeetingKind, SubjectKind>> = Object.fromEntries(
  MEETING_KIND_SPECS.flatMap((spec) => (spec.subject ? [[spec.kind, spec.subject]] : [])),
);

/**
 * The body a suggestion files as, or null when confirming it is not one act:
 * a kind that takes a subject the model could not name needs the picker, and
 * a lead that does not exist yet needs creating. Those stay one row at a
 * time; this is what a batch may confirm unattended.
 */
export function suggestedBody(suggestion: GranolaFilingSuggestion): FilingBody | null {
  const subjectKind = SUBJECT_KIND[suggestion.meeting_kind];
  if (!subjectKind) return { meeting_kind: suggestion.meeting_kind };
  const id = subjectKind === 'lead' ? suggestion.lead_id
    : subjectKind === 'project' ? suggestion.project_id
      : subjectKind === 'event' ? suggestion.event_id
        : suggestion.partner_organization_id;
  return id ? bodyFor(subjectKind, id) : null;
}

/** A subject pick, as the body the category route takes. */
export function bodyFor(kind: SubjectKind, id: string): FilingBody {
  if (kind === 'lead') return { meeting_kind: 'lead', lead_id: id };
  if (kind === 'project') return { meeting_kind: 'project', project_id: id };
  if (kind === 'event') return { meeting_kind: 'event', event_id: id };
  return { meeting_kind: 'partner', partner_organization_id: id };
}

/**
 * The kind and subject of a row in the CRM, and the control that changes
 * them. The same control for a Granola note and a Mac recording; only the
 * route differs, and the caller passes it.
 *
 * A `suggestion` (docs/GRANOLA_BRIDGE.md §Suggested filing) draws one more
 * button while the row is unfiled: the model's answer, one tap to confirm.
 * A suggested lead or project with no matching subject opens the picker on
 * that kind instead — the model never names a subject Core does not list.
 */
export function Filing({ kind, subjectTitle, hasTranscript, title = null, suggestion = null, file: send, onFiled }: {
  kind: MeetingKind;
  subjectTitle: string | null;
  hasTranscript: boolean;
  /** The meeting's title, the name a lead created from it starts with. */
  title?: string | null;
  suggestion?: GranolaFilingSuggestion | null;
  file: (body: FilingBody) => Promise<MeetingCategoryResponse>;
  onFiled: (category: MeetingCategoryResponse) => void;
}) {
  const imported = { meeting_kind: kind, subject_title: subjectTitle, has_transcript: hasTranscript };
  const [picking, setPicking] = useState<SubjectKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function file(body: FilingBody) {
    setBusy(true);
    setError('');
    try {
      const category = await send(body);
      onFiled(category);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t file the meeting.'));
    } finally {
      setBusy(false);
      setPicking(null);
    }
  }

  function onPick(subject: DocsSubject) {
    const kind = subject.kind;
    if (kind === 'project' || kind === 'lead' || kind === 'organization' || kind === 'event') void file(bodyFor(kind, subject.subject_id));
  }

  /**
   * The suggested lead does not exist: make it, on the organization Core
   * drew from the guests, named after the meeting, then file. One tap where
   * the picker had nothing to offer.
   */
  async function createLeadAndFile() {
    if (!suggestion?.organization_id) return;
    setBusy(true);
    setError('');
    try {
      const lead = await createSubject({
        kind: 'lead',
        title: (title ?? '').trim() || t('New lead'),
        status: 'Conversations',
        start_date: '',
        end_date: '',
        description: '',
        url: '',
        notes: '',
        organization_id: suggestion.organization_id,
      });
      const category = await send({ meeting_kind: 'lead', lead_id: lead.id });
      onFiled(category);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t file the meeting.'));
    } finally {
      setBusy(false);
    }
  }

  function acceptSuggestion() {
    if (!suggestion) return;
    const body = suggestedBody(suggestion);
    if (body) { void file(body); return; }
    const subjectKind = SUBJECT_KIND[suggestion.meeting_kind]!;
    if (subjectKind === 'lead' && suggestion.organization_id) void createLeadAndFile();
    else setPicking(subjectKind);
  }

  const label = imported.meeting_kind === 'uncategorized'
    ? t('Unfiled')
    : imported.subject_title
      ? `${KIND_LABEL[imported.meeting_kind]} · ${imported.subject_title}`
      : KIND_LABEL[imported.meeting_kind];

  const suggested = suggestion && imported.meeting_kind === 'uncategorized' ? suggestion : null;
  const suggestedLabel = suggested
    ? suggested.subject_title
      ? `${KIND_LABEL[suggested.meeting_kind]} · ${suggested.subject_title}`
      : suggested.meeting_kind === 'lead' && suggested.organization_id
        ? t('New lead')
        : SUBJECT_KIND[suggested.meeting_kind]
          ? `${KIND_LABEL[suggested.meeting_kind]}…`
          : KIND_LABEL[suggested.meeting_kind]
    : '';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={cn('text-[13px]', imported.meeting_kind === 'uncategorized' && 'text-muted-foreground italic')}>{busy ? t('Filing…') : label}</span>
      {!imported.has_transcript && <small className="text-[11px] text-muted-foreground">{t('no transcript')}</small>}
      <div className={LEDGER.controls}>
        {suggested && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-primary disabled:border-border"
            disabled={busy}
            onClick={acceptSuggestion}
          >
            {suggestedLabel}
            <small className="text-[11px] text-muted-foreground">{Math.round(suggested.probability * 100)}%</small>
          </Button>
        )}
        <NativeSelect
          aria-label={t('File as')}
          size="sm"
          value=""
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'project' || value === 'lead' || value === 'organization' || value === 'event') setPicking(value);
            else if (value === 'status' || value === 'internal' || value === 'personal' || value === 'uncategorized') void file({ meeting_kind: value });
          }}
        >
          <NativeSelectOption value="">{imported.meeting_kind === 'uncategorized' ? t('File…') : t('Move…')}</NativeSelectOption>
          <NativeSelectOption value="project">{t('Project…')}</NativeSelectOption>
          <NativeSelectOption value="lead">{t('Lead…')}</NativeSelectOption>
          <NativeSelectOption value="organization">{t('Partner…')}</NativeSelectOption>
          <NativeSelectOption value="event">{t('Event…')}</NativeSelectOption>
          <NativeSelectOption value="status">{t('Status')}</NativeSelectOption>
          <NativeSelectOption value="internal">{t('Internal')}</NativeSelectOption>
          <NativeSelectOption value="personal">{t('Personal')}</NativeSelectOption>
          {imported.meeting_kind !== 'uncategorized' && <NativeSelectOption value="uncategorized">{t('Unfile')}</NativeSelectOption>}
        </NativeSelect>
        {/* A zero-width box at the row's right edge: the picker's anchor hangs from it, so the popover ends under the select. */}
        {picking && (
          <span className="absolute inset-y-0 right-0">
            <SubjectPicker kinds={MEETING_FILING_KINDS} initialKind={picking} allStatuses align="end" onPick={onPick} onClose={() => setPicking(null)} />
          </span>
        )}
      </div>
      {error && <ErrorNotice message={error} inline className="text-[13px]" />}
    </div>
  );
}
