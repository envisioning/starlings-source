import { useMemo, useRef, type ReactNode } from 'react';
import { WORK_STAGE_TITLES, type WorkStage } from '@starlings/contracts';
import { t } from '@shared/i18n';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { AgentAvatar } from '@shared/peer-face';
import { BoardColumn } from '@shared/BoardColumn';
import { MessageBubble, MessageTurn } from '@shared/thread-parts';
import { SimStage } from './SimStage';
import { useScript, type Beat } from './use-script';
import { useSampleMeeting, type SampleMeeting } from './sample-meeting';
import { DEMO_PROJECTS, USE_CASES } from '../use-cases';

/*
 * The proposal use case on home: a person and an agent on one project. The
 * chat on the left and the project's board on the right read the same
 * state, so every message moves a card. The board is Work's own column
 * (BoardColumn.tsx) with the shared stage titles; the cards are drawn here.
 */

const JOB = USE_CASES[2];
const PROJECT = DEMO_PROJECTS[0];
const COLUMNS: WorkStage[] = ['queued', 'doing', 'review', 'done'];

type CardID = 'sources' | 'draft' | 'fees' | 'approve';
type Holder = 'agent' | 'host' | null;
type Card = { id: CardID; stage: WorkStage; holder: Holder };
type Line = 'ask' | 'reading' | 'drafted' | 'fees' | 'answer' | 'approved' | 'filed';

type State = { step: number; cards: Card[]; lines: Line[]; working: boolean };

const INITIAL: State = {
  step: 0,
  cards: [
    { id: 'sources', stage: 'queued', holder: null },
    { id: 'draft', stage: 'queued', holder: null },
  ],
  lines: [],
  working: false,
};

const move = (state: State, id: CardID, stage: WorkStage, holder?: Holder): State => ({
  ...state,
  cards: state.cards.map((card) => (card.id === id ? { ...card, stage, holder: holder === undefined ? card.holder : holder } : card)),
});
const say = (state: State, line: Line): State => ({ ...state, lines: [...state.lines, line] });

/** The tour. Each beat is one thing a person or the agent does; the step is the visible chapter. */
const BEATS: Beat<State>[] = [
  { hold: 1200, apply: (state) => say(state, 'ask') },
  { hold: 1500, target: '[data-sim="card-sources"]', apply: (state) => ({ ...move(move(state, 'sources', 'doing', 'agent'), 'draft', 'queued', 'agent'), step: 1, working: true }) },
  { hold: 900, apply: (state) => say(state, 'reading') },
  { hold: 2200, target: '[data-sim="card-draft"]', apply: (state) => move(move(state, 'sources', 'done'), 'draft', 'doing') },
  { hold: 2400, apply: (state) => ({ ...say(move(state, 'draft', 'review'), 'drafted'), working: false }) },
  { hold: 1800, apply: (state) => ({ ...say({ ...state, cards: [...state.cards, { id: 'fees', stage: 'queued', holder: 'host' }] }, 'fees'), step: 2 }) },
  { hold: 1700, target: '[data-sim="card-fees"]', apply: (state) => move(state, 'fees', 'doing') },
  { hold: 1600, apply: (state) => say(move(state, 'fees', 'done'), 'answer') },
  { hold: 1600, apply: (state) => ({ ...state, cards: [...state.cards, { id: 'approve', stage: 'review', holder: 'host' }], step: 3 }) },
  { hold: 1600, target: '[data-sim="approve"]', apply: (state) => say(move(move(state, 'approve', 'done'), 'draft', 'done'), 'approved') },
  { hold: 1300, apply: (state) => say(state, 'filed') },
];

/** Where a step opens when the visitor picks it: the state the tour reaches at that step's start. */
const stepOf = (state: State) => state.step;

export function ProposalSim({ className }: { className?: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const meeting = useSampleMeeting();
  const sim = useScript({ initial: INITIAL, beats: BEATS, stage, stepOf });
  const host = meeting.host.name.split(' ')[0]!;
  const agent = meeting.agent;
  const steps = [t('Brief'), t('Draft'), t('Questions'), t('Review')];
  const captions = [
    t('{host} asks {agent} for a proposal from the client brief and the company playbook.', { host, agent }),
    t('{agent} takes the cards, reads the sources and files a draft for review.', { agent }),
    t('Fees and dates need a person. {agent} hands that card to {host}.', { agent, host }),
    JOB.review,
  ];
  return (
    <SimStage
      stage={stage}
      sim={sim}
      className={className}
      ariaLabel={t('{title}, simulated', { title: JOB.title })}
      windowLabel={t('Work')}
      windowClassName="h-[440px] max-[641px]:h-[min(640px,calc(100svh-150px))]"
      caption={captions[sim.step]}
      captions={captions}
      steps={{ labels: steps, current: sim.step, onSelect: sim.goTo }}
    >
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,0.85fr)_minmax(0,1.6fr)] gap-3 p-3 max-[800px]:grid-cols-1">
        <Chat state={sim.state} meeting={meeting} host={host} />
        <Board state={sim.state} meeting={meeting} host={host} />
      </div>
    </SimStage>
  );
}

function Chat({ state, meeting, host }: { state: State; meeting: SampleMeeting; host: string }) {
  const agent = meeting.agent;
  const text: Record<Line, { mine: boolean; text: string }> = {
    ask: { mine: true, text: t('{agent}, draft the {project} proposal from the brief and our playbook. Leave fees and dates to me.', { agent, project: PROJECT.name }) },
    reading: { mine: false, text: t('On it. Reading the brief and the playbook.') },
    drafted: { mine: false, text: t('The draft is in Review. Goal from the brief, approach from the playbook, each with its source.') },
    fees: { mine: false, text: t('{host}, fees and dates are yours. I put that card on your column.', { host }) },
    answer: { mine: true, text: t('Pilot fee as in the playbook, start on 3 November.') },
    approved: { mine: true, text: t('Approved. I will send it myself.') },
    filed: { mine: false, text: t('Filed in Documents. Nothing went to the client.') },
  };
  return (
    <section className="flex min-h-0 flex-col rounded-md border border-border bg-popover" aria-label={t('Talk')}>
      <header className="flex items-baseline gap-2 border-b border-border px-3 py-2">
        <b className="text-sm">{PROJECT.name}</b>
        <span className="text-xs text-muted-foreground">{t('Talk')}</span>
      </header>
      <ol className="m-0 flex min-h-0 flex-1 list-none flex-col justify-end overflow-hidden px-3 pb-3">
        {state.lines.map((line, index) => {
          const { mine, text: body } = text[line];
          const grouped = index > 0 && text[state.lines[index - 1]!].mine === mine;
          return (
            <MessageTurn key={line} mine={mine} grouped={grouped} className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1"
              avatar={<AgentAvatar identity={meeting.agentIdentity} className="mt-0.5 size-7" />}>
              {!mine && !grouped && <small className="text-[11px] font-semibold text-muted-foreground">{agent}</small>}
              <MessageBubble mine={mine} text={body} />
            </MessageTurn>
          );
        })}
        {state.working && (
          <li className="flex items-center gap-2 pt-2 text-xs text-muted-foreground">
            <span className="size-2 rounded-full bg-muted-foreground motion-safe:animate-pulse" />{t('{agent} is working', { agent })}
          </li>
        )}
        {state.lines.length === 0 && <li className="m-auto text-xs text-muted-foreground">{t('{host} is typing', { host })}</li>}
      </ol>
    </section>
  );
}

function Board({ state, meeting, host }: { state: State; meeting: SampleMeeting; host: string }) {
  const titles: Record<CardID, string> = {
    sources: t('Read the brief and playbook'),
    draft: t('Draft the proposal'),
    fees: t('Confirm fees and dates'),
    approve: t('Approve before sharing'),
  };
  return (
    <section className="grid min-h-0 grid-cols-4 gap-1.5 overflow-y-auto max-[640px]:grid-cols-2" aria-label={t('Board')}>
      {COLUMNS.map((column) => {
        const cards = state.cards.filter((card) => card.stage === column);
        return (
          <BoardColumn key={column} title={t(WORK_STAGE_TITLES.find((row) => row.value === column)!.title)} count={cards.length} onDropCard={() => {}}>
            {cards.map((card) => (
              <CardFace key={`${card.id}:${card.stage}`} id={card.id} title={titles[card.id]} done={column === 'done'}>
                <Holder holder={card.holder} meeting={meeting} host={host} />
                {card.id === 'approve' && column === 'review' && <Button type="button" size="xs" data-sim="approve" className="ml-auto">{t('Approve')}</Button>}
              </CardFace>
            ))}
          </BoardColumn>
        );
      })}
    </section>
  );
}

/** A card as the project board draws it: the title, then who holds it. A move re-keys it, so it lands with a fade. */
function CardFace({ id, title, done, children }: { id: CardID; title: string; done: boolean; children: ReactNode }) {
  return (
    <article data-sim={`card-${id}`} className={cn('grid min-w-0 gap-2 rounded-md border border-border bg-(--surface-raised) p-2.5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-300', done && 'opacity-60')}>
      <span className={cn('text-[13px] leading-snug font-[560]', done && 'line-through decoration-muted-foreground/60')}>{title}</span>
      <span className="flex min-w-0 items-center gap-1.5">{children}</span>
    </article>
  );
}

function Holder({ holder, meeting, host }: { holder: Holder; meeting: SampleMeeting; host: string }) {
  if (holder === null) return <small className="text-[11px] text-muted-foreground">{t('Nobody yet')}</small>;
  return (
    <small className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      {holder === 'agent'
        ? <AgentAvatar identity={meeting.agentIdentity} className="size-4" />
        : <img src={meeting.host.photo} alt="" className="size-4 rounded-full object-cover" />}
      <span className="truncate">{holder === 'agent' ? meeting.agent : host}</span>
    </small>
  );
}
