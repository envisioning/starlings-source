import { useState } from 'react';
import type { DecisionAsk } from '@starlings/contracts/decision-asks';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';
import { Textarea } from '@/ui/textarea';
import { Spinner } from '@/ui/spinner';
import { cn } from '@/lib/utils';
import { CloseIcon } from './action-icons';
import { answerDecisionAsk } from './crm-work';
import { editorDialogClass, editorHeaderClass, editorTitleClass } from './editor-dialog';
import { ErrorNotice } from './ErrorNotice';
import { decisionDefaultByLabel } from './inbox-rows';
import { Markdown } from './markdown';
import { t } from './i18n';

/**
 * One decision waiting on you, opened from its INBOX row: the agent's
 * context and links, one button per option with the recommendation marked,
 * and an optional note. Choosing an option answers it. The Mac's sheet and
 * the phone's sheet draw the same things (docs/help/howto/answer-a-decision.md).
 */
export function DecisionDialog({ ask, onAnswered, onClose }: {
  ask: DecisionAsk;
  onAnswered: (ask: DecisionAsk) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function answer(key: string) {
    if (busy) return;
    setBusy(key);
    setError('');
    try {
      onAnswered(await answerDecisionAsk(ask.id, key, note));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t answer that decision.'));
      setBusy(null);
    }
  }

  const meta = [
    ask.overdue ? t('Overdue') : null,
    decisionDefaultByLabel(ask),
    ask.subject?.title ?? null,
  ].filter(Boolean).join(' · ');

  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent
      showCloseButton={false}
      aria-describedby={undefined}
      className={cn(editorDialogClass, 'gap-3 bg-card p-5 sm:max-w-[560px]')}
    >
      <div className={editorHeaderClass}>
        <DialogTitle asChild><h2 className={cn(editorTitleClass, 'text-[clamp(20px,3vw,28px)]')}>{ask.question}</h2></DialogTitle>
        <Button type="button" variant="ghost" size="icon" className="rounded-full text-muted-foreground" aria-label={t('Close')} disabled={busy !== null} onClick={onClose}><CloseIcon /></Button>
      </div>
      <p className="m-0 text-sm font-semibold">{t('Asked by {who}', { who: ask.asked_by })}</p>
      <p className={cn('m-0 text-sm', ask.overdue ? 'text-destructive' : 'text-muted-foreground')}>{meta}</p>
      {error && <ErrorNotice message={error} />}
      {ask.context && <div className="text-sm"><Markdown text={ask.context} /></div>}
      {ask.links.length > 0 && (
        <ul className="m-0 grid list-none gap-1 p-0 text-sm" aria-label={t('Links')}>
          {ask.links.map((link) => (
            <li key={link.url}><a href={link.url} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">{link.title || link.url}</a></li>
          ))}
        </ul>
      )}
      <Textarea
        rows={2}
        maxLength={2000}
        value={note}
        placeholder={t('Note (optional)')}
        aria-label={t('Note (optional)')}
        className="resize-y"
        disabled={busy !== null}
        onChange={(event) => setNote(event.target.value)}
      />
      <p className="mb-0 mt-1 text-sm text-muted-foreground">{t('Choose an option to send your answer.')}</p>
      <div className="grid gap-2" role="group" aria-label={t('Answer')}>
        {ask.options.map((option) => {
          const recommended = option.key === ask.recommendation;
          return (
            <Button
              key={option.key}
              type="button"
              variant="outline"
              className="h-auto min-h-12 w-full justify-between gap-3 whitespace-normal px-4 py-3 text-left"
              disabled={busy !== null}
              aria-label={recommended ? t('{label}, recommended', { label: option.label }) : option.label}
              onClick={() => { void answer(option.key); }}
            >
              {busy === option.key && <Spinner aria-hidden />}
              <span className="min-w-0 break-words">{option.label}</span>
              {recommended && <span className="shrink-0 rounded-md bg-secondary px-2 py-1 text-xs">{t('Recommended')}</span>}
            </Button>
          );
        })}
      </div>
    </DialogContent>
  </Dialog>;
}

