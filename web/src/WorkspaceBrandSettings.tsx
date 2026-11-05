import { useEffect, useId, useRef, useState } from 'react';
import { WORKSPACE_ACCENT_PATTERN } from '@starlings/contracts/workspace-accent';
import {
  WORKSPACE_NAME_MAX,
  WORKSPACE_SUITES,
  WORKSPACE_SUITE_LABELS,
  parseWorkspaceSuite,
  type WorkspaceBrandAdminResponse,
  type WorkspaceSuiteAdminResponse,
} from '@starlings/contracts/workspace-profile';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { RadioGroup, RadioGroupItem } from '@/ui/radio-group';
import { apiFetch, apiUpload } from './api';
import { ErrorNotice } from './ErrorNotice';
import { CheckRow } from './form-row';
import { SectionCard } from './SectionCard';
import { workspaceBrand } from './workspace-brand';
import { t } from './i18n';
import { WorkspaceBackgroundSettings } from './WorkspaceBackgroundSettings';
import { WorkspaceDefaultsSettings } from './WorkspaceDefaultsSettings';

/**
 * Admin › People: the workspace's name, accent and mark (,
 * packages/contracts/src/workspace-profile.ts). Every page and the
 * descriptor at `/.well-known/meet` read them; a page already open shows the
 * change on its next load. Only an admin may change them; anyone else reads.
 */
export function WorkspaceBrandSettings({ canEdit }: { canEdit: boolean }) {
  const [brand, setBrand] = useState<WorkspaceBrandAdminResponse | null>(null);
  const [name, setName] = useState('');
  const [accent, setAccent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  function show(next: WorkspaceBrandAdminResponse) {
    setBrand(next);
    setName(next.name ?? '');
    setAccent(next.accent ?? '');
  }

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<WorkspaceBrandAdminResponse>('/admin/workspace', { fallbackError: t('Couldn’t load the workspace.'), noStore: true, signal: controller.signal })
      .then(show)
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, []);

  async function run(action: () => Promise<WorkspaceBrandAdminResponse>) {
    setSaving(true);
    setError(null);
    try {
      show(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  const trimmedAccent = accent.trim();
  const accentValid = trimmedAccent === '' || WORKSPACE_ACCENT_PATTERN.test(trimmedAccent);
  const changed = !!brand && (name.trim() !== (brand.name ?? '') || trimmedAccent.toLowerCase() !== (brand.accent ?? ''));
  const disabled = !canEdit || saving || !brand;

  return (
    <SectionCard id="admin-workspace" title={t('Workspace')}>
      <form
        className="grid max-w-80 gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!changed || !accentValid) return;
          void run(() => apiFetch<WorkspaceBrandAdminResponse>('/admin/workspace', {
            method: 'PUT',
            body: { name: name.trim() || null, accent: trimmedAccent || null },
            fallbackError: t('Couldn’t save the workspace.'),
          }));
        }}
      >
        <Label className="grid gap-1.5 font-normal leading-normal">
          {t('Name')}
          <Input value={name} maxLength={WORKSPACE_NAME_MAX} placeholder={workspaceBrand().name} disabled={disabled} onChange={(event) => setName(event.target.value)} />
        </Label>
        <Label className="grid gap-1.5 font-normal leading-normal">
          {t('Accent')}
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="size-8 shrink-0 rounded-md border border-border bg-accent"
              style={trimmedAccent && accentValid ? { backgroundColor: trimmedAccent } : undefined}
            />
            <Input value={accent} placeholder="#rrggbb" spellCheck={false} disabled={disabled} aria-invalid={!accentValid} onChange={(event) => setAccent(event.target.value)} />
          </span>
        </Label>
        <div>
          <Button type="submit" disabled={disabled || !changed || !accentValid}>{saving ? t('Saving…') : t('Save')}</Button>
        </div>
      </form>

      <div className="grid gap-1.5">
        <span className="text-sm">{t('Mark')}</span>
        <div className="flex flex-wrap items-center gap-2">
          {brand?.mark_url && <img src={brand.mark_url} alt="" className="size-8 rounded-md border border-border object-contain p-1" />}
          {/* shadcn: a hidden file input; a Button opens it */}
          <input
            ref={file}
            type="file"
            accept="image/png,image/svg+xml"
            hidden
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              event.target.value = '';
              if (chosen) void run(() => apiUpload<WorkspaceBrandAdminResponse>('/admin/workspace/mark', chosen, t('Couldn’t upload the mark.')));
            }}
          />
          <Button type="button" variant="secondary" disabled={disabled} onClick={() => file.current?.click()}>
            {brand?.mark_url ? t('Replace…') : t('Upload…')}
          </Button>
          {brand?.mark_url && (
            <Button
              type="button"
              variant="ghost"
              disabled={disabled}
              onClick={() => void run(() => apiFetch<WorkspaceBrandAdminResponse>('/admin/workspace/mark', { method: 'DELETE', fallbackError: t('Couldn’t remove the mark.') }))}
            >
              {t('Remove')}
            </Button>
          )}
        </div>
      </div>
      <WorkspaceBackgroundSettings canEdit={canEdit} accent={brand?.accent ?? null} />
      {error && <ErrorNotice message={error} inline className="text-sm" />}

      <WorkspaceSuiteSetting canEdit={canEdit} />
      <WorkspaceDefaultsSettings canEdit={canEdit} />
    </SectionCard>
  );
}

/**
 * Where the workspace's mail and calendar live (contracts/workspace-suite.ts).
 * Calendar connects on Google only, so the other two hide Connect Calendar
 * in every client. Saves on change.
 */
function WorkspaceSuiteSetting({ canEdit }: { canEdit: boolean }) {
  const uid = useId();
  const [suite, setSuite] = useState<WorkspaceSuiteAdminResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<WorkspaceSuiteAdminResponse>('/admin/workspace/suite', { fallbackError: t('Couldn’t load the workspace.'), noStore: true, signal: controller.signal })
      .then(setSuite)
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, []);

  async function save(value: string) {
    const parsed = parseWorkspaceSuite(value);
    if (!parsed || parsed === suite?.suite) return;
    setSaving(true);
    setError(null);
    try {
      setSuite(await apiFetch<WorkspaceSuiteAdminResponse>('/admin/workspace/suite', {
        method: 'PUT',
        body: { suite: parsed },
        fallbackError: t('Couldn’t save the workspace.'),
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-1.5">
      <span className="text-sm">{t('Mail and calendar')}</span>
      <RadioGroup value={suite?.suite ?? ''} onValueChange={(value) => void save(value)} disabled={!canEdit || saving || !suite} className="gap-0">
        {WORKSPACE_SUITES.map((value) => (
          <CheckRow key={value} id={`${uid}-${value}`} label={t(WORKSPACE_SUITE_LABELS[value])} className="my-1">
            <RadioGroupItem id={`${uid}-${value}`} value={value} />
          </CheckRow>
        ))}
      </RadioGroup>
      {error && <ErrorNotice message={error} inline className="text-sm" />}
    </div>
  );
}
