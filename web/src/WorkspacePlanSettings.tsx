import { useEffect, useState } from 'react';
import type { WorkspacePlanResponse } from '@starlings/contracts/workspace-plan';
import { WORKSPACE_PLANS, workspacePlanSpec, type WorkspacePlanId } from '@starlings/contracts/workspace-plans';
import { Button } from '@/ui/button';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { apiFetch } from './api';
import { fetchSubjects, type CrmSubject } from './crm-work';
import { ErrorNotice } from './ErrorNotice';
import { SectionCard } from './SectionCard';
import { t } from './i18n';
import { publishWorkspacePlan, useWorkspacePlan } from './workspace-plan';

const FIELD = 'grid max-w-80 gap-1.5 font-normal leading-normal';

/**
 * Admin › People: the workspace's plan. Everyone with Admin sees
 * it. A root admin changes it. On a plan with a project limit, an admin
 * picks the one writable project, once.
 */
export function WorkspacePlanSettings({ viewer }: { viewer: { is_admin: boolean; is_root: boolean } }) {
  const plan = useWorkspacePlan();
  const [choice, setChoice] = useState<WorkspacePlanId | null>(null);
  const [projects, setProjects] = useState<CrmSubject[] | null>(null);
  const [kept, setKept] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const picking = !!plan && plan.project_limit !== null && !plan.kept_project_picked && viewer.is_admin;

  useEffect(() => {
    if (!picking) return;
    let active = true;
    fetchSubjects('project', '')
      .then((page) => { if (active) setProjects(page.subjects); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; };
  }, [picking]);

  async function run(action: () => Promise<WorkspacePlanResponse>) {
    setSaving(true);
    setError(null);
    try {
      publishWorkspacePlan(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  const selected = choice ?? plan?.plan ?? null;
  const keptValue = kept || plan?.kept_project_id || projects?.[0]?.id || '';

  return (
    <SectionCard id="admin-plan" title={t('Plan')}>
      {viewer.is_root ? (
        <form
          className="grid max-w-80 gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!selected || selected === plan?.plan) return;
            void run(() => apiFetch<WorkspacePlanResponse>('/admin/plan', {
              method: 'PUT',
              body: { plan: selected },
              fallbackError: t('Couldn’t save the plan.'),
            }));
          }}
        >
          <Label className={FIELD}>
            {t('Plan')}
            <NativeSelect value={selected ?? ''} disabled={saving || !plan} onChange={(event) => setChoice(event.target.value as WorkspacePlanId)}>
              {WORKSPACE_PLANS.map((spec) => (
                <NativeSelectOption key={spec.id} value={spec.id}>{t(spec.label)}</NativeSelectOption>
              ))}
            </NativeSelect>
          </Label>
          <div>
            <Button type="submit" disabled={saving || !plan || selected === plan.plan}>{saving ? t('Saving…') : t('Save')}</Button>
          </div>
        </form>
      ) : (
        <p className="m-0 text-sm">{plan ? t(workspacePlanSpec(plan.plan).label) : '—'}</p>
      )}

      {picking && projects && projects.length > 1 && (
        <form
          className="grid max-w-80 gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!keptValue) return;
            void run(() => apiFetch<WorkspacePlanResponse>('/admin/plan/kept-project', {
              method: 'PUT',
              body: { project_id: keptValue },
              fallbackError: t('Couldn’t save the writable project.'),
            }));
          }}
        >
          <Label className={FIELD}>
            {t('Writable project')}
            <NativeSelect value={keptValue} disabled={saving} onChange={(event) => setKept(event.target.value)}>
              {projects.map((project) => (
                <NativeSelectOption key={project.id} value={project.id}>{project.title}</NativeSelectOption>
              ))}
            </NativeSelect>
          </Label>
          <div>
            <Button type="submit" disabled={saving || !keptValue}>{saving ? t('Saving…') : t('Save')}</Button>
          </div>
        </form>
      )}
      {error && <ErrorNotice message={error} inline className="text-sm" />}
    </SectionCard>
  );
}
