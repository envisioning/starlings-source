import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/ui/button';
import { errorCodeOf } from './config';
import { loadSnapshot, saveSnapshot } from './snapshot-store';
import { HOME_SNAPSHOT } from './home-snapshots';
import {
  calendarConnectHref,
  calendarEventHref,
  closedDaySummaryLabel,
  countdown,
  eventDemotionKey,
  eventLaunchURL,
  fetchUpcoming,
  fetchCalendarPreferences,
  heroHoldsAccent,
  heroLabel,
  isStarlingsMeet,
  isVideoMeeting,
  joinTitle,
  participantAttendees,
  platformActionTitle,
  platformLabel,
  scheduleLine,
  setEventDemoted,
  upcomingPlan,
  upcomingPreferencesFromWire,
  type UpcomingPlan,
  type WebCalendarEvent,
  type WebCalendarPreferences,
} from './owner-agenda';
import { CalendarIcon, MeetingPlatformIcon } from './action-icons';
import { JoinMeetingButton } from './JoinMeetingButton';
import { AttendeeStack } from './AttendeeAvatar';
import type { UpcomingPreferences } from '@starlings/contracts/upcoming';
import { CALENDAR_REFRESH_SECONDS } from '@starlings/contracts/limits';
import { t } from './i18n';
import { PlaceholderRows } from '@/ui/placeholder-rows';
import { GlyphMark } from './SubjectMark';
import { HomeCard, HomeClockFace, HomeFoldToggle, HomeList, HomeRow, HomeRowMark, HomeRowText, HomeRowWhen, homeLabelClass, homeRowClass, homeRowMenuButtonClass, homeRowMenuOptions } from './HomeModule';
import { useRowMenu } from './use-row-menu';
import { MenuGroups, OpenItem } from './row-menu-items';
import { DropdownMenuItem } from '@/ui/dropdown-menu';
import { MenuIcon } from './menu-icons';
import { toast } from './Toast';
import { calendarConnectable } from './workspace-brand';
import { cn } from '@/lib/utils';

/** Refresh the agenda while in front; the countdown itself ticks locally. */
const REFRESH_MS = CALENDAR_REFRESH_SECONDS * 1_000;

/**
 * Home is today.
 *
 * The clock and the next real meetings, in the same order and the same words
 * the iOS Home tab uses. The agenda itself is read-only: creating, moving, and
 * choosing calendars stays on the Mac and iOS, and this page says so rather
 * than offering buttons the web cannot honour. Connecting is the exception —
 * the control plane has a browser OAuth flow, and an account with no calendar
 * at all should be able to fix that from the page that is missing one.
 */
export function OwnerAgendaCard({ onHeroAccent }: { onHeroAccent?: (holds: boolean) => void } = {}) {
  // Last known first (docs/CACHING.md): the day this browser last read, and
  // the policy it was drawn under, until the live read replaces both.
  const [events, setEvents] = useState<WebCalendarEvent[] | null>(() => loadSnapshot<WebCalendarEvent[]>(HOME_SNAPSHOT.upcoming)?.value ?? null);
  const [connected, setConnected] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [preferences, setPreferences] = useState<UpcomingPreferences>(() => upcomingPreferencesFromWire(loadSnapshot<WebCalendarPreferences>(HOME_SNAPSHOT.preferences)?.value.upcoming));
  const [showRemainingToday, setShowRemainingToday] = useState(false);
  // Whether an agenda has ever arrived, read inside the poll's own closure —
  // "we have nothing to show" and "this refresh failed" are different failures.
  const everLoaded = useRef(events !== null);

  useEffect(() => {
    let cancelled = false;
    let disconnected = false;
    let timer: number | undefined;

    const load = async () => {
      if (document.visibilityState !== 'visible') return;
      // No calendar is a settled answer, not a transient failure. Polling it
      // would file one control-plane error per minute for a normal state.
      if (disconnected) return;
      try {
        const [next, preferenceResponse] = await Promise.all([
          fetchUpcoming(),
          fetchCalendarPreferences().catch(() => undefined),
        ]);
        if (cancelled) return;
        everLoaded.current = true;
        saveSnapshot(HOME_SNAPSHOT.upcoming, next);
        setEvents(next);
        if (preferenceResponse) {
          saveSnapshot(HOME_SNAPSHOT.preferences, preferenceResponse);
          setPreferences(upcomingPreferencesFromWire(preferenceResponse.upcoming));
        }
        setConnected(true);
        setUnavailable(false);
      } catch (cause) {
        if (cancelled) return;
        if (errorCodeOf(cause) === 'calendar_not_connected') {
          disconnected = true;
          setConnected(false);
          saveSnapshot(HOME_SNAPSHOT.upcoming, []);
          setEvents([]);
          return;
        }
        // A stale agenda beats a blank card, so the last good answer stays on
        // screen and only a failure with nothing behind it admits it.
        if (!everLoaded.current) {
          setEvents([]);
          setUnavailable(true);
        }
      } finally {
        if (!cancelled) setNow(Date.now());
      }
    };

    const start = () => {
      window.clearInterval(timer);
      void load();
      timer = window.setInterval(() => void load(), REFRESH_MS);
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else window.clearInterval(timer);
    };

    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // Mounting once is the point: the poll owns its own lifecycle.
  }, []);

  // The countdown is the only thing on this page that has to be true to the
  // minute, so it ticks on its own rather than re-fetching the feed.
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, []);

  // Hide from Next, the Mac's and the phone's row action. The row leaves the
  // plan at once; a failed write puts it back and says so.
  const demote = (event: WebCalendarEvent, demoted: boolean) => {
    const key = eventDemotionKey(event);
    const mark = (value: boolean) => setEvents((current) => current?.map((row) => (
      eventDemotionKey(row) === key ? { ...row, demoted: value } : row
    )) ?? current);
    mark(demoted);
    void setEventDemoted(event, demoted).catch((cause: unknown) => {
      mark(!demoted);
      toast(cause instanceof Error ? cause.message : t('Couldn’t change Next.'), 'danger');
    });
  };

  const plan = useMemo<UpcomingPlan<WebCalendarEvent>>(
    () => upcomingPlan(events ?? [], now, preferences),
    [events, now, preferences],
  );
  const next = plan.focus;
  const following = plan.homeRows;

  // One accent per screen: while the hero's Join is on screen the room card's
  // primary steps down, and steps back up the moment the window closes.
  const holdsAccent = heroHoldsAccent(next, now);
  useEffect(() => {
    onHeroAccent?.(holdsAccent);
  }, [holdsAccent, onHeroAccent]);

  return (
    <HomeCard aria-label={t('Upcoming')}>
      <p className={homeLabelClass}>{t(heroLabel(plan))}</p>
      {events === null && <PlaceholderRows label={t('Loading your day…')} />}
      {!connected && calendarConnectable() && (
        <>
          <Button asChild variant="secondary"><a href={calendarConnectHref('/')}>
            <CalendarIcon /> Connect Google Calendar
          </a></Button>
        </>
      )}
      {connected && events !== null && !next && (
        <TodayEmpty>
          {unavailable
            ? t('Couldn’t reach your calendar.')
            : closedDaySummaryLabel(plan)}
        </TodayEmpty>
      )}
      {connected && next && <NextMeeting event={next} plan={plan} now={now} />}
      {following.length > 0 && (
        <HomeList>
          {following.map((event) => (
            <li key={event.id}>
              <FollowingRow event={event} plan={plan} now={now} onDemote={demote} />
            </li>
          ))}
        </HomeList>
      )}
      {connected && plan.remainingToday.length > 0 && (
        <div className="flex flex-col gap-2">
          <HomeFoldToggle
            className="font-semibold text-foreground"
            aria-expanded={showRemainingToday}
            onClick={() => setShowRemainingToday((shown) => !shown)}
          >
            {showRemainingToday ? t('Hide rest of day') : t('See rest of day')}
          </HomeFoldToggle>
          {showRemainingToday && (
            <HomeList>
              {plan.remainingToday.map((event) => (
                <li key={event.id}>
                  <FollowingRow event={event} plan={plan} now={now} onDemote={demote} />
                </li>
              ))}
            </HomeList>
          )}
        </div>
      )}
    </HomeCard>
  );
}

/** The agenda's one-line state: loading, nothing left today, no calendar. */
function TodayEmpty({ children }: { children: ReactNode }) {
  return <p className="m-0 text-[15px] leading-[1.45] text-muted-foreground">{children}</p>;
}

/**
 * One row under the hero. The row opens the event in Calendar — every row,
 * an in-person meeting included. Joining is the hero's button; the Mac and
 * the phone keep it on the row's context menu, and so does the row's `…`
 * here: Join (a video meeting only), then Hide from Next and Open in Calendar.
 */
function FollowingRow(
  {
    event,
    plan,
    now,
    showCountdown = true,
    showContext = false,
    participants = [],
    action,
    onDemote,
  }: {
    event: WebCalendarEvent;
    plan: UpcomingPlan<WebCalendarEvent>;
    now: number;
    onDemote?: (event: WebCalendarEvent, demoted: boolean) => void;
    showCountdown?: boolean;
    showContext?: boolean;
    participants?: ReturnType<typeof participantAttendees>;
    /** The card's own Join, its bottom row inside the card. */
    action?: ReactNode;
  },
) {
  const context = showContext ? event.subject?.title.trim() : '';
  const menu = useRowMenu(homeRowMenuOptions);
  const row = menu.rowProps(event.id);
  const panel = menu.panel(event.id, (
    <MenuGroups groups={[
      isVideoMeeting(event) ? [<OpenItem key="join" href={eventLaunchURL(event)} label={platformActionTitle(event)} external={!isStarlingsMeet(event)} icon="join" />] : [],
      [
        ...(onDemote ? [(
          <DropdownMenuItem key="demote" onSelect={() => onDemote(event, !event.demoted)}>
            <MenuIcon name={event.demoted ? 'show' : 'hide'} />
            {event.demoted ? t('Show in Next') : t('Hide from Next')}
          </DropdownMenuItem>
        )] : []),
        <OpenItem key="open" href={calendarEventHref(event)} label={t('Open in Calendar')} icon="openCalendar" />,
      ],
    ]} />
  ), { className: homeRowMenuButtonClass });
  const rowContent = (
    <>
      {/* The platform in the square well every Home list leads with — the
          Mac's `UpcomingCompactRow`, the phone's `MobileHomeUpcomingRow`. */}
      <HomeRowMark ink={isStarlingsMeet(event) ? 'accent' : 'muted'} aria-label={platformLabelFor(event)}>
        <GlyphMark size={24} shape="square"><MeetingPlatformIcon platform={event.platform} /></GlyphMark>
      </HomeRowMark>
      <HomeRowText title={event.title} detail={[scheduleLine(event, now), context].filter(Boolean).join(' · ')} />
      {showCountdown && isToday(plan, event) && !event.allDay && (
        <HomeRowWhen>{countdown(event, now)}</HomeRowWhen>
      )}
    </>
  );

  if (participants.length > 0 || action) {
    return (
      <HomeRow {...row} className={cn(row.className, 'relative flex-col flex-nowrap items-stretch gap-1.5')}>
        <a
          href={calendarEventHref(event)}
          className={cn(homeRowClass, 'flex w-full flex-none flex-nowrap rounded-sm p-0 pr-8 hover-lift')}
          data-home-row
        >
          {rowContent}
        </a>
        {/* Faces overlapping in a row, not a list of names: the card stays
            one line tall and the Calendar page has the full list (meet#623). */}
        {participants.length > 0 && <AttendeeStack attendees={participants} className="pl-[34px]" />}
        {action}
        {panel}
      </HomeRow>
    );
  }

  return (
    <div {...row} className={cn(row.className, 'relative')}>
      <HomeRow asChild className="flex-nowrap pr-11">
        <a href={calendarEventHref(event)} data-home-row>
          {rowContent}
        </a>
      </HomeRow>
      {panel}
    </div>
  );
}

/**
 * A countdown belongs to today. "in 2d 14h" beside a Monday standup is
 * arithmetic, not information — the date beside it already says more, and the
 * Mac has always left it off these rows.
 */
function isToday(plan: UpcomingPlan<WebCalendarEvent>, event: WebCalendarEvent): boolean {
  const tier = plan.tiers[event.id];
  return tier === 'now' || tier === 'today';
}

/** The clock is Home's header on every surface; it is not a module, and it never moves. */
export function OwnerClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return <HomeClockFace now={now} />;
}

/**
 * Accent only for our own rooms — the same rule the Mac launch screen and the
 * iOS card apply. Somebody else's Zoom link is a way out of the app, not the
 * call to action.
 */
function NextMeeting({
  event,
  plan,
  now,
}: {
  event: WebCalendarEvent;
  plan: UpcomingPlan<WebCalendarEvent>;
  now: number;
}) {
  const href = isVideoMeeting(event) ? eventLaunchURL(event) : '';
  // The button exists only inside the join window; three hours out the card
  // is a countdown. Inside it the countdown rides the button.
  const showsButton = heroHoldsAccent(event, now);
  const showsAction = showsButton && Boolean(href);
  const label = joinTitle(event, now);
  const participants = participantAttendees(event).slice(0, 20);
  return (
    <FollowingRow
      event={event}
      plan={plan}
      now={now}
      showCountdown={!showsAction}
      showContext
      participants={participants}
      action={showsAction ? (
        <JoinMeetingButton event={event} href={href} className="mt-0.5 self-end">
          {label}
        </JoinMeetingButton>
      ) : undefined}
    />
  );
}

function platformLabelFor(event: WebCalendarEvent): string {
  return platformLabel(event) || t('Calendar event');
}
