import { useEffect, useState } from 'react';
import type { SetupResponse } from '@starlings/contracts/setup';
import { Checkbox } from '@/ui/checkbox';
import { Label } from '@/ui/label';
import { apiFetch } from './api';
import { ErrorNotice } from './ErrorNotice';
import { SectionCard } from './SectionCard';
import { t } from './i18n';

/**
 * Admin › People: the setup checklist on Home, on or off for everyone
 * (docs/ONBOARDING.md §The setup checklist). Saves on change. The card's own
 * "Turn off for everyone" writes the same setting; this is where it comes back on.
 */
export function SetupChecklistSettings({ canEdit }: { canEdit: boolean }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<SetupResponse>('/setup', { fallbackError: t('Couldn’t load your setup steps.'), noStore: true, signal: controller.signal })
      .then((setup) => setOn(setup.on))
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, []);

  async function save(next: boolean) {
    const previous = on;
    setOn(next);
    setSaving(true);
    setError(null);
    try {
      setOn((await apiFetch<SetupResponse>('/admin/setup', { method: 'PUT', body: { on: next }, fallbackError: t('Couldn’t save the setup checklist.') })).on);
    } catch (cause) {
      setOn(previous);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard id="admin-setup-checklist" title={t('Setup checklist')}>
      <Label className="flex cursor-pointer items-center gap-3 font-normal leading-normal">
        <Checkbox
          checked={on ?? false}
          disabled={!canEdit || saving || on === null}
          onCheckedChange={(value) => { void save(value === true); }}
        />
        {t('Show the setup steps on Home')}
      </Label>
      {error && <ErrorNotice message={error} inline className="text-sm" />}
    </SectionCard>
  );
}
