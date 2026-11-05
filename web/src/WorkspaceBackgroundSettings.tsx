import { useEffect, useMemo, useRef, useState } from 'react';
import { BACKGROUND_GALLERY, BACKGROUND_TONES, BACKGROUND_TONE_LABELS, ENVISIONING_BACKGROUND_TONES, backgroundTonesFromAccent, tonePairVisible, BACKGROUND_GENERATORS } from '@starlings/contracts/background-gallery';
import type { WorkspaceBackgroundAdminResponse, WorkspaceBackgroundTones, WorkspaceBackgroundUpdate } from '@starlings/contracts/workspace-backgrounds';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { SearchablePicker } from './SearchablePicker';
import { apiFetch, apiUpload } from './api';
import { ErrorNotice } from './ErrorNotice';
import { prepareBackgroundImage } from './custom-background';
import { renderGalleryBackground } from './background-gallery';
import { t } from './i18n';
import { setWorkspaceBackgroundProfile } from './workspace-backgrounds';

export function WorkspaceBackgroundSettings({ canEdit, accent }: { canEdit: boolean; accent: string | null }) {
  const [data, setData] = useState<WorkspaceBackgroundAdminResponse | null>(null);
  const [explicit, setExplicit] = useState(false);
  const [tones, setTones] = useState<WorkspaceBackgroundTones>(ENVISIONING_BACKGROUND_TONES);
  const [selection, setSelection] = useState('none');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  function show(next: WorkspaceBackgroundAdminResponse) {
    setData(next);
    setExplicit(next.settings.tones !== null);
    setTones(next.settings.tones ?? next.resolved.tones);
    const value = next.settings.default;
    setSelection(value?.mode === 'image' ? 'image' : value?.mode === 'generated' ? `${value.generator}:${value.tone}` : 'none');
  }
  useEffect(() => {
    const controller = new AbortController();
    apiFetch<WorkspaceBackgroundAdminResponse>('/admin/workspace/backgrounds', { noStore: true, signal: controller.signal, fallbackError: t('Couldn’t load backgrounds.') })
      .then(show).catch(cause => { if (!controller.signal.aborted) setError(String(cause instanceof Error ? cause.message : cause)); });
    return () => controller.abort();
  }, []);
  async function run(action: () => Promise<WorkspaceBackgroundAdminResponse>, preserveDraft = false) {
    setSaving(true); setError('');
    try {
      const next = await action();
      if (preserveDraft) {
        setData(next);
        if (!next.settings.image && selection === 'image') setSelection('none');
      } else show(next);
      setWorkspaceBackgroundProfile(next.resolved);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  }
  const disabled = !canEdit || saving || !data;
  const resolved = useMemo(() => explicit ? tones : backgroundTonesFromAccent(accent) ?? ENVISIONING_BACKGROUND_TONES, [explicit, tones, accent]);
  const valid = BACKGROUND_TONES.every(tone => tonePairVisible(resolved[tone]));
  const previews = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const images = previews.current?.querySelectorAll<HTMLImageElement>('img[data-generator]');
    images?.forEach((image, index) => {
      const choice = BACKGROUND_GALLERY[index];
      if (choice && valid) image.src = renderGalleryBackground({ width: 320, height: 180, choice, seed: 42, tones: resolved });
    });
  }, [resolved, valid]);
  const entry = BACKGROUND_GALLERY.find(choice => `${choice.generator}:${choice.tone}` === selection);
  const update: WorkspaceBackgroundUpdate = { tones: explicit ? tones : null, default: selection === 'image' ? { mode: 'image' } : entry ? { mode: 'generated', ...entry } : null };
  return <div className="grid gap-4 border-t border-border pt-4">
    <h3 className="text-base font-medium">{t('Backgrounds')}</h3>
    <p className="text-sm text-muted-foreground">{t('These backgrounds are available to members and guests. A default applies only until someone chooses their own.')}</p>
    <form className="grid gap-4" onSubmit={event => {
      event.preventDefault();
      if (!valid) return;
      void run(() => apiFetch<WorkspaceBackgroundAdminResponse>('/admin/workspace/backgrounds', { method: 'PUT', body: update, fallbackError: t('Couldn’t save backgrounds.') }));
    }}>
      <Label className="grid max-w-80 gap-1.5 font-normal">{t('Tone colours')}
        <NativeSelect disabled={disabled} value={explicit ? 'explicit' : 'derived'} onChange={event => setExplicit(event.target.value === 'explicit')}>
          <NativeSelectOption value="derived">{t('Derive from workspace accent')}</NativeSelectOption>
          <NativeSelectOption value="explicit">{t('Set each colour')}</NativeSelectOption>
        </NativeSelect>
      </Label>
      {explicit && <div className="grid gap-3 sm:grid-cols-3">
        {BACKGROUND_TONES.map(tone => <fieldset key={tone} className="grid gap-2 rounded-md border border-border p-3" disabled={disabled}>
          <legend className="px-1 text-sm">{t(BACKGROUND_TONE_LABELS[tone].label)}</legend>
          {(['base', 'modules'] as const).map(part => <Label key={part} className="grid gap-1 font-normal">
            {part === 'base' ? t('Base colour') : t('Pattern colour')}
            <div className="flex gap-2">
              <Input type="color" aria-label={`${t(BACKGROUND_TONE_LABELS[tone].label)} ${part === 'base' ? t('Base colour') : t('Pattern colour')}`} className="w-12 shrink-0 p-1" value={tones[tone][part]} onChange={event => setTones(current => ({ ...current, [tone]: { ...current[tone], [part]: event.target.value } }))} />
              <Input aria-label={`${t(BACKGROUND_TONE_LABELS[tone].label)} ${part === 'base' ? t('Base colour') : t('Pattern colour')} #rrggbb`} value={tones[tone][part]} spellCheck={false} onChange={event => setTones(current => ({ ...current, [tone]: { ...current[tone], [part]: event.target.value } }))} />
            </div>
          </Label>)}
        </fieldset>)}
      </div>}
      {!valid && <ErrorNotice inline message={t('The pattern must be visible against its background.')} />}
      <div ref={previews} className="grid grid-cols-3 gap-2">
        {BACKGROUND_GALLERY.map(choice => <figure key={`${choice.generator}:${choice.tone}`} className="m-0 min-w-0">
          <img data-generator={choice.generator} alt="" className="aspect-video w-full rounded-md border border-border" />
          <figcaption className="mt-1 text-xs text-muted-foreground">{t(BACKGROUND_GENERATORS.find(generator => generator.id === choice.generator)!.label)} · {t(BACKGROUND_TONE_LABELS[choice.tone].label)}</figcaption>
        </figure>)}
      </div>
      <SearchablePicker label={t('Default background')} placeholder={t('None')} emptyMessage={t('No backgrounds found.')} value={selection} disabled={disabled} onChange={setSelection} options={[
        { id: 'none', title: t('None') },
        ...BACKGROUND_GALLERY.map(choice => ({ id: `${choice.generator}:${choice.tone}`, title: `${t(BACKGROUND_GENERATORS.find(generator => generator.id === choice.generator)!.label)} · ${t(BACKGROUND_TONE_LABELS[choice.tone].label)}` })),
        ...(data?.settings.image ? [{ id: 'image', title: t('Workspace picture') }] : []),
      ]} />
      <div><Button type="submit" disabled={disabled || !valid}>{saving ? t('Saving…') : t('Save backgrounds')}</Button></div>
    </form>
    <div className="grid gap-2">
      <span className="text-sm">{t('Workspace picture')}</span>
      <p className="text-xs text-muted-foreground">{t('PNG, JPEG or WebP, up to 12 MB. Pictures are resized to 1280 × 720 and metadata is removed before upload.')}</p>
      {data?.resolved.image_url && <img src={data.resolved.image_url} alt={t('Workspace picture')} className="aspect-video w-64 max-w-full rounded-md border border-border object-cover" />}
      {/* shadcn: a hidden file input opened by a Button */}
      <input ref={file} type="file" hidden disabled={disabled} accept="image/png,image/jpeg,image/webp" onChange={event => {
        const chosen = event.target.files?.[0]; event.target.value = '';
        if (chosen) void run(async () => {
          const prepared = await prepareBackgroundImage(chosen);
          return apiUpload<WorkspaceBackgroundAdminResponse>('/admin/workspace/backgrounds/image', prepared.blob, t('Couldn’t upload the workspace picture.'));
        }, true);
      }} />
      <div className="flex gap-2">
        <Button type="button" variant="secondary" disabled={disabled} onClick={() => file.current?.click()}>{data?.settings.image ? t('Replace…') : t('Upload…')}</Button>
        {data?.settings.image && <Button type="button" variant="ghost" disabled={disabled} onClick={() => void run(() => apiFetch<WorkspaceBackgroundAdminResponse>('/admin/workspace/backgrounds/image', { method: 'DELETE', fallbackError: t('Couldn’t remove the workspace picture.') }), true)}>{t('Remove')}</Button>}
      </div>
    </div>
    {error && <ErrorNotice inline message={error} />}
  </div>;
}
