import { cn } from "@/lib/utils"
import { GatheringDots } from "../GatheringDots"
import { t } from "../i18n"

/** The busy flock: the one loader motion (docs/DESIGN.md, "Waiting"). */
function Spinner({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span className={cn("inline-flex size-4", className)} {...props}>
      <GatheringDots motion="busy" width="100%" height="100%" />
    </span>
  )
}

type LoadingPlacement = "inline" | "section" | "full-page"

/**
 * The one loading treatment for Meet Web. Placement changes only the wrapper;
 * the same Spinner carries the motion in every state. A visible label also
 * names the status for assistive technology, while unlabeled states get a
 * localized, screen-reader-only name.
 */
function LoadingIndicator({
  placement = "inline",
  label,
  labelVisibility = "sr-only",
  decorative = false,
  className,
}: {
  placement?: LoadingPlacement
  label?: string
  labelVisibility?: "visible" | "sr-only"
  /** Use when nearby visible copy already announces the wait. */
  decorative?: boolean
  className?: string
}) {
  const statusLabel = label ?? t("Loading…")
  const Wrapper = placement === "inline" ? "span" : "div"
  const placementClass = placement === "inline"
    ? "inline-flex items-center gap-2"
    : placement === "section"
      ? "flex min-h-24 w-full items-center justify-center gap-2 text-muted-foreground"
      : "flex min-h-[min(42vh,24rem)] w-full flex-col items-center justify-center gap-3 text-muted-foreground"
  const spinnerClass = placement === "inline" ? "size-4" : placement === "section" ? "size-6" : "size-8"
  const labelClass = placement === "full-page" ? "text-lg font-medium text-foreground" : "text-sm"

  return (
    <Wrapper
      role={decorative ? undefined : "status"}
      aria-live={decorative ? undefined : "polite"}
      aria-label={decorative ? undefined : statusLabel}
      data-loader={placement === "full-page" ? "full-page" : undefined}
      className={cn(placementClass, className)}
    >
      <Spinner className={spinnerClass} />
      {label && labelVisibility === "visible" && <span aria-hidden={decorative ? undefined : true} className={labelClass}>{label}</span>}
    </Wrapper>
  )
}

export { LoadingIndicator, Spinner }
