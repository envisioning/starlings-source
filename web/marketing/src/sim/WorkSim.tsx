import { useMemo, useRef, type ReactNode } from 'react';
import type { CrmIssue } from '@starlings/contracts';
import { Button } from '@/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { cn } from '@/lib/utils';
import { AgentIcon, DecisionIcon, InteractionIcon, TaskIcon, TasksIcon, WorkIcon } from '@shared/action-icons';
import { decisionDetail } from '@shared/decision-labels';
import { IssueRowView, issueMeta, RailRow, RailSection, TaskRowView, surfacePanelClass } from '@shared/rail-row';
import { railListClass } from '@shared/rail-list';
import { GlyphMark, SubjectMark } from '@shared/SubjectMark';
import { TURN, TURN_MINE } from '../bento';
import { SimStage } from './SimStage';
import { useScript, type Beat } from './use-script';
import { SAMPLE_MEETING, useSampleMeeting } from './sample-meeting';
import { useSampleWorkspace, type SampleTask, type SampleWorkspace } from './sample-workspace';

/*
 * Work: the rail of Inbox, Mine and the subjects, and the column it opens.
 * The rail, its blocks and the task rows are Work's own parts (rail-row.tsx)
 * with sample data. The tour accepts a task the meeting proposed, opens the
 * project, hands a task to an agent, and the agent answers in Talk.
 */

type View = 'inbox' | 'mine' | 'pilot' | 'lead' | 'research';
type Tab = 'talk' | 'tasks' | 'issues';

type State = {
  view: View;
  tab: Tab;
  accepted: boolean;
  handed: boolean;
  agentReply: boolean;
  done: string[];
  /** The issue the visitor or the tour has selected. */
  issue: string | null;
};

const INITIAL: State = { view: 'inbox', tab: 'talk', accepted: false, handed: false, agentReply: false, done: [], issue: null };

/** The tour. It finds the project's row by the end of its label (its name) and the agent's issue by the start of its label (its title). */
const beatsFor = ({ subjects, handedIssue }: SampleWorkspace): Beat<State>[] => [
  { hold: 1400, target: '[data-sim="accept-proposal"]', apply: (state) => ({ ...state, accepted: true }) },
  { hold: 1300, target: `button[aria-label$="${subjects[0].title}"]`, apply: (state) => ({ ...state, view: 'pilot', tab: 'talk' }) },
  { hold: 1400, target: '[data-sim="tab-tasks"]', apply: (state) => ({ ...state, tab: 'tasks' }) },
  { hold: 1500, target: '[data-sim="hand-off"]', apply: (state) => ({ ...state, handed: true }) },
  { hold: 1300, target: '[data-sim="tab-issues"]', apply: (state) => ({ ...state, tab: 'issues' }) },
  { hold: 1400, target: `button[aria-label^="${handedIssue.title},"]`, apply: (state) => ({ ...state, issue: handedIssue.id }) },
  { hold: 1200, target: '[data-sim="tab-talk"]', apply: (state) => ({ ...state, tab: 'talk' }) },
  { hold: 2200, apply: (state) => ({ ...state, agentReply: true }) },
];

const stepOf = () => 0;

const AGENT = SAMPLE_MEETING.agent;

export function WorkSim({ className }: { className?: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const meeting = useSampleMeeting();
  const workspace = useSampleWorkspace();
  const beats = useMemo(() => beatsFor(workspace), [workspace]);
  const sim = useScript({ initial: INITIAL, beats, stage, stepOf });
  const { state, act } = sim;
  const open = (view: View) => act((current) => ({ ...current, view }));
  const tasks = visibleTasks(state, workspace, meeting.host.name);
  const { subjects } = workspace;
  const inboxCount = state.accepted ? 1 : 2;

  return (
    <SimStage
      stage={stage}
      sim={sim}
      className={className}
      ariaLabel="Work in Starlings, simulated"
      windowLabel="Work"
      contentKey={state.view}
      caption="Work keeps each project's conversation, tasks and decisions together. Agents take tasks and report back in the same place."
    >
      <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] gap-4 p-3 max-[641px]:grid-cols-1 max-[641px]:gap-3">
        <aside className={cn('surface-rail', surfacePanelClass, "font-['Inter',sans-serif] max-[641px]:max-h-[170px] max-[641px]:overflow-y-auto")} aria-label="Work sidebar">
          <ul className={railListClass}>
            <RailRow leading={<GlyphMark><WorkIcon /></GlyphMark>} title="Inbox" badge={<small className="text-[11px] text-muted-foreground">{inboxCount}</small>} active={state.view === 'inbox'} ariaLabel="Open Inbox" onSelect={() => open('inbox')} />
            <RailRow leading={<GlyphMark><TasksIcon /></GlyphMark>} title="Mine" badge={<small className="text-[11px] text-muted-foreground">{tasks.length}</small>} active={state.view === 'mine'} ariaLabel="Open Mine" onSelect={() => open('mine')} />
          </ul>
          <div className="mt-3.5">
            <RailSection title="Subjects" storageKey="sim-subjects" count={subjects.length}>
              <ul className={railListClass}>
                {subjects.map((subject) => (
                  <RailRow
                    key={subject.id}
                    leading={<SubjectMark subject={{ kind: subject.kind, organization_logo_url: null }} size={26} />}
                    title={subject.title}
                    subtitle={subject.detail}
                    active={state.view === subject.id}
                    ariaLabel={`Open ${subject.title}`}
                    onSelect={() => open(subject.id)}
                  />
                ))}
              </ul>
            </RailSection>
          </div>
        </aside>
        <div className="min-w-0 overflow-y-auto pr-1">
          {state.view === 'inbox' && <Inbox state={state} act={act} />}
          {state.view === 'mine' && <Mine tasks={tasks} act={act} />}
          {state.view === 'pilot' && <Project state={state} act={act} tasks={tasks} />}
          {(state.view === 'lead' || state.view === 'research') && <Quiet title={subjects.find((subject) => subject.id === state.view)!.title} />}
        </div>
      </div>
    </SimStage>
  );
}

type Act = (change: (state: State) => State) => void;

/** The tasks the host sees: the sample list, the one accepted from the meeting, minus the done ones. */
function visibleTasks(state: State, { tasks, proposedTask, checklist }: SampleWorkspace, host: string): SampleTask[] {
  const accepted: SampleTask[] = state.accepted ? [{ id: proposedTask.id, title: proposedTask.title, owner: host, due: 'Thu' }] : [];
  return [...tasks, ...accepted]
    .map((task) => (task.id === checklist.id && state.handed ? { ...task, owner: AGENT } : task))
    .filter((task) => !state.done.includes(task.id));
}

function ColumnHead({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return (
    <header className="mb-3 flex flex-col gap-2">
      <div className="flex items-baseline gap-2.5">
        <h3 className="m-0 text-lg font-semibold">{title}</h3>
        {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
      </div>
      {children}
    </header>
  );
}

function Inbox({ state, act }: { state: State; act: Act }) {
  const meeting = useSampleMeeting();
  const { decisionAsk, proposedTask, mention } = useSampleWorkspace();
  return (
    <>
      <ColumnHead title="Inbox" detail="What needs you" />
      <ul className={railListClass}>
        <RailRow
          leading={<GlyphMark shape="square"><DecisionIcon /></GlyphMark>}
          title={decisionAsk.question}
          subtitle={decisionDetail(decisionAsk)}
        />
        {!state.accepted && (
          <RailRow
            leading={<GlyphMark shape="square"><TaskIcon size={14} /></GlyphMark>}
            title={proposedTask.title}
            subtitle={`Proposed from ${proposedTask.from} · “${proposedTask.quote}”`}
            trailing={<Button type="button" size="xs" data-sim="accept-proposal" onClick={() => act((current) => ({ ...current, accepted: true }))}>Accept</Button>}
          />
        )}
        <RailRow
          leading={<GlyphMark><InteractionIcon type="note" size={14} /></GlyphMark>}
          title={meeting.project}
          subtitle={`Mentions you · ${meeting.guest.name}: ${mention}`}
        />
      </ul>
    </>
  );
}

function Mine({ tasks, act }: { tasks: SampleTask[]; act: Act }) {
  const groups: [string, SampleTask[]][] = [
    ['Late', tasks.filter((task) => task.late)],
    ['Today', tasks.filter((task) => task.due === 'Today')],
    ['Upcoming', tasks.filter((task) => !task.late && task.due !== 'Today')],
  ];
  return (
    <>
      <ColumnHead title="Mine" detail="Your open work" />
      {groups.filter(([, rows]) => rows.length > 0).map(([label, rows]) => (
        <section key={label} className="mb-3">
          <h4 className="m-0 mb-1.5 text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase">{label}</h4>
          <TaskList tasks={rows} act={act} />
        </section>
      ))}
    </>
  );
}

function TaskList({ tasks, act, handOff }: { tasks: SampleTask[]; act: Act; handOff?: ReactNode }) {
  const { checklist } = useSampleWorkspace();
  return (
    <ul className={railListClass}>
      {tasks.map((task) => (
        <TaskRowView
          key={task.id}
          title={task.title}
          metadata={[task.owner ?? 'Nobody yet', task.due].join(' · ')}
          late={task.late}
          onComplete={() => act((current) => ({ ...current, done: [...current.done, task.id] }))}
          onOpen={() => {}}
          trailing={task.id === checklist.id && task.owner === null ? handOff : undefined}
        />
      ))}
    </ul>
  );
}

function Project({ state, act, tasks }: { state: State; act: Act; tasks: SampleTask[] }) {
  const { subjects, talk, issues, proposedTask, checklist, report } = useSampleWorkspace();
  const subject = subjects[0];
  return (
    <>
      <ColumnHead title={subject.title} detail={subject.detail} />
      <Tabs value={state.tab} onValueChange={(tab) => act((current) => ({ ...current, tab: tab as Tab }))}>
        <TabsList className="h-8">
          <TabsTrigger value="talk" data-sim="tab-talk" className="px-2.5 text-xs">Talk</TabsTrigger>
          <TabsTrigger value="tasks" data-sim="tab-tasks" className="px-2.5 text-xs">Tasks · {tasks.length}</TabsTrigger>
          <TabsTrigger value="issues" data-sim="tab-issues" className="px-2.5 text-xs">Issues · {issues.filter((issue) => issue.state === 'open').length}</TabsTrigger>
        </TabsList>
        <TabsContent value="talk" className="mt-3">
          <div className="flex flex-col gap-1.5">
            {talk.map((line) => (line.kind === 'event'
              ? <small key={line.id} className="py-0.5 text-center text-[11px] text-muted-foreground">{line.text}</small>
              : (
                <p key={line.id} className={cn(TURN, 'mine' in line && line.mine ? TURN_MINE : 'self-start')}>
                  {!('mine' in line && line.mine) && <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">{line.who}</span>}
                  {line.text}
                </p>
              )))}
            {state.accepted && <small className="py-0.5 text-center text-[11px] text-muted-foreground">Task accepted: {proposedTask.title}</small>}
            {state.handed && <small className="py-0.5 text-center text-[11px] text-muted-foreground">Task handed to {AGENT}: {checklist.title}</small>}
            {state.agentReply && (
              <p className={cn(TURN, 'self-start motion-safe:animate-in motion-safe:fade-in-0')}>
                <span className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase [&>svg]:size-3.5"><AgentIcon />{AGENT}</span>
                {report}
              </p>
            )}
          </div>
        </TabsContent>
        <TabsContent value="tasks" className="mt-3">
          <TaskList
            tasks={tasks}
            act={act}
            handOff={(
              <Button type="button" variant="secondary" size="xs" data-sim="hand-off" onClick={() => act((current) => ({ ...current, handed: true }))}>
                <AgentIcon /> Hand to {AGENT}
              </Button>
            )}
          />
        </TabsContent>
        <TabsContent value="issues" className="mt-3">
          <Issues selected={state.issue} onOpen={(id) => act((current) => ({ ...current, issue: id }))} />
        </TabsContent>
      </Tabs>
    </>
  );
}

/** The project's issues from its mapped repository: open first, then closed. */
function Issues({ selected, onOpen }: { selected: string | null; onOpen: (id: string) => void }) {
  const { issues } = useSampleWorkspace();
  const groups: [string, CrmIssue[]][] = [
    ['Open', issues.filter((issue) => issue.state === 'open')],
    ['Closed', issues.filter((issue) => issue.state !== 'open')],
  ];
  return (
    <>
      {groups.map(([label, issues]) => (
        <section key={label} className="mb-3">
          <h4 className="m-0 mb-1.5 text-xs font-medium tracking-[0.08em] text-muted-foreground uppercase">{label}</h4>
          <ul className={railListClass}>
            {issues.map((issue) => (
              <IssueRowView key={issue.id} issue={issue} metadata={issueMeta(issue)} active={issue.id === selected} onOpen={() => onOpen(issue.id)} />
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function Quiet({ title }: { title: string }) {
  return (
    <>
      <ColumnHead title={title} />
      <p className="m-0 text-sm text-muted-foreground">Nothing needs you here today.</p>
    </>
  );
}
