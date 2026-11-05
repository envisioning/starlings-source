import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * shadcn Label, drawn on a native <label> rather than Radix Label: guest
 * forms on the entry path use it, and that path carries no Radix. Radix
 * adds only a double-click guard, which `select-none` covers.
 */
function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Label }
