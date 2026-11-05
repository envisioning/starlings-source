import { useId, useState } from 'react';
import type { CalendarQuickAddResponse } from '@starlings/contracts';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Button } from '@/ui/button';
import { Spinner } from '@/ui/spinner';
import { apiFetch } from './api';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { localTimeZone } from './meeting-time';
import { localDateTime } from './calendar-editor-model';
import { CloseIcon } from './action-icons';
import { cn } from '@/lib/utils';
import { editorDialogClass, editorHeaderClass, editorTitleClass } from './editor-dialog';

/**
 * Quick add event…: one line, read by the shared grammar (the
 * notes engine when it read no date), then New event opens filled in for
 * review and Save. What it understood is said in that form, not here.
 */
export function CalendarQuickAdd({ onRead, onClose }: {
  onRead: (answer: CalendarQuickAddResponse) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [sentence, setSentence] = useState('');
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');

  async function read() {
    const typed = sentence.trim();
    if (!typed || reading) return;
    setReading(true);
    setError('');
    try {
      const answer = await apiFetch<CalendarQuickAddResponse>('/calendar/quick-add', {
        method: 'POST',
        body: { sentence: typed, now: localDateTime(new Date()), time_zone: localTimeZone(), default_duration_minutes: 60 },
        fallbackError: t('Couldn’t read that.'),
        noStore: true,
      });
      onRead(answer);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t read that.'));
    } finally {
      setReading(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !reading) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className={cn(editorDialogClass, 'gap-3 bg-card p-5 sm:max-w-[520px]')}
        // Focus starts in the field, not on Close, so Enter reads the sentence.
        onOpenAutoFocus={(event) => {
          const field = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('input');
          if (!field) return;
          event.preventDefault();
          field.focus();
        }}
      >
        <form className="m-0" onSubmit={(event) => { event.preventDefault(); void read(); }}>
          <div className={editorHeaderClass}>
            <DialogTitle asChild><h2 className={editorTitleClass}>{t('Quick add event')}</h2></DialogTitle>
            <Button type="button" variant="ghost" size="icon" className="rounded-full text-muted-foreground" aria-label={t('Close')} disabled={reading} onClick={onClose}>
              <CloseIcon />
            </Button>
          </div>
          {error && <ErrorNotice message={error} />}
          <span className="flex items-center gap-2">
            <Input
              id={id}
              maxLength={500}
              aria-label={t('Quick add event…')}
              placeholder={t('Coffee with Ana Thu 14:00 at Ground, 45 min')}
              value={sentence}
              disabled={reading}
              className="flex-1"
              onChange={(change) => setSentence(change.target.value)}
            />
            <Button type="submit" disabled={reading || !sentence.trim()}>{reading && <Spinner aria-hidden />}{reading ? t('Reading…') : t('Next')}</Button>
          </span>
        </form>
      </DialogContent>
    </Dialog>
  );
}
