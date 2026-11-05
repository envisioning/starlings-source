/**
 * The header's round icon controls: Search, Help, Settings (SiteChrome) and
 * the surface's `+` (SurfaceCreate). Its own module so SurfaceCreate, which
 * is lazy, does not import SiteChrome.
 */
export const CHROME_ICON_BUTTON = 'rounded-full text-muted-foreground aria-[current=page]:bg-popover aria-[current=page]:text-primary';
