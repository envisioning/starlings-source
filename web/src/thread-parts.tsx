import type { ComponentProps, ReactNode } from 'react';
import { Check, KeyRound } from 'lucide-react';
import { GatheringDots } from './GatheringDots';
import { Avatar, AvatarFallback, AvatarImage } from '@/ui/avatar';
import { Button } from '@/ui/button';
import { ErrorNotice } from './ErrorNotice';
import { Item, ItemActions, ItemContent, ItemMedia } from '@/ui/item';
import { cn } from '@/lib/utils';
import { Markdown } from './markdown';
import { formatTime } from './meeting-time';
import { plural, t } from './i18n';

/*
 * The lines of a conversation as ThreadPane draws them: a turn, its head,
 * its bubble, an event line, an agent's question, an agent's Keep release
 * request and an agent at work. No
 * data of their own. ThreadPane loads, sends and answers; the product site
 * draws the same lines with a sample conversation, so this module must not
 * import a session, an API client or a store.
 */

/** A face: the initials stand until the picture loads, and stay if it never does. */
export function ThreadAvatarFace({ name, src }: { name: string; src?: string }) {
  const words = name.split(/[\s@._-]+/u).filter(Boolean);
  const initials = (words.slice(0, 2).map(word => word[0] ?? '').join('') || name.slice(0, 2)).toUpperCase();
  return (
    <Avatar className="mt-0.5 size-7 flex-none border" aria-hidden="true">
      {src && <AvatarImage src={src} alt="" />}
      <AvatarFallback className="bg-popover text-[0.68rem] font-semibold text-muted-foreground">{initials}</AvatarFallback>
    </Avatar>
  );
}

/**
 * One turn. Theirs on the left behind a face, yours on the right with none:
 * you know who you are. A grouped line keeps the face's indent so the text
 * stays under the text above it. A new turn gets a clear gap above it and a
 * following line from the same person a small one.
 */
export function MessageTurn({ mine, grouped, avatar, className, children, ...props }: ComponentProps<'li'> & {
  mine: boolean;
  grouped: boolean;
  avatar: ReactNode;
}) {
  return (
    <li {...props} className={cn('flex items-start gap-2 pt-3 pb-0.5', grouped && 'pt-1', mine && 'justify-end', className)}>
      {!mine && (grouped ? <span className="w-7 flex-none" aria-hidden="true" /> : avatar)}
      <div className={cn('flex max-w-[min(42rem,82%)] min-w-0 flex-col items-start', mine && 'items-end')}>
        {children}
      </div>
    </li>
  );
}

/** Who and when over a turn; yours has no name. `notes` follow the time: edited, from Slack, via a client. */
export function MessageHead({ sender, sentAt, notes = [] }: {
  sender: string | null;
  sentAt: string | number | Date;
  notes?: ReadonlyArray<string | false | null | undefined | ''>;
}) {
  const at = new Date(sentAt);
  return (
    <small className="text-muted-foreground">
      {sender && <><b className="text-foreground">{sender}</b>{' '}</>}
      <time dateTime={at.toISOString()}>{formatTime(at)}</time>
      {notes.filter(Boolean).map((note) => ` · ${note}`)}
    </small>
  );
}

/**
 * The words of a turn. A Meet shape on theme tokens: no shadcn chat bubble
 * exists. It takes the width its words need; yours is tinted. Still being
 * written (partial): dashed. Agents answer in Markdown and people type it, so
 * it renders as React nodes, never as markup (markdown.tsx).
 */
export function MessageBubble({ mine, partial = false, withdrawn = false, text, mentions = [], focusable = false }: {
  mine: boolean;
  partial?: boolean;
  withdrawn?: boolean;
  text: string;
  mentions?: string[];
  /** The bubble is the row's focus target when the row has a menu. */
  focusable?: boolean;
}) {
  return (
    <div
      data-bubble=""
      className={cn(
        'max-w-full rounded-xl border border-border bg-popover px-3 py-1.5 focus:outline-2 focus:outline-offset-2 focus:outline-ring',
        mine && 'border-primary/30 bg-primary/15',
        partial && 'border-dashed',
      )}
      data-home-row={focusable ? '' : undefined}
      tabIndex={focusable ? -1 : undefined}
    >
      {withdrawn
        ? <p className="m-0 text-muted-foreground italic">{t('Message withdrawn')}</p>
        : <Markdown text={text} mentions={mentions} />}
    </div>
  );
}

/**
 * An event in the conversation (a meeting filed, an issue opened): a muted
 * Item row; each ref is a chip in `actions`, not a second sentence.
 */
export function ThreadEventRow({ text, actions }: { text: string; actions?: ReactNode }) {
  return (
    <Item asChild variant="muted" size="sm" className="my-1 gap-2 px-3 py-2 text-muted-foreground">
      <li>
        <ItemContent className="min-w-0">
          <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</p>
        </ItemContent>
        {actions && <ItemActions className="flex-wrap gap-1">{actions}</ItemActions>}
      </li>
    </Item>
  );
}

/**
 * An agent's question with its options. Single choice answers on the click;
 * multiple choice collects, then Submit answer. Once answered it shows who
 * answered and what.
 */
export function QuestionCard({ askedBy, mode, options, answer, selected, submitting, error, disabled = false, status = null, waitingFor = null, onSelect, onSubmit }: {
  disabled?: boolean;
  status?: string | null;
  waitingFor?: string | null;
  askedBy: string;
  mode: 'single' | 'multiple';
  options: ReadonlyArray<{ id: string; label: string }>;
  answer: { by: string; labels: readonly string[]; withdrawn: boolean } | null;
  selected: readonly string[];
  submitting: boolean;
  error: string;
  onSelect: (optionID: string, checked: boolean) => void;
  onSubmit: () => void;
}) {
  return (
    <section aria-label={t('Interactive question')} className="mt-2 w-full rounded-lg border border-border bg-muted/40 p-3">
      <p className="mb-1 mt-0 text-sm font-semibold">{t('Asked by {who}', { who: askedBy })}</p>
      <p className="mb-2 mt-0 text-xs text-muted-foreground">
        {mode === 'single' ? t('Choose one option') : t('Choose all that apply')}
      </p>
      {status && !answer ? <p role="status" className="m-0 text-sm text-muted-foreground">{status}</p> : waitingFor && !answer ? <p role="status" className="m-0 text-sm text-muted-foreground">{t('Waiting on {who}', { who: waitingFor })}</p> : answer ? (
        <div role="status">
          {answer.withdrawn
            ? <p className="m-0 text-xs text-muted-foreground">{t('Answer withdrawn.')}</p>
            : <>
              <p className="m-0 text-xs text-muted-foreground">{t('Answered by {name}', { name: answer.by })}</p>
              <ul className="mb-0 mt-1 list-disc ps-5">{answer.labels.map((label) => <li key={label}>{label}</li>)}</ul>
            </>}
        </div>
      ) : (
        <>
          <fieldset className="m-0 grid gap-2 border-0 p-0" disabled={submitting || disabled}>
            <legend className="sr-only">{t('Interactive question options')}</legend>
            {options.map((option) => <Button
              key={option.id}
              type="button"
              variant="outline"
              data-option={option.id}
              className={cn('h-auto min-h-11 w-full justify-start whitespace-normal px-3 py-3 text-left', selected.includes(option.id) && 'border-ring bg-secondary')}
              aria-pressed={selected.includes(option.id)}
              onClick={() => onSelect(option.id, mode === 'single' || !selected.includes(option.id))}
            >
              <span className="min-w-0 flex-1 break-words">{option.label}</span>
              {selected.includes(option.id) && <Check aria-hidden="true" />}
            </Button>)}
          </fieldset>
          {error && <ErrorNotice message={error} inline className="mt-2 text-sm" />}
          {mode === 'multiple'
            ? <Button type="button" variant="default" size="lg" className="mt-3 h-11 min-w-36" disabled={!selected.length || submitting || disabled} onClick={onSubmit}>
              {submitting ? t('Submitting…') : t('Submit answer')}
            </Button>
            : submitting
              ? <p role="status" className="mb-0 mt-2 text-sm text-muted-foreground">{t('Submitting…')}</p>
              : null}
        </>
      )}
    </section>
  );
}

/** How long a release lasts, in words: minutes under an hour, else hours. */
export function releaseDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return plural(minutes, { one: '{count} minute', other: '{count} minutes' });
  return plural(Math.round(minutes / 60), { one: '{count} hour', other: '{count} hours' });
}

/**
 * An agent's request for one Keep item, read-only. Keep's key never
 * enters a browser tab in Meet, so the web never approves: it says where to.
 * The card names the item and the task, never a value.
 */
export function ReleaseRequestCard({ askedBy, request, state, now }: {
  askedBy: string;
  request: { vault: string; item: string; task: string; reason: string; expires_in_seconds?: number | undefined };
  state: { status: string; approver_email: string; approver_name: string | null; expires_at: number; item_name: string; ended_by_email?: string | undefined } | null;
  now: number;
}) {
  const approver = state ? (state.approver_name || state.approver_email) : '';
  const status = !state
    ? t('Approve on Mac or iPhone.')
    : state.status === 'ended'
      ? t('Ended by {name}.', { name: state.ended_by_email ?? approver })
      : state.status === 'used'
        ? t('Used. Approved by {name}.', { name: approver })
        : state.expires_at <= now
          ? t('Expired. Approved by {name}.', { name: approver })
          : t('Approved by {name} until {time}.', { name: approver, time: formatTime(new Date(state.expires_at)) });
  return (
    <section aria-label={t('Keep request')} className="mt-2 w-full rounded-lg border border-border bg-muted/40 p-3">
      <p className="mb-2 mt-0 flex items-center gap-1.5 text-sm font-semibold">
        <KeyRound aria-hidden="true" className="size-4 flex-none text-muted-foreground" />
        <span className="min-w-0 break-words">{t('{who} asks for {item}', { who: askedBy, item: state?.item_name ?? request.item })}</span>
      </p>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t('Vault')}</dt>
        <dd className="m-0 min-w-0 break-words">{request.vault}</dd>
        <dt className="text-muted-foreground">{t('Task')}</dt>
        <dd className="m-0 min-w-0 break-words">{request.task}</dd>
        <dt className="text-muted-foreground">{t('Why')}</dt>
        <dd className="m-0 min-w-0 break-words">{request.reason}</dd>
        {request.expires_in_seconds !== undefined && <>
          <dt className="text-muted-foreground">{t('Asked for')}</dt>
          <dd className="m-0">{releaseDuration(request.expires_in_seconds)}</dd>
        </>}
      </dl>
      <p role="status" className="mb-0 mt-2 text-sm text-muted-foreground">{status}</p>
    </section>
  );
}

/**
 * An agent's turn in flight: a muted Item pinned to the bottom, replaced the
 * moment the real reply lands. Not a bubble. `step` is the latest step, in
 * the agent's own words.
 */
export function AgentWorkingRow({ name, elapsed, step }: { name: string; elapsed?: string | null; step?: string | null }) {
  const label = t('{name} is working', { name });
  return (
    <Item asChild variant="muted" size="sm" className="mt-3 gap-2 px-3 py-2 text-muted-foreground">
      <li aria-label={label}>
        <ItemMedia>
          <GatheringDots motion="thinking" className="size-5 flex-none" />
        </ItemMedia>
        <ItemContent className="min-w-0 gap-0.5">
          <span>
            {label}
            {elapsed && <> · <span className="tabular-nums">{elapsed}</span></>}
          </span>
          {step && <span className="truncate text-xs opacity-75">{step}</span>}
        </ItemContent>
      </li>
    </Item>
  );
}
