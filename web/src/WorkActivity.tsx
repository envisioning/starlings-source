import type { InboxRecentEntry } from '@starlings/contracts/inbox';
import { Button } from '@/ui/button';
import { RailRow, RailSection, railBlockProps } from './SurfaceShell';
import { railListClass } from './rail-list';
import { GlyphMark } from './SubjectMark';
import { InteractionIcon } from './action-icons';
import { ClockIcon } from 'lucide-react';
import { ErrorNotice } from './ErrorNotice';
import { formatTime } from './meeting-time';
import { dateLocale, t } from './i18n';

/** Catch up without adding items to the response queue or its badge. */
export function WorkActivity({ entries, partial, failed, onRetry, onOpen }: {
  entries: InboxRecentEntry[] | null;
  partial: string[];
  failed: boolean;
  onRetry: () => void;
  onOpen: (subject: InboxRecentEntry['subject']) => void;
}) {
  return <RailSection title={t('Activity')} {...railBlockProps('workOverview', 'activity')}>
    <p className="mx-2 text-xs text-muted-foreground">{t('Latest 30 entries · Past 7 days')}</p>
    {entries === null && !failed ? <p className="lede" role="status">{t('Loading…')}</p> : null}
    <ul className={railListClass} aria-label={t('Activity')}>
      {(entries ?? []).map((entry) => {
        const at = entry.date ? new Date(entry.date) : null;
        const timestamp = at && !Number.isNaN(at.valueOf())
          ? `${at.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short' })} · ${formatTime(at)}` : null;
        return <RailRow key={entry.id} leading={<GlyphMark>{entry.type === 'event' ? <ClockIcon size={16} aria-hidden /> : <InteractionIcon type={entry.type} />}</GlyphMark>}
          title={entry.title} subtitle={[entry.subject.title, timestamp].filter(Boolean).join(' · ')}
          onSelect={() => onOpen(entry.subject)} />;
      })}
    </ul>
    {entries && entries.length === 0 && partial.length === 0 && !failed ? <p className="lede">{t('No activity this week.')}</p> : null}
    {partial.length > 0 || failed ? <ErrorNotice inline role="status"
      message={t('Couldn’t read some activity. Refresh to try again.')}
      action={<Button type="button" variant="outline" size="xs" onClick={onRetry}>{t('Retry')}</Button>} /> : null}
  </RailSection>;
}
