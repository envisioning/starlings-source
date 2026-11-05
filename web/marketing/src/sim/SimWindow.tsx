import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { GearIcon, SearchIcon, WorkspaceMark } from '@shared/action-icons';
import { useSampleMeeting, useVisitDrawnClass, type SampleMeeting } from './sample-meeting';

/**
 * The drawn Starlings window every simulation sits in: a raised card, the
 * window inside it, and the top bar with the workspace's mark and name (as
 * the app header draws it, for the sample workspace), the surface's name, and search and settings. MiniMeet's displays and the scripted scenes share it,
 * so the frame changes in one place. The window is a picture: it is inert,
 * so nothing in it takes a hover, a cursor, a click or focus. The workspace
 * is this visit's (useSampleMeeting); a scene that draws its own sample
 * meeting passes that meeting's workspace.
 */
export function SimWindow({ label, ariaLabel, workspace: own, className, children }: {
  label: ReactNode;
  workspace?: SampleMeeting['workspace'];
  ariaLabel: string;
  className?: string;
  children: ReactNode;
}) {
  const visit = useSampleMeeting().workspace;
  const workspace = own ?? visit;
  // The card stays; the window inside it fades in with this visit's sample, never the default first.
  const drawn = useVisitDrawnClass();
  return (
    <div className="rounded-(--radius-card) border border-(--line) bg-(--surface-raised) p-2.5 shadow-[0_18px_48px_-32px_rgb(var(--ink-rgb)/0.38)] max-[641px]:p-1.5">
      <div inert className={cn(drawn, 'pointer-events-none flex flex-col overflow-hidden rounded-[calc(var(--radius-card)-4px)] border border-(--line) bg-(--surface-sunken) text-(--ink) select-none', className)} role="group" aria-label={ariaLabel}>
        <div className="flex min-h-[52px] items-center justify-between gap-4 border-b border-(--line) bg-(--surface) px-3 py-2 max-[641px]:gap-2 max-[641px]:px-2">
          <span className="inline-flex min-w-16 flex-none items-center gap-[7px] text-[14px] tracking-[-0.01em] max-[641px]:min-w-0 [&_svg]:size-5"><WorkspaceMark brand={workspace} className="text-(--accent-mark)" /><b>{workspace.name}</b></span>
          <span className="flex-none text-[12px] whitespace-nowrap text-(--muted)">{label}</span>
          <span className="inline-flex flex-none items-center gap-2.5 text-(--muted) max-[641px]:hidden [&_svg]:size-[15px]" aria-hidden="true">
            <SearchIcon />
            <GearIcon />
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}
