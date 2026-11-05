import { IOS_DOWNLOAD_URL, MAC_DOWNLOAD_URL, PRODUCT_SITE_ORIGIN } from '@starlings/contracts/deployment';
import { consumePeerCall, fetchPeers } from './team-presence';
import { Input } from '@/ui/input';
import { Card } from '@/ui/card';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import {
  Component,
  type ComponentType,
  FormEvent,
  Fragment,
  lazy,
  ReactNode,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  GuestPresenceStage,
  JoinRequestReceipt,
  JoinStatusResponse,
  LobbyStatusValue,
} from '@starlings/contracts';
import { LOBBY_POLL_SECONDS, LOBBY_SOCKET_POLL_SECONDS } from '@starlings/contracts/limits';
import type { StarlingsMintedBookingProjection } from '@starlings/contracts/calendar';
import { isMeetMintedBookingProjection, isPublicRoomResponse } from '@starlings/contracts/room-entry-values';
import { isProductSitePath, parsePublicEventPath } from '@starlings/contracts/paths';
import { parsePermalinkPath } from '@starlings/contracts/permalinks';
import type { MeetingDisconnect } from './MeetingExperience';
import { apiFetch } from './api';
import {
  apiBase,
  bookPathFromLocation,
  canonicalRoomPath,
  ControlRequestError,
  roomPathFromLocation,
  type RoomPathParts,
} from './config';
import { formatMeetingDuration } from './meeting-duration';
import { recordMeetError } from './meeting-error-log';
import { formatRangeWithZone, hasEnded, localTimeZone, timeUntilMeeting } from './meeting-time';
import { hasValidGuestIdentity } from './meeting-types';
import type { ConnectionDetails, JoinIdentity, LocalUserChoices } from './meeting-types';
import {
  clearGuestLobbySession,
  identityFromSession,
  mediaChoicesForResume,
  readGuestLobbySession,
  receiptFromSession,
  writeGuestLobbySession,
} from './guest-lobby-session';
import { guestClient } from './guest-client';
import { clearPresenceId, useGuestPresence } from './guest-presence';
import { withTurnstileToken } from './turnstile';
import { readStored, StorageKeys, writeStored } from './storage';
import { checkBrowserSupport } from './browser-support';
import { buildBookingIcs, icsFileName } from './booking-ics';
import { useOwnerSession, wasMember } from './owner-session';
import { useOwnerHeartbeat } from './use-owner-heartbeat';
import { ScheduleScreen } from './ScheduleScreen';
import { LoadingIndicator } from '@/ui/spinner';
import { AppShell, ChromeFrame, MemberLoadingShell } from './SiteChrome';
import { configureRoutes, usePageKey } from './navigation';
import { track, trackPageview } from './analytics';
import { EnvisioningSignInButton } from './EnvisioningSignInButton';
import { HomeTile, HomeTileGrid } from './HomeTile';
import { SignedOutDoor } from './SignedOutDoor';
import { GatheringDots } from './GatheringDots';
import { ORG_WEB_ORIGIN } from '@starlings/contracts/deployment';
import {
  CalendarIcon,
  DesktopIcon,
  PhoneIcon,
  VideoIcon,
  WarningIcon,
} from './action-icons';
import { ErrorNotice } from './ErrorNotice';
import { VISITOR_HOME_DEFAULT, type VisitorHomeResponse } from '@starlings/contracts/visitor-home';
import { GuestCard, GuestField, GuestLede } from './GuestCard';
import { useDocumentTitle } from './document-title';
import { t } from './i18n';
import { isEnvisioningWorkspace, workspaceBrand } from './workspace-brand';
import { tx } from './i18n/tx';
// A guest opening an invite loads the meeting and nothing else: every
// workspace page is its own chunk, fetched when its route is chosen
//, or earlier, when a link to it is hovered (navigation.ts).
//
// `page()` is `lazy()` that can also be fetched ahead. Once its chunk is in,
// it draws the page directly instead of through `lazy`, which would suspend
// for a microtask even on a module it already has. That is what lets a
// navigation swap pages in one frame, with the header standing still.
type PageModule<P> = { default: ComponentType<P> };
function page<P extends object>(load: () => Promise<PageModule<P>>) {
  let loaded: ComponentType<P> | undefined;
  let loading: Promise<PageModule<P>> | undefined;
  const preload = () => {
    loading ??= load().then(
      (module) => { loaded = module.default; return module; },
      (cause) => { loading = undefined; throw cause; },
    );
    return loading;
  };
  const Lazy = lazy(preload);
  function Page(props: P) {
    const Loaded = loaded;
    return Loaded ? <Loaded {...props} /> : <Lazy {...props} />;
  }
  return Object.assign(Page, { preload });
}

const AdminPage = page(async () => ({ default: (await import('./AdminPage')).AdminPage }));
const AdminRecordsPage = page(async () => ({ default: (await import('./AdminRecordsPage')).AdminRecordsPage }));
const AdminActivityPage = page(async () => ({ default: (await import('./AdminActivityPage')).AdminActivityPage }));
const SettingsPage = page(async () => ({ default: (await import('./SettingsPage')).SettingsPage }));
const ConnectPage = page(async () => ({ default: (await import('./ConnectPage')).ConnectPage }));
const SavePage = page(async () => ({ default: (await import('./SavePage')).SavePage }));
const TeamPage = page(async () => ({ default: (await import('./TeamPage')).TeamPage }));
const CalendarPage = page(async () => ({ default: (await import('./CalendarPage')).CalendarPage }));
const WorkPage = page(async () => ({ default: (await import('./WorkPage')).WorkPage }));
const OfferEditorPage = page(async () => ({ default: (await import('./OfferEditorPage')).OfferEditorPage }));
const CatalogPage = page(async () => ({ default: (await import('./CatalogPage')).CatalogPage }));
const DocsPage = page(async () => ({ default: (await import('./DocsPage')).DocsPage }));
const MeetingsPage = page(async () => ({ default: (await import('./MeetingsPage')).MeetingsPage }));
const GranolaConnectorPage = page(async () => ({ default: (await import('./GranolaConnectorPage')).GranolaConnectorPage }));
const GithubConnectorPage = page(async () => ({ default: (await import('./GithubConnectorPage')).GithubConnectorPage }));
const SlackConnectorPage = page(async () => ({ default: (await import('./SlackConnectorPage')).SlackConnectorPage }));
const TranscriptPage = page(async () => ({ default: (await import('./TranscriptPage')).TranscriptPage }));
const OwnerWebHome = page(async () => ({ default: (await import('./OwnerWebHome')).OwnerWebHome }));
const GuestPage = page(async () => ({ default: (await import('./GuestPage')).GuestPage }));
const SupportPage = page(async () => ({ default: (await import('./SupportPage')).SupportPage }));
// An event's sign-up page (docs/SESSIONS.md §0): public, its own chunk.
const EventSignupPage = page(async () => import('./EventSignupPage'));

const Prejoin = lazy(async () => ({
  default: (await import('./MeetingExperience')).Prejoin,
}));
const ConnectedMeeting = lazy(async () => ({
  default: (await import('./MeetingExperience')).ConnectedMeeting,
}));

type LobbyReceipt = JoinRequestReceipt;
type LobbyStatus = LobbyStatusValue;

/**
 * What an invite token resolves to. `scheduled` is the only state that puts a
 * title on the join card; `expired` covers a cancelled booking, a token the
 * control plane does not know, and a window that has already closed. A token
 * we could not resolve at all stays `undefined` — the guest gets the same
 * opaque door as the bare slug rather than a wrong story about their invite.
 * See docs/ROOM_ENTRY.md.
 */
type BookingCard =
  | {
    state: 'scheduled';
    title: string | null;
    /** What the guest wrote in "what should we cover?" when they booked. */
    subject: string | null;
    startsAt: string | null;
    endsAt: string | null;
    /** Core's own pages — Meet links out rather than reimplementing either. */
    rescheduleUrl: string | null;
    cancelUrl: string | null;
    /** The holder's own identity, when the host named them at mint. */
    guestName: string | null;
    guestEmail: string | null;
    /** A registration for an event sign-up: the join starts muted (docs/SESSIONS.md §8). */
    session: boolean;
  }
  | { state: 'expired' };

function trimmedOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bookingCardFrom(body: StarlingsMintedBookingProjection): BookingCard {
  if (body.status !== 'scheduled') return { state: 'expired' };
  const endsAt = body.ends_at;
  // A booking whose window has closed reads as expired even though the row is
  // still confirmed — the host may well be live, but with someone else.
  if (hasEnded(endsAt)) return { state: 'expired' };
  return {
    state: 'scheduled',
    title: trimmedOrNull(body.title),
    subject: trimmedOrNull(body.subject),
    startsAt: body.starts_at,
    endsAt,
    rescheduleUrl: trimmedOrNull(body.reschedule_url),
    cancelUrl: trimmedOrNull(body.cancel_url),
    guestName: trimmedOrNull(body.guest_name),
    guestEmail: trimmedOrNull(body.guest_email),
    session: body.session === true,
  };
}

function metaPage(pathname: string = window.location.pathname) {
  // The product site: one path each, from the same contract the Worker
  // serves the shell for and the ProductNav draws. `/workspace/status` is the
  // one child.
  if (isProductSitePath(pathname)) {
    const path = pathname.replace(/\/$/u, '').toLowerCase();
    if (path === '/workspace/status') return 'features-status' as const;
    if (path === '/workspace/capabilities') return 'features-capabilities' as const;
    return path.slice(1) as 'why' | 'features' | 'pricing' | 'changelog' | 'interest' | 'privacy' | 'terms';
  }
  if (/^\/help(\/[a-z0-9/-]+)?\/?$/i.test(pathname)) return 'help' as const;
  if (/^\/support\/?$/i.test(pathname)) return 'support' as const;
  // Admin is destinations by verb (docs/ADMIN.md §10): Operations, Agents,
  // People, Connectors (with a page per source), Records, Activity, Jobs. `/admin/org` and
  // `/connectors*` are the old addresses — see `movedAdminPath`.
  if (/^\/admin\/agents\/?$/i.test(pathname)) return 'admin-agents' as const;
  if (/^\/admin\/people\/?$/i.test(pathname)) return 'admin-people' as const;
  if (/^\/admin\/operations\/?$/i.test(pathname)) return 'admin-operations' as const;
  if (/^\/admin\/connectors\/?$/i.test(pathname)) return 'admin-connectors' as const;
  if (/^\/admin\/connectors\/granola\/?$/i.test(pathname)) return 'connector-granola' as const;
  if (/^\/admin\/connectors\/github\/?$/i.test(pathname)) return 'connector-github' as const;
  if (/^\/admin\/connectors\/slack\/?$/i.test(pathname)) return 'connector-slack' as const;
  if (/^\/admin\/records\/?$/i.test(pathname)) return 'admin-records' as const;
  if (/^\/admin\/activity\/?$/i.test(pathname)) return 'admin-activity' as const;
  if (/^\/admin\/jobs\/?$/i.test(pathname)) return 'admin-jobs' as const;
  if (/^\/admin\/?$/i.test(pathname)) return 'admin' as const;
  if (/^\/team\/?$/i.test(pathname)) return 'team' as const;
  // A record's permalink is drawn by its surface's page.
  const record = parsePermalinkPath(pathname);
  if (record) return record.surface;
  // `/agents` remains a compatibility door, but Agents is a section of Team,
  // not a second workspace destination.
  if (/^\/agents\/?$/i.test(pathname)) return 'team' as const;
  if (/^\/join\/?$/i.test(pathname)) return 'join' as const;
  if (/^\/calendar\/?$/i.test(pathname)) return 'calendar' as const;
  if (/^\/work\/offers\/[0-9a-f-]{36}\/?$/i.test(pathname)) return 'work-offer' as const;
  if (/^\/work\/catalog\/?$/i.test(pathname)) return 'work-catalog' as const;
  // Signals is a filter on licences and leads, and its old address opens Browse with the filter.
  if (/^\/work(\/(mine|internal|envisioning|projects|leads|partners|browse|licenses|signals))?\/?$/i.test(pathname)) return 'work' as const;
  if (/^\/docs\/?$/i.test(pathname)) return 'docs' as const;
  // Meetings: what the Mac recorded, and filing.
  if (/^\/meetings\/?$/i.test(pathname)) return 'meetings' as const;
  if (/^\/meetings\/[a-z0-9-]{2,40}\/[0-9a-f-]{36}\/?$/i.test(pathname)) return 'transcript' as const;
  if (/^\/settings\/?$/i.test(pathname)) return 'settings' as const;
  if (/^\/connect\/?$/i.test(pathname)) return 'connect' as const;
  if (/^\/save\/?$/i.test(pathname)) return 'save' as const;
  return null;
}

/**
 * Where an Admin address that no longer exists went. `/connectors` joined Admin
 * as its third section and `/admin/org` folded into it (docs/ADMIN.md §10);
 * old links and bookmarks land on the new page rather than a door.
 */
function movedAdminPath(pathname: string): string | null {
  if (/^\/admin\/org\/?$/i.test(pathname)) return '/admin/connectors';
  const connector = /^\/connectors(\/(granola|github|slack))?\/?$/i.exec(pathname);
  if (connector) return `/admin/connectors${(connector[1] ?? '').toLowerCase()}`;
  return null;
}

const ROUTE_PAGES_WITH_LOADING_STATE = new Set([
  'admin',
  'admin-agents',
  'admin-people',
  'admin-operations',
  'admin-connectors',
  'admin-records',
  'admin-activity',
  'admin-jobs',
  'team',
  'calendar',
  'work',
  'work-offer',
  'work-catalog',
  'docs',
  'meetings',
  'transcript',
  'settings',
  'connect',
  'save',
  'connector-granola',
  'connector-github',
  'connector-slack',
]);

const publicPagePreload = async () => {};

function PublicSiteRedirect({ workspace = false }: { workspace?: boolean }) {
  const target = `${workspace ? '/privacy' : `${PRODUCT_SITE_ORIGIN}${window.location.pathname}`}${window.location.search}${window.location.hash}`;
  useEffect(() => {
    window.location.replace(target);
  }, [target]);
  return <p><a href={target}>{t('Open the Starlings site')}</a></p>;
}

/** Each page's code, by route, for `preloadPath` and the click that follows it. */
const PAGE_PRELOAD: Record<NonNullable<ReturnType<typeof metaPage>>, () => Promise<unknown>> = {
  privacy: publicPagePreload,
  terms: publicPagePreload,
  features: publicPagePreload,
  why: publicPagePreload,
  'features-status': publicPagePreload,
  'features-capabilities': publicPagePreload,
  interest: publicPagePreload,
  pricing: publicPagePreload,
  changelog: publicPagePreload,
  help: publicPagePreload,
  support: SupportPage.preload,
  admin: AdminPage.preload,
  'admin-agents': AdminPage.preload,
  'admin-people': AdminPage.preload,
  'admin-operations': AdminPage.preload,
  'admin-connectors': AdminPage.preload,
  'admin-records': AdminRecordsPage.preload,
  'admin-activity': AdminActivityPage.preload,
  'admin-jobs': AdminPage.preload,
  settings: SettingsPage.preload,
  connect: ConnectPage.preload,
  save: SavePage.preload,
  team: TeamPage.preload,
  calendar: CalendarPage.preload,
  work: WorkPage.preload,
  'work-offer': OfferEditorPage.preload,
  'work-catalog': CatalogPage.preload,
  docs: DocsPage.preload,
  meetings: MeetingsPage.preload,
  'connector-granola': GranolaConnectorPage.preload,
  'connector-github': GithubConnectorPage.preload,
  'connector-slack': SlackConnectorPage.preload,
  transcript: TranscriptPage.preload,
  // Drawn by App itself: nothing to fetch.
  join: () => Promise.resolve(),
};

/**
 * The addresses App draws without a page load: the root, and every route
 * `metaPage` names. A room, a booking and anything unknown stay page loads —
 * a meeting owns its document (media, the lobby socket) from the first byte.
 */
configureRoutes({
  handles: (pathname) => pathname === '/' || metaPage(pathname) !== null,
  preload: (pathname) => {
    if (pathname === '/') return OwnerWebHome.preload();
    const route = metaPage(pathname);
    return route ? PAGE_PRELOAD[route]() : Promise.resolve();
  },
  samePage: (a, b) => metaPage(a) !== null && metaPage(a) === metaPage(b),
});

/**
 * One header for the whole visit (`ChromeFrame`), and under it the page for
 * the current address. The page is keyed by the navigation, so each address
 * mounts its page fresh, as a page load did; the frame, the session and the
 * search palette stay.
 */
export function App() {
  const pageKey = usePageKey();
  useEffect(() => { trackPageview(analyticsPage(window.location.pathname)); }, [pageKey]);
  return (
    <ChromeFrame>
      <Suspense fallback={<RouteFallback />}>
        <Fragment key={pageKey}>
          <RoutedApp />
        </Fragment>
      </Suspense>
    </ChromeFrame>
  );
}

/**
 * The page name a page view is counted under (docs/ANALYTICS.md): the route,
 * never the address, so no record id, room slug or token leaves the browser.
 */
function analyticsPage(pathname: string): string {
  if (pathname === '/') return '/home';
  const route = metaPage(pathname);
  if (route) return `/${route}`;
  if (/^\/guest(\/|$)/u.test(pathname)) return '/guest';
  if (bookPathFromLocation(pathname)) return '/book';
  if (parsePublicEventPath(pathname)) return '/event';
  if (roomPathFromLocation(pathname)) return '/room';
  return '/other';
}

/**
 * Only a first load waits on a page's code here; a navigation fetched it
 * before swapping. Workspace pages draw their own wait once their code is in,
 * so a second, full-screen one first would only flash.
 */
function RouteFallback() {
  const route = metaPage();
  if (route && ROUTE_PAGES_WITH_LOADING_STATE.has(route)) return null;
  return <LoadingScreen quiet />;
}

function RoutedApp() {
  const moved = movedAdminPath(window.location.pathname);
  if (moved) {
    window.location.replace(moved + window.location.search);
    return null;
  }
  // A guest's page (docs/ACCESS.md slice 4): outside the workspace, no member session.
  if (/^\/guest(\/[A-Za-z0-9_-]{20,200})?\/?$/u.test(window.location.pathname)) return <GuestPage />;
  const route = metaPage();
  const routed = routedPage(route);
  if (routed) return routed;
  if (route === 'join') return <JoinDoor />;
  const book = bookPathFromLocation(window.location.pathname);
  if (book) return <BookPage slug={book.slug} />;
  const signup = parsePublicEventPath(window.location.pathname);
  if (signup) return <EventSignupPage slug={signup.slug} />;
  if (/^\/$/u.test(window.location.pathname)) return <RootExperience />;
  return <MeetingApp />;
}

/** The pages that are their own chunk. `null` for the ones App draws itself. */
function routedPage(page: ReturnType<typeof metaPage>): ReactNode {
  switch (page) {
    case 'privacy': return <PublicSiteRedirect workspace />;
    case 'terms': return <PublicSiteRedirect />;
    case 'features': return <PublicSiteRedirect />;
    case 'why': return <PublicSiteRedirect />;
    case 'features-status': return <PublicSiteRedirect />;
    case 'features-capabilities': return <PublicSiteRedirect />;
    case 'interest': return <PublicSiteRedirect />;
    case 'pricing': return <PublicSiteRedirect />;
    case 'changelog': return <PublicSiteRedirect />;
    case 'help': return <PublicSiteRedirect />;
    case 'support': return <SupportPage />;
    // Admin opens on People (MZ, 2026-10-18); Operations has its own address.
    case 'admin': return <AdminPage section="people" />;
    case 'admin-operations': return <AdminPage section="operations" />;
    case 'admin-agents': return <AdminPage section="agents" />;
    case 'admin-people': return <AdminPage section="people" />;
    case 'admin-connectors': return <AdminPage section="connectors" />;
    case 'admin-records': return <AdminRecordsPage />;
    case 'admin-activity': return <AdminActivityPage />;
    case 'admin-jobs': return <AdminPage section="jobs" />;
    case 'settings': return <SettingsPage />;
    case 'connect': return <ConnectPage />;
    case 'save': return <SavePage />;
    case 'team': return <TeamPage />;
    case 'calendar': return <CalendarPage />;
    case 'work': return <WorkPage />;
    case 'work-offer': return <OfferEditorPage />;
    case 'work-catalog': return <CatalogPage />;
    case 'docs': return <DocsPage />;
    case 'meetings': return <MeetingsPage />;
    case 'connector-granola': return <GranolaConnectorPage />;
    case 'connector-github': return <GithubConnectorPage />;
    case 'connector-slack': return <SlackConnectorPage />;
    case 'transcript': {
      const [, , slug, id] = window.location.pathname.split('/');
      return <TranscriptPage roomSlug={slug!} meetingID={id!} />;
    }
    default: return null;
  }
}

/**
 * The root is the only audience-neutral door. Resolve an existing Envisioning
 * session before choosing Home; explicit /room and /book URLs bypass this gate
 * because intent wins over account identity.
 */
function RootExperience() {
  const state = useOwnerSession();
  useDocumentTitle();

  if (state.kind === 'loading') {
    // A member's browser fetches Home's code while the session is checked,
    // not after it.
    if (wasMember()) void OwnerWebHome.preload();
    return wasMember() ? <MemberLoadingShell label={t('Opening Starlings…')} /> : <LoadingScreen label={t('Opening Starlings…')} />;
  }
  if (state.kind === 'visitor') return <HomePage visitorRoot />;
  return <OwnerWebHome owner={state.owner} room={state.room} roomState={state.roomState} />;
}

/**
 * `/join` — the room-code door as its own address. It remains a real route for
 * direct links and signed-out visitors, but signed-in workspace navigation
 * reaches this same flow from Home rather than treating Join as a destination.
 */
function JoinDoor() {
  const state = useOwnerSession();
  useDocumentTitle(t('Join'));

  if (state.kind === 'loading') return <LoadingScreen label={t('Opening Starlings…')} />;
  return <HomePage member={state.kind === 'owner'} />;
}

/**
 * `/book/<slug>` — the booking surface as its own address. Same screen the
 * Schedule button opens, minus the identity the join card would have collected;
 * the form asks for it instead. Leaving here goes to the room, so "find a time"
 * and "join now" stay one hop apart.
 */
function BookPage({ slug }: { slug: string }) {
  return (
    <ScheduleScreen
      room={slug}
      onBack={() => { window.location.href = `/room/${slug}`; }}
      backLabel="Back to the room"
    />
  );
}

function MeetingApp() {
  const path = useMemo(() => roomPathFromLocation(window.location.pathname), []);
  const recorderName = useMemo(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get('meet') !== 'recorder') return null;
    return query.get('name')?.trim().slice(0, 80) || null;
  }, []);
  // Restore an in-tab lobby receipt before first paint so reload skips RoomEntry
  // and Prejoin when the guest was already waiting or admitted.
  const resumed = useMemo(
    () => (path ? readGuestLobbySession(path.slug) : undefined),
    [path],
  );
  const [roomReady, setRoomReady] = useState<'loading' | 'ok' | 'missing'>(path ? 'loading' : 'missing');
  const [intent, setIntent] = useState<'knock' | null>(() => (resumed ? 'knock' : null));
  const [connection, setConnection] = useState<ConnectionDetails>();
  const [identity, setIdentity] = useState<JoinIdentity | undefined>(() => (
    resumed ? identityFromSession(resumed) : undefined
  ));
  const [mediaChoices, setMediaChoices] = useState<LocalUserChoices | undefined>(() => (
    resumed ? mediaChoicesForResume(resumed.name) : undefined
  ));
  const [lobby, setLobby] = useState<LobbyReceipt | undefined>(() => (
    resumed ? receiptFromSession(resumed) : undefined
  ));
  const [error, setError] = useState('');
  const [ended, setEnded] = useState<MeetingSummary>();
  const [ownerName, setOwnerName] = useState('');
  const [roomInternal, setRoomInternal] = useState(false);
  /* The signed-in member, on the internal room only. */
  const [memberIdentity, setMemberIdentity] = useState<JoinIdentity | undefined>(undefined);
  const [booking, setBooking] = useState<BookingCard>();
  const [draftName, setDraftName] = useState(() => readStored(StorageKeys.name));
  // Leaving a meeting returns to this room's entry page, but it must not make
  // the guest look like a brand-new visitor in the owner's waiting room. The
  // next explicit Join starts a new presence visit.
  const [guestPresenceSuppressed, setGuestPresenceSuppressed] = useState(false);
  const [guestPresenceResetKey, setGuestPresenceResetKey] = useState(0);
  const leavingIntentionally = useRef(false);
  // Survives `connection` being cleared for a reconnect, so the ended summary
  // can still say how long the meeting ran when the end arrived mid-rejoin.
  const lastStartedAt = useRef<number | undefined>(undefined);
  const room = path?.slug ?? '';
  const bookingToken = path?.bookingToken;
  const autoCallStarted = useRef(false);

  const presenceActive = roomReady === 'ok'
    && !guestPresenceSuppressed
    && !lobby
    && !connection
    && !ended;
  const presenceStage: GuestPresenceStage = identity && intent === 'knock' && !mediaChoices
    ? 'preview'
    : draftName.trim()
      ? 'naming'
      : 'visit';
  const presenceName = (identity?.name || draftName).trim() || undefined;
  const presenceId = useGuestPresence({
    room,
    active: presenceActive && Boolean(room),
    stage: presenceStage,
    name: presenceName,
    resetKey: guestPresenceResetKey,
    // Carried pre-knock so a visitor who arrived on a booking link is
    // recognizable before they identify themselves.
    bookingToken,
  });

  // The tab: the phase, then whose room — `Waiting · Rosa’s room · Starlings`.
  const roomLabel = roomReady === 'ok' ? (ownerName ? t('{ownerName}’s room', { ownerName }) : room) : null;
  useDocumentTitle(
    ended ? t('Ended') : connection ? t('In meeting') : lobby ? t('Waiting') : null,
    roomLabel,
  );

  useEffect(() => {
    if (!path) {
      setRoomReady('missing');
      return;
    }
    let cancelled = false;
    void fetch(`${apiBase}/rooms/${path.slug}`)
      .then(async (response) => {
        if (cancelled) return;
        setRoomReady(response.ok ? 'ok' : 'missing');
        if (!response.ok) return;
        // Whose room this is, so the lobby can name them. The Worker sends a
        // display name only — never the owner's email.
        const candidate: unknown = await response.json().catch(() => null);
        if (cancelled || !isPublicRoomResponse(candidate)) return;
        const body = candidate;
        if (body.owner_name) setOwnerName(body.owner_name);
        // `you` is the viewer's own identity, sent for a signed-in member on
        // any room. Room entry then has nothing left to ask: no name, no
        // email. The internal room also skips the waiting room; a member on
        // somebody's permanent room still knocks like anyone else.
        setRoomInternal(body.internal === true);
        if (body.you) setMemberIdentity({ name: body.you.name, email: body.you.email });
      })
      .catch(() => {
        if (!cancelled) setRoomReady('missing');
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  /*
   * Anyone on the team just joins — no name, no email. The session already
   * identified them, so a member walks straight past Room entry to Prejoin on
   * any room, which stays because a device check is a courtesy to the joiner
   * rather than an admission step. The internal room also has no waiting
   * room; on a permanent room the knock still goes to its host.
   */
  useEffect(() => {
    if (!memberIdentity || identity) return;
    rememberCanonicalPath();
    setGuestPresenceSuppressed(true);
    setDraftName(memberIdentity.name);
    setIdentity(memberIdentity);
    setIntent('knock');
    // `rememberCanonicalPath` is stable for the life of this component and the
    // setters never change; re-running on anything but these two would put
    // the member back at the door they just walked through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberIdentity, identity]);

  // The invite token is the only thing that names the meeting. Resolving it is
  // never on the critical path: until (or unless) it lands, Room entry shows
  // the same opaque Join a bare slug gets.
  useEffect(() => {
    if (!path?.bookingToken) {
      setBooking(undefined);
      return;
    }
    let cancelled = false;
    const token = encodeURIComponent(path.bookingToken);
    void fetch(`${apiBase}/rooms/${path.slug}/bookings/${token}`, { cache: 'no-store' })
      .then(async (response) => {
        if (cancelled) return;
        // 404 is an invite this room does not recognize; anything else failing
        // is our problem, not the guest's, so we say nothing about the booking.
        if (response.status === 404) {
          setBooking({ state: 'expired' });
          return;
        }
        if (!response.ok) return;
        // The contract, not a cast: a body that does not parse says nothing
        // about the booking, the same as a failed request.
        const candidate: unknown = await response.json().catch(() => null);
        if (!cancelled && isMeetMintedBookingProjection(candidate)) setBooking(bookingCardFrom(candidate));
      })
      .catch(() => {
        /* Offline or blocked: the token still rides along on the knock. */
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  function persistLobby(receipt: LobbyReceipt, nextIdentity: JoinIdentity) {
    writeGuestLobbySession({
      slug: room,
      requestId: receipt.requestId,
      lobbyToken: receipt.lobbyToken,
      status: receipt.status,
      waitingCount: receipt.waitingCount,
      name: nextIdentity.name,
      email: nextIdentity.email,
    });
  }

  function abandonLobbyCredentials() {
    if (room) clearGuestLobbySession(room);
    setLobby(undefined);
    setMediaChoices(undefined);
  }

  async function requestAdmission(nextIdentity: JoinIdentity, choices: LocalUserChoices, recording = false) {
    setError('');
    const normalizedIdentity = { ...nextIdentity, name: choices.username.trim() || nextIdentity.name };
    const body = {
      name: normalizedIdentity.name,
      ...(normalizedIdentity.email ? { email: normalizedIdentity.email } : {}),
      ...(bookingToken ? { booking_token: bookingToken } : {}),
      ...(presenceId ? { presence_id: presenceId } : {}),
      client: guestClient(),
      ...(recording ? { recording: true } : {}),
    };
    // A declared notetaker is a headless browser. It still passes the rate
    // limit and waits for owner admission, but does not solve a device-bound
    // browser challenge.
    const receipt = await apiFetch<JoinRequestReceipt>(`/rooms/${room}/join-requests`, {
      body: recording ? body : await withTurnstileToken('join', body),
      fallbackError: t('Couldn’t reach this room right now — try again shortly.'),
    });
    if (room) clearPresenceId(room);
    setIdentity(normalizedIdentity);
    setMediaChoices(choices);
    setLobby(receipt);
    persistLobby(receipt, normalizedIdentity);
    if (recording) rememberCanonicalPath();
  }

  useEffect(() => {
    if (roomReady !== 'ok' || autoCallStarted.current) return;
    autoCallStarted.current = true;
    if (!consumePeerCall(room) || resumed) return;
    void fetchPeers().then(async roster => {
      const me = roster.peers.find(peer => peer.is_self);
      if (!me) throw new Error(t('Sign in before calling a colleague.'));
      const nextIdentity = { name: me.name?.trim() || me.email.split('@')[0], email: me.email };
      setIdentity(nextIdentity); setIntent('knock');
      await requestAdmission(nextIdentity, mediaChoicesForResume(nextIdentity.name));
    }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t('Couldn’t join this call.')));
  }, [roomReady, room, resumed]);

  async function exchangeAdmission(receipt: LobbyReceipt) {
    const details = await apiFetch<ConnectionDetails>(`/rooms/${room}/join-requests/${receipt.requestId}/exchange`, {
      body: { lobby_token: receipt.lobbyToken },
      fallbackError: t('Couldn’t enter the meeting.'),
    });
    leavingIntentionally.current = false;
    lastStartedAt.current = details.started_at;
    setConnection(details);
    track('Meeting joined');
    if (identity) {
      persistLobby({ ...receipt, status: 'joined' }, identity);
    }
    return details;
  }

  /** Guest pressed Leave — drop credentials and return to the Join form. */
  function leaveMeeting() {
    leavingIntentionally.current = true;
    setGuestPresenceSuppressed(true);
    setGuestPresenceResetKey((key) => key + 1);
    if (room) clearPresenceId(room);
    setConnection(undefined);
    abandonLobbyCredentials();
    setIntent(null);
    setIdentity(undefined);
    setError('');
  }

  /** Tear down every credential we hold and switch to the summary screen. */
  function finishMeeting() {
    // Suppress reconnect attempts from the LiveKit disconnect that follows.
    leavingIntentionally.current = true;
    setEnded({
      startedAt: connection?.started_at ?? lastStartedAt.current,
      endedAt: Date.now(),
    });
    setConnection(undefined);
    abandonLobbyCredentials();
  }

  // No client-side LiveKit token refresh: the SFU pushes refreshed tokens to
  // connected participants over the signal channel, so the 2h JWT only matters
  // when (re)joining from scratch — and that path re-exchanges below.
  function rememberCanonicalPath() {
    const canonical = canonicalRoomPath(room, bookingToken);
    if (window.location.pathname.replace(/\/$/, '') !== canonical) {
      window.history.replaceState(null, '', canonical);
    }
  }

  if (!path) return <HomePage />;
  if (roomReady === 'missing') return <RoomNotFound room={room} />;

  if (roomReady === 'loading') {
    return <LoadingScreen label={t('Loading…')} />;
  }

  if (ended) {
    return (
      <MeetingEnded
        room={room}
        summary={ended}
        onRejoin={() => {
          setEnded(undefined);
          setIntent(null);
          abandonLobbyCredentials();
          setError('');
        }}
      />
    );
  }

  // The internal room has no Room entry to show: the effect above is taking
  // the member straight to Prejoin, and a flash of the guest form on the way
  // would be a question nobody is being asked.
  if ((roomInternal || memberIdentity) && !identity) return <LoadingScreen room={room} quiet />;

  if (!intent || !identity) {
    return (
      <RoomEntry
        room={room}
        bookingToken={bookingToken}
        booking={booking}
        ownerName={ownerName}
        internal={roomInternal}
        error={error}
        onDraftName={setDraftName}
        recorderName={recorderName}
        onJoin={(nextIdentity) => {
          setGuestPresenceSuppressed(false);
          setDraftName(nextIdentity.name);
          if (recorderName) {
            setIntent('knock');
            void requestAdmission(nextIdentity, mediaChoicesForResume(nextIdentity.name), true)
              .catch((reason: Error) => setError(reason.message));
          } else {
            rememberCanonicalPath();
            setIdentity(nextIdentity);
            setIntent('knock');
          }
        }}
      />
    );
  }

  if (!mediaChoices) {
    return (
      <Suspense fallback={<LoadingScreen room={room} quiet />}>
        <Prejoin
          roomSlug={room}
          identity={identity}
          session={booking?.state === 'scheduled' && booking.session}
          error={error}
          onJoin={(choices) => requestAdmission(identity, choices).catch((reason: Error) => setError(reason.message))}
          onBack={() => {
            // Up one step to Room entry. Name and email are remembered in
            // storage, so the form comes back filled in.
            setIntent(null);
            setIdentity(undefined);
            setError('');
          }}
        />
      </Suspense>
    );
  }

  if (!connection && lobby) {
    const canReenter = lobby.status === 'admitted' || lobby.status === 'joined';
    return (
      <WaitingRoom
        room={room}
        ownerName={ownerName}
        receipt={lobby}
        reconnecting={canReenter}
        readiness={mediaReadinessLabel(mediaChoices)}
        booking={booking}
        onCancel={() => {
          // Identity and intent stay, so this lands on Prejoin — the step
          // before the knock — exactly as iOS `cancelWaiting` does.
          abandonLobbyCredentials();
          setError('');
        }}
        onStatus={(status, waitingCount) => {
          if (status === 'rejected' || status === 'expired' || status === 'removed') {
            abandonLobbyCredentials();
            setIntent(null);
            setError({
              rejected: t('The owner declined this request. Ask to join again.'),
              expired: t('Your request timed out waiting for the owner. Ask to join again.'),
              removed: t('The owner removed you from this meeting. You can ask to join again.'),
            }[status]);
            return;
          }
          setLobby((current) => {
            if (!current) return current;
            const next = {
              ...current,
              status,
              waitingCount: waitingCount ?? current.waitingCount,
            };
            if (identity) persistLobby(next, identity);
            return next;
          });
        }}
        onSessionInvalid={() => {
          abandonLobbyCredentials();
          setIntent(null);
          setError(t('Your place in the waiting room expired. Ask to join again.'));
        }}
        onAdmitted={async () => {
          try {
            await exchangeAdmission(lobby);
          } catch (reason) {
            const message = reason instanceof Error ? reason.message : t('Couldn’t enter the meeting.');
            if (reason instanceof ControlRequestError && reason.meetingIsOver) {
              // A guest who was already inside reached this from a drop that
              // raced the owner pressing End — an ending, not a failure, so
              // close out with the summary rather than an error banner.
              if (lobby.status === 'joined') {
                finishMeeting();
                return;
              }
              abandonLobbyCredentials();
              setIntent(null);
            } else if (reason instanceof ControlRequestError && reason.needsRejoin) {
              abandonLobbyCredentials();
              setIntent(null);
            }
            setError(message);
            throw reason;
          }
        }}
        error={error}
      />
    );
  }

  if (!connection) {
    return (
      <RoomEntry
        room={room}
        bookingToken={bookingToken}
        error={error || t('Ask to join again.')}
        onJoin={(nextIdentity) => {
          setGuestPresenceSuppressed(false);
          setIdentity(nextIdentity);
          setIntent('knock');
          abandonLobbyCredentials();
        }}
      />
    );
  }

  return (
    <MeetingErrorBoundary
      room={room}
      onReset={() => {
        setConnection(undefined);
        abandonLobbyCredentials();
        setIntent(null);
      }}
    >
      <Suspense fallback={<LoadingScreen room={room} label={t('Connecting securely…')} />}>
        <ConnectedMeeting
        roomSlug={room}
        connection={connection}
        mediaChoices={mediaChoices}
        // Only a token link resolves a booking, so only a token link gets a
        // clock — a bare slug must not learn when the meeting ends
        // (docs/ROOM_ENTRY.md, decision 6).
        scheduledEndsAt={booking?.state === 'scheduled' ? booking.endsAt : null}
        onLeave={leaveMeeting}
        onOwnerLeft={finishMeeting}
        onDisconnected={(why: MeetingDisconnect) => {
          if (leavingIntentionally.current) {
            // leaveMeeting / finishMeeting already tore down UI state.
            leavingIntentionally.current = false;
            return;
          }
          // The owner ended the meeting: the room is gone, so retrying would
          // only fail. Close out with a summary instead.
          if (why === 'owner-closed') {
            finishMeeting();
            return;
          }
          // Removed by the host. The credentials this tab holds were spent
          // server-side at the same moment, so re-exchanging would only turn a
          // decision somebody made into a confusing failure. Say what happened
          // and put them back at the door.
          if (why === 'removed') {
            setConnection(undefined);
            abandonLobbyCredentials();
            setIntent(null);
            setError(t('The owner removed you from this meeting. You can ask to join again.'));
            return;
          }
          // Keep lobby credentials and the seat. Clearing `connection` puts
          // the WaitingRoom back up, and that component owns the admission
          // exchange — one owner with backoff, instead of a second exchange
          // here racing the one the WaitingRoom would start itself. A drop is
          // exactly when the network is flaky, so a single failed re-exchange
          // must not cost an admitted guest their place in the room.
          if (!lobby) {
            setConnection(undefined);
            abandonLobbyCredentials();
            return;
          }
          setConnection(undefined);
        }}
        />
      </Suspense>
    </MeetingErrorBoundary>
  );
}

/**
 * A render error anywhere in the meeting view used to unmount the whole app and
 * leave an admitted guest staring at a blank page. Contain it here and offer a
 * way back into the room instead.
 */
class MeetingErrorBoundary extends Component<
  { room: string; onReset: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error('Meeting view failed', error);
    recordMeetError('meeting view', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <AppShell variant="centered" roomSlug={this.props.room}>
        <GuestCard size="status" aria-live="polite">
          <h1>{t('This meeting view stopped')}</h1>
          <p className="lede">{t('Something went wrong. Ask to join again.')}</p>
          <Button
            type="button"
            onClick={() => {
              this.setState({ failed: false });
              this.props.onReset();
            }}
          >
            {t('Back to this room')}
          </Button>
        </GuestCard>
      </AppShell>
    );
  }
}

type MeetingSummary = {
  startedAt?: number;
  endedAt: number;
};

function MeetingEnded({ room, summary, onRejoin }: {
  room: string;
  summary: MeetingSummary;
  onRejoin: () => void;
}) {
  const lasted = summary.startedAt
    ? formatMeetingDuration(summary.endedAt - summary.startedAt)
    : null;
  return (
    <AppShell variant="centered" roomSlug={room}>
      <GuestCard size="status" aria-live="polite">
        <h1>{t('The meeting ended')}</h1>
        <p className="lede">{t('The owner closed the room.')}</p>
        <dl className="mx-0 mt-0 mb-6 flex flex-wrap justify-center gap-3">
          {lasted && <SummaryFact term={t('Lasted')}>{lasted}</SummaryFact>}
          <SummaryFact term={t('Room')}>{room}</SummaryFact>
          <SummaryFact term={t('Transcript')}>{t('Your host keeps it')}</SummaryFact>
        </dl>
        <div className="flex flex-wrap justify-center gap-2.5">
          <Button type="button" onClick={onRejoin}>
            {t('Back to this room')}
          </Button>
          {/* Same pair iOS puts on its ended receipt. Home is the only
              audience-neutral door, so "another room" is a room code there. */}
          <Button asChild variant="secondary"><a href="/">
            {t('Join another room')}
          </a></Button>
        </div>
        {/* The one earned ask on the public site: the guest just spent an
            hour with us. Newsletter only; no research hub, no pricing.
            Envisioning's newsletter, so only on Envisioning (meet#943). */}
        {isEnvisioningWorkspace() && (
          <p className="mt-6 mb-0 text-[13px] leading-normal text-muted-foreground">
            {tx('Read what we are researching this week in {newsletter}, our newsletter.', {
              newsletter: <a href={`${ORG_WEB_ORIGIN}/newsletter`} target="_blank" rel="noreferrer">Artificial Insights</a>,
            })}
          </p>
        )}
      </GuestCard>
    </AppShell>
  );
}

/** One fact on the ended receipt: a small caps term over its value. */
function SummaryFact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <Card className="gap-0 rounded-lg bg-(--surface-sunken) px-3.5 py-2.5 shadow-none">
      <dt className="text-[11px] font-semibold tracking-[0.04em] text-muted-foreground/70 uppercase">{term}</dt>
      <dd className="mx-0 mt-0.5 mb-0 text-[15px] tabular-nums">{children}</dd>
    </Card>
  );
}

/** A guest's intentional wait for the host, distinct from app loading. */
function GuestWaitingFlock() {
  return (
    <div className="mx-auto mb-8 flex size-24 items-center justify-center text-muted-foreground" aria-hidden="true">
      <GatheringDots motion="murmuration" width={64} height={64} />
    </div>
  );
}

function LoadingScreen({ room, label, quiet = false }: { room?: string; label?: string; quiet?: boolean }) {
  const [visible, setVisible] = useState(false);

  // Most route and code-split transitions finish in a frame or two. Holding
  // the fallback briefly avoids flashing a separate "Loading" page for them.
  useEffect(() => {
    const timeout = window.setTimeout(() => setVisible(true), 300);
    return () => window.clearTimeout(timeout);
  }, []);

  if (!visible) return null;

  return (
    <AppShell variant="centered" roomSlug={room}>
      <GuestCard size="status">
        <LoadingIndicator
          placement="full-page"
          label={quiet ? undefined : label}
          labelVisibility={quiet ? 'sr-only' : 'visible'}
          className="min-h-40"
        />
      </GuestCard>
    </AppShell>
  );
}

const ROOM_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,39}$/;

/**
 * The blocks under the join card read as chapters under it: a 22pt
 * heading, so the join card stays the loudest thing. A block with no heading
 * keeps the heading's room above it, or its tiles crowd the link before.
 */
const HOME_SECTION_HEADING = "m-0 text-[22px] font-[620] tracking-[-0.01em] text-foreground";

const VISITOR_HOME_FALLBACK: VisitorHomeResponse = { join: VISITOR_HOME_DEFAULT.join, booking: null };

/**
 * What an admin chose for the visitor root (`/admin/people`). Undefined while
 * it loads, so a root with the room-code field turned off never flashes it.
 * A failed read is the default: the root still opens.
 */
function useVisitorHome(enabled: boolean): VisitorHomeResponse | undefined {
  const [home, setHome] = useState<VisitorHomeResponse | undefined>(enabled ? undefined : VISITOR_HOME_FALLBACK);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    apiFetch<VisitorHomeResponse>('/visitor-home', { fallbackError: t('Couldn’t load the visitor home.'), noStore: true, signal: controller.signal })
      .then(setHome)
      .catch(() => { if (!controller.signal.aborted) setHome(VISITOR_HOME_FALLBACK); });
    return () => controller.abort();
  }, [enabled]);
  return home;
}

/**
 * The audience-neutral entry: type a slug to join. At the root a visitor sees
 * what an admin chose (`visitorRoot`); `/join` and a member always get the
 * room-code field.
 */
function HomePage({ member = false, visitorRoot = false }: { member?: boolean; visitorRoot?: boolean }) {
  const visitorHome = useVisitorHome(visitorRoot && !member);
  const showJoin = visitorHome?.join === true;
  const booking = visitorHome?.booking ?? null;
  const [slug, setSlug] = useState('');
  const [resolving, setResolving] = useState(false);
  const [localError, setLocalError] = useState('');

  /**
   * Room code, path, or a pasted link. Keeps the booking token when the input
   * carries one: someone who pastes their whole invite should land on their
   * meeting's card, not on the opaque door with the token quietly dropped.
   */
  function normalizeRoomInput(raw: string): RoomPathParts | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      const asURL = new URL(trimmed);
      // A pasted URL is a room only in its canonical /room form; a short
      // https://…/<slug> link is not a room any more.
      return roomPathFromLocation(asURL.pathname);
    } catch {
      // Not a URL — treat as a bare slug / path fragment.
    }
    const pathish = trimmed.replace(/^\/+/, '');
    const fromPath = roomPathFromLocation(`/${pathish}`);
    if (fromPath) return fromPath;
    const bare = pathish.replace(/^room\//iu, '').split('/')[0]?.toLowerCase() ?? '';
    return ROOM_SLUG_PATTERN.test(bare) ? { slug: bare } : null;
  }

  function enterRoom(parts: RoomPathParts) {
    const token = parts.bookingToken ? `/${encodeURIComponent(parts.bookingToken)}` : '';
    window.location.assign(`/room/${encodeURIComponent(parts.slug)}${token}`);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = normalizeRoomInput(slug);
    if (!next) {
      setLocalError(t('Enter a room code, or paste a room link.'));
      return;
    }
    setLocalError('');

    // A bare booking token looks exactly like a room code — 16 lowercase
    // characters — so a guest who pastes just their token would otherwise be
    // told there is no such room. Anything long enough to be a token gets one
    // lookup before we take it at face value as a slug.
    if (!next.bookingToken && next.slug.length >= 8) {
      setResolving(true);
      try {
        const found = await fetch(`${apiBase}/bookings/${encodeURIComponent(next.slug)}/room`, {
          cache: 'no-store',
        });
        if (found.ok) {
          const body = await found.json().catch(() => null) as { slug?: unknown } | null;
          if (typeof body?.slug === 'string') {
            enterRoom({ slug: body.slug, bookingToken: next.slug });
            return;
          }
        }
      } catch {
        // Offline or blocked — fall through and treat the input as a room code.
      } finally {
        setResolving(false);
      }
    }

    enterRoom(next);
  }

  // A member here is on Home's room flow, not at the visitor door: they
  // already have a session, so the sign-in button below would be a dead end.
  useOwnerHeartbeat(member);

  return (
    <AppShell variant="centered" current={member ? undefined : 'join'} member={member ? 'home' : undefined}>
      <div className="grid w-[min(100%,560px)] justify-items-stretch gap-4">
        {booking && (
          <HomeTile
            href={`/book/${encodeURIComponent(booking.room)}`}
            icon={<CalendarIcon />}
            title={booking.name ? t('Book with {display_name}', { display_name: booking.name }) : t('Book')}
            detail={t('Pick a time')}
          />
        )}
        {showJoin && <GuestCard className="w-full">
          <h1 className="mt-0">{t('Join a room')}</h1>
          <GuestLede>
            {t('Enter a room code from your host to join.')}
          </GuestLede>
          {/* The field and Continue share one row: the button is as wide as
              its word, not the card (MZ, 2026-10-06). */}
          <form className="grid gap-4" onSubmit={submit}>
            <div className="flex items-start gap-2.5">
              <GuestField className="min-w-0 flex-1">
                <Input
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  aria-label={t('Room code')}
                  value={slug}
                  onChange={(event) => {
                    setSlug(event.target.value);
                    if (localError) setLocalError('');
                  }}
                  aria-invalid={localError ? true : undefined}
                />
              </GuestField>
              <Button type="submit" disabled={resolving}>
                {resolving ? t('Looking up…') : t('Continue')}
              </Button>
            </div>
            {localError && <ErrorNotice message={localError} />}
          </form>
        </GuestCard>}
        {/* The two doors: a guest's call, then a member's sign-in.
            A signed-in member reaches this page from Home and sees the apps
            instead. Downloads are the product site's, not the
            workspace's, so a signed-out visitor is not offered them. */}
        {member ? (
          <section className="grid justify-items-stretch gap-3 px-0.5 pt-3">
            <h2 className={HOME_SECTION_HEADING}>{t('Apps')}</h2>
            <HomeTileGrid>
              <HomeTile
                href={MAC_DOWNLOAD_URL}
                aria-label={t('Download Starlings for Mac')}
                icon={<DesktopIcon />}
                title={t('Mac')}
                detail={t('Download')}
              />
              <HomeTile
                href={IOS_DOWNLOAD_URL}
                aria-label={t('Join the Starlings TestFlight beta for iPhone and iPad')}
                icon={<PhoneIcon />}
                title={t('iPhone & iPad')}
                detail={t('Join TestFlight')}
              />
            </HomeTileGrid>
          </section>
        ) : (
          <SignedOutDoor returnTo="/" />
        )}
      </div>
    </AppShell>
  );
}

/**
 * A syntactically valid room link that the control plane does not know. Keep
 * this inside the normal Meet shell so a mistyped room feels like a resolved
 * Meet state, with a clear way back to the room-code door.
 *
 * The Worker answers a member-only room with the same 404 an unknown slug
 * gets, so a signed-out member landing on `/room/team` cannot be told apart
 * from a typo — by the server. The client can: if this browser has no
 * Envisioning session, the first offer is to sign in and come straight back
 * here. Every 404 gets that offer, so the page still confirms nothing about
 * whether a room exists.
 */
function RoomNotFound({ room }: { room: string }) {
  const session = useOwnerSession();
  const signedOut = session.kind === 'visitor';
  const message = t('No room named “{room}”. Check the code from your host.', { room });
  return (
    <AppShell variant="centered" roomSlug={room}>
      <GuestCard role="region" aria-labelledby="room-not-found-title">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3.5">
          <div
            className="grid size-12 flex-none place-items-center rounded-(--radius-control) border border-(--danger)/36 bg-(--danger)/12 text-(--danger-ink)"
            aria-hidden="true"
          >
            <WarningIcon />
          </div>
          <div>
            <h1 id="room-not-found-title" className="mt-2.5 text-[clamp(32px,5vw,46px)]">{t('This room isn’t available')}</h1>
          </div>
        </div>
        <p className="lede my-5!">
          {signedOut
            ? t('Some rooms only open for {workspace} members. Sign in to check this one.', { workspace: workspaceBrand().name })
            : t('We couldn’t find a room at this link.')}
        </p>
        <div className="mb-4 flex items-center justify-between gap-4 rounded-(--radius-field) border border-border bg-(--surface-sunken) px-3.5 py-3 text-xs text-muted-foreground">
          <span className="flex-none font-semibold tracking-[0.04em] uppercase">{t('Requested room')}</span>
          <code className="min-w-0 truncate text-foreground [font:inherit]">/room/{room}</code>
        </div>
        {!signedOut && <ErrorNotice message={message} role="status" className="mb-5" />}
        <div className="grid gap-2.5">
          {signedOut && (
            <EnvisioningSignInButton
              returnTo={`/room/${room}`}
              onSignedIn={() => window.location.reload()}
            />
          )}
          <Button asChild variant={signedOut ? 'secondary' : 'default'}><a
                        href="/join"
          >
            {t('Enter another room')}
          </a></Button>
          <Button asChild variant="secondary"><a href="/">{t('Back to Starlings')}</a></Button>
        </div>
        <p className="mt-5 mb-0 border-t border-border pt-4 text-[13px] leading-normal text-muted-foreground">
          {signedOut
            ? t('Not a member? Check the room code from your host, or ask them to resend the link.')
            : t('If you expected a meeting here, ask your host to resend the room link.')}
        </p>
      </GuestCard>
    </AppShell>
  );
}

/** Why the meeting runs here, in one breath, before the name field. */
const ROOM_ENTRY_NOTE = 'mt-[-8px] mb-5 text-[13px] leading-normal text-muted-foreground';

function RoomEntry({ room, bookingToken, booking, ownerName, internal, error, onJoin, onDraftName, recorderName }: {
  room: string;
  bookingToken?: string;
  booking?: BookingCard;
  /** Whose room this is — the card says who the guest is meeting. */
  ownerName?: string;
  /**
   * The internal room. Reaching this component with it set means the viewer is
   * a verified member, because the Worker 404s the room lookup for anyone else.
   */
  internal?: boolean;
  error: string;
  onJoin: (identity: JoinIdentity) => void;
  onDraftName?: (name: string) => void;
  /** Name supplied by a declared notetaker's custom meeting URL. */
  recorderName?: string | null;
}) {
  // The token, not the resolved booking, decides whether Schedule is offered:
  // someone holding an invite already has a time, even a stale one. The
  // internal room offers it never — it has no booking door to send anyone to.
  const hasBooking = Boolean(bookingToken);
  const [name, setName] = useState(() => recorderName || readStored(StorageKeys.name));
  const [email, setEmail] = useState(() => readStored(StorageKeys.email));
  const [localError, setLocalError] = useState('');
  const recorderMode = Boolean(recorderName);
  const canSubmitIdentity = recorderMode ? Boolean(name.trim()) : hasValidGuestIdentity(name, email);

  // An invite minted for one person carries their name and email. It wins
  // over what this browser remembers, and stays editable: a guest on a shared
  // laptop can still correct it.
  const invitedName = booking?.state === 'scheduled' ? booking.guestName : null;
  const invitedEmail = booking?.state === 'scheduled' ? booking.guestEmail : null;
  useEffect(() => {
    if (invitedName) setName(invitedName);
    if (invitedEmail) setEmail(invitedEmail);
  }, [invitedName, invitedEmail]);

  function identityFromForm(): JoinIdentity | null {
    if (!canSubmitIdentity) return null;
    writeStored(StorageKeys.name, name.trim());
    if (!recorderMode) writeStored(StorageKeys.email, email.trim());
    return { name: name.trim(), email: recorderMode ? '' : email.trim() };
  }

  function submitJoin(event: FormEvent) {
    event.preventDefault();
    setLocalError('');
    const next = identityFromForm();
    if (next) onJoin(next);
  }

  function submitSchedule() {
    const next = identityFromForm();
    if (!next) {
      setLocalError(t('Enter your name and email first.'));
      return;
    }
    setLocalError('');
    // A real address, not a step in this component's state — so the guest can
    // bookmark it, get sent it, or reload mid-form without landing back here.
    window.location.href = `/book/${encodeURIComponent(room)}`;
  }

  // Asked once, before the form: a browser that cannot carry the meeting
  // should say so here rather than after the owner has admitted a ghost.
  // Scheduling still works, so this replaces Join and not the whole page.
  const support = useMemo(() => checkBrowserSupport(), []);

  return (
    <AppShell variant="centered" roomSlug={room}>
      <GuestCard>
        <h1>{t('Join')}</h1>
        <GuestLede>
          {recorderMode
            ? t('Join this room as a notetaker.')
            : internal
            ? t('Enter your details to join.')
            : hasBooking
              ? t('Enter your details to join this meeting.')
              : t('Enter your details, then join now or schedule a time.')}
        </GuestLede>
        <BookingCardBanner booking={booking} ownerName={ownerName} />
        <AddToCalendar booking={booking} ownerName={ownerName} />
        {/* The one place a guest reads why the meeting runs here, before they
            type their name. The internal room has no guest to tell. */}
        {!internal && (
          <p className={ROOM_ENTRY_NOTE}>
            {t('{workspace} runs this meeting on Starlings. Starlings does not record or store audio or video. An admitted third-party notetaker may record the media it receives; it is marked in the room and the owner can refuse it. The transcript is produced on the host device, and only that text is kept.', { workspace: workspaceBrand().name })}{' '}
            <a href="/workspace">{t('What Starlings does')}</a> · <a href="/privacy">{t('How it handles your data')}</a>
          </p>
        )}
        {recorderMode && (
          <p className={ROOM_ENTRY_NOTE}>{t('This notetaker declares that it records. The owner can refuse it, and it receives no microphone or camera access from Starlings.')}</p>
        )}
        {!recorderMode && !support.ok && (
          <ErrorNotice message={support.reason} />
        )}
        <form className="grid gap-4" onSubmit={submitJoin}>
          <GuestField>
            {t('Your name')}
            <Input
              autoFocus
              required
              value={name}
              onChange={(event) => {
                const next = event.target.value;
                setName(next);
                onDraftName?.(next);
              }}
              placeholder={t('Name')}
            />
          </GuestField>
          {!recorderMode && (
            <GuestField>
              {t('Email')}
              <Input
                required
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={t('Email')}
              />
            </GuestField>
          )}
          {(error || localError) && <ErrorNotice message={error || localError} />}
          <div className="grid gap-3">
            <Button
              type="submit"
              disabled={!canSubmitIdentity || (!recorderMode && !support.ok)}
            >
              {!recorderMode && <VideoIcon />}
              {/* Not "Join" and not "Knock": this opens Prejoin, where the
                  actual knock lives ("Ask to join"). Both doors say the same
                  thing because both knock — a token does not skip the lobby. */}
              {recorderMode ? t('Join') : t('Continue')}
            </Button>
            {!hasBooking && !internal && (
              <Button variant="secondary"
                type="button"
                disabled={!canSubmitIdentity}
                onClick={submitSchedule}
              >
                <CalendarIcon />
                {t('Schedule')}
              </Button>
            )}
          </div>
        </form>
      </GuestCard>
    </AppShell>
  );
}

/**
 * What the invite behind the token says — title and window, nothing else. An
 * expired or unrecognized invite says so plainly and still leaves Join in
 * place: the host may be waiting, and the token still rides along on the knock
 * so the meeting lands on the right CRM timeline.
 */
/**
 * Puts the booking in the guest's own calendar. Only for a resolvable, still
 * scheduled invite — a bare slug has no time to offer, and ROOM_ENTRY decision
 * 6 says it must not acquire one.
 */
function AddToCalendar({ booking, ownerName }: {
  booking?: BookingCard;
  ownerName?: string;
}) {
  const [href, setHref] = useState('');
  const scheduled = booking?.state === 'scheduled' ? booking : undefined;
  const title = scheduled?.title ?? '';
  const startsAt = scheduled?.startsAt ?? '';
  const endsAt = scheduled?.endsAt ?? '';

  useEffect(() => {
    if (!title || !startsAt || !endsAt) {
      setHref('');
      return;
    }
    const ics = buildBookingIcs({
      title,
      startsAt,
      endsAt,
      joinUrl: window.location.href,
      ownerName,
    });
    if (!ics) {
      setHref('');
      return;
    }
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    setHref(url);
    // One live object URL at a time; the tab would otherwise hold every blob
    // it ever built until reload.
    return () => URL.revokeObjectURL(url);
  }, [title, startsAt, endsAt, ownerName]);

  if (!href || !title) return null;
  return (
    <Button asChild variant="link" className="mb-4.5 h-auto p-0 text-[13px] text-foreground/66 hover:text-foreground/95">
      <a href={href} download={icsFileName(title)}>
        <CalendarIcon />
        {t('Add to my calendar')}
      </a>
    </Button>
  );
}

/**
 * What the invite behind the token says. Sits between the lede and the form so
 * the guest confirms the meeting before typing their name.
 */
const BOOKING_CARD = 'mt-[-12px] mb-5 rounded-[10px] border border-l-2 border-border border-l-(--accent) bg-(--surface-sunken) px-3.5 py-3 text-left';

function BookingManageLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button asChild variant="link" className="h-auto p-0 text-xs font-normal text-muted-foreground underline underline-offset-3 hover:text-foreground">
      <a href={href}>{children}</a>
    </Button>
  );
}

function BookingCardBanner({ booking, ownerName }: {
  booking?: BookingCard;
  ownerName?: string;
}) {
  const timeZone = useMemo(() => localTimeZone(), []);
  // Re-render on a slow tick so "in 25 minutes" does not go stale while the
  // guest sits on this page waiting for the hour to come round.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!booking) return null;

  if (booking.state === 'expired') {
    return (
      <p className={cn(BOOKING_CARD, 'border-l-border text-[13px] leading-[1.4] text-muted-foreground')}>
        {t('This invite link has expired. You can still ask to join.')}
      </p>
    );
  }

  const when = booking.startsAt && booking.endsAt
    ? formatRangeWithZone(booking.startsAt, booking.endsAt, timeZone)
    : null;
  const countdown = timeUntilMeeting(booking.startsAt, booking.endsAt, now);
  if (!booking.title && !when && !booking.subject) return null;

  return (
    <div className={BOOKING_CARD}>
      {booking.title && <p className="m-0 text-[15px] leading-[1.3] font-semibold wrap-anywhere text-foreground">{booking.title}</p>}
      {ownerName && <p className="mt-0.5 mb-0 text-[13px] leading-[1.4] text-muted-foreground">with {ownerName}</p>}
      {when && (
        <p className="mt-1 mb-0 text-[13px] leading-[1.4] text-muted-foreground">
          {when}
          {/* How far off, so the guest knows whether to wait or come back:
              "Tuesday … 14:00–15:00 (CEST) · in 3 weeks". */}
          {countdown && (
            <span className="whitespace-nowrap text-foreground before:text-muted-foreground before:content-['_·_']">{countdown}</span>
          )}
        </p>
      )}
      {/* The guest's own words from the booking form — clamped, because it is
          free text and the card is not the place to read an essay. */}
      {booking.subject && (
        <p className="mt-2 mb-0 line-clamp-3 border-t border-border pt-2 text-[13px] leading-[1.45] wrap-anywhere text-foreground/72">{booking.subject}</p>
      )}
      {/* Changing the booking is Core's job, not Meet's — one implementation of
          "move the calendar event and the CRM row", linked to from the one
          surface a guest reliably reaches holding their token. */}
      {(booking.rescheduleUrl || booking.cancelUrl) && (
        <p className="mt-2.5 mb-0 text-xs leading-[1.4] text-muted-foreground">
          {booking.rescheduleUrl && <BookingManageLink href={booking.rescheduleUrl}>{t('Reschedule')}</BookingManageLink>}
          {booking.rescheduleUrl && booking.cancelUrl && <span aria-hidden> · </span>}
          {booking.cancelUrl && <BookingManageLink href={booking.cancelUrl}>{t('Cancel')}</BookingManageLink>}
        </p>
      )}
    </div>
  );
}

/**
 * What the guest will walk in with. Said honestly: the knock goes through with
 * both devices blocked, so "camera and microphone are ready" was a lie for
 * anyone who asked to join without them.
 */
function mediaReadinessLabel(choices: LocalUserChoices | undefined): string {
  const audio = choices?.audioEnabled ?? false;
  const video = choices?.videoEnabled ?? false;
  if (audio && video) return t('Your camera and microphone are ready.');
  if (audio) return t('Your microphone is ready. Your camera is off.');
  if (video) return t('Your camera is ready. Your microphone is off.');
  return t('You will join with your camera and microphone off.');
}

function WaitingRoom({
  room,
  ownerName,
  receipt,
  error,
  reconnecting = false,
  readiness,
  booking,
  onStatus,
  onAdmitted,
  onSessionInvalid,
  onCancel,
}: {
  room: string;
  /** The room owner's display name; empty until the Worker knows it. */
  ownerName: string;
  receipt: LobbyReceipt;
  error: string;
  /** True when reloading with an already-admitted lobby receipt. */
  reconnecting?: boolean;
  /** The lede while waiting — see `mediaReadinessLabel`. */
  readiness: string;
  /** Present only on a token link — the source of the reschedule recourse. */
  booking?: BookingCard;
  onStatus: (status: LobbyStatus, waitingCount?: number) => void;
  onAdmitted: () => Promise<void>;
  /** Lobby credentials are gone (401/404) — drop the ghost waiting UI. */
  onSessionInvalid: () => void;
  /**
   * Withdraw the knock. Same contract as Mac Join and iOS: the poll stops and
   * the guest is back on Prejoin; the lobby row expires on the Worker by
   * itself, so nothing is sent.
   */
  onCancel: () => void;
}) {
  const exchangeStarted = useRef(false);
  const exchangeAttempts = useRef(0);
  const nextExchangeAt = useRef(0);
  const onStatusRef = useRef(onStatus);
  const onAdmittedRef = useRef(onAdmitted);
  const onSessionInvalidRef = useRef(onSessionInvalid);
  const [waitingCount, setWaitingCount] = useState(receipt.waitingCount ?? 1);
  onStatusRef.current = onStatus;
  onAdmittedRef.current = onAdmitted;
  onSessionInvalidRef.current = onSessionInvalid;

  // Refused, expired, or removed: there is no answer left to wait for. Kept
  // above the effect because the poll has to honour it too — this screen used
  // to go on asking every two seconds for as long as the tab stayed open.
  const rejected = receipt.status === 'rejected'
    || receipt.status === 'expired'
    || receipt.status === 'removed';

  // A knock nobody answers used to poll in silence for as long as the tab
  // stayed open, with a spinner that never said anything had gone wrong. After
  // a minute, say so plainly and offer whatever recourse this link carries.
  // Never the owner's address: the guest surface is built to know the owner's
  // display name and nothing more.
  const [unanswered, setUnanswered] = useState(false);
  useEffect(() => {
    if (rejected || reconnecting) return;
    const timer = window.setTimeout(() => setUnanswered(true), WAITING_NO_ANSWER_MS);
    return () => window.clearTimeout(timer);
  }, [rejected, reconnecting]);

  useEffect(() => {
    if (rejected) return;
    let active = true;
    let socket: WebSocket | undefined;
    // Lobby token travels in the Authorization header, not the URL — URLs are
    // captured by traces and proxy logs. (The WebSocket below still uses a
    // query parameter; browsers cannot set headers on WebSocket upgrades.)
    const statusURL = `/rooms/${room}/join-requests/${receipt.requestId}`;

    function handleStatus(status: LobbyStatus, nextWaitingCount?: number) {
      if (!active) return;
      if (typeof nextWaitingCount === 'number') setWaitingCount(nextWaitingCount);
      onStatusRef.current(status, nextWaitingCount);
      if ((status === 'admitted' || status === 'joined') && !exchangeStarted.current) {
        // A failing exchange (host lease lapsed, network) must not hammer the
        // API on every 2s poll: back off exponentially to a 30s ceiling and
        // keep trying for as long as the seat stands. The likeliest cause is a
        // host whose Mac went to sleep — the lease comes back when the Mac
        // does, and giving up for good would strand an admitted guest on a
        // seat the owner already granted. Terminal answers (meeting over,
        // credentials gone) exit through onAdmitted's own handling instead.
        if (Date.now() < nextExchangeAt.current) return;
        exchangeStarted.current = true;
        void onAdmittedRef.current().catch(() => {
          exchangeStarted.current = false;
          exchangeAttempts.current += 1;
          nextExchangeAt.current = Date.now()
            + Math.min(30_000, 2_000 * 2 ** Math.min(exchangeAttempts.current, 4));
        });
      }
    }

    async function poll() {
      try {
        const body = await apiFetch<JoinStatusResponse>(statusURL, {
          token: receipt.lobbyToken,
          noStore: true,
          fallbackError: t('Lobby status unavailable.'),
        });
        handleStatus(body.status, body.waitingCount);
      } catch (reason) {
        // Stale sessionStorage after a Worker/DO reset, or a deleted request —
        // keep polling through transient network errors only. Keyed on the
        // stable code so rewording the server string can't silently strand a
        // guest on a seat that no longer exists.
        if (reason instanceof ControlRequestError && reason.needsRejoin) {
          if (active) onSessionInvalidRef.current();
        }
      }
    }

    const websocketURL = new URL(`${apiBase}/rooms/${room}/lobby/socket`);
    websocketURL.protocol = websocketURL.protocol === 'https:' ? 'wss:' : 'ws:';
    websocketURL.searchParams.set('request_id', receipt.requestId);
    websocketURL.searchParams.set('token', receipt.lobbyToken);
    // The poll is the fallback, not the delivery path — so it runs briskly
    // only while the socket is not carrying status, and drops to a safety net
    // once it is. Re-armed on close, because a dropped socket puts this back
    // in charge of noticing that a guest was admitted.
    let timer: number | undefined;
    let cadence: number | undefined;
    function setCadence(seconds: number) {
      if (!active || cadence === seconds) return;
      cadence = seconds;
      window.clearInterval(timer);
      timer = window.setInterval(() => void poll(), seconds * 1_000);
    }

    try {
      socket = new WebSocket(websocketURL);
      socket.onopen = () => setCadence(LOBBY_SOCKET_POLL_SECONDS);
      socket.onclose = () => setCadence(LOBBY_POLL_SECONDS);
      socket.onerror = () => setCadence(LOBBY_POLL_SECONDS);
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as {
            type?: string;
            status?: LobbyStatus;
            waiting_count?: number;
          };
          if (message.type === 'lobby.status' && message.status) {
            handleStatus(message.status);
          }
          if (message.type === 'lobby.waiting' && typeof message.waiting_count === 'number') {
            setWaitingCount(message.waiting_count);
          }
        } catch {
          // Ignore malformed or newer lobby messages and keep polling.
        }
      };
    } catch {
      // Polling remains available when WebSockets are blocked.
    }
    // Already admitted from a prior visit in this tab — don't wait on poll/WS.
    if (receipt.status === 'admitted' || receipt.status === 'joined') {
      handleStatus(receipt.status, receipt.waitingCount);
    }
    void poll();
    setCadence(LOBBY_POLL_SECONDS);
    return () => {
      active = false;
      window.clearInterval(timer);
      socket?.close();
    };
  }, [receipt.lobbyToken, receipt.requestId, receipt.status, receipt.waitingCount, rejected, room]);

  return (
    <AppShell variant="centered" roomSlug={room}>
      <GuestCard size="status" aria-live="polite">
        {!rejected && <GuestWaitingFlock />}
        <h1>
          {rejected
            ? t('Not admitted')
            : reconnecting
              ? t('Rejoining the meeting…')
              : ownerName ? t('Waiting for {ownerName}', { ownerName }) : t('Waiting to be let in')}
        </h1>
        <p className="lede">
          {rejected
            ? t('The owner declined this request or the meeting ended. You can close this tab.')
            : reconnecting
              ? t('You were already let in — picking up where you left off.')
              : readiness}
        </p>
        {error && <ErrorNotice message={error} />}
        {!rejected && !reconnecting && (
          <>
            <div className="mt-7 flex flex-wrap items-center justify-center gap-2.5">
              <div className="inline-flex items-center gap-2 rounded-full border border-border bg-(--surface-sunken) px-3 py-2 text-xs text-foreground/74">
                <i className="size-[7px] animate-pulse rounded-full bg-(--accent)" /> {t('Knock sent')}
              </div>
              {waitingCount > 1 && (
                <div className="text-xs font-medium tracking-[0.01em] text-foreground/58" aria-live="polite">
                  {waitingCountLabel(waitingCount)}
                </div>
              )}
            </div>
            {/* Shown once a knock has gone a minute without an answer. Calm on
                purpose: nothing has failed, and the guest is still in the queue. */}
            {unanswered && (
              <div className="mt-6 flex flex-col items-center gap-3.5 border-t border-foreground/10 pt-5" role="status">
                <p className="m-0 max-w-[34em] text-[13px] leading-normal text-foreground/62">
                  {t('No answer yet. {owner} may not be at their desk. You can keep waiting, and this page will let you in the moment they answer.', { owner: ownerName || t('The owner') })}
                </p>
                {booking?.state === 'scheduled' && booking.rescheduleUrl && (
                  <Button asChild variant="secondary"><a
                    href={booking.rescheduleUrl}
                  >
                    {t('Pick another time')}
                  </a></Button>
                )}
              </div>
            )}
            {/* No Back here on purpose (docs/SURFACES.md): leaving a knock is
                withdrawing it, so the word is Cancel — the same word Mac Join
                and iOS put on this step. */}
            <Button
              type="button" variant="secondary" className="mt-5"
              onClick={onCancel}
            >
              {t('Cancel request')}
            </Button>
          </>
        )}
      </GuestCard>
    </AppShell>
  );
}

/**
 * How long a knock goes unanswered before the waiting room admits as much.
 * Long enough that a host walking back to their Mac is not told anything is
 * wrong; short enough to beat the point where a guest gives up on their own.
 */
const WAITING_NO_ANSWER_MS = 60_000;

/** Only rendered for a queue — being alone in the waiting room is not worth a line. */
function waitingCountLabel(count: number): string {
  return t('{count} people in the waiting room', { count });
}
