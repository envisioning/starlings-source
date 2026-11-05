import { MEMBER_SURFACES, type MemberSurfaceId } from '@starlings/contracts/member-surfaces';
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { CHROME_ICON_BUTTON } from './chrome-classes';
import { PRODUCT_DESTINATIONS, PRODUCT_INTEREST_PATH, type ProductDestination } from '@starlings/contracts/paths';
import {
  CalendarIcon,
  DocsIcon,
  WorkspaceMark,
  GearIcon,
  HelpIcon,
  HomeIcon,
  MegaphoneIcon,
  NoteIcon,
  ChartIcon,
  SearchIcon,
  TeamIcon,
  WorkIcon,
} from './action-icons';
import { openSearchPalette } from './search-doors';
import { SearchPaletteHost } from './SearchPaletteHost';
import { HomeGridBackground } from './HomeGridBackground';
import { t } from './i18n';
import { workspaceBrand } from './workspace-brand';
import { useVisibleSurfaces } from './calendar-sources';
import { useOwnerSession, wasMember } from './owner-session';
import { signOut } from './owner-local-state';
import { preloadPath, usePendingPath } from './navigation';
import { LoadingIndicator } from '@/ui/spinner';
import { PlaceholderRows } from '@/ui/placeholder-rows';
import { useHelpUnread } from './help-status';
import { onOpenHelp, openHelp } from './help-bus';

// Radix Tooltip must stay off the guest entry and App's static graph
// (web/vite.config.ts). The header's icon controls show only to members, so
// their tooltips load on demand: the control renders bare until Tip arrives.
const LazyTip = lazy(async () => ({ default: (await import('./Tip')).Tip }));
// The workspace badge's menu is Radix too: a member sees the plain brand
// until it arrives.
const LazyWorkspaceSwitcher = lazy(async () => ({ default: (await import('./WorkspaceSwitcher')).WorkspaceSwitcher }));

function ChromeTip({ label, children }: { label: string; children: ReactElement }) {
  return <Suspense fallback={children}><LazyTip label={label}>{children}</LazyTip></Suspense>;
}

/**
 * `app` is the member workspace (Calendar, Work, Team, Docs): the page is the
 * window, edge to edge, the way the Mac app is. `wide` keeps the 1152px
 * column for pages that read as pages, Home included. The header and the
 * footer span the window on every variant.
 */
type ShellVariant = 'centered' | 'wide' | 'app' | 'document';

/**
 * The page column under the header, per variant. At 640px and narrower the
 * side padding drops to 16px, except on a full-width editorial page, which
 * scales its own.
 */
function shellBodyClass(variant: ShellVariant, fullWidth: boolean): string {
  if (variant === 'app') return 'w-full pt-5 pb-6 px-6 [@media(max-width:640px)]:px-4';
  if (variant === 'wide') {
    return fullWidth
      ? 'mx-auto w-full pt-8 pb-10 px-[clamp(16px,3.4vw,72px)]'
      : 'mx-auto w-full max-w-[1152px] pt-8 pb-10 px-6 [@media(max-width:640px)]:px-4';
  }
  if (variant === 'document') return 'items-center py-10 px-6 [@media(max-width:640px)]:px-4';
  return 'items-center justify-center py-10 px-6 [@media(max-width:640px)]:px-4';
}

/** A footer link: muted, ink and underlined under the pointer, ink for the page you are on. */
function footerLinkClass(current = false): string {
  return cn(
    'h-auto gap-[5px] rounded-sm p-0 text-[length:inherit] font-normal text-muted-foreground underline-offset-[3px] has-[>svg]:px-0 hover:text-foreground',
    current && 'text-foreground hover:no-underline',
  );
}
/**
 * Footer state: which of the two legal documents is on screen. The other
 * values mark pages that are neither.
 */
type SiteCurrent = 'join' | 'privacy' | 'terms' | 'help' | 'meeting';

/**
 * The member workspace destinations, in the order the iOS tab bar shows them
 * and answering the same questions: Home *today*, Calendar *when*, Work *what*,
 * Team *who*, Docs *what was written*. Home also owns the room/Meet experience. Anything the web gains
 * later joins this list rather than arriving as a different kind of link
 * somewhere else on the page.
 *
 * Settings is deliberately absent: it is reached from chrome on every client,
 * never from the tab bar.
 */
export type MemberDestination = MemberSurfaceId;
export type MemberNavUnread = Partial<Record<MemberDestination, number>>;

const MEMBER_ICON: Record<MemberDestination, ReactNode> = {
  home: <HomeIcon />, calendar: <CalendarIcon />, work: <WorkIcon />, team: <TeamIcon />, docs: <DocsIcon />,
};
/** The surfaces, their order, words and paths are the contract's (`member-surfaces.ts`). */
const MEMBER_NAV: Array<{ id: MemberDestination; label: string; href: string; icon: ReactNode }> = MEMBER_SURFACES.map((surface) => ({
  id: surface.id, label: t(surface.title), href: surface.path, icon: MEMBER_ICON[surface.id],
}));

/** `/help/surfaces/<id>` for the destination on screen; Settings for a page with none; the index otherwise. */
/**
 * The header's Help button, the dot for an unread reply, and the Help panel,
 * loaded on first open: the header is on the guest entry path, and the panel's
 * Radix parts belong to lazy surfaces only.
 */
function HelpButton({ pageHelpHref }: { pageHelpHref: string }) {
  const [unread, refresh] = useHelpUnread();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  useEffect(() => onOpenHelp((detail) => {
    setConversationId(detail.conversationId ?? null);
    setLoaded(true);
    setOpen(true);
  }), []);
  // An INBOX row opens Help on its conversation by address (`?help=<id>`).
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('help');
    if (id === null) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('help');
    window.history.replaceState(window.history.state, '', url);
    openHelp(id ? { conversationId: id } : {});
  }, []);
  return (
    <>
      <ChromeTip label={unread > 0 ? t('Help · Starlings support replied') : t('Help')}><Button
        type="button"
        variant="ghost" size="icon" className={cn(CHROME_ICON_BUTTON, 'relative')}
        aria-label={unread > 0 ? t('Help, Starlings support replied') : t('Help')}
        onClick={() => openHelp()}
      >
        <HelpIcon />
        {unread > 0 && <span aria-hidden className="absolute top-1.5 right-1.5 size-2 rounded-full bg-(--accent)" />}
      </Button></ChromeTip>
      {loaded && (
        <Suspense fallback={null}>
          <LazyHelpPanel pageHelpHref={pageHelpHref} open={open} conversationId={conversationId} onOpenChange={setOpen} onChanged={refresh} />
        </Suspense>
      )}
    </>
  );
}

const LazyHelpPanel = lazy(() => import('./HelpPanel'));

function helpHref(destination: MemberDestination | null | undefined): string {
  if (destination) return `/help/surfaces/${destination}`;
  if (window.location.pathname.replace(/\/$/u, '') === '/settings') return '/help/surfaces/settings';
  if (window.location.pathname.startsWith('/admin')) return '/help/surfaces/admin';
  return '/help';
}

/**
 * The product site's nav: the same object as the member nav, second instance
 * (docs/AUDIENCES_AND_IA.md §Prospect). The rows come from the contract that
 * also drives the router and the Worker allowlist; the icons are the web's.
 */
const PRODUCT_ICONS: Record<ProductDestination, ReactNode> = {
  why: <MegaphoneIcon />,
  features: <WorkIcon />,
  pricing: <ChartIcon />,
  changelog: <NoteIcon />,
};

const PRODUCT_NAV: Array<{ id: ProductDestination; label: string; href: string; icon: ReactNode }> = PRODUCT_DESTINATIONS.map((d) => ({
  id: d.id,
  label: t(d.label),
  href: d.path,
  icon: PRODUCT_ICONS[d.id],
}));

type AppShellProps = {
  children: ReactNode;
  variant?: ShellVariant;
  roomSlug?: string;
  startAction?: ReactNode;
  brandHref?: string;
  current?: SiteCurrent;
  /**
   * Which member destination this page is. Present only for a signed-in
   * Envisioning member: a visitor has no workspace to tab between, and a nav
   * that can only ask them to sign in describes a product they are not using.
   */
  member?: MemberDestination;
  /**
   * Active workspace destination. Settings keeps the member chrome visible,
   * but has no active workspace destination of its own.
   */
  memberNavCurrent?: MemberDestination | null;
  /**
   * Unread counts on the member nav's tabs. Home sets Work and Team, the way
   * the Mac's window switcher carries them; a page without counts omits it.
   */
  memberNavUnread?: MemberNavUnread;
  /** The surface's one `+` (`SurfaceCreate`), in the header beside Search. */
  create?: ReactNode;
  /** The selected surface's inspector toggle, beside its other workspace controls. */
  rightSidebarToggle?: ReactNode;
  /** Let editorial pages use the full viewport width for their visual grid. */
  fullWidth?: boolean;
  /**
   * Above the phone the page takes the viewport and does not scroll; the
   * surface shell's columns scroll themselves (`SurfaceShell`).
   */
  fill?: boolean;
  /**
   * Which product-site page this is. Present on every page behind the join —
   * why, features, pricing, changelog, interest, privacy, terms — whatever
   * session the browser has: a product URL is a prospect's intent, and intent
   * wins over identity. `null` for a product page that is no tab (Interest,
   * the legal documents), the way Settings sits under the member nav.
   */
  product?: ProductDestination | null;
};

type ChromeConfig = Omit<AppShellProps, 'children'>;
type ChromeSlot = {
  show(owner: string, config: ChromeConfig): void;
  clear(owner: string): void;
};

/**
 * Set by `ChromeFrame`. An `AppShell` under it hands its chrome up rather than
 * drawing it, so the header survives the page changing under it.
 */
const ChromeSlotContext = createContext<ChromeSlot | null>(null);

/** The window around the page: outer frame, per variant. */
function shellFrameClass(variant: ShellVariant, fill: boolean): string {
  return cn(
    // `app-shell` and `app-shell--document` are hooks for the global
    // selection and cursor rules in styles.css, which are not layout.
    'app-shell relative isolate flex min-h-screen flex-col bg-background',
    variant === 'document' && 'app-shell--document',
    fill && 'min-[761px]:h-dvh',
  );
}

/** What sits above the page: the skip link, Home's grid, and the header. */
function ShellLead({ config, navCurrent, pageNav }: {
  config: ChromeConfig;
  navCurrent: MemberDestination | null | undefined;
  /** The page's own destination; Home's grid follows the page, not the click. */
  pageNav: MemberDestination | null | undefined;
}) {
  const { roomSlug, startAction, brandHref = '/', member, memberNavUnread, create, rightSidebarToggle, product } = config;
  return (
    <>
      <Button asChild className="absolute top-2 left-2 z-100 h-auto -translate-y-[200%] rounded-[var(--radius-control)] px-3.5 py-2 font-semibold focus-visible:translate-y-0">
        <a href="#content">{t('Skip to content')}</a>
      </Button>
      {pageNav === 'home' && <HomeGridBackground />}
      <SiteHeader
        roomSlug={roomSlug}
        startAction={startAction}
        brandHref={brandHref}
        member={member}
        memberNavCurrent={navCurrent}
        memberNavUnread={memberNavUnread}
        create={create}
        rightSidebarToggle={rightSidebarToggle}
        product={product}
      />
    </>
  );
}

/** What sits below the page: the footer, the phone's tab bar, and ⌘K. */
function ShellTail({ config, navCurrent, productCurrent }: {
  config: ChromeConfig;
  navCurrent: MemberDestination | null | undefined;
  productCurrent: ProductDestination | null | undefined;
}) {
  const { current, member, memberNavUnread, product, fill = false } = config;
  const productSite = product !== undefined;
  return (
    <>
      {/* A window that fills has no page end to close: above the phone the
          footer gives its height back to the columns. */}
      <SiteFooter current={current} member={Boolean(member)} bottomBar={Boolean(member) || productSite} className={fill ? 'min-[761px]:hidden' : undefined} />
      {member && <MemberNav current={navCurrent} unread={memberNavUnread} />}
      {productSite && <ProductNav current={productCurrent} />}
      {member && <SearchPaletteHost />}
    </>
  );
}

/** The tab a page is on, or the one a click is loading. */
function pendingDestination<ID extends string>(
  items: ReadonlyArray<{ id: ID; href: string }>,
  pending: string | null,
): ID | undefined {
  if (!pending) return undefined;
  const path = pending.replace(/\/$/u, '') || '/';
  return items.find((item) => (item.href === '/' ? path === '/' : path === item.href || path.startsWith(`${item.href}/`)))?.id;
}

/**
 * The one header of the document. App draws it once around every page; each
 * page's `AppShell` says what it should show. Switching Home, Calendar, Work,
 * Team or Docs swaps the page under it and leaves the header where it is, the
 * way a tab bar in the Mac or iOS app stays put.
 *
 * Before any page has said anything the frame draws nothing of its own, so a
 * page with no shell (a meeting, a loading door) looks as it always did.
 */
export function ChromeFrame({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<{ owner: string; config: ChromeConfig } | null>(null);
  const pending = usePendingPath();
  const slot = useMemo<ChromeSlot>(() => ({
    show: (owner, config) => setShown({ owner, config }),
    clear: (owner) => setShown((currentShown) => (currentShown?.owner === owner ? null : currentShown)),
  }), []);
  const config = shown?.config ?? null;
  const member = Boolean(config?.member);

  // Once the workspace tabs are on screen, fetch their pages while the
  // browser is idle, so the first tap on each draws in one frame.
  useEffect(() => {
    if (!member) return;
    const warm = () => { for (const item of MEMBER_NAV) preloadPath(item.href); };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(warm, { timeout: 4000 });
      return () => window.cancelIdleCallback(handle);
    }
    const handle = window.setTimeout(warm, 1500);
    return () => window.clearTimeout(handle);
  }, [member]);

  const pageNav = config && (config.memberNavCurrent === undefined ? config.member : config.memberNavCurrent);
  const navCurrent = (config?.member && pendingDestination(MEMBER_NAV, pending)) || pageNav;
  const productCurrent = (config && config.product !== undefined && pendingDestination(PRODUCT_NAV, pending)) || config?.product;

  return (
    <ChromeSlotContext.Provider value={slot}>
      {/* The page keeps its place among these children whether or not a
          header is drawn, so a page that gains its shell is not remounted. */}
      <div className={config ? shellFrameClass(config.variant ?? 'centered', config.fill ?? false) : 'contents'}>
        {config && <ShellLead config={config} navCurrent={navCurrent} pageNav={pageNav} />}
        {children}
        {config && <ShellTail config={config} navCurrent={navCurrent} productCurrent={productCurrent} />}
      </div>
    </ChromeSlotContext.Provider>
  );
}

export function AppShell({ children, ...config }: AppShellProps) {
  const slot = useContext(ChromeSlotContext);
  const owner = useId();
  const { variant = 'centered', fullWidth = false, fill = false } = config;

  // Under a ChromeFrame: hand the chrome up before paint, every render, since
  // `create` and the sidebar toggle carry the page's current state.
  useLayoutEffect(() => {
    slot?.show(owner, config);
  });
  useLayoutEffect(() => () => slot?.clear(owner), [slot, owner]);

  const body = (
    <div className={cn('relative z-1 flex min-w-0 flex-1 flex-col focus:outline-none', shellBodyClass(variant, fullWidth), fill && 'min-[761px]:min-h-0')} id="content" tabIndex={-1}>{children}</div>
  );
  if (slot) return body;

  // No frame (a test rendering one page): draw the whole window here.
  const navCurrent = config.memberNavCurrent === undefined ? config.member : config.memberNavCurrent;
  return (
    <div className={shellFrameClass(variant, fill)}>
      <ShellLead config={config} navCurrent={navCurrent} pageNav={navCurrent} />
      {body}
      <ShellTail config={config} navCurrent={navCurrent} productCurrent={config.product} />
    </div>
  );
}

/**
 * The shell a member page shows while it asks who is signed in. A browser that
 * was a member last time gets the workspace header at once, so the tabs do not
 * appear a moment after the page; anyone else gets the plain wait.
 */
export function MemberLoadingShell({ label }: { label?: string }) {
  if (!wasMember()) return <LoadingIndicator placement="full-page" label={label} />;
  return (
    <AppShell variant="wide" member="home" memberNavCurrent={null}>
      <PlaceholderRows count={5} label={label ?? t('Opening…')} />
    </AppShell>
  );
}

export function SiteHeader({
  roomSlug,
  startAction,
  brandHref = '/',
  member,
  memberNavCurrent,
  memberNavUnread,
  create,
  rightSidebarToggle,
  product,
}: {
  roomSlug?: string;
  startAction?: ReactNode;
  brandHref?: string;
  member?: MemberDestination;
  memberNavCurrent?: MemberDestination | null;
  memberNavUnread?: MemberNavUnread;
  create?: ReactNode;
  rightSidebarToggle?: ReactNode;
  product?: ProductDestination | null;
}) {
  return (
    <header className="relative z-2 cursor-default [view-transition-name:meet-header] border-b border-border bg-[color-mix(in_srgb,var(--surface-bg)_92%,transparent)] backdrop-blur-[10px] select-none">
      <div className="flex min-h-[72px] w-full items-center gap-4 px-6 [@media(max-width:640px)]:px-4">
        <div className="flex min-w-0 items-center gap-3.5">
          {startAction}
          {member
            ? <Suspense fallback={<SiteBrand href={brandHref} />}><LazyWorkspaceSwitcher /></Suspense>
            : <SiteBrand href={brandHref} signedOut />}
          {roomSlug && (
            <span className="max-w-[12rem] overflow-hidden rounded-full border border-border bg-muted px-2.5 py-1 text-[11px] font-[560] tracking-[0.06em] text-ellipsis whitespace-nowrap text-[var(--text-muted)] uppercase [@media(max-width:760px)]:hidden">
              {roomSlug}
            </span>
          )}
        </div>
        {member && <MemberNav current={memberNavCurrent} unread={memberNavUnread} placement="header" />}
        {product !== undefined && <ProductNav current={product} placement="header" />}
        {product !== undefined && <ProductAction />}
        {/* The surface's `+` sits first in the trailing run — create, the
            inspector toggle when available, then Search, Help and Settings.
            On a phone the nav becomes the bottom bar and the run moves to the
            trailing edge. */}
        {member && (
          <div className="ml-1 flex items-center gap-5 [@media(max-width:720px)]:ml-auto">
            {/* Fixed seats, filled or not: a page without a `+` or an
                inspector leaves its seat empty, so Search, Help, Settings
                and the tabs stay put when the page under them changes. At
                720px and narrower the tabs are the bottom bar, nothing here
                can move them, and the seats fold away. */}
            <span className="flex size-9 flex-none items-center justify-center [@media(max-width:720px)]:contents">{create}</span>
            <span className="flex size-9 flex-none items-center justify-center [@media(max-width:720px)]:contents">{rightSidebarToggle}</span>
            {/* Search is chrome too (meet#174 decision 14): the same palette ⌘K
                opens, for a pointer or a phone. It sits beside Settings, outside
                the nav, so it is on every member page and never a tab. */}
            <ChromeTip label={t('Search anything (⌘K)')}><Button
              type="button"
              variant="ghost" size="icon" className={CHROME_ICON_BUTTON}
              aria-label={t('Search anything')}
              onClick={() => openSearchPalette()}
            >
              <SearchIcon />
            </Button></ChromeTip>
            {/* Help opens the Help panel (meet#994). Its first link is still the
                reference page for the surface you are on (docs/DOCUMENTATION.md
                decision 6, meet#270); the panel adds search and Starlings
                support. A dot says Starlings support replied (meet#995). */}
            <HelpButton pageHelpHref={helpHref(memberNavCurrent === undefined ? member : memberNavCurrent)} />
            {/* Settings is chrome, never a tab — the gear iOS puts in its toolbar
                and the Mac puts behind ⌘,. Outside the nav so it survives the
                phone layout, where the nav becomes a bottom bar. */}
            <ChromeTip label={t('Settings')}><Button asChild variant="ghost" size="icon" className={CHROME_ICON_BUTTON}><a
              href="/settings"
              aria-label={t('Settings')}
              aria-current={window.location.pathname.replace(/\/$/u, '') === '/settings' ? 'page' : undefined}
            >
              <GearIcon />
            </a></Button></ChromeTip>
          </div>
        )}
      </div>
    </header>
  );
}

/**
 * The workspace switcher. Rendered twice and shown once: in the header where
 * there is room for it, and as a bottom bar on a phone — the shape these
 * destinations already have on iOS. Plain links, because each one is a real
 * address somebody can bookmark, share, or open in a second tab.
 */
function MemberNav({ current, unread, placement = 'bar' }: {
  current?: MemberDestination | null;
  unread?: MemberNavUnread;
  placement?: 'header' | 'bar';
}) {
  // A destination with nothing to show is not listed; its address still opens.
  const visible = useVisibleSurfaces();
  const items = MEMBER_NAV.filter((item) => visible.has(item.id));
  return <DestinationNav label={t('Workspace')} items={items} current={current} unread={unread} placement={placement} />;
}

/**
 * The product site's switcher: the member nav's shape, with the contract's
 * rows. Header where there is room, bottom bar on a phone. Plain links,
 * because each is an address a prospect forwards to a colleague.
 */
function ProductNav({ current, placement = 'bar' }: {
  current?: ProductDestination | null;
  placement?: 'header' | 'bar';
}) {
  return <DestinationNav label={t('Product')} items={PRODUCT_NAV} current={current} placement={placement} />;
}

/**
 * The switcher both navs draw: Button links, not a Radix NavigationMenu,
 * because SiteChrome is on App's static graph (web/vite.config.ts).
 * `aria-current` marks the page and draws the current state. At 720px and
 * narrower the header copy hides and the bar copy shows, fixed at the bottom
 * where a thumb is.
 */
function DestinationNav<ID extends string>({ label, items, current, unread, placement }: {
  label: string;
  items: ReadonlyArray<{ id: ID; label: string; href: string; icon: ReactNode }>;
  current?: ID | null;
  unread?: Partial<Record<ID, number>>;
  placement: 'header' | 'bar';
}) {
  const bar = placement === 'bar';
  return (
    <nav
      className={bar
        ? 'hidden select-none justify-around [view-transition-name:meet-tabbar] border-t border-border bg-[color-mix(in_srgb,var(--surface-bg)_94%,transparent)] px-2 pt-1.5 pb-[calc(6px+env(safe-area-inset-bottom))] backdrop-blur-[10px] [@media(max-width:720px)]:fixed [@media(max-width:720px)]:inset-x-0 [@media(max-width:720px)]:bottom-0 [@media(max-width:720px)]:z-3 [@media(max-width:720px)]:flex'
        : 'ml-auto flex select-none items-center gap-1 [@media(max-width:720px)]:hidden'}
      aria-label={label}
    >
      {items.map((item) => {
        const count = unread?.[item.id] ?? 0;
        return (
        <Button
          key={item.id}
          asChild
          variant="ghost"
          className={bar
            ? 'h-auto flex-1 flex-col gap-[3px] rounded-xl px-1 py-1.5 text-[11px] text-muted-foreground no-underline hover:text-foreground aria-[current=page]:text-primary'
            : 'h-auto rounded-full px-3.5 py-2 text-sm text-muted-foreground no-underline hover:text-foreground aria-[current=page]:bg-popover aria-[current=page]:text-primary'}
        >
          <a
            href={item.href}
            aria-current={item.id === current ? 'page' : undefined}
            aria-label={count > 0 ? t('{label}, {count} unread', { label: item.label, count }) : undefined}
          >
            <span className="relative inline-flex items-center" aria-hidden="true">
              {item.icon}
              {/* Tab bar: a chip on the icon's corner, ringed in the bar's colour so it reads as separate. */}
              {bar && count > 0 && (
                <span className="absolute -top-1.5 -right-3 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums ring-2 ring-background">
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </span>
            <span>{item.label}</span>
            {/* Top nav: a pill after the label, in flow, so it never covers the icon or the word. */}
            {!bar && count > 0 && (
              <span aria-hidden="true" className="min-w-4 rounded-full bg-primary px-1 text-center text-[10px] leading-4 font-semibold text-primary-foreground tabular-nums">
                {count > 99 ? '99+' : count}
              </span>
            )}
          </a>
        </Button>
        );
      })}
    </nav>
  );
}

/**
 * The product site's one action, in the seat Search and Settings have for a
 * member. A prospect is asked to run Meet; a signed-in member reading the
 * same page is offered the way back into the workspace instead — the nav
 * stays the product's, because the URL said what they came for.
 */
function ProductAction() {
  const session = useOwnerSession();
  const member = session.kind === 'owner';
  return (
    <Button
      asChild
      variant={member ? 'outline' : 'default'}
      className={cn(
        'ml-2 h-auto rounded-full px-3.5 py-2 text-[14px] font-semibold',
        '[@media(max-width:720px)]:ml-auto [@media(max-width:720px)]:px-3 [@media(max-width:720px)]:py-1.5 [@media(max-width:720px)]:text-[13px]',
        member
          ? 'border-border bg-popover text-foreground shadow-none dark:border-border dark:bg-popover'
          : 'bg-[var(--accent)] text-[var(--surface-bg)] hover:bg-(--accent-hover)',
      )}
    >
      <a href={member ? '/' : PRODUCT_INTEREST_PATH}>
        {member ? t('Open Starlings') : t('Ask about a pilot')}
      </a>
    </Button>
  );
}

/**
 * A rule closes the page, then Privacy and Terms, and Sign out under them
 * for a member. The version lives in Settings, About. `bottomBar` clears
 * the phone's fixed nav bar, so nothing ends up underneath it.
 */
export function SiteFooter({ current, member = false, bottomBar = false, className }: {
  current?: SiteCurrent;
  className?: string;
  member?: boolean;
  bottomBar?: boolean;
} = {}) {
  return (
    <footer className={cn(
      'relative z-2 mt-6 grid w-full cursor-default justify-items-center gap-2.5 border-t border-border px-6 pt-6 pb-10 text-[12px] leading-[1.45] text-muted-foreground select-none',
      '[@media(max-width:640px)]:gap-2 [@media(max-width:640px)]:px-4 [@media(max-width:640px)]:pt-5',
      bottomBar
        ? '[@media(max-width:720px)]:pb-[calc(76px+env(safe-area-inset-bottom))]'
        : '[@media(max-width:640px)]:pb-8',
      className,
    )}>
      <SiteFooterNav current={current} />
      {member ? <FooterSignOut /> : <SessionFooterSignOut />}
    </footer>
  );
}

/** Sign out sits next to the product link, for a signed-in member only. */
function FooterSignOut() {
  return (
    <Button
      type="button"
      variant="link"
      className={cn(footerLinkClass(), 'text-[color:var(--footer-meta-ink)]')}
      onClick={() => void signOut()}
    >
      {t('Sign out')}
    </Button>
  );
}

function SessionFooterSignOut() {
  const session = useOwnerSession();
  return session.kind === 'owner' ? <FooterSignOut /> : null;
}

/**
 * A page outside the member shell (a product page, Help, Privacy) asks the
 * session: a signed-in member reading it gets the member footer.
 */
/**
 * The footer is the two legal documents and nothing else (MZ, 2026-10-06).
 * The product's pages live on the product site, and the door reaches them
 * through its Runs on Starlings tile; a member has Help in the header.
 */
function SiteFooterNav({ current }: { current?: SiteCurrent }) {
  const link = (href: string, label: ReactNode, here: boolean) => (
    <Button asChild variant="link" className={footerLinkClass(here)}>
      <a href={href} aria-current={here ? 'page' : undefined}>{label}</a>
    </Button>
  );
  return (
    <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[13px]" aria-label={t('Site')}>
      {link('/privacy', 'Privacy', current === 'privacy')}
      {link('/terms', 'Terms', current === 'terms')}
    </nav>
  );
}

/**
 * Global top-left brand — same mark in shell header and in-meeting chrome.
 * It names whose workspace this is: the workspace's mark and name
 * (workspace-brand.ts), never the product's. The product wordmark is
 * `StarlingsWordmark`, on the public site. The meeting header passes
 * `className` and `labelClassName` to push it to the leading edge and hide
 * the word on a phone.
 */
export function SiteBrand({ href = '/', className, labelClassName, signedOut = false }: {
  href?: string;
  className?: string;
  labelClassName?: string;
  /** Nobody signed in: without an uploaded mark, the Starlings flock (WorkspaceMark). */
  signedOut?: boolean;
}) {
  return (
    <a
      className={cn(
        'inline-flex min-w-0 items-center gap-3 text-[22px] font-semibold tracking-[-0.02em] no-underline',
        className,
      )}
      href={href}
    >
      <BrandGlyph className="block size-7 flex-none text-[var(--accent-mark)]" size={28} signedOut={signedOut} />
      <span className={cn('truncate text-foreground', labelClassName)}>{workspaceBrand().name}</span>
    </a>
  );
}

/**
 * Inline rather than `<img src="/glyph.svg">`: the fill is baked into that file,
 * so the mark stayed `#d6f249` on a white page — brand lime is legible against
 * the dark canvas it was picked for and washes out against a light one. Drawn
 * inline it takes `--accent-mark`, which is the lime in dark mode and `#aacc00`
 * in light. See the accent budget in docs/DESIGN.md.
 */
export function BrandGlyph({
  size = 40,
  className = 'mb-5 block size-10 text-(--accent-mark)',
  signedOut = false,
}: {
  size?: number;
  className?: string;
  signedOut?: boolean;
}) {
  return <WorkspaceMark size={size} className={className} signedOut={signedOut} />;
}
