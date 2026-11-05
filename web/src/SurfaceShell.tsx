import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { wasMember } from './owner-session';
import { BackButton } from './BackButton';
import { AppShell, type MemberDestination } from './SiteChrome';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { RightSidebarIcon } from './action-icons';
import { readStored, removeStored, StorageKeys, writeStored } from './storage';
import { useDocumentTitle } from './document-title';
import { t } from './i18n';
import { Tip } from './Tip';
import { CHROME_ICON_BUTTON } from './chrome-classes';
import { useVisibleSurfaces } from './calendar-sources';
import { useEmailEventNotices } from './email-event-notices';
import { railListClass } from './rail-list';
import { RailEmpty, RailRow, RailSection, SCROLLBAR_AFFORDANCE_CLASS, railBlockProps, surfacePanelClass, surfaceScrollClass, useRailFold } from './rail-row';
import { PLACEHOLDER_FADE, PlaceholderBar } from '@/ui/placeholder-rows';

/**
 * The web's `StarlingsShellViewController` (docs/SURFACES.md §Under the chrome):
 * one shell under Work, Team and Docs, so the three destinations do not each
 * compose their own columns. A rail on the left, the thing chosen in the
 * middle, an inspector on the right when its user toggle is open and a thing
 * is chosen. The inspector starts closed and remembers its choice per
 * surface. Docs adds its list between the rail and the document.
 *
 * Above the phone the rail and the inspector pin to the viewport and scroll
 * on their own; the middle column is the page, and the page scrolls. On the
 * phone the rail is the page until something is chosen, and then the column
 * takes over with the shell's back row above it — the iOS push, not a stack
 * of both.
 */
export function SurfaceShell({ surface, title, openTitle, className = '', open = false, onBack, backLabel, rail, list, inspector, rightSidebar, before, create, children }: {
  surface: MemberDestination;
  /** Screen-reader title and the tab title. The nav already says which surface this is. */
  title: string;
  /** What is open in the column, first in the tab title: `Board notes · Docs · Meet`. */
  openTitle?: string | null;
  /** Extra classes on the split, for a surface's own column rules (Docs). */
  className?: string;
  /** Something is chosen in the column, so the phone shows the column alone. */
  open?: boolean;
  /** The phone's way back to the rail while `open`. */
  onBack?: () => void;
  backLabel?: string;
  rail?: ReactNode;
  list?: ReactNode;
  inspector?: ReactNode;
  /** The same control can drive an in-place side pane, such as Docs comments. */
  rightSidebar?: { open: boolean; onToggle: () => void; available?: boolean; hideToggleOnPhone?: boolean };
  /** Above the split, full width: banners, notices, errors. */
  before?: ReactNode;
  /** The surface's one `+`, handed to the header (`SurfaceCreate`). */
  create?: ReactNode;
  children: ReactNode;
}) {
  useDocumentTitle(openTitle, title);
  // Every member page, so a forwarded mail is announced wherever the member is.
  const surfaces = useVisibleSurfaces();
  useEmailEventNotices(wasMember() && surfaces.has('calendar'));
  const hasInspector = Boolean(inspector);
  const rightSidebarOpen = rightSidebar?.open ?? false;
  const rightSidebarAvailable = rightSidebar?.available ?? hasInspector;
  const rightSidebarLabel = rightSidebarOpen ? t('Hide Right Sidebar') : t('Show Right Sidebar');
  const rightSidebarToggle = rightSidebarAvailable && rightSidebar ? (
    <Tip label={rightSidebarLabel}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(CHROME_ICON_BUTTON, rightSidebar.hideToggleOnPhone !== false && 'max-[761px]:hidden', 'aria-pressed:bg-popover aria-pressed:text-foreground')}
        aria-label={rightSidebarLabel}
        aria-pressed={rightSidebarOpen}
        onClick={rightSidebar.onToggle}
      >
        <RightSidebarIcon />
      </Button>
    </Tip>
  ) : undefined;
  // The same toggle, drawn in a content header (`RightSidebarSlot`) where the open thing's own
  // controls are: beside a conversation's star and mute, not in the page's chrome. A page that
  // draws a slot claims it, and the chrome then leaves its own toggle out.
  const inlineToggle = rightSidebarAvailable && rightSidebar ? (
    <Tip label={rightSidebarLabel}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className={cn(rightSidebar.hideToggleOnPhone !== false && 'max-[761px]:hidden', 'aria-pressed:bg-accent')}
        aria-label={rightSidebarLabel}
        aria-pressed={rightSidebarOpen}
        onClick={rightSidebar.onToggle}
      >
        <RightSidebarIcon />
      </Button>
    </Tip>
  ) : null;
  const [slotClaims, setSlotClaims] = useState(0);
  const claimSlot = useCallback(() => {
    setSlotClaims((count) => count + 1);
    return () => setSlotClaims((count) => count - 1);
  }, []);
  const slot = useMemo(() => ({ node: inlineToggle, claim: claimSlot }), [inlineToggle, claimSlot]);
  const visibleInspector = hasInspector && rightSidebarOpen;
  const split = !(rail === undefined && list === undefined && inspector === undefined);
  return (
    // Signed out, no member destination shows, loading included:
    // a visitor's cold load of /work gets no nav before its first 401.
    <AppShell variant="app" member={wasMember() ? surface : undefined} create={create} rightSidebarToggle={slotClaims === 0 ? rightSidebarToggle : undefined} fill={split}>
      <RightSidebarSlotContext.Provider value={slot}>
      <div className={cn(
        'w-full text-foreground',
        split && 'min-[761px]:flex min-[761px]:min-h-0 min-[761px]:flex-1 min-[761px]:flex-col',
      )}>
        <h1 className="sr-only">{title}</h1>
        {before}
        {!split ? children : (
          <div
            className={cn(
              'surface-split mt-2 grid grid-cols-[var(--rail-col)_minmax(0,1fr)] items-start gap-6 [--rail-col:minmax(220px,260px)]',
              visibleInspector && 'grid-cols-[var(--rail-col)_minmax(0,1fr)_minmax(18rem,22rem)] max-[1101px]:grid-cols-[var(--rail-col)_minmax(0,1fr)]',
              // Above the phone the window is the Mac window: the page does
              // not scroll. The rail, the column and the inspector each
              // scroll themselves, so a conversation's composer is always on
              // screen and a rail is never taller than the window.
              'min-[761px]:min-h-0 min-[761px]:flex-1 min-[761px]:grid-rows-[minmax(0,1fr)] min-[761px]:items-stretch',
              'max-[761px]:grid-cols-1',
              className,
            )}
          >
            {/* `surface-split`, `surface-rail` and `surface-column` stay as
                hooks, with no rule of their own: Docs reads the split and
                puts the rail away in focus, RailRow reads where it sits,
                Work's Overview takes the column's scrolling above 900px:
                the column stands its height and its halves scroll. */}
            {rail !== undefined && (
              <aside className={cn('surface-rail', surfacePanelClass, "font-['Inter',sans-serif]", open && 'max-[761px]:hidden')} aria-label={`${title} sidebar`}>{rail}</aside>
            )}
            {list}
            <main className={cn('surface-column min-w-0', surfaceScrollClass, 'min-[761px]:pr-1 min-[761px]:has-[>[data-thread-pane=fill]]:overflow-hidden', WORK_OVERVIEW_COLUMN)}>
              {/* The way back to the rail: on a phone, while a column is open. */}
              {open && onBack && (
                <BackButton className="hidden max-[761px]:inline-flex" label={backLabel ?? title} onClick={onBack} />
              )}
              {children}
            </main>
            {visibleInspector && (
              <aside
                className={cn(
                  surfacePanelClass,
                  "font-['Inter',sans-serif]",
                  'max-[761px]:hidden',
                  // A conversation's context stands at its own height.
                  'has-[[data-inspector-context]]:self-start',
                  // Two columns: the inspector goes above the column.
                  'max-[1101px]:-order-1 max-[1101px]:col-[2] max-[761px]:col-auto',
                )}
              >
                {inspector}
              </aside>
            )}
          </div>
        )}
      </div>
      </RightSidebarSlotContext.Provider>
    </AppShell>
  );
}

const RightSidebarSlotContext = createContext<{ node: ReactNode; claim: () => () => void } | null>(null);

/**
 * Where a content header draws the right-sidebar toggle. It draws nothing when the page has no
 * sidebar to show, and while it is on screen the chrome's own toggle steps aside.
 */
export function RightSidebarSlot() {
  const slot = useContext(RightSidebarSlotContext);
  const claim = slot?.claim;
  useEffect(() => claim?.(), [claim]);
  return slot?.node ?? null;
}

/** One per-surface visibility preference shared by every web right sidebar. */
export function useRightSidebar(surface: MemberDestination) {
  const key = StorageKeys.rightSidebar + surface;
  const [open, setOpen] = useState(() => readStored(key) === '1');

  function setVisible(next: boolean) {
    setOpen(next);
    if (next) writeStored(key, '1');
    else removeStored(key);
  }

  return {
    open,
    setOpen: setVisible,
    toggle: () => setVisible(!open),
  };
}

/** Above the phone a column scrolls on its own, inside the viewport. */
/** Work's Overview and a subject's Overview (WorkPage) fill the column and scroll in their halves above 900px. */
const WORK_OVERVIEW_COLUMN = cn(
  'min-[901px]:has-[>.work-overview:first-child>.work-overview-columns]:flex',
  'min-[901px]:has-[>.work-overview:first-child>.work-overview-columns]:flex-col',
  'min-[901px]:has-[>.work-overview:first-child>.work-overview-columns]:overflow-hidden',
  // A subject's Overview (Talk | Work) does the same beneath its head and tabs.
  'min-[901px]:has-[.subject-overview-columns]:flex',
  'min-[901px]:has-[.subject-overview-columns]:flex-col',
  'min-[901px]:has-[.subject-overview-columns]:overflow-hidden',
);
export { SCROLLBAR_AFFORDANCE_CLASS, useRailFold, railBlockProps, RailSection, RailEmpty };
export { RailRow };

type RailMark = 'avatar' | 'glyph' | 'square' | 'none';

const PLACEHOLDER_TITLE_WIDTHS = ['w-[62%]', 'w-[46%]', 'w-[74%]'];
const PLACEHOLDER_SUBTITLE_WIDTHS = ['w-[84%]', 'w-[68%]', 'w-[56%]'];

/**
 * A `RailRow` while its list waits: the same row, with a well for the mark
 * and bars for the words, so a rail or a column keeps the shape it will
 * have. `mark` is the leading the real rows carry: a face (38px), a round
 * glyph or a square one (26px), or none. Widths step by `variant`.
 */
export function RailRowPlaceholder({ mark = 'glyph', subtitle = true, trailing = false, variant = 0 }: {
  mark?: RailMark;
  subtitle?: boolean;
  /** A count at the end, as Docs' rail rows carry. */
  trailing?: boolean;
  variant?: number;
}) {
  const well = mark === 'avatar' ? 'size-[38px] rounded-full' : mark === 'square' ? 'size-[26px] rounded-[25%]' : 'size-[26px] rounded-full';
  return (
    <RailRow
      leading={mark === 'none' ? undefined : <PlaceholderBar immediate className={well} />}
      title={<PlaceholderBar immediate className={cn('inline-block h-3 rounded-full align-middle', PLACEHOLDER_TITLE_WIDTHS[variant % 3])} />}
      subtitle={subtitle ? <PlaceholderBar immediate className={cn('inline-block h-2.5 rounded-full align-middle', PLACEHOLDER_SUBTITLE_WIDTHS[variant % 3])} /> : undefined}
      trailing={trailing ? <PlaceholderBar immediate className="h-2.5 w-4 rounded-full" /> : undefined}
    />
  );
}

/**
 * A `railListClass` list of placeholder rows: the card a column's rows sit
 * in, or the flat list in the rail. Inside a page skeleton it draws at once
 * (`immediate`); a section waiting on a loaded page keeps the 250 ms fade.
 * Hidden from assistive technology unless it names its own wait (`label`).
 */
export function RailRowsPlaceholder({ count = 4, mark, subtitle, trailing, label, immediate = false, className }: {
  count?: number;
  mark?: RailMark;
  subtitle?: boolean;
  trailing?: boolean;
  label?: string;
  immediate?: boolean;
  className?: string;
}) {
  return (
    <>
      {label && <span role="status" aria-live="polite" className="sr-only">{label}</span>}
      <ul className={cn(railListClass, !immediate && PLACEHOLDER_FADE, className)} aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <RailRowPlaceholder key={index} mark={mark} subtitle={subtitle} trailing={trailing} variant={index} />
        ))}
      </ul>
    </>
  );
}
