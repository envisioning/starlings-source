import { useMemo, useRef, useState } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';
import { cn } from '@/lib/utils';
import { SendIcon } from '@shared/action-icons';
import { composerFieldClass, composerSendClass } from '@shared/composer-send';
import { AgentAvatar } from '@shared/peer-face';
import { RailRow, surfacePanelClass } from '@shared/rail-row';
import { railListClass } from '@shared/rail-list';
import { SubjectMark } from '@shared/SubjectMark';
import { AgentWorkingRow, MessageBubble, MessageHead, MessageTurn, QuestionCard, ThreadAvatarFace, ThreadEventRow } from '@shared/thread-parts';
import { SimStage } from './SimStage';
import { useScript, type Beat } from './use-script';
import { useSampleMeeting } from './sample-meeting';
import { SAMPLE_THREADS, useSampleThreads, type SampleThread, type ThreadLine } from './sample-threads';

/*
 * Conversations with agents and people, as Team and Work draw them: the list
 * on the left, the open conversation on the right. Every line is the
 * workspace's own part (thread-parts.tsx) and every agent face is its seeded
 * identity (agent-avatar-values). The tour opens each agent's conversation
 * and plays its work out; an agent Starlings cannot pair with yet carries
 * Planned, from its row in AGENT_ECOSYSTEM.
 */

type State = {
  open: string;
  /** Lines shown per conversation. */
  shown: Record<string, number>;
  /** Questions answered, by conversation. */
  answered: Record<string, string>;
  /** Lines the visitor typed, by conversation. */
  typed: Record<string, string[]>;
};

const INITIAL: State = {
  open: SAMPLE_THREADS[0]!.id,
  shown: Object.fromEntries(SAMPLE_THREADS.map((thread) => [thread.id, thread.opening])),
  answered: {},
  typed: {},
};


const reveal = (id: string) => (state: State): State => ({ ...state, shown: { ...state.shown, [id]: (state.shown[id] ?? 0) + 1 } });
const openThread = (id: string) => (state: State): State => ({ ...state, open: id });

/** The tour: the agent's work and its question, then the project, then each planned agent in turn. */
function beatsFor(threads: SampleThread[]): Beat<State>[] {
  /** The list row the pointer goes to, found by the end of its label: the conversation's name. */
  const threadRow = (id: string) => `button[aria-label$="${threads.find((thread) => thread.id === id)!.name}"]`;
  return [
    { hold: 1200, apply: reveal('factory') },
    { hold: 2400, apply: reveal('factory') },
    { hold: 1600, apply: reveal('factory') },
    { hold: 1800, target: '[data-option="factory"]', apply: (state) => ({ ...state, answered: { ...state.answered, factory: 'factory' } }) },
    { hold: 2200, target: threadRow('pilot'), apply: openThread('pilot') },
    { hold: 1500, apply: reveal('pilot') },
    ...['hermes', 'openclaw', 'grok', 'muse'].flatMap((id): Beat<State>[] => [
      { hold: 2200, target: threadRow(id), apply: openThread(id) },
      { hold: 1000, apply: reveal(id) },
      { hold: 2000, apply: reveal(id) },
    ]),
  ];
}

const stepOf = () => 0;

export function ThreadsSim({ className }: { className?: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const threads = useSampleThreads();
  const beats = useMemo(() => beatsFor(threads), [threads]);
  const sim = useScript({ initial: INITIAL, beats, stage, stepOf });
  const { state, act } = sim;
  const thread = threads.find((row) => row.id === state.open)!;

  return (
    <SimStage
      stage={stage}
      sim={sim}
      className={className}
      ariaLabel="Agents and people in Starlings conversations, simulated"
      windowLabel="Team"
      windowClassName="h-[560px] max-[641px]:min-h-[640px]"
      caption="Agents work in the same conversations as your team. Each one reports progress, asks when it needs you, and files the result on the project. Planned marks agents that cannot pair with Starlings yet."
    >
      <div className="grid min-h-0 flex-1 grid-cols-[250px_minmax(0,1fr)] gap-3 p-3 max-[641px]:grid-cols-1">
        <aside className={cn('surface-rail', surfacePanelClass, "font-['Inter',sans-serif] max-[641px]:max-h-[180px] max-[641px]:overflow-y-auto")} aria-label="Conversations">
          <ul className={railListClass}>
            {threads.map((row) => (
              <RailRow
                key={row.id}
                leading={<Face thread={row} />}
                title={row.name}
                subtitle={preview(row, state)}
                badge={row.working ? undefined : <PlannedBadge />}
                active={row.id === state.open}
                ariaLabel={`Open ${row.name}`}
                onSelect={() => act((current) => ({
                  ...current,
                  open: row.id,
                  // A conversation the visitor opens has already happened.
                  shown: { ...current.shown, [row.id]: row.lines.length },
                }))}
              />
            ))}
          </ul>
        </aside>
        <Conversation thread={thread} state={state} act={act} />
      </div>
    </SimStage>
  );
}

type Act = (change: (state: State) => State) => void;

function Face({ thread, small = false }: { thread: SampleThread; small?: boolean }) {
  if (thread.face.kind === 'agent') {
    return <AgentAvatar identity={thread.face.identity} className={cn(small ? 'mt-0.5 size-7' : 'size-[30px]', !thread.working && 'border-dashed')} />;
  }
  if (thread.face.kind === 'project') return <SubjectMark subject={{ kind: 'project', organization_logo_url: null }} size={small ? 28 : 30} />;
  return <ThreadAvatarFace name={thread.name} />;
}

function PlannedBadge() {
  return <Badge variant="outline" className="h-5 rounded-full border-dashed px-1.5 text-[10px] font-normal text-muted-foreground">Planned</Badge>;
}

/** The list's second line: the last thing said, as a conversation list shows it. */
function preview(thread: SampleThread, state: State): string {
  const typed = state.typed[thread.id];
  if (typed?.length) return typed.at(-1)!;
  const lines = thread.lines.slice(0, state.shown[thread.id] ?? 0);
  const last = lines.at(-1);
  if (!last) return thread.detail;
  if (last.kind === 'working') return `${thread.name} is working…`;
  if (last.kind === 'question') return state.answered[thread.id] ? last.reply : last.text;
  return last.text.replace(/[*\n-]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function Conversation({ thread, state, act }: { thread: SampleThread; state: State; act: Act }) {
  const [draft, setDraft] = useState('');
  const shown = state.shown[thread.id] ?? 0;
  const lines = thread.lines.slice(0, shown);
  const typed = state.typed[thread.id] ?? [];
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    act((current) => ({ ...current, typed: { ...current.typed, [thread.id]: [...(current.typed[thread.id] ?? []), text] } }));
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-col rounded-xl border bg-card" aria-label={`Conversation with ${thread.name}`}>
      <header className="flex items-center gap-2.5 border-b px-4 py-2.5">
        <Face thread={thread} small />
        <div className="min-w-0">
          <b className="block truncate text-sm font-semibold">{thread.name}</b>
          <small className="block truncate text-xs text-muted-foreground">{thread.detail}</small>
        </div>
        {!thread.working && <span className="ml-auto"><PlannedBadge /></span>}
      </header>
      <ol className="m-0 min-h-0 flex-1 list-none overflow-y-auto px-4 pb-3">
        {!thread.working && (
          <ThreadEventRow text={`${thread.name} cannot pair with Starlings yet. This shows how it will work once it can.`} />
        )}
        {lines.map((line, index) => (
          <Line key={index} thread={thread} line={line} last={index === lines.length - 1} grouped={index > 0 && sameSpeaker(lines[index - 1]!, line)} state={state} act={act} />
        ))}
        {typed.map((text, index) => (
          <MessageTurn key={`typed-${index}`} mine grouped={false} avatar={null}>
            <MessageHead sender={null} sentAt={sampleTime('15:30')} />
            <MessageBubble mine text={text} />
          </MessageTurn>
        ))}
      </ol>
      <form className="flex items-end gap-2 border-t p-2.5" onSubmit={(event) => { event.preventDefault(); send(); }}>
        <div className="relative min-w-0 flex-1">
          <Textarea
            className={composerFieldClass}
            aria-label="Message"
            placeholder={`Message ${thread.name}`}
            value={draft}
            rows={1}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }}
          />
          <Button size="icon" type="submit" className={composerSendClass} disabled={!draft.trim()} aria-label="Send"><SendIcon /></Button>
        </div>
      </form>
    </section>
  );
}

function Line({ thread, line, last, grouped, state, act }: { thread: SampleThread; line: ThreadLine; last: boolean; grouped: boolean; state: State; act: Act }) {
  const meeting = useSampleMeeting();
  if (line.kind === 'event') return <ThreadEventRow text={line.text} />;
  // An agent at work is only the last line; its reply replaces it.
  if (line.kind === 'working') return last ? <AgentWorkingRow name={thread.name} elapsed="1 min" step={line.step} /> : null;
  if (line.kind === 'message') {
    const mine = line.from === 'me';
    const sender = thread.face.kind === 'project' ? meeting.guest.name : thread.name;
    return (
      <MessageTurn mine={mine} grouped={grouped} avatar={thread.face.kind === 'project' ? <ThreadAvatarFace name={sender} /> : <Face thread={thread} small />}>
        {!grouped && <MessageHead sender={mine ? null : sender} sentAt={sampleTime(line.at)} notes={[line.via && `via ${line.via}`]} />}
        <MessageBubble mine={mine} text={line.text} />
      </MessageTurn>
    );
  }
  const answer = state.answered[thread.id];
  const chosen = line.options.find((option) => option.id === answer);
  return (
    <>
      <MessageTurn mine={false} grouped={grouped} avatar={<Face thread={thread} small />}>
        {!grouped && <MessageHead sender={thread.name} sentAt={sampleTime(line.at)} />}
        <MessageBubble mine={false} text={line.text} />
        <QuestionCard
          askedBy={thread.name}
          mode="single"
          options={line.options}
          answer={chosen ? { by: meeting.host.name, labels: [chosen.label], withdrawn: false } : null}
          selected={chosen ? [chosen.id] : []}
          submitting={false}
          error=""
          onSelect={(optionID) => act((current) => ({ ...current, answered: { ...current.answered, [thread.id]: optionID } }))}
          onSubmit={() => {}}
        />
      </MessageTurn>
      {chosen && (
        <MessageTurn mine={false} grouped avatar={null}>
          <MessageBubble mine={false} text={line.reply} />
        </MessageTurn>
      )}
    </>
  );
}

function sameSpeaker(previous: ThreadLine, line: ThreadLine): boolean {
  if (previous.kind !== 'message' || line.kind !== 'message') return false;
  return previous.from === line.from;
}

/** A sample clock time on the workshop day, as a Date the message head formats. */
function sampleTime(at: string): Date {
  const [hours, minutes] = at.split(':').map(Number);
  return new Date(2026, 9, 6, hours, minutes);
}
