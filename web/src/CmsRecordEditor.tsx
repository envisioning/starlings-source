import { useEffect, useId, useMemo, useState } from 'react';
import type { CmsEntity, CmsField, CmsRecord } from '@starlings/contracts/cms';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { CheckRow, FormRow } from './form-row';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';
import { Spinner } from '@/ui/spinner';
import { cn } from '@/lib/utils';
import { SearchablePicker } from './SearchablePicker';
import { DatePicker } from './DatePicker';
import { CloseIcon } from './action-icons';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { editorDialogClass, editorFieldsetClass, editorHeaderClass, editorTitleClass } from './editor-dialog';
import {
  cmsControl,
  cmsDraftValue,
  cmsPatch,
  fetchCmsChoices,
  fetchCmsRecord,
  fetchCmsRegistry,
  updateCmsRecord,
  writableCmsEntity,
  type CmsControl,
  type CmsDraftValue,
} from './cms-content';

/** A field: its name above it, in secondary ink; the control keeps primary ink (CalendarEventEditor). */
const sectionLabelClass = 'mt-[18px] mb-1 block text-sm font-medium text-foreground';

/** Core's section ids, named. An id Core adds later shows as its own words. */
const SECTION_LABELS: Record<string, string> = {
  basics: t('Basics'),
  schedule: t('Date and time'),
  where: t('Where'),
  hosting: t('Hosting'),
  generated_page_body: t('Generated page'),
  publishing: t('Publishing'),
};

function sectionLabel(id: string): string {
  return SECTION_LABELS[id] ?? id.replace(/_/g, ' ').replace(/^./u, (letter) => letter.toUpperCase());
}

/** The fields in the registry's order, grouped by section in first-seen order. */
function sections(fields: CmsField[]): Array<{ id: string; fields: CmsField[] }> {
  const groups: Array<{ id: string; fields: CmsField[] }> = [];
  for (const field of fields) {
    const id = field.section ?? '';
    const group = groups.find((entry) => entry.id === id);
    if (group) group.fields.push(field);
    else groups.push({ id, fields: [field] });
  }
  return groups;
}

type Loaded = { state: 'loading' } | { state: 'failed'; message: string } | { state: 'ok'; record: CmsRecord };

/**
 * Edit one CMS row in Meet: every field Core's registry lists
 * for the entity, grouped as Core groups them. Save sends only what
 * changed, as the person; Core's strict schema is the validator, and its
 * refusal names the field.
 */
export function CmsRecordEditor({ entity, id, onClose, onSaved }: {
  entity: CmsEntity;
  id: string;
  onClose: () => void;
  onSaved: (record: CmsRecord) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [draft, setDraft] = useState<Record<string, CmsDraftValue>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    fetchCmsRecord(entity.id, id).then(
      (record) => { if (live) setLoaded({ state: 'ok', record }); },
      (cause: unknown) => { if (live) setLoaded({ state: 'failed', message: cause instanceof Error ? cause.message : t('Couldn’t load that record.') }); },
    );
    return () => { live = false; };
  }, [entity.id, id]);

  const record = loaded.state === 'ok' ? loaded.record : null;
  const value = (field: CmsField): CmsDraftValue =>
    draft[field.name] ?? cmsDraftValue(cmsControl(entity.id, field), record?.[field.name]);
  const set = (field: CmsField, next: CmsDraftValue) => setDraft((current) => ({ ...current, [field.name]: next }));
  const primary = entity.fields.find((field) => field.name === entity.primaryField);
  const primaryValue = primary ? value(primary) : 'x';
  const canSave = record !== null && !busy && (typeof primaryValue !== 'string' || primaryValue.trim().length > 0);

  async function save() {
    if (!record) return;
    setError('');
    let patch;
    try { patch = cmsPatch(entity.id, entity.fields, record, draft); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    if (!patch) { onClose(); return; }
    setBusy(true);
    try {
      onSaved(await updateCmsRecord(entity.id, id, patch));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t save that record.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className={cn(editorDialogClass, 'gap-3 bg-card p-5 sm:max-w-[560px]')}
        // An editor keeps its draft: only Esc or Close leaves.
        onInteractOutside={(event) => event.preventDefault()}
      >
        <form className="m-0" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <div className={editorHeaderClass}>
            <DialogTitle asChild><h2 className={editorTitleClass}>{t('Edit {kind}', { kind: entity.singularLabel.toLowerCase() })}</h2></DialogTitle>
            <Button type="button" variant="ghost" size="icon" className="rounded-full text-muted-foreground" aria-label={t('Close')} disabled={busy} onClick={onClose}>
              <CloseIcon />
            </Button>
          </div>
          {error && <ErrorNotice message={error} />}
          {loaded.state === 'loading' && <p className="my-3 text-sm text-muted-foreground">{t('Loading…')}</p>}
          {loaded.state === 'failed' && <ErrorNotice message={loaded.message} />}
          {record && (
            <fieldset className={editorFieldsetClass} disabled={busy}>
              {sections(entity.fields).map((section) => (
                <div key={section.id || 'fields'}>
                  {section.id && <span className={sectionLabelClass}>{sectionLabel(section.id)}</span>}
                  {section.fields.map((field) => (
                    <CmsFieldControl
                      key={field.name}
                      field={field}
                      control={cmsControl(entity.id, field)}
                      value={value(field)}
                      required={field.name === entity.primaryField}
                      onChange={(next) => set(field, next)}
                    />
                  ))}
                </div>
              ))}
            </fieldset>
          )}
          <div className="mt-[18px] flex flex-wrap items-center justify-end gap-2">
            <Button disabled={!canSave}>{busy && <Spinner aria-hidden />}{t('Save')}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CmsFieldControl({ field, control, value, required, onChange }: {
  field: CmsField;
  control: CmsControl;
  value: CmsDraftValue;
  required: boolean;
  onChange: (value: CmsDraftValue) => void;
}) {
  const id = useId();
  if (control === 'toggle') {
    return <CheckRow id={id} label={field.label}><Checkbox id={id} checked={value === true} onCheckedChange={(checked) => onChange(checked === true)} /></CheckRow>;
  }
  const text = typeof value === 'string' ? value : '';
  const change = (event: { target: { value: string } }) => onChange(event.target.value);
  let input;
  switch (control) {
    case 'readOnly':
      input = <Input id={id} readOnly value={text} className="text-muted-foreground" />;
      break;
    case 'textarea':
      input = <Textarea id={id} rows={3} value={text} onChange={change} />;
      break;
    case 'markdown':
      input = <Textarea id={id} rows={10} value={text} className="font-mono text-[13px]" onChange={change} />;
      break;
    case 'url':
      input = <Input id={id} type="url" inputMode="url" value={text} placeholder="https://" onChange={change} />;
      break;
    case 'email':
      input = <Input id={id} type="email" value={text} onChange={change} />;
      break;
    case 'emails':
      input = <Input id={id} type="text" inputMode="email" value={text} placeholder={t('Emails, separated by commas')} onChange={change} />;
      break;
    case 'number':
      input = <Input id={id} type="text" inputMode="decimal" value={text} onChange={change} />;
      break;
    case 'date':
      input = <DatePicker id={id} value={text} ariaLabel={field.label} onChange={(day) => onChange(day)} />;
      break;
    case 'time':
      // Native clock controls are locale-rendered; the column is 24-hour HH:MM.
      input = <Input id={id} type="text" inputMode="numeric" pattern="(?:[01][0-9]|2[0-3]):[0-5][0-9]" maxLength={5} placeholder={t('HH:MM')} value={text} className="w-30" onChange={change} />;
      break;
    case 'timezone':
      input = <TimeZoneSelect label={field.label} value={text} onChange={(zone) => onChange(zone)} />;
      break;
    case 'relation':
      input = <RelationSelect field={field} value={text} onChange={(next) => onChange(next)} />;
      break;
    default:
      input = <Input id={id} required={required} value={text} onChange={change} />;
  }
  if (control === 'timezone' || control === 'relation') return input;
  return <FormRow id={id} label={field.label}>{input}</FormRow>;
}

function TimeZoneSelect({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const zones = useMemo(() => {
    const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    return value && !all.includes(value) ? [value, ...all] : all;
  }, [value]);
  return <SearchablePicker
    label={label}
    placeholder={t('None')}
    options={[
      { id: '', title: t('None') },
      ...zones.map((zone) => ({ id: zone, title: zone })),
    ]}
    value={value}
    onChange={onChange}
    emptyMessage={t('No options match that search.')}
    className="my-2"
  />;
}

/** A relation column: the target entity's rows by their primary field. */
function RelationSelect({ field, value, onChange }: { field: CmsField; value: string; onChange: (value: string) => void }) {
  const [choices, setChoices] = useState<Array<{ id: string; label: string }> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetchCmsRegistry()
      .then((entities) => {
        const target = entities.find((entity) => entity.id === field.relationEntity);
        if (!target) throw new Error('unknown relation');
        return fetchCmsChoices(target);
      })
      .then((rows) => { if (live) setChoices(rows); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [field.relationEntity]);
  // Without the list, the id itself stays editable rather than the field vanishing.
  if (failed) return <Input value={value} onChange={(event) => onChange(event.target.value)} />;
  const options = choices ?? [];
  const known = !value || options.some((choice) => choice.id === value);
  return <SearchablePicker
    label={field.label}
    placeholder={choices === null ? t('Loading…') : t('None')}
    options={[
      { id: '', title: t('None') },
      ...(!known ? [{ id: value, title: value }] : []),
      ...options.map((choice) => ({ id: choice.id, title: choice.label })),
    ]}
    value={value}
    onChange={onChange}
    emptyMessage={t('No options match that search.')}
    disabled={choices === null}
    className="my-2"
  />;
}

/**
 * The entity when this person may edit its rows, or null while unknown and
 * when they may not. Pass '' for a row that is not a CMS row.
 */
export function useWritableCmsEntity(entityID: string): CmsEntity | null {
  const [entity, setEntity] = useState<{ id: string; value: CmsEntity | null }>({ id: '', value: null });
  useEffect(() => {
    if (!entityID) return;
    let live = true;
    void writableCmsEntity(entityID).then((value) => { if (live) setEntity({ id: entityID, value }); });
    return () => { live = false; };
  }, [entityID]);
  return entityID && entity.id === entityID ? entity.value : null;
}
