import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';
import { cn } from '@/lib/utils';
import { plural, t } from '@shared/i18n';
import { CallCameraIcon, CallLeaveIcon, CallMicIcon, DecisionIcon, TasksIcon } from '@shared/action-icons';
import { GatheringDots } from '@shared/GatheringDots';
import { AgentAvatar } from '@shared/peer-face';
import { AgentWorkingRow, MessageBubble, MessageHead, MessageTurn, ThreadEventRow } from '@shared/thread-parts';
import { Markdown } from '@shared/markdown';
import { ControlButton, ControlGroup, ControlMenuButton, GroupedControlButton, leaveButtonClass, PLATE, TILE, TILE_SPEAKING } from '@shared/meeting-control';
import { TaskRowView } from '@shared/rail-row';
import { railListClass } from '@shared/rail-list';
import { SectionCard } from '@shared/SectionCard';
import { CaptionLine, DecisionCandidates, TranscriptLines } from '@shared/transcript-parts';
import { PrejoinFigure, SuggestFigure } from '../bento-figures';
import { squareGridPlan } from '@shared/square-grid';
import { SimStage } from './SimStage';
import { useScript, type Beat } from './use-script';
import { composeMeeting, nextPick, useVisitPick, type MeetingPick, type SampleMeeting, type SampleProposalID } from './sample-meeting';

/*
 * One meeting, opened on the live call: a guest joins, the call is captioned, the
 * team's agent takes a task in the call and starts it, the transcript and its
 * notes and decision arrive, and the project holds what came out of it, with
 * the agent's finished work. The tour plays by itself; a click inside the window hands
 * it to the visitor (use-script.ts). Each visit and each loop draws a new
 * call and three or four new people from the sample pool (sample-meeting.ts); the
 * prerendered page draws the default, so the first client render matches it.
 *
 * The transcript, the decision, the caption lines, the task rows and the
 * call's buttons are the workspace's own components with sample data, so
 * they change when the product changes. The call's video tiles are drawn
 * here: the real stage needs LiveKit, which the public bundle refuses. The
 * agent's tile follows the centaur room (docs/CENTAUR.md): an agent is a
 * participant with its seeded face, and it hears the captions, not audio.
 */

type Step = 0 | 1 | 2 | 3;

type State = {
  step: Step;
  name: string;
  waiting: boolean;
  /** Caption lines heard in full. */
  heard: number;
  /** The next line is arriving, not yet final. */
  arriving: boolean;
  decision: 'open' | 'recorded' | 'dismissed';
  selected: string[];
  accepted: SampleProposalID[];
  done: SampleProposalID[];
  /** The agent's task, after the call: still in progress, or filed. */
  agent: 'working' | 'filed';
  /** The joining guest's camera: off as the join screen opens, on a moment later. */
  camera: boolean;
};

// Lead with the call itself: the first visible frame shows the named people
// and agent together. Joining remains available as the first step in the tour.
const INITIAL: State = { step: 1, name: '', waiting: false, heard: 0, arriving: false, decision: 'open', selected: [], accepted: [], done: [], agent: 'working', camera: true };

const STEPS: readonly { label: string; caption: string }[] = [
  { label: t('Join'), caption: t('A guest opens the link. They don’t need an account, and they wait until the host lets them in.') },
  { label: t('Talk'), caption: t('Your agent is in the call. It reads the live captions and starts work when someone asks. Starlings doesn’t record audio or video.') },
  { label: t('Transcript'), caption: t('When the call ends, the transcript and notes are ready, with any decisions Starlings found.') },
  { label: t('Project'), caption: t('Starlings files it all on the project. The agent reports its work there while you accept your own tasks.') },
];

const at = (step: Step) => (state: State): State => ({ ...state, step });

const beatsFor = (meeting: SampleMeeting): readonly Beat<State>[] => [
  ...meeting.lines.map((): Beat<State>[] => [
    { hold: 700, apply: (state) => ({ ...state, arriving: true }) },
    { hold: 1300, apply: (state) => ({ ...state, arriving: false, heard: state.heard + 1 }) },
  ]).flat(),
  { hold: 2200, target: '[data-sim="leave"]', apply: at(2) },
  { hold: 1600, target: '[aria-label="Decisions"] button', apply: (state) => ({ ...state, decision: 'recorded' }) },
  { hold: 1000, target: '[data-sim="open-project"]', apply: at(3) },
  { hold: 1500, target: '[data-sim="accept-host"]', apply: (state) => ({ ...state, accepted: [...state.accepted, 'host'] }) },
  { hold: 2600, apply: (state) => ({ ...state, agent: 'filed', done: [...state.done, 'agent'] }) },
];

const stepOf = (state: State) => state.step;

export function MeetingSim({ className }: { className?: string }) {
  // This visit's call from the first client render (the prerender draws the
  // default, hidden by SimWindow until then). Each loop of the tour draws the next.
  const visit = useVisitPick();
  const [looped, setLooped] = useState<MeetingPick | null>(null);
  const pick = looped ?? visit;
  const meeting = useMemo(() => composeMeeting(pick), [pick]);
  const onLoop = useCallback(() => setLooped((current) => nextPick(current ?? visit)), [visit]);
  return <MeetingRun key={`${pick.call}-${pick.workspace}-${pick.host}-${pick.guests.join('-')}-${pick.phones.join('-')}-${pick.agent}-${pick.agentSeed}`} meeting={meeting} className={className} onLoop={onLoop} />;
}

function MeetingRun({ meeting, className, onLoop }: { meeting: SampleMeeting; className?: string; onLoop: () => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const beats = useMemo(() => beatsFor(meeting), [meeting]);
  const sim = useScript({ initial: INITIAL, beats, stage, stepOf, onLoop });
  const { state, act } = sim;

  return (
    <SimStage
      stage={stage}
      sim={sim}
      className={className}
      ariaLabel="A meeting in Starlings, simulated"
      steps={{ labels: STEPS.map((step) => step.label), current: sim.step, onSelect: sim.goTo, ariaLabel: 'Steps of the meeting' }}
      windowLabel={state.step === 3 ? 'Work' : 'Meeting'}
      workspace={meeting.workspace}
      contentKey={state.step}
      caption={STEPS[state.step]!.caption}
      captions={STEPS.map((step) => step.caption)}
    >
      {state.step === 0 && <JoinStep meeting={meeting} state={state} act={act} />}
      {state.step === 1 && <TalkStep meeting={meeting} state={state} act={act} />}
      {state.step === 2 && <TranscriptStep meeting={meeting} state={state} act={act} />}
      {state.step === 3 && <ProjectStep meeting={meeting} state={state} act={act} />}
    </SimStage>
  );
}

type StepProps = { meeting: SampleMeeting; state: State; act: (change: (state: State) => State) => void };

function JoinStep({ meeting, state, act }: StepProps) {
  return (
    <div className="grid min-h-0 flex-1 place-items-center p-6 max-[641px]:p-3">
      <div className="w-full max-w-[460px]">
        <PrejoinFigure
          room={meeting.room}
          title={meeting.title}
          when={meeting.when}
          name={state.name}
          onName={(name) => act((current) => ({ ...current, name }))}
          waitingFor={state.waiting ? meeting.host.name : null}
          camera={{ photo: meeting.guest.photo, portrait: meeting.guest.portrait, on: state.camera }}
          onCamera={() => act((current) => ({ ...current, camera: !current.camera }))}
          onAsk={() => {
            act((current) => ({ ...current, name: current.name || meeting.guest.name, waiting: true }));
            // The host lets the guest in a moment later, as the tour does.
            window.setTimeout(() => act((current) => (current.step === 0 ? { ...current, step: 1 } : current)), 1500);
          }}
        />
      </div>
    </div>
  );
}

function TalkStep({ meeting, state, act }: StepProps) {
  const heard = meeting.lines.slice(0, state.heard);
  const arriving = state.arriving ? meeting.lines[state.heard] : undefined;
  const speaking = (arriving ?? heard.at(-1))?.speaker_id;
  // The agent starts once it has answered the host's ask.
  const working = state.heard > meeting.handoffLine + 1;
  // What the agent has done so far in the call, each after the line that prompted it.
  const done = meeting.agentActions.filter((action) => action.afterLine < state.heard);
  const status = working ? meeting.agentWork.working : done.at(-1)?.status ?? t('Listening');
  const people = [
    // In the call you are the host: the Join step showed the guest arriving.
    { ...meeting.host, label: t('{name} (you) · Host', { name: meeting.host.name }) },
    ...meeting.guests.map((guest, index) => ({ ...guest, label: index === 0 ? state.name || guest.name : guest.name, joiner: index === 0 })),
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Faces on the left half, the live transcript on the right; stacked on a phone. */}
      <div className="flex min-h-0 flex-1 max-[641px]:flex-col">
      <div className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col">
      {/* The app's square-cell grid (SquareGridLayout), tile frame and name plate (MeetParticipantTile), with a picture for the camera. */}
      <SquareGrid count={people.length + 1}>
        {people.map((person) => (
          <div key={person.id} className={cn(TILE, 'size-full', speaking === person.id && TILE_SPEAKING)}>
            {/* Every camera fills its square. A phone's portrait selfie crops to the face, which sits in its upper third. */}
            {'joiner' in person && person.joiner && !state.camera
              // Camera off: the stage's placeholder, initials in a circle.
              ? <span className="m-auto grid aspect-square w-[46%] max-w-32 place-items-center rounded-full border border-[rgb(var(--veil-rgb)/0.14)] bg-(--surface-raised) text-[clamp(14px,2.4vw,26px)] font-semibold tracking-[0.02em]">{person.initials}</span>
              : <img src={person.photo} alt="" className={cn('absolute inset-0 size-full object-cover motion-safe:animate-in motion-safe:fade-in-0', person.portrait && 'object-[50%_30%]')} />}
            <TilePlate>{person.label}</TilePlate>
          </div>
        ))}
        <div className={cn(TILE, 'size-full items-center justify-center gap-2 px-2 pb-7', speaking === 'agent' && TILE_SPEAKING)}>
          <AgentAvatar identity={meeting.agentIdentity} size="tile" className="mb-0 size-16 flex-none max-[641px]:size-12" />
          <span className="flex max-w-full items-start gap-1.5 self-stretch text-left text-[12px] leading-tight text-muted-foreground max-[641px]:hidden">
            <GatheringDots motion={working ? 'thinking' : 'drift'} className="size-4 flex-none" />
            <span>{status}</span>
          </span>
          <TilePlate>{meeting.agent} · Agent</TilePlate>
          {working && <span className="absolute top-1 right-1 rounded-[4px] bg-(--accent) px-1.5 py-0.5 text-[10px] font-semibold text-(--on-accent)">{t('Working')}</span>}
        </div>
      </SquareGrid>
      </div>
      <section className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col gap-2 border-l border-border bg-(--surface-sunken) px-4 pt-3 pb-3 max-[641px]:h-[180px] max-[641px]:flex-none max-[641px]:basis-auto max-[641px]:border-t max-[641px]:border-l-0">
        <header className="flex items-center gap-3">
          <h3 className="m-0 text-sm font-semibold">Live transcript</h3>
          <span className="text-xs text-muted-foreground">{plural(people.length, { one: t('{count} person, 1 agent'), other: t('{count} people, 1 agent') })}</span>
        </header>
        {/* The whole call so far, newest at the bottom; older lines leave at the top. */}
        <div className="flex min-h-0 flex-1 flex-col justify-end gap-1.5 overflow-hidden" aria-live="polite">
          {heard.length === 0 && !arriving && <p className="m-0 text-sm text-muted-foreground">Captions appear here once the host Mac has heard a full sentence.</p>}
          {heard.map((line, index) => (
            <Fragment key={line.id}>
              <CaptionLine speaker={line.speaker_name} text={line.text} final />
              {done.filter((action) => action.afterLine === index).map((action) => (
                <AgentActionRow key={action.text} meeting={meeting} kind={action.kind} text={action.text} />
              ))}
            </Fragment>
          ))}
          {arriving && <CaptionLine speaker={arriving.speaker_name} text={firstHalf(arriving.text)} final={false} />}
        </div>
      </section>
      </div>
      <div className="flex items-center justify-center gap-2 border-t border-border bg-(--surface) p-2">
        {/* The call bar's device controls, as ConnectedMeeting groups them: the toggle and its options chevron. */}
        <ControlGroup>
          <GroupedControlButton icon={<CallMicIcon className="m-1 size-4" />} label="Microphone" aria-pressed />
          <ControlMenuButton aria-label="Audio options" />
        </ControlGroup>
        <ControlGroup>
          <GroupedControlButton icon={<CallCameraIcon className="m-1 size-4" />} label="Camera" aria-pressed={state.camera} data-sim="camera" onClick={() => act((current) => ({ ...current, camera: !current.camera }))} />
          <ControlMenuButton aria-label="Video options" />
        </ControlGroup>
        {/* The host's End, a bar cell like the others, symbol over word, as the phone's call bar draws it. */}
        <ControlButton icon={<CallLeaveIcon className="m-1 size-4" />} label={t('End')} data-sim="leave" className={cn(leaveButtonClass, 'ml-2')} onClick={() => act((current) => ({ ...current, step: 2, heard: meeting.lines.length, arriving: false }))} />
      </div>
    </div>
  );
}

/** Something the agent did in the call, in the transcript where it happened. */
function AgentActionRow({ meeting, kind, text }: { meeting: SampleMeeting; kind: 'decision' | 'task'; text: string }) {
  return (
    <div className="flex max-w-[720px] items-start gap-2 rounded-[6px] border border-dashed border-(--accent) bg-background px-2.5 py-1.5 text-[13px] leading-snug motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1">
      <AgentAvatar identity={meeting.agentIdentity} className="mt-px size-5 flex-none" />
      <span className="mt-0.5 flex-none text-muted-foreground [&_svg]:size-3.5">{kind === 'decision' ? <DecisionIcon /> : <TasksIcon />}</span>
      {/* The sentence names the agent first; its name is set in bold. */}
      <span className="min-w-0">{text.startsWith(meeting.agent) ? <><b className="font-semibold">{meeting.agent}</b>{text.slice(meeting.agent.length)}</> : text}</span>
    </div>
  );
}

const GRID_GAP = 8;

/** Square cells, as many columns as make them largest, sized by the box (SquareGridLayout). */
function SquareGrid({ count, children }: { count: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const node = box.current;
    if (!node) return undefined;
    // Measure now, as SquareGridLayout does, then follow resizes.
    const update = () => {
      const rect = node.getBoundingClientRect();
      setSize({ width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const plan = squareGridPlan(count, size.width, size.height, GRID_GAP);
  return (
    <div className="min-h-0 flex-1 p-3 max-[641px]:p-2">
      <div
        ref={box}
        className="grid size-full min-h-0 content-center justify-center overflow-hidden"
        style={{ gridTemplateColumns: `repeat(${plan.columns}, ${plan.cell}px)`, gridAutoRows: `${plan.cell}px`, gap: `${GRID_GAP}px` }}
      >
        {children}
      </div>
    </div>
  );
}

/** A tile's name, on the plate the app draws across video. */
function TilePlate({ children }: { children: ReactNode }) {
  return (
    <div className="absolute right-1 bottom-1 left-1 flex leading-none">
      <div className={cn(PLATE, 'max-w-full')}><span className="truncate text-[12px]">{children}</span></div>
    </div>
  );
}

function TranscriptStep({ meeting, state, act }: StepProps) {
  const candidates = [{ ...meeting.decision, decision_id: state.decision === 'recorded' ? 'sample' : null, dismissed: state.decision === 'dismissed' }];
  const selected = new Set(state.selected);
  return (
    <div className="flex flex-col gap-4 p-5 max-[641px]:p-3">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="m-0 text-xs text-muted-foreground">{meeting.when} · {meeting.project}</p>
          <h3 className="m-0 mt-1 text-lg font-semibold">{meeting.title}</h3>
          <p className="m-0 mt-1 text-sm text-muted-foreground">{[meeting.host, ...meeting.guests].map((person) => person.name).join(', ')}, {meeting.agent}</p>
        </div>
        <Button type="button" variant="secondary" size="sm" data-sim="open-project" onClick={() => act((current) => ({ ...current, step: 3 }))}>
          Open {meeting.project}
        </Button>
      </header>
      <Card role="region" aria-label="Notes" className="py-4 shadow-none">
        <CardContent className="px-5">
          <Markdown text={meeting.notes} />
        </CardContent>
      </Card>
      <DecisionCandidates
        candidates={candidates}
        filed
        answer={async (_index, accept) => act((current) => ({ ...current, decision: accept ? 'recorded' : 'dismissed' }))}
      />
      <SectionCard id="sim-transcript-heading" title="Transcript">
        <TranscriptLines
          lines={meeting.lines}
          selected={selected}
          readOnly={false}
          onToggle={(line) => act((current) => ({
            ...current,
            selected: current.selected.includes(line.id) ? current.selected.filter((id) => id !== line.id) : [...current.selected, line.id],
          }))}
          onRename={() => {}}
        />
      </SectionCard>
    </div>
  );
}

function ProjectStep({ meeting, state, act }: StepProps) {
  const handed = meeting.proposals.find((row) => row.owner === meeting.agent)!;
  const events: string[] = [
    t('{title} filed here · Notes filed', { title: meeting.title }),
    t('Task handed to {agent} in the call: {task}', { agent: meeting.agent, task: handed.title }),
    state.decision === 'recorded' && t('Decision recorded: {what}', { what: meeting.decision.what }),
    ...state.accepted.map((id) => t('Task accepted: {task}', { task: meeting.proposals.find((row) => row.id === id)!.title })),
  ].filter((event): event is string => Boolean(event));
  // The host's own commitments wait for a click; the agent's was handed over in the call.
  const open = meeting.proposals.filter((row) => row.owner !== meeting.agent && !state.accepted.includes(row.id));
  const tasks = meeting.proposals.filter((row) => (row.owner === meeting.agent || state.accepted.includes(row.id)) && !state.done.includes(row.id));
  const agentFace = <AgentAvatar identity={meeting.agentIdentity} className="mt-0.5 size-7" />;
  return (
    <div className="flex flex-col gap-3 p-5 max-[641px]:p-3">
      <header className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2.5">
          <h3 className="m-0 text-lg font-semibold">{meeting.project}</h3>
          <span className="text-xs text-muted-foreground">{meeting.partner} · Active</span>
        </div>
        <Tabs value="Talk">
          <TabsList className="h-8">
            {['Talk', 'Tasks', 'Issues', 'History', 'Documents'].map((pane) => <TabsTrigger key={pane} value={pane} tabIndex={-1} className="px-2 text-xs">{pane}</TabsTrigger>)}
          </TabsList>
        </Tabs>
      </header>
      <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-3 max-[760px]:grid-cols-1">
        <ol className="m-0 flex list-none flex-col rounded-md border border-border bg-popover p-3">
          <MessageTurn mine grouped={false} avatar={null} className="pt-0">
            <MessageBubble mine text={meeting.hostNote} />
          </MessageTurn>
          {events.map((event) => <ThreadEventRow key={event} text={event} />)}
          {state.agent === 'working'
            ? <AgentWorkingRow name={meeting.agent} elapsed={t('4 min')} step={t('{work} from the notes and transcript', { work: meeting.agentWork.working })} />
            : (
              <>
                <MessageTurn mine={false} grouped={false} avatar={agentFace} className="motion-safe:animate-in motion-safe:fade-in-0">
                  <MessageHead sender={meeting.agent} sentAt={new Date(2026, 9, 6, 15, 12)} />
                  <MessageBubble mine={false} text={meeting.agentWork.reply} />
                </MessageTurn>
                <ThreadEventRow text={t('Document filed: {task}', { task: handed.title })} />
              </>
            )}
        </ol>
        <div className="flex flex-col gap-2.5">
          {open.map((row) => (
            <SuggestFigure
              key={row.id}
              quote={row.quote}
              task={row.title}
              simTarget={`accept-${row.id}`}
              onAccept={() => act((current) => ({ ...current, accepted: [...current.accepted, row.id] }))}
            />
          ))}
          {tasks.length > 0 && (
            <ul className={railListClass}>
              {tasks.map((row) => (
                <TaskRowView
                  key={row.id}
                  title={row.title}
                  metadata={row.owner === meeting.agent ? t('{owner} · Working · From the call', { owner: row.owner }) : t('{owner} · {due} · From the call', { owner: row.owner, due: row.due })}
                  onComplete={() => act((current) => ({ ...current, done: [...current.done, row.id] }))}
                  onOpen={() => {}}
                />
              ))}
            </ul>
          )}
          {state.done.length > 0 && <p className="m-0 text-xs text-muted-foreground">{state.done.length} done</p>}
        </div>
      </div>
    </div>
  );
}

/** The first half of a line's words: the caption still arriving. */
function firstHalf(text: string): string {
  const words = text.split(' ');
  return words.slice(0, Math.ceil(words.length / 2)).join(' ');
}
