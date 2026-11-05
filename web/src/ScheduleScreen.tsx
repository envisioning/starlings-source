import { workspaceTimeZones } from './workspace-defaults';
import { FormEvent, lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { BackButton } from './BackButton';
import { Input } from '@/ui/input';
import { Card } from '@/ui/card';
import { Label } from '@/ui/label';
import { Textarea } from '@/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Button } from '@/ui/button';
import { Spinner } from '@/ui/spinner';
import { PlaceholderBar, PlaceholderRows } from '@/ui/placeholder-rows';
import { WorkspaceMark } from './action-icons';
import { apiFetch } from './api';
import { formatRange, formatSlotTime, localTimeZone } from './meeting-time';
import { hasValidGuestIdentity } from './meeting-types';
import type { JoinIdentity } from './meeting-types';
import { AppShell } from './SiteChrome';
import { readStored, StorageKeys, writeStored } from './storage';
import { withTurnstileToken } from './turnstile';
import { ErrorNotice } from './ErrorNotice';
import { GuestCard, GuestField } from './GuestCard';
import { useDocumentTitle } from './document-title';
import { t, dateLocale } from './i18n';

// react-day-picker stays off the guest entry: the month loads on its own.
const BookingMonth = lazy(() => import('./BookingMonth'));
const NdaCheckbox = lazy(() => import('./NdaCheckbox'));

type WorkingHours = Record<string, { enabled: boolean; start: string; end: string }>;

type MeetingInfo = {
  display_name: string;
  title?: string | null;
  duration_minutes: number;
  timezone: string;
  working_hours: WorkingHours;
  /** The workspace offers its NDA, a Docs document the guest signs. */
  nda?: boolean;
};

type TimeSlot = { start: string; end: string };

/**
 * A published Envisioning event this host is at, in the shared projection Core
 * serves to every scheduling surface. Only events that name the host arrive; a
 * day carrying one is closed to 1:1s and offers the event instead.
 */
type PublicEvent = {
  id: string;
  title: string;
  /** `YYYY-MM-DD` — the grid keys on this, so no timezone maths on the client. */
  date: string;
  starts_at: string | null;
  ends_at: string | null;
  is_all_day: boolean;
  location: string | null;
  signup_url: string | null;
  host: string | null;
};

function groupEventsByDate(events: PublicEvent[]): Record<string, PublicEvent[]> {
  const byDate: Record<string, PublicEvent[]> = {};
  for (const event of events) {
    if (typeof event?.date !== 'string') continue;
    (byDate[event.date] ??= []).push(event);
  }
  return byDate;
}

type ManagedBooking = {
  start_time: string;
  end_time: string;
  guest_name: string;
  status: 'confirmed' | 'cancelled';
  nda?: 'pending' | 'signed' | 'closed' | null;
};

type BookingResult = {
  id: string;
  start_time: string;
  end_time: string;
  guest_name: string;
  guest_email: string;
  nda_sent?: boolean;
};

function ymd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** Two from the start of the day, two from the end. */
const MAX_VISIBLE_SLOTS = 4;

function weekdayKey(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
}

function formatDayHeading(date: Date): string {
  return date.toLocaleDateString(dateLocale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

export function ScheduleScreen({
  room,
  identity,
  onBack,
  backLabel = t('Back'),
}: {
  room: string;
  /**
   * Set when the guest already identified themselves on Room entry. Absent on
   * the `/book/<slug>` deep link, where nobody has been asked yet — then the
   * booking form collects name and email itself rather than gating the
   * calendar behind a form the visitor did not ask for.
   */
  identity?: JoinIdentity;
  onBack: () => void;
  backLabel?: string;
}) {
  const detectedTimezone = useMemo(() => localTimeZone(), []);
  const [guestTimezone, setGuestTimezone] = useState(detectedTimezone);
  const [info, setInfo] = useState<MeetingInfo>();
  useDocumentTitle(info ? t('Book with {display_name}', { display_name: info.display_name }) : t('Book'));
  const [loadError, setLoadError] = useState('');
  const [dateAvailability, setDateAvailability] = useState<Record<string, boolean>>({});
  const [eventsByDate, setEventsByDate] = useState<Record<string, PublicEvent[]>>({});
  const [loadingCalendar, setLoadingCalendar] = useState(true);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<TimeSlot | null>(null);
  const [title, setTitle] = useState(() => readStored(StorageKeys.title));
  const [organization, setOrganization] = useState(() => readStored(StorageKeys.organization));
  const [notes, setNotes] = useState('');
  // `?nda=1`: a link that already asked for the NDA, as the contact page's does.
  const [requiresNda, setRequiresNda] = useState(() => new URLSearchParams(window.location.search).get('nda') === '1');
  // Only used when `identity` is absent; prefilled from the same store Room
  // entry writes, so a returning visitor rarely retypes either.
  const [guestName, setGuestName] = useState(() => readStored(StorageKeys.name));
  const [guestEmail, setGuestEmail] = useState(() => readStored(StorageKeys.email));
  const [booking, setBooking] = useState(false);
  const [bookError, setBookError] = useState('');
  const [confirmation, setConfirmation] = useState<BookingResult | null>(null);
  // `?manage=<token>`: the link in a booking's invite and join card. The page
  // shows that booking with Cancel, and booking a new time moves it.
  const manageToken = useMemo(() => {
    const token = new URLSearchParams(window.location.search).get('manage');
    return token && /^[A-Za-z0-9_-]{16,128}$/u.test(token) ? token : null;
  }, []);
  const [managed, setManaged] = useState<ManagedBooking | null>(null);
  const [manageError, setManageError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);

  const range = useMemo(() => {
    const start = startOfLocalDay(new Date());
    const end = addDays(start, 35);
    const days: Date[] = [];
    for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) days.push(cursor);
    return { start, end, days, startStr: ymd(start), endStr: ymd(end) };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await apiFetch<MeetingInfo>(`/schedule/${room}/info`, {
          fallbackError: t('Scheduling isn’t available for this room.'),
        });
        if (!cancelled) setInfo(body);
      } catch (reason) {
        if (!cancelled) {
          setLoadError(reason instanceof Error ? reason.message : t('Couldn’t load scheduling.'));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [room]);

  useEffect(() => {
    if (!info) return;
    let cancelled = false;
    setLoadingCalendar(true);
    void (async () => {
      try {
        const query = new URLSearchParams({
          startDate: range.startStr,
          endDate: range.endStr,
          timezone: guestTimezone,
        });
        // One request: Core closes public-event days *and* returns the events,
        // so the grid and the sidebar can never disagree about which is which.
        const body = await apiFetch<{
          dateAvailability?: Record<string, boolean>;
          events?: PublicEvent[];
        }>(
          `/schedule/${room}/availability-calendar?${query}`,
          { fallbackError: t('Couldn’t load available dates.') },
        );
        if (cancelled) return;
        setDateAvailability(body.dateAvailability ?? {});
        setEventsByDate(groupEventsByDate(body.events ?? []));
      } catch (reason) {
        if (!cancelled) {
          setLoadError(reason instanceof Error ? reason.message : t('Couldn’t load available dates.'));
        }
      } finally {
        if (!cancelled) setLoadingCalendar(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [info, room, guestTimezone, range.startStr, range.endStr]);

  useEffect(() => {
    if (!info || loadingCalendar || selectedDate) return;
    const first = range.days.find((day) => isDateBookable(day, info.working_hours, dateAvailability));
    if (first) setSelectedDate(first);
  }, [info, loadingCalendar, selectedDate, range.days, dateAvailability]);

  useEffect(() => {
    if (!selectedDate) {
      setSlots([]);
      return;
    }
    // An event day has no slots to ask for; Core would return an empty list
    // anyway, so skip the round trip and the "Loading times…" flash.
    if ((eventsByDate[ymd(selectedDate)] ?? []).length > 0) {
      setSlots([]);
      setSelectedSlot(null);
      setLoadingSlots(false);
      return;
    }
    let cancelled = false;
    setLoadingSlots(true);
    setSelectedSlot(null);
    void (async () => {
      try {
        const query = new URLSearchParams({
          date: ymd(selectedDate),
          timezone: guestTimezone,
        });
        const body = await apiFetch<{ slots?: TimeSlot[] }>(`/schedule/${room}/availability?${query}`, {
          fallbackError: t('Couldn’t load times for that day.'),
        });
        if (!cancelled) setSlots(body.slots ?? []);
      } catch (reason) {
        if (!cancelled) {
          setSlots([]);
          setBookError(reason instanceof Error ? reason.message : t('Couldn’t load times.'));
        }
      } finally {
        if (!cancelled) setLoadingSlots(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedDate, guestTimezone, room, eventsByDate]);

  /**
   * At most four times a day: the first two and the last two. Offering every
   * half-hour turned the panel into a wall of near-identical buttons.
   *
   * Deliberate trade-off: mid-day times are not reachable from this screen.
   */
  const displayedSlots = useMemo(
    () => (slots.length <= MAX_VISIBLE_SLOTS
      ? slots
      : [...slots.slice(0, 2), ...slots.slice(-2)]),
    [slots],
  );

  const selectedDayEvents = selectedDate ? eventsByDate[ymd(selectedDate)] ?? [] : [];

  const bookingName = (identity?.name ?? guestName).trim();
  const bookingEmail = (identity?.email ?? guestEmail).trim();
  const canSubmitBooking = Boolean(
    selectedSlot
    && hasValidGuestIdentity(bookingName, bookingEmail)
    && title.trim()
    && organization.trim()
    && notes.trim()
  );

  useEffect(() => {
    if (!manageToken) return;
    let cancelledRequest = false;
    apiFetch<{ booking: ManagedBooking }>(`/schedule/${room}/booking/${manageToken}`, {
      fallbackError: t('This booking link is not valid.'),
      noStore: true,
    })
      .then((body) => { if (!cancelledRequest) setManaged(body.booking); })
      .catch((reason: unknown) => {
        if (!cancelledRequest) setManageError(reason instanceof Error ? reason.message : t('This booking link is not valid.'));
      });
    return () => { cancelledRequest = true; };
  }, [manageToken, room]);

  async function cancelManaged() {
    if (!manageToken) return;
    setCancelling(true);
    setManageError('');
    try {
      await apiFetch<{ ok: true }>(`/schedule/${room}/booking/${manageToken}/cancel`, {
        method: 'POST',
        body: {},
        fallbackError: t('Couldn’t cancel the booking.'),
      });
      setCancelled(true);
    } catch (reason) {
      setManageError(reason instanceof Error ? reason.message : t('Couldn’t cancel the booking.'));
    } finally {
      setCancelling(false);
    }
  }

  const moving = Boolean(manageToken && managed?.status === 'confirmed');

  async function submitBooking(event: FormEvent) {
    event.preventDefault();
    if (!selectedSlot || !title.trim() || !organization.trim() || !notes.trim()) return;
    if (!bookingName || !bookingEmail) return;
    setBooking(true);
    setBookError('');
    try {
      writeStored(StorageKeys.title, title.trim());
      writeStored(StorageKeys.organization, organization.trim());
      if (!identity) {
        writeStored(StorageKeys.name, bookingName);
        writeStored(StorageKeys.email, bookingEmail);
      }
      const body = await apiFetch<{ booking?: BookingResult }>(`/schedule/${room}/book`, {
        body: await withTurnstileToken('book', {
          guest_name: bookingName,
          guest_email: bookingEmail,
          guest_title: title.trim(),
          guest_organization: organization.trim(),
          guest_notes: notes.trim(),
          start_time: selectedSlot.start,
          // The zone they picked the slot in, so Core's confirmation email
          // quotes the same hour they just clicked.
          guest_timezone: guestTimezone,
          // A move keeps the first booking's NDA; the Worker carries it.
          requires_nda: Boolean(info?.nda && requiresNda && !moving),
          // A move: the Worker cancels the old booking once the new one stands.
          ...(moving ? { reschedule_token: manageToken } : {}),
        }),
        fallbackError: t('Couldn’t book that time.'),
      });
      if (!body.booking) throw new Error(t('Booking succeeded without a confirmation payload.'));
      setConfirmation(body.booking);
    } catch (reason) {
      setBookError(reason instanceof Error ? reason.message : t('Couldn’t book that time.'));
    } finally {
      setBooking(false);
    }
  }

  if (confirmation) {
    return (
      <AppShell variant="centered" roomSlug={room}>
        <GuestCard size="status">
          <h1>{t('You’re on the calendar')}</h1>
          <p className="lede">
            {formatRange(confirmation.start_time, confirmation.end_time, guestTimezone)}
          </p>
          <p className="lede">
            {t('A calendar invite goes to {email}. Join later from this same link.', { email: confirmation.guest_email })}
          </p>
          {confirmation.nda_sent === true && (
            <p className="lede">{t('The NDA goes to {email} to sign.', { email: confirmation.guest_email })}</p>
          )}
          {confirmation.nda_sent === false && (
            <p className="lede">{t('The NDA didn’t send. Reply to the invite to get it.')}</p>
          )}
          <Button type="button" onClick={onBack}>
            {backLabel}
          </Button>
        </GuestCard>
      </AppShell>
    );
  }

  if (cancelled) {
    return (
      <AppShell variant="centered" roomSlug={room}>
        <GuestCard size="status">
          <h1>{t('Booking cancelled')}</h1>
          <p className="lede">{t('The calendar invite is withdrawn. You can book a new time from this page.')}</p>
          <Button type="button" onClick={onBack}>
            {backLabel}
          </Button>
        </GuestCard>
      </AppShell>
    );
  }

  if (loadError && !info) {
    return (
      <AppShell variant="centered" roomSlug={room}>
        <GuestCard size="status">
          <h1>{t('Unavailable')}</h1>
          <ErrorNotice message={loadError} />
          <Button variant="secondary" type="button" onClick={onBack}>
            {t('Back')}
          </Button>
        </GuestCard>
      </AppShell>
    );
  }

  return (
    <AppShell variant="wide" roomSlug={room}>
      <GuestCard size="wide">
        {/* No glyph here — the site header already carries the brand, and the
            booking screen is wide enough that repeating it just eats the row. */}
        {/* Title on the left, timezone on the right and centred against it:
            the picker scopes every time on the screen, so it belongs with the
            heading rather than on top of the slot list. */}
        <header className="mb-7 flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
          <div className="min-w-0 flex-[1_1_20rem]">
            {/* One return affordance, always in the same place, always the same
                word: back goes up one step in the guest flow — to Room entry
                when that is where we came from, to the room itself on a
                `/book/<slug>` deep link that had no previous step. Lateral
                moves ("Change", "Register") stay inline where they apply. */}
            <BackButton label={backLabel} onClick={onBack} />
            {info
              ? <h1 className="mt-1! mb-2! text-[28px]! leading-[1.2]!">{t('Book {duration_minutes} min with {display_name}', { duration_minutes: info.duration_minutes, display_name: info.display_name })}</h1>
              : <PlaceholderBar label={t('Loading availability…')} className="mt-1 mb-2 h-8 w-72 max-w-full" />}
            {manageToken && (
              <div className="mb-3 grid gap-2 rounded-xl border bg-muted p-3 text-[13px]">
                {managed?.status === 'confirmed' ? (
                  <>
                    <p className="m-0">
                      {t('Your booking: {range}. Pick a new time below to move it, or cancel it.', {
                        range: formatRange(managed.start_time, managed.end_time, guestTimezone),
                      })}
                    </p>
                    {managed.nda === 'pending' && <p className="m-0">{t('The NDA is waiting for your signature in your email.')}</p>}
                    {managed.nda === 'signed' && <p className="m-0">{t('NDA signed.')}</p>}
                    <div>
                      <Button type="button" variant="secondary" disabled={cancelling} onClick={() => { void cancelManaged(); }}>
                        {cancelling && <Spinner aria-hidden />}
                        {t('Cancel booking')}
                      </Button>
                    </div>
                  </>
                ) : managed?.status === 'cancelled' ? (
                  <p className="m-0">{t('This booking is already cancelled. You can book a new time below.')}</p>
                ) : manageError ? null : (
                  <PlaceholderBar label={t('Loading your booking…')} className="h-4 w-64 max-w-full" />
                )}
                {manageError && <ErrorNotice message={manageError} />}
              </div>
            )}
            <p className="lede">
              {identity ? (
                <>
                  {t('Booking as {name} ({email}).', { name: identity.name, email: identity.email })}
                  {' '}
                  <Button type="button" variant="link" className="h-auto p-0 text-foreground" onClick={onBack}>{t('Change')}</Button>
                </>
              ) : (
                t('Pick a time, then tell us who you are.')
              )}
            </p>
          </div>
          {/* Belongs with the title, not the slot list: it scopes every time on
              the screen — the grid's days as much as the sidebar's hours. */}
          <Label className="grid w-[min(100%,17rem)] flex-none gap-2 text-[13px] text-muted-foreground font-normal leading-normal items-stretch">
            {t('Times shown in')}
            <NativeSelect
              value={guestTimezone}
              onChange={(event) => setGuestTimezone(event.target.value)}
            >
              <NativeSelectOption value={detectedTimezone}>{t('{timezone} (local)', { timezone: detectedTimezone })}</NativeSelectOption>
              {info?.timezone && info.timezone !== detectedTimezone ? (
                <NativeSelectOption value={info.timezone}>{t('{timezone} (host)', { timezone: info.timezone })}</NativeSelectOption>
              ) : null}
              {TIMEZONE_PRESETS.filter(
                (zone) => zone.id !== detectedTimezone && zone.id !== info?.timezone,
              ).map((zone) => (
                <NativeSelectOption key={zone.id} value={zone.id}>{zone.label}</NativeSelectOption>
              ))}
            </NativeSelect>
          </Label>
        </header>

        <div className="grid gap-7 min-[840px]:grid-cols-[1.1fr_0.9fr] min-[840px]:items-start">
          <div>
            <div className="mb-3 text-[13px] text-muted-foreground">
              {range.start.toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' })}
              {' – '}
              {range.end.toLocaleDateString(dateLocale, { month: 'short', day: 'numeric', year: 'numeric' })}
            </div>
            {/* Every day would read closed until availability arrives, so show
                a pending state rather than a fully booked month. */}
            {!info || loadingCalendar ? (
              <MonthLoading />
            ) : (
              <Suspense fallback={<MonthLoading />}>
                <BookingMonth
                  start={range.start}
                  end={range.end}
                  selected={selectedDate}
                  onSelect={setSelectedDate}
                  isOpen={(day) => isDateBookable(day, info.working_hours, dateAvailability)}
                  hasEvent={(day) => (eventsByDate[ymd(day)] ?? []).length > 0}
                  showLegend={Object.keys(eventsByDate).length > 0}
                />
              </Suspense>
            )}
          </div>

          <div>
            {/* Until the availability fetch lands there is no selected date
                *yet* — which is not the same as there being none. Saying so
                early made every load flash "no available dates". */}
            {!info || loadingCalendar ? (
              <PlaceholderRows glyph={false} label={t('Loading availability…')} />
            ) : !selectedDate ? (
              <p className="lede">{t('No available dates in this period.')}</p>
            ) : selectedDayEvents.length > 0 ? (
              // The day is closed to 1:1s because something else is on. The
              // event cards standing where the slot list would be say that on
              // their own — no sentence needed to explain the absence.
              <>
                <h2 className={SIDE_HEADING}>{formatDayHeading(selectedDate)}</h2>
                <div className="grid gap-3">
                  {selectedDayEvents.map((event) => (
                    <PublicEventCard key={event.id} event={event} timeZone={guestTimezone} />
                  ))}
                </div>
              </>
            ) : loadingSlots ? (
              <PlaceholderRows count={4} glyph={false} label={t('Loading times…')} />
            ) : !selectedSlot ? (
              <>
                <h2 className={SIDE_HEADING}>{formatDayHeading(selectedDate)}</h2>
                {displayedSlots.length === 0 ? (
                  <p className="lede">{t('No available times for this day.')}</p>
                ) : (
                  <div className="grid max-h-[360px] gap-2 overflow-auto">
                    {displayedSlots.map((slot) => (
                      <Button
                        key={slot.start}
                        type="button"
                        variant="outline"
                        className="h-10 justify-start"
                        onClick={() => setSelectedSlot(slot)}
                      >
                        {formatSlotTime(slot.start, guestTimezone)}
                      </Button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <form className="grid gap-3.5" onSubmit={submitBooking}>
                <p className="lede">
                  {formatRange(selectedSlot.start, selectedSlot.end, guestTimezone)}
                  {' '}
                  <Button type="button" variant="link" className="h-auto p-0 text-foreground" onClick={() => setSelectedSlot(null)}>
                    {t('Change time')}
                  </Button>
                </p>
                {!identity && (
                  <>
                    <GuestField>
                      {t('Your name')}
                      <Input
                        required
                        value={guestName}
                        onChange={(event) => setGuestName(event.target.value)}
                        placeholder={t('Name')}
                      />
                    </GuestField>
                    <GuestField>
                      {t('Email')}
                      <Input
                        required
                        type="email"
                        value={guestEmail}
                        onChange={(event) => setGuestEmail(event.target.value)}
                        placeholder={t('Email')}
                      />
                    </GuestField>
                  </>
                )}
                <GuestField>
                  {t('Your title')}
                  <Input
                    required
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder={t('e.g. Product lead')}
                  />
                </GuestField>
                <GuestField>
                  {t('Organization')}
                  <Input
                    required
                    value={organization}
                    onChange={(event) => setOrganization(event.target.value)}
                    placeholder={t('Company or team')}
                  />
                </GuestField>
                <GuestField>
                  {t('Notes')}
                  <Textarea
                    required
                    rows={3}
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder={t('What should we cover?')}
                  />
                </GuestField>
                {info?.nda && !moving && (
                  <Suspense fallback={null}>
                    <NdaCheckbox checked={requiresNda} onChange={setRequiresNda} />
                  </Suspense>
                )}
                {bookError && <ErrorNotice message={bookError} />}
                <Button type="submit" disabled={booking || !canSubmitBooking}>
                  {booking && <Spinner aria-hidden />}
                  {booking ? t('Booking…') : t('Confirm booking')}
                </Button>
              </form>
            )}
          </div>
        </div>
      </GuestCard>
    </AppShell>
  );
}

const SIDE_HEADING = 'mt-0 mb-3 text-[18px]';

/** The calendar area while availability or the calendar chunk loads. */
function MonthLoading() {
  return <PlaceholderBar label={t('Loading availability…')} className="h-[220px] w-full" />;
}

/**
 * One published event in the sidebar. The action is "register", not "join" —
 * these are Envisioning's public events, not Meet rooms: no lobby, no slug.
 */
function PublicEventCard({ event, timeZone }: { event: PublicEvent; timeZone: string }) {
  const when = event.is_all_day || !event.starts_at
    ? t('All day')
    : event.ends_at
      ? `${formatSlotTime(event.starts_at, timeZone)}–${formatSlotTime(event.ends_at, timeZone)}`
      : formatSlotTime(event.starts_at, timeZone);
  const where = [event.location, event.host && t('Hosted by {host}', { host: event.host })]
    .filter(Boolean)
    .join(' · ');

  return (
    <Card asChild className="gap-0 rounded-[10px] border-l-2 border-l-muted-foreground/55 bg-(--surface-sunken) p-3.5 shadow-none">
      <article>
        <h3 className="m-0 text-[15px] leading-[1.3] font-semibold wrap-anywhere">
          <WorkspaceMark size={12} className="mr-1 inline-flex align-[-1px] text-muted-foreground" />
          {event.title}
        </h3>
        <p className="mt-1 mb-0 text-[13px] leading-[1.4] text-muted-foreground">
          {when}
          {where && ` · ${where}`}
        </p>
        {event.signup_url && (
          <Button asChild variant="secondary"><a
            href={event.signup_url}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t('Register')}
          </a></Button>
        )}
      </article>
    </Card>
  );
}

function isDateBookable(
  date: Date,
  workingHours: WorkingHours,
  dateAvailability: Record<string, boolean>,
): boolean {
  // Event days are not bookable anyway, so the host's working hours and Core's
  // availability are the only gates needed.
  const day = workingHours[weekdayKey(date)];
  if (!day?.enabled) return false;
  return Boolean(dateAvailability[ymd(date)]);
}

/** The presets are the contract's (`SCHEDULE_TIME_ZONES`), the same ten cities as the Mac and iPhone. */
const TIMEZONE_PRESETS: { id: string; label: string }[] = workspaceTimeZones().map((zone) => ({ id: zone.zone, label: t(zone.city) }));
