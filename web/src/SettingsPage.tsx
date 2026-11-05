import { SignInGate } from './SignInGate';
import { IOS_DOWNLOAD_URL, MAC_DOWNLOAD_URL } from '@starlings/contracts/deployment';
import { settingsGroups, settingsPages } from '@starlings/contracts/settings-pages';
import { SEARCH_SETTINGS_TITLES } from '@starlings/contracts/search-values';
import { Children, Fragment, isValidElement, useCallback, useEffect, useState, type ReactNode } from 'react';
import { Checkbox } from '@/ui/checkbox';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Button } from '@/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemSeparator, ItemTitle } from '@/ui/item';
import { meetBuild, meetVersion } from 'virtual:meet-version';
import { AppearancePicker, PICKER_LABEL } from './AppearancePicker';
import { ErrorNotice } from './ErrorNotice';
import { useHomeTexture } from './home-texture';
import { ChevronDownIcon, ChevronUpIcon } from './action-icons';
import { apiBase } from './config';
import { signOut } from './owner-local-state';
import {
  calendarConnectHref,
  fetchCalendarConnection,
  fetchCalendarPreferences,
  setUpcomingPreferences,
  upcomingPreferencesFromWire,
  type CalendarConnection,
} from './owner-agenda';
import { DEFAULT_UPCOMING_PREFERENCES, type UpcomingPreferences } from '@starlings/contracts/upcoming';
import { homeModule, moveHomeModule, offeredHomeModules, type HomeModuleID } from '@starlings/contracts/home-layout';
import { useWorkModules } from './work-modules';
import { useHomeLayout } from './home-layout';
import { resolveLanguage, type Language } from '@starlings/contracts/language';
import { workspaceLanguages } from './workspace-defaults';
import { useLanguage } from './language';
import { useOwnerSession } from './owner-session';
import { AppShell, MemberLoadingShell } from './SiteChrome';
import { SectionCard } from './SectionCard';
import { BookingSettingsSection } from './BookingSettings';
import { AvatarControl } from './TeamPage';
import { PeerAvatar } from './PeerAvatar';
import { fetchPeers, relativeTime, type Peer } from './team-presence';
import { fetchSubjectState, setWorkPreferences } from './crm-work';
import { WORK_MODULES, subjectKindShown } from '@starlings/contracts/work-modules';
import type { SubjectKind } from '@starlings/contracts/subject-kinds';
import { INBOX_SOURCE_SPECS, resolveInboxSources } from '@starlings/contracts/inbox-values';
import type { SubjectStateResponse, WorkPreferencesUpdate } from '@starlings/contracts/subject-state';
import type { GoogleGrantProduct, GoogleGrantResponse, OwnerDeviceSummary } from '@starlings/contracts';
import { useOwnerHeartbeat } from './use-owner-heartbeat';
import { MCP_CONNECT_HELP_PATH, mcpAddress, mcpServerName } from '@starlings/contracts/mcp';
import { useDocumentTitle } from './document-title';
import { apiFetch } from './api';
import { languageFor, plural, t, uiLanguage } from './i18n';
import { calendarConnectable, workspaceBrand, workspaceHasDocs } from './workspace-brand';
import { BrowserSaveSection } from './SavePage';
import { WorkspacesSection } from './WorkspacesSection';
import { Spinner } from '@/ui/spinner';
import { cn } from '@/lib/utils';
import { Calendar, CircleUserRound, Contrast, House, Inbox, Info, type LucideIcon } from 'lucide-react';

/**
 * `/settings` — the member's own preferences, reached from the header gear the
 * way iOS reaches its sheet from a toolbar gear and the Mac from ⌘,. Never a
 * tab (docs/AUDIENCES_AND_IA.md).
 *
 * The sections keep the shared vocabulary — Account, Calendar, Appearance,
 * About — and show only what a browser can act on. Audio, video and
 * captions are per-meeting choices here and live in the in-meeting Settings;
 * notifications are local to the native apps, because the web has none.
 */
export function SettingsPage() {
  const session = useOwnerSession();
  useDocumentTitle(t('Settings'));

  if (session.kind === 'loading') return <MemberLoadingShell />;
  if (session.kind === 'visitor') {
    return (
      <SignInGate title={t('Settings')} />
    );
  }

  return <MemberSettings ownerEmail={session.owner.email} ownerName={session.owner.name} isAdmin={session.owner.isAdmin === true} />;
}

function MemberSettings({ ownerEmail, ownerName, isAdmin }: { ownerEmail: string; ownerName: string; isAdmin: boolean }) {
  const [me, setMe] = useState<Peer | undefined>();
  const [calendar, setCalendar] = useState<CalendarConnection | undefined>();
  const [upcoming, setUpcoming] = useState<UpcomingPreferences>(DEFAULT_UPCOMING_PREFERENCES);
  const [upcomingLoaded, setUpcomingLoaded] = useState(false);
  const [savingUpcoming, setSavingUpcoming] = useState(false);
  const [upcomingMessage, setUpcomingMessage] = useState<string | undefined>();
  const [upcomingError, setUpcomingError] = useState<string | undefined>();
  const { layout: homeLayout, save: saveHomeLayout, loaded: homeLayoutLoaded } = useHomeLayout(true);
  const workModules = useWorkModules();
  const offeredModules = offeredHomeModules(homeLayout, workModules ?? undefined);
  const [homeLayoutMessage, setHomeLayoutMessage] = useState<string | undefined>();
  const [savingHomeLayout, setSavingHomeLayout] = useState(false);

  useOwnerHeartbeat(true);

  async function changeHomeLayout(next: typeof homeLayout) {
    setSavingHomeLayout(true);
    setHomeLayoutMessage(undefined);
    try {
      await saveHomeLayout(next);
    } catch (error) {
      setHomeLayoutMessage(error instanceof Error ? error.message : t('Couldn’t save your Home layout.'));
    } finally {
      setSavingHomeLayout(false);
    }
  }

  function moveModule(id: HomeModuleID, direction: 'up' | 'down') {
    void changeHomeLayout(moveHomeModule(homeLayout, id, direction, workModules ?? undefined));
  }

  function toggleModule(id: HomeModuleID, enabled: boolean) {
    void changeHomeLayout(homeLayout.map((row) => (row.id === id ? { ...row, enabled } : row)));
  }

  // Your own roster row is where the picture lives; the same row Team draws.
  const loadMe = useCallback(async () => {
    try {
      const roster = await fetchPeers();
      setMe(roster.peers.find((peer) => peer.is_self));
    } catch {
      // The page still works without a picture control; the name and email
      // come from the session.
    }
  }, []);

  useEffect(() => {
    void loadMe();
    void Promise.all([
      fetchCalendarConnection().catch(() => ({ connected: false })),
      fetchCalendarPreferences().catch(() => undefined),
    ]).then(([connection, preferences]) => {
      setCalendar(connection);
      if (preferences) setUpcoming(upcomingPreferencesFromWire(preferences.upcoming));
      setUpcomingLoaded(true);
    });
  }, [loadMe]);

  async function saveUpcoming() {
    setSavingUpcoming(true);
    setUpcomingMessage(undefined);
    setUpcomingError(undefined);
    try {
      setUpcoming(await setUpcomingPreferences(upcoming));
      setUpcomingMessage(t('Saved across Starlings on Mac, iPhone, and web.'));
    } catch (error) {
      setUpcomingError(error instanceof Error ? error.message : t('Couldn’t save your Upcoming settings.'));
    } finally {
      setSavingUpcoming(false);
    }
  }

  // The cards, by the page each belongs to. Which pages there are and their order come from the
  // table every client reads (`@starlings/contracts/settings-pages`); Devices, Connected agents and
  // Gmail and Drive sit within their page, as on the Mac.
  const pages: Record<string, ReactNode> = {
    account: <>
        <SectionCard id="settings-account" title={t('Account')}>
          <Item className="p-0">
            {me && <ItemMedia><PeerAvatar peer={me} /></ItemMedia>}
            <ItemContent className="gap-0.5">
              <ItemTitle className="text-[15px] font-semibold">{ownerName}</ItemTitle>
              <ItemDescription className="text-xs">{ownerEmail}</ItemDescription>
              {me && <AvatarControl peer={me} onChanged={() => void loadMe()} />}
            </ItemContent>
          </Item>
          <p className={NOTE}>
            Your picture is drawn wherever you appear — the roster, a meeting tile, a message.
          </p>
          <div className={ACTIONS}>
            <Button type="button" variant="secondary" onClick={() => void signOut()}>
              {t('Sign out')}
            </Button>
          </div>
        </SectionCard>

        <WorkspacesSection ownerEmail={ownerEmail} />

        <DevicesSection />

        <ConnectedClaudesSection />

        {workspaceHasDocs() && <BrowserSaveSection />}
        </>,
    home: <>
        <SectionCard id="settings-home" title={t('Home')}>
          <p className={NOTE}>
            {t('Off keeps a module off Home even when it has something to show.')}
          </p>
          <RowList label={t('Home modules')}>
            {offeredModules.map((row, index) => {
              const module = homeModule(row.id);
              const detail = t(module.detail);
              return (
                <Item key={row.id} role="listitem" size="sm" className="flex-nowrap">
                  <CheckLabel
                    checked={row.enabled}
                    disabled={!module.canHide || !homeLayoutLoaded || savingHomeLayout}
                    onCheckedChange={(checked) => toggleModule(row.id, checked)}
                    title={t(module.title)}
                    detail={module.canHide ? detail : t('{detail}. Stays on Home.', { detail })}
                  />
                  <ItemActions className="gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="size-7 rounded-full text-muted-foreground hover:text-foreground"
                      aria-label={t('Move {title} up', { title: t(module.title) })}
                      disabled={row.id === 'recent' || index === 0 || !homeLayoutLoaded || savingHomeLayout}
                      onClick={() => moveModule(row.id, 'up')}
                    >
                      <ChevronUpIcon />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="size-7 rounded-full text-muted-foreground hover:text-foreground"
                      aria-label={t('Move {title} down', { title: t(module.title) })}
                      disabled={row.id === 'recent' || index >= offeredModules.length - 2 || !homeLayoutLoaded || savingHomeLayout}
                      onClick={() => moveModule(row.id, 'down')}
                    >
                      <ChevronDownIcon />
                    </Button>
                  </ItemActions>
                </Item>
              );
            })}
          </RowList>
          {homeLayoutMessage && <ErrorNotice message={homeLayoutMessage} />}
          <div className="grid gap-2.5 border-t pt-1">
            <h3 className="mt-2 mb-0 text-sm font-semibold">{t('Upcoming')}</h3>
            <p className={NOTE}>{t('How many meetings show before the foldout.')}</p>
            {/* The fieldset groups the control for `disabled`; it draws nothing. */}
            <fieldset className="m-0 min-w-0 border-0 p-0" disabled={!upcomingLoaded || savingUpcoming}>
              <Label className="inline-flex items-center gap-2.5 text-[13px] text-muted-foreground font-normal leading-normal">
                <span>{t('Following meetings')}</span>
                <NativeSelect
                  value={upcoming.homeFollowingRows}
                  onChange={(event) => setUpcoming((current) => ({ ...current, homeFollowingRows: Number(event.target.value) }))}
                >
                  {[0, 1, 2, 3, 4].map((count) => (
                    <NativeSelectOption key={count} value={count}>{count === 0 ? t('None') : plural(count, { one: '{count} meeting', other: '{count} meetings' })}</NativeSelectOption>
                  ))}
                </NativeSelect>
              </Label>
            </fieldset>
            <div className={ACTIONS}>
              <Button type="button" variant="secondary" onClick={() => void saveUpcoming()} disabled={!upcomingLoaded || savingUpcoming}>
                {savingUpcoming && <Spinner aria-hidden />}
                {savingUpcoming ? t('Saving…') : t('Save Upcoming settings')}
              </Button>
            </div>
            {upcomingMessage && <p className={NOTE} role="status">{upcomingMessage}</p>}
            {upcomingError && <ErrorNotice message={upcomingError} />}
          </div>
        </SectionCard>
        </>,
    work: <>
        <WorkSettings />
        </>,
    calendar: <>
        <SectionCard id="settings-calendar" title={t('Calendar')}>
          <p className={NOTE}>
            {calendar === undefined
              ? t('Checking your Google Calendar connection…')
              : calendar.connected
                ? `Google Calendar connected${calendar.email ? ` as ${calendar.email}` : ''}. Calendar sources are managed in Starlings on Mac or iPhone.`
                : calendarConnectable()
                  ? t('Google Calendar isn’t connected.')
                  : t('Calendar connects to Google only.')}
          </p>
          <div className={ACTIONS}>
            {calendar?.connected ? (
              <Button asChild variant="secondary"><a href="/calendar">{t('Open Calendar')}</a></Button>
            ) : calendarConnectable() && (
              <Button asChild><a href={calendarConnectHref('/settings#settings-calendar')}>{t('Connect Google Calendar')}</a></Button>
            )}
          </div>
        </SectionCard>

        <BookingSettingsSection calendarConnected={calendar?.connected} />

        <GoogleGrantSection />
        </>,
    appearance: <>
        <SectionCard id="settings-appearance" title={t('Appearance')}>
          <p className={NOTE}>{t('Remembered in this browser only.')}</p>
          <AppearancePicker />
          <HomeTextureToggle />
        </SectionCard>

        {/* The Language card is parked until product-market fit (meet#1111): <LanguagePicker /> stays. */}
        </>,
    about: <>
        <SectionCard id="settings-about" title={t('About')}>
          <p className={NOTE}>
            Starlings {meetVersion}{meetBuild === '0' ? '' : t(' · build {meetBuild}', { meetBuild })}.
          </p>
          <div className={ACTIONS}>
            <Button asChild variant="secondary"><a href={MAC_DOWNLOAD_URL}>{t('Starlings for Mac')}</a></Button>
            <Button asChild variant="secondary"><a href={IOS_DOWNLOAD_URL}>{t('Starlings for iPhone and iPad')}</a></Button>
            {isAdmin && <Button asChild variant="secondary"><a href="/admin">{t('Admin')}</a></Button>}
          </div>
        </SectionCard>
        </>,
  };

  return (
    <AppShell variant="wide" member="home" memberNavCurrent={null}>
      <SettingsShell pages={pages} isAdmin={isAdmin} />
    </AppShell>
  );
}

/**
 * The page list in groups, the selected page beside it: the Mac's sidebar and
 * the iPad's split view. The groups, their pages and order, and the titles are
 * the shared tables (`settings-pages.ts`, `search-values.ts`); only the glyphs
 * are the web's. On a narrow window the list is a strip of pills over the page.
 */
const PAGE_ICONS: Record<string, LucideIcon> = {
  account: CircleUserRound,
  home: House,
  work: Inbox,
  calendar: Calendar,
  appearance: Contrast,
  about: Info,
};

function pageTitle(id: string): string {
  return (SEARCH_SETTINGS_TITLES as Record<string, string>)[id] ?? id;
}

/**
 * Cards that sit inside a page, so an old link to one (`/settings#settings-devices`)
 * opens the page that holds it. A page's own card is `settings-<page>`.
 */
const CARD_PAGES: Record<string, string> = {
  'settings-workspaces': 'account',
  'settings-devices': 'account',
  'settings-claudes': 'account',
  'settings-browser-save': 'account',
  'settings-booking': 'calendar',
  'settings-google': 'calendar',
};

function pageForHash(hash: string, ids: readonly string[]): string | undefined {
  const card = decodeURIComponent(hash.replace(/^#/u, ''));
  if (!card) return undefined;
  const page = CARD_PAGES[card] ?? card.replace(/^settings-/u, '');
  return ids.includes(page) ? page : undefined;
}

function SettingsShell({ pages, isAdmin }: { pages: Record<string, ReactNode>; isAdmin: boolean }) {
  const ids = settingsPages('web').map((page) => page.id).filter((id) => pages[id] !== undefined);
  const [selected, setSelected] = useState(() => pageForHash(window.location.hash, ids) ?? ids[0]);

  // A hash link (Home's gear, the setup checklist, ⌘K) picks the page, then
  // scrolls to the card when it names one inside the page.
  useEffect(() => {
    function follow() {
      const page = pageForHash(window.location.hash, ids);
      if (!page) return;
      setSelected(page);
      const card = window.location.hash.slice(1);
      if (card !== `settings-${page}`) {
        requestAnimationFrame(() => document.getElementById(card)?.scrollIntoView({ block: 'start' }));
      }
    }
    follow();
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
    // `ids` is the same table on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function select(page: string) {
    setSelected(page);
    history.replaceState(null, '', `#settings-${page}`);
    window.scrollTo({ top: 0 });
  }

  const groups = settingsGroups('web')
    .map((row) => ({ ...row, pages: row.pages.map((page) => page.id).filter((id) => ids.includes(id)) }))
    .filter((row) => row.pages.length > 0);

  return (
    <div className="mx-auto grid w-full max-w-[960px] gap-5">
      {/* Settings is *me*; Admin is the workspace's, and only an admin's (docs/ADMIN.md §10). */}
      <div className="mb-1 flex items-center justify-between gap-3">
        <h1 className="m-0">{t('Settings')}</h1>
        {isAdmin && <Button asChild variant="secondary"><a href="/admin">{t('Admin')}</a></Button>}
      </div>
      <div className="grid gap-5 md:grid-cols-[200px_minmax(0,1fr)] md:items-start">
        <nav aria-label={t('Settings pages')} className="md:sticky md:top-4">
          <div className="flex gap-1.5 overflow-x-auto pb-1 md:hidden">
            {ids.map((id) => (
              <PageLink key={id} id={id} selected={id === selected} onSelect={select} pill />
            ))}
          </div>
          <div className="hidden gap-4 md:grid">
            {groups.map((group) => (
              <div key={group.group} className="grid gap-0.5">
                <p className="m-0 px-2.5 pb-1 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                  {t(group.title)}
                </p>
                {group.pages.map((id) => (
                  <PageLink key={id} id={id} selected={id === selected} onSelect={select} />
                ))}
              </div>
            ))}
          </div>
        </nav>
        <div key={selected} className="grid min-w-0 gap-5">
          {selected && pages[selected]}
        </div>
      </div>
    </div>
  );
}

function PageLink({ id, selected, onSelect, pill = false }: {
  id: string;
  selected: boolean;
  onSelect: (id: string) => void;
  pill?: boolean;
}) {
  const Icon = PAGE_ICONS[id] ?? Info;
  return (
    <a
      href={`#settings-${id}`}
      aria-current={selected ? 'page' : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        onSelect(id);
      }}
      className={cn(
        'inline-flex items-center gap-2.5 text-sm font-medium text-muted-foreground no-underline transition-colors hover-lift hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        pill
          ? 'flex-none whitespace-nowrap rounded-full border px-3 py-1.5'
          : 'min-h-9 rounded-md px-2.5 py-1.5',
        selected && (pill ? 'border-foreground bg-popover text-foreground' : 'bg-muted text-foreground'),
      )}
    >
      <Icon className="size-4 flex-none" aria-hidden />
      {t(pageTitle(id))}
    </a>
  );
}

/** A section's quiet line: what the controls around it do. */
const NOTE = 'm-0 text-[13px] leading-normal text-muted-foreground';

/** A row of buttons at the end of a section. */
const ACTIONS = 'flex flex-wrap gap-2.5';

/** A bordered list of setting rows, one hairline between rows. */
function RowList({ label, children }: { label: string; children: ReactNode }) {
  const rows = Children.toArray(children);
  return (
    <ItemGroup aria-label={label} className="rounded-xl border bg-muted">
      {rows.map((row, index) => (
        <Fragment key={isValidElement(row) ? row.key ?? index : index}>
          {index > 0 && <ItemSeparator />}
          {row}
        </Fragment>
      ))}
    </ItemGroup>
  );
}

/** A setting row's title and the line under it. */
function RowText({ title, detail }: { title: ReactNode; detail: ReactNode }) {
  return (
    <ItemContent className="min-w-0 gap-0.5">
      <ItemTitle className="text-[13px] font-semibold">{title}</ItemTitle>
      <ItemDescription className="line-clamp-none text-xs">{detail}</ItemDescription>
    </ItemContent>
  );
}

/** A checkbox and its row text, one label, so the whole text toggles it. */
function CheckLabel({ checked, disabled, onCheckedChange, title, detail }: {
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
  title: ReactNode;
  detail: ReactNode;
}) {
  return (
    <Label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 font-normal leading-normal">
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => onCheckedChange(value === true)} />
      <RowText title={title} detail={detail} />
    </Label>
  );
}

/**
 * Settings › Work, the Mac's and the phone's: which subject kinds you see in
 * Work (; Leads is the old Sales opt-in) and which INBOX sources you
 * want, both kept by the Worker (`hidden_kinds`, `inbox_sources`) so they
 * follow the person to every client. Only kinds whose work module the
 * workspace has on are offered. Star and mute are on each subject's row in
 * Work, not here.
 */
function shownKinds(): Array<{ kind: SubjectKind; title: string; detail: string }> {
  return [
    { kind: 'project', title: t('Projects'), detail: t('Projects in Browse and on your rail.') },
    { kind: 'lead', title: t('Leads'), detail: t('The lead pipeline in Browse, leads on your rail by default, and sales touches in INBOX.') },
    { kind: 'organization', title: t('Organizations'), detail: t('Organizations in Browse and on your rail.') },
    { kind: 'event', title: t('Events'), detail: t('Events in Browse and on your rail.') },
  ];
}

function WorkSettings() {
  const [state, setState] = useState<SubjectStateResponse | undefined>();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    fetchSubjectState()
      .then((loaded) => { if (!cancelled) setState(loaded); })
      .catch((error: unknown) => { if (!cancelled) setMessage(error instanceof Error ? error.message : t('Couldn’t read your Work settings.')); });
    return () => { cancelled = true; };
  }, []);

  /** One write; the row shows the change at once and goes back on failure. */
  async function change(update: WorkPreferencesUpdate, failure: string) {
    if (!state) return;
    const before = state;
    setState({
      ...state,
      ...(update.sales_enabled !== undefined ? { sales_enabled: update.sales_enabled } : {}),
      ...(update.hidden_kinds ? { hidden_kinds: update.hidden_kinds, sales_enabled: !update.hidden_kinds.includes('lead') } : {}),
      ...(update.inbox_sources ? { inbox_sources: update.inbox_sources } : {}),
    });
    setSaving(true);
    setMessage(undefined);
    try {
      setState(await setWorkPreferences(update));
    } catch (error) {
      setState(before);
      setMessage(error instanceof Error ? error.message : failure);
    } finally {
      setSaving(false);
    }
  }

  const sources = resolveInboxSources(state?.inbox_sources);
  const salesEnabled = state?.sales_enabled ?? false;
  // An older Worker sends only the Sales switch: leads, and nothing else hidden.
  const hidden: readonly SubjectKind[] = state?.hidden_kinds ?? (salesEnabled ? [] : ['lead']);
  const workModules = state?.work_modules ?? WORK_MODULES;
  const availableSources = new Set(
    state?.inbox_available_sources ?? INBOX_SOURCE_SPECS.map((spec) => spec.source),
  );

  return (
    <SectionCard id="settings-work" title={t('Work')}>
      <RowList label={t('Show in Work')}>
        {shownKinds().filter((row) => subjectKindShown(row.kind, workModules)).map((row) => (
          <Item key={row.kind} role="listitem" size="sm">
            <CheckLabel
              checked={!hidden.includes(row.kind)}
              disabled={!state || saving}
              onCheckedChange={(checked) => {
                const next = checked ? hidden.filter((kind) => kind !== row.kind) : [...hidden, row.kind];
                void change({ hidden_kinds: next }, t('Couldn’t change {title}.', { title: row.title }));
              }}
              title={row.title}
              detail={row.detail}
            />
          </Item>
        ))}
      </RowList>
      <p className={NOTE}>{t('Star or mute a subject from its row in Work.')}</p>
      <h3 className="mt-2 mb-0 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">{t('Inbox')}</h3>
      <RowList label={t('Inbox')}>
        {INBOX_SOURCE_SPECS.filter((spec) => availableSources.has(spec.source)).map((spec) => (
          <Item key={spec.source} role="listitem" size="sm">
            <CheckLabel
              checked={sources[spec.source]}
              // Sales touches follow the Sales opt-in above.
              disabled={!state || saving || (spec.source === 'sales' && !salesEnabled)}
              onCheckedChange={(checked) => {
                void change({ inbox_sources: { ...(state?.inbox_sources ?? {}), [spec.source]: checked } }, t('Couldn’t change {title}.', { title: spec.title }));
              }}
              title={t(spec.title)}
              detail={t(spec.detail)}
            />
          </Item>
        ))}
      </RowList>
      {message && <ErrorNotice message={message} />}
    </SectionCard>
  );
}

type McpGrant = {
  id: string;
  client_name: string;
  scopes: Array<'read' | 'write'>;
  created_at: number;
  last_call_at: number | null;
  paused_at: number | null;
};

type McpCall = {
  id: string;
  ts: number;
  name: string;
  args: string | null;
  outcome: 'ok' | 'replayed' | 'refused' | 'failed';
  detail: string | null;
};

type OwnerDevice = OwnerDeviceSummary;

/**
 * Devices (docs/ADMIN.md §5a): the person's signed-in Macs and phones, each
 * with a Sign out. The row goes on the Worker, so the device's tokens are
 * refused from its next request — this is the control for a phone that is
 * no longer in your pocket. This browser holds no row and is not listed;
 * Sign out above is its control.
 */
function DevicesSection() {
  const [devices, setDevices] = useState<OwnerDevice[] | undefined>();
  const [message, setMessage] = useState<string | undefined>();

  useEffect(() => {
    apiFetch<{ devices: OwnerDevice[] }>('/auth/devices', { fallbackError: t('Couldn’t load devices.') })
      .then((body) => setDevices(body.devices))
      .catch((cause: unknown) => setMessage(cause instanceof Error ? cause.message : t('Couldn’t load devices.')));
  }, []);

  async function signOutDevice(device: OwnerDevice) {
    setMessage(undefined);
    try {
      const body = await apiFetch<{ devices: OwnerDevice[] }>('/auth/devices/revoke', {
        method: 'POST',
        body: { device_id: device.device_id },
        fallbackError: t('Couldn’t sign that device out.'),
        noStore: true,
      });
      setDevices(body.devices);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : t('Couldn’t sign that device out.'));
    }
  }

  return (
    <SectionCard id="settings-devices" title={t('Devices')}>
      {devices === undefined ? null : devices.length === 0 ? (
        <p className={NOTE}>{t('No Mac or iPhone is signed in.')}</p>
      ) : (
        <RowList label={t('Devices')}>
          {devices.map((device) => (
            <Item key={device.device_id} role="listitem" size="sm">
              <RowText
                title={deviceName(device)}
                detail={<>{deviceKind(device)} · {t('renewed {time}', { time: relativeTime(device.renewed_at) })}</>}
              />
              <ItemActions>
                <Button type="button" variant="secondary" onClick={() => void signOutDevice(device)}>
                  {t('Sign out')}
                </Button>
              </ItemActions>
            </Item>
          ))}
        </RowList>
      )}
      <p className={NOTE}>{t('Lost a phone? Sign it out here. Its session ends at its next request.')}</p>
      {message && <ErrorNotice message={message} />}
    </SectionCard>
  );
}

function deviceName(device: OwnerDevice): string {
  return device.label ?? (device.platform === 'android' ? t('Android phone') : device.client === 'ios' ? 'iPhone' : 'Mac');
}

/** An Android row arrives as `client: ios`, the value shipped apps decode; `platform` names it. */
function deviceKind(device: OwnerDevice): string {
  if (device.platform === 'android') return t('Android phone');
  return device.client === 'ios' ? t('iPhone or iPad') : 'Mac';
}

/**
 * Connected agents (docs/MCP.md §The record): the person's own pairings,
 * each with its scope, its last call, the tail of its record, Pause and
 * Revoke. Same rows as Settings > Account on Mac and iPhone.
 */
const GOOGLE_GRANT_PRODUCTS_SHOWN: Array<{ id: GoogleGrantProduct; name: string }> = [
  { id: 'gmail', name: 'Gmail' },
  { id: 'drive', name: 'Google Drive' },
];

/**
 * Read access to your own Gmail and Drive, for the imports (,
 * docs/CONNECTORS.md). One Google grant holds both: Google revokes a grant
 * whole, so Disconnect takes both products at once.
 */
function GoogleGrantSection() {
  const [status, setStatus] = useState<GoogleGrantResponse | undefined>();
  const [message, setMessage] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      setStatus(await apiFetch<GoogleGrantResponse>('/connectors/google', { fallbackError: t('Couldn’t load connectors.') }));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : t('Couldn’t load connectors.'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function disconnect() {
    setMessage(undefined);
    try {
      setStatus(await apiFetch<GoogleGrantResponse>('/connectors/google/disconnect', { method: 'POST', body: {}, fallbackError: t('Couldn’t disconnect.') }));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : t('Couldn’t disconnect.'));
    }
  }

  // Nothing to offer on a deployment without the connector's Google client.
  if (!status?.configured) return null;
  const granted = new Set(status.grant?.products ?? []);

  return (
    <SectionCard id="settings-google" title={t('Gmail and Drive')}>
      {status.grant && <p className={NOTE}>{t('Read only, as {email}.', { email: status.grant.email })}</p>}
      <RowList label={t('Gmail and Drive')}>
        {GOOGLE_GRANT_PRODUCTS_SHOWN.map((product) => (
          <Item key={product.id} role="listitem" size="sm">
            <RowText title={product.name} detail={granted.has(product.id) ? t('Connected') : t('Not connected')} />
            {!granted.has(product.id) && (
              <ItemActions>
                <Button asChild variant="secondary"><a href={googleGrantHref(product.id)}>
                  {t('Connect')}
                </a></Button>
              </ItemActions>
            )}
          </Item>
        ))}
      </RowList>
      {status.grant && (
        <div className={ACTIONS}>
          <Button type="button" variant="secondary" onClick={() => void disconnect()}>
            {t('Disconnect Gmail and Drive')}
          </Button>
        </div>
      )}
      {message && <ErrorNotice message={message} />}
    </SectionCard>
  );
}

/** Google's consent screen for one product, and back to Settings. The token never reaches the browser. */
function googleGrantHref(product: GoogleGrantProduct): string {
  return `${apiBase}/connectors/google/connect/start?product=${product}&return_to=${encodeURIComponent('/settings#settings-google')}`;
}

function ConnectedClaudesSection() {
  const [grants, setGrants] = useState<McpGrant[] | undefined>();
  const [open, setOpen] = useState<string | undefined>();
  const [calls, setCalls] = useState<Record<string, McpCall[]>>({});
  const [message, setMessage] = useState<string | undefined>();

  const load = useCallback(async () => {
    try {
      const body = await apiFetch<{ grants: McpGrant[] }>('/mcp/grants', { fallbackError: t('Couldn’t load connectors.') });
      setGrants(body.grants);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : t('Couldn’t load connectors.'));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function toggle(id: string) {
    if (open === id) { setOpen(undefined); return; }
    setOpen(id);
    if (!calls[id]) {
      try {
        const body = await apiFetch<{ calls: McpCall[] }>(`/mcp/grants/${encodeURIComponent(id)}/calls`, { fallbackError: t('Couldn’t load calls.') });
        setCalls((current) => ({ ...current, [id]: body.calls }));
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : t('Couldn’t load calls.'));
      }
    }
  }

  // Pause stops the Claude at its next call and keeps the pairing, so Resume
  // needs nothing from Claude's side.
  async function setPaused(id: string, paused: boolean) {
    setMessage(undefined);
    try {
      const body = await apiFetch<{ grants: McpGrant[] }>(`/mcp/grants/${encodeURIComponent(id)}/${paused ? 'pause' : 'resume'}`, {
        method: 'POST',
        body: {},
        fallbackError: paused ? t('Couldn’t pause.') : t('Couldn’t resume.'),
      });
      setGrants(body.grants);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : paused ? t('Couldn’t pause.') : t('Couldn’t resume.'));
    }
  }

  async function revoke(id: string) {
    setMessage(undefined);
    try {
      const body = await apiFetch<{ grants: McpGrant[] }>(`/mcp/grants/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: {}, fallbackError: t('Couldn’t revoke.') });
      setGrants(body.grants);
      if (open === id) setOpen(undefined);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : t('Couldn’t revoke.'));
    }
  }

  return (
    <SectionCard id="settings-claudes" title={t('Connected agents')}>
      {grants === undefined ? null : grants.length === 0 ? (
        <p className={NOTE}>{t('None.')}</p>
      ) : (
        <RowList label={t('Connected agents')}>
          {grants.map((grant) => (
            <Collapsible key={grant.id} asChild open={open === grant.id} onOpenChange={() => void toggle(grant.id)}>
            <Item role="listitem" size="sm">
              <CollapsibleTrigger className="-m-2 flex min-w-0 flex-1 cursor-pointer rounded-md border-0 bg-transparent p-2 text-left text-inherit hover-lift [font:inherit]">
                <RowText
                  title={grant.client_name}
                  detail={<>
                    {grant.paused_at != null && `${t('Paused')} · `}
                    {grant.scopes.includes('write') ? t('Reads and writes') : t('Reads')}
                    {grant.last_call_at ? ` · ${relativeTime(grant.last_call_at)}` : ' · no calls yet'}
                  </>}
                />
              </CollapsibleTrigger>
              <ItemActions>
                <Button type="button" variant="secondary" onClick={() => void setPaused(grant.id, grant.paused_at == null)}>
                  {grant.paused_at == null ? t('Pause') : t('Resume')}
                </Button>
                <Button type="button" variant="secondary" onClick={() => void revoke(grant.id)}>
                  {t('Revoke')}
                </Button>
              </ItemActions>
              <CollapsibleContent asChild>
                <ol className="m-0 grid basis-full list-none gap-1.5 p-0 text-xs">
                  {(calls[grant.id] ?? []).map((call) => (
                    <li key={call.id} className="grid grid-cols-[auto_1fr_auto] items-baseline gap-2.5 text-muted-foreground">
                      <code className="text-foreground">{call.name}</code>
                      <span className="truncate">{call.args ?? ''}</span>
                      <small>{call.outcome === 'ok' ? relativeTime(call.ts) : `${call.outcome}${call.detail ? ` · ${call.detail}` : ''}`}</small>
                    </li>
                  ))}
                  {calls[grant.id]?.length === 0 && <li className="text-muted-foreground"><small>{t('No calls yet.')}</small></li>}
                </ol>
              </CollapsibleContent>
            </Item>
            </Collapsible>
          ))}
        </RowList>
      )}
      <ConnectorAddressRow />
      {message && <ErrorNotice message={message} />}
    </SectionCard>
  );
}

/**
 * The name and the address a member gives Claude or any MCP client, each with
 * Copy, and the help page that says where to add them. The name is the one
 * the server gives itself, so two connected workspaces read apart. The same
 * rows on Mac and iPhone.
 */
function ConnectorAddressRow() {
  return (
    <>
      <CopyValueRow title={t('Connector name')} value={mcpServerName(workspaceBrand().name)} />
      <CopyValueRow
        title={t('Connector address')}
        value={mcpAddress(window.location.origin)}
        extra={<Button asChild variant="secondary"><a href={MCP_CONNECT_HELP_PATH}>{t('How to connect Claude')}</a></Button>}
      />
    </>
  );
}

function CopyValueRow({ title, value, extra }: { title: string; value: string; extra?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  function copy() {
    setFailed(false);
    navigator.clipboard.writeText(value).then(() => setCopied(true), () => setFailed(true));
  }
  return (
    <>
    <Item size="sm" className="p-0">
      <RowText title={title} detail={<code className="break-all">{value}</code>} />
      <ItemActions>
        <Button type="button" variant="secondary" onClick={copy}>
          {copied ? t('Copied') : t('Copy')}
        </Button>
        {extra}
      </ItemActions>
    </Item>
    {failed && <ErrorNotice message={t('Couldn’t copy it.')} />}
    </>
  );
}

/** The Mac's and iOS's Grid texture switch, for this browser (#230). */
/**
 * The owner-synced language choice. The select shows the cached
 * value at once, the Worker's answer replaces it, and a failed save puts
 * the old choice back where the change was made.
 */
function LanguagePicker() {
  const { language, save, loaded } = useLanguage(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | undefined>();
  const labels: Record<Language, string> = { en: t('English'), 'pt-BR': t('Português') };

  async function change(next: Language | null) {
    setSaving(true);
    setMessage(undefined);
    try {
      const saved = await save(next);
      // The page drew in one language and now holds another: reload, the
      // web's version of the native restart.
      if (languageFor(saved) !== uiLanguage) window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('Couldn’t save your language.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Label className={PICKER_LABEL} htmlFor="site-language">
        <span>{t('Language')}</span>
        <NativeSelect
          id="site-language"
          className="py-0"
          value={language ?? ''}
          disabled={!loaded || saving}
          onChange={(event) => { void change(resolveLanguage(event.target.value)); }}
          aria-label={t('Language')}
        >
          <NativeSelectOption value="">{t('System')}</NativeSelectOption>
          {workspaceLanguages().map((option) => (
            <NativeSelectOption key={option} value={option}>{labels[option]}</NativeSelectOption>
          ))}
        </NativeSelect>
      </Label>
      {message && <ErrorNotice message={message} />}
    </>
  );
}

function HomeTextureToggle() {
  const [shows, setShows] = useHomeTexture();
  return (
    <RowList label={t('Grid texture')}>
      <Item role="listitem" size="sm">
        <CheckLabel
          checked={shows}
          onCheckedChange={setShows}
          title={t('Grid texture')}
          detail={t('A faint square grid behind Home and the meeting Stage.')}
        />
      </Item>
    </RowList>
  );
}
