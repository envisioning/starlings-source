import { SignInGate } from './SignInGate';
import { CalendarEventEditor } from './CalendarEventEditor';
import { CalendarQuickAdd } from './CalendarQuickAdd';
import type { CalendarQuickAddResponse } from '@starlings/contracts';
import { googleCalendarKey } from '@starlings/contracts/calendar-keys';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';
import { Label } from '@/ui/label';
import { Checkbox } from '@/ui/checkbox';
import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Card } from '@/ui/card';
import { Item } from '@/ui/item';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/dialog';
import { Tip } from './Tip';
import { editorDialogClass, editorHeaderClass } from './editor-dialog';
import { cn } from '@/lib/utils';
import { AttendeeAvatar } from './AttendeeAvatar';
import { useOwnerSession, wasMember } from './owner-session';
import { roomPermalink } from './config';
import { toast } from './Toast';
import { writeAddress } from './navigation';
import { eventHref } from './work-hrefs';
import { parsePermalinkPath } from '@starlings/contracts/permalinks';
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/ui/dropdown-menu';
import { CopyLinkItem, MenuGroups, OpenItem } from './row-menu-items';
import { ClockIcon, MapPinIcon } from 'lucide-react';
import { calendarTileDetail } from './calendar-tile';
import { MenuIcon } from './menu-icons';
import { readStored, StorageKeys, writeStored } from './storage';
import { useRowMenu, type RowMenuController } from './use-row-menu';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { calendarFailureDetail, classifyCalendarFailure, logCalendarFailure, withTransientRetry } from './calendar-failure';
import { errorCodeOf } from './config';
import { AppShell } from './SiteChrome';
import { SurfaceCreate } from './SurfaceCreate';
import { SCROLLBAR_AFFORDANCE_CLASS } from './SurfaceShell';
import { AttendanceIcon, CalendarIcon, ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, MeetingPlatformIcon, TaskIcon, TodayIcon, WorkspaceMark } from './action-icons';
import { GlyphMark } from './SubjectMark';
import { JoinMeetingButton } from './JoinMeetingButton';
import { EventAbout, hasEventAbout } from './EventAbout';
import { CmsRecordEditor, useWritableCmsEntity } from './CmsRecordEditor';
import { fetchSubjectDetail, type CrmSubjectDetail } from './crm-work';
import { formatTime } from './meeting-time';
import {
  addDays,
  addMonths,
  calendarAccounts,
  CALENDAR_RSVP_CHOICES,
  CALENDAR_SPECIAL_LAYERS,
  calendarLocationLabel,
  calendarConnectHref,
  calendarSourceLabel,
  combineIdenticalEvents,
  splitMirroredLayerItems,
  dayHeading,
  eventLaunchURL,
  fetchCalendarLayers,
  fetchCalendarPreferences,
  fetchCalendarSources,
  fetchEventsInRange,
  fetchSubscriptionEventsInRange,
  groupByDay,
  isStarlingsMeet,
  isCalendarHidden,
  isInProgress,
  isVideoMeeting,
  monthGrid,
  parseCalendarDay,
  participantAttendees,
  attendeeIsMember,
  ATTENDANCE_LABEL,
  attendanceOf,
  platformActionTitle,
  platformLabel,
  respondToCalendarInvitation,
  setEventDemoted,
  eventMoveChoices,
  moveCalendarEvent,
  startOfDay,
  startOfMonth,
  timeRange,
  SUBSCRIBED_ACCOUNT_KEY,
  travelTimeLabel,
  visibleEvents,
  withAccountHidden,
  withCalendarHidden,
  writeHiddenCalendarKeys,
  type AgendaDay,
  type CalendarRSVP,
  type WebCalendarEvent,
  type WebCalendarLayerItem,
  type WebCalendarLayerKind,
  type WebCalendarAccount,
  type WebCalendarPreferences,
  type WebCalendarSource,
} from './owner-agenda';
import { useOwnerHeartbeat } from './use-owner-heartbeat';
import { ErrorNotice } from './ErrorNotice';
import { SEARCH_EVENTS_AHEAD_DAYS, SEARCH_EVENTS_BACK_DAYS } from '@starlings/contracts/limits';
import { useDocumentTitle } from './document-title';
import { t, dateLocale } from './i18n';
import { workspaceBrand } from './workspace-brand';
import { calendarConnectable } from './workspace-brand';
import { PlaceholderRows } from '@/ui/placeholder-rows';

/** A page of the calendar is a week, and paging moves by the same seven days. */
/** Mac `CalendarWorkspace.monthTTL`: two minutes between reads of an open week. */
const CALENDAR_REFRESH_SECONDS = 120;
const WINDOW_DAYS = 7;

/**
 * Calendar on the web — *when*, the third question the workspace answers.
 *
 * The week and its event editor share the native calendar API. Source choices
 * stay owner-wide; editing never moves a shared event to a different calendar.
 */
export function CalendarPage() {
  useDocumentTitle(t('Calendar'));
  const [editing, setEditing] = useState<WebCalendarEvent | 'new' | null>(null);
  const [quickAdding, setQuickAdding] = useState(false);
  const [prefill, setPrefill] = useState<CalendarQuickAddResponse | undefined>(undefined);
  // Home's "See rest of day" is a deliberately narrower door than the
  // ordinary Calendar destination. Keep that scope for this page instance;
  // the normal nav link still opens the full week.
  const [todayOnly] = useState(() => new URLSearchParams(window.location.search).get('scope') === 'today');
  // A Home row lands on an event's permalink with ?day=YYYY-MM-DD: the week is the
  // one that day falls in, and the event opens once that week is in.
  const [from, setFrom] = useState(() => startOfDay(
    parseCalendarDay(new URLSearchParams(window.location.search).get('day')) ?? new Date(),
  ));
  const [events, setEvents] = useState<WebCalendarEvent[] | null>(null);
  const lookedBeyondWeek = useRef<string | null>(null);
  // An event the address asked for (`/calendar/event/<id>`),
  // until it is open or known to be unreachable. The address stays until then, so a reload asks again
  // instead of forgetting.
  const [requestedEvent, setRequestedEvent] = useState<{ id: string; status: 'looking' | 'missing' | 'failed' } | null>(() => {
    const record = parsePermalinkPath(window.location.pathname);
    const id = record?.surface === 'calendar' ? record.id : null;
    return id ? { id, status: 'looking' } : null;
  });
  // Rows Google took a delete for. Google's list can still carry the event
  // on the reload that follows, so the row stays hidden until a fetch comes
  // back without it.
  const [deleted, setDeleted] = useState<Set<string>>(() => new Set());
  const [sources, setSources] = useState<WebCalendarSource[]>([]);
  const [preferences, setPreferences] = useState<WebCalendarPreferences | undefined>(undefined);
  const [specialItems, setSpecialItems] = useState<WebCalendarLayerItem[]>([]);
  const [degradedSpecialLayers, setDegradedSpecialLayers] = useState<Set<WebCalendarLayerKind>>(() => new Set());
  const [visibleSpecialLayers, setVisibleSpecialLayers] = useState<Set<WebCalendarLayerKind>>(
    () => new Set(CALENDAR_SPECIAL_LAYERS.map((layer) => layer.kind)),
  );
  // A hidden event is gone from the grid unless asked back, then drawn faded.
  const [showHidden, setShowHidden] = useState(() => readStored(StorageKeys.calendarShowHidden) === '1');
  const toggleShowHidden = (next: boolean) => { setShowHidden(next); writeStored(StorageKeys.calendarShowHidden, next ? '1' : ''); };
  const [state, setState] = useState<'loading' | 'ok' | 'signin' | 'disconnected'>('loading');
  // Paging keeps the week that is on screen until the next one arrives, so the
  // list must be able to say it is out of date without going blank.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // What Copy carries beside the sentence: classified cause, code, request id.
  const [errorDetail, setErrorDetail] = useState('');
  const pageDays = todayOnly ? 1 : WINDOW_DAYS;
  // Week pages a week; Month pages a month and reads the whole grid, whole weeks, so the
  // days either side of the month are real days, not blanks.
  const [mode, setMode] = useState<'week' | 'month'>('week');
  const [month, setMonth] = useState(() => startOfMonth(from));
  const grid = useMemo(() => monthGrid(month), [month]);
  const rangeFrom = mode === 'month' ? grid.from : from;
  const rangeDays = mode === 'month' ? grid.days : pageDays;
  const to = useMemo(() => addDays(rangeFrom, rangeDays), [rangeFrom, rangeDays]);
  // Only a range change makes the list out of date. A background refresh of
  // the same range (focus, return, the two-minute timer) keeps the rows at
  // full strength: a slow or stalled refresh must not leave the week faded.
  const span = `${rangeFrom.toISOString()}|${to.toISOString()}`;
  const [loadedSpan, setLoadedSpan] = useState('');
  const stale = busy && loadedSpan !== span;

  // Each load takes a ticket; only the newest may write. A week that was
  // paged away from, or a refresh that started before `?event=` moved the
  // week, can answer late and must not overwrite the week on screen.
  const loadTicket = useRef(0);
  const load = useCallback(async () => {
    const ticket = ++loadTicket.current;
    const isLatest = () => ticket === loadTicket.current;
    setBusy(true);
    try {
      // The page span is either the requested day or the ordinary week; the
      // sources and preferences only decide what of it is shown.
      // Subscribed feeds are best-effort beside Google: a dead feed
      // must not blank the week. Without Google, an owner with subscriptions
      // still gets their week; with neither, the page asks to connect.
      const [google, subscribed, sourceList, prefs, layers] = await Promise.all([
        // A device waking from sleep reaches the page before its network does:
        // retry a transient failure quietly (1s, 3s) before any banner shows.
        withTransientRetry(() => fetchEventsInRange(rangeFrom, to), {
          isStale: () => !isLatest(),
          onRetry: (attempt, cause) => logCalendarFailure('calendar', cause, attempt, 'retrying'),
        }).catch((cause: unknown) => {
          if (errorCodeOf(cause) === 'calendar_not_connected') return null;
          throw cause;
        }),
        fetchSubscriptionEventsInRange(rangeFrom, to).catch(() => [] as WebCalendarEvent[]),
        fetchCalendarSources().catch(() => [] as WebCalendarSource[]),
        fetchCalendarPreferences().catch(() => undefined),
        fetchCalendarLayers(rangeFrom, to),
      ]);
      if (!isLatest()) return;
      if (google === null && subscribed.length === 0) {
        setState('disconnected');
        return;
      }
      const week = [...(google ?? []), ...subscribed];
      setEvents(week);
      setDeleted((current) => {
        if (current.size === 0) return current;
        const listed = new Set(week.map(eventKey));
        const next = new Set([...current].filter((key) => listed.has(key)));
        return next.size === current.size ? current : next;
      });
      setSources(sourceList);
      setPreferences(prefs);
      setSpecialItems(layers.items);
      setDegradedSpecialLayers(layers.degraded);
      setLoadedSpan(`${rangeFrom.toISOString()}|${to.toISOString()}`);
      setState('ok');
      setError('');
      setErrorDetail('');
    } catch (cause) {
      if (!isLatest()) return;
      const kind = classifyCalendarFailure(cause);
      if (kind === 'cancelled') return;
      // Only a refused Meet session asks to sign in again. A Google refusal
      // (calendar_expired, calendar_failed) used to land here on its status.
      if (kind === 'sign_in') {
        setState('signin');
        return;
      }
      if (kind === 'not_connected') {
        setState('disconnected');
        return;
      }
      const message = kind === 'transient'
        ? t('Google events didn’t refresh')
        : cause instanceof Error ? cause.message : t('Couldn’t load your calendar.');
      logCalendarFailure('calendar', cause, 1, 'shown');
      setState('ok');
      setEvents((current) => current ?? []);
      setError(message);
      setErrorDetail(calendarFailureDetail(cause, message));
    } finally {
      if (isLatest()) setBusy(false);
    }
  }, [rangeFrom, to]);

  useEffect(() => { void load(); }, [load]);

  // The Mac reloads every two minutes and on wake; iOS on every EventKit
  // change. A browser tab left open saw nothing until the range moved (#224).
  // Same cadence and the same retune as Admin: refresh on return, then every
  // two minutes while the tab is visible. Not while an editor is open — a
  // reload under a half-typed event is a lost edit.
  const editingRef = useRef(editing);
  editingRef.current = editing;
  useEffect(() => {
    let timer = 0;
    let first = true;
    const refresh = () => { if (!editingRef.current) void load(); };
    const start = () => {
      window.clearInterval(timer);
      if (document.visibilityState !== 'visible') return;
      // The mount effect above already loaded once; a retune is a return.
      if (!first) refresh();
      first = false;
      timer = window.setInterval(refresh, CALENDAR_REFRESH_SECONDS * 1_000);
    };
    start();
    const retune = () => start();
    document.addEventListener('visibilitychange', retune);
    window.addEventListener('focus', retune);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', retune);
      window.removeEventListener('focus', retune);
    };
  }, [load]);

  // Home's Schedule meeting lands here with ?new=meeting: open the editor on
  // a new event once the week is in, then drop the flag so a reload does not
  // open it again.
  const session = useOwnerSession();
  const room = session.kind === 'owner' && session.room
    ? { slug: session.room.slug, joinURL: roomPermalink(session.room.slug) }
    : undefined;
  useEffect(() => {
    if (state !== 'ok') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('new') !== 'meeting') return;
    setEditing('new');
    params.delete('new');
    const query = params.toString();
    window.history.replaceState(null, '', query ? `${window.location.pathname}?${query}` : window.location.pathname);
  }, [state]);

  // Home's rows and ⌘K land on an event's permalink: open that event once
  // the week is in, then drop `day`. The id is matched whole first,
  // then by its Google tail, since the feed prefixes the calendar ref. A hit
  // outside the loaded week — Search reaches last week through 38 days
  // ahead, the page one week — is looked for in that same window, and the
  // week moves to it. Not found there, or the lookup failed: the
  // notice says so, and the address stays until it is dismissed.
  useEffect(() => {
    if (state !== 'ok' || !events || !requestedEvent || requestedEvent.status !== 'looking') return;
    const { id } = requestedEvent;
    const tail = id.slice(id.lastIndexOf(':') + 1);
    const find = (list: WebCalendarEvent[]) => list.find((event) => event.id === id) ?? list.find((event) => event.id.endsWith(tail));
    const open = (match: WebCalendarEvent) => {
      setRequestedEvent(null);
      openEvent(match, { push: false });
    };
    const inWeek = find(events);
    if (inWeek) { open(inWeek); return; }
    // Once: the week already moved to where the window said the event was,
    // and it is still not in it. Asking again would move nowhere.
    if (lookedBeyondWeek.current === id) { setRequestedEvent({ id, status: 'missing' }); return; }
    let cancelled = false;
    const now = new Date();
    fetchEventsInRange(addDays(startOfDay(now), -SEARCH_EVENTS_BACK_DAYS), addDays(startOfDay(now), SEARCH_EVENTS_AHEAD_DAYS))
      .then((range) => {
        if (cancelled) return;
        const match = find(range);
        if (!match) { setRequestedEvent({ id, status: 'missing' }); return; }
        const day = match.allDay ? parseCalendarDay(match.start.slice(0, 10)) : new Date(Date.parse(match.start));
        if (!day || Number.isNaN(day.getTime())) { setRequestedEvent({ id, status: 'missing' }); return; }
        lookedBeyondWeek.current = id;
        // The week that holds it loads next; the effect runs again with it
        // in `events` and opens it then.
        setFrom(startOfDay(day));
      })
      .catch(() => { if (!cancelled) setRequestedEvent({ id, status: 'failed' }); });
    return () => { cancelled = true; };
  }, [state, events, requestedEvent]);

  const dismissRequestedEvent = useCallback(() => {
    writeAddress(calendarAddress(null), { push: false });
    setRequestedEvent(null);
  }, []);

  /** An event opens at its permalink; a new one is a history entry, the arrival rewrites the one it came in on. */
  function openEvent(event: WebCalendarEvent | 'new', { push = true }: { push?: boolean } = {}) {
    setEditing(event);
    if (event !== 'new') writeAddress(calendarAddress(event.id), { push });
  }

  function closeEvent() {
    setEditing(null);
    setPrefill(undefined);
    if (parsePermalinkPath(window.location.pathname)?.surface === 'calendar') writeAddress(calendarAddress(null), { push: true });
  }
  useOwnerHeartbeat(state === 'ok');

  const days: AgendaDay[] = useMemo(() => {
    if (!events) return [];
    const visible = visibleEvents(events.filter((event) => !deleted.has(eventKey(event)) && (showHidden || !event.demoted)), sources, preferences);
    const writableCalendarIds = new Set(sources.filter(source => source.writable).map(source => source.id));
    const split = splitMirroredLayerItems(
      specialItems.filter((item) => visibleSpecialLayers.has(item.kind)),
      combineIdenticalEvents(visible, writableCalendarIds),
    );
    return groupByDay(split.events, rangeFrom, rangeDays, split.layers);
  }, [events, deleted, showHidden, sources, preferences, specialItems, visibleSpecialLayers, rangeFrom, rangeDays]);
  const writableCalendarIds = new Set(sources.filter(source => source.writable).map(source => source.id));

  const toggleSpecialLayer = (kind: WebCalendarLayerKind) => {
    setVisibleSpecialLayers((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  // A choice is owner-wide: it is written to the same hidden keys the Mac and the
  // phone read. Drawn at once, saved behind it, put back if the save fails.
  const saveHiddenKeys = (keys: string[]) => {
    const before = preferences;
    setPreferences((current) => ({ ...(current ?? { hidden_calendar_keys: [], disabled_calendar_keys: [] }), hidden_calendar_keys: keys }));
    void writeHiddenCalendarKeys(keys).then((saved) => setPreferences(saved)).catch((cause: unknown) => {
      setPreferences(before);
      toast(cause instanceof Error ? cause.message : t('Couldn’t save your calendar choices.'), 'danger');
    });
  };
  const hiddenKeys = preferences?.hidden_calendar_keys ?? [];
  const toggleCalendar = (source: WebCalendarSource, account: WebCalendarAccount, hidden: boolean) => saveHiddenKeys(withCalendarHidden(hiddenKeys, source, account, hidden));
  const toggleAccount = (account: WebCalendarAccount, hidden: boolean) => saveHiddenKeys(withAccountHidden(hiddenKeys, account, hidden));
  const toggleSubscribed = (hidden: boolean) => saveHiddenKeys(hidden ? [...hiddenKeys, SUBSCRIBED_ACCOUNT_KEY] : hiddenKeys.filter((key) => key !== SUBSCRIBED_ACCOUNT_KEY));
  const hasSubscribed = events?.some((event) => event.calendarId.startsWith('sub:')) ?? false;
  const hasDemoted = events?.some((event) => event.demoted) ?? false;

  const isToday = mode === 'month'
    ? startOfMonth(new Date()).getTime() === month.getTime()
    : startOfDay(new Date()).getTime() === from.getTime();
  const page = (direction: 1 | -1) => (mode === 'month' ? setMonth(addMonths(month, direction)) : setFrom(addDays(from, direction * pageDays)));
  const goToday = () => (mode === 'month' ? setMonth(startOfMonth(new Date())) : setFrom(startOfDay(new Date())));
  const eventMenu = useRowMenu();
  const [openLayer, setOpenLayer] = useState<WebCalendarLayerItem | null>(null);

  if (state === 'signin') {
    return (
      <SignInGate title={t('Calendar')} onSignedIn={load} />
    );
  }

  if (state === 'disconnected') {
    return (
      <CalendarShell>
        {calendarConnectable() ? (
          <Button asChild><a href={calendarConnectHref('/calendar')}>
            <CalendarIcon /> {t('Connect Google Calendar')}
          </a></Button>
        ) : (
          <p className="text-sm text-muted-foreground">{t('Calendar connects to Google only.')}</p>
        )}
      </CalendarShell>
    );
  }

  const canCreate = state === 'ok' && sources.some(source => source.writable);

  const eventActions: EventActions = {
    menu: eventMenu,
    onEdit: openEvent,
    onOpenLayer: setOpenLayer,
    // The row fades at once; a failed write puts it back and says so.
    onDemote: (event, demoted) => {
      const mark = (value: boolean) => setEvents((current) => current?.map((row) => (
        eventKey(row) === eventKey(event) ? { ...row, demoted: value } : row
      )) ?? current);
      mark(demoted);
      void setEventDemoted(event, demoted).catch((cause: unknown) => {
        mark(!demoted);
        toast(cause instanceof Error ? cause.message : t('Couldn’t change Next.'), 'danger');
      });
    },
    moveChoices: (event) => eventMoveChoices(event, sources),
    onMove: (event, destinationId) => {
      void moveCalendarEvent(event, destinationId).then(
        () => { void load(); },
        (cause: unknown) => toast(cause instanceof Error ? cause.message : t('Couldn’t move this event to that calendar.'), 'danger'),
      );
    },
    onRespond: (event, response) => {
      void respondToCalendarInvitation(event, response).then(
        () => { void load(); },
        (cause: unknown) => toast(cause instanceof Error ? cause.message : t('Couldn’t send your answer.'), 'danger'),
      );
    },
  };
  return (
    <CalendarShell create={canCreate ? <SurfaceCreate label={t('New event…')} items={[
      { label: t('New event…'), icon: 'addEvent', onSelect: () => { setPrefill(undefined); setEditing('new'); } },
      // One sentence, then New event filled in for review.
      { label: t('Quick add event…'), icon: 'write', onSelect: () => setQuickAdding(true) },
    ]} /> : undefined}>
      <div className="mt-5 mb-2 flex flex-wrap items-center justify-between gap-3">
        {/* Paging is three icons; the week on screen says which days it is,
            so the range needs no label of its own. The page reloads itself
            every CALENDAR_REFRESH_SECONDS, so there is no Reload. */}
        <div className="flex gap-2" aria-busy={busy || undefined}>
          <Tip label={t('Previous')}>
            <Button type="button" variant="secondary" size="icon" aria-label={t('Previous')} onClick={() => page(-1)}>
              <ChevronLeftIcon />
            </Button>
          </Tip>
          <Tip label={t('Today')}>
            <Button type="button" variant="secondary" size="icon" aria-label={t('Today')} onClick={goToday} disabled={isToday}>
              <TodayIcon />
            </Button>
          </Tip>
          <Tip label={t('Next')}>
            <Button type="button" variant="secondary" size="icon" aria-label={t('Next')} onClick={() => page(1)}>
              <ChevronRightIcon />
            </Button>
          </Tip>
          {!todayOnly && (
            <div role="group" aria-label={t('View')} className="ml-2 flex gap-1">
              <Button type="button" variant={mode === 'week' ? 'default' : 'secondary'} aria-pressed={mode === 'week'} onClick={() => { setMode('week'); }}>{t('Week')}</Button>
              <Button type="button" variant={mode === 'month' ? 'default' : 'secondary'} aria-pressed={mode === 'month'} onClick={() => { setMonth(startOfMonth(from)); setMode('month'); }}>{t('Month')}</Button>
            </div>
          )}
          {mode === 'month' && (
            <strong className={'ml-3 self-center text-[17px] font-medium'} aria-live="polite">
              {month.toLocaleDateString(dateLocale, { month: 'long', year: 'numeric' })}
            </strong>
          )}
        </div>
        <div className="flex flex-none items-center justify-end gap-3">
          {(sources.length > 0 || hasSubscribed || hasDemoted) && (
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="secondary">{t('Calendars')} <ChevronDownIcon /></Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 p-2">
                <CalendarChoices
                  accounts={calendarAccounts(sources)}
                  preferences={preferences}
                  hasSubscribed={hasSubscribed}
                  subscribedHidden={hiddenKeys.includes(SUBSCRIBED_ACCOUNT_KEY) || (preferences?.disabled_calendar_keys ?? []).includes(SUBSCRIBED_ACCOUNT_KEY)}
                  onToggleCalendar={toggleCalendar}
                  onToggleAccount={toggleAccount}
                  onToggleSubscribed={toggleSubscribed}
                />
                <Label className="mt-1 flex cursor-pointer items-center gap-2 border-t px-1 pt-2.5 text-[13px] text-foreground font-normal leading-normal">
                  <Checkbox checked={showHidden} onCheckedChange={(checked) => toggleShowHidden(checked === true)} aria-label={t('Show hidden events')} />
                  {t('Show hidden events')}
                </Label>
              </PopoverContent>
            </Popover>
          )}
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="secondary">{t('{workspace} calendars', { workspace: workspaceBrand().name })} <ChevronDownIcon /></Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-2">
              <CalendarSpecials
                items={specialItems}
                degradedKinds={degradedSpecialLayers}
                visibleKinds={visibleSpecialLayers}
                onToggle={toggleSpecialLayer}
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {quickAdding && <CalendarQuickAdd onClose={() => setQuickAdding(false)} onRead={(answer) => { setQuickAdding(false); setPrefill(answer); setEditing('new'); }} />}
      {editing && <CalendarEventEditor event={editing === 'new' ? undefined : editing} sources={sources} room={room} prefill={editing === 'new' ? prefill : undefined} onClose={closeEvent} onSaved={(saved) => { void load(); if (saved) toast(saved); }} onDeleted={(event) => setDeleted((current) => new Set(current).add(eventKey(event)))} />}
      {error && <ErrorNotice message={error} copyText={errorDetail || undefined} />}
      {requestedEvent?.status === 'missing' && (
        <ErrorNotice
          role="status"
          message={t('That event is not in the calendar range Search covers.')}
          action={<Button type="button" variant="secondary" onClick={dismissRequestedEvent}>{t('Dismiss')}</Button>}
        />
      )}
      {requestedEvent?.status === 'failed' && (
        <ErrorNotice
          message={t('Couldn’t look for that event.')}
          action={(
            <>
              <Button type="button" variant="secondary" onClick={() => { lookedBeyondWeek.current = null; setRequestedEvent({ id: requestedEvent.id, status: 'looking' }); }}>{t('Retry')}</Button>
              <Button type="button" variant="secondary" onClick={dismissRequestedEvent}>{t('Dismiss')}</Button>
            </>
          )}
        />
      )}

      {state === 'loading' && <PlaceholderRows count={5} className="mt-3" />}

      {state === 'ok' && mode === 'month' && (
        <div className={cn('mt-3 min-w-0 min-[761px]:min-h-0 min-[761px]:flex-1 min-[761px]:overflow-y-auto', SCROLLBAR_AFFORDANCE_CLASS, stale && 'opacity-55')}>
          <CalendarMonth
            days={days}
            month={month}
            writableCalendarIds={writableCalendarIds}
            onEdit={openEvent}
            onOpenDay={(date) => { setFrom(startOfDay(date)); setMode('week'); }}
          />
        </div>
      )}

      {state === 'ok' && mode === 'week' && (
        // The agenda takes a third and the timeline two thirds, so the whole
        // week fits beside the list. Below 1100px they stack and scroll as one.
        <div className={cn(
          'grid grid-cols-[minmax(300px,1fr)_minmax(0,2fr)] items-start gap-6 max-[1099px]:grid-cols-1',
          'min-[761px]:min-h-0 min-[761px]:flex-1 min-[761px]:max-[1099px]:overflow-y-auto min-[761px]:max-[1099px]:overscroll-contain',
          'min-[1100px]:grid-rows-[minmax(0,1fr)]',
          SCROLLBAR_AFFORDANCE_CLASS,
        )}>
          {/* Paging: the week on screen is the previous answer until the next one lands. */}
          <ol className={cn('@container/agenda m-0 list-none p-0 pt-3', calendarColumnScroll, stale && 'opacity-55')}>
            {days.map((day) => (
              <DayRow key={day.date.toISOString()} day={day} sources={sources} actions={eventActions} />
            ))}
          </ol>
          <div className={cn('min-w-0', calendarColumnScroll)}>
            <CalendarTimeline days={days} writableCalendarIds={writableCalendarIds} onEdit={openEvent} onOpenLayer={setOpenLayer} todayOnly={todayOnly} />
          </div>
        </div>
      )}
      <CalendarLayerDialog item={openLayer} onClose={() => setOpenLayer(null)} onChanged={() => { setOpenLayer(null); void load(); toast(t('Saved')); }} />
    </CalendarShell>
  );
}

/** Side by side, each column scrolls on its own inside the window. */
const calendarColumnScroll = cn(
  'min-[1100px]:box-border min-[1100px]:max-h-full min-[1100px]:min-h-0 min-[1100px]:overflow-y-auto min-[1100px]:overscroll-contain min-[1100px]:pr-1',
  SCROLLBAR_AFFORDANCE_CLASS,
);

function CalendarShell({ children, create }: {
  children: React.ReactNode;
  /** The surface's one `+`, handed to the header (`SurfaceCreate`). */
  create?: React.ReactNode;
}) {
  return (
    // No member nav for a visitor, even while loading.
    <AppShell variant="app" member={wasMember() ? 'calendar' : undefined} create={create} fill>
      {/* Above the phone the window is the Mac window, as in SurfaceShell: the
          page does not scroll, the agenda and the timeline scroll themselves. */}
      <div className="w-full text-foreground min-[761px]:flex min-[761px]:min-h-0 min-[761px]:flex-1 min-[761px]:flex-col">
        {/* The nav names the surface; the heading stays for screen readers. */}
        <h1 className="sr-only">{t('Calendar')}</h1>
        {children}
      </div>
    </AppShell>
  );
}

function DayRow({ day, sources, actions }: { day: AgendaDay; sources: WebCalendarSource[]; actions: EventActions }) {
  const heading = dayHeading(day.date);
  const isToday = day.date.getTime() === startOfDay(new Date()).getTime();
  const hasItems = day.layers.length > 0 || day.events.length > 0;
  const items = orderedDayItems(day);
  return (
    // Today, called out in the list the same way the rest of the app marks "now".
    <li className={cn(
      'grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-5 gap-y-1 border-t py-3.5 @max-[34rem]/agenda:grid-cols-1 @max-[34rem]/agenda:gap-2',
      isToday && 'border-t-(--accent)',
    )}>
      <div className="flex flex-col gap-0.5">
        <strong className={cn('text-[17px] font-medium', isToday ? 'text-(--accent-down)' : 'text-foreground')}>{heading.primary}</strong>
        <small className="text-xs text-muted-foreground">{heading.secondary}</small>
      </div>
      {!hasItems ? (
        <p className="m-0 mt-0.5 text-sm text-muted-foreground/50">{t('Nothing scheduled')}</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {items.map((item) => item.kind === 'layer' ? (
            <CalendarLayerRow key={item.item.id} item={item.item} actions={actions} />
          ) : (
            <EventRow key={`${item.item.calendarId}:${item.item.id}`} event={item.item} canEdit={sources.some(source => source.id === item.item.calendarId && source.writable)} actions={actions} />
          ))}
        </ul>
      )}
    </li>
  );
}

type OrderedDayItem =
  | { kind: 'layer'; item: WebCalendarLayerItem }
  | { kind: 'event'; item: WebCalendarEvent };

function orderedDayItems(day: AgendaDay): OrderedDayItem[] {
  return [
    ...day.layers.map((item) => ({ kind: 'layer' as const, item })),
    ...day.events.map((item) => ({ kind: 'event' as const, item })),
  ].sort((left, right) => {
    if (left.item.allDay !== right.item.allDay) return left.item.allDay ? -1 : 1;
    const leftStart = Date.parse(left.item.start);
    const rightStart = Date.parse(right.item.start);
    return (Number.isFinite(leftStart) ? leftStart : Number.POSITIVE_INFINITY)
      - (Number.isFinite(rightStart) ? rightStart : Number.POSITIVE_INFINITY);
  });
}

/**
 * A layer's colour, as the `--layer` variable the classes below read. The
 * colours live once, in `CALENDAR_SPECIAL_LAYERS`. A Google row standing in
 * for a published event wears the Events colour.
 */
function layerColorStyle(kind: WebCalendarLayerKind): CSSProperties {
  return { '--layer': CALENDAR_SPECIAL_LAYERS.find((layer) => layer.kind === kind)?.color } as CSSProperties;
}

/** The hover veil over whatever background the element already has (docs/DESIGN.md, "Hover"). */
const hoverLift = 'hover-lift';

/** A card by layer: an edge in the layer colour. */
const LAYER_EDGE = 'border-r-[3px] border-r-(--layer) pr-2.5';

function CalendarSpecials({
  items,
  degradedKinds,
  visibleKinds,
  onToggle,
}: {
  items: WebCalendarLayerItem[];
  degradedKinds: Set<WebCalendarLayerKind>;
  visibleKinds: Set<WebCalendarLayerKind>;
  onToggle: (kind: WebCalendarLayerKind) => void;
}) {
  return (
    <aside aria-label={t('{workspace} calendars', { workspace: workspaceBrand().name })}>
      <div className="flex flex-col gap-0.5 border-b px-1 pb-2.5">
        <strong className="text-sm font-semibold text-foreground">{t('{workspace} calendars', { workspace: workspaceBrand().name })}</strong>
        <small className="text-[11px] text-muted-foreground">{t('Read-only projections')}</small>
      </div>
      <div className="flex flex-col gap-0.5 pt-2">
        {CALENDAR_SPECIAL_LAYERS.map((layer) => {
          const count = items.filter((item) => item.kind === layer.kind).length;
          const checked = visibleKinds.has(layer.kind);
          // A feed Core did not answer says so in place of its caption: an
          // empty week and a dead feed must not both read as "—".
          const degraded = degradedKinds.has(layer.kind);
          return (
            <Label
              key={layer.kind}
              className={cn(
                'grid min-h-[42px] cursor-pointer grid-cols-[15px_10px_minmax(0,1fr)_auto] items-center gap-2 rounded-md p-1 text-foreground hover-lift font-normal leading-normal',
                !checked && 'opacity-50',
              )}
            >
              <Checkbox
                checked={checked}
                onCheckedChange={() => onToggle(layer.kind)}
                aria-label={t('Show {title}', { title: layer.title })}
              />
              <span className="size-2.5 rounded-[3px]" style={{ backgroundColor: layer.color }} aria-hidden="true" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <strong className="truncate text-[13px] font-[560]">{layer.title}</strong>
                <small className={cn('truncate text-[11px]', degraded ? 'text-destructive' : 'text-muted-foreground')}>
                  {degraded ? t('Didn’t load') : layer.caption}
                </small>
              </span>
              <Badge
                variant="secondary"
                className={cn('min-w-5 px-1.5 text-[11px] tabular-nums', degraded ? 'text-destructive' : 'text-muted-foreground')}
              >
                {degraded ? '!' : count || '—'}
              </Badge>
            </Label>
          );
        })}
      </div>
      <p className="mx-1 mt-3 mb-0 text-[11px] leading-[1.45] text-muted-foreground">{t('Read-only.')}</p>
    </aside>
  );
}

/**
 * A month on a grid, Monday first: each day lists its first few events, and a
 * day opens the week it is in. A chip edits its event where the calendar is
 * writable; on a read-only one it only reads. The page's week stays the place
 * to see an event's detail.
 */
const MONTH_CHIPS = 3;

function CalendarMonth({ days, month, writableCalendarIds, onEdit, onOpenDay }: {
  days: AgendaDay[];
  month: Date;
  writableCalendarIds: Set<string>;
  onEdit: (event: WebCalendarEvent) => void;
  onOpenDay: (date: Date) => void;
}) {
  const today = startOfDay(new Date()).getTime();
  const weekdays = Array.from({ length: 7 }, (_, index) => new Date(2024, 0, 1 + index)
    .toLocaleDateString(dateLocale, { weekday: 'short' }));
  return (
    <Card asChild className="gap-0 overflow-hidden rounded-[12px] py-0 shadow-none">
    <section aria-label={t('Month')}>
      <div className="grid grid-cols-7 border-b bg-muted text-center text-[11px] font-medium tracking-[0.04em] text-muted-foreground uppercase" aria-hidden="true">
        {weekdays.map((name) => <span key={name} className="px-1 py-1.5">{name}</span>)}
      </div>
      <ol className="m-0 grid list-none grid-cols-7 p-0">
        {days.map((day) => {
          const inMonth = day.date.getMonth() === month.getMonth();
          const isToday = day.date.getTime() === today;
          const shown = day.events.slice(0, MONTH_CHIPS);
          return (
            <li key={day.date.toISOString()} className={cn('min-h-24 min-w-0 border-r border-b p-1 [&:nth-child(7n)]:border-r-0', !inMonth && 'bg-muted/40')}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className={cn('mb-0.5 rounded-full text-xs font-normal tabular-nums', isToday ? 'bg-foreground font-semibold text-background hover:text-background' : inMonth ? 'text-foreground' : 'text-muted-foreground')}
                aria-label={t('Open the week of {day}', { day: day.date.toLocaleDateString(dateLocale, { weekday: 'long', day: 'numeric', month: 'long' }) })}
                onClick={() => onOpenDay(day.date)}
              >
                {day.date.getDate()}
              </Button>
              <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                {shown.map((event) => {
                  const label = event.allDay ? event.title : `${formatTime(new Date(event.start))} ${event.title}`;
                  const chip = 'block w-full truncate rounded-[4px] border-0 border-l-[3px] border-l-muted-foreground bg-foreground/8 px-1 py-0.5 text-left text-[11px] leading-tight text-foreground';
                  return (
                    <li key={`${event.calendarId}:${event.id}`} className="min-w-0">
                      {writableCalendarIds.has(event.calendarId)
                          // shadcn: a month-grid event chip, coloured per calendar
                        ? <button type="button" className={cn(chip, 'cursor-pointer hover-lift')} title={label} onClick={() => onEdit(event)}>{label}</button>
                        : <span className={chip} title={label}>{label}</span>}
                    </li>
                  );
                })}
              </ul>
              {day.events.length > MONTH_CHIPS && (
                <Button type="button" variant="link" size="xs" className="mt-0.5 h-auto px-1 py-0 text-[11px] font-normal text-muted-foreground hover:text-foreground" onClick={() => onOpenDay(day.date)}>
                  {t('+{count} more', { count: day.events.length - MONTH_CHIPS })}
                </Button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
    </Card>
  );
}

/**
 * Which calendars are drawn, per account, as the Mac's CALENDARS block lists them.
 * A calendar kept out of Meet in Settings shows dimmed: it is decided there, not here.
 */
function CalendarChoices({ accounts, preferences, hasSubscribed, subscribedHidden, onToggleCalendar, onToggleAccount, onToggleSubscribed }: {
  accounts: WebCalendarAccount[];
  preferences?: WebCalendarPreferences;
  hasSubscribed: boolean;
  subscribedHidden: boolean;
  onToggleCalendar: (source: WebCalendarSource, account: WebCalendarAccount, hidden: boolean) => void;
  onToggleAccount: (account: WebCalendarAccount, hidden: boolean) => void;
  onToggleSubscribed: (hidden: boolean) => void;
}) {
  const disabled = new Set(preferences?.disabled_calendar_keys ?? []);
  return (
    <aside aria-label={t('Calendars')} className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5 border-b px-1 pb-2.5">
        <strong className="text-sm font-semibold text-foreground">{t('Calendars')}</strong>
        <small className="text-[11px] text-muted-foreground">{t('Also changes the Mac and iPhone')}</small>
      </div>
      {accounts.map((account) => {
        const accountOff = disabled.has(account.key);
        const accountHidden = accountOff || (preferences?.hidden_calendar_keys ?? []).includes(account.key)
          || account.calendars.every((calendar) => isCalendarHidden(calendar, account, preferences));
        return (
          <section key={account.key} className="flex flex-col gap-0.5" aria-label={account.title}>
            <Label className={cn('flex min-h-8 cursor-pointer items-center gap-2 rounded-md p-1 hover-lift font-normal leading-normal', accountOff && 'cursor-default opacity-50')}>
              <Checkbox
                checked={!accountHidden}
                disabled={accountOff}
                onCheckedChange={() => onToggleAccount(account, !accountHidden)}
                aria-label={t('Show {title}', { title: account.title })}
              />
              <strong className="truncate text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">{account.title}</strong>
            </Label>
            {account.calendars.map((calendar) => {
              const off = disabled.has(googleCalendarKey(calendar.id)) || accountOff;
              const hidden = isCalendarHidden(calendar, account, preferences);
              return (
                <Label key={calendar.id} className={cn('flex min-h-8 cursor-pointer items-center gap-2 rounded-md p-1 pl-6 hover-lift font-normal leading-normal', off && 'cursor-default opacity-50')}>
                  <Checkbox
                    checked={!hidden}
                    disabled={off}
                    onCheckedChange={() => onToggleCalendar(calendar, account, !hidden)}
                    aria-label={t('Show {title}', { title: calendar.summary })}
                  />
                  <span className="size-2.5 flex-none rounded-[3px] bg-muted-foreground" style={calendar.backgroundColor ? { backgroundColor: calendar.backgroundColor } : undefined} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{calendar.summary}</span>
                  {off && <small className="text-[11px] text-muted-foreground">{t('Off in Starlings')}</small>}
                </Label>
              );
            })}
          </section>
        );
      })}
      {hasSubscribed && (
        <Label className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md p-1 hover-lift font-normal leading-normal">
          <Checkbox checked={!subscribedHidden} onCheckedChange={() => onToggleSubscribed(!subscribedHidden)} aria-label={t('Show subscribed calendars')} />
          <strong className="truncate text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">{t('Subscribed')}</strong>
        </Label>
      )}
    </aside>
  );
}

/** The time column of a card: the same width on every row, so the titles line up. */
const cardTimeClass = 'min-w-30 flex-none text-[13px] text-muted-foreground tabular-nums @max-[34rem]/agenda:min-w-24';
/** The text column of a card: the title, then the metadata lines. */
const cardTextClass = 'flex min-w-48 flex-1 flex-col gap-0.5';
const cardTitleClass = 'text-[15px] font-[560] text-foreground';
const cardDetailClass = 'truncate text-xs text-muted-foreground';
/** Over: faded, still readable and still clickable, like the Mac's past blocks. */
const pastRowClass = 'opacity-50';

/** A row whose end is behind now. The page redraws on its refresh timer. */
function hasEnded(end: string, now = Date.now()): boolean {
  const time = Date.parse(end);
  return Number.isFinite(time) && time <= now;
}

/** An event or layer card: an Item on the list's own rhythm, no frame. */
const cardClass = 'items-start gap-x-4 gap-y-1.5 rounded-none px-0 py-2';

/**
 * A layer row on the event row's frame: the same time column, the title
 * as the row's target, and the same `…` menu. A task wears the task mark
 * the Work rows use (`TaskRow`), before its title as in Work.
 */
function CalendarLayerRow({ item, actions }: { item: WebCalendarLayerItem; actions: EventActions }) {
  // Every layer row opens its dialog: what it is, and the
  // ways to where it lives. The dialog holds the event page link too.
  const key = `layer|${item.kind}|${item.id}`;
  const row = actions.menu.rowProps(key);
  const copyHref = item.links[0]?.href || item.url;
  return (
    <Item asChild {...row} className={cn(row.className, cardClass, hasEnded(item.end) && pastRowClass)}>
      <li>
        <span className={cardTimeClass}>{layerTimeRange(item)}</span>
        <span className={cardTextClass}>
          {/* shadcn: the whole row is the target */}
          <button
            type="button"
            className={cn('flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-sm border-0 bg-transparent p-0 text-left text-inherit', hoverLift)}
            data-row-target=""
            onClick={() => actions.onOpenLayer(item)}
          >
            {item.kind === 'tasks' && <GlyphMark size={20} shape="square"><TaskIcon size={12} /></GlyphMark>}
            <strong className={cn(cardTitleClass, 'min-w-0 truncate')}>{item.title}</strong>
          </button>
          {item.detail && <small className={cardDetailClass}>{item.detail}</small>}
        </span>
        <span className="flex flex-none items-center gap-2">
          {actions.menu.panel(key, (
            <MenuGroups
              groups={[
                [<DropdownMenuItem key="open" onSelect={() => actions.onOpenLayer(item)}><MenuIcon name="open" />{t('Open')}</DropdownMenuItem>],
                [
                  ...item.links.map((link) => <OpenItem key={link.href} href={link.href} label={link.label} />),
                  ...(item.url ? [<OpenItem key="event" href={item.url} label={t('Sign-up page')} external />] : []),
                ],
                copyHref ? [<CopyLinkItem key="copy" href={copyHref} />] : [],
              ]}
            />
          ))}
        </span>
      </li>
    </Item>
  );
}

/**
 * A layer row read in the editor's dialog frame, so an event and a task open
 * the same way: kind, title, when, who and where, and the ways onward.
 * Read-only. Core owns the row, and Work is where it is changed (editing is
 *). With no draft to lose, a click outside closes it.
 */
function CalendarLayerDialog({ item, onClose, onChanged }: {
  item: WebCalendarLayerItem | null;
  onClose: () => void;
  /** A published event was saved to the CMS: the row's title or time may have moved. */
  onChanged: () => void;
}) {
  const layer = item ? CALENDAR_SPECIAL_LAYERS.find((entry) => entry.kind === item.kind) : undefined;
  const about = usePublishedEventDetail(item);
  const eventID = publishedEventID(item);
  //: a published event is a CMS row; whoever may write it edits it here.
  const cmsEvents = useWritableCmsEntity(eventID ? 'events' : '');
  const [editing, setEditing] = useState(false);
  const facts: Array<[string, string]> = item ? [
    [item.kind === 'events' ? t('Location') : t('Project'), item.place],
    [item.mine ? t('Assigned to you') : t('Assigned to'), item.assignee],
    [t('Status'), layerStatusLabel(item.status)],
  ].filter((fact): fact is [string, string] => fact[1].length > 0) : [];
  return (
    <Dialog open={item !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {item && (
        <DialogContent
          showCloseButton={false}
          className={cn(editorDialogClass, 'gap-4 bg-card p-5 sm:max-w-[520px]')}
          style={layerColorStyle(item.kind)}
        >
          <div className={editorHeaderClass}>
            <div className="flex min-w-0 flex-col gap-1">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <span className="size-2.5 rounded-[3px] bg-(--layer)" aria-hidden="true" />
                {layer?.title}
              </span>
              <DialogTitle className="text-xl leading-snug font-semibold [overflow-wrap:anywhere]">{item.title}</DialogTitle>
              <DialogDescription className="text-sm text-muted-foreground">{layerWhen(item)}</DialogDescription>
            </div>
            <Button type="button" variant="ghost" size="icon" className="rounded-full text-muted-foreground" aria-label={t('Close')} onClick={onClose}>
              <CloseIcon />
            </Button>
          </div>
          {facts.length > 0 && (
            <dl className="m-0 grid gap-2.5">
              {facts.map(([label, value]) => (
                <div key={label} className="grid gap-0.5">
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="m-0 text-sm">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {item.notes && <p className="m-0 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">{item.notes}</p>}
          {about.state === 'loading' && <p className="m-0 text-sm text-muted-foreground">{t('Loading event…')}</p>}
          {about.state === 'failed' && <p className="m-0 text-sm text-muted-foreground">{about.message}</p>}
          {about.state === 'ok' && hasEventAbout(about.detail) && (
            <div className="grid gap-2 text-sm [&_img]:m-0 [&_p]:m-0">
              <EventAbout detail={about.detail} title={item.title} />
            </div>
          )}
          {(item.links.length > 0 || item.url || cmsEvents) && (
            <div className="flex flex-wrap gap-2">
              {item.links.map((link, index) => (
                <Button key={link.href} asChild variant={index === 0 ? 'default' : 'secondary'}>
                  <a href={link.href}>{link.label}</a>
                </Button>
              ))}
              {item.url && (
                <Button asChild variant={item.links.length === 0 ? 'default' : 'secondary'}>
                  <a href={item.url} target="_blank" rel="noreferrer">{t('Sign-up page')}</a>
                </Button>
              )}
              {cmsEvents && <Button type="button" variant="secondary" onClick={() => setEditing(true)}>{t('Edit…')}</Button>}
            </div>
          )}
          {editing && cmsEvents && (
            <CmsRecordEditor entity={cmsEvents} id={eventID} onClose={() => setEditing(false)} onSaved={onChanged} />
          )}
          {layer && <small className="text-xs text-muted-foreground">{layer.caption}</small>}
        </DialogContent>
      )}
    </Dialog>
  );
}

type PublishedEventDetail =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'failed'; message: string }
  | { state: 'ok'; detail: CrmSubjectDetail };

/** The CMS `events.id` behind a published-event row, or ''. */
function publishedEventID(item: WebCalendarLayerItem | null): string {
  return item?.kind === 'events' && item.id.startsWith('public:') ? item.id.slice('public:'.length) : '';
}

/**
 * A published event's full record, read when its dialog opens. The public
 * feed carries only title, time, place and the sign-up link; the Work
 * event subject is the same CMS row (`public:<events.id>`) with the rest.
 */
function usePublishedEventDetail(item: WebCalendarLayerItem | null): PublishedEventDetail {
  const eventID = publishedEventID(item);
  const title = item?.title ?? '';
  const [result, setResult] = useState<{ id: string; value: PublishedEventDetail }>({ id: '', value: { state: 'none' } });
  useEffect(() => {
    if (!eventID) return;
    let live = true;
    fetchSubjectDetail({ kind: 'event', id: eventID, title, subtitle: null }).then(
      (detail) => { if (live) setResult({ id: eventID, value: { state: 'ok', detail } }); },
      (cause: unknown) => {
        if (live) setResult({ id: eventID, value: { state: 'failed', message: cause instanceof Error ? cause.message : t('Couldn’t load that subject.') } });
      },
    );
    return () => { live = false; };
    // The title only names the request; the id decides it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventID]);
  if (!eventID) return { state: 'none' };
  return result.id === eventID ? result.value : { state: 'loading' };
}

/** Core's status word, readable: `in_progress` → "In progress". */
function layerStatusLabel(status: string): string {
  const words = status.replace(/_/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

/** The dialog's when: a day for a dated row, a due time for a task, a window otherwise. */
function layerWhen(item: WebCalendarLayerItem): string {
  const start = new Date(item.start);
  const day = start.toLocaleDateString(dateLocale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (item.allDay) return day;
  if (item.kind === 'tasks') return t('Due {when}', { when: `${day} ${formatTime(start)}` });
  return `${day} ${formatTime(start)} – ${formatTime(new Date(item.end))}`;
}

const TIMELINE_START_HOUR = 8;
const TIMELINE_END_HOUR = 20;
const TIMELINE_HOUR_HEIGHT = 56;

/** An hour of the timeline on the 24-hour clock, from the same formatter as every other time. */
function timelineHourLabel(hour: number): string {
  return formatTime(new Date(2000, 0, 1, hour));
}

/** One hairline per hour under the blocks. */
const TIMELINE_COLUMN_STYLE: CSSProperties = {
  backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${TIMELINE_HOUR_HEIGHT - 1}px, var(--line) ${TIMELINE_HOUR_HEIGHT - 1}px, var(--line) ${TIMELINE_HOUR_HEIGHT}px)`,
};

function CalendarTimeline({
  days,
  writableCalendarIds,
  onEdit,
  onOpenLayer,
  todayOnly,
}: {
  days: AgendaDay[];
  writableCalendarIds: Set<string>;
  onEdit: (event: WebCalendarEvent) => void;
  onOpenLayer: (item: WebCalendarLayerItem) => void;
  todayOnly: boolean;
}) {
  const timelineStyle = {
    '--columns': days.length,
  } as CSSProperties;
  const hours = Array.from(
    { length: TIMELINE_END_HOUR - TIMELINE_START_HOUR },
    (_, index) => TIMELINE_START_HOUR + index,
  );

  return (
    <section className="mt-3 min-w-0 overflow-hidden rounded-[12px] border bg-muted" aria-label={todayOnly ? 'Today timeline' : 'Week timeline'}>
      <div className="flex items-baseline justify-between gap-2 border-b px-3.5 py-3">
        <strong className="text-sm font-semibold">{todayOnly ? t('Today') : t('Timeline')}</strong>
        <small className="text-[11px] text-muted-foreground tabular-nums">
          {timelineHourLabel(TIMELINE_START_HOUR)} – {timelineHourLabel(TIMELINE_END_HOUR)}
        </small>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-[calc(42px+var(--columns)*88px)]" style={timelineStyle}>
          <div className="grid min-h-11 grid-cols-[42px_repeat(var(--columns),minmax(88px,1fr))] border-b">
            <span aria-hidden="true" />
            {days.map((day) => {
              const heading = dayHeading(day.date);
              const weekday = day.date.toLocaleDateString(dateLocale, { weekday: 'short' });
              const label = heading.primary === 'Today' ? 'Today' : weekday;
              return (
                <span key={day.date.toISOString()} className="flex min-w-0 flex-col justify-center gap-px border-l px-2 py-1.5">
                  <strong className="truncate text-xs font-semibold text-foreground">{label}</strong>
                  <small className="text-[11px] text-muted-foreground">{day.date.getDate()}</small>
                </span>
              );
            })}
          </div>
          <div
            className="grid grid-cols-[42px_minmax(0,1fr)]"
            style={{ height: hours.length * TIMELINE_HOUR_HEIGHT }}
          >
            <div className="grid" style={{ gridTemplateRows: `repeat(${hours.length}, ${TIMELINE_HOUR_HEIGHT}px)` }} aria-hidden="true">
              {hours.map((hour) => (
                <span key={hour} className="pt-1.5 pr-[7px] text-right text-[11px] text-muted-foreground tabular-nums">
                  {timelineHourLabel(hour)}
                </span>
              ))}
            </div>
            <div className="grid min-w-0 grid-cols-[repeat(var(--columns),minmax(88px,1fr))]">
              {days.map((day) => (
                <TimelineDay
                  key={day.date.toISOString()}
                  day={day}
                  canEdit={(event) => writableCalendarIds.has(event.calendarId)}
                  onEdit={onEdit}
                  onOpenLayer={onOpenLayer}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * A block on the timeline. Its height is set inline from the duration, so
 * it is a size container: when it is tall enough for two rows of marks
 * (36px, as on the Mac and the phone), "where" keeps the top-right corner
 * and "who" takes the bottom-right.
 */
const timelineBlockClass = 'absolute inset-x-[5px] z-1 flex flex-col items-start justify-start overflow-hidden rounded-[7px] border-0 border-l-[3px] border-l-muted-foreground bg-foreground/8 px-1.5 py-[5px] text-left text-foreground [container-type:size]';
/** Now: the accent fill and edge. */
const timelineActiveClass = 'border-l-(--accent) bg-[color-mix(in_srgb,var(--accent)_16%,transparent)]';
/** A layer block: the layer's colour, from `layerColorStyle`. */
const timelineLayerClass = 'border-l-(--layer) bg-[color-mix(in_srgb,var(--layer)_18%,transparent)] opacity-82';
const timelineTitleClass = 'flex w-full min-w-0 items-center gap-[5px]';
/** A metadata row under the title: hidden until the block is tall enough to hold it whole. */
const timelineRowClass = 'hidden h-3 w-full min-w-0 items-center gap-[3px] text-[10px] leading-3 text-muted-foreground';
const timelineTitleTextClass = 'block min-w-0 flex-1 truncate text-xs leading-[1.15] font-semibold';

function TimelineDay({
  day,
  canEdit,
  onEdit,
  onOpenLayer,
}: {
  day: AgendaDay;
  canEdit: (event: WebCalendarEvent) => boolean;
  onEdit: (event: WebCalendarEvent) => void;
  onOpenLayer: (item: WebCalendarLayerItem) => void;
}) {
  const now = new Date();
  const isToday = startOfDay(now).getTime() === day.date.getTime();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const nowOffset = (nowMinutes - TIMELINE_START_HOUR * 60) / 60 * TIMELINE_HOUR_HEIGHT;
  const showNow = isToday
    && nowMinutes >= TIMELINE_START_HOUR * 60
    && nowMinutes < TIMELINE_END_HOUR * 60;

  // Layers and events pack in one pass, as on native, so a layer block and a
  // meeting at the same hour share the column instead of covering each other.
  const layers = day.layers.filter((item) => !item.allDay).flatMap((item) => {
    const box = timelineItemBox(item, day.date);
    return box ? [{ item, box, key: `layer:${item.id}` }] : [];
  });
  const events = day.events.filter((event) => !event.allDay).flatMap((event) => {
    const box = timelineItemBox(event, day.date);
    return box ? [{ event, box, key: `event:${eventKey(event)}` }] : [];
  });
  const lanes = packTimelineBoxes([...layers, ...events]);
  const placed = (key: string, box: TimelineBox) => {
    const lane = lanes.get(key) ?? { column: 0, columnCount: 1 };
    return { lane, position: timelineLanePosition(box, lane) };
  };

  return (
    <div className="relative min-w-0 border-l" style={TIMELINE_COLUMN_STYLE}>
      {layers.map(({ item, box, key }) => {
        const { lane, position } = placed(key, box);
        const blockClass = cn(timelineBlockClass, isLayerInProgress(item) && timelineActiveClass, timelineLayerClass);
        const style = { ...position, ...layerColorStyle(item.kind) };
        // The same title wrapper as an event: it sets the card's type size
        // and clamps to one line.
        const content = <span className={timelineTitleClass}><strong className={timelineTitleTextClass}>{item.title}</strong></span>;
        const block = (
          // shadcn: a timeline block, placed and coloured per event
          <button
            type="button"
            className={cn(blockClass, 'cursor-pointer', hoverLift)}
            style={style}
            aria-label={`${item.title}, ${layerTimeRange(item)}`}
            onClick={() => onOpenLayer(item)}
          >
            {content}
          </button>
        );
        return <TimelineLaneBlock key={key} lane={lane} position={position}>{block}</TimelineLaneBlock>;
      })}
      {events.map(({ event, box, key }) => {
        const { lane, position } = placed(key, box);
        const attendance = attendanceOf(event);
        // Location and time under the title, as the block grows:
        // the same rows and order as the Mac and the phone. The thresholds are
        // the title line, then one 12px row each, plus the block's 10px of
        // padding, so a row is shown whole or not at all.
        const detail = calendarTileDetail(event);
        const content = (
          <>
          <span className={timelineTitleClass}>
            <strong className={timelineTitleTextClass}>{event.title}</strong>
            {event.platform !== 'none' && (
              <MeetingPlatformIcon
                platform={event.platform}
                className={isStarlingsMeet(event) ? 'text-(--accent)' : 'text-muted-foreground'}
              />
            )}
            {attendance && (
              <span
                className={cn(
                  'flex flex-none [@container(min-height:36px)]:absolute [@container(min-height:36px)]:right-1.5 [@container(min-height:36px)]:bottom-1',
                  attendance === 'confirmed' ? 'text-foreground' : 'text-muted-foreground',
                )}
                title={ATTENDANCE_LABEL[attendance]}
              >
                <AttendanceIcon attendance={attendance} className="block" />
              </span>
            )}
          </span>
          {detail?.location && (
            <span className={cn(timelineRowClass, '[@container(min-height:48px)]:flex', attendance && 'pr-4')} data-tile-row="location">
              <MapPinIcon className="size-[9px] flex-none" aria-hidden />
              <span className="truncate">{detail.location}</span>
            </span>
          )}
          {detail && (
            <span className={cn(timelineRowClass, '[@container(min-height:36px)]:flex', attendance && 'pr-4')} data-tile-row="time">
              <ClockIcon className="size-[9px] flex-none" aria-hidden />
              <span className="truncate">{detail.time}</span>
            </span>
          )}
          </>
        );
        const blockClass = cn(
          timelineBlockClass,
          event.calendarRole === 'global_interest' && 'border-l-(--accent)',
          isInProgress(event) && timelineActiveClass,
          // Shown only when asked for, and then faded.
          event.demoted && 'opacity-40',
          // A Google row standing in for a published event wears the Events colour.
          event.published && 'shadow-[inset_-3px_0_0_var(--layer)]',
        );
        const style = event.published ? { ...position, ...layerColorStyle('events') } : position;
        const block = canEdit(event) ? (
          // shadcn: a timeline block, placed and coloured per event
          <button
            type="button"
            className={cn(blockClass, 'cursor-pointer', hoverLift)}
            style={style}
            aria-label={`${event.title}, ${timeRange(event)}`}
            onClick={() => onEdit(event)}
          >
            {content}
          </button>
        ) : (
          <span className={blockClass} style={style}>
            {content}
          </span>
        );
        return <TimelineLaneBlock key={key} lane={lane} position={position}>{block}</TimelineLaneBlock>;
      })}
      {showNow && (
        <span
          className="pointer-events-none absolute inset-x-0 z-50 h-0.5 bg-(--accent) before:absolute before:-top-1 before:-left-1 before:size-2.5 before:rounded-full before:bg-(--accent) before:content-['']"
          style={{ top: nowOffset }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

/** A block's drawn extent on the timeline, in pixels from the top of the column. */
type TimelineBox = { top: number; height: number };
type TimelineLane = { column: number; columnCount: number };

/**
 * Native `CalendarWeekMath.pack`: greedy lanes over one day's blocks, with a
 * lane count per cluster of blocks that touch. The web packs the drawn boxes
 * rather than the times, because the 28px floor makes a short block reach
 * into the next one.
 */
function packTimelineBoxes(entries: { key: string; box: TimelineBox }[]): Map<string, TimelineLane> {
  const ordered = [...entries].sort((left, right) =>
    left.box.top - right.box.top || right.box.height - left.box.height);
  const columnByKey = new Map<string, number>();
  const clusters: string[][] = [];
  let active: { bottom: number; column: number }[] = [];
  let cluster: string[] = [];
  let clusterBottom = -Infinity;

  for (const { key, box } of ordered) {
    active = active.filter((entry) => entry.bottom > box.top);
    if (box.top >= clusterBottom) {
      if (cluster.length > 0) clusters.push(cluster);
      cluster = [];
      clusterBottom = box.top + box.height;
    } else {
      clusterBottom = Math.max(clusterBottom, box.top + box.height);
    }
    cluster.push(key);
    const used = new Set(active.map((entry) => entry.column));
    let column = 0;
    while (used.has(column)) column += 1;
    columnByKey.set(key, column);
    active.push({ bottom: box.top + box.height, column });
  }
  if (cluster.length > 0) clusters.push(cluster);

  const lanes = new Map<string, TimelineLane>();
  for (const keys of clusters) {
    const columnCount = Math.max(...keys.map((key) => columnByKey.get(key) ?? 0)) + 1;
    for (const key of keys) lanes.set(key, { column: columnByKey.get(key) ?? 0, columnCount });
  }
  return lanes;
}

/**
 * Native `CalendarPackedSpan`: colliding blocks cascade. Each lane starts a
 * step further right and runs to the edge of the day, so the front block is
 * wide enough for a title and the ones behind it keep a stub you can click.
 */
function timelineLanePosition(box: TimelineBox, lane: TimelineLane): CSSProperties {
  const step = lane.columnCount > 1 ? Math.min(0.34, 0.8 / lane.columnCount) : 0;
  const leading = step * lane.column;
  return {
    top: box.top,
    height: box.height,
    left: leading > 0 ? `calc(5px + (100% - 10px) * ${leading})` : undefined,
    zIndex: 1 + lane.column,
  };
}

/**
 * A block in a cascade sits on a solid underlay: its fill is a tint, and
 * without the underlay the title behind it reads through its own.
 */
function TimelineLaneBlock({ lane, position, children }: { lane: TimelineLane; position: CSSProperties; children: ReactNode }) {
  if (lane.columnCount < 2) return children;
  return (
    <>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-[5px] rounded-[7px] bg-muted shadow-[0_0_0_1px_var(--muted)]"
        style={position}
      />
      {children}
    </>
  );
}

function timelineItemBox(item: Pick<WebCalendarEvent, 'start' | 'end'>, day: Date): TimelineBox | null {
  const start = Date.parse(item.start);
  const end = Date.parse(item.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  const dayStart = startOfDay(day);
  const visibleStart = new Date(dayStart);
  visibleStart.setHours(TIMELINE_START_HOUR, 0, 0, 0);
  const visibleEnd = new Date(dayStart);
  visibleEnd.setHours(TIMELINE_END_HOUR, 0, 0, 0);
  const clippedStart = Math.max(start, visibleStart.getTime());
  const clippedEnd = Math.min(end, visibleEnd.getTime());
  if (clippedEnd <= clippedStart) return null;

  const top = (clippedStart - visibleStart.getTime()) / 3_600_000 * TIMELINE_HOUR_HEIGHT;
  const height = Math.max(28, (clippedEnd - clippedStart) / 3_600_000 * TIMELINE_HOUR_HEIGHT - 4);
  return {
    top,
    height,
  };
}

function layerTimeRange(item: WebCalendarLayerItem): string {
  if (item.allDay) return t('All day');
  const start = new Date(item.start);
  const end = new Date(item.end);
  if (Number.isNaN(start.getTime())) return '';
  return Number.isNaN(end.getTime()) ? formatTime(start) : `${formatTime(start)} – ${formatTime(end)}`;
}

function isLayerInProgress(item: WebCalendarLayerItem, now = Date.now()): boolean {
  const start = Date.parse(item.start);
  const end = Date.parse(item.end);
  return Number.isFinite(start) && Number.isFinite(end) && start <= now && end > now;
}

/** What an agenda row's menu does; the page owns the writes. */
type EventActions = {
  menu: RowMenuController;
  onEdit: (event: WebCalendarEvent) => void;
  onOpenLayer: (item: WebCalendarLayerItem) => void;
  onDemote: (event: WebCalendarEvent, demoted: boolean) => void;
  onRespond: (event: WebCalendarEvent, response: CalendarRSVP) => void;
  /** Where each event may move (`eventMoveChoices`), its own calendar included. */
  moveChoices: (event: WebCalendarEvent) => WebCalendarSource[];
  onMove: (event: WebCalendarEvent, destinationId: string) => void;
};

/**
 * An event row's menu, in the Mac's order (`CalendarViewController
 * .contextMenu(for:)`): Join; Edit…, Hide from Next, Reply, Move to; Copy link.
 * Move to lists the calendars by account with the current one ticked, as the
 * Mac and the phone do. Delete stays in the editor; the web has no Duplicate.
 */
function EventMenuItems({ event, canEdit, actions }: { event: WebCalendarEvent; canEdit: boolean; actions: EventActions }) {
  const join = isVideoMeeting(event) ? eventLaunchURL(event) : '';
  const self = event.calendarId.startsWith('sub:') ? undefined : event.attendees.find((attendee) => attendee.self);
  const link = event.joinUrl || event.conferenceUrl;
  const choices = actions.moveChoices(event);
  const accounts = [...new Set(choices.map((source) => source.accountEmail))];
  return (
    <MenuGroups
      groups={[
        join ? [<OpenItem key="join" href={join} label={platformActionTitle(event)} external={!isStarlingsMeet(event)} icon="join" />] : [],
        [
          ...(canEdit ? [<DropdownMenuItem key="edit" onSelect={() => actions.onEdit(event)}><MenuIcon name="edit" />{t('Edit…')}</DropdownMenuItem>] : []),
          <DropdownMenuItem key="demote" onSelect={() => actions.onDemote(event, !event.demoted)}>
            <MenuIcon name={event.demoted ? 'show' : 'hide'} />
            {event.demoted ? t('Show in Next') : t('Hide from Next')}
          </DropdownMenuItem>,
          ...(self ? [(
            <DropdownMenuSub key="reply">
              <DropdownMenuSubTrigger><MenuIcon name="reply" />{t('Reply')}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={self.status} onValueChange={(value) => actions.onRespond(event, value as CalendarRSVP)}>
                  {CALENDAR_RSVP_CHOICES.map((choice) => (
                    <DropdownMenuRadioItem key={choice.response} value={choice.response}>{choice.title}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )] : []),
          ...(choices.length > 0 ? [(
            <DropdownMenuSub key="move">
              <DropdownMenuSubTrigger><MenuIcon name="move" />{t('Move to')}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={event.calendarId} onValueChange={(value) => { if (value !== event.calendarId) actions.onMove(event, value); }}>
                  {accounts.map((account) => (
                    <DropdownMenuGroup key={account}>
                      <DropdownMenuLabel>{account}</DropdownMenuLabel>
                      {choices.filter((source) => source.accountEmail === account).map((source) => (
                        <DropdownMenuRadioItem key={source.id} value={source.id}>{source.summary}</DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuGroup>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )] : []),
        ],
        link ? [<CopyLinkItem key="copy" href={link} />] : [],
      ]}
    />
  );
}

function EventRow({ event, canEdit, actions }: { event: WebCalendarEvent; canEdit: boolean; actions: EventActions }) {
  const row = actions.menu.rowProps(eventKey(event));
  const href = isVideoMeeting(event) ? eventLaunchURL(event) : '';
  const ours = isStarlingsMeet(event);
  const label = platformActionTitle(event);
  const sourceLabel = calendarSourceLabel(event);
  const meetingLabel = platformLabel(event);
  const locationLabel = calendarLocationLabel(event);
  const participants = participantAttendees(event);
  const travelLabel = travelTimeLabel(event.travelTimeMinutes);
  const titleContent = (
    <>
      <strong className={cn(cardTitleClass, canEdit && 'min-w-0 truncate')}>{event.title}</strong>
      {event.calendarRole === 'global_interest' && event.platform === 'none' && (
        // Ours, beside the title so the mark explains the event rather
        // than appearing detached at the far edge of the row.
        <span className="inline-flex flex-none text-foreground" title={t('Global interest')}>
          <WorkspaceMark />
        </span>
      )}
    </>
  );
  return (
    <Item
      asChild
      {...row}
      className={cn(
        row.className,
        cardClass,
        // Hidden from Home Upcoming, not hidden from the week: still yours and
        // available here to restore with Show in Next.
        event.demoted && 'opacity-60',
        hasEnded(event.end) && pastRowClass,
        event.published && LAYER_EDGE,
      )}
      style={event.published ? layerColorStyle('events') : undefined}
    >
      <li>
        <span className={cardTimeClass}>{timeRange(event)}</span>
        <span className={cardTextClass}>
          {canEdit
            ? (
              // shadcn: the whole row is the target
              <button
                type="button"
                className={cn('flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-sm border-0 bg-transparent p-0 text-left text-inherit', hoverLift)}
                data-row-target=""
                onClick={() => actions.onEdit(event)}
              >
                {titleContent}
              </button>
            )
            : <span className="flex min-w-0 items-center gap-1.5">{titleContent}</span>}
          {(meetingLabel || sourceLabel || locationLabel) && (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {meetingLabel && (
                <Badge
                  variant={ours ? 'default' : 'secondary'}
                  className={cn('gap-[5px] text-[11px] leading-tight font-normal', !ours && 'border-(--control-line) text-muted-foreground')}
                >
                  <MeetingPlatformIcon platform={event.platform} />
                  {meetingLabel}
                </Badge>
              )}
              {(sourceLabel || locationLabel) && (
                <small className={cardDetailClass}>{[sourceLabel, locationLabel].filter(Boolean).join(' · ')}</small>
              )}
            </span>
          )}
          {travelLabel && <small className="text-xs text-muted-foreground">{travelLabel}</small>}
          {participants.length > 0 && (
            <span className="flex flex-col gap-0.5 text-muted-foreground">
              {participants.map((participant) => (
                <span className="flex items-center gap-1.5" key={participant.email || participant.name}>
                  <AttendeeAvatar
                    name={participant.name}
                    email={participant.email}
                    status={participant.status}
                    member={attendeeIsMember(participant)}
                  />
                  <small className={cn('text-xs', participant.status === 'declined' && 'opacity-55')}>
                    {participant.crmUrl ? (
                      <a
                        className="text-inherit underline decoration-muted-foreground/55 underline-offset-2 hover:decoration-current"
                        href={participant.crmUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={t('Open full record for {name}', { name: participant.name })}
                      >
                        {participant.name}
                      </a>
                    ) : participant.name}
                  </small>
                  <Checkbox
                    className="ml-1 size-3.5"
                    checked={participant.inCrm === true}
                    disabled
                    tabIndex={-1}
                    aria-label={`${participant.name} is ${participant.inCrm ? '' : 'not '}in CRM`}
                  />
                </span>
              ))}
            </span>
          )}
          {/* The join is the event's bottom line, inside its block: in the
              trailing column it wrapped under the time (meet#1080). */}
          {isInProgress(event) && href && (
            <JoinMeetingButton event={event} href={href} className="self-start">{label}</JoinMeetingButton>
          )}
        </span>
        <span className="flex flex-none items-center gap-2">
          {actions.menu.panel(eventKey(event), <EventMenuItems event={event} canEdit={canEdit} actions={actions} />)}
        </span>
      </li>
    </Item>
  );
}

function eventKey(event: Pick<WebCalendarEvent, 'calendarId' | 'id'>): string {
  return `${event.calendarId}|${event.id}`;
}

/**
 * Calendar's address with `eventID` open, or with none: the event's
 * permalink, keeping the page's own context (`scope`) and
 * dropping what only an arrival reads (`day`).
 */
function calendarAddress(eventID: string | null): string {
  const params = new URLSearchParams(window.location.search);
  params.delete('day');
  const query = params.toString();
  return `${eventID ? eventHref(eventID) : '/calendar'}${query ? `?${query}` : ''}`;
}
