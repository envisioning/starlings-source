import { useEffect, useRef, useState } from 'react';
import type { AttentionRequest } from '@starlings/contracts/attention';
import { THREAD_POLL_SECONDS } from '@starlings/contracts/limits';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';
import { CloseIcon } from './action-icons';
import { ErrorNotice } from './ErrorNotice';
import { Markdown } from './markdown';
import { QuestionCard } from './thread-parts';
import { attentionStatus, readAttention, resolveAttention } from './attention';
import { teamThreadHref } from './work-hrefs';
import { useOwnerSession } from './owner-session';
import { t } from './i18n';

/** One canonical question, opened in Home or Work. Drafts survive open-state polls. */
export function AttentionQuestionDialog({ initial, onResolved, onClose }: {
  initial: AttentionRequest;
  onResolved: (request: AttentionRequest) => void;
  onClose: () => void;
}) {
  const [request, setRequest] = useState(initial);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  const [fresh, setFresh] = useState(false);
  const owner = useOwnerSession();
  const notify = useRef(onResolved);
  notify.current = onResolved;
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (request.state === 'open') return;
    setSelected([]);
    const key = `${request.id}:${request.revision}`;
    if (reported.current !== key) { reported.current = key; notify.current(request); }
  }, [request]);
  useEffect(() => {
    let stopped = false;
    let timer: number;
    async function refresh() {
      if (document.visibilityState === 'visible' && !submitting.current) {
        try {
          const next = await readAttention(initial.id);
          if (!stopped) { setRequest((current) => next.revision >= current.revision ? next : current); setFresh(true); setError(''); }
        } catch (cause) {
          if (!stopped) setError(cause instanceof Error ? cause.message : t('Couldn’t load this question.'));
        }
      }
      if (!stopped) timer = window.setTimeout(refresh, THREAD_POLL_SECONDS * 1_000);
    }
    const shown = () => { if (document.visibilityState === 'visible') { window.clearTimeout(timer); void refresh(); } };
    void refresh();
    document.addEventListener('visibilitychange', shown);
    return () => { stopped = true; window.clearTimeout(timer); document.removeEventListener('visibilitychange', shown); };
  }, [initial.id]);
  const canAnswer = fresh && owner.kind === 'owner'
    && owner.owner.email.toLowerCase() === request.recipient_email.toLowerCase();
  async function resolve(action: 'answer' | 'dismiss', ids = selected) {
    if (submitting.current || !canAnswer || request.state !== 'open') return;
    submitting.current = true; setBusy(true); setError('');
    try {
      const result = await resolveAttention(request.id, { action, option_ids: action === 'answer' ? ids : [] });
      setRequest(result.request); // includes a competing winner, even when accepted=false
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t submit this answer.'));
    } finally { submitting.current = false; setBusy(false); }
  }
  const origin = request.origin;
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent showCloseButton={false} aria-describedby={undefined} className="max-h-[85svh] gap-3 overflow-y-auto p-5 sm:max-w-[560px]">
      <div className="flex items-start justify-between gap-3">
        <DialogTitle>{t('Question')}</DialogTitle>
        <Button variant="ghost" size="icon" aria-label={t('Close')} disabled={busy} onClick={onClose}><CloseIcon /></Button>
      </div>
      <div className="text-base"><Markdown text={request.prompt} /></div>
      {(request.subject?.title || request.context) && <p className="m-0 text-sm text-muted-foreground">{request.subject?.title ?? request.context}</p>}
      <QuestionCard askedBy={request.asked_by} mode={request.selection_mode} options={request.options}
        status={attentionStatus(request)} waitingFor={fresh && !canAnswer ? request.recipient_email : null}
        answer={request.answer ? { by: request.answer.answered_by_email, labels: request.answer.option_labels, withdrawn: false } : null}
        selected={selected} submitting={busy} disabled={!fresh} error=""
        onSelect={(id, checked) => {
          if (request.selection_mode === 'single') { setSelected([id]); void resolve('answer', [id]); }
          else setSelected((current) => checked ? [...current.filter((value) => value !== id), id] : current.filter((value) => value !== id));
        }} onSubmit={() => { void resolve('answer'); }} />
      {error && <ErrorNotice message={error} />}
      <div className="flex flex-wrap items-center gap-2">
        {request.state === 'open' && canAnswer && <Button variant="ghost" disabled={busy} onClick={() => { void resolve('dismiss'); }}>{t('Dismiss')}</Button>}
        {origin.type === 'thread_question' && <Button variant="outline" asChild><a href={teamThreadHref(origin.thread_id, origin.message_id)}>{t('Open conversation')}</a></Button>}
      </div>
    </DialogContent>
  </Dialog>;
}
