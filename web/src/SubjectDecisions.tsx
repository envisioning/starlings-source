import { formatDay } from './meeting-time';
import { useCallback, useEffect, useState } from 'react';
import { railListClass } from './rail-list';
import { Textarea } from '@/ui/textarea';
import { Button } from '@/ui/button';
import type { CrmDecision, CrmGoal } from '@starlings/contracts/goals-decisions';
import { ErrorNotice } from './ErrorNotice';
import { RailRow, RailSection } from './SurfaceShell';
import { OVERVIEW_GROUP_ROWS } from './SubjectOverview';
import { GlyphMark } from './SubjectMark';
import { NoteIcon } from './action-icons';
import { createDecision, fetchDecisions, type CrmSubject } from './crm-work';
import { t } from './i18n';
import { HeadRow, PlanHead, SheetActions, SheetCard, SheetField, StateActions } from './work-parts';
import { SearchablePicker } from './SearchablePicker';

/**
 * A subject's decisions, at the top of its History: what the
 * team settled, newest first. A decision is written once; the channel line
 * the route writes is the record of who and when.
 */
export function SubjectDecisions({ subject, goals, inGroup = false, onShowAll }: {
  subject: CrmSubject;
  /** Open goals on the subject, when it is a project: a decision may cite one. */
  goals: CrmGoal[];
  /** Drawn as a foldable group of the subject's Overview: the newest few, and Show all. */
  inGroup?: boolean;
  onShowAll?: () => void;
}) {
  const [decisions, setDecisions] = useState<CrmDecision[]>([]);
  const [error, setError] = useState('');
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [body, setBody] = useState('');
  const [goalId, setGoalId] = useState('');

  const load = useCallback(async () => {
    try {
      setDecisions(await fetchDecisions(subject));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t load decisions.'));
    }
  }, [subject]);

  useEffect(() => { void load(); }, [load]);

  async function onRecord() {
    if (!body.trim()) return;
    setSaving(true);
    try {
      await createDecision({ subject_kind: subject.kind, subject_id: subject.id, body: body.trim(), source: 'manual', goal_id: goalId || null });
      setBody(''); setGoalId('');
      setRecording(false);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t record that decision.'));
    } finally {
      setSaving(false);
    }
  }

  const goalTitle = (id: string | null) => (id ? goals.find((goal) => goal.id === id)?.title ?? null : null);

  const controls = (
    <StateActions>
      {inGroup && onShowAll && decisions.length > OVERVIEW_GROUP_ROWS && (
        <Button type="button" variant="ghost" size="sm" onClick={onShowAll}>{t('Show all')}</Button>
      )}
      <Button type="button" variant="outline" size="sm" onClick={() => setRecording(true)}>{t('Record decision')}</Button>
    </StateActions>
  );
  const shown = inGroup ? decisions.slice(0, OVERVIEW_GROUP_ROWS) : decisions;
  const content = (
    <>
      {error && <ErrorNotice message={error} copyText={error} action={<Button type="button" variant="outline" size="xs" onClick={() => void load()}>{t('Retry')}</Button>} />}
      {recording && (
        <SheetCard className="mt-1 mb-2.5" onSubmit={(event) => { event.preventDefault(); void onRecord(); }}>
          <SheetField label={t('Decision')}>
            <Textarea rows={3} value={body} autoFocus onChange={(event) => setBody(event.target.value)} />
          </SheetField>
          {goals.length > 0 && (
            <SearchablePicker
              label={t('Goal')}
              placeholder={t('None')}
              options={[
                { id: '', title: t('None') },
                ...goals.map((goal) => ({ id: goal.id, title: goal.title })),
              ]}
              value={goalId}
              onChange={setGoalId}
              emptyMessage={t('No options match that search.')}
            />
          )}
          <SheetActions>
            <Button type="button" variant="secondary" onClick={() => setRecording(false)}>{t('Cancel')}</Button>
            <Button type="submit" disabled={saving || !body.trim()}>{t('Save')}</Button>
          </SheetActions>
        </SheetCard>
      )}
      {shown.length > 0 && (
        <ul className={railListClass} aria-label={t('Decisions')}>
          {shown.map((decision) => (
            <RailRow
              key={decision.id}
              leading={<GlyphMark shape="square"><NoteIcon /></GlyphMark>}
              title={decision.body}
              subtitle={[
                formatDay(decision.decided_at),
                decision.decided_by_name,
                decision.source === 'agent' ? t('via {client}', { client: decision.source_ref ?? 'Claude' }) : null,
                goalTitle(decision.goal_id),
              ].filter(Boolean).join(' · ')}
            />
          ))}
        </ul>
      )}
    </>
  );
  if (inGroup) {
    return <RailSection title={t('Decisions')} storageKey={`work.subject-overview.${subject.kind}.${subject.id}.decisions`} count={decisions.length} accessory={controls}>{content}</RailSection>;
  }
  return (
    <section className="mb-4" aria-labelledby="work-decisions-heading">
      <HeadRow>
        <PlanHead id="work-decisions-heading">{t('Decisions')}</PlanHead>
        {controls}
      </HeadRow>
      {content}
    </section>
  );
}
