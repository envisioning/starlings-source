import { useEffect, useState } from 'react';
import { SCHEDULE_TIME_ZONES } from '@starlings/contracts/calendar-values';
import { LANGUAGES, resolveLanguage } from '@starlings/contracts/language-values';
import { workspaceDefaultsSchema, type WorkspaceDefaults, type WorkspaceDefaultsAdminResponse } from '@starlings/contracts/workspace-defaults';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Textarea } from '@/ui/textarea';
import { Checkbox } from '@/ui/checkbox';
import { CheckRow } from './form-row';
import { apiFetch } from './api';
import { ErrorNotice } from './ErrorNotice';
import { SearchablePicker } from './SearchablePicker';
import { t } from './i18n';

export function WorkspaceDefaultsSettings({ canEdit }: { canEdit: boolean }) {
  const [saved, setSaved] = useState<WorkspaceDefaults | null>(null);
  const [draft, setDraft] = useState<WorkspaceDefaults | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  function show(response: WorkspaceDefaultsAdminResponse) { setSaved(response.defaults); setDraft(response.defaults); }
  useEffect(() => {
    const controller = new AbortController();
    apiFetch<WorkspaceDefaultsAdminResponse>('/admin/workspace/defaults', { noStore: true, signal: controller.signal, fallbackError: t('Couldn’t load the workspace.') })
      .then(show).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, []);
  function change<K extends keyof WorkspaceDefaults>(key: K, value: WorkspaceDefaults[K]) {
    setDraft(current => current ? { ...current, [key]: value } : current);
    setNotice('');
  }
  const disabled = !canEdit || saving || !draft;
  const valid = draft ? workspaceDefaultsSchema.safeParse(draft).success : false;
  const changed = JSON.stringify(saved) !== JSON.stringify(draft);
  const languageNames = { en: t('English'), 'pt-BR': t('Português') };
  return <div className="grid gap-3 border-t border-border pt-4">
    <h3 className="text-base font-medium">{t('Workspace defaults')}</h3>
    {draft && <form className="grid max-w-xl gap-3" onSubmit={event => {
      event.preventDefault();
      if (!canEdit || !valid || !changed || saving) return;
      setSaving(true); setError(''); setNotice('');
      void apiFetch<WorkspaceDefaultsAdminResponse>('/admin/workspace/defaults', { method: 'PUT', body: draft, fallbackError: t('Couldn’t save the workspace.') })
        .then(response => { show(response); setNotice(t('Saved. Open a new page or restart Starlings to use the updated defaults.')); })
        .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setSaving(false));
    }}>
      <div className="grid gap-2">
        <Label>{t('Time zones')}</Label>
        <SearchablePicker label={t('Add time zone')} placeholder={t('Add time zone')} emptyMessage={t('No matches')} value="" disabled={disabled}
          options={SCHEDULE_TIME_ZONES.filter(zone => !draft.time_zones.includes(zone.id)).map(zone => ({ id: zone.id, title: t(zone.city), subtitle: zone.zone }))}
          onChange={id => { const zone = SCHEDULE_TIME_ZONES.find(zone => zone.id === id); if (zone) change('time_zones', [...draft.time_zones, zone.id]); }} />
        <div className="flex flex-wrap gap-2">
          {SCHEDULE_TIME_ZONES.filter(zone => draft.time_zones.includes(zone.id)).map(zone => <Button key={zone.id} type="button" variant="secondary" size="sm"
            disabled={disabled || draft.time_zones.length === 1} aria-label={t('Remove {name}', { name: t(zone.city) })}
            onClick={() => change('time_zones', draft.time_zones.filter(id => id !== zone.id))}>{t(zone.city)}</Button>)}
        </div>
      </div>
      <fieldset className="grid gap-1" disabled={disabled}>
        <legend className="mb-1 text-sm">{t('Languages offered')}</legend>
        {LANGUAGES.map(language => <CheckRow key={language} id={`workspace-language-${language}`} label={languageNames[language]}>
          <Checkbox id={`workspace-language-${language}`} checked={draft.languages_offered.includes(language)}
            disabled={disabled || (draft.languages_offered.length === 1 && draft.languages_offered.includes(language))}
            onCheckedChange={checked => {
              setNotice('');
              const offered = checked ? [...draft.languages_offered, language] : draft.languages_offered.filter(value => value !== language);
              setDraft(current => current ? { ...current, languages_offered: offered, default_language: current.default_language && !offered.includes(current.default_language) ? null : current.default_language } : current);
            }} />
        </CheckRow>)}
      </fieldset>
      <Label className="grid gap-1.5 font-normal">{t('Default language')}
        <NativeSelect value={draft.default_language ?? ''} disabled={disabled} onChange={event => change('default_language', resolveLanguage(event.target.value))}>
          <NativeSelectOption value="">{t('System')}</NativeSelectOption>
          {LANGUAGES.filter(language => draft.languages_offered.includes(language)).map(language => <NativeSelectOption key={language} value={language}>{languageNames[language]}</NativeSelectOption>)}
        </NativeSelect>
      </Label>
      {(['contact_email', 'privacy_email', 'project_group_name', 'public_events_feed'] as const).map(key => <Label key={key} className="grid gap-1.5 font-normal">
        {key === 'contact_email' ? t('Contact email') : key === 'privacy_email' ? t('Privacy email') : key === 'project_group_name' ? t('Project group name') : t('Public events feed')}
        <Input type={key.endsWith('email') ? 'email' : key === 'public_events_feed' ? 'url' : 'text'} disabled={disabled} value={draft[key] ?? ''}
          maxLength={key === 'project_group_name' ? 60 : key === 'public_events_feed' ? 2048 : 254}
          onChange={event => change(key, key.endsWith('email') ? event.target.value : event.target.value || null)} />
      </Label>)}
      <Label className="grid gap-1.5 font-normal">{t('AI filing persona')}
        <Textarea disabled={disabled} value={draft.ai_filing_persona ?? ''} maxLength={2000} onChange={event => change('ai_filing_persona', event.target.value || null)} />
      </Label>
      <Label className="grid gap-1.5 font-normal">{t('Booking slot grid (minutes)')}
        <Input type="number" min={5} max={240} step={1} disabled={disabled} value={draft.booking_slot_minutes ?? ''} onChange={event => change('booking_slot_minutes', event.target.value ? Number(event.target.value) : null)} />
      </Label>
      <div><Button type="submit" disabled={disabled || !valid || !changed}>{saving ? t('Saving…') : t('Save defaults')}</Button></div>
    </form>}
    {notice && <p role="status" className="m-0 text-sm text-muted-foreground">{notice}</p>}
    {error && <ErrorNotice inline message={error} />}
  </div>;
}
