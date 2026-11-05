import type { ReactNode } from 'react';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { MeetingPlatformIcon } from './action-icons';
import { isStarlingsMeet, type WebCalendarEvent } from './owner-agenda';

/**
 * A meeting's Join, drawn inside its own card or row: Home Upcoming
 * and the Calendar agenda use this one button.
 * Accent only for our own rooms. Somebody else's Zoom or Meet link is a way
 * out of the app, so it opens beside it and stays quiet.
 */
export function JoinMeetingButton({ event, href, children, className }: {
  event: WebCalendarEvent;
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const ours = isStarlingsMeet(event);
  return (
    <Button
      asChild
      size="sm"
      variant={ours ? 'default' : 'ghost'}
      className={cn(
        'h-7 rounded-[7px] px-2.5 text-xs',
        !ours && 'text-muted-foreground hover:text-foreground hover:underline hover:underline-offset-3',
        className,
      )}
    >
      <a href={href} {...(ours ? {} : { target: '_blank', rel: 'noreferrer' })}>
        <MeetingPlatformIcon platform={event.platform} /> {children}
      </a>
    </Button>
  );
}
