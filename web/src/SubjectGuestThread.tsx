import { useEffect, useState } from 'react';
import { RailSection } from './SurfaceShell';
import { t } from './i18n';
import { readSubjectAccess } from './subject-access-api';
import { ThreadPane } from './ThreadPane';

/**
 * A subject's guest thread on its Overview (docs/ACCESS.md slice 4): the one
 * thread members share with the guests and organizations granted on the
 * subject. Drawn only once one exists; the subject's own Talk stays members
 * only. `refreshKey` reloads it after the Share dialog changes access.
 */
export function SubjectGuestThread({ subject, refreshKey = 0 }: { subject: { kind: string; id: string }; refreshKey?: number }) {
  const [threadId, setThreadId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    readSubjectAccess(subject).then(
      (access) => { if (!cancelled) setThreadId(access.guest_thread_id); },
      // A subject this member cannot read the access of draws no guest thread.
      () => { if (!cancelled) setThreadId(null); },
    );
    return () => { cancelled = true; };
  }, [subject.kind, subject.id, refreshKey]);

  if (!threadId) return null;
  return (
    <RailSection title={t('Guests')} storageKey={`work.subject-overview.${subject.kind}.${subject.id}.guests`}>
      <p className="mb-2 text-xs text-muted-foreground">{t('Guests read this thread.')}</p>
      <ThreadPane key={threadId} threadID={threadId} title={t('Guests')} />
    </RailSection>
  );
}
