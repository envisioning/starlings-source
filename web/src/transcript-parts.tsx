import { useState } from 'react';
import type { MeetingDecisionCandidate, TranscriptSegment } from '@starlings/contracts';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/ui/item';
import { cn } from '@/lib/utils';
import { ErrorNotice } from './ErrorNotice';
import { Note, SectionCard } from './SectionCard';
import { t } from './i18n';

/*
 * The words of a meeting as the workspace draws them: a caption line on the
 * call, the transcript's lines, and the decisions offered from it. No data
 * of their own. TranscriptPage and the call's panel load the data; the
 * product site draws the same parts with a sample meeting, so this module
 * must not import a session, an API client or livekit.
 */

/** One spoken line on the call. 720 wide keeps it a line and not a ruler (#210). */
export function CaptionLine({ speaker, text, final }: { speaker: string; text: string; final: boolean }) {
  return (
    <div
      className={cn(
        'flex max-w-[720px] items-baseline gap-2.5 rounded-[6px] border border-solid border-border bg-background px-2.5 py-1.5 text-foreground max-[640px]:flex-col max-[640px]:gap-0.5',
        !final && 'opacity-72',
      )}
    >
      <strong className="text-xs font-semibold whitespace-nowrap text-[var(--text-muted)]">{speaker}</strong>
      <span className="text-[15px] leading-[1.4]">{text}</span>
    </div>
  );
}

/** The transcript's lines: time, speaker, words. A click selects a line;
 * shift extends the range; the speaker's name renames them everywhere. */
export function TranscriptLines({ lines, selected, readOnly, onToggle, onRename }: {
  lines: TranscriptSegment[];
  selected: ReadonlySet<string>;
  readOnly: boolean;
  onToggle: (line: TranscriptSegment, shift: boolean) => void;
  onRename: (line: TranscriptSegment) => void;
}) {
  return (
    <ol className="m-0 list-none p-0">
      {lines.map((line) => (
        <li
          key={line.id}
          className={cn(
            'grid cursor-pointer grid-cols-[20px_52px_140px_minmax(0,1fr)] items-baseline gap-2.5 rounded-md px-2 py-1.5 select-none hover-lift max-sm:grid-cols-[20px_52px_minmax(0,1fr)]',
            selected.has(line.id) && 'bg-[rgb(var(--muted-rgb)/0.18)]',
          )}
          onClick={readOnly ? undefined : (event) => onToggle(line, event.shiftKey)}
        >
          {!readOnly && <Checkbox checked={selected.has(line.id)} onClick={(event) => { event.stopPropagation(); onToggle(line, event.shiftKey); }} aria-label={t('Select line by {speaker_name}', { speaker_name: line.speaker_name })} />}
          <span className={TIME}>{clock(line.starts_at_ms)}</span>
          {readOnly
            ? <span className={cn(SPEAKER, 'font-semibold')}>{line.speaker_name}</span>
            : (
              // shadcn: a speaker name that reads as text
              <button type="button" className={cn(SPEAKER, 'cursor-text border-0 bg-transparent p-0 text-left text-inherit hover:underline hover:decoration-dotted')} onClick={(event) => { event.stopPropagation(); onRename(line); }}>
                {/* The page's button rule sets `font: inherit`, so the weight sits on the text. */}
                <span className="font-semibold">{line.speaker_name}</span>
              </button>
            )}
          <span className="select-text max-sm:[grid-column:2/-1]">{line.text}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * What the notes proposed as settled, each with its line, and
 * the owner's answer: Record writes the decision on the meeting's subject
 * with the meeting as its source; Dismiss puts it away. Answered rows stay
 * as a short receipt; an unfiled meeting offers Dismiss only, since there is
 * no subject to record on yet.
 */
export function DecisionCandidates({ candidates, filed, answer }: {
  candidates: MeetingDecisionCandidate[];
  filed: boolean;
  answer: (index: number, accept: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');
  const open = candidates.filter((candidate) => !candidate.decision_id && !candidate.dismissed);
  const recorded = candidates.filter((candidate) => candidate.decision_id);
  if (open.length === 0 && recorded.length === 0) return null;
  async function run(index: number, accept: boolean) {
    setBusy(index);
    try {
      await answer(index, accept);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Couldn’t record that decision.'));
    } finally {
      setBusy(null);
    }
  }
  return (
    <SectionCard id="transcript-decisions-heading" title={t('Decisions')}>
      {error && <ErrorNotice message={error} />}
      {!filed && open.length > 0 && <Note>{t('File the meeting under a project or lead to record these.')}</Note>}
      <ItemGroup className="gap-2" aria-label={t('Decisions')}>
        {candidates.map((candidate, index) => {
          if (candidate.dismissed) return null;
          const answered = Boolean(candidate.decision_id);
          return (
            <Item key={index} role="listitem" variant="outline" size="sm" className="flex-nowrap items-start">
              <ItemContent className="min-w-0">
                <ItemTitle className="w-auto font-normal">{candidate.what}</ItemTitle>
                {candidate.quote && (
                  <ItemDescription className="line-clamp-none text-xs">
                    {candidate.at_ms !== null && <span className={TIME}>{clock(candidate.at_ms)}</span>} “{candidate.quote}”
                  </ItemDescription>
                )}
              </ItemContent>
              <ItemActions className="gap-1">
                {answered ? (
                  <Badge variant="secondary">{t('Recorded')}</Badge>
                ) : (
                  <>
                    <Button type="button" variant="outline" size="sm" disabled={!filed || busy !== null} onClick={() => { void run(index, true); }}>{t('Record')}</Button>
                    <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => { void run(index, false); }}>{t('Dismiss')}</Button>
                  </>
                )}
              </ItemActions>
            </Item>
          );
        })}
      </ItemGroup>
    </SectionCard>
  );
}

/** A line's offset into the meeting, in the transcript and beside a quote. */
const TIME = 'text-xs text-muted-foreground tabular-nums';
/** The speaker column: one line, cut with an ellipsis; below 640px it moves to the third column. */
const SPEAKER = 'block min-w-0 truncate max-sm:[grid-column:3]';

export function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
