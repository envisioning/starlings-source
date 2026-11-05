import type { ComponentProps } from 'react';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';

/**
 * A column's filter trigger, the Mac rail's accessory button. Quiet until
 * something is set; then the accent says the list is not the plain one.
 * The menu's trigger copies its props onto this button (`asChild`).
 */
export function FilterButton({ dirty, label, className, ...props }: ComponentProps<typeof Button> & { dirty: boolean; label: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      className={cn('size-[26px] text-muted-foreground hover:text-foreground', dirty && 'text-(--accent-cta) hover:text-(--accent-cta)', className)}
      {...props}
      data-slot="button"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M2 4h12M4 8h8M6 12h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </Button>
  );
}
