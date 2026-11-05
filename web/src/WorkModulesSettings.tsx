import { useEffect, useState } from 'react';
import { WORK_MODULES, WORK_MODULE_LABELS, WORK_MODULE_SPECS, type WorkModule } from '@starlings/contracts/work-modules';
import type { WorkModulesAdminResponse } from '@starlings/contracts/work-modules-setting';
import { Checkbox } from '@/ui/checkbox';
import { Label } from '@/ui/label';
import { apiFetch } from './api';
import { ErrorNotice } from './ErrorNotice';
import { SectionCard } from './SectionCard';
import { t } from './i18n';

/**
 * Admin › People: which work modules the workspace has on
 * (docs/WORK_MODEL.md). Each box saves on change. A work module this
 * workspace's store cannot serve shows as not available; a commercial one
 * shows only where it is available. Only an admin may change it.
 */
export function WorkModulesSettings({ canEdit }: { canEdit: boolean }) {
  const [setting, setSetting] = useState<WorkModulesAdminResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<WorkModulesAdminResponse>('/admin/work-modules', { fallbackError: t('Couldn’t load the work modules.'), noStore: true, signal: controller.signal })
      .then(setSetting)
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, []);

  async function toggle(module: WorkModule, on: boolean) {
    if (!setting) return;
    const previous = setting;
    const next = on ? [...setting.on, module] : setting.on.filter((id) => id !== module);
    setSetting({ ...setting, on: next });
    setSaving(true);
    setError(null);
    try {
      setSetting(await apiFetch<WorkModulesAdminResponse>('/admin/work-modules', {
        method: 'PUT',
        body: { on: next },
        fallbackError: t('Couldn’t save the work modules.'),
      }));
    } catch (cause) {
      setSetting(previous);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  const shown = WORK_MODULES.filter((module) => !WORK_MODULE_SPECS[module].commercial || setting?.available.includes(module));

  return (
    <SectionCard id="admin-work-modules" title={t('Work modules')}>
      {shown.map((module) => {
        const available = setting?.available.includes(module) ?? false;
        return (
          <Label key={module} className="flex cursor-pointer items-center gap-3 font-normal leading-normal">
            <Checkbox
              checked={setting?.on.includes(module) ?? false}
              disabled={!canEdit || saving || !setting || !available}
              onCheckedChange={(value) => { void toggle(module, value === true); }}
            />
            {t(WORK_MODULE_LABELS[module])}
            {setting && !available && <span className="text-muted-foreground">{t('Not available yet')}</span>}
          </Label>
        );
      })}
      {error && <ErrorNotice message={error} inline className="text-sm" />}
    </SectionCard>
  );
}
