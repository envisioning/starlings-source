import { useEffect, useRef, useState } from 'react';
import { Button } from '@/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { SAMPLE_MEETING, useSampleMeeting } from './sim/sample-meeting';
import { SimWindow } from './sim/SimWindow';
import { WALLPAPER_STAGE } from './sim/SimStage';
import { SampleAgentFace } from './bento-figures';

type MiniMeetSceneID = 'calendar' | 'team' | 'docs';

type MiniMeetScene = {
  id: MiniMeetSceneID;
  label: string;
};

const MINI_MEET_DISPLAYS: readonly MiniMeetScene[] = [
  { id: 'calendar', label: 'Calendar' },
  { id: 'team', label: 'Team' },
  { id: 'docs', label: 'Docs' },
];

/** The rails, with this visit's workspace as the shared calendar. */
const miniRails = (workspace: string): Record<MiniMeetSceneID, {
  label: string;
  sections: Array<{ title: string; rows: Array<{ label: string; detail?: string; count?: string }> }>;
}> => ({
  calendar: {
    label: 'Calendar',
    sections: [
      { title: 'Calendars', rows: [{ label: workspace, detail: 'Shared company' }, { label: 'Personal', detail: 'Private' }] },
      { title: 'Views', rows: [{ label: 'Week', count: '7' }, { label: 'Agenda' }] },
    ],
  },
  team: {
    label: 'Team',
    sections: [
      { title: '', rows: [{ label: 'Lounge', detail: 'Who is around' }] },
      { title: 'You', rows: [{ label: 'You', detail: 'Available' }] },
      { title: 'Groups', rows: [{ label: 'Everyone', count: '4' }, { label: 'Core team' }] },
      { title: 'People', rows: [{ label: 'A colleague', detail: 'In a meeting' }, { label: 'Another person', detail: 'Available' }] },
      { title: 'Agents', rows: [{ label: 'Wren', detail: 'Working on a task' }] },
    ],
  },
  docs: {
    label: 'Docs',
    sections: [
      { title: 'Work', rows: [{ label: 'Recent', count: '6' }, { label: 'Meeting notes' }] },
      { title: 'By project', rows: [{ label: SAMPLE_MEETING.project, count: '12' }, { label: 'Client discovery', count: '4' }] },
      { title: 'By lead', rows: [{ label: 'A partner', count: '3' }] },
      { title: 'Library', rows: [{ label: 'Research', count: '18' }] },
    ],
  },
});

/*
 * The drawn Meet is Tailwind utilities on Meet's own tokens. It is
 * a picture, not the product: no real Calendar, Team or Docs component.
 * Home and Work are simulations made of the real components (sim/).
 * Phone and narrow widths use `max-[641px]` and `max-[901px]`, which match
 * `max-width: 640px` and `max-width: 900px` for whole-pixel widths, and sort
 * narrowest last.
 */

/** A small uppercase LABEL above a title or a rail section. */
const KICKER = 'text-(--muted) text-[9px] font-[650] tracking-[0.09em] leading-[1.2] uppercase';

/** A card's own LABEL, left of a count or a mark. */
const CARD_LABEL = 'truncate text-(--muted) text-[10px] font-[650] tracking-[0.07em] uppercase';

/** A panel inside the drawn window. The border colour is the caller's. */
const PANEL = 'min-w-0 p-3 bg-(--surface) border rounded-[9px]';

/** The narrow padding every panel takes on a phone. */
const PANEL_PHONE = 'max-[641px]:p-2.5';

const SECTION_HEAD = 'flex gap-2 items-center justify-between';
const DETAIL_TITLE = `m-0 font-[620] text-[22px] tracking-[-0.02em]`;
const DETAIL_COPY = 'm-0 text-(--ink) text-[12px] leading-[1.45]';
const MINE_BUBBLE = 'self-end bg-[color-mix(in_srgb,var(--accent)_25%,transparent)] rounded-[8px_8px_2px_8px]';

type MiniPresence = 'available' | 'meeting' | 'agent';

/** Presence on a drawn avatar: a ring for people, a rounded square for an agent. */
const AVATAR_KIND: Record<MiniPresence, string> = {
  available: 'rounded-full shadow-[inset_0_0_0_2px_var(--accent)]',
  meeting: 'rounded-full shadow-[inset_0_0_0_2px_var(--presence-in-meeting)]',
  agent: 'rounded-[7px]',
};

type MiniEventKind = 'mine' | 'shared' | 'private';

/** A calendar event: your own on the accent, the others quiet. */
const EVENT_KIND: Record<MiniEventKind, string> = {
  mine: 'top-[52%] text-(--ink) bg-[color-mix(in_srgb,var(--accent)_24%,transparent)] border-(--accent)',
  shared: 'top-[31%] text-(--muted) bg-(--surface-sunken) border-(--line)',
  private: 'top-[70%] text-(--muted) bg-(--surface-sunken) border-(--muted)',
};

/**
 * A small, presentational gallery of the signed-in Meet workspace. It is
 * deliberately not made from the real surface pages: those own auth, data
 * loading, and navigation. These are static marketing displays with fake
 * data, not a second application shell.
 */
export function MiniMeet() {
  return (
    <section className="mx-0 mt-0 mb-9" aria-label="A few windows into Starlings">
      <MiniMeetCarousel />

      <p className="mx-0 mt-2.5 mb-0 text-center text-[12px] text-(--muted)">Simulated views of Starlings with sample data.</p>
    </section>
  );
}

/**
 * One display at a time, full width. The track is a scroll-snap strip, so a
 * swipe or a trackpad scroll moves it; the tabs and the arrows scroll it the
 * same way. The active tab follows the track, not the other way round, so a
 * swipe never leaves the tabs stale.
 */
function MiniMeetCarousel() {
  const track = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const node = track.current;
    if (!node) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = node.clientWidth;
        if (width > 0) setActive(Math.round(node.scrollLeft / width));
      });
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      node.removeEventListener('scroll', onScroll);
    };
  }, []);

  const go = (index: number) => {
    const node = track.current;
    if (!node) return;
    const next = Math.max(0, Math.min(MINI_MEET_DISPLAYS.length - 1, index));
    node.scrollTo({ left: next * node.clientWidth, behavior: 'smooth' });
    setActive(next);
  };

  return (
    <Tabs value={MINI_MEET_DISPLAYS[active]?.id} onValueChange={(id) => go(MINI_MEET_DISPLAYS.findIndex((display) => display.id === id))} className="block">
      <div className="mb-3.5 flex items-center justify-between gap-3 [@media(max-width:640px)]:flex-wrap">
        <TabsList aria-label="Starlings displays" className="max-w-full [@media(max-width:640px)]:h-auto [@media(max-width:640px)]:flex-wrap">
          {MINI_MEET_DISPLAYS.map((display) => (
            <TabsTrigger key={display.id} value={display.id} className="px-3 max-[640px]:min-h-10">
              {display.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="flex flex-none gap-1.5">
          <Button type="button" variant="outline" size="icon-sm" className="text-base leading-none max-[640px]:size-10" aria-label="Previous display" disabled={active === 0} onClick={() => go(active - 1)}>‹</Button>
          <Button type="button" variant="outline" size="icon-sm" className="text-base leading-none max-[640px]:size-10" aria-label="Next display" disabled={active === MINI_MEET_DISPLAYS.length - 1} onClick={() => go(active + 1)}>›</Button>
        </div>
      </div>
      {/* Every slide stays mounted: the track is one scroll-snap strip. The
          scrollbar is hidden: the tabs and the arrows are the visible control. */}
      <div className="flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" ref={track}>
        {MINI_MEET_DISPLAYS.map((display, index) => (
          <TabsContent
            key={display.id}
            value={display.id}
            forceMount
            tabIndex={active === index ? 0 : -1}
            className="min-w-0 flex-[0_0_100%] snap-start snap-always focus-visible:ring-[3px] focus-visible:ring-ring"
            aria-hidden={active !== index}
          >
            <MiniMeetDisplay display={display} />
          </TabsContent>
        ))}
      </div>
    </Tabs>
  );
}

function MiniMeetDisplay({ display }: { display: MiniMeetScene }) {
  return (
    <article className="flex min-w-0 flex-col">
      <div className={WALLPAPER_STAGE}>
        <SimWindow label={display.label} ariaLabel={`Simulated ${display.label} display`} className="min-h-[455px] max-[901px]:min-h-[430px] max-[641px]:min-h-[420px]">
          {/* One column on a phone: the display's own content, without the sidebar. */}
          <div className="grid min-h-0 flex-1 grid-cols-[188px_minmax(0,1fr)] max-[641px]:grid-cols-1">
            <MiniMeetRail scene={display.id} />
            <main className="min-w-0 overflow-hidden bg-(--surface-sunken) px-[22px] pt-5 pb-6 max-[641px]:px-3 max-[641px]:pt-4 max-[641px]:pb-[18px]">
              <div className="mb-[18px] flex justify-end">
                <span className="inline-flex size-7 flex-none items-center justify-center rounded-[7px] border border-(--line) bg-(--surface-raised) text-[19px] leading-none text-(--ink)" aria-hidden="true">+</span>
              </div>
              <SceneContent scene={display.id} />
            </main>
          </div>
        </SimWindow>
      </div>
    </article>
  );
}

function MiniMeetRail({ scene }: { scene: MiniMeetSceneID }) {
  const rail = miniRails(useSampleMeeting().workspace.name)[scene];
  return (
    <aside className="min-w-0 overflow-hidden border-r border-(--line) bg-(--surface) px-2.5 py-4 font-['Inter',sans-serif] max-[641px]:hidden" aria-label={`${rail.label} sidebar`}>
      <div className="mx-2 mt-0 mb-[17px] text-(--ink) text-[19px] tracking-[-0.02em]">{rail.label}</div>
      {rail.sections.map((section, sectionIndex) => (
        <section key={`${section.title}-${sectionIndex}`} className="mb-[15px]">
          {section.title && <h4 className={`mx-2 mt-0 mb-[5px] ${KICKER}`}>{section.title}</h4>}
          <ul className="m-0 grid list-none gap-0.5 p-0">
            {section.rows.map((row, rowIndex) => (
              <li key={row.label} className={`flex min-w-0 items-center gap-[7px] rounded-[7px] px-2 py-[7px] ${rowIndex === 0 && sectionIndex === 0 ? 'bg-(--selected)' : ''}`}>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <b className="truncate text-[11px] font-[560]">{row.label}</b>
                  {row.detail && <small className="truncate text-[9px] text-(--muted)">{row.detail}</small>}
                </span>
                {row.count && <span className="flex-none text-[10px] text-(--muted) tabular-nums">{row.count}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}

function SceneContent({ scene }: { scene: MiniMeetSceneID }) {
  switch (scene) {
    case 'calendar': return <MiniCalendar />;
    case 'team': return <MiniTeam />;
    case 'docs': return <MiniDocs />;
    default: return <MiniCalendar />;
  }
}

function MiniCalendar() {
  const days = ['MON', 'TUE', 'WED', 'THU', 'FRI'];
  const events: Record<number, { kind: MiniEventKind; title: string; time: string }> = {
    1: { kind: 'shared', title: 'Team stand-up', time: '10:30' },
    2: { kind: 'mine', title: 'Client workshop', time: '14:30 · Room' },
    4: { kind: 'private', title: 'Personal', time: '16:00' },
  };
  return (
    <div className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <b className="text-[12px] font-semibold text-(--ink)">This week</b>
        <span className="text-[11px] text-(--muted)">Week</span>
      </div>
      <div className="grid min-h-[330px] grid-cols-[42px_repeat(5,minmax(0,1fr))] rounded-[9px] border border-(--line) bg-(--surface) pt-[30px] max-[641px]:min-h-[280px] max-[641px]:grid-cols-[33px_repeat(5,minmax(50px,1fr))] max-[641px]:overflow-x-auto">
        <div className="flex flex-col justify-between pr-[5px] pb-3.5 text-right text-[9px] text-(--muted)"><span>09:00</span><span>11:00</span><span>13:00</span><span>15:00</span></div>
        {days.map((day, index) => {
          const event = events[index];
          return (
            <div key={day} className="relative min-h-[300px] min-w-0 border-l border-(--line) px-[7px] max-[641px]:min-h-[250px] max-[641px]:px-1">
              <b className={`absolute -top-[22px] left-2 text-[9px] tracking-[0.05em] max-[641px]:left-[5px] max-[641px]:text-[8px] ${index === 2 ? 'text-(--accent-mark)' : 'text-(--muted)'}`}>{day}</b>
              <span className="absolute inset-x-0 top-1/4 border-t border-dashed border-(--line)" />
              {event && (
                <span className={`absolute inset-x-1.5 overflow-hidden rounded-[5px] border-l-2 p-[7px] text-[10px] leading-[1.3] font-semibold max-[641px]:inset-x-[3px] max-[641px]:p-[5px] max-[641px]:text-[8px] ${EVENT_KIND[event.kind]}`}>
                  {event.title}<br /><small className="text-[9px] font-medium text-(--muted) max-[641px]:text-[8px]">{event.time}</small>
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const MINI_PEOPLE: ReadonlyArray<{ name: string; status: string; kind: MiniPresence; initial: string }> = [
  { name: 'A colleague', status: 'In a meeting', kind: 'meeting', initial: 'C' },
  { name: 'Another person', status: 'Available', kind: 'available', initial: 'P' },
  { name: 'You', status: 'Available', kind: 'available', initial: 'Y' },
  { name: 'Wren', status: 'Working on a task', kind: 'agent', initial: 'W' },
];

function MiniTeam() {
  return (
    <div className="grid min-w-0 grid-cols-2 gap-2.5 max-[641px]:grid-cols-1">
      <div className={`${PANEL} border-(--line) min-h-[300px] ${PANEL_PHONE}`}>
        <div className={`${SECTION_HEAD} mb-3`}>
          <b className={CARD_LABEL}>People around</b>
          <span className="text-[10px] text-(--muted)">4</span>
        </div>
        {MINI_PEOPLE.map(({ name, status, kind, initial }) => (
          <div key={name} className="flex items-center gap-[9px] border-t border-(--line) py-[9px]">
            {kind === 'agent'
              ? <SampleAgentFace className="size-[27px]" />
              : <span className={`inline-flex size-[27px] flex-none items-center justify-center bg-(--surface-sunken) text-[10px] font-[650] text-(--ink) ${AVATAR_KIND[kind]}`}>{initial}</span>}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <b className="text-[11px] font-semibold">{name}</b>
              <small className="truncate text-[10px] text-(--muted)">{status}</small>
            </span>
          </div>
        ))}
      </div>
      <div className={`${PANEL} border-(--line) flex min-h-[300px] flex-col gap-[11px] max-[641px]:min-h-0 ${PANEL_PHONE}`}>
        <span className={KICKER}>Conversation</span>
        <h4 className={DETAIL_TITLE}>A colleague</h4>
        <p className={DETAIL_COPY}>Can we look at the workshop notes before tomorrow?</p>
        <p className={`${DETAIL_COPY} px-2.5 py-2 ${MINE_BUBBLE}`}>Yes, I filed them on the project.</p>
        <div className="mt-auto flex gap-1.5">
          {['Message', 'Wave', 'Call'].map((action) => (
            <span key={action} className="rounded-full border border-(--line) bg-(--surface-sunken) px-2 py-1.5 text-[10px] text-(--muted)">{action}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function MiniDocs() {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(190px,0.8fr)_minmax(0,1.2fr)] gap-2.5 max-[901px]:grid-cols-[minmax(0,1fr)_minmax(150px,0.65fr)] max-[641px]:grid-cols-1">
      <div className={`${PANEL} border-(--line) min-h-[300px] ${PANEL_PHONE}`}>
        <div className={`${SECTION_HEAD} mb-3`}>
          <b className={CARD_LABEL}>Recent</b>
          <span className="text-[10px] font-medium text-(--muted)">6 documents</span>
        </div>
        {[
          ['Workshop brief', `${SAMPLE_MEETING.project} · edited today`],
          ['Meeting notes', 'Client discovery · yesterday'],
          ['Research outline', 'Library · 18 Sep'],
        ].map(([title, detail], index) => (
          <div key={title} className="grid grid-cols-[13px_minmax(0,1fr)] items-center gap-x-2 gap-y-[3px] border-t border-(--line) py-2.5">
            <span className={`row-span-2 h-3.5 w-[11px] rounded-[2px] border ${index === 0 ? 'border-(--accent) bg-(--accent)' : 'border-(--muted)'}`} aria-hidden="true" />
            <b className="truncate text-[11px] font-semibold">{title}</b>
            <small className="truncate text-[9px] text-(--muted)">{detail}</small>
          </div>
        ))}
      </div>
      <article className={`${PANEL} border-(--line) flex min-h-[300px] flex-col gap-[13px] max-[641px]:min-h-0 ${PANEL_PHONE}`}>
        <span className={KICKER}>Document · {SAMPLE_MEETING.project}</span>
        <h4 className={DETAIL_TITLE}>Workshop brief</h4>
        <p className={DETAIL_COPY}>What should the next session help the team decide?</p>
        <hr className="mx-0 my-[3px] h-0 w-full border-x-0 border-t border-b-0 border-(--line)" />
        <small className="max-w-md text-[11px] leading-[1.45] text-(--muted)">Notes, transcript, and tasks stay beside the work they came from.</small>
      </article>
    </div>
  );
}
