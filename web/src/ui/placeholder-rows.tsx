import { cn } from "@/lib/utils"
import { Skeleton } from "@/ui/skeleton"
import { t } from "../i18n"

/** Placeholders appear only once a wait outlasts 250 ms (see PlaceholderRows). */
export const PLACEHOLDER_FADE = "animate-in fade-in fill-mode-backwards delay-250 duration-200"

/**
 * Bars are flat, as on native: no pulse. A page skeleton is many bars in
 * several columns, and a page of them breathing reads as noise.
 */
const BAR = "animate-none"

const TITLE_WIDTHS = ["max-w-[140px]", "max-w-[110px]", "max-w-[170px]"]
const DETAIL_WIDTHS = ["max-w-[220px]", "max-w-[190px]", "max-w-[160px]"]

/**
 * The wait drawn in the section the answer will fill (DESIGN.md, Waiting):
 * the web twin of EnvisioningUI `EnvisioningPlaceholderRows`. Each row is a
 * glyph, a title bar and a detail bar; widths step so a stack reads as rows.
 * The rows fade in after 250 ms, because most answers land inside that and a
 * placeholder that flashes reads as a flicker. The bars are hidden from
 * assistive technology; the wrapper names the wait once. Where the rows the
 * answer brings have a known shape, draw that shape instead
 * (`RailRowPlaceholder`, `DocumentRowsPlaceholder`).
 */
function PlaceholderRows({
  count = 3,
  glyph = true,
  label,
  className,
}: {
  count?: number
  /** Leave the glyph out where the real rows have none. */
  glyph?: boolean
  label?: string
  className?: string
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label ?? t("Loading…")}
      className={cn(
        "grid w-full gap-3 py-2",
        PLACEHOLDER_FADE,
        className,
      )}
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} aria-hidden="true" className="flex items-start gap-2.5 py-[3px]">
          {glyph && <Skeleton className={cn(BAR, "size-4 flex-none")} />}
          <div className="grid min-w-0 flex-1 gap-1.5">
            <Skeleton className={cn(BAR, "h-3 w-full rounded-full", TITLE_WIDTHS[index % 3])} />
            <Skeleton className={cn(BAR, "h-2.5 w-full rounded-full", DETAIL_WIDTHS[index % 3])} />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * One bar or block of known size: a title, a count line, a status word, a
 * chart, a month, an avatar. With a label it names the wait itself; without
 * one it is hidden from assistive technology and something nearby names the
 * wait. `immediate` drops the 250 ms fade, for a bar inside a skeleton that
 * is already on screen.
 */
function PlaceholderBar({ label, immediate = false, className }: { label?: string; immediate?: boolean; className?: string }) {
  return (
    <Skeleton
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn(BAR, !immediate && PLACEHOLDER_FADE, className)}
    />
  )
}

/**
 * Names a page skeleton's wait once, for assistive technology; the bars
 * themselves are hidden. The first child of a skeleton page.
 */
function PlaceholderStatus({ label }: { label?: string }) {
  return <span role="status" aria-live="polite" className="sr-only">{label ?? t("Loading…")}</span>
}

export { PlaceholderBar, PlaceholderRows, PlaceholderStatus }
