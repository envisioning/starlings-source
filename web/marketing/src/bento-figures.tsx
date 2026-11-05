/**
 * The drawings the public pages share. `FeaturesPage` invented this
 * vocabulary — a small flat picture of the thing, drawn in Tailwind utilities
 * on the theme tokens (the shared parts are in `bento.ts`) — and `WhyPage`
 * shows the same pictures beside its argument. They live here so neither page imports the
 * other's chunk, and so a drawing that changes changes in one place.
 *
 * Every figure is decorative: it repeats what the prose beside it already
 * says, and is wrapped by the caller in an `aria-hidden` container. A figure
 * that draws real controls is `inert` at its root, so they take no focus or
 * clicks; a figure with real outbound links (Technology) is not.
 *
 * Where a figure shows a control, it is the real shadcn control with sample
 * data: the picture of the product is the product, so it cannot
 * drift from what a member sees.
 */
import { WORKSPACE_HOST_SUFFIX } from '@starlings/contracts/workspace-slug';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { Input } from '@/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/ui/tabs';
import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/ui/item';
import { cn } from '@/lib/utils';
import { t } from '@shared/i18n';
import { CallCameraIcon, CallMicIcon, WaveIcon } from '@shared/action-icons';
import { formatTime } from '@shared/meeting-time';
import { AgentAvatar } from '@shared/peer-face';
import { sampleAgentIdentity, useSampleMeeting } from './sim/sample-meeting';
import { CAPS, MONO, RAISED, ROW, ROW_DONE, ROW_LIST, ROW_META, SUNKEN, TURN, TURN_MINE } from './bento';
import { ArrowGlyph } from './feature-tiles';

/** A URL, as the browser bar shows it: host in grey, room slug in ink. */
export function Address({ host, slug, tail, slugFirst = false, className }: { host: string; slug: string; tail?: string; slugFirst?: boolean; className?: string }) {
  const hostNode = <span className="text-muted-foreground">{host}</span>;
  const slugNode = <span className="font-semibold text-foreground">{slug}</span>;
  return (
    <div className={cn(SUNKEN, 'inline-flex max-w-full flex-wrap items-baseline px-3.5 py-2.5 font-mono text-[13px] leading-[1.4] [overflow-wrap:anywhere]', className)}>
      {slugFirst ? slugNode : hostNode}
      {slugFirst ? hostNode : slugNode}
      {/* A booking token: the same room, with the invite's title and time on the card. */}
      {tail && <span className="text-muted-foreground">{tail}</span>}
    </div>
  );
}

/** One caption line, the way the stage draws it, with the caret still writing. */
export function CaptionFigure({ speaker = 'Speaker', words = 'what they say, as they say it' }: { speaker?: string; words?: string } = {}) {
  return (
    <div className={cn(SUNKEN, 'flex flex-col gap-1 px-3 py-2.5 text-[13px] leading-[1.45]')}>
      <span className="text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">{speaker}</span>
      <span>
        {words}
        <span className="ml-[3px] inline-block h-[0.95em] w-0.5 animate-caret-blink bg-(--accent) align-text-bottom motion-reduce:animate-none" />
      </span>
    </div>
  );
}

/**
 * One service or tool in a row of them, as an outlined Item. `app` rings the
 * one that signs in; `planned` is dashed and muted.
 */
export function ServiceCell({ title, foot, app = false, planned = false, children }: {
  title: string;
  foot: ReactNode;
  app?: boolean;
  planned?: boolean;
  children: ReactNode;
}) {
  return (
    <Item variant="outline" size="sm" className={cn('min-w-0 flex-col flex-nowrap items-start gap-1 bg-popover px-3.5 py-3', app && 'border-(--accent)', planned && 'border-dashed')}>
      <ItemTitle className={planned ? 'text-muted-foreground' : undefined}>{title}</ItemTitle>
      <ItemDescription className="line-clamp-none text-xs">{children}</ItemDescription>
      <small className="mt-auto pt-1.5 text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">{foot}</small>
    </Item>
  );
}

/** A row of ServiceCells: four across, two on a tablet, one on a phone. `three` sets three across. */
export function ServiceRow({ three = false, children }: { three?: boolean; children: ReactNode }) {
  return (
    <div className={cn('grid gap-2 max-[960px]:grid-cols-2 max-[640px]:grid-cols-1', three ? 'grid-cols-3' : 'grid-cols-4')}>
      {children}
    </div>
  );
}

export function PersonGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="5.5" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2.8 14a5.2 5.2 0 0 1 10.4 0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function MessageGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.5 3.5h11v7.5H7l-3 2.5v-2.5H2.5Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function LockGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/**
 * The prejoin card a guest sees: the room link, the invite, a preview, name,
 * email, Ask to join. With no props it is the decorative figure. A
 * simulation passes the sample invite and `onAsk`; the card is then live:
 * the name field types and Ask to join answers, and `waitingFor` names the
 * host the guest waits for.
 */
export function PrejoinFigure({ room = { host: `example.${WORKSPACE_HOST_SUFFIX}/room/`, slug: 'host', tail: '/k7f3q2' }, title = 'Meeting title', when = 'Today, 14:30', name, onName, waitingFor, onAsk, camera, onCamera }: {
  room?: { host: string; slug: string; tail?: string };
  title?: string;
  when?: string;
  name?: string;
  onName?: (name: string) => void;
  waitingFor?: string | null;
  onAsk?: () => void;
  /** The guest's own camera in the preview: their picture while it is on. */
  camera?: { photo: string; portrait: boolean; on: boolean };
  onCamera?: () => void;
} = {}) {
  const live = Boolean(onAsk);
  return (
    <div className={cn(RAISED, 'flex flex-col gap-2 p-3')} inert={!live}>
      <span className="mb-1 flex items-center gap-2 self-stretch rounded-full border border-border bg-muted px-3 py-1.5 text-muted-foreground [&>svg]:flex-none">
        <LockGlyph />
        <Address host={room.host} slug={room.slug} tail={room.tail} className="rounded-none border-0 bg-transparent p-0 text-[12px]" />
      </span>
      <span className="mb-1 flex items-baseline gap-2 text-[12px] text-muted-foreground"><b className="text-[14px] font-semibold text-foreground">{title}</b>{when}</span>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3">
        <div className="flex flex-col items-center gap-1.5">
          <span className="relative aspect-square w-24 overflow-hidden rounded-sm border border-border bg-muted">
            {camera?.on && <img src={camera.photo} alt="" className={cn('absolute inset-0 size-full object-cover motion-safe:animate-in motion-safe:fade-in-0', camera.portrait && 'object-[50%_30%]')} />}
            <i className="absolute bottom-[5px] left-[5px] rounded-full bg-popover px-1.5 py-px text-[10px] font-semibold not-italic">You</i>
          </span>
          <span className="flex gap-1.5">
            <b className={PREVIEW_DEVICE}><CallMicIcon /></b>
            {/* shadcn: a drawn copy of the app's device chip, sized and styled like the <b> beside it; a Button would not match */}
            {onCamera
              ? <button type="button" data-sim="prejoin-camera" aria-label={t('Camera')} aria-pressed={Boolean(camera?.on)} onClick={onCamera} className={cn(PREVIEW_DEVICE, 'hover-lift', camera?.on && 'text-[var(--accent-mark)]')}><CallCameraIcon /></button>
              : <b className={PREVIEW_DEVICE}><CallCameraIcon /></b>}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-2">
          <Input readOnly={!onName} tabIndex={live ? undefined : -1} placeholder="Your name" aria-label="Your name" data-sim="name" value={name ?? ''} onChange={(event) => onName?.(event.target.value)} className="h-8 text-xs" />
          <Input readOnly tabIndex={-1} placeholder="Your email" className="h-8 text-xs" />
          <Button size="sm" tabIndex={live ? undefined : -1} data-sim="ask" disabled={Boolean(waitingFor)} onClick={onAsk}>
            {waitingFor ? `Waiting for ${waitingFor}` : 'Ask to join'}
          </Button>
        </div>
      </div>
    </div>
  );
}

const PREVIEW_DEVICE = 'inline-flex size-7 items-center justify-center rounded-md border border-input bg-secondary text-foreground';

/** A subject as it opens in Work: its head, its panes on Talk, and Talk's first lines. */
export function SubjectFigure({ panes, filed }: { panes: string[]; filed: string }) {
  return (
    <div className={cn(RAISED, 'flex flex-col gap-2.5 px-3.5 py-3')} inert>
      <div className="flex items-baseline gap-2.5 text-[13px]">
        <b className="text-[14px] font-semibold">A project</b>
        <span className="flex-1 text-[12px] text-muted-foreground">Their company · Active</span>
        <Button size="xs" tabIndex={-1}>Meet about this</Button>
      </div>
      <Tabs value="Talk">
        <TabsList className="h-8">
          {panes.map((pane) => <TabsTrigger key={pane} value={pane} tabIndex={-1} className="px-2 text-xs">{pane}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      <div className="flex flex-col gap-1.5">
        <p className={cn(TURN, 'max-w-[60%] bg-muted')}>A message from a colleague</p>
        <small className={TALK_EVENT}>{filed}</small>
        <small className={TALK_EVENT}>GitHub: issue #142 opened</small>
        <p className={cn(TURN, TURN_MINE, 'max-w-[60%] bg-[color-mix(in_srgb,var(--accent)_16%,var(--surface-sunken))]')}>Your reply</p>
      </div>
    </div>
  );
}

const TALK_EVENT = 'py-0.5 text-center text-[11px] text-muted-foreground';

/**
 * A commitment from the transcript, offered as a task with Accept. With no
 * props it is the decorative figure; a simulation passes the sample quote
 * and task and `onAccept`, and the Accept button answers.
 */
export function SuggestFigure({ quote = 'A commitment someone made out loud', task = 'The task it becomes', acceptLabel = 'Accept', onAccept, simTarget }: {
  quote?: string;
  task?: string;
  acceptLabel?: string;
  onAccept?: () => void;
  /** The `data-sim` name a scripted pointer finds the Accept button by. */
  simTarget?: string;
} = {}) {
  return (
    <div className="flex flex-col gap-2" inert={!onAccept}>
      <q className="border-l-2 border-border px-3 py-1.5 text-[13px] text-muted-foreground italic [quotes:'“'_'”']">{quote}</q>
      <div className={cn(RAISED, 'flex items-center gap-2.5 py-2 pr-2 pl-3 text-[13px]')}>
        <Checkbox tabIndex={-1} />
        <span className="min-w-0 flex-1">{task}</span>
        <Button size="xs" tabIndex={onAccept ? undefined : -1} data-sim={simTarget} onClick={onAccept}>{acceptLabel}</Button>
      </div>
    </div>
  );
}

/**
 * A decision ask as INBOX shows it: the agent's question, its options with the
 * recommended one marked, and the day the default applies. Strings come in,
 * so the home page passes keyed copy and /workspace passes its own.
 */
export function DecisionFigure({ from, question, options, recommended, recommendedLabel, defaultBy }: {
  from: string; question: string; options: string[]; recommended: number; recommendedLabel: string; defaultBy: string;
}) {
  return (
    <div className={cn(RAISED, 'flex flex-col gap-2.5 px-3.5 py-3')} inert>
      <span className="text-[11px] text-muted-foreground">{from}</span>
      <span className="text-[14px] font-medium leading-snug">{question}</span>
      <div className="flex flex-wrap gap-2">
        {options.map((option, index) => (
          <Button key={option} size="xs" variant={index === recommended ? 'default' : 'outline'} tabIndex={-1}>
            {option}{index === recommended && <span className="opacity-75">· {recommendedLabel}</span>}
          </Button>
        ))}
      </div>
      <small className={ROW_META}>{defaultBy}</small>
    </div>
  );
}

/** Two task rows: one open, one done. */
export function TaskListFigure() {
  return (
    <ul className={ROW_LIST} inert>
      <li className={ROW}><Checkbox tabIndex={-1} />An open task<small className={ROW_META}>Today</small></li>
      <li className={cn(ROW, ROW_DONE)}><Checkbox tabIndex={-1} checked />A done task<small className={ROW_META}>Done</small></li>
    </ul>
  );
}

/**
 * An agent's own figure, as the app draws it: this visit's sample agent, so
 * it changes per visit. `seed` draws a different agent beside it, for a
 * figure that shows two. Size it with `className`.
 */
export function SampleAgentFace({ seed, className = 'size-4' }: { seed?: string; className?: string }) {
  const meeting = useSampleMeeting();
  const identity = seed ? sampleAgentIdentity(`${seed} ${meeting.agent}`) : meeting.agentIdentity;
  return <AgentAvatar identity={identity} className={cn('flex-none border-0 bg-transparent', className)} />;
}

/** People and agents as Team lists them: a mark, a name, their presence, and Message / Wave. */
export function RosterFigure({ rows }: { rows: { mark: ReactNode; label: string; presence: 'on' | 'meeting' | 'off' }[] }) {
  return (
    <ul className={ROW_LIST} inert>
      {rows.map((row) => (
        <li key={row.label}>
          <Item variant="outline" size="sm" className="gap-2.5 bg-popover py-1.5 pr-2 pl-1.5">
            <ItemMedia className="size-7 rounded-full bg-muted text-[11px] font-semibold">{row.mark}</ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle className="gap-1.5 text-xs font-normal text-muted-foreground">
                {row.label}
                <i className={cn('size-2 flex-none rounded-full', PRESENCE_DOT[row.presence])} />
              </ItemTitle>
            </ItemContent>
            <ItemActions className="gap-1">
              <Button variant="secondary" size="icon-xs" tabIndex={-1}><MessageGlyph /></Button>
              <Button variant="secondary" size="icon-xs" tabIndex={-1}><WaveIcon className="size-3.5! basis-3.5!" /></Button>
            </ItemActions>
          </Item>
        </li>
      ))}
    </ul>
  );
}

const PRESENCE_DOT: Record<'on' | 'meeting' | 'off', string> = {
  on: 'bg-(--accent)',
  meeting: 'bg-(--presence-in-meeting)',
  off: 'bg-muted-foreground opacity-45',
};

/** The stage, as the app lays it out: equal squares, centred, on the dark stage. `columns` is what `squareGridPlan` would pick. */
export function Stage({ columns, footer, children }: { columns: number; footer?: ReactNode; children: ReactNode }) {
  return (
    <div className={cn(SUNKEN, 'flex flex-col gap-2 p-3')}>
      <div className="grid grid-cols-[repeat(var(--n),minmax(0,96px))] justify-center gap-2" style={{ '--n': columns } as CSSProperties}>
        {children}
      </div>
      {footer}
    </div>
  );
}

/** One square on the stage with its name capsule; `sharing` draws a screen share. */
export function StageTile({ label, sharing = false, photo }: { label: string; sharing?: boolean; photo?: string }) {
  return (
    <span className={cn(
      'relative aspect-square rounded-sm border',
      sharing
        ? 'border-input bg-[repeating-linear-gradient(135deg,var(--surface-raised)_0_6px,var(--surface-sunken)_6px_8px)]'
        : 'border-border bg-popover',
    )}>
      {photo && <img src={photo} alt="" loading="lazy" className="absolute inset-0 size-full rounded-[inherit] object-cover object-[50%_30%] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300" />}
      {label && <i className="absolute bottom-[5px] left-[5px] max-w-[calc(100%-10px)] truncate rounded-full bg-muted px-1.5 py-px text-[10px] font-semibold not-italic">{label}</i>}
    </span>
  );
}

/** Kept or not kept: a label and its items. */
export function LedgerColumn({ label, kept = false, children }: { label: string; kept?: boolean; children: ReactNode }) {
  return (
    <div className={cn(RAISED, 'px-4 py-3.5', kept ? '[&_svg]:text-(--accent-mark)' : '[&_dd]:text-muted-foreground')}>
      <dt className={cn(CAPS, 'mx-0 mt-0 mb-2 text-muted-foreground')}>{label}</dt>
      {children}
    </div>
  );
}

/** One node of the host, relay, guests flow. */
export function FlowNode({ icon, name, detail }: { icon: ReactNode; name: string; detail: string }) {
  return (
    <span className={cn(RAISED, 'flex min-w-0 flex-col items-center gap-0.5 px-2 py-3 text-center [&>svg]:mb-1 [&>svg]:size-6')}>
      {icon}
      <b className="text-[12px] font-semibold">{name}</b>
      <small className="text-[11px] leading-[1.3] text-muted-foreground">{detail}</small>
    </span>
  );
}

/** The way media goes between two flow nodes: across on a wide tile, down on a phone. */
export function FlowArrow() {
  return (
    <i className="flex -rotate-90 text-muted-foreground max-[640px]:rotate-0 max-[640px]:justify-center [&_svg]:m-0 [&_svg]:size-4">
      <ArrowGlyph />
    </i>
  );
}

/** One ⌘K result with its kind; the first is the selected one. */
export function PaletteRow({ label, kind, selected = false }: { label: string; kind: string; selected?: boolean }) {
  return (
    <li className={cn('flex items-baseline gap-2.5 rounded-md px-2 py-1.5 text-[13px]', selected && 'bg-(--selected)')}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <small className="text-[11px] text-muted-foreground">{kind}</small>
    </li>
  );
}

/** A column of Work's overview: the head with its count, then its rows. */
export function OverviewColumn({ head, count, children }: { head: string; count: number; children: ReactNode }) {
  return (
    <div className={cn(RAISED, 'flex min-w-0 flex-col gap-1.5 px-3 py-2.5 text-[12px]')}>
      <span className={cn(OVERVIEW_LINE, CAPS, 'mb-0.5 text-muted-foreground')}>{head}<Badge variant="secondary" className="px-1.5">{count}</Badge></span>
      {children}
    </div>
  );
}

const OVERVIEW_LINE = 'flex items-baseline gap-2 truncate';

export function OverviewRow({ meta, children }: { meta?: string; children: ReactNode }) {
  return (
    <span className={cn(OVERVIEW_LINE, '[&>svg]:size-3 [&>svg]:flex-none [&>svg]:self-center')}>
      {children}
      {meta && <small className={cn('ml-auto text-[11px] text-muted-foreground', meta.startsWith('#') && MONO)}>{meta}</small>}
    </span>
  );
}

/** Seven columns, today ringed, a few blocks: the week as Calendar draws it. */
export function WeekStrip() {
  // The visitor's day, never the build's: the prerender rings no day, the browser rings today.
  const today = useSyncExternalStore(noSubscription, () => new Date().getDay(), () => -1);
  const days = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const blocks: Record<number, number[]> = { 1: [1, 4], 2: [2], 3: [1, 5], 4: [3], 5: [2, 5] };
  return (
    <div className={cn(RAISED, 'grid grid-cols-7 gap-1 p-2.5')}>
      {days.map((label, index) => (
        <div key={index} className="flex flex-col items-center gap-1.5">
          <span className={cn(
            'inline-flex size-5 items-center justify-center rounded-full text-[11px] font-semibold',
            index === today ? 'text-foreground shadow-[inset_0_0_0_1.5px_var(--accent)]' : 'text-muted-foreground',
          )}>{label}</span>
          <span className="grid w-full grid-rows-[repeat(6,9px)] gap-0.5 border-t border-border px-0.5 pt-1">
            {(blocks[index] ?? []).map((row) => (
              <i key={row} className="block rounded-xs bg-input" style={{ gridRow: `${row} / span 2` }} />
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The Home clock, live: `formatTime` keeps it 24-hour (AGENTS.md invariant 20). */
export function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  // The prerender holds the clock's place without a time, so the build's time never shows or mismatches hydration.
  const client = useSyncExternalStore(noSubscription, () => true, () => false);
  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return client ? <>{formatTime(now)}</> : <span className="invisible">{formatTime(new Date(2026, 0, 1, 12, 0))}</span>;
}

const noSubscription = () => () => {};
