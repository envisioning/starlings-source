import type { ComponentProps, ReactNode } from 'react';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { ChevronIcon } from './action-icons';

/**
 * The meeting control bar and the prejoin media row, on shadcn `Button`
 *. LiveKit's hooks drive them (`useTrackToggle`, the layout
 * context); none of LiveKit's own buttons draw here.
 *
 * A toggle is a Button with `aria-pressed`. The pressed state fills in the
 * primary, so an open panel or a raised hand reads at a glance.
 */
export const pressedClass =
  'aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:bg-none aria-pressed:hover:bg-(--accent-cta-hover)';

/**
 * A device toggle (microphone, camera) keeps a neutral face. A live device
 * lights its icon in the accent mark instead of filling the button.
 */
/** Leave: an outline in the danger ink, quieter than a filled destructive button. */
export const leaveButtonClass =
  'border-destructive/65 bg-transparent text-xs text-[var(--danger-ink)] hover:text-[var(--danger-ink)] dark:border-destructive/65 dark:bg-transparent';

export const liveIconClass = 'aria-pressed:[&_svg]:text-[var(--accent-mark)]';

/*
 * One bar cell: symbol over label, 64 tall. Under 760 wide the cell is a
 * 48-point square (above the 44-point touch minimum) and the label goes to
 * screen readers only, so the bar stays one row.
 */
const cellClass =
  "relative h-16 min-w-18 flex-col gap-1 px-3 text-xs leading-none max-[760px]:h-12 max-[760px]:min-w-12 [&_svg:not([class*='size-'])]:size-6";

/** The visible word under a bar cell's symbol. */
export function ControlLabel({ children }: { children: ReactNode }) {
  return <span className="block max-w-[12ch] truncate max-[760px]:sr-only">{children}</span>;
}

/**
 * A bar cell. Pass `aria-pressed` to make it a toggle. `pressedStyle="icon"`
 * marks a live device on the icon alone (`liveIconClass`).
 */
export function ControlButton({ icon, label, className, children, variant = 'outline', pressedStyle = 'fill', ...props }: ComponentProps<typeof Button> & {
  icon: ReactNode;
  label: string;
  pressedStyle?: 'fill' | 'icon';
}) {
  return (
    <Button
      type="button"
      variant={variant}
      className={cn(cellClass, pressedStyle === 'fill' ? pressedClass : liveIconClass, className)}
      {...props}
    >
      {icon}
      <ControlLabel>{label}</ControlLabel>
      {children}
    </Button>
  );
}

/**
 * Two buttons in one outline: the track toggle and the chevron that opens its
 * device menu. The Popover anchors on this box, so the menu lines up with the
 * whole control and not with the chevron alone.
 */
export function ControlGroup({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('inline-flex min-w-0 overflow-hidden rounded-md border border-border bg-background shadow-xs', className)}
      {...props}
    />
  );
}

/** The toggle half of a ControlGroup, as a bar cell: a device toggle. */
export function GroupedControlButton({ className, ...props }: ComponentProps<typeof ControlButton>) {
  return <ControlButton variant="ghost" pressedStyle="icon" className={cn('rounded-none', className)} {...props} />;
}

/**
 * The chevron half of a ControlGroup. It is a PopoverTrigger child, so it
 * spreads every prop (Radix passes the ref, the handlers and `aria-expanded`).
 * A trigger keeps the browser's button face under Tailwind's reset, so the
 * face, border and padding are set here.
 */
export function ControlMenuButton({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="ghost"
      className={cn(
        "h-auto w-[30px] min-w-0 rounded-none border-0 border-l border-border bg-transparent p-0 [&_svg:not([class*='size-'])]:size-2.5",
        className,
      )}
      {...props}
    >
      <ChevronIcon />
    </Button>
  );
}

/*
 * The frame. An accent ring around whoever the SFU scores as talking (the
 * Mac's `SpeakingRing`), drawn by the border and a 3px inner ring together so
 * the two read as one frame. A screen share gets a neutral ring instead: a
 * tile carrying somebody's desktop must never read as their camera. The ring
 * lingers half a second after speech stops, so it does not flicker. The
 * product site's drawn call (MeetingSim) uses the same frame and plate.
 */
export const TILE =
  "group/tile relative flex flex-col gap-1.5 overflow-hidden rounded-[8px] border border-solid border-border bg-background after:pointer-events-none after:absolute after:inset-0 after:rounded-[8px] after:border-0 after:border-solid after:border-[color:var(--accent)] after:transition-[border-width] after:delay-500 after:duration-400 after:content-['']";
export const TILE_SPEAKING = 'border-[color:var(--accent)] after:border-3 after:delay-0 after:duration-200';
export const TILE_SHARE = 'border-[rgb(var(--ink-rgb)/0.6)] after:border-3 after:border-[rgb(var(--ink-rgb)/0.6)] after:delay-0';

/* A plate that crosses video carries its own contrast. */
export const PLATE = 'flex items-center rounded-[4px] bg-[rgba(29,29,29,0.84)] p-1 text-[var(--on-media)]';
