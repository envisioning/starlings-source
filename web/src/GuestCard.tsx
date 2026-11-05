import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { Card } from '@/ui/card';
import { Label } from '@/ui/label';

const SIZES = {
  /** Room entry, room not found, the room-code door, and a page's sign-in gate. */
  form: 'w-[min(100%,560px)] p-10 max-sm:px-6 max-sm:py-8',
  /** The lobby wait, a loading screen, a booking receipt, the ended note. */
  status: 'w-[min(100%,640px)] p-12 text-center max-sm:px-6 max-sm:py-8',
  /** The booking panel: a month beside the slot list. */
  wide: 'mx-auto w-[min(100%,960px)] p-7',
} as const;

/**
 * The card a guest's first screens draw, and a member page's sign-in gate
 *. shadcn Card is plain markup, so it may sit on the guest entry.
 * The card stays one rung up the ladder with the raised shadow: it floats on
 * the page, not in a section of it.
 */
export function GuestCard({ size = 'form', className, ...props }: ComponentProps<'div'> & {
  size?: keyof typeof SIZES;
}) {
  return (
    <Card
      className={cn(
        'relative block overflow-hidden bg-(--surface-raised) shadow-(--shadow-raised)',
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
}

/** The line under a guest card's heading: quieter and smaller than `.lede`. */
export function GuestLede({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('mt-0 mb-6 text-[15px] leading-[1.45] font-light text-muted-foreground', className)} {...props} />;
}

/** A labelled field on a guest form: the label above, the control full width under it. */
export function GuestField({ className, ...props }: ComponentProps<'label'>) {
  return <Label className={cn('grid gap-2 text-sm leading-normal font-medium text-foreground items-stretch', className)} {...props} />;
}
