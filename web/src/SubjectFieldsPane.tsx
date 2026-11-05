import { useCallback, useEffect, useId, useState } from 'react';
import { coreFieldsEntityFor, type CoreEntity, type CoreField, type CoreRecord } from '@starlings/contracts/core-fields';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { CheckRow, FormRow } from './form-row';
import { Input } from '@/ui/input';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { PlaceholderRows } from '@/ui/placeholder-rows';
import { Spinner } from '@/ui/spinner';
import { Textarea } from '@/ui/textarea';
import type { CrmSubject } from './crm-work';
import { DatePicker } from './DatePicker';
import { ErrorNotice } from './ErrorNotice';
import { SearchablePicker } from './SearchablePicker';
import { toast } from './Toast';
import { t } from './i18n';
import { PlanHead } from './work-parts';
import { docsListHeadClass } from './docs-list';
import {
  coreControl,
  coreDisplayValue,
  coreDraftValue,
  coreEntityWritable,
  corePatch,
  coreSections,
  fetchCoreFieldsRecord,
  fetchCoreRegistry,
  updateCoreFieldsRecord,
  type CoreControl,
  type CoreDraftValue,
} from './core-fields';

const sectionLabelClass = 'mt-[18px] mb-1 block text-sm font-medium text-foreground';
/** Past this many options a select searches (AGENTS.md invariant 31). */
const SEARCHABLE_OPTIONS = 8;

type Loaded =
  | { state: 'loading' }
  | { state: 'failed'; message: string }
  | { state: 'ok'; entity: CoreEntity; record: CoreRecord };

/**
 * The Fields pane: every field Core's registry lists for the
 * record behind a project, lead or partner, the web twin of Mac and iOS's
 * `CoreSubjectFieldsView`. As there, the subject stays the door and this is
 * the layer beneath it; nothing is written until Save, and Revert drops the
 * draft. The Worker reads and writes as the member, so what Core lets this
 * person change is what the form lets them change.
 */
export function SubjectFieldsPane({ subject, onSaved }: { subject: CrmSubject; onSaved?: () => void }) {
  const entityID = coreFieldsEntityFor(subject.kind);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [draft, setDraft] = useState<Record<string, CoreDraftValue>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!entityID) return;
    setLoaded((current) => (current.state === 'ok' ? current : { state: 'loading' }));
    try {
      const entities = await fetchCoreRegistry();
      const entity = entities.find((row) => row.id === entityID);
      if (!entity || !entity.access.canRead) {
        setLoaded({ state: 'failed', message: t('This account can’t see these fields.') });
        return;
      }
      const record = await fetchCoreFieldsRecord(entityID, subject.id);
      setLoaded({ state: 'ok', entity, record });
    } catch (cause) {
      setLoaded({ state: 'failed', message: cause instanceof Error ? cause.message : t('Couldn’t load the record') });
    }
  }, [entityID, subject.id]);

  useEffect(() => {
    setDraft({});
    setError('');
    setLoaded({ state: 'loading' });
    void load();
  }, [load]);

  if (!entityID) return null;

  const entity = loaded.state === 'ok' ? loaded.entity : null;
  const record = loaded.state === 'ok' ? loaded.record : null;
  const writable = entity ? coreEntityWritable(entity) : false;
  const dirty = Object.keys(draft).length > 0;

  const value = (field: CoreField): CoreDraftValue =>
    draft[field.name] ?? coreDraftValue(coreControl(field), record?.[field.name]);
  const set = (field: CoreField, next: CoreDraftValue) => setDraft((current) => {
    const control = coreControl(field);
    // Typing back to the saved value is no change: Save and Revert go quiet again.
    if (next === coreDraftValue(control, record?.[field.name])) {
      const { [field.name]: _dropped, ...rest } = current;
      return rest;
    }
    return { ...current, [field.name]: next };
  });

  async function save() {
    if (!entity || !record || !entityID) return;
    setError('');
    let patch;
    try { patch = corePatch(entity.fields, record, draft); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    if (!patch) { setDraft({}); return; }
    setBusy(true);
    try {
      const saved = await updateCoreFieldsRecord(entityID, subject.id, patch);
      setLoaded({ state: 'ok', entity, record: { ...record, ...saved } });
      setDraft({});
      toast(t('Saved'));
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t save that record.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-2" aria-labelledby="work-fields-heading">
      <div className={docsListHeadClass}>
        <PlanHead id="work-fields-heading">{t('Fields')}</PlanHead>
        {writable && record && (
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" disabled={!dirty || busy} onClick={() => { setDraft({}); setError(''); }}>{t('Revert')}</Button>
            <Button type="button" size="sm" disabled={!dirty || busy} onClick={() => void save()}>{busy && <Spinner aria-hidden />}{t('Save')}</Button>
          </div>
        )}
      </div>
      {error && <ErrorNotice message={error} />}
      {loaded.state === 'loading' && <PlaceholderRows count={4} glyph={false} label={t('Loading…')} />}
      {loaded.state === 'failed' && (
        <ErrorNotice message={loaded.message} action={<Button type="button" variant="outline" size="xs" onClick={() => void load()}>{t('Retry')}</Button>} />
      )}
      {entity && record && (
        <form className="m-0 max-w-[640px]" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <fieldset className="m-0 min-w-0 border-0 p-0" disabled={busy || !writable}>
            {coreSections(entity.fields).map((section) => (
              <div key={section.id || 'fields'}>
                {section.label && <span className={sectionLabelClass}>{section.label}</span>}
                {section.fields.map((field) => (
                  <CoreFieldControl
                    key={field.name}
                    field={field}
                    control={coreControl(field)}
                    value={value(field)}
                    display={coreDisplayValue(field, record)}
                    onChange={(next) => set(field, next)}
                  />
                ))}
              </div>
            ))}
          </fieldset>
        </form>
      )}
    </section>
  );
}

function CoreFieldControl({ field, control, value, display, onChange }: {
  field: CoreField;
  control: CoreControl;
  value: CoreDraftValue;
  display: string;
  onChange: (value: CoreDraftValue) => void;
}) {
  const id = useId();
  if (control === 'toggle') {
    return <CheckRow id={id} label={field.label}><Checkbox id={id} checked={value === true} onCheckedChange={(checked) => onChange(checked === true)} /></CheckRow>;
  }
  const text = typeof value === 'string' ? value : '';
  const change = (event: { target: { value: string } }) => onChange(event.target.value);
  const maxLength = typeof field.maxLength === 'number' ? field.maxLength : undefined;
  let input;
  switch (control) {
    case 'textarea':
      input = <Textarea id={id} rows={3} value={text} maxLength={maxLength} onChange={change} />;
      break;
    case 'markdown':
      input = <Textarea id={id} rows={8} value={text} className="font-mono text-[13px]" onChange={change} />;
      break;
    case 'url':
      input = <Input id={id} type="url" inputMode="url" value={text} placeholder="https://" onChange={change} />;
      break;
    case 'email':
      input = <Input id={id} type="email" value={text} onChange={change} />;
      break;
    case 'number':
      input = <Input id={id} type="text" inputMode="decimal" value={text} onChange={change} />;
      break;
    case 'date':
      input = <DatePicker id={id} value={text} ariaLabel={field.label} onChange={(day) => onChange(day)} />;
      break;
    case 'select': {
      const options = field.options ?? [];
      const known = !text || options.some((option) => option.value === text);
      const choices = [
        ...(!known ? [{ value: text, label: text }] : []),
        ...options,
      ];
      if (choices.length > SEARCHABLE_OPTIONS) {
        return <SearchablePicker
          label={field.label}
          placeholder={t('None')}
          options={[{ id: '', title: t('None') }, ...choices.map((option) => ({ id: option.value, title: option.label }))]}
          value={text}
          onChange={(next) => onChange(next)}
          emptyMessage={t('No options match that search.')}
          className="my-2"
        />;
      }
      input = (
        <NativeSelect id={id} value={text} onChange={change}>
          <NativeSelectOption value="">{t('None')}</NativeSelectOption>
          {choices.map((option) => <NativeSelectOption key={option.value} value={option.value}>{option.label}</NativeSelectOption>)}
        </NativeSelect>
      );
      break;
    }
    case 'readOnly':
      input = <Input id={id} readOnly tabIndex={-1} value={display} placeholder="—" className="text-muted-foreground" />;
      break;
    default:
      input = <Input id={id} required={field.required === true} maxLength={maxLength} value={text} onChange={change} />;
  }
  return <FormRow id={id} label={field.label}>{input}</FormRow>;
}
