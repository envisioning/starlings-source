import { WORKSPACE_HOST_SUFFIX } from '@starlings/contracts/workspace-slug';
import { type JSX, type ReactNode } from 'react';
import { Button } from '@/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { cn } from '@/lib/utils';
import { HOME_MODULES } from '@starlings/contracts/home-layout';
import { SURFACE_STATUS_LABEL, capabilityById, type Capability, type CapabilitySurface, type SurfaceStatus } from '@starlings/contracts/capabilities';
import {
  CalendarIcon,
  CallCameraIcon,
  CallMicIcon,
  DesktopIcon,
  DocsIcon,
  HomeIcon,
  MailIcon,
  ReactionIcon,
  TeamIcon,
  VideoIcon,
  WaveIcon,
  WorkIcon,
} from '@shared/action-icons';
import { t } from '@shared/i18n';
import { leaveButtonClass } from '@shared/meeting-control';
import {
  Address,
  CaptionFigure,
  FlowArrow,
  FlowNode,
  LedgerColumn,
  LiveClock,
  LockGlyph,
  MessageGlyph,
  OverviewColumn,
  OverviewRow,
  PaletteRow,
  PersonGlyph,
  PrejoinFigure,
  DecisionFigure,
  RosterFigure,
  ServiceCell,
  ServiceRow,
  Stage,
  StageTile,
  SubjectFigure,
  SampleAgentFace,
  SuggestFigure,
  TaskListFigure,
  WeekStrip,
} from './bento-figures';
import { CAPS, DISPLAY, GRID, MONO, RAISED, ROW, ROW_DONE, ROW_LIST, ROW_META, SECTION_HERO, SUNKEN, TURN, TURN_MINE } from './bento';
import { SAMPLE_MEETING, SAMPLE_PEOPLE, sampleAgentIdentity, useSampleMeeting, useVisitDrawnClass } from './sim/sample-meeting';
import { AgentAvatar } from '@shared/peer-face';
import {
  AccessGlyph,
  ArrowGlyph,
  BellGlyph,
  BrowserGlyph,
  CameraGlyph,
  CaptionsGlyph,
  CaptureGlyph,
  CheckGlyph,
  CloudGlyph,
  CrossGlyph,
  DoorGlyph,
  Ext,
  EyeOffGlyph,
  FolderGlyph,
  Gate,
  HandGlyph,
  IssueGlyph,
  KeyGlyph,
  LinkGlyph,
  McpTool,
  NoteGlyph,
  PlugGlyph,
  PrivacyLine,
  PrivacySubject,
  RecordGlyph,
  RoomGlyph,
  SearchGlyph,
  LinkPill,
  ShareGlyph,
  ShieldGlyph,
  StackGlyph,
  StageGlyph,
  TasksGlyph,
  TranscriptGlyph,
  Tile,
  type SPAN,
} from './feature-tiles';

/*
 * The feature library: every product claim the public site makes,
 * written once. Product areas classify the claims by recurring need. A
 * feature is one tile: a name, one sentence, a drawing, the facts. A theme
 * is one editorial section of a page: a title, a lede, and
 * its features in order. Most themes are /workspace sections; the agent and
 * connector themes sit on /integrations, and the data theme on /security.
 * Pages do not write tiles; they render this with `FeatureBento`, so a claim
 * changed here changes on every page that shows it.
 *
 * Every claim is a shipped behaviour. The per-surface state of each feature
 * lives one level down at /workspace/status (`FeatureStatusPage`).
 */

export type FeatureId =
  | 'decisions'
  | 'attention'
  | 'share-project'
  | 'project'
  | 'tasks'
  | 'issues'
  | 'transcript-tasks'
  | 'messages'
  | 'quick-notes'
  | 'recorder'
  | 'docs'
  | 'internal-room'
  | 'email-forwarding'
  | 'search'
  | 'reach'
  | 'stages'
  | 'home'
  | 'team'
  | 'calendar'
  | 'work'
  | 'kept'
  | 'join-link'
  | 'waiting-room'
  | 'captions'
  | 'transcript'
  | 'call-controls'
  | 'booking'
  | 'hosting'
  | 'private-by-default'
  | 'shared-by-choice'
  | 'native-apps'
  | 'accessibility'
  | 'mcp'
  | 'shared-agents'
  | 'connectors'
  | 'google-workspace'
  | 'your-data'
  | 'keep-vault'
  | 'security'
  | 'privacy'
  | 'building-blocks'
  | 'technology';

export type Feature = {
  id: FeatureId;
  icon: ReactNode;
  title: string;
  fact: string;
  /** The drawing under the sentence. Decorative: `Tile` hides it from assistive tech. */
  figure?: ReactNode;
  rows?: Array<[label: string, text: ReactNode]>;
  /** One link under the rows, for a feature that has a fuller page behind it. */
  more?: { href: string; label: string };
  /** The hero claim: the one tile with the bigger title. */
  hero?: boolean;
  /** Width on the 12-column grid at detail depth. */
  span: keyof typeof SPAN;
  /**
   * The capability row (packages/contracts/src/capabilities.ts) this claim
   * stands on. Its `surfaces` draw the tile's "Works on" row, so the claim
   * and /workspace/status cannot disagree; features.test.ts holds it shipped.
   */
  capability?: string;
};

export type ThemeId =
  | 'project'
  | 'surfaces'
  | 'calls'
  | 'outside'
  | 'privacy'
  | 'platforms'
  | 'access'
  | 'agents'
  | 'connectors'
  | 'data';

export type Theme = {
  id: ThemeId;
  /** The page the theme's section is on. */
  page: '/workspace/capabilities' | '/integrations' | '/security';
  /** The section anchor on that page: the id on the section's header. */
  anchor: string;
  title: string;
  lede: ReactNode;
  features: readonly FeatureId[];
  /**
   * The theme as one tile, for a page that shows the whole product at a
   * glance (home): a claim, one sentence, and one feature's icon and drawing.
   */
  glance?: { title: string; fact: string; figure: FeatureId; span: keyof typeof SPAN };
};

/** Product areas describe recurring needs; themes below are editorial sections. */
export type ProductArea = {
  id: 'work' | 'messages' | 'calls' | 'docs' | 'calendar' | 'keep';
  name: string;
  outcome: string;
  emphasis: 'primary' | 'supporting';
  feature: FeatureId;
  features: readonly FeatureId[];
};

export const PRODUCT_MESSAGE = t('Work, messages, calls and docs in one workspace, so your team and your agents can work from the same project record.');
export const PRODUCT_AREAS_TITLE = t('One workspace, every area connected.');
export const PRODUCT_AGENT_MESSAGE = t('Your agents work alongside your team across the workspace. Their access follows each capability’s permissions and availability.');

export const PRODUCT_ATTENTION_MESSAGE = t('When an agent needs your answer, the attention queue keeps its request connected to the conversation.');

/** Campaign leads explain the difference; they are not navigation areas. */
export const TENTPOLES_TITLE = t('What makes Starlings different.');
export const TENTPOLES = [
  { id: 'attention', feature: 'attention', title: t('Attention queue'),
    headline: t('Know what needs your answer.'), summary: t('See pending questions and decisions with the context behind them.'),
    steps: [t('Asked'), t('Opened'), t('Answered')],
    captions: [t('An agent’s question lands in your Inbox, linked to the conversation it came from.'), t('Opening it shows the context. The question stays in your Inbox until you answer.'), t('Your answer resolves the question in the conversation and in Inbox at once. It supplies information, not permission to act.')],
    scope: t('Connected question Inbox on web; native question replies in chat. Decisions also work in native Inbox.') },
  { id: 'memory', feature: 'docs', title: t('Company second brain'),
    headline: t('Put your company’s knowledge to work.'), summary: t('Give people and authorized agents a shared library of briefs, playbooks and project knowledge.'),
    steps: [t('Brief'), t('Playbook'), t('Draft')],
    captions: [t('The agent starts from the project brief: what the client agreed.'), t('It applies the company playbook: how your team writes a proposal.'), t('The draft cites both sources and waits for a person to review it. Company memory is shared knowledge, not automatic learning.')],
    scope: t('Docs on Mac, iPhone, iPad and web. Agent access follows the connected person’s permissions.') },
  { id: 'record', feature: 'project', title: t('Shared project record'),
    headline: t('Keep the work and its context together.'), summary: t('Calls, conversations, tasks and documents belong to the project they are about.'),
    steps: [t('Call'), t('Follow-up'), t('Project')],
    captions: [t('The call ends and files its transcript, summary and decision on the project.'), t('Accept the proposed follow-up. The task keeps a link to the moment in the call it came from.'), t('Whoever opens the project next, person or agent, finds the call, decision, task and brief on one timeline.')],
    scope: t('Project work across Mac, iPhone, iPad and web. Call transcription runs on the host device.') },
  { id: 'agents', feature: 'shared-agents', title: t('Agents alongside the team'),
    headline: t('Give agents a place on the team.'), summary: t('Assign work to a named agent and see its replies and drafts alongside the team’s work.'),
    steps: [t('Assigned'), t('Working'), t('Reported')],
    captions: [t('Assign a task on the board to a named agent, as you would a teammate.'), t('The agent works in the open: the team sees its card move and its steps as they happen.'), t('Its reply and draft return to the same project for review. The team continues from its result.')],
    scope: t('Shared agents report in conversations and Work. Provider and tool availability varies; speaking in calls is planned.') },
] as const satisfies readonly { id: string; feature: FeatureId; title: string; headline: string; summary: string; steps: readonly string[]; captions: readonly string[]; scope: string }[];
export type Tentpole = typeof TENTPOLES[number];

/** Decided 2026-10-06 (MZ): lead with shared work; Calendar and Keep support it. */
export const PRODUCT_AREAS: readonly ProductArea[] = [
  { id: 'work', name: t('Work'), outcome: t('Coordinate projects, tasks, issues, goals and decisions on one shared record.'), emphasis: 'primary', feature: 'work', features: ['project', 'tasks', 'issues', 'transcript-tasks', 'stages', 'work'] },
  { id: 'messages', name: t('Messages'), outcome: t('Keep conversations with your team, clients and partners next to the work they are about.'), emphasis: 'primary', feature: 'messages', features: ['messages', 'reach', 'team', 'email-forwarding'] },
  { id: 'calls', name: t('Calls'), outcome: t('Meet live, keep the transcript and notes, and file the record on its project.'), emphasis: 'primary', feature: 'kept', features: ['recorder', 'internal-room', 'kept', 'join-link', 'waiting-room', 'captions', 'transcript', 'call-controls', 'hosting'] },
  { id: 'docs', name: t('Docs'), outcome: t('Your company second brain: shared knowledge that people and agents can use.'), emphasis: 'primary', feature: 'docs', features: ['docs', 'quick-notes'] },
  { id: 'calendar', name: t('Calendar'), outcome: t('Plan your time, take bookings and bring people together.'), emphasis: 'supporting', feature: 'calendar', features: ['calendar', 'booking'] },
  { id: 'keep', name: t('Secrets'), outcome: t('Share credentials in sealed vaults on Mac and iPhone.'), emphasis: 'supporting', feature: 'keep-vault', features: ['keep-vault'] },
];

/** Cross-area claims have no invented seventh product area. */
export const CROSS_AREA_FEATURES: Record<'agents' | 'foundation', readonly FeatureId[]> = {
  agents: ['mcp', 'decisions', 'attention', 'shared-agents'],
  foundation: ['home', 'search', 'share-project', 'private-by-default', 'shared-by-choice', 'native-apps', 'accessibility', 'connectors', 'google-workspace', 'your-data', 'security', 'privacy', 'building-blocks', 'technology'],
};

export function productAreaHref(area: ProductArea): string {
  const home = themeOf(area.feature)!;
  return `${home.page}#feature-${area.feature}`;
}

/** The same area names, outcomes and order on home and /workspace. */
export function ProductOverview({ compact = false }: { compact?: boolean }) {
  return (
    <section aria-label={PRODUCT_AREAS_TITLE} className="my-10 grid gap-5">
      <h2 className="m-0">{PRODUCT_AREAS_TITLE}</h2>
      {/* Every area is a tile of the same size, drawn with its lead feature's figure (the one /workspace draws). */}
      <div className={GRID}>
        {PRODUCT_AREAS.map((area) => {
          const lead = feature(area.feature);
          return (
            <Tile
              key={area.id}
              span={4}
              compact
              icon={lead.icon}
              title={area.name}
              fact={area.outcome}
              // The drawing sits under the sentence; the row is as tall as its tallest tile. The block's one way onward is Explore the workspace.
              illustration={areaFigure(area.id) ?? lead.figure}
            />
          );
        })}
      </div>
      {!compact && <><p className="m-0 text-sm text-muted-foreground">{PRODUCT_AGENT_MESSAGE}</p>
      <p className="m-0 text-sm text-muted-foreground">{PRODUCT_ATTENTION_MESSAGE}</p>
      <div><LinkPill href="/integrations#feature-attention">{t('Explore the attention queue')}</LinkPill></div></>}
    </section>
  );
}

/**
 * The people on a call tile: this visit's host and guests, drawn anew on every
 * visit (sim/sample-meeting.ts). The faces stay hidden until the visit's pick
 * is drawn, then fade in; on the static home page they show the default.
 */
function CallFaces() {
  const meeting = useSampleMeeting();
  const drawn = useVisitDrawnClass();
  return (
    <div className={drawn}>
      <Stage columns={3}>
        {[meeting.host, ...meeting.guests].map((person) => <StageTile key={person.id} label={person.name.split(' ')[0]!} photo={person.photo} />)}
      </Stage>
    </div>
  );
}

/** The Messages tile's exchanges: a person asks, you answer, the agent does it. */
const MESSAGE_EXCHANGES = [
  { person: SAMPLE_PEOPLE[1], asks: t('Can we start the pilot with one team?'), reply: t('Yes. We review it after four weeks.'), agent: 'Juniper', done: t('I updated the brief with the new scope.') },
  { person: SAMPLE_PEOPLE[2], asks: t('The client picked the second direction.'), reply: t('Good. Drop the other two.'), agent: 'Scout', done: t('I archived the other two and filed the decision.') },
  { person: SAMPLE_PEOPLE[5], asks: t('Two competitors only show prices after a demo.'), reply: t('Book both demos for next week.'), agent: 'Ledger', done: t('Both demos are booked and on your calendar.') },
] as const;

/** Each exchange's turn in the cycle: one third of 15 seconds each (tailwind-site.css, exchange-turn). */
const EXCHANGE_TURN = [
  'motion-safe:animate-[exchange-turn_15s_ease-in-out_infinite]',
  'opacity-0 motion-safe:animate-[exchange-turn_15s_ease-in-out_-10s_infinite]',
  'opacity-0 motion-safe:animate-[exchange-turn_15s_ease-in-out_-5s_infinite]',
];

/** One line in a drawn thread, from someone other than you: their face, their name, the line. */
function Turn({ face, who, agent = false, text }: { face: ReactNode; who: string; agent?: boolean; text: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 flex-none">{face}</span>
      <p className={cn(TURN, 'max-w-[85%]')}>
        <span className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">{who}{agent && <span className="rounded-full border border-border px-1.5 text-[10px] font-medium">{t('Agent')}</span>}</span>
        {text}
      </p>
    </div>
  );
}

/**
 * The home tiles' own drawing of an area, where the lead feature's figure
 * tells a different story on /workspace (Calls there is about what is kept).
 * Calendar draws its lead figure as it is.
 */
function areaFigure(id: ProductArea['id']): ReactNode | undefined {
  switch (id) {
    case 'work': return (
      <div className="grid grid-cols-2 gap-2">
        <OverviewColumn head={t('Inbox')} count={3}>
          <OverviewRow>{t('A message to answer')}</OverviewRow>
          <OverviewRow>{t('A task to accept')}</OverviewRow>
          <OverviewRow>{t('A question from an agent')}</OverviewRow>
        </OverviewColumn>
        <OverviewColumn head={t('Mine')} count={5}>
          <OverviewRow meta={t('Today')}>{t('A task')}</OverviewRow>
          <OverviewRow meta={t('Fri')}>{t('Another task')}</OverviewRow>
          <OverviewRow meta={t('Mon')}>{t('A draft to review')}</OverviewRow>
          <OverviewRow meta={t('Tue')}>{t('A reply to send')}</OverviewRow>
          <OverviewRow meta={t('Wed')}>{t('A brief to update')}</OverviewRow>
        </OverviewColumn>
      </div>
    );
    case 'messages': return (
      // Three exchanges from the sample calls take turns in one grid cell, so
      // the tile never changes size. People show their photo; the agent shows
      // its own face and says it is an agent. Reduced motion shows the first.
      <div className="grid">
        {MESSAGE_EXCHANGES.map((exchange, index) => (
          <div key={exchange.agent} className={cn('col-start-1 row-start-1 flex flex-col gap-1.5', index === 0 ? 'motion-reduce:opacity-100' : 'motion-reduce:invisible', EXCHANGE_TURN[index])}>
            <Turn face={<img src={exchange.person.photo} alt="" loading="lazy" className="size-6 rounded-full object-cover" />} who={exchange.person.name.split(' ')[0]!} text={exchange.asks} />
            <p className={cn(TURN, TURN_MINE)}>{exchange.reply}</p>
            <Turn face={<AgentAvatar identity={sampleAgentIdentity(exchange.agent)} className="size-6" />} who={exchange.agent} agent text={exchange.done} />
          </div>
        ))}
      </div>
    );
    case 'calls': return (
      <CallFaces />
    );
    case 'docs': return (
      <ul className={cn(RAISED, 'm-0 grid list-none gap-0.5 p-1.5 text-[13px]')}>
        <li className={FOLDER}>{t('Recent')}</li>
        <li className={FOLDER}>{t('By project')}</li>
        <li className={cn(FOLDER, 'mt-1 rounded-t-none border-t border-border bg-(--selected) pt-[9px]')}><FolderGlyph />{t('Proposals')}</li>
        <li className={FOLDER}><FolderGlyph />{t('Research')}</li>
      </ul>
    );
    case 'keep': return (
      <ul className={ROW_LIST}>
        <li className={ROW}>
          <LockGlyph />{t('Password')}
          {/* The value is shown, then sealed: both sit in one cell, so the row never changes size. */}
          <span className="ml-auto grid font-mono text-[12px]">
            <span className="col-start-1 row-start-1 motion-safe:animate-[keep-shown_4s_ease-in-out_infinite] motion-reduce:invisible">river-otter-42</span>
            <span className="col-start-1 row-start-1 opacity-0 motion-safe:animate-[keep-sealed_4s_ease-in-out_infinite] motion-reduce:opacity-100">••••••••••••••</span>
          </span>
        </li>
        <li className={ROW}><LockGlyph />{t('Login')}<small className={ROW_META}>{t('Vault')}</small></li>
        <li className={ROW}><LockGlyph />{t('API key')}<small className={ROW_META}>{t('Vault')}</small></li>
      </ul>
    );
    default: return undefined;
  }
}

// The drawings' sample content: the default sample call the simulations
// draw (sim/sample-meeting.ts), so a figure never shows placeholder words.
const SAMPLE_PROPOSAL = SAMPLE_MEETING.proposals[0];

/** The join screen, for this visit's workspace and host (useSampleMeeting). */
function SamplePrejoinFigure() {
  const meeting = useSampleMeeting();
  return <div className={useVisitDrawnClass()}><PrejoinFigure room={meeting.room} title={meeting.title} when={meeting.when} /></div>;
}

/** A guest's line, captioned, said by this visit's guest. */
function SampleCaptionFigure() {
  const caption = useSampleMeeting().lines[1]!;
  return <div className={useVisitDrawnClass()}><CaptionFigure speaker={caption.speaker_name} words={caption.text} /></div>;
}

// The drawings' parts, named once for each feature that repeats them.

const BAR_BUTTON = 'inline-flex size-9 items-center justify-center rounded-lg border border-input bg-secondary text-foreground';
const NOTE_DOOR = 'rounded-full border border-input bg-secondary px-2.5 py-[5px] text-[12px] font-semibold';
const FOLDER = 'flex items-center gap-2 rounded-md px-2 py-[5px] [&>svg]:flex-none [&>svg]:text-muted-foreground';
const GESTURE = 'flex items-center justify-center gap-2 rounded-lg border border-input bg-secondary px-2.5 py-[9px] text-[13px] font-semibold text-foreground [&>svg]:size-4 [&>svg]:flex-none';
const LEDGER_ITEM = 'm-0 flex items-center gap-2 text-[14px] leading-[1.55] [&+dd]:mt-0.5 [&>svg]:flex-none';

export const FEATURES: Record<FeatureId, Feature> = {
  'project': {
    id: 'project',
    capability: 'owner-work',
    icon: <WorkIcon />,
    title: t('One place per project'),
    fact: 'Open a project, a lead, or a partner and everything about it is there: the conversation, the tasks, the issues, the history, the documents.',
    figure: <SubjectFigure panes={['Talk', 'Tasks', 'Issues', 'History', 'Fields', 'Documents']} filed="Call filed here · Notes filed" />,
    rows: [
      ['Talk', 'The project\'s own conversation. Meetings, notes, GitHub, and agents post event lines into it. The thread is the project\'s log'],
      ['Tasks and issues', <>Tasks live on the project. Link a <Ext href="https://github.com">GitHub</Ext> repository and you read, answer, and close its issues here. Starlings posts every GitHub change in Talk</>],
      ['Goals and decisions', 'A goal states what the tasks and the agents work toward. A decision records what the team settled, once, with its source: typed, a line in Talk, a Claude, or the meeting notes'],
      ['Questions waiting on you', 'An assigned agent question appears in Home and Work Inbox with its sender on web, Mac and iPhone. Answer with buttons or dismiss it. Web chat shows the same terminal result; Mac and iPhone canonical chat refresh is still being built'],
      ['Decisions waiting on you', 'An agent puts a question to you with its options, a recommendation and a default-by day. It heads INBOX on the web, the Mac and the phone; one tap answers it, and the agent reads the answer back'],
      [t('History'), t('Interactions and quiet event lines about this project in one chronological list. Log a call, meeting or note by hand, and edit or delete it later')],
      [t('Activity'), t('Catch up in Work on Mac, iPhone, iPad and web: the latest 30 entries from the past seven days across your subjects, each opening History')],
      ['Documents', 'The documents about this subject, from Docs, beside the work'],
      ['Starlings about this', 'Start a room from the project. Starlings files the call on the project before it starts, so its transcript and tasks go to the project'],
      ['Leads from your website', 'A form on your own site files each answer as a lead, with its organization and contact. Admins see it in Inbox on web, Mac and iPhone, and the lead shows every answer'],
      ['Who is responsible', 'Name the person who answers for a project or a lead. Until someone is named, the person with the most open tasks shows as suggested'],
      ['One record', 'Starlings, GitHub and your agents read and write the same project'],
    ],
    span: 8,
  },
  'tasks': {
    id: 'tasks',
    capability: 'owner-work',
    icon: <TasksGlyph />,
    title: 'Tasks',
    fact: 'Everything you owe, on the project it belongs to.',
    figure: <TaskListFigure />,
    rows: [
      ['Create', 'From a message, a call, or a quick note'],
      ['Hand off', 'To a colleague or an agent'],
      ['Move to…', 'Onto another project or lead. Nothing else about it changes'],
      ['Close', 'Done or cancelled from any row\'s menu'],
    ],
    span: 4,
  },
  'issues': {
    id: 'issues',
    capability: 'owner-issues',
    icon: <IssueGlyph />,
    title: 'Issues',
    fact: 'GitHub issues, read and answered inside the project.',
    figure: (
      <ul className={ROW_LIST}>
        <li className={ROW}><span className="size-2.5 flex-none rounded-full border-[1.5px] border-foreground" />An open issue<small className={cn(ROW_META, MONO)}>#142</small></li>
        <li className={cn(ROW, ROW_DONE)}><span className="size-2.5 flex-none rounded-full border-[1.5px] border-transparent bg-muted-foreground" />A closed issue<small className={cn(ROW_META, MONO)}>#139</small></li>
      </ul>
    ),
    rows: [
      ['Read, comment, close', 'In Starlings, not on GitHub. Close or reopen from any row\'s menu'],
      ['Follow', <><Ext href="https://github.com">GitHub</Ext> activity posts to the project's Talk</>],
    ],
    span: 6,
  },
  'transcript-tasks': {
    id: 'transcript-tasks',
    capability: 'collab-artifacts',
    icon: <CaptureGlyph />,
    title: 'Tasks from transcripts',
    fact: 'Starlings finds a commitment in the transcript and proposes it as a task.',
    figure: <SuggestFigure quote={SAMPLE_PROPOSAL.quote} task={SAMPLE_PROPOSAL.title} />,
    rows: [
      ['When', 'Starlings checks during the call and again when it ends'],
      ['From the notes', 'Starlings proposes each action item in the notes on the call\'s project or lead, with the owner, the deadline, and the exact quote'],
      ['The follow-up', 'After a call with people outside your team, the host gets a drafted follow-up next to the call\'s tasks. Approve opens it in your own mail app. Starlings never sends it'],
      ['Accept', 'Pick the project and who owes it. The task has no owner or date until someone accepts it'],
      ['Source', 'The task links to the call it came from'],
    ],
    span: 6,
  },
  'messages': {
    id: 'messages',
    capability: 'owner-direct-messages',
    icon: <MessageGlyph />,
    title: 'Messages',
    fact: 'One conversation per person, group, or project. The same thread on every device.',
    figure: (
      <div className="flex flex-col gap-1.5">
        <p className={TURN}>A message from a colleague</p>
        <p className={cn(TURN, TURN_MINE)}>Your reply<span className="absolute right-2 -bottom-2.5 rounded-full border border-border bg-muted px-[7px] py-px text-[10px] font-semibold">+1</span></p>
      </div>
    ),
    rows: [
      ['Where', 'Everyone, a group, a person, or a project'],
      ['Compose', '@mentions, files, link previews, and Markdown formatting'],
      ['After', 'React to any message, including your own. Save your own message as a Quick Note copy to triage later; edit or withdraw it. Mute for a week'],
    ],
    span: 6,
  },
  'quick-notes': {
    id: 'quick-notes',
    icon: <NoteGlyph />,
    title: 'Quick Notes',
    fact: 'Write a private note now. File it into shared work later.',
    figure: (
      <div className={cn(SUNKEN, 'px-3 py-2.5')}>
        <p className="mt-0 mb-2.5 text-[13px]">A note you just typed</p>
        <div className="flex gap-1.5">
          <span className={NOTE_DOOR}>Task</span>
          <span className={NOTE_DOOR}>Issue</span>
          <span className={NOTE_DOOR}>Document</span>
        </div>
      </div>
    ),
    rows: [
      ['Capture', 'Mac, phone, browser, or copy your own message from Team or Work Talk. Dictate from the watch. Only you see an unfiled note'],
      ['File', 'Search projects and leads beyond the first page, or filter conversations as you type. File as a task, issue, message or document; the destination\'s access rules apply'],
    ],
    span: 6,
  },
  'recorder': {
    id: 'recorder',
    icon: <RecordGlyph />,
    title: 'Every meeting, transcribed',
    fact: 'Zoom, Teams, Webex, or Google Meet: your Mac records the call, writes the transcript, and files it with your Starlings meetings.',
    figure: (
      <div className={cn(RAISED, 'flex items-center gap-2.5 px-3 py-2.5 text-[13px]')} inert>
        <span className="size-2.5 flex-none rounded-full bg-destructive" />
        <span className="flex min-w-0 flex-1 flex-col text-[12px] text-muted-foreground"><b className="text-[13px] font-semibold text-foreground">A call started</b>Zoom</span>
        <Button size="xs" tabIndex={-1} className="flex-none">Record</Button>
      </div>
    ),
    rows: [
      ['Record', 'From the menu bar, or one click when a call starts. A minute before a calendar event with a call link, Launch & Record opens it and starts'],
      ['Transcribe', 'On the Mac. Speakers named; a Zoom call reads its own roster for who is speaking. The audio stays on your Mac'],
      ['File', 'Starlings files the transcript and summary on the project, with your Starlings calls'],
    ],
    span: 6,
  },
  'docs': {
    id: 'docs',
    capability: 'owner-docs',
    icon: <DocsIcon />,
    title: t('Docs'),
    fact: t('Your company second brain. Standards, playbooks, research and working documents, connected to the projects they inform.'),
    figure: (
      <ul className={cn(RAISED, 'm-0 grid list-none gap-0.5 p-1.5 text-[13px]')}>
        <li className={FOLDER}>Graph</li>
        <li className={FOLDER}>Recent</li>
        <li className={FOLDER}>By project</li>
        <li className={FOLDER}>By lead</li>
        {/* The first folder: a hairline under the views, and the open one. */}
        <li className={cn(FOLDER, 'mt-1 rounded-t-none border-t border-border bg-(--selected) pt-[9px]')}><FolderGlyph />Proposals</li>
        <li className={FOLDER}><FolderGlyph />Research</li>
        <li className={FOLDER}><FolderGlyph />Meetings</li>
      </ul>
    ),
    rows: [
      [t('Company memory'), t('Keep standards, playbooks and research in one shared knowledge base, with links between documents')],
      [t('Context for agents'), t('Authorized agents can read source documents and file their drafts beside the work')],
      ['Versions', 'Every save, with a message'],
      ['Comments', 'On a passage, on every device'],
      ['Graph', 'Explore linked documents grouped by folder on Mac, iPhone, iPad and web. Filter folders, then pan and zoom to explore'],
      ['Links', 'Paste or drop a URL, or click the Save button in your browser, and Docs keeps the article as text under your notes, with screenshots. A link saved on a project is filed on that project'],
      ['Folders', 'Drag documents onto a folder, a project, or a lead. Select several and move them at once. Unfiled lists the documents nobody has filed'],
      ['Share', 'By link'],
    ],
    span: 6,
  },
  'internal-room': {
    id: 'internal-room',
    icon: <RoomGlyph />,
    title: 'Internal room',
    fact: 'One room for the whole team. Members join directly, with no waiting room.',
    figure: (
      <Stage columns={4}>
        <StageTile label="You" />
        <StageTile label="Screen" sharing />
        <StageTile label="Colleague" />
        <StageTile label="+4" />
      </Stage>
    ),
    rows: [
      ['Enter', 'Members join directly. No waiting room'],
      ['Start', 'From Team, on any device'],
    ],
    span: 6,
  },
  'email-forwarding': {
    id: 'email-forwarding',
    icon: <MailIcon />,
    title: 'Email forwarding',
    fact: 'Forward an email to a channel\'s address. Starlings posts it as your message.',
    figure: (
      <div className="flex flex-col gap-1">
        <div className={cn(RAISED, 'flex items-center gap-2 px-3 py-2 text-[13px] [&>svg]:flex-none [&>svg]:text-muted-foreground')}><MailIcon /><span>Fwd: an email thread</span></div>
        <span className="flex justify-center text-muted-foreground"><ArrowGlyph /></span>
        <p className={cn(TURN, TURN_MINE, 'flex max-w-full flex-col gap-0.5')}>The same thread, as your message<small className="text-[11px] text-muted-foreground">On the project</small></p>
      </div>
    ),
    rows: [
      ['Send', 'Any email, to the channel\'s address'],
      ['Posts', 'As your message, on the project'],
    ],
    span: 6,
  },
  'search': {
    id: 'search',
    capability: 'owner-core-search',
    icon: <SearchGlyph />,
    title: 'Search',
    fact: 'Anything in the company, from any screen.',
    figure: (
      <div className={cn(RAISED, 'p-2')}>
        <Address host={"⌘K\u00a0"} slug="a project" className="mb-1.5 flex" />
        <ul className="m-0 grid list-none gap-0.5 p-0">
          <PaletteRow selected label="Their project" kind="Project" />
          <PaletteRow label="A document you wrote" kind="Document" />
          <PaletteRow label="Your next meeting" kind="Event" />
        </ul>
      </div>
    ),
    rows: [
      ['Finds', 'People, agents, projects, conversations, documents, events, tasks, issues, and transcript lines from conversations you can read'],
      ['Opens', 'Any destination, setting, or action'],
      ['Acts', 'A project or lead offers New task, New issue, New document, and Starlings about this'],
    ],
    span: 6,
  },
  'reach': {
    id: 'reach',
    capability: 'owner-call',
    icon: <BellGlyph />,
    title: 'Reach people',
    fact: 'Four ways to reach a person. Each name says what it asks.',
    figure: (
      <div className="grid grid-cols-2 gap-1.5">
        <span className={GESTURE}><MessageGlyph />Message</span>
        <span className={GESTURE}><WaveIcon />Wave</span>
        <span className={GESTURE}><VideoIcon />Call</span>
        <span className={GESTURE}><DoorGlyph />Knock</span>
      </div>
    ),
    rows: [
      ['Message', 'Read later'],
      ['Wave', 'A chime'],
      ['Call', 'Ask a colleague to open their room; join directly when their call is live'],
      ['Knock', 'Ask to enter a room'],
    ],
    span: 6,
  },
  'stages': {
    id: 'stages',
    capability: 'owner-work',
    icon: <WorkIcon />,
    title: 'Every card has a stage',
    fact: 'Tasks and issues move through the same stages. An agent works a card until Review. Starlings logs every move in the project.',
    figure: (
      <div className="grid grid-cols-4 gap-2 max-[640px]:grid-cols-2">
        <OverviewColumn head="Queued" count={4}>
          <OverviewRow>A task, unassigned</OverviewRow>
          <OverviewRow meta="#212">An issue</OverviewRow>
        </OverviewColumn>
        <OverviewColumn head="Doing" count={2}>
          <OverviewRow meta="#208"><SampleAgentFace />Wren</OverviewRow>
          <OverviewRow meta="Today">A task</OverviewRow>
        </OverviewColumn>
        <OverviewColumn head="Review" count={1}>
          <OverviewRow meta="PR"><SampleAgentFace />Wren</OverviewRow>
        </OverviewColumn>
        <OverviewColumn head="Blocked" count={1}>
          <OverviewRow meta="#199">An issue</OverviewRow>
        </OverviewColumn>
      </div>
    ),
    rows: [
      ['One vocabulary', 'Queued, doing, review, blocked, done. A task and a GitHub issue read through the same stages'],
      ['A board on every project', 'Drag a card to another column, or move it from its menu, on Mac, web, iPhone and iPad'],
      ['Your view', 'Show only the cards people hold, or only an agent\'s. Hide the columns you do not use, on every device'],
      ['GitHub issues', 'On a project with a repository, the issue\'s label sets its stage and the issue thread is its history'],
      ['Agents on the board', 'A card an agent is working on shows the agent\'s last update. Anyone can take the card back'],
      ['You accept the work', 'An agent never moves a card to Done. It stops at Review, and the card waits in the Inbox of the person who answers for it'],
      ['Log', 'Starlings writes one line into the project\'s Talk for each move'],
    ],
    span: 12,
  },
  'home': {
    id: 'home',
    capability: 'owner-home',
    icon: <HomeIcon />,
    title: 'Home',
    fact: 'Modules in your order, on every device.',
    figure: (
      <div className={cn(RAISED, 'px-4 pt-3.5 pb-4')}>
        <div className={cn(DISPLAY, 'mb-3 text-[32px] leading-none tracking-[-0.03em] tabular-nums')}><LiveClock /></div>
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5 p-0">
          {HOME_MODULES.map((module) => (
            <li key={module.id} className="flex min-w-0 flex-col gap-0.5 rounded-sm border border-border bg-muted px-3 py-2.5">
              <b className={CAPS}>{module.title}</b>
              <span className="text-[12px] leading-[1.35] text-muted-foreground">{module.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    ),
    rows: [
      ['Modules', HOME_MODULES.map((module) => module.title).join(', ')],
      ['Order', 'Set it in Settings on any device. Every device uses it'],
      ['Clock', 'Always first, always 24-hour'],
      ['Setup', 'Each new admin and member sees their first steps until they are done'],
    ],
    span: 8,
  },
  'team': {
    id: 'team',
    capability: 'owner-team-presence',
    icon: <TeamIcon />,
    title: 'Team',
    fact: 'See who is free before you reach them.',
    figure: (
      <RosterFigure rows={[
        { mark: <PersonGlyph />, label: 'Available', presence: 'on' },
        { mark: <PersonGlyph />, label: 'In a meeting', presence: 'meeting' },
        { mark: <PersonGlyph />, label: 'Unavailable', presence: 'off' },
        { mark: <SampleAgentFace className="size-full" />, label: t('Agent: working'), presence: 'meeting' },
      ]} />
    ),
    rows: [
      ['Status', 'Available, Focused, Unavailable, Offline'],
      ['Yours', 'Appear offline when you need to'],
      [t('Agents'), t('Working, Ready or Not connected. An admin sees each agent’s activity and can freeze one')],
    ],
    span: 4,
  },
  'calendar': {
    id: 'calendar',
    capability: 'owner-calendar',
    icon: <CalendarIcon />,
    title: 'Calendar',
    fact: 'Company meetings, your tasks, and your personal calendars in one place. Personal calendars stay private.',
    figure: <WeekStrip />,
    rows: [
      ['Private sources', 'Additional Google accounts, Apple, subscriptions, and personal calendars stay yours'],
      ['Shared', 'Company meetings, tasks, milestones, and shared calendar layers are company data'],
      ['Views', 'Day, week, month, agenda'],
      ['Describe it', 'One sentence fills in the title, the times, the place, and the guests. Nothing is saved until you say so'],
      ['Forward it', 'Send a booking or a ticket to calendar@ and Home proposes the events in it, each with Add'],
      ['Edit', 'Drag to move. Invite people. Add the room link. All-day events, and this event or the whole series'],
      ['Filed', 'Start a call from an event and Starlings files the transcript on its project'],
      ['Upcoming', 'Join from Home ten minutes before. Answer invitations there'],
      ['Also', 'Timezones, weather, travel time, contacts'],
    ],
    span: 6,
  },
  'work': {
    id: 'work',
    capability: 'owner-work',
    icon: <WorkIcon />,
    title: 'Work',
    fact: 'What needs you and what you owe, on the project it belongs to.',
    figure: (
      <div className="grid grid-cols-2 gap-2">
        <OverviewColumn head="Inbox" count={3}>
          <OverviewRow>A message to answer</OverviewRow>
          <OverviewRow>A task to accept</OverviewRow>
          <OverviewRow>{t('A question from an agent')}</OverviewRow>
        </OverviewColumn>
        <OverviewColumn head="Mine" count={5}>
          <OverviewRow meta="Today">A task</OverviewRow>
          <OverviewRow meta="Fri">Another task</OverviewRow>
          <OverviewRow meta="Mon">{t('A draft to review')}</OverviewRow>
          <OverviewRow meta="Tue">{t('A reply to send')}</OverviewRow>
          <OverviewRow meta="Wed">{t('A brief to update')}</OverviewRow>
        </OverviewColumn>
      </div>
    ),
    rows: [
      ['Inbox', 'What is new and needs you: decisions, proposals, comments, bookings. Filter by source'],
      ['Mine', 'What you owe, by when. Filter by due and by where it came from'],
      ['Recently finished', 'Reopen your completed or cancelled tasks and closed issues from the past week on Mac, web, or iOS'],
      ['Subjects', 'Projects, leads, partners, events. Talk, tasks, issues, and documents on each. The rail sorts by what needs you'],
      ['Browse', 'Your company, clients, partners, events, sales'],
      ['Contacts', 'The people at each organization, with their addresses, their projects and leads, and the calls they were in'],
    ],
    span: 6,
  },
  'kept': {
    id: 'kept',
    capability: 'collab-artifacts',
    icon: <CameraGlyph />,
    title: 'What Starlings keeps',
    fact: 'The transcript and the summary. Starlings doesn’t store audio or video.',
    figure: (
      <>
        <CallFaces />
        <dl className="m-0 grid grid-cols-2 gap-3 max-[640px]:grid-cols-1">
          <LedgerColumn label="Kept" kept>
            <dd className={LEDGER_ITEM}><CheckGlyph />Transcript</dd>
            <dd className={LEDGER_ITEM}><CheckGlyph />Summary</dd>
          </LedgerColumn>
          <LedgerColumn label="Not kept">
            <dd className={LEDGER_ITEM}><CrossGlyph />Audio</dd>
            <dd className={LEDGER_ITEM}><CrossGlyph />Video</dd>
            <dd className={LEDGER_ITEM}><CrossGlyph />Your screen</dd>
          </LedgerColumn>
        </dl>
      </>
    ),
    rows: [
      ['Transcript', 'The host\'s device writes it. Only the text leaves the device'],
      ['Summary', 'Starlings writes it from the transcript when the call ends'],
    ],
    hero: true,
    span: 7,
  },
  'join-link': {
    id: 'join-link',
    capability: 'entry-room',
    icon: <LinkGlyph />,
    title: 'Join with a link',
    fact: 'Guests enter a name and an email. No account.',
    figure: <SamplePrejoinFigure />,
    rows: [
      ['One room', 'The same address every time. An invite adds a token, and the card shows its title and time'],
      ['Nothing to install', 'The browser is enough'],
    ],
    span: 5,
  },
  'waiting-room': {
    id: 'waiting-room',
    capability: 'entry-waiting',
    icon: <DoorGlyph />,
    title: 'Waiting room',
    fact: 'The host admits each guest. No audio or video flows before that.',
    figure: (
      <div className={cn(RAISED, 'flex items-center gap-2.5 px-3 py-2.5 text-[13px]')} inert>
        <span className="inline-flex size-[26px] flex-none items-center justify-center rounded-full bg-muted text-[12px] font-semibold text-foreground"><PersonGlyph /></span>
        <span className="min-w-0 flex-1 truncate">A guest is waiting</span>
        <Button size="xs" tabIndex={-1} className="ml-auto">Admit</Button>
      </div>
    ),
    rows: [
      ['Admit', 'The host admits one guest at a time'],
      ['Before that', 'No audio or video flows'],
    ],
    span: 4,
  },
  'captions': {
    id: 'captions',
    capability: 'collab-captions',
    icon: <CaptionsGlyph />,
    title: 'Live captions',
    fact: 'The host’s Mac or iPhone transcribes the call and shows captions to everyone.',
    figure: <SampleCaptionFigure />,
    rows: [
      ['Written by', 'The host\'s Mac or iPhone'],
      ['Shared', 'Everyone in the room sees them, with the speaker\'s name'],
    ],
    span: 4,
  },
  'transcript': {
    id: 'transcript',
    capability: 'collab-artifacts',
    icon: <TranscriptGlyph />,
    title: 'Transcript and summary',
    fact: 'When the call ends, Starlings files the transcript and a summary on the project or contact.',
    figure: (
      <div className={cn(RAISED, 'flex flex-col gap-0.5 px-3 py-2.5 text-[13px]')}>
        <b className="font-semibold">{SAMPLE_MEETING.title}</b>
        <span className="text-[12px] text-muted-foreground">Transcript · Summary</span>
        <small className="text-[12px] text-muted-foreground">On the project</small>
      </div>
    ),
    rows: [
      ['When', 'The call ends'],
      ['Where', 'The project or contact it was about, and Docs'],
      ['Share', 'A link to the call page, which opens only for people who can already read it. Copy it, or download it as .md or .txt'],
    ],
    span: 4,
  },
  'call-controls': {
    id: 'call-controls',
    capability: 'media-mic',
    icon: <StageGlyph />,
    title: 'Call controls',
    fact: 'All of these work in the browser. Nothing to install.',
    figure: (
      <div className="flex items-center gap-1.5">
        <span className={BAR_BUTTON}><CallMicIcon /></span>
        <span className={BAR_BUTTON}><CallCameraIcon /></span>
        <span className={BAR_BUTTON}><ShareGlyph /></span>
        <span className={BAR_BUTTON}><HandGlyph /></span>
        <span className={BAR_BUTTON}><ReactionIcon /></span>
        <span className={cn('inline-flex h-9 items-center justify-center rounded-md border px-3.5 font-medium', leaveButtonClass)}>Leave</span>
      </div>
    ),
    rows: [
      ['Share', 'Your screen'],
      ['Look', 'Blur, a personal or workspace picture, or Pixels, Flock and Grid in workspace tones on Mac, iPhone and web. Admin chooses the palette and an optional default'],
      ['Sound', 'Noise suppression. Each voice plays from where that person\'s video is'],
      ['Devices', 'Pick your camera, mic and speaker'],
      ['Take part', 'Raise a hand, react, chat'],
      ['Reconnect', 'Rejoin after a dropped connection'],
    ],
    span: 6,
  },
  'booking': {
    id: 'booking',
    capability: 'entry-book',
    icon: <CalendarIcon />,
    title: 'Booking page',
    fact: 'Share one link. People pick a time when you are free.',
    figure: (
      <>
        <Address host={`example.${WORKSPACE_HOST_SUFFIX}/book/`} slug="room" />
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" inert>
          {['09:30', '10:00', '11:30', '14:00', '16:30'].map((slot) => (
            <li key={slot}><Button size="sm" variant={slot === '11:30' ? 'default' : 'outline'} tabIndex={-1} className="tabular-nums">{slot}</Button></li>
          ))}
        </ul>
      </>
    ),
    rows: [
      ['Free', 'Starlings reads your calendar and offers only free slots. No double bookings'],
      ['Self-serve', 'They reschedule or cancel from the invite'],
      ['Invite', 'Includes the room link, the start time, and the end time'],
      ['Events', 'An event gets a sign-up page. Each person gets their own room link and a calendar invite'],
    ],
    span: 6,
  },
  'hosting': {
    id: 'hosting',
    capability: 'owner-admit',
    icon: <DesktopIcon />,
    title: 'Hosted by you',
    fact: 'Your Mac or iPhone runs the call and decides who gets in.',
    figure: (
      <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-1.5 max-[640px]:grid-cols-1">
        <FlowNode icon={<DesktopIcon />} name="Your Mac or iPhone" detail="Admits, transcribes, ends" />
        <FlowArrow />
        <FlowNode icon={<CloudGlyph />} name="Media relay" detail="Video and audio, in transit only" />
        <FlowArrow />
        <FlowNode icon={<BrowserGlyph />} name="Guests" detail="Browser, Mac, or phone" />
      </div>
    ),
    rows: [
      ['Host', 'The Mac or iPhone that hosts admits guests and transcribes on the device. A second device joins muted as a companion'],
      ['Mac-to-Mac handoff', 'A companion Mac can take host while guests stay in the same room. The old host stops its microphone and uploads pending text first'],
      ['When no device hosts', 'New admissions stop when the 30-second host lease runs out. A companion Mac takes host on its own'],
      ['iPhone', 'Can start a call or join as a muted companion. Moving host to or from an iPhone is not available yet'],
      ['Media', 'Each person\'s audio and video go straight to the relay. The host device does not forward anyone else\'s media'],
    ],
    span: 12,
  },
  'share-project': {
    id: 'share-project',
    capability: 'subject-sharing',
    icon: <TeamIcon />,
    title: t('Share one project'),
    fact: t('Bring a client or a partner company into one project. They see that project and nothing else.'),
    figure: (
      <ul className={ROW_LIST}>
        <li className={ROW}><PersonGlyph />{t('Your team')}<small className={ROW_META}>{t('Everyone here')}</small></li>
        <li className={ROW}><PersonGlyph />{t('A client')}<small className={ROW_META}>{t('Guest · Write')}</small></li>
        <li className={ROW}><SampleAgentFace />{t('A partner’s Claude')}<small className={ROW_META}>{t('Organization · Read')}</small></li>
      </ul>
    ),
    rows: [
      [t('Share'), t('Add a member, an agent, a guest or another organization to one project, with read or write. Or keep the project to the people you add')],
      [t('Guests'), t('A client opens a link to the project’s guest thread and writes there, with no account. Your team reads it on the project')],
      [t('Partners'), t('A partner organization’s Claude reads and writes in the same thread with its own key. Revoke the key at any time')],
      [t('From outside'), t('Lines from guests and partners are labelled, and they never start one of your agents. Starlings records every grant')],
    ],
    span: 12,
  },
  'private-by-default': {
    id: 'private-by-default',
    icon: <LockGlyph />,
    title: 'Private by default',
    fact: 'Your quick notes and personal calendar sources are yours alone.',
    rows: [
      ['Quick Notes', 'On iPhone and iPad, New Quick Note stays in the Home bar. Only you see an unfiled note until you file it as a task, issue, message, or document'],
      ['Calendars', 'Additional Google accounts, iCloud, On My Mac, and personal subscriptions stay in your calendar view'],
      ['Preferences', 'Your calendar display, timezone, weather, and other personal settings stay yours'],
    ],
    span: 6,
  },
  'shared-by-choice': {
    id: 'shared-by-choice',
    icon: <TeamIcon />,
    title: 'Shared by choice',
    fact: 'When you put something in a shared place, it becomes company data.',
    rows: [
      ['Work', 'Projects, leads, tasks, issues, and documents follow the access rules of the shared record'],
      ['Talk', 'A message belongs to its conversation, and is visible to that conversation\'s members'],
      ['Calls', 'A call transcript or summary is shared with its participants and the project or contact it is filed with'],
    ],
    span: 6,
  },
  'native-apps': {
    id: 'native-apps',
    icon: <DesktopIcon />,
    title: 'Native apps',
    fact: 'Built for each platform, at parity. The same rooms, the same workspace, the same Home.',
    figure: <ParityTable />,
    rows: [
      [t('Mac'), t('AppKit. Host from the window or the menu bar. Home, Calendar, Work, Team, and Docs in tabs or separate windows, chosen in Appearance settings. Quit to the menu bar and keep recording. Updates itself')],
      ['iPhone and iPad', 'SwiftUI. Host and transcribe on the phone. Live Activity for the call, widgets for the next meeting, today\'s agenda, and today\'s work'],
      ['Apple Watch', 'What is next, who is waiting, and your quick notes: read, add, delete'],
      ['Web', 'The full workspace, signed in. Guests join with nothing to install'],
      ['Workspaces', 'One Mac or iPhone app for every workspace you belong to. Switch from the Starlings menu on the Mac, or from Settings on iPhone'],
      ['Workspace defaults', 'Admins set time-zone presets, offered languages, contacts, filing persona, project group, public events feed and booking defaults in Admin on the web. Calendar and Work use the workspace choices on Mac, iPhone and web'],
    ],
    span: 12,
  },
  'accessibility': {
    id: 'accessibility',
    icon: <AccessGlyph />,
    title: 'Accessibility',
    fact: 'Every control says what it does. The room announces who joins, who leaves, and who raises a hand.',
    rows: [
      ['Labels', 'Icon-only controls on Mac, iPhone and the web have a spoken label that names the action, not the symbol. A control with a word on it has no tooltip'],
      ['In the room', 'A screen reader hears people join and leave and hands go up, in the order they happen. Nothing is read twice'],
      ['Text size', 'The iPhone app follows Dynamic Type all the way up. Rows wrap instead of truncating; dense calendar grids hand off to the list beside them'],
      ['Contrast', 'Increase Contrast on the Mac and prefers-contrast in the browser make thin lines solid and muted text dark'],
      ['Motion', 'Reduce Motion is respected on every client. Reactions fade in place instead of flying'],
      ['Keyboard', 'Every page starts with a skip link. Focus is a visible ring on every control, and the main verbs have shortcuts on the Mac'],
    ],
    span: 12,
  },
  'mcp': {
    id: 'mcp',
    icon: <PlugGlyph />,
    title: 'MCP',
    fact: 'Your own agent reads and writes company data through Starlings, as you. Claude, Hermes or any MCP client. Starlings logs every call.',
    figure: (
      <ul className={cn(SUNKEN, 'm-0 grid list-none grid-cols-2 gap-x-3 gap-y-1 px-3 py-2.5 max-[640px]:grid-cols-1')}>
        <McpTool name="search">What ⌘K finds</McpTool>
        <McpTool name="open">A subject, a thread, a document, a person</McpTool>
        <McpTool name="now">Who is around, what is next, what is due</McpTool>
        <McpTool name="transcript">A finished meeting</McpTool>
        <McpTool name="send_message">Into a conversation</McpTool>
        <McpTool name="task">On a project or lead</McpTool>
        <McpTool name="create_issue">On a project</McpTool>
        <McpTool name="schedule">An event, with your room</McpTool>
        <McpTool name="docs_write">A document, or a link save</McpTool>
        <McpTool name="record_decision">What the team settled</McpTool>
        <McpTool name="ask_decision">A question for you to decide</McpTool>
      </ul>
    ),
    rows: [
      ['Reads', 'Subjects, people, conversations, documents, events, tasks, issues, finished transcripts'],
      ['Writes', 'A message, a task and its updates, an issue, an event, a room, a goal, a decision, a question for you to decide, a document, website content. Each one names the client that wrote it'],
      ['Scope', 'Writes are a scope you grant on connect, off by default. Settings lists each connected client, with Pause and Revoke'],
      ['Record', 'Starlings logs every call. Admin and your own account page show the log. The log keeps no content, and keeps entries 90 days'],
      ['Protocol', <><Ext href="https://modelcontextprotocol.io">Model Context Protocol</Ext>, over one signed endpoint</>],
      ['Works in', <><Ext href="https://claude.ai">claude.ai</Ext>, <Ext href="https://claude.com/download">Claude Desktop</Ext>, <Ext href="https://claude.com/product/claude-code">Claude Code</Ext>, and any MCP client that does OAuth sign-in</>],
      ['Connector or teammate', 'Your own agent connects as you. A shared agent in Team has its own identity and answers through a signed runtime connection'],
    ],
    more: { href: '/help/howto/connect-an-agent-over-mcp', label: t('How to connect an agent') },
    span: 12,
  },
  'decisions': {
    id: 'decisions',
    capability: 'owner-decision-queue',
    icon: <SampleAgentFace className="size-6 [&_svg]:size-full!" />,
    title: t('Your agents ask. You decide.'),
    fact: t('When an agent needs a call from a person, it does not guess. It files a decision for you, with its options, its recommendation and a default-by day.'),
    figure: (
      <DecisionFigure
        from={`${SAMPLE_MEETING.agent} · ${SAMPLE_MEETING.project}`}
        question={t('Send the brief to the client today, or wait for the legal review?')}
        options={[t('Send today'), t('Wait for legal')]}
        recommended={1}
        recommendedLabel={t('Recommended')}
        defaultBy={t('Default-by Friday · Wait for legal is recommended')}
      />
    ),
    rows: [
      [t('First in INBOX'), t('On the web, the Mac and the phone. One tap answers it')],
      [t('Never applied for you'), t('The default-by day marks when the recommendation may be applied explicitly. Passing it does not decide for you')],
      [t('Saved on the project'), t('Your answer becomes a decision on the project, with who decided and when. The agent reads it back')],
    ],
    more: { href: '/help/howto/answer-a-decision', label: t('How to answer a decision') },
    span: 12,
  },
  'attention': {
    id: 'attention',
    capability: 'owner-question-inbox',
    icon: <BellGlyph />,
    title: t('Attention queue'),
    fact: t('Questions and decisions waiting for your answer, with their context. On web, assigned questions stay connected across chat and Inbox.'),
    figure: (
      <ul className={cn(RAISED, 'm-0 list-none p-3 text-sm')}>
        <li className={ROW}><NoteGlyph /><span>{t('Decision: send the brief?')}</span></li>
        <li className={ROW}><MessageGlyph /><span>{t('Question: which audience?')}</span></li>
        <li className={cn(ROW_META, 'mt-2')}>{t('One request, wherever you answer')}</li>
      </ul>
    ),
    rows: [
      [t('Connected on web'), t('Assigned questions appear in chat, Home Inbox and Work Inbox. Answer or dismiss in one view; the others show the same result')],
      [t('Decisions'), t('Decisions have options, a recommendation and a default-by day. Answer from Inbox on Mac, iPhone, iPad or web')],
      [t('Questions'), t('Questions gather information. Answering one does not approve an action')],
      [t('Still waiting'), t('Opening or reading a request does not resolve it. A notification points to the request; it does not own its state')],
      [t('Native coverage'), t('Mac and iPhone support question replies in chat. Connected question Inbox controls are still planned')],
    ],
    more: { href: '/help/howto/answer-a-question', label: t('How to answer a question') },
    span: 6,
  },
  'shared-agents': {
    id: 'shared-agents',
    capability: 'owner-agent-interactive-questions',
    icon: <SampleAgentFace className="size-6 [&_svg]:size-full!" />,
    title: 'Agents',
    fact: 'Team lists agents next to people. Message one, answer a question with choices, or hand it a task.',
    figure: (
      <div className="flex flex-col gap-1.5">
        <p className={cn(TURN, TURN_MINE)}>A task, handed to the agent</p>
        <p className={cn(TURN, 'self-start')}><span className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase [&>svg]:size-3.5"><SampleAgentFace className="size-3.5" />Agent</span>Its reply, with the work filed on the project</p>
      </div>
    ),
    rows: [
      ['In Team', 'Listed with people. Message one the way you message anyone'],
      ['Interactive questions', 'An agent can ask with single or multiple choices. Submit your answer in chat to continue the same thread'],
      ['In Work', 'On the Mac and the web, hand it a card and say what done looks like and what should come back. It stops at Review'],
      ['A person answers', 'Someone hands each card to an agent, and someone accepts the result. Everything an agent does records who it acted for'],
      ['On your behalf', 'It acts as the person who asked'],
      ['What it can do', 'Open an agent’s profile to see its runtime-reported skills, tools, connections, schedules and the documents it follows'],
      ['In a room', 'From a command line, an agent hosts, admits guests, and reads the transcript'],
      ['Runs on Eve', <>Envisioning’s shared agents run on <Ext href="https://vercel.com/eve">Vercel Eve</Ext> with their own skills, connections and keys. Signed handoffs and replies connect the runtime to Starlings</>],
    ],
    more: { href: '/help/howto/hand-off-a-card-to-an-agent', label: 'How to hand a card to an agent' },
    span: 12,
  },
  'connectors': {
    id: 'connectors',
    icon: <PlugGlyph />,
    title: 'Connectors',
    fact: 'One connector per tool. Map a channel, a repository, or a folder to a project. Starlings files its past and new items on that project.',
    figure: (
      <ServiceRow three>
        <ServiceCell title="Granola" foot="Live">Meeting notes, past and future, filed on a subject. A suggestion says where each belongs, and one lead is proposed per company</ServiceCell>
        <ServiceCell title="GitHub" foot="Live">An admin connects your GitHub account from Admin, then maps repositories to projects. Issues and pull requests in Work, every change in Talk</ServiceCell>
        <ServiceCell title="Slack" foot="Live">A channel's history into a project's conversation, at its original time, kept current hourly</ServiceCell>
        <ServiceCell title="Beeper" foot="Next" planned>WhatsApp, LinkedIn, Telegram, and Signal threads, read by the Mac, on the subjects the contact is on</ServiceCell>
        <ServiceCell title="Google Drive" foot="Planned" planned>Folders into Docs, linked to the meeting that produced them</ServiceCell>
        <ServiceCell title="Notion" foot="Planned" planned>Pages and databases into Docs, once, then Notion retires</ServiceCell>
      </ServiceRow>
    ),
    rows: [
      ['You map', 'Each connector lists what the tool holds. You pick the subject for each row, or skip it. A suggestion only prefills the choice'],
      ['One ledger', 'Every import records what it filed and where. You can reverse a wrong mapping for that one row'],
      ['Off by default', 'A connector runs only when an admin turns it on. When off, it reads nothing'],
      ['Google stays', 'Gmail, Calendar, and Drive remain the record. Starlings reads and links, and never writes back'],
    ],
    span: 12,
  },
  'google-workspace': {
    id: 'google-workspace',
    capability: 'owner-calendar',
    icon: <CalendarIcon />,
    title: 'Google Workspace',
    fact: 'Your team signs in with Google, and Starlings reads your calendar.',
    rows: [
      ['Sign-in', 'Google accounts from your company only, proven by Google itself'],
      ['Calendar', 'Company meetings and your own calendars in one view. Your booking page offers only the times you are free'],
      ['Calls', 'Start a call from a calendar event, and Starlings files its transcript on the event’s project'],
      ['Read only', 'Gmail, Calendar and Drive remain the record. Starlings reads and links, and never writes back'],
    ],
    span: 12,
  },
  'your-data': {
    id: 'your-data',
    icon: <LockGlyph />,
    title: 'Your data stays yours',
    fact: 'Starlings keeps your workspace’s records, documents and transcripts in its own storage, and you can take them with you.',
    figure: (
      <ul className={ROW_LIST}>
        <li className={ROW}><LockGlyph />Transcripts and summaries<small className={ROW_META}>Your workspace</small></li>
        <li className={ROW}><LockGlyph />Tasks, issues, records<small className={ROW_META}>Your workspace</small></li>
        <li className={ROW}><LockGlyph />Documents<small className={ROW_META}>Your workspace</small></li>
        <li className={ROW}><LockGlyph />Credentials<small className={ROW_META}>Sealed on device</small></li>
      </ul>
    ),
    rows: [
      ['Where', <><Ext href="https://www.cloudflare.com">Cloudflare</Ext>. Docs and records too</>],
      ['Who else', 'Nobody else holds a copy. Starlings doesn’t store audio or video'],
      ['Backed up', 'Starlings copies every room and conversation to an EU bucket each day and keeps each copy thirty days. Each one restores on its own'],
      ['Separate', 'Each workspace’s data is kept apart from every other workspace’s'],
      ['Export', 'Download transcripts and notes as plain Markdown files at any time'],
    ],
    span: 7,
  },
  'keep-vault': {
    id: 'keep-vault',
    capability: 'owner-keep',
    icon: <KeyGlyph />,
    title: t('Secrets'),
    fact: 'Client credentials, sealed on your device. The server cannot read them.',
    figure: (
      <ul className={ROW_LIST}>
        <li className={ROW}><LockGlyph />Password<small className={ROW_META}>Vault</small></li>
        <li className={ROW}><LockGlyph />Login<small className={ROW_META}>Vault</small></li>
        <li className={ROW}><LockGlyph />API key<small className={ROW_META}>Vault</small></li>
      </ul>
    ),
    rows: [
      ['Unlock', 'Touch ID, Face ID, or a passphrase. Locks after fifteen idle minutes'],
      ['Share', 'Per vault, with an audit trail'],
      ['Where', 'Mac and iPhone. On the web, a vault says to open it there: a browser never holds the keys'],
      ['Agents', 'An agent asks in a thread for one item. A member approves on Mac or iPhone, for fifteen minutes unless they choose longer'],
    ],
    span: 5,
  },
  'security': {
    id: 'security',
    icon: <ShieldGlyph />,
    title: 'Security',
    fact: 'Every entry point checks who you are. Starlings trusts no request because of where it came from.',
    figure: (
      <ol className="m-0 grid list-none grid-cols-5 gap-2 p-0 [counter-reset:gate] max-[960px]:grid-cols-3 max-[640px]:grid-cols-1">
        <Gate name="Sign in">Google, your company’s accounts only</Gate>
        <Gate name="Ask to join">A secret, no media yet</Gate>
        <Gate name="Admitted">By the host, while the host is live</Gate>
        <Gate name="In the room">A two-hour key for this room only</Gate>
        <Gate name="Transcribed">Text leaves the device. Audio never does</Gate>
      </ol>
    ),
    rows: [
      ['Hosts', 'Only a Google account from your company can host, proven by Google itself. A room belongs to its owner by configuration, never by a submitted name or link'],
      ['Guests', 'Ask to join, and hold a secret until the host admits you. No media flows before that, and the host has to be live within the last thirty seconds'],
      ['Keys', 'A room key lasts two hours and opens one room. Sessions last eight hours. Logs never hold keys, transcripts, emails, or lobby secrets'],
      ['Devices', 'Settings lists every Mac and phone signed in to your account, by name. Sign one out from anywhere and Starlings refuses its next request. A session stays on its device and never goes into a backup'],
      ['Captions', 'Starlings shows captions only from the verified host. Reactions are an enum, so a guest cannot put text on your screen'],
      ['Agents', 'Never hold a session. They come through one signed endpoint, rate limited, and Starlings logs every call'],
      ['Browser', 'Strict content policy, no framing, no referrer. Shared files render in a sandbox with no scripts'],
    ],
    more: { href: '/privacy', label: 'The full privacy and security contract' },
    span: 12,
  },
  'privacy': {
    id: 'privacy',
    icon: <EyeOffGlyph />,
    title: 'Privacy',
    fact: 'Starlings keeps the text of a call and the minimum about each person.',
    figure: (
      <div className="grid grid-cols-3 gap-2 max-[960px]:grid-cols-1">
        <PrivacySubject name="A guest">
          <PrivacyLine kept>Name and email, for the waiting room</PrivacyLine>
          <PrivacyLine>No account, no cookie profile, no tracking</PrivacyLine>
          <PrivacyLine>Never sees who else is online</PrivacyLine>
        </PrivacySubject>
        <PrivacySubject name="A meeting">
          <PrivacyLine kept>Transcript text: speaker, time, and text</PrivacyLine>
          <PrivacyLine kept>A summary, written from that text</PrivacyLine>
          <PrivacyLine>No audio, video, or screen, at any point</PrivacyLine>
        </PrivacySubject>
        <PrivacySubject name="A member">
          <PrivacyLine kept>Online now, and a last-seen time</PrivacyLine>
          <PrivacyLine>No history of where you were</PrivacyLine>
          <PrivacyLine>Messages never enter a database or a log</PrivacyLine>
        </PrivacySubject>
      </div>
    ),
    rows: [
      ['Speech', 'The host\'s Mac or iPhone transcribes it in memory and discards the audio as it goes. Only finished text leaves'],
      ['Notes', 'A model writes them from the transcript text. The model providers do not train on it'],
      ['Who sees notes', 'People who were in the call, inside Starlings. Starlings never emails a transcript'],
      ['Where', 'Cloudflare. Direct messages are stored only in the EU'],
      ['Logs', 'Never hold a token, a transcript, a message, an email address, or a lobby secret'],
    ],
    more: { href: '/privacy', label: 'The full privacy contract' },
    span: 12,
  },
  'building-blocks': {
    id: 'building-blocks',
    icon: <StackGlyph />,
    title: 'The building blocks',
    fact: 'Starlings is the app. Records, documents and the vault are separate services, each with its own store and key.',
    figure: (
      <ServiceRow>
        <ServiceCell title="Starlings" foot="One Google sign-in" app>Rooms, messages, presence, the transcript pipeline</ServiceCell>
        <ServiceCell title="Records" foot="Its own token">Projects, leads, partners, people</ServiceCell>
        <ServiceCell title="Docs" foot="Its own token">Documents, versions, comments, shares</ServiceCell>
        <ServiceCell title={t('Secrets')} foot="Its own token">Passwords and keys, encrypted on the device</ServiceCell>
      </ServiceRow>
    ),
    rows: [
      ['One sign-in', 'You sign in to Starlings. Starlings confirms who you are to each service. The service gives your device its own key. Starlings never keeps it'],
      ['Direct', 'After that, your Mac or phone talks to the service itself. Each service enforces its own rules, once'],
      ['Self-describing', 'Each service says what it holds and what you may do. Starlings shows only that'],
      ['Separate keys', 'A key for Docs does not open Keep. Revoke one and the others still work'],
      ['Extensible', 'A new service needs a store, a key, a package, and an entry point in Starlings. The tabs do not change'],
    ],
    span: 12,
  },
  'technology': {
    id: 'technology',
    icon: <CloudGlyph />,
    title: 'Technology',
    fact: 'Media on LiveKit, transcription on the host\'s device, everything else on one Cloudflare Worker.',
    figure: (
      <ServiceRow three>
        <ServiceCell title="Media" foot={<Ext href="https://webrtc.org">WebRTC</Ext>}><Ext href="https://livekit.io">LiveKit Cloud</Ext> carries audio, video, and screen between the people in a room. Nothing is recorded</ServiceCell>
        <ServiceCell title="Transcription" foot="On device"><Ext href="https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3">Parakeet v3</Ext> runs on the host's Mac or iPhone through <Ext href="https://developer.apple.com/machine-learning/core-ml/">Core ML</Ext>, via <Ext href="https://github.com/FluidInference/FluidAudio">FluidAudio</Ext>. Audio never leaves it; text does</ServiceCell>
        <ServiceCell title="Control plane" foot={<Ext href="https://www.cloudflare.com">Cloudflare</Ext>}>One <Ext href="https://workers.cloudflare.com">Worker</Ext>. A <Ext href="https://developers.cloudflare.com/durable-objects/">Durable Object</Ext> per room and per thread, <Ext href="https://developers.cloudflare.com/d1/">D1</Ext>, <Ext href="https://developers.cloudflare.com/kv/">KV</Ext>, <Ext href="https://developers.cloudflare.com/r2/">R2</Ext>, and a <Ext href="https://developers.cloudflare.com/queues/">queue</Ext> for the transcript pipeline</ServiceCell>
        <ServiceCell title="Models" foot={<><Ext href="https://www.anthropic.com">Anthropic</Ext>, <Ext href="https://www.llama.com">Llama</Ext></>}><Ext href="https://claude.com">Claude</Ext> writes the meeting notes and reads forwarded mail for events. <Ext href="https://developers.cloudflare.com/workers-ai/">Workers AI</Ext> drafts the summary, suggests tasks, and suggests where an imported note belongs</ServiceCell>
        <ServiceCell title="Clients" foot={<><Ext href="https://www.swift.org">Swift</Ext>, <Ext href="https://www.typescriptlang.org">TypeScript</Ext></>}><Ext href="https://developer.apple.com/documentation/appkit">AppKit</Ext> on the Mac, <Ext href="https://developer.apple.com/swiftui/">SwiftUI</Ext> on iPhone, iPad, and Watch, <Ext href="https://react.dev">React</Ext> on the web. One shared wire contract</ServiceCell>
        <ServiceCell title="Agents" foot={<Ext href="https://vercel.com">Vercel</Ext>}>Each agent is a <Ext href="https://vercel.com/eve">Vercel Eve</Ext> sandbox with its own skills and keys. It reaches Starlings through one signed endpoint</ServiceCell>
      </ServiceRow>
    ),
    rows: [
      ['Rooms', 'A Durable Object holds each room: who is waiting, who is in, whose hand is up. LiveKit only ever sees a signed two-hour key'],
      ['Agent activity', 'Admin shows handoffs, runtime acceptance or refusal, finalized replies observed by Starlings, and watchdog resets. Runtime model costs are not included'],
      ['Transcript pipeline', 'The host device posts finished text to the Worker. A queue turns it into the transcript, the summary, and a record on the project, with retries and a dead letter an admin can replay. The Worker counts failures and daily model spend and sends an alert by email'],
      ['Services', <>Records, Docs and Keep are separate services. Starlings reaches them over <Ext href="https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/">service bindings</Ext>, never the public internet</>],
      ['Contract', <>One package of <Ext href="https://zod.dev">Zod</Ext> schemas defines every wire shape. The Swift clients read the same fixtures, so the three clients cannot drift</>],
      ['Ships', <>Every push to main deploys the web app and the Worker through <Ext href="https://developers.cloudflare.com/workers/ci-cd/builds/">Workers Builds</Ext>. Mac and iOS releases are <Ext href="https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution">notarized</Ext> from a tag, and the Mac app checks for its own update</>],
      ['Sign-in', <><Ext href="https://developers.google.com/identity">Google</Ext>, your company’s accounts only. The Worker encrypts refresh tokens; the device keeps a session and its own device id</>],
    ],
    span: 12,
  },
};

export const THEMES: readonly Theme[] = [
  {
    id: 'project',
    page: '/workspace/capabilities',
    anchor: 'project',
    title: 'Everything about a project, in one place.',
    lede: 'Each project keeps its chat, tasks, issues, documents and past calls together. You don’t connect anything.',
    features: ['project', 'tasks', 'issues', 'transcript-tasks', 'messages', 'quick-notes', 'recorder', 'docs', 'internal-room', 'email-forwarding', 'search', 'reach', 'stages'],
    glance: { title: t('Calls, chat, tasks and docs in one app.'), fact: t('They share one data model, so you don’t connect anything. When a call ends, its notes and follow-ups are already on the project.'), figure: 'project', span: 7 },
  },
  {
    id: 'surfaces',
    page: '/workspace/capabilities',
    anchor: 'surfaces',
    title: 'One workspace for you, your team and your agents.',
    lede: 'See your day, plan your week, pick up what needs you and find who is around. Your agents work in the same place.',
    features: ['home', 'team', 'calendar', 'work'],
  },
  {
    id: 'calls',
    page: '/workspace/capabilities',
    anchor: 'calls',
    title: 'Calls that file their own notes.',
    lede: 'Send a link and guests join from a browser, with no account. The host’s device writes the transcript, and Starlings files it on the project.',
    features: ['kept', 'join-link', 'waiting-room', 'captions', 'transcript', 'call-controls', 'booking', 'hosting'],
  },
  {
    id: 'outside',
    page: '/workspace/capabilities',
    anchor: 'outside',
    title: t('Work with people outside your team.'),
    lede: t('Share one project with a client or a partner company. They see that project and nothing else, and their agents can work in it too.'),
    features: ['share-project'],
  },
  {
    id: 'privacy',
    page: '/workspace/capabilities',
    anchor: 'privacy',
    title: 'Private until you share it.',
    lede: 'Quick Notes and personal calendars stay private. Anything you file into a project, conversation, document or the company calendar takes that place\'s access rules.',
    features: ['private-by-default', 'shared-by-choice'],
  },
  {
    id: 'platforms',
    page: '/workspace/capabilities',
    anchor: 'platforms',
    title: 'Mac, iPhone, and the browser.',
    lede: 'The native apps and the web app share the same building blocks.',
    features: ['native-apps'],
  },
  {
    id: 'access',
    page: '/workspace/capabilities',
    anchor: 'access',
    title: 'For everyone.',
    lede: 'Every control works with a screen reader and a keyboard.',
    features: ['accessibility'],
  },
  {
    id: 'agents',
    page: '/integrations',
    anchor: 'agents',
    title: 'Your agents work inside the workspace.',
    lede: 'An agent reads the same calls, tasks and documents as your team, and files its work where the team will look for it. Starlings logs each MCP call under the name of the person who asked.',
    features: ['mcp', 'decisions', 'attention', 'shared-agents'],
    glance: { title: t('Agents work alongside your team.'), fact: t('Connect Claude through MCP and it works as you: read only, or read and write. Starlings logs every call it makes under the name of the person who asked.'), figure: 'shared-agents', span: 5 },
  },
  {
    id: 'connectors',
    page: '/integrations',
    anchor: 'connectors',
    title: 'Works with the tools you use.',
    lede: 'Map each source to a project once. Starlings files only what you map.',
    features: ['connectors', 'google-workspace'],
    glance: { title: t('Works with the tools you use.'), fact: t('Sign in with Google Workspace and bring your calendar. Pull in history from GitHub, Slack and Granola.'), figure: 'connectors', span: 7 },
  },
  {
    // /security opens on this grid with no section head of its own: the
    // page's hero is the theme's head, and carries its anchor.
    id: 'data',
    page: '/security',
    anchor: 'data',
    title: 'Security and data.',
    lede: 'Starlings keeps your team’s work in your own workspace, apart from every other team’s. Here is where it lives, who can see it, and what Starlings never keeps.',
    features: ['your-data', 'keep-vault', 'security', 'privacy', 'building-blocks', 'technology'],
    glance: { title: t('Your data stays yours.'), fact: t('Starlings keeps each workspace separate from every other team’s. Download transcripts and notes as plain Markdown files at any time.'), figure: 'your-data', span: 5 },
  },
];

export function feature(id: FeatureId): Feature {
  return FEATURES[id];
}

export function theme(id: ThemeId): Theme {
  // THEMES lists every ThemeId once; a miss is a typo the type already stops.
  return THEMES.find((entry) => entry.id === id)!;
}

/** Where a theme's section is: its page and its anchor. */
export function themeHref(entry: Theme): string {
  return `${entry.page}#${entry.anchor}`;
}

/**
 * A theme's section head: its anchor, title and lede, from the library.
 * `className` adds to the section style, for a head that opens its page.
 */
export function ThemeHead({ id, className }: { id: ThemeId; className?: string }) {
  const { anchor, title, lede } = theme(id);
  return (
    <header id={anchor} className={className ? cn(SECTION_HERO, className) : SECTION_HERO}>
      <h2>{title}</h2>
      <p className="lede">{lede}</p>
    </header>
  );
}

/** The theme a feature sits in, for a glance tile's link to its section. */
function themeOf(id: FeatureId): Theme | undefined {
  return THEMES.find((entry) => entry.features.includes(id));
}

/**
 * The one renderer for the library. `detail` is /workspace: every tile at its
 * span, with its facts and its link. `glance` is a page that points at the
 * feature: icon, name, sentence and drawing, and a link to the feature's
 * section, on whichever page holds its theme, in place of the facts.
 */
export function FeatureBento(props:
  | { theme: ThemeId; depth: 'detail' | 'glance' }
  | { ids: readonly FeatureId[]; depth: 'detail' | 'glance' }
  | { themes: readonly ThemeId[]; depth: 'glance' }): JSX.Element {
  if ('themes' in props) return <ThemeGlance ids={props.themes} />;
  const ids = 'theme' in props ? theme(props.theme).features : props.ids;
  return (
    <div className={GRID}>
      {ids.map((id) => {
        const entry = feature(id);
        if (props.depth === 'glance') {
          const home = themeOf(id);
          return (
            <Tile
              key={id}
              span={entry.span}
              icon={entry.icon}
              title={entry.title}
              fact={entry.fact}
              illustration={entry.figure}
              more={home && { href: themeHref(home), label: home.title }}
            />
          );
        }
        return (
          <Tile
            key={id}
            id={`feature-${id}`}
            span={entry.span}
            icon={entry.icon}
            title={entry.title}
            fact={entry.fact}
            illustration={entry.figure}
            rows={withSurfaces(entry)}
            more={entry.more}
            hero={entry.hero}
          />
        );
      })}
    </div>
  );
}

/**
 * A slice of the by-surface matrix, read from the same data `/workspace/status`
 * draws, so the tile cannot claim parity the table would deny.
 */
const PARITY_ROWS: Array<[id: string, label: string]> = [
  ['owner-admit', 'Host a call'],
  ['entry-waiting', 'Join one'],
  ['collab-captions', 'Live captions'],
  ['collab-artifacts', 'Transcript and summary'],
  ['owner-calendar', 'Calendar'],
  ['owner-work', 'Work'],
  ['owner-direct-messages', 'Messages'],
  ['owner-issues', 'Issues'],
  ['owner-docs-graph', 'Docs graph'],
];
const PARITY_SURFACES: Array<[key: CapabilitySurface, label: string]> = [
  ['mac-host', 'Mac'],
  ['ios', 'iPhone and iPad'],
  ['web', 'Web'],
];

const PARITY_CELL = 'border-t border-border px-2 py-1.5 text-center';
const PARITY_HEAD = cn(PARITY_CELL, CAPS, 'border-t-0 font-semibold tracking-[0.04em] text-muted-foreground');
const PARITY_MARK: Record<SurfaceStatus, string> = {
  works: 'text-(--accent-mark)',
  partial: 'text-muted-foreground',
  handoff: 'text-muted-foreground [&_svg]:-rotate-90',
  'not-available': 'text-muted-foreground',
};

/** The same marks the hero's ledger uses: a check, a cross, and the arrow for a handoff. */
function ParityMark({ status }: { status: SurfaceStatus }) {
  if (status === 'not-available') return <CrossGlyph />;
  if (status === 'handoff') return <ArrowGlyph />;
  return <CheckGlyph />;
}

function ParityTable() {
  return (
    <Table className="border-collapse text-[12px]">
      <TableHeader>
        <TableRow>
          <TableHead scope="col" className={PARITY_HEAD}><span className="sr-only">Feature</span></TableHead>
          {PARITY_SURFACES.map(([key, label]) => <TableHead key={key} scope="col" className={PARITY_HEAD}>{label}</TableHead>)}
        </TableRow>
      </TableHeader>
      <TableBody>
        {PARITY_ROWS.map(([id, label]) => {
          const row: Capability | undefined = capabilityById(id);
          const surfaces = row?.surfaces;
          if (!surfaces) return null;
          return (
            <TableRow key={id}>
              <TableHead scope="row" className={cn(PARITY_CELL, 'text-left')}>{label}</TableHead>
              {PARITY_SURFACES.map(([key]) => {
                const status = surfaces[key] ?? 'not-available';
                return (
                  <TableCell key={key} className={cn(PARITY_CELL, '[&_svg]:align-middle', PARITY_MARK[status])}>
                    <ParityMark status={status} />
                    <span className="sr-only">{SURFACE_STATUS_LABEL[status]}</span>
                  </TableCell>
                );
              })}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Whole themes, one tile each, linking to where each is told in full. */
function ThemeGlance({ ids }: { ids: readonly ThemeId[] }): JSX.Element {
  return (
    <div className={GRID}>
      {ids.map((id) => {
        const entry = theme(id);
        if (!entry.glance) throw new Error(`Theme ${id} has no glance`);
        const lead = feature(entry.glance.figure);
        return (
          <Tile
            key={id}
            span={entry.glance.span}
            icon={lead.icon}
            title={entry.glance.title}
            fact={entry.glance.fact}
            illustration={lead.figure}
            more={{ href: themeHref(entry), label: t('More'), name: t('More: {title}', { title: entry.glance.title.replace(/\.$/u, '') }) }}
          />
        );
      })}
    </div>
  );
}

/** How a surface reads in a tile's "Works on" row: the Mac once, whichever mode. */
const SURFACE_NAME: Record<CapabilitySurface, string> = { 'mac-host': t('Mac'), 'mac-join': t('Mac'), web: t('Web'), ios: t('iPhone and iPad') };

/** Where a feature works, from its capability row: every surface not marked unavailable. */
export function surfacesOf(entry: Feature): string[] {
  const row = entry.capability ? capabilityById(entry.capability) : undefined;
  const names = Object.entries(row?.surfaces ?? {})
    .filter(([, status]) => status === 'works' || status === 'partial')
    .map(([surface]) => SURFACE_NAME[surface as CapabilitySurface]);
  return [...new Set(names)];
}

/** A feature's facts, closed by where it works when its capability says. */
function withSurfaces(entry: Feature): Feature['rows'] {
  const names = surfacesOf(entry);
  if (names.length === 0) return entry.rows;
  return [...(entry.rows ?? []), [t('Works on'), names.join(', ')]];
}
