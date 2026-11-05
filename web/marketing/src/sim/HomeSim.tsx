import { useRef, type ReactNode } from 'react';
import { CalendarPlusIcon, XIcon } from 'lucide-react';
import type { HomeModuleID } from '@starlings/contracts/home-layout-values';
import { decisionAskOptionLabel } from '@starlings/contracts/decision-asks';
import { UPCOMING_CONFIG } from '@starlings/contracts/upcoming';
import { Button } from '@/ui/button';
import { CalendarIcon, DecisionIcon, TaskIcon, VideoIcon } from '@shared/action-icons';
import { decisionDetail } from '@shared/decision-labels';
import { HomeColumns } from '@shared/HomeColumns';
import { HomeCard, HomeCardHead, HomeClockFace, HomeList, HomeRow, HomeRowActions, HomeRowMark, HomeRowText, HomeRowWhen, homeLabelClass } from '@shared/HomeModule';
import { GlyphMark } from '@shared/SubjectMark';
import { SimStage } from './SimStage';
import { useScript, type Beat } from './use-script';
import { useSampleMeeting } from './sample-meeting';
import { useSampleWorkspace } from './sample-workspace';

/*
 * Home, the page a member opens first: the clock, then what is next, what
 * needs an answer, and the room. The cards are Home's own parts
 * (HomeModule, HomeColumns, the clock face) with sample data; the tour
 * answers a decision, accepts an invitation and opens the room.
 */

type State = {
  agentMessage: boolean;
  decision: string | null;
  invitation: 'open' | 'added' | 'discarded';
  roomOpen: boolean;
};

const INITIAL: State = { agentMessage: false, decision: null, invitation: 'open', roomOpen: false };

const BEATS: readonly Beat<State>[] = [
  { hold: 1800, apply: (state) => ({ ...state, agentMessage: true }) },
  { hold: 1600, target: '[data-sim="decide-ship"]', apply: (state) => ({ ...state, decision: 'ship' }) },
  { hold: 1500, target: '[data-sim="add-invitation"]', apply: (state) => ({ ...state, invitation: 'added' }) },
  { hold: 1500, target: '[data-sim="start-room"]', apply: (state) => ({ ...state, roomOpen: true }) },
];

/** Home in the simulation has one step; the tour runs inside it. */
const stepOf = () => 0;

const MODULES: readonly HomeModuleID[] = ['agenda', 'messages', 'work', 'room'];

export function HomeSim({ className }: { className?: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const sim = useScript({ initial: INITIAL, beats: BEATS, stage, stepOf });
  const workspace = useSampleWorkspace();
  const { state, act } = sim;

  const nodes: Record<HomeModuleID, ReactNode> = {
    agenda: <Upcoming />,
    messages: (
      <Messages
        agent={state.agentMessage}
        invitation={state.invitation}
        onAnswer={(answer) => act((current) => ({ ...current, invitation: answer }))}
      />
    ),
    work: <Work decision={state.decision} onDecide={(key) => act((current) => ({ ...current, decision: key }))} />,
    room: <Room open={state.roomOpen} onStart={() => act((current) => ({ ...current, roomOpen: true }))} />,
    commercial: null,
    notes: null,
    events: null,
    recent: null,
  };

  return (
    <SimStage
      stage={stage}
      sim={sim}
      className={className}
      ariaLabel="Home in Starlings, simulated"
      windowLabel="Home"
      windowClassName="h-[560px] max-[641px]:min-h-[620px]"
      caption="Home is today: the next call, who wrote to you, what needs an answer, and your room."
    >
      <div className="mx-auto grid w-full max-w-[856px] min-w-0 gap-3.5 px-4 pt-6 pb-2 max-[641px]:px-2.5 max-[641px]:pt-4">
        <section className="flex min-w-0 flex-col" aria-label="Today">
          <HomeClockFace now={workspace.now} />
        </section>
        <HomeColumns modules={MODULES} nodes={nodes} />
      </div>
    </SimStage>
  );
}

function Upcoming() {
  const meeting = useSampleMeeting();
  return (
    <HomeCard aria-label="Upcoming">
      <p className={homeLabelClass}>{UPCOMING_CONFIG.sectionTitle}</p>
      <HomeRow>
        <HomeRowMark aria-hidden="true"><GlyphMark size={24} shape="round"><CalendarIcon /></GlyphMark></HomeRowMark>
        <HomeRowText title={meeting.title} detail={`${meeting.guest.name} · ${meeting.partner}`} />
        <HomeRowWhen>14:30 · in 10 min</HomeRowWhen>
      </HomeRow>
    </HomeCard>
  );
}

/** Home's Inbox: the unread threads, and an invitation answered in place. */
function Messages({ agent, invitation: state, onAnswer }: {
  agent: boolean;
  invitation: State['invitation'];
  onAnswer: (answer: 'added' | 'discarded') => void;
}) {
  const { messages, agentMessage, invitation } = useSampleWorkspace();
  const threads = agent ? [agentMessage, ...messages] : messages;
  const count = threads.length + (state === 'open' ? 1 : 0);
  return (
    <HomeCard aria-label="Unread messages">
      <HomeCardHead title="Messages" count={count === 1 ? '1 new' : `${count} new`} />
      <HomeList>
        <li>
          <HomeRow>
            <HomeRowMark aria-hidden="true"><GlyphMark size={24} shape="round"><CalendarIcon /></GlyphMark></HomeRowMark>
            <HomeRowText
              title={invitation.title}
              detail={state === 'open' ? invitation.detail : state === 'added' ? 'Added to your calendar' : 'Discarded'}
            />
            {state === 'open' && (
              <HomeRowActions>
                <Button type="button" variant="default" data-sim="add-invitation" onClick={() => onAnswer('added')}>
                  <CalendarPlusIcon aria-hidden="true" />Add
                </Button>
                <Button type="button" variant="secondary" onClick={() => onAnswer('discarded')}>
                  <XIcon aria-hidden="true" />Discard
                </Button>
              </HomeRowActions>
            )}
          </HomeRow>
        </li>
        {threads.map((thread) => (
          <li key={thread.id} className="motion-safe:animate-in motion-safe:fade-in-0">
            <HomeRow>
              <span className="size-2 flex-none self-center rounded-full bg-(--accent-mark)" aria-hidden="true" />
              <HomeRowText title={thread.from} detail={thread.preview} wrap="detail-2" />
              <HomeRowWhen>{thread.when}</HomeRowWhen>
            </HomeRow>
          </li>
        ))}
      </HomeList>
    </HomeCard>
  );
}

function Work({ decision, onDecide }: { decision: string | null; onDecide: (key: string) => void }) {
  const meeting = useSampleMeeting();
  const { decisionAsk: ask, tasks } = useSampleWorkspace();
  const late = tasks.filter((task) => task.late).length;
  const today = tasks.filter((task) => task.due === 'Today').length;
  return (
    <HomeCard aria-label="Work">
      <HomeCardHead title={decision ? 'Work' : 'Work · 1 needs you'} count={`${late} overdue · ${today} due today`} />
      <HomeList>
        <li>
          <HomeRow>
            <HomeRowMark aria-hidden="true"><GlyphMark size={24} shape="square"><DecisionIcon /></GlyphMark></HomeRowMark>
            <HomeRowText
              title={ask.question}
              detail={decision ? `Answered: ${decisionAskOptionLabel(ask, decision)}` : decisionDetail(ask)}
              wrap="detail"
            />
            {!decision && (
              <HomeRowActions>
                {ask.options.map((option) => (
                  <Button
                    key={option.key}
                    type="button"
                    size="sm"
                    variant={option.key === ask.recommendation ? 'default' : 'secondary'}
                    data-sim={`decide-${option.key}`}
                    onClick={() => onDecide(option.key)}
                  >
                    {option.label}
                  </Button>
                ))}
              </HomeRowActions>
            )}
          </HomeRow>
        </li>
        {tasks.filter((task) => task.late || task.due === 'Today').map((task) => (
          <li key={task.id}>
            <HomeRow>
              <HomeRowMark aria-hidden="true" ink={task.late ? 'primary' : 'muted'}><GlyphMark size={24} shape="square"><TaskIcon size={14} /></GlyphMark></HomeRowMark>
              <HomeRowText title={task.title} detail={meeting.project} />
              <HomeRowWhen late={task.late}>{task.due}</HomeRowWhen>
            </HomeRow>
          </li>
        ))}
      </HomeList>
    </HomeCard>
  );
}

function Room({ open, onStart }: { open: boolean; onStart: () => void }) {
  const meeting = useSampleMeeting();
  return (
    <HomeCard>
      <HomeCardHead title="Your room" className="items-center" />
      <HomeRow className="mb-2.5">
        <HomeRowText
          title={meeting.room.slug}
          wrap="title"
          titleClassName="text-2xl"
          detail={`${meeting.room.host}${meeting.room.slug}`}
        >
          <small className="truncate text-xs text-muted-foreground">{open ? 'Your room is open.' : 'Ready to host.'}</small>
        </HomeRowText>
      </HomeRow>
      <Button type="button" size="lg" className="w-full" data-sim="start-room" onClick={onStart}>
        <VideoIcon /> Start room
      </Button>
    </HomeCard>
  );
}
