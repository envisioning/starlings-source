import type { ReactNode } from 'react';
import { Badge } from '@/ui/badge';
import { Card } from '@/ui/card';
import { cn } from '@/lib/utils';
import { HEADING_SMALL, ILLUSTRATION, PILL_LINK, PILL_LINK_ARROW, RAISED, TILE, TILE_COMPACT, TILE_ICON, TILE_ICON_COMPACT, TILE_LINK, TILE_LINK_ARROW, TILE_LINK_ICON, TILE_LINK_LARGE } from './bento';

/*
 * The product pages' tile and the parts their drawings share: /workspace,
 * /security and /integrations draw the same tile, so a fact moved between
 * them keeps its look. Every tile has the same grammar, in the same order: a
 * name, one sentence, a drawing of the thing, then the facts as label/text
 * rows. `Tile` enforces the order.
 */

/**
 * One tile, one grammar: icon, name, sentence, drawing, facts. The drawing is
 * decorative (`aria-hidden`); the facts are the accessible content.
 */
export function Tile({
  id,
  span,
  icon,
  title,
  fact,
  illustration,
  rows,
  more,
  hero = false,
  compact = false,
}: {
  id?: string;
  span: keyof typeof SPAN;
  icon: ReactNode;
  title: string;
  fact: string;
  illustration?: ReactNode;
  rows?: Array<[label: string, text: ReactNode]>;
  /**
   * One link under the rows, for a tile that has a fuller page behind it.
   * `name` is its accessible name when the label alone ("More") repeats on
   * the page; it starts with the label.
   */
  more?: { href: string; label: string; name?: string };
  /** The hero claim: a bigger title. Its icon stays neutral: the accent is the page's one main action. */
  hero?: boolean;
  /** Many tiles in one grid: the glyph sits on the title's line, with less padding and a closer drawing. */
  compact?: boolean;
}) {
  return (
    // shadcn Card: the surface, hairline and corner are the Card's.
    <Card id={id} className={cn(TILE, compact && TILE_COMPACT, SPAN[span])}>
      {compact
        ? <h2 className="flex items-center gap-2.5"><span className={TILE_ICON_COMPACT} aria-hidden="true">{icon}</span>{title}</h2>
        : <><span className={TILE_ICON} aria-hidden="true">{icon}</span><h2 className={hero ? HEADING_SMALL : undefined}>{title}</h2></>}
      <p>{fact}</p>
      {illustration && <div className={cn(ILLUSTRATION, compact && 'mt-4')} aria-hidden="true">{illustration}</div>}
      {rows && rows.length > 0 && (
        // Pinned to the foot: tiles in one row share a baseline for their facts
        // whatever height their drawings came out at.
        <dl className="mx-0 mt-auto mb-0 grid pt-[22px]">
          {rows.map(([label, text]) => (
            <div key={label} className="border-t border-border py-2 text-[14px] leading-[1.45]">
              <dt className="m-0 inline font-semibold">{label}</dt>{' '}
              <dd className="m-0 inline text-muted-foreground">{text}</dd>
            </div>
          ))}
        </dl>
      )}
      {/* With no facts under it, the link is pinned to the foot, so tiles in one row line it up. */}
      {more && <a className={cn('inline-flex items-center gap-1.5 text-[13px] font-semibold no-underline hover:underline [&>svg]:-rotate-90', rows?.length ? 'mt-3' : 'mt-auto pt-3')} href={more.href} aria-label={more.name}>{more.label}<ArrowGlyph /></a>}
    </Card>
  );
}

/**
 * A whole tile that is a link to another page: the tinted tile (`TILE_LINK`)
 * with an optional glyph, a name, one sentence and the arrow disc. Every
 * link tile on the site is this, so the look changes in one place. `large`
 * is the page's closing ask (EarlyAccess): the same tile, bigger. A tile
 * carries no margin; the grid it sits in sets the gaps.
 */
export function LinkTile({ href, icon, title, text, large = false, className }: {
  href: string;
  icon?: ReactNode;
  title: ReactNode;
  text: ReactNode;
  large?: boolean;
  className?: string;
}) {
  return (
    <Card asChild className={cn(TILE, TILE_LINK, large && TILE_LINK_LARGE, className)}>
      <a href={href}>
        {icon && <span className={TILE_LINK_ICON} aria-hidden="true">{icon}</span>}
        <h2>{title}</h2>
        <p>{text}</p>
        <span className={TILE_LINK_ARROW} aria-hidden="true"><ArrowGlyph /></span>
      </a>
    </Card>
  );
}

/** A link to another page, small: the link tile as a pill. Use it where a section ends in a way onward. */
export function LinkPill({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className={PILL_LINK}>
      {children}
      <span className={PILL_LINK_ARROW} aria-hidden="true"><ArrowGlyph /></span>
    </a>
  );
}

/** A note set apart by the accent rule: "Coming later", "Direction". `className` sets its margins and size. */
export function Callout({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn('rounded-r-md border-l-[3px] border-(--accent) bg-popover px-3.5 py-3', className)}>{children}</p>;
}

/** Twelve columns: a tile's span on a wide window, half on a tablet, whole on a phone. */
export const SPAN = {
  3: 'col-span-3 max-[960px]:col-span-6 max-[640px]:col-span-12',
  4: 'col-span-4 max-[960px]:col-span-6 max-[640px]:col-span-12',
  5: 'col-span-5 max-[960px]:col-span-6 max-[640px]:col-span-12',
  6: 'col-span-6 max-[640px]:col-span-12',
  7: 'col-span-7 max-[960px]:col-span-6 max-[640px]:col-span-12',
  8: 'col-span-8 max-[960px]:col-span-6 max-[640px]:col-span-12',
  12: 'col-span-12',
} as const;

/** One MCP tool: the name in mono, what it reaches in prose. */
export function McpTool({ name, children }: { name: string; children: ReactNode }) {
  return (
    <li className="flex min-w-0 items-baseline gap-2.5 py-1 text-[12px]">
      <Badge variant="outline" className="min-w-0 font-mono text-muted-foreground">{name}</Badge>
      <span className="min-w-0 truncate text-muted-foreground">{children}</span>
    </li>
  );
}

/** A gate a guest passes, numbered in order, with what it hands over. The number is an ink disc, not the accent. */
export function Gate({ name, children }: { name: string; children: ReactNode }) {
  return (
    <li className={cn(
      RAISED,
      'flex min-w-0 flex-col gap-0.5 px-3.5 py-3 [counter-increment:gate]',
      'before:mb-2 before:inline-flex before:size-5 before:items-center before:justify-center before:rounded-full before:bg-foreground before:text-[11px] before:font-medium before:text-background before:content-[counter(gate)]',
    )}>
      <b className="text-[13px] font-semibold">{name}</b>
      <span className="text-[12px] leading-[1.4] text-muted-foreground">{children}</span>
    </li>
  );
}

/** A subject and, for it, what Starlings keeps and what it does not. */
export function PrivacySubject({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className={cn(RAISED, 'flex min-w-0 flex-col gap-1.5 px-3.5 py-3')}>
      <b className="mb-1 text-[13px] font-semibold">{name}</b>
      {children}
    </div>
  );
}

export function PrivacyLine({ kept = false, children }: { kept?: boolean; children: ReactNode }) {
  return (
    <span className={cn('flex items-start gap-2 text-[12px] leading-[1.4] [&>svg]:mt-0.5 [&>svg]:flex-none', kept ? '[&>svg]:text-(--accent-mark)' : 'text-muted-foreground')}>
      {kept ? <CheckGlyph /> : <CrossGlyph />}
      {children}
    </span>
  );
}

/** A link out to a vendor or a standard. Opens in a new tab and sends no referrer. */
export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return <a className="underline decoration-border underline-offset-3 hover:decoration-current hover:text-foreground" href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

export function ArrowGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 3v10M4.5 9.5 8 13l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function StatusGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.5 12.5V8M6.5 12.5V4M10.5 12.5V6.5M14.5 12.5V3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function CheckGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="m3 8.5 3.2 3.2L13 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CrossGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function PlugGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5.5 2v3M10.5 2v3M4 5h8v2.5a4 4 0 0 1-8 0Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 11.5V14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function CloudGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <path d="M8.5 21.5h11a5 5 0 0 0 .8-9.9A7 7 0 0 0 7 12.5a4.5 4.5 0 0 0 1.5 9Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

export function StackGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="m8 2.5 6 3-6 3-6-3Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="m2 8.5 6 3 6-3M2 11.5l6 3 6-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function ShieldGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 1.8 13 4v3.5c0 3.4-2.2 5.8-5 6.7-2.8-.9-5-3.3-5-6.7V4Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="m5.8 8 1.5 1.5L10.5 6.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function EyeOffGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="m3 3 10 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function KeyGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="5.5" cy="10.5" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="m7.8 8.2 5.2-5.2M11 5l1.8 1.8M9.2 6.8 11 8.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// The feature library's glyphs (`features.tsx`). Same stroke and box as
// `action-icons.tsx`; one moves there the day an app surface needs it.

export function CaptureGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 4h10M3 7h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="m8.5 12 1.8 1.8L14 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AccessGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="2.6" r="1.4" fill="currentColor" />
      <path d="M2.5 5.5h11M8 5.5v4.2M8 9.7l-2.6 4.3M8 9.7l2.6 4.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ShareGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.5" y="3" width="13" height="9" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 10V5.5M5.8 7.7 8 5.5l2.2 2.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function HandGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5 8.5V4a1 1 0 0 1 2 0v3.5M7 7V2.8a1 1 0 0 1 2 0V7M9 7V3.8a1 1 0 0 1 2 0V8M11 8V5.3a1 1 0 0 1 2 0V10a4 4 0 0 1-4 4H8.4a4 4 0 0 1-3.2-1.6L3.3 9.9a1 1 0 0 1 1.6-1.2L5 9.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CameraGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M1.5 5.5A1.5 1.5 0 0 1 3 4h5l2 2v4.5L8.5 12H3a1.5 1.5 0 0 1-1.5-1.5Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M11 6.2 14.5 4.4v7.2L11 9.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function LinkGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M6.5 9.5a3 3 0 0 0 4.2.2l1.8-1.8a3 3 0 0 0-4.2-4.2l-1 1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M9.5 6.5a3 3 0 0 0-4.2-.2L3.5 8.1a3 3 0 0 0 4.2 4.2l1-1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function DoorGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4 14V3a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M2 14h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="9.4" cy="8.2" r="0.9" fill="currentColor" />
    </svg>
  );
}

export function CaptionsGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 9.5h4.5M4 7h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function StageGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.5" y="2.5" width="6" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="8.5" y="2.5" width="6" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="1.5" y="8.5" width="6" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="8.5" y="8.5" width="6" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function BrowserGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect x="3.5" y="4.5" width="21" height="19" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M3.5 9.5h21" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="7" cy="7" r="0.9" fill="currentColor" />
      <circle cx="10" cy="7" r="0.9" fill="currentColor" />
    </svg>
  );
}

export function TasksGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="m2.5 4.5 1.5 1.5 3-3M2.5 10.5l1.5 1.5 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 4.5h4.5M9 10.5h4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function IssueGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" />
    </svg>
  );
}

export function NoteGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3.5 2.5h7l2.5 2.5v8.5h-9.5Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6 8h4M6 10.5h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function RecordGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="2.6" fill="currentColor" />
    </svg>
  );
}

export function TranscriptGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 4h10M3 7h7M3 10h10M3 13h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function RoomGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="2" y="3" width="12" height="10" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="6" cy="7.2" r="1.3" fill="currentColor" />
      <circle cx="10" cy="7.2" r="1.3" fill="currentColor" />
      <path d="M4 11c.5-1.2 1.2-1.7 2-1.7s1.5.5 2 1.7M8 11c.5-1.2 1.2-1.7 2-1.7s1.5.5 2 1.7" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function BellGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M6.5 14h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function FolderGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function SearchGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
