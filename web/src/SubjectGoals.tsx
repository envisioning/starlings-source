import { formatDay } from './meeting-time';
import { useState } from 'react';
import { railListClass } from './rail-list';
import { DatePicker } from './DatePicker';
import { Input } from '@/ui/input';
import { Button } from '@/ui/button';
import { isLateGoal, isLiveGoal, sortGoals, type CrmGoal, type GoalStatus } from '@starlings/contracts/goals-decisions';
import { ErrorNotice } from './ErrorNotice';
import { RailRow, RailSection } from './SurfaceShell';
import { GlyphMark } from './SubjectMark';
import { TasksIcon } from './action-icons';
import { createGoal, updateGoal, type CrmTeamMember } from './crm-work';
import { t } from './i18n';
import { HeadRow, PlanHead, SheetActions, SheetCard, SheetField, StateActions } from './work-parts';
import { RowMenuItems } from './row-menu-items';
import { useRowMenu } from './use-row-menu';
import { SearchablePicker } from './SearchablePicker';

/**
 * A project's goals, at the top of its Tasks pane: where the
 * work points, before the work. Open goals first in the contract's order;
 * met and dropped fold under a Show all.
 */
export function SubjectGoals({ projectId, goals, error: loadError, team, onReload, inGroup = false }: {
  projectId: string;
  /** Every goal on the project, any status; the page reads them once. */
  goals: CrmGoal[];
  error: string;
  team: CrmTeamMember[];
  /** After a write: the page re-reads, and the task sheet's picker follows. */
  onReload: () => void;
  /** Drawn as a foldable group of the subject's Overview, not as a pane's own section. */
  inGroup?: boolean;
}) {
  const [writeError, setWriteError] = useState('');
  const error = writeError || loadError;
  const [showAll, setShowAll] = useState(false);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [owner, setOwner] = useState('');

  async function onCreate() {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await createGoal({ project_id: projectId, title: title.trim(), target_date: targetDate || null, owner: owner || null });
      setTitle(''); setTargetDate(''); setOwner('');
      setCreating(false);
      setWriteError('');
      onReload();
    } catch (cause) {
      setWriteError(cause instanceof Error ? cause.message : t('Couldn’t create that goal.'));
    } finally {
      setSaving(false);
    }
  }

  async function onStatus(goal: CrmGoal, status: GoalStatus) {
    try {
      await updateGoal(goal.id, { status });
      setWriteError('');
      onReload();
    } catch (cause) {
      setWriteError(cause instanceof Error ? cause.message : t('Couldn’t update that goal.'));
    }
  }

  /** A goal's menu: the Mac's `showGoalMenu`, the same
   * decisions as the row's buttons. A goal has no page to open. */
  const rowMenu = useRowMenu();
  function goalMenu(goal: CrmGoal) {
    const key = `goal:${goal.id}`;
    const set = (status: GoalStatus) => () => { rowMenu.close(); void onStatus(goal, status); };
    return { rowProps: rowMenu.rowProps(key), targetProps: {}, panel: rowMenu.panel(key, <RowMenuItems kind="goal" context="row" facts={{ isOpen: goal.status === 'open' }} run={{ met: set('met'), drop: set('dropped'), reopen: set('open') }} />, { className: 'mr-1.5' }) };
  }

  const now = Date.now();
  const ordered = sortGoals(goals, now);
  const shown = showAll ? ordered : ordered.filter(isLiveGoal);

  const controls = (
    <StateActions>
      <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll((value) => !value)}>{showAll ? t('Open only') : t('Show all')}</Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(true)}>{t('New goal')}</Button>
    </StateActions>
  );
  const body = (
    <>
      {error && <ErrorNotice message={error} copyText={error} action={<Button type="button" variant="outline" size="xs" onClick={onReload}>{t('Retry')}</Button>} />}
      {creating && (
        <SheetCard className="mt-1 mb-2.5" onSubmit={(event) => { event.preventDefault(); void onCreate(); }}>
          <SheetField label={t('Goal')}>
            <Input value={title} autoFocus onChange={(event) => setTitle(event.target.value)} />
          </SheetField>
          <SheetField label={t('Target date')}>
            <DatePicker value={targetDate} onChange={setTargetDate} />
          </SheetField>
          {team.length > 0 && (
            <SearchablePicker
              label={t('Owner')}
              placeholder={t('Nobody yet')}
              options={[
                { id: '', title: t('Nobody yet') },
                // A goal's owner is a person; an agent holds tasks, not goals.
                ...team.filter((member) => member.kind !== 'agent').map((member) => ({ id: member.id, title: member.name })),
              ]}
              value={owner}
              onChange={setOwner}
              emptyMessage={t('No options match that search.')}
            />
          )}
          <SheetActions>
            <Button type="button" variant="secondary" onClick={() => setCreating(false)}>{t('Cancel')}</Button>
            <Button type="submit" disabled={saving || !title.trim()}>{t('Save')}</Button>
          </SheetActions>
        </SheetCard>
      )}
      {shown.length > 0 && (
        <ul className={railListClass} aria-label={t('Goals')}>
          {shown.map((goal) => (
            <RailRow
              key={goal.id}
              leading={<GlyphMark shape="square"><TasksIcon /></GlyphMark>}
              muted={!isLiveGoal(goal)}
              menu={goalMenu(goal)}
              title={goal.title}
              subtitle={goalMeta(goal, now)}
              trailing={(
                <StateActions>
                  {goal.status === 'open' ? (
                    <>
                      <Button type="button" variant="outline" size="sm" onClick={() => { void onStatus(goal, 'met'); }}>{t('Met')}</Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => { void onStatus(goal, 'dropped'); }}>{t('Drop')}</Button>
                    </>
                  ) : (
                    <Button type="button" variant="ghost" size="sm" onClick={() => { void onStatus(goal, 'open'); }}>{t('Reopen')}</Button>
                  )}
                </StateActions>
              )}
            />
          ))}
        </ul>
      )}
    </>
  );
  if (inGroup) {
    return <RailSection title={t('Goals')} storageKey={`work.subject-overview.project.${projectId}.goals`} accessory={controls}>{body}</RailSection>;
  }
  return (
    <section className="mb-4" aria-labelledby="work-goals-heading">
      <HeadRow>
        <PlanHead id="work-goals-heading">{t('Goals')}</PlanHead>
        {controls}
      </HeadRow>
      {body}
    </section>
  );
}

export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = {
  open: t('Open'),
  met: t('Met'),
  dropped: t('Dropped'),
};

function goalMeta(goal: CrmGoal, nowMs: number): string {
  const late = isLateGoal(goal, nowMs);
  return [
    formatDay(goal.target_date) ? (late ? t('late, {date}', { date: formatDay(goal.target_date) }) : formatDay(goal.target_date)) : null,
    goal.status === 'open' ? null : GOAL_STATUS_LABEL[goal.status],
    goal.owner_name,
  ].filter(Boolean).join(' · ');
}
