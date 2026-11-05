/**
 * The frame of the public product pages (/workspace, /why, /pricing,
 * /interest) and the parts their drawings share, as Tailwind class lists on
 * the theme tokens. One source: a page composes these with `cn`
 * and adds only what is its own. The values follow the Starlings house style
 * (../house.css): Inter headings, ruled sections, 20px tiles.
 *
 * Cascade: the element rules in styles.css (`a`, `h1`) sit in the base
 * layer, so every utility here beats them. Where two utilities
 * set the same property, the more specific one wins: a descendant variant
 * (`[&_h2]:mt-0` in TILE) beats a plain utility on the element.
 */

/** The house heading face: Inter at 400, as house.css sets `h1` and `h2`. */
export const DISPLAY = 'font-sans [font-weight:400] [font-variation-settings:normal]';

export const PAGE = 'w-full';

/**
 * The one smaller heading step: a heading that opens a block inside a section
 * (Home's project card, a /why argument, the hero tile), below the page's
 * `h2`. It keeps the house h2's line height and tracking. It is important
 * (`!`) because a tile sets its `h2` as a descendant variant, which outranks
 * a plain utility on the element.
 */
export const HEADING_SMALL = 'text-[clamp(24px,3.2vw,32px)]! leading-[1.12]! tracking-[-0.02em]!';

/** The page head: title, lede. The lede closes the block. */
const HERO_BASE = 'mb-14 max-w-[58rem] [&_.lede]:mb-0';
export const HERO = `${HERO_BASE} mt-0`;

/** A head that opens a later section of the page. */
export const SECTION_HERO = `${HERO_BASE} mt-20 max-w-none border-t border-border pt-16 max-[800px]:mt-14 max-[800px]:pt-12 [&_h2]:mt-0 [&_h2]:mb-5 [&_h2]:max-w-[44rem] [&_h2]:text-balance [&_.lede]:max-w-[44rem]`;

/** Twelve columns; each tile names its span. */
export const GRID = 'grid grid-cols-12 gap-3 max-[640px]:gap-2.5';

/**
 * A tile: the house look on a shadcn Card, a title in the display face and
 * one sentence under it. The Card draws the surface and the hairline; a tile
 * that is a `<section>`, `<aside>` or `<a>` is `<Card asChild className={TILE}>`.
 */
export const TILE = [
  'min-w-0 gap-0 rounded-[var(--radius)] shadow-none',
  'p-7 pb-6 max-[640px]:p-5 max-[640px]:pb-4',
  '[&_h2]:mt-0 [&_h2]:mb-2 [&_h2]:text-[20px] [&_h2]:leading-[1.3] [&_h2]:tracking-[-0.4px] [&_h2]:text-balance [&_h2]:[font-weight:500]',
  '[&>p]:m-0 [&>p]:max-w-[34rem] [&>p]:text-[14px] [&>p]:leading-[1.6] [&>p]:text-muted-foreground',
].join(' ');

/** A tile at its compact size, for a grid of many (home's workspace areas): tighter padding, the drawing closer to the sentence. */
export const TILE_COMPACT = 'p-5 pb-4 max-[640px]:p-4 max-[640px]:pb-3';

/** A compact tile's glyph square: smaller, on the title's line. */
export const TILE_ICON_COMPACT = 'inline-flex size-7 flex-none items-center justify-center rounded-md border border-border bg-popover text-foreground [&_svg]:size-[15px]';

/**
 * The fill, edge and hover that mark a link to another page: the tile and the
 * pill share it. The mix is on `--ink`: the site defines no `--foreground`,
 * and an undefined token voids the whole `color-mix`, which left a white
 * currentColor edge and no fill. The fill marks the link; the edge rests on
 * the plain hairline so `hover-edge` brightens it, and a hovered tile reads
 * as the others, lifted.
 */
const LINK_SURFACE = 'border-(--line) bg-[color-mix(in_srgb,var(--ink)_5%,var(--surface-raised))] no-underline hover-lift hover-edge';

/**
 * A whole tile that is a link. It must not read as an information card, so
 * it has its own fill: the card's surface lifted a step toward the ink and a
 * lighter edge (no accent: the accent is the page's main action), and less
 * padding. It hovers (invariant 18).
 * Neutral tiles inform; tinted tiles go somewhere. Its sentence is ink, not
 * muted: muted ink on the tint does not read, worst in light mode.
 */
export const TILE_LINK = `relative ${LINK_SURFACE} py-5 pr-20 max-[640px]:py-4 [&>p]:text-foreground`;

/** A link to another page at its smallest: a pill with the tile's fill and edge, the label in ink, and a small arrow disc. */
export const PILL_LINK = `${LINK_SURFACE} inline-flex h-10 items-center gap-3 rounded-full border py-0 pr-1.5 pl-4 text-sm font-medium text-foreground`;

/** The arrow disc in a pill link: the tile's disc, smaller. */
export const PILL_LINK_ARROW = 'inline-flex size-7 -rotate-90 items-center justify-center rounded-full bg-foreground text-background';

/** A link tile at its large size: the page's closing ask. Same tint, edge and arrow; more room and a bigger name. */
export const TILE_LINK_LARGE = 'py-10 pl-10 pr-28 max-[640px]:py-7 max-[640px]:pl-6 max-[640px]:pr-20 [&_h2]:mb-3 [&_h2]:text-[clamp(26px,3.6vw,40px)] [&_h2]:leading-[1.1] [&_h2]:tracking-[-0.025em] [&>p]:max-w-[590px] [&>p]:text-base';

/** The arrow in a link tile: a solid ink disc, centred on the right edge. Ink, not accent: the accent is the page's one main action. */
export const TILE_LINK_ARROW = 'absolute top-1/2 right-7 inline-flex size-10 -translate-y-1/2 -rotate-90 items-center justify-center rounded-full bg-foreground text-background max-[640px]:right-5';

/**
 * The frame of a table on a public page: the card's corner and hairline. The
 * shadcn Table scrolls sideways inside it; the frame clips the corners, and
 * the outer cells step in from the round edge.
 */
export const TABLE_FRAME = 'overflow-hidden rounded-(--radius-card) border border-border [&_tr>*:first-child]:pl-4 [&_tr>*:last-child]:pr-4';

/** The square that holds a tile's glyph. */
export const TILE_ICON = 'mb-[18px] inline-flex size-9 items-center justify-center rounded-md border border-border bg-popover text-foreground [&_svg]:size-[18px]';

/** The glyph square in a link tile: the neutral square, same as every tile. The accent stays on the main button. */
export const TILE_LINK_ICON = TILE_ICON;

/** A drawn widget is a picture, not text: nothing in it selects, no text cursor shows, and a control in it keeps the pointer. */
export const WIDGET = 'cursor-default select-none [&_:is(a,button,summary,[role=tab],[role=button])]:cursor-pointer';

/** The drawing slot under a tile's sentence. */
export const ILLUSTRATION = `mt-[22px] flex flex-col gap-2.5 ${WIDGET}`;

/** The Elevated rung, as a drawn box. */
export const RAISED = 'rounded-md border border-border bg-popover';

/** The Well rung, as a drawn box. */
export const SUNKEN = 'rounded-md border border-border bg-muted';

/** A small uppercase label inside a drawing. */
export const CAPS = 'text-[11px] font-semibold uppercase tracking-[0.05em]';

/** A message bubble; the mine variant sits on the right in the accent tint. */
export const TURN = 'm-0 max-w-[78%] rounded-lg border border-border bg-popover px-3 py-2 text-[13px] leading-[1.4]';
export const TURN_MINE = 'relative self-end border-transparent bg-[color-mix(in_srgb,var(--accent)_16%,var(--surface-raised))]';

/** A list of task-like rows, and one row with its trailing meta. */
export const ROW_LIST = 'm-0 grid list-none gap-1 p-0';
export const ROW = `${RAISED} flex items-center gap-2.5 px-3 py-2 text-[13px]`;
export const ROW_DONE = 'text-muted-foreground line-through';
export const ROW_META = 'ml-auto text-[11px] tabular-nums text-muted-foreground';

/** Machine detail in mono: an issue number, a tool name, a shortcut, a file name. */
export const MONO = 'font-mono tracking-normal';
