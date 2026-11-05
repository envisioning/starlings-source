import { useEffect, useState } from 'react';
import type { CardLinesResponse, ThreadMessage } from '@starlings/contracts';
import type { AttentionRequest } from '@starlings/contracts/attention';
import { Button } from '@/ui/button';
import { apiFetch } from './api';
import { attentionStatus, fetchAttention, resolveAttention } from './attention';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { PlaceholderRows } from '@/ui/placeholder-rows';
import { RailEmpty, RailSection } from './rail-row';
import { MessageBubble, MessageHead, QuestionCard, ThreadEventRow } from './thread-parts';

/**
 * What was said about one card: the hand-off with its brief, the
 * agent's steps, its questions and the answers, and the event lines, from
 * every thread that named the card and that you can read. An agent's question
 * is answered here as in Inbox and in Talk: one answer clears all three.
 */
export function CardActivity({ refKind, refId, onOpenLine }: {
  refKind: 'task' | 'issue';
  refId: string;
  /** The line in its thread, where the whole conversation is. */
  onOpenLine?: (line: ThreadMessage) => void;
}) {
  const [lines, setLines] = useState<ThreadMessage[] | null>(null);
  const [error, setError] = useState('');
  const [requests, setRequests] = useState<Record<string, AttentionRequest>>({});
  const [selections, setSelections] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState<Set<string>>(() => new Set());
  const [answerErrors, setAnswerErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    setLines(null);
    setError('');
    setRequests({});
    const query = new URLSearchParams({ kind: refKind, id: refId });
    void apiFetch<CardLinesResponse>(`/card-lines?${query}`, { noStore: true, fallbackError: t('Couldn’t load what was said about this.') })
      .then(async (response) => {
        if (!live) return;
        setLines(response.lines);
        // A question's state is the attention request Inbox answers, read per thread.
        const threads = [...new Set(response.lines.filter((line) => line.question).map((line) => line.thread_id))];
        const pages = await Promise.all(threads.map((threadID) => fetchAttention({ thread_id: threadID, state: 'all' }).catch(() => null)));
        if (!live) return;
        const next: Record<string, AttentionRequest> = {};
        for (const request of pages.flatMap((page) => page?.requests ?? [])) {
          if (request.origin.type !== 'thread_question') continue;
          const previous = next[request.origin.message_id];
          if (!previous || request.revision >= previous.revision) next[request.origin.message_id] = request;
        }
        setRequests(next);
      })
      .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : t('Couldn’t load what was said about this.')); });
    return () => { live = false; };
  }, [refKind, refId]);

  async function answer(messageID: string, optionIDs: string[]) {
    const request = requests[messageID];
    if (!request || optionIDs.length === 0) return;
    setSubmitting((current) => new Set(current).add(messageID));
    setAnswerErrors((current) => ({ ...current, [messageID]: '' }));
    try {
      const result = await resolveAttention(request.id, { action: 'answer', option_ids: optionIDs });
      setRequests((current) => ({ ...current, [messageID]: result.request }));
      setSelections((current) => ({ ...current, [messageID]: [] }));
    } catch (cause) {
      setAnswerErrors((current) => ({ ...current, [messageID]: cause instanceof Error ? cause.message : t('Couldn’t submit this answer.') }));
    } finally {
      setSubmitting((current) => { const next = new Set(current); next.delete(messageID); return next; });
    }
  }

  function select(line: ThreadMessage, optionID: string, checked: boolean) {
    if (line.question?.mode === 'single') { void answer(line.id, [optionID]); return; }
    setSelections((current) => {
      const chosen = new Set(current[line.id] ?? []);
      if (checked) chosen.add(optionID); else chosen.delete(optionID);
      return { ...current, [line.id]: [...chosen] };
    });
  }

  return (
    <RailSection title={t('Activity')} storageKey="work.card.activity" count={lines?.length}>
      {error && <ErrorNotice message={error} copyText={error} />}
      {!error && lines === null && <PlaceholderRows count={2} glyph={false} label={t('Loading activity…')} />}
      {!error && lines?.length === 0 && <RailEmpty>{t('Nothing said about this yet.')}</RailEmpty>}
      {!error && lines && lines.length > 0 && (
        <ul className="m-0 grid list-none gap-3 p-0">
          {lines.map((line) => {
            const sender = line.sender_name ?? line.sender_email;
            if (line.type === 'event') {
              return <ThreadEventRow key={line.id} text={line.text} />;
            }
            const request = requests[line.id];
            return (
              <li key={line.id} className="grid gap-1">
                <MessageHead sender={sender} sentAt={line.sent_at} />
                <MessageBubble mine={line.is_mine} withdrawn={Boolean(line.deleted_at)} text={line.text} mentions={line.mentions ?? []} />
                {line.question && !line.deleted_at && (
                  <QuestionCard
                    askedBy={sender}
                    mode={line.question.mode}
                    options={line.question.options}
                    status={request ? attentionStatus(request) : t('Answer it in Talk.')}
                    disabled={!request}
                    answer={request?.answer ? { by: request.answer.answered_by_email, labels: request.answer.option_labels, withdrawn: false } : null}
                    selected={selections[line.id] ?? []}
                    submitting={submitting.has(line.id)}
                    error={answerErrors[line.id] ?? ''}
                    onSelect={(optionID, checked) => select(line, optionID, checked)}
                    onSubmit={() => void answer(line.id, selections[line.id] ?? [])}
                  />
                )}
                {onOpenLine && (
                  <Button type="button" variant="link" size="sm" className="h-auto justify-self-start p-0 text-xs text-muted-foreground hover:text-foreground" onClick={() => onOpenLine(line)}>
                    {t('Open in Talk')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </RailSection>
  );
}
