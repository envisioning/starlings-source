import type { ReactElement, ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui/tooltip';

/**
 * The tooltip of an icon-only control (docs/DESIGN.md "Tooltips, contrast,
 * announcements"), except a plain Close icon. It shows on hover and on
 * keyboard focus, never on touch.
 * The control keeps its own `aria-label`; the tooltip is not its name.
 *
 * Each Tip carries its own provider. One provider at the App root would put
 * Radix on the guest entry path, which the build refuses (web/vite.config.ts).
 * Import Tip from lazy surfaces only; SiteChrome loads it on demand.
 */
export function Tip({ label, children }: { label: ReactNode; children: ReactElement }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
