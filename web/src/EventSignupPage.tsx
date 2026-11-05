import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { CalendarPlusIcon, VideoIcon } from 'lucide-react';
import type { EventRegistrationJoin, EventRegistrationResponse, SessionEvent } from '@starlings/contracts/event-signups';
import { buildSessionInvite, googleCalendarURL, outlookCalendarURL } from '@starlings/contracts/event-calendar';
import { PRODUCT_SITE_ORIGIN } from '@starlings/contracts/deployment';
import { Avatar, AvatarFallback, AvatarImage } from '@/ui/avatar';
import { Button } from '@/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import { Spinner } from '@/ui/spinner';
import { WorkspaceMark } from './action-icons';
import { apiFetch } from './api';
import { ControlRequestError } from './config';
import { DocumentMarkdown } from './document-markdown';
import { ErrorNotice } from './ErrorNotice';
import { StarlingsWordmark } from './GatheringDots';
import { GuestCard, GuestField } from './GuestCard';
import { dateLocale, plural, t } from './i18n';
import { formatRangeWithZone, formatTime, localTimeZone, timeZoneLabel, zoneOffsetSeconds } from './meeting-time';
import { AppShell } from './SiteChrome';
import { withTurnstileToken } from './turnstile';
import { useDocumentTitle } from './document-title';
import { workspaceBrand } from './workspace-brand';

type Load =
  | { kind: 'loading' }
  | { kind: 'missing' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; event: SessionEvent };

/** What the registration card shows after a sign-up (decision S9). */
type Signed =
  | { kind: 'new'; join: EventRegistrationJoin }
  | { kind: 'repeat' };

/** The zone the event is written in, when this browser knows it; else the visitor's. */
function eventZone(session: SessionEvent): string {
  const zone = session.time_zone;
  return zone && zoneOffsetSeconds(zone, new Date(session.starts_at)) !== null ? zone : localTimeZone();
}

/**
 * The When row's words: the day, the time in the event's zone, and the
 * visitor's time when their zone differs at the start.
 */
function sessionWhen(session: SessionEvent): { month: string; day: string; date: string; time: string; visitor: string | null } {
  const zone = eventZone(session);
  const start = new Date(session.starts_at);
  const end = new Date(session.ends_at);
  const visitorZone = localTimeZone();
  const label = timeZoneLabel(session.starts_at, zone);
  const differs = zoneOffsetSeconds(zone, start) !== zoneOffsetSeconds(visitorZone, start);
  return {
    month: start.toLocaleDateString(dateLocale, { timeZone: zone, month: 'short' }),
    day: start.toLocaleDateString(dateLocale, { timeZone: zone, day: 'numeric' }),
    date: start.toLocaleDateString(dateLocale, { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long' }),
    time: `${formatTime(start, { timeZone: zone })}–${formatTime(end, { timeZone: zone })}${label ? ` ${label}` : ''}`,
    visitor: differs ? formatRangeWithZone(session.starts_at, session.ends_at, visitorZone) : null,
  };
}

function initials(name: string): string {
  return name.split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => Array.from(part)[0]?.toUpperCase() ?? '').join('');
}

/** A row with a small tile on the left and one to three lines beside it. */
function DetailRow({ tile, children }: { tile: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex size-11 shrink-0 flex-col items-center justify-center overflow-hidden rounded-md border border-border bg-(--surface) text-muted-foreground">
        {tile}
      </div>
      <div className="min-w-0 text-[15px] leading-snug">{children}</div>
    </div>
  );
}

/** A section's label over a hairline: "Hosted by", "About". */
function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="m-0 mb-3 border-b border-border pb-2 text-sm font-medium text-muted-foreground">{children}</h2>;
}

/**
 * Add to calendar: Google, Outlook, and an `.ics` file. The browser builds all
 * three from the register answer with the one generator (`event-calendar`).
 * The file carries the registration's own `ics_uid`, so it is the same entry
 * as the mail's invite.
 */
function AddToCalendar({ session, join }: { session: SessionEvent; join: EventRegistrationJoin }) {
  const icsURL = useMemo(() => {
    const ics = buildSessionInvite({ uid: join.ics_uid, sequence: join.ics_sequence, method: 'PUBLISH', event: session, url: join.url });
    return URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  }, [session, join]);
  useEffect(() => () => URL.revokeObjectURL(icsURL), [icsURL]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" className="w-full">
          <CalendarPlusIcon aria-hidden />
          {t('Add to calendar')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-(--radix-dropdown-menu-trigger-width)">
        <DropdownMenuItem asChild>
          <a href={googleCalendarURL(session, join.url)} target="_blank" rel="noopener noreferrer">{t('Google Calendar')}</a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={outlookCalendarURL(session, join.url)} target="_blank" rel="noopener noreferrer">{t('Outlook')}</a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={icsURL} download="event.ics">{t('Download .ics file')}</a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * `/event/<slug>`: an event's page in the shape of a Luma event page
 * (docs/SESSIONS.md §0). Public, no sign-in. Desktop has
 * two columns, the left narrower: the cover, Hosted by and Going on the left;
 * the title, When, Where, the registration card and About on the right. A
 * phone has one column: cover, title, When, Where, registration, Hosted by,
 * Going, About. The site header names the workspace, so the page body does
 * not repeat it. The registration card holds the page's one accent button.
 */
export default function EventSignupPage({ slug }: { slug: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [signed, setSigned] = useState<Signed | null>(null);
  const [closed, setClosed] = useState(false);
  const [sendError, setSendError] = useState('');
  const brand = workspaceBrand();
  useDocumentTitle(load.kind === 'ready' ? load.event.title : t('Sign up'));

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<{ event: SessionEvent }>(`/events/${encodeURIComponent(slug)}`, {
      fallbackError: t('Couldn’t load this event.'),
      noStore: true,
      signal: controller.signal,
    }).then(
      (body) => setLoad({ kind: 'ready', event: body.event }),
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        if (reason instanceof ControlRequestError && reason.status === 404) setLoad({ kind: 'missing' });
        else setLoad({ kind: 'failed', message: reason instanceof Error ? reason.message : t('Couldn’t load this event.') });
      },
    );
    return () => controller.abort();
  }, [slug]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setSendError('');
    try {
      const answer = await apiFetch<EventRegistrationResponse>(`/events/${encodeURIComponent(slug)}/register`, {
        method: 'POST',
        body: await withTurnstileToken('event_signup', { name: name.trim(), email: email.trim() }),
        fallbackError: t('Couldn’t sign you up. Try again.'),
      });
      setSigned(answer.join ? { kind: 'new', join: answer.join } : { kind: 'repeat' });
    } catch (reason) {
      if (reason instanceof ControlRequestError && reason.status === 409) setClosed(true);
      else setSendError(reason instanceof Error ? reason.message : t('Couldn’t sign you up. Try again.'));
    } finally {
      setSending(false);
    }
  }

  // The workspace hosts the event; Starlings is where it happens.
  const hostedOn = (
    <p className="m-0 flex items-center gap-1.5 text-sm text-muted-foreground">
      {t('Hosted on')}
      <a href={PRODUCT_SITE_ORIGIN} className="text-foreground no-underline hover:underline">
        <StarlingsWordmark motion="still" />
      </a>
    </p>
  );

  if (load.kind === 'loading') {
    return (
      <AppShell variant="centered">
        <GuestCard size="status">
          <Spinner aria-label={t('Loading…')} />
        </GuestCard>
      </AppShell>
    );
  }

  if (load.kind === 'missing' || load.kind === 'failed') {
    return (
      <AppShell variant="centered">
        <GuestCard size="status">
          {load.kind === 'missing'
            ? <h1 className="mt-0 mb-6">{t('No event here.')}</h1>
            : <div className="mb-6"><ErrorNotice message={load.message} /></div>}
          {hostedOn}
        </GuestCard>
      </AppShell>
    );
  }

  const session = load.event;
  const isClosed = closed || !session.open;
  const when = sessionWhen(session);

  const registration = (
    <GuestCard size="form" className="w-full p-6 max-sm:px-5 max-sm:py-6">
      {signed?.kind === 'new' ? (
        <div className="grid gap-3" role="status">
          <h2 className="m-0 text-lg font-semibold">{t('You’re in')}</h2>
          <Button asChild>
            <a href={signed.join.url}>{t('Join with your link')}</a>
          </Button>
          <AddToCalendar session={session} join={signed.join} />
          <p className="m-0 text-sm text-muted-foreground">{t('Check your email too.')}</p>
        </div>
      ) : signed?.kind === 'repeat' ? (
        <p className="m-0 text-base" role="status">{t('Check your email for your link.')}</p>
      ) : isClosed ? (
        <p className="m-0 text-base">{t('Sign-up is closed.')}</p>
      ) : (
        <form className="grid gap-3.5" onSubmit={(formEvent) => { void submit(formEvent); }}>
          <h2 className="m-0 text-lg font-semibold">{t('Registration')}</h2>
          <GuestField>
            {t('Your name')}
            <Input required autoComplete="name" maxLength={160} value={name} onChange={(change) => setName(change.target.value)} />
          </GuestField>
          <GuestField>
            {t('Email')}
            <Input required type="email" autoComplete="email" maxLength={254} value={email} onChange={(change) => setEmail(change.target.value)} />
          </GuestField>
          {sendError && <ErrorNotice message={sendError} />}
          <Button type="submit" disabled={sending || !name.trim() || !email.trim()}>
            {sending && <Spinner aria-hidden />}
            {sending ? t('Signing up…') : t('Sign up')}
          </Button>
          {session.spots_left !== null && (
            <p className="m-0 text-sm text-muted-foreground">
              {plural(session.spots_left, { one: '{count} spot left', other: '{count} spots left' })}
            </p>
          )}
        </form>
      )}
    </GuestCard>
  );

  // One list of blocks. On a phone both columns are `contents` and `order`
  // sets the one-column sequence; from `md` each column is its own stack.
  return (
    <AppShell variant="wide">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-6 md:grid md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:items-start md:gap-10">
        <div className="contents md:flex md:flex-col md:gap-6">
          <div className="order-1 md:order-none">
            {session.image_url ? (
              <img src={session.image_url} alt="" className="block aspect-square w-full rounded-xl object-cover" />
            ) : (
              <div className="flex aspect-square w-full items-center justify-center rounded-xl bg-(--surface) text-muted-foreground">
                <WorkspaceMark size={72} brand={brand} />
              </div>
            )}
          </div>
          {session.host && (
            <section className="order-6 md:order-none">
              <SectionLabel>{t('Hosted by')}</SectionLabel>
              <div className="flex items-center gap-2.5 text-[15px] font-medium">
                <Avatar>
                  {session.host.image_url && <AvatarImage src={session.host.image_url} alt="" />}
                  <AvatarFallback>{initials(session.host.name)}</AvatarFallback>
                </Avatar>
                {session.host.name}
              </div>
            </section>
          )}
          {session.going !== null && (
            <p className="order-7 m-0 text-sm text-muted-foreground md:order-none">
              {plural(session.going, { one: '{count} going', other: '{count} going' })}
            </p>
          )}
        </div>
        <div className="contents md:flex md:flex-col md:gap-6">
          <h1 className="order-2 m-0 text-[clamp(28px,4.5vw,40px)] leading-tight font-semibold md:order-none">{session.title}</h1>
          <div className="order-3 md:order-none">
            <DetailRow
              tile={(
                <>
                  <span className="text-[10px] leading-none font-medium uppercase">{when.month}</span>
                  <span className="text-base leading-tight font-semibold text-foreground">{when.day}</span>
                </>
              )}
            >
              <span className="block font-medium">{when.date}</span>
              <span className="block text-muted-foreground">{when.time}</span>
              {when.visitor && <span className="block text-muted-foreground">{t('Your time: {time}', { time: when.visitor })}</span>}
            </DetailRow>
          </div>
          <div className="order-4 md:order-none">
            <DetailRow tile={<VideoIcon className="size-5" aria-hidden />}>
              <span className="block font-medium">
                {t('Online')}
                <span className="font-normal text-muted-foreground"> · {t('{minutes} min', { minutes: session.duration_minutes })}</span>
              </span>
              <span className="block text-muted-foreground">{t('Join from your browser')}</span>
            </DetailRow>
          </div>
          <div className="order-5 md:order-none">{registration}</div>
          {(session.description || session.body) && (
            <section className="order-8 md:order-none">
              <SectionLabel>{t('About')}</SectionLabel>
              {session.description && <p className="mt-0 mb-4 text-[15px] leading-normal whitespace-pre-line">{session.description}</p>}
              {session.body && <DocumentMarkdown text={session.body} />}
            </section>
          )}
          <div className="order-9 md:order-none">{hostedOn}</div>
        </div>
      </div>
    </AppShell>
  );
}
