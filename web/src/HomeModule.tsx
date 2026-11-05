import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Card, CardHeader, CardTitle } from '@/ui/card';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/ui/item';
import { HOME_ROW_ATTRIBUTE } from './home-keys';
import type { RowMenuController } from './use-row-menu';
import { formatHomeDate, formatTime } from './meeting-time';

/**
 * The parts every Home module is made of (docs/DESIGN.md, "Home rows"), on
 * shadcn Card and Item. One helper per concept: a module that
 * composes the shell by hand is the drift that section exists to stop.
 *
 * Card: the Panel rung, radius `card`, 12 × 14 padding, a 12 gap between
 * its parts. Row: the Elevated rung on that panel, a 1px line, radius
 * `field`, 12 padding, the hover lift only when it opens something.
 *
 * Radix lives under Item (Slot, Separator), so this file loads with the
 * Home chunk only, never on the guest entry.
 */

/** The shell class, for a panel that also draws somewhere else (Quick Notes). */
export const homeCardClass = 'mb-3.5 w-full min-w-0 gap-3 rounded-xl px-3.5 py-3 shadow-none';

/** A module's LABEL: caption, uppercase, secondary ink. */
export const homeLabelClass = 'm-0 text-[11px] leading-normal font-semibold tracking-[0.06em] text-muted-foreground uppercase';

/** Envisioning Octa. Home's clock only; the date under it and all other copy is Inter. */
const octaClass = 'font-display';

/** A module. With an `aria-label` it is a region, as the `<section>` it replaces was. */
export function HomeCard({ className, ...props }: ComponentProps<typeof Card>) {
  return <Card role={props['aria-label'] ? 'region' : undefined} className={cn(homeCardClass, className)} {...props} />;
}

/**
 * LABEL left, then a count or controls right. One fixed height (the icon
 * button's) with everything centred, so a card with a trailing action and one
 * without start their rows at the same y.
 */
export function HomeCardHead({ title, count, children, className }: {
  title: ReactNode;
  count?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <CardHeader className={cn('flex h-8 items-center justify-between gap-3 px-0 py-0', className)}>
      <CardTitle className={cn(homeLabelClass, 'inline-flex items-center gap-1.5')}>{title}</CardTitle>
      {count && <span className="text-[11px] font-semibold tracking-[0.06em] text-foreground uppercase">{count}</span>}
      {children}
    </CardHeader>
  );
}

/**
 * One column the width of the card, never the implicit `auto`: a title is
 * one nowrap line, and an auto track would size itself to the longest one.
 * A row with a menu is a `HomeMenuItem`.
 */
export function HomeList({ className, ...props }: ComponentProps<'ul'>) {
  return (
    <ul
      className={cn('m-0 grid list-none grid-cols-[minmax(0,1fr)] gap-2 p-0 [&>li]:relative [&>li]:min-w-0', className)}
      {...props}
    />
  );
}

/** The focus target of a Home row's menu: the control the arrow keys walk. */
export const homeRowMenuOptions = { target: `[${HOME_ROW_ATTRIBUTE}]` } as const;

/**
 * A Home list row with its menu: right-click, Shift+F10, and the
 * `…` in the row's top corner. The row inside keeps room for the `…`, so
 * the button never covers the title or the "when". No items, no `…`.
 */
export function HomeMenuItem({ menu, id, items, className, leaving = false, children }: {
  menu: RowMenuController;
  id: string;
  items: ReactNode;
  className?: string;
  leaving?: boolean;
  children: ReactNode;
}) {
  const row = menu.rowProps(id);
  const hasMenu = items !== null && items !== undefined && items !== false;
  return (
    <li
      {...(hasMenu ? row : {})}
      aria-hidden={leaving || undefined}
      inert={leaving || undefined}
      className={cn(hasMenu && row.className, hasMenu && '[&>[data-slot=item]]:pr-11 [@media(hover:hover)]:[&:has([data-home-when])>[data-slot=item]]:pr-3', leaving && 'task-row-leaving', className)}
    >
      {children}
      {menu.panel(id, items, { className: homeRowMenuButtonClass })}
    </li>
  );
}

/**
 * Where the `…` sits on a Home row: the top corner, level with the title. On a
 * pointer device it takes the place of the row's "when" (`HomeRowWhen`), which
 * hides while the `…` shows; on touch the `…` has its own room.
 */
export const homeRowMenuButtonClass = 'absolute top-2 right-1.5';

/** The row class, for a row whose shell is not an Item (the agenda's link inside its roster). */
export const homeRowClass = 'min-w-0 items-start gap-2.5 rounded-md bg-(--surface-raised) p-3 text-inherit no-underline';

/** Anything you can act on lifts under the pointer (docs/DESIGN.md, "Hover"). */
const homeRowHover = 'hover-lift';

/**
 * The Home row: a leading mark, one title line, one metadata line, and a
 * trailing "when". A link row passes `asChild` with its `<a data-home-row>`.
 */
export function HomeRow({ className, interactive, ...props }: ComponentProps<typeof Item> & { interactive?: boolean }) {
  return (
    <Item
      variant="outline"
      className={cn(homeRowClass, (interactive ?? props.asChild) && homeRowHover, className)}
      {...props}
    />
  );
}

/**
 * Home's fixed 24px leading mark slot. Secondary ink by default;
 * `ink="primary"` for a late row, `ink="accent"` for our own room. The
 * well inherits it (`GlyphMark`); `alignment="row"` is for the unread dot.
 */
export function HomeRowMark({ ink = 'muted', alignment = 'first-line', className, ...props }: ComponentProps<typeof ItemMedia> & {
  ink?: 'muted' | 'primary' | 'accent';
  alignment?: 'first-line' | 'row';
}) {
  return (
    <ItemMedia
      data-home-mark=""
      className={cn(
        'size-6 [&_svg]:size-4',
        alignment === 'row'
          ? 'mt-0 self-center group-has-[[data-slot=item-description]]/item:translate-y-0 group-has-[[data-slot=item-description]]/item:self-center'
          : 'mt-px',
        ink === 'muted' && 'text-muted-foreground',
        ink === 'primary' && 'text-foreground',
        ink === 'accent' && 'text-(--accent-mark)',
        className,
      )}
      {...props}
    />
  );
}

/** The Messages mark uses the same 24px slot, with its dot centred across the row. */
export function HomeRowUnreadMark() {
  return (
    <HomeRowMark alignment="row" aria-hidden="true">
      <span className="size-2 rounded-full bg-(--accent-mark)" />
    </HomeRowMark>
  );
}

/**
 * Title, one line; metadata, one line. `wrap` lets a part run on: a
 * message preview takes two lines, the room slug and the unmapped notice
 * take what they need.
 */
export function HomeRowText({ title, detail, wrap, titleClassName, detailClassName, children }: {
  title: ReactNode;
  detail?: ReactNode;
  wrap?: 'title' | 'detail' | 'detail-2';
  titleClassName?: string;
  detailClassName?: string;
  children?: ReactNode;
}) {
  return (
    <ItemContent className="min-w-0 gap-[3px]">
      <ItemTitle
        className={cn(
          'block w-full min-w-0 text-[15px] leading-snug font-[560] text-foreground',
          wrap === 'title' ? 'whitespace-normal' : 'truncate',
          titleClassName,
        )}
      >
        {title}
      </ItemTitle>
      {detail && (
        <ItemDescription
          className={cn(
            'text-xs text-muted-foreground',
            wrap === 'detail' ? 'line-clamp-none whitespace-normal' : wrap === 'detail-2' ? 'line-clamp-2 text-[13px] leading-[1.4]' : 'line-clamp-none truncate',
            detailClassName,
          )}
        >
          {detail}
        </ItemDescription>
      )}
      {children}
    </ItemContent>
  );
}

/** The trailing "when". Late is said by the word and its weight, never a colour. */
export function HomeRowWhen({ late = false, children }: { late?: boolean; children: ReactNode }) {
  return (
    <span
      data-home-when=""
      className={cn(
        'flex-none text-right text-xs font-semibold text-muted-foreground',
        // The row's `…` takes this place on hover, focus and while its menu is open.
        '[@media(hover:hover)]:group-hover/row-menu:opacity-0 [@media(hover:hover)]:group-focus-within/row-menu:opacity-0 [@media(hover:hover)]:group-has-[[data-row-menu-button][data-state=open]]/row-menu:opacity-0',
        late && 'font-bold text-foreground',
      )}
    >
      {children}
    </span>
  );
}

/** Answers under the row at full width: Accept / Maybe / Decline, Add / Discard. */
export function HomeRowActions({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex basis-full flex-wrap gap-2', className)} {...props} />;
}

/** "and 3 more in Work": a link when there is a place to go, a line when there is not. */
export function HomeMore({ href, className, children, ...props }: ComponentProps<'p'> & { href?: string }) {
  const classes = cn('m-0 block text-xs text-muted-foreground no-underline', className);
  if (href) {
    return (
      <a className={cn(classes, 'hover:text-foreground hover:underline hover:underline-offset-3')} href={href}>
        {children}
      </a>
    );
  }
  return <p className={classes} {...props}>{children}</p>;
}

/** The quiet fold toggle: "See rest of day", "See 4 more". */
export function HomeFoldToggle({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className={cn(
        'h-auto self-start p-0 text-xs leading-[1.4] font-normal text-muted-foreground underline underline-offset-3 hover:text-foreground has-[>svg]:px-0',
        className,
      )}
      {...props}
    />
  );
}

/** The same 24-hour Octa clock the phone shows, for the same reason: Home is today. */
export function HomeClockFace({ now }: { now: Date }) {
  const time = formatTime(now);
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <span
        className={cn(octaClass, 'text-[clamp(44px,11vw,64px)] leading-none font-medium tracking-[-0.02em] text-foreground tabular-nums')}
        aria-label={time}
      >
        {time}
      </span>
      <span className="text-sm font-medium text-muted-foreground">{formatHomeDate(now)}</span>
    </div>
  );
}
