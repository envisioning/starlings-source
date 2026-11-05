import type { ReactNode } from 'react';
import { Check, FileText, Link2, Video } from 'lucide-react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { t } from '@shared/i18n';
import { DecisionIcon } from '@shared/action-icons';
import { decisionDetail } from '@shared/decision-labels';
import { GatheringDots } from '@shared/GatheringDots';
import { AgentAvatar } from '@shared/peer-face';
import { RailRow, surfacePanelClass } from '@shared/rail-row';
import { railListClass } from '@shared/rail-list';
import { GlyphMark, SubjectMark } from '@shared/SubjectMark';
import { AgentWorkingRow, MessageBubble, MessageHead, MessageTurn, QuestionCard, ThreadAvatarFace, ThreadEventRow } from '@shared/thread-parts';
import { SAMPLE_PEOPLE, useSampleMeeting, type SampleMeeting } from './sample-meeting';
import { useSampleWorkspace } from './sample-workspace';

/*
 * The four signature scenes on /workspace. Each draws a different surface of
 * the app with its own parts: Inbox beside a conversation, a document with
 * its sources, a project's timeline, and Work's board. A scene is a function
 * of its phase; SCENE_SCRIPTS says which step each phase belongs to, how long
 * the tour waits before it, and where the pointer goes. `--tone` is the
 * chapter's tone (TentpoleShowcase): it marks the one part of the scene the
 * step is about.
 */

type Phase = { step: number; hold: number; target?: string };
export type SceneScript = { phases: readonly Phase[]; autoplay: number };

export const SCENE_SCRIPTS: Record<'attention' | 'memory' | 'record' | 'agents', SceneScript> = {
  // The tour opens the question and stops: reading never answers it.
  attention: { phases: [{ step: 0, hold: 0 }, { step: 1, hold: 3200, target: '[data-sim="inbox-question"]' }, { step: 2, hold: 0 }], autoplay: 1 },
  memory: { phases: [{ step: 0, hold: 0 }, { step: 1, hold: 3000 }, { step: 2, hold: 3000 }, { step: 2, hold: 2200 }], autoplay: 3 },
  record: { phases: [{ step: 0, hold: 0 }, { step: 1, hold: 3000 }, { step: 1, hold: 2400, target: '[data-sim="accept"]' }, { step: 2, hold: 2600 }], autoplay: 3 },
  agents: { phases: [{ step: 0, hold: 0 }, { step: 0, hold: 2400, target: '[data-sim="assign"]' }, { step: 1, hold: 2200 }, { step: 1, hold: 2200 }, { step: 2, hold: 2600 }], autoplay: 4 },
};

const firstName = (name: string) => name.split(' ')[0]!;

/** A sample clock time on the workshop day. */
const at = (hours: number, minutes: number) => new Date(2026, 9, 6, hours, minutes);

/** A future part of the scene: there from the first frame, dimmed until its phase. */
const later = (reached: boolean) => cn('transition-opacity duration-500', !reached && 'opacity-35');

/** The tone's mark on the part a step is about. */
const FOCUS = 'ring-2 ring-(--tone)/70 ring-offset-2 ring-offset-card';

const PANE = 'flex min-h-0 min-w-0 flex-col rounded-xl border bg-card';

/* ------------------------------------------------------------------ Attention */

/** Inbox beside the conversation: the question is one record, drawn in both places. */
export function AttentionScene({ phase }: { phase: number }) {
  const meeting = useSampleMeeting();
  const { decisionAsk } = useSampleWorkspace();
  const question = t('Which audience should the proposal address?');
  const opened = phase >= 1;
  const answered = phase >= 2;
  const options = [{ id: 'client', label: t('The client team') }, { id: 'board', label: t('Their board') }, { id: 'both', label: t('Both') }];
  return <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,210px)_minmax(0,1fr)] gap-3 p-3 max-[641px]:grid-cols-1">
    <aside className={cn('surface-rail', surfacePanelClass, 'max-[641px]:max-h-[150px] max-[641px]:overflow-y-auto')} aria-label={t('Inbox')}>
      <header className="mb-2 flex items-center justify-between gap-2 px-1">
        <b className="text-sm">{t('Inbox')}</b>
        <span className={cn('rounded-full px-2 text-xs tabular-nums', answered ? 'bg-muted text-muted-foreground' : 'bg-(--tone)/25 text-foreground')}>{answered ? 1 : 2}</span>
      </header>
      <ul className={railListClass}>
        {!answered && <RailRow
          leading={<span data-sim="inbox-question" className="relative block"><AgentAvatar identity={meeting.agentIdentity} className="size-[26px]" />{!opened && <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card bg-(--tone)" />}</span>}
          title={question}
          subtitle={opened ? t('Opened · still waiting for your answer') : t('{agent} asks you · {project}', { agent: meeting.agent, project: meeting.project })}
          active={opened}
        />}
        <RailRow leading={<GlyphMark shape="square"><DecisionIcon /></GlyphMark>} title={decisionAsk.question} subtitle={decisionDetail(decisionAsk)} />
      </ul>
      {answered && <p className="mx-1 mt-2 mb-0 text-xs text-muted-foreground motion-safe:animate-in motion-safe:fade-in-0">{t('No pending questions')}</p>}
    </aside>
    <section className={cn(PANE, later(opened))} aria-label={t('Conversation')}>
      <header className="flex items-center gap-2.5 border-b px-3 py-2">
        <SubjectMark subject={{ kind: 'project', organization_logo_url: null }} size={26} />
        <div className="min-w-0"><b className="block truncate text-sm">{meeting.project}</b><small className="block truncate text-xs text-muted-foreground">{meeting.partner}</small></div>
      </header>
      <ol className="m-0 min-h-0 flex-1 list-none overflow-y-auto px-3 pb-3">
        <MessageTurn mine={false} grouped={false} avatar={<AgentAvatar identity={meeting.agentIdentity} className="mt-0.5 size-7" />}>
          <MessageHead sender={meeting.agent} sentAt={at(14, 52)} />
          <MessageBubble mine={false} text={question} />
          <div className={cn('w-full rounded-lg transition-shadow', opened && !answered && FOCUS)}>
            <QuestionCard
              askedBy={meeting.agent}
              mode="single"
              options={options}
              answer={answered ? { by: meeting.host.name, labels: [options[0]!.label], withdrawn: false } : null}
              selected={answered ? ['client'] : []}
              submitting={false}
              error=""
              onSelect={() => {}}
              onSubmit={() => {}}
            />
          </div>
        </MessageTurn>
        {answered && <>
          <ThreadEventRow text={t('Answered: client team')} />
          <MessageTurn mine={false} grouped={false} avatar={<AgentAvatar identity={meeting.agentIdentity} className="mt-0.5 size-7" />} className="motion-safe:animate-in motion-safe:fade-in-0">
            <MessageHead sender={meeting.agent} sentAt={at(14, 58)} />
            <MessageBubble mine={false} text={t('Thanks. I’ll write it for the client team and file the draft here for your review.')} />
          </MessageTurn>
        </>}
      </ol>
    </section>
  </div>;
}

/* --------------------------------------------------------------------- Memory */

/** Two source documents beside the draft they feed. Every claim in the draft cites one. */
export function MemoryScene({ phase }: { phase: number }) {
  const meeting = useSampleMeeting();
  const host = firstName(meeting.host.name);
  const drafting = phase >= 2;
  const done = phase >= 3;
  return <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-3 p-3 max-[641px]:grid-cols-1">
    <div className="flex min-h-0 min-w-0 flex-col gap-3">
      <SourceDoc
        cite={1}
        title={t('Project brief')}
        place={meeting.project}
        lines={[t('Client: {partner}', { partner: meeting.partner }), meeting.decision.what, t('Owner: {name}', { name: meeting.host.name })]}
        marked={[1]}
        reading={phase === 0}
        cited={drafting}
      />
      <SourceDoc
        cite={2}
        title={t('Proposals playbook')}
        place={t('Company library')}
        lines={[t('Start with the client’s goal.'), t('State the scope and the review point.'), t('Keep it to one page.')]}
        marked={[0, 1]}
        reading={phase === 1}
        cited={done}
      />
    </div>
    <section className={PANE} aria-label={t('Proposal draft')}>
      <header className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
        <FileText className="size-4 flex-none" aria-hidden="true" />
        <span className="min-w-0 truncate">{t('Docs')} › {meeting.project} › <b className="text-foreground">{t('Proposal draft')}</b></span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 text-sm">
        <h4 className="m-0 text-base font-medium">{t('Proposal for {partner}', { partner: meeting.partner })}</h4>
        <p className="m-0 flex items-center gap-2 text-xs text-muted-foreground">
          <AgentAvatar identity={meeting.agentIdentity} className="size-5" />
          {done ? t('Draft by {agent}', { agent: meeting.agent }) : t('{agent} is drafting from 2 sources', { agent: meeting.agent })}
          {!done && <GatheringDots motion="thinking" className="size-4" />}
        </p>
        {drafting
          ? <p className="m-0 motion-safe:animate-in motion-safe:fade-in-0"><b>{t('Goal.')}</b> {meeting.decision.what} <Cite n={1} /></p>
          : <DraftPlaceholder />}
        {done
          ? <p className="m-0 motion-safe:animate-in motion-safe:fade-in-0"><b>{t('Scope and review.')}</b> {t('One page, with the scope and the review point stated first.')} <Cite n={2} /></p>
          : drafting && <DraftPlaceholder short />}
        <div className={cn('mt-auto flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2', later(done))}>
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">{t('Waiting for {name} to review', { name: host })}</span>
          <Button type="button" size="xs" variant="outline" tabIndex={-1}>{t('Suggest edit')}</Button>
          <Button type="button" size="xs" tabIndex={-1}>{t('Review')}</Button>
        </div>
      </div>
    </section>
  </div>;
}

function SourceDoc({ cite, title, place, lines, marked, reading, cited }: { cite: number; title: string; place: string; lines: readonly string[]; marked: readonly number[]; reading: boolean; cited: boolean }) {
  const lit = reading || cited;
  return <article className={cn('min-w-0 rounded-xl border bg-card px-3 py-2.5 transition-shadow', reading && FOCUS)}>
    <header className="mb-1.5 flex items-center gap-2">
      <FileText className="size-4 flex-none text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1"><b className="block truncate text-sm">{title}</b><small className="block truncate text-[11px] text-muted-foreground">{place}</small></div>
      {cited && <Cite n={cite} />}
    </header>
    <ul className="m-0 grid list-none gap-0.5 p-0 text-xs">
      {lines.map((line, index) => <li key={index} className={cn('rounded-sm border-l-2 border-transparent px-1.5 py-0.5 transition-colors duration-500', marked.includes(index) && lit && 'border-(--tone) bg-(--tone)/15')}>{line}</li>)}
    </ul>
  </article>;
}

function Cite({ n }: { n: number }) {
  return <sup className="ml-0.5 inline-grid min-w-4 place-items-center rounded-sm bg-(--tone)/25 px-1 text-[10px] font-medium text-foreground tabular-nums">{n}</sup>;
}

function DraftPlaceholder({ short = false }: { short?: boolean }) {
  return <div className="grid gap-1.5" aria-hidden="true">
    <span className="h-2.5 w-full rounded-sm bg-muted" />
    <span className={cn('h-2.5 rounded-sm bg-muted', short ? 'w-2/5' : 'w-4/5')} />
  </div>;
}

/* --------------------------------------------------------------------- Record */

/** A project's timeline: the call, the work it started, and the brief, in the order they happened. */
export function RecordScene({ phase }: { phase: number }) {
  const meeting = useSampleMeeting();
  const proposal = meeting.proposals[0];
  const accepted = phase >= 2;
  const full = phase >= 3;
  const teammate = SAMPLE_PEOPLE.find((person) => person.name !== meeting.host.name && !meeting.guests.some((guest) => guest.name === person.name))!;
  const counts = [
    [t('Calls'), 1],
    [t('Decisions'), 1],
    [t('Tasks'), accepted ? 1 : 0],
    [t('Docs'), full ? 1 : 0],
  ] as const;
  return <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <SubjectMark subject={{ kind: 'project', organization_logo_url: null }} size={30} />
      <div className="min-w-0 flex-1"><b className="block truncate">{meeting.project}</b><small className="block truncate text-xs text-muted-foreground">{t('{partner} · Active', { partner: meeting.partner })}</small></div>
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {counts.map(([label, count]) => <li key={label} className="rounded-full border bg-card px-2 py-0.5 text-[11px] text-muted-foreground">{label} <b className="text-foreground tabular-nums">{count}</b></li>)}
      </ul>
    </header>
    <ol className="m-0 flex min-h-0 flex-1 list-none flex-col overflow-y-auto rounded-xl border bg-card p-3 pl-2">
      <Moment icon={<Video className="size-3.5" aria-hidden="true" />} reached when="14:30">
        <b className="text-sm">{meeting.title}</b> <small className="text-xs text-muted-foreground">· {t('Ended · 32 min')}</small>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="flex -space-x-1.5">
            {[meeting.host, ...meeting.guests].map((person) => <ThreadAvatarFace key={person.id} name={person.name} src={person.photo} />)}
            <AgentAvatar identity={meeting.agentIdentity} className="mt-0.5 size-7" />
          </span>
          <Badge variant="outline" className="text-[11px] font-normal">{t('Transcript')}</Badge>
          <Badge variant="outline" className="text-[11px] font-normal">{t('Summary')}</Badge>
        </div>
        <p className={cn('mt-2 mb-0 rounded-md border-l-2 border-(--tone) bg-(--tone)/12 px-2 py-1 text-xs', phase === 0 && 'motion-safe:animate-in motion-safe:fade-in-0')}>
          <span className="font-medium">{t('Decision')}:</span> {meeting.decision.what}
        </p>
      </Moment>
      <Moment icon={accepted ? <Check className="size-3.5" aria-hidden="true" /> : <Link2 className="size-3.5" aria-hidden="true" />} reached={phase >= 1} when="15:04">
        {accepted
          ? <div className="motion-safe:animate-in motion-safe:fade-in-0">
            <b className="text-sm">{proposal.title}</b>
            <p className="m-0 text-xs text-muted-foreground">{t('Task · {owner} · {due}', { owner: proposal.owner, due: proposal.due })}</p>
            <span className="mt-1 inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground"><Link2 className="size-3" aria-hidden="true" />{t('Source: {call} at 00:42', { call: meeting.title })}</span>
          </div>
          : <div className={cn('rounded-lg border bg-muted/40 p-2', phase === 1 && FOCUS)}>
            <small className="text-[11px] text-muted-foreground">{t('Proposed from the call')}</small>
            <p className="m-0 text-sm font-medium">{proposal.title}</p>
            <p className="m-0 text-xs text-muted-foreground italic">“{proposal.quote}”</p>
            <div className="mt-2 flex gap-1.5">
              <Button type="button" size="xs" tabIndex={-1} data-sim="accept">{t('Accept')}</Button>
              <Button type="button" size="xs" variant="ghost" tabIndex={-1}>{t('Dismiss')}</Button>
            </div>
          </div>}
      </Moment>
      <Moment icon={<FileText className="size-3.5" aria-hidden="true" />} reached={full} when="15:20">
        <b className="text-sm">{t('Project brief updated')}</b>
        <p className="m-0 text-xs text-muted-foreground">{t('Decision added from {call}', { call: meeting.title })}</p>
      </Moment>
      <Moment icon={<ThreadAvatarFace name={teammate.name} src={teammate.photo} />} reached={full} when={t('Next day')} last plain>
        <p className="m-0 text-sm">{t('{name} opens the project and has the whole story.', { name: firstName(teammate.name) })}</p>
      </Moment>
    </ol>
  </div>;
}

function Moment({ icon, reached, when, last = false, plain = false, children }: { icon: ReactNode; reached: boolean; when: string; last?: boolean; plain?: boolean; children: ReactNode }) {
  return <li className={cn('grid grid-cols-[28px_minmax(0,1fr)] gap-x-2.5', later(reached))}>
    <span className="relative flex justify-center">
      <span className={cn('relative z-10 grid size-7 place-items-center rounded-full', !plain && 'border', !plain && (reached ? 'border-(--tone) bg-(--tone)/20' : 'bg-muted'))}>{icon}</span>
      {!last && <span aria-hidden="true" className={cn('absolute top-7 bottom-0 w-0.5', reached ? 'bg-(--tone)/60' : 'bg-border')} />}
    </span>
    <div className={cn('min-w-0', !last && 'pb-4')}>
      <small className="block text-[11px] text-muted-foreground tabular-nums">{when}</small>
      {children}
    </div>
  </li>;
}

/* --------------------------------------------------------------------- Agents */

type Column = 'todo' | 'working' | 'review';

/** Work's board for the project: the agent's card moves across it while its activity plays out below. */
export function AgentsScene({ phase }: { phase: number }) {
  const meeting = useSampleMeeting();
  const { checklist, tasks, day } = useSampleWorkspace();
  const assigned = phase >= 1;
  const column: Column = phase >= 4 ? 'review' : phase >= 2 ? 'working' : 'todo';
  const columns: [Column, string][] = [['todo', t('To do')], ['working', t('Working')], ['review', t('Review')]];
  const others: { id: string; title: string; column: Column; person: SampleMeeting['host'] }[] = [
    { id: 'host', title: meeting.proposals[0].title, column: 'todo', person: meeting.host },
    // The host's other open task: never the one the call proposed, which is already in To do.
    { id: 'other', title: tasks.find((task) => task.owner === meeting.host.name && task.title !== meeting.proposals[0].title)!.title, column: 'working', person: meeting.host },
  ];
  const steps = [day.thread.step, meeting.agentWork.working];
  return <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
    <header className="flex items-center gap-3">
      <SubjectMark subject={{ kind: 'project', organization_logo_url: null }} size={28} />
      <b className="min-w-0 flex-1 truncate">{meeting.project}</b>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {t('Team')}
        <span className="flex -space-x-1.5">
          {[meeting.host, meeting.guest].map((person) => <ThreadAvatarFace key={person.id} name={person.name} src={person.photo} />)}
          <AgentAvatar identity={meeting.agentIdentity} className="mt-0.5 size-7 ring-2 ring-(--tone)/70" />
        </span>
      </span>
    </header>
    <div className="grid flex-none grid-cols-[repeat(3,minmax(0,1fr))] gap-2 max-[641px]:gap-1.5">
      {columns.map(([id, label]) => {
        const cards = others.filter((card) => card.column === id);
        const mine = column === id;
        return <section key={id} className="min-w-0 rounded-lg bg-muted/50 p-2 max-[641px]:p-1.5" aria-label={label}>
          <h4 className="m-0 mb-1.5 flex items-center justify-between text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">{label}<span className="tabular-nums">{cards.length + (mine ? 1 : 0)}</span></h4>
          <ul className="m-0 grid list-none gap-1.5 p-0">
            {mine && <li key={`agent-${id}`} className={cn('min-w-0 rounded-md border bg-card p-2 text-xs shadow-sm max-[641px]:text-[11px] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-left-3', assigned && 'border-(--tone)/70')}>
              <p className="m-0 mb-1.5 font-medium">{checklist.title}</p>
              {!assigned
                ? <span className="flex flex-wrap items-center justify-between gap-1 text-muted-foreground">{t('Nobody yet')}<Button type="button" size="xs" variant="outline" tabIndex={-1} data-sim="assign">{t('Assign to {agent}', { agent: meeting.agent })}</Button></span>
                : <span className="flex items-center gap-1.5 text-muted-foreground">
                  <AgentAvatar identity={meeting.agentIdentity} className="size-5" />
                  <span className="min-w-0 flex-1 truncate">{column === 'working' ? steps[phase - 2] : column === 'review' ? day.thread.filed : meeting.agent}</span>
                  {column === 'working' && <GatheringDots motion="thinking" className="size-4 flex-none" />}
                  {column === 'review' && <FileText className="size-3.5 flex-none" aria-hidden="true" />}
                </span>}
            </li>}
            {cards.map((card) => <li key={card.id} className="min-w-0 rounded-md border bg-card p-2 text-xs max-[641px]:text-[11px]">
              <p className="m-0 mb-1.5 font-medium">{card.title}</p>
              <span className="flex items-center gap-1.5 text-muted-foreground"><ThreadAvatarFace name={card.person.name} src={card.person.photo} /><span className="truncate max-[641px]:hidden">{firstName(card.person.name)}</span></span>
            </li>)}
          </ul>
        </section>;
      })}
    </div>
    <section className={cn(PANE, 'flex-1')} aria-label={t('Activity')}>
      <ol className="m-0 min-h-0 flex-1 list-none overflow-y-auto px-3 pb-2">
        {!assigned && <ThreadEventRow text={t('{task} is waiting for an owner.', { task: checklist.title })} />}
        {assigned && <ThreadEventRow text={t('{host} assigned {task} to {agent}', { host: firstName(meeting.host.name), task: checklist.title, agent: meeting.agent })} />}
        {column === 'working' && <AgentWorkingRow name={meeting.agent} elapsed={phase === 2 ? '0:20' : '1:45'} step={steps[phase - 2]} />}
        {column === 'review' && <MessageTurn mine={false} grouped={false} avatar={<AgentAvatar identity={meeting.agentIdentity} className="mt-0.5 size-7" />} className="motion-safe:animate-in motion-safe:fade-in-0">
          <MessageHead sender={meeting.agent} sentAt={at(15, 12)} notes={[t('Agent')]} />
          <MessageBubble mine={false} text={meeting.agentWork.reply} />
          <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-(--tone)/60 bg-(--tone)/12 px-2 py-0.5 text-[11px]"><FileText className="size-3" aria-hidden="true" />{day.thread.filed}</span>
        </MessageTurn>}
      </ol>
    </section>
  </div>;
}
