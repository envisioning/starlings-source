import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useMaybeRoomContext, useMediaDeviceSelect } from '@livekit/components-react';
import { RoomEvent, type LocalAudioTrack, type LocalVideoTrack } from 'livekit-client';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { PopoverContent } from '@/ui/popover';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { ChevronIcon } from './action-icons';

/**
 * The camera and microphone menus of the meeting toolbar and the prejoin
 * card: shadcn's Popover (MZ's one approach for the whole site),
 * anchored on the ControlGroup (meeting-control.tsx), with one DeviceSection
 * per list. The group's chevron, a shadcn Button, is the PopoverTrigger.
 *
 * The panel portals out of the ControlGroup, so the group's
 * `overflow: hidden` cannot clip it. It opens upward by default: the
 * meeting row sits at the bottom of the screen.
 */
export function DeviceMenuContent({ side = 'top', className, children }: {
  side?: 'top' | 'bottom';
  className?: string;
  children: ReactNode;
}) {
  return (
    <PopoverContent side={side} align="start" className={cn('flex w-72 flex-col gap-0.5 p-2', className)}>
      {children}
    </PopoverContent>
  );
}

/**
 * One row that expands into its own list — a device list or the background
 * effects — rather than every list sitting flattened in one long panel. The
 * caller keeps one section open at a time.
 */
export function DeviceSection({ label, summary, icon, open, onOpenChange, children }: {
  label: string;
  /** The current value, shown muted beside the label — "Blur", "MacBook Mic". */
  summary?: string;
  icon?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent p-2 text-left text-xs font-medium text-foreground hover-lift">
        {icon}
        <span className="flex-auto">{label}</span>
        {summary && <span className="min-w-0 flex-initial truncate font-normal text-muted-foreground">{summary}</span>}
        <ChevronIcon expanded={open} />
      </CollapsibleTrigger>
      <CollapsibleContent className="my-0.5 ml-2 max-h-56 overflow-y-auto border-l pl-2">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The devices of one kind, one row each, the active one checked.
 * LiveKit's `useMediaDeviceSelect` does the work; this replaces its
 * `MediaDeviceSelect` markup, which needed LiveKit's stylesheet. The
 * behaviour is the same: an initial selection applied once, an exact device
 * match, and a device error raised on the room.
 *
 * `menu` sits in a DeviceSection; `list` is a bordered list in Settings.
 */
export function DeviceList({
  kind,
  track,
  initialSelection,
  requestPermissions,
  onActiveDeviceChange,
  variant = 'menu',
}: {
  kind: MediaDeviceKind;
  track?: LocalAudioTrack | LocalVideoTrack;
  initialSelection?: string;
  requestPermissions?: boolean;
  onActiveDeviceChange?: (deviceId: string) => void;
  variant?: 'menu' | 'list';
}) {
  const room = useMaybeRoomContext();
  const onError = useCallback((error: Error) => {
    room?.emit(RoomEvent.MediaDevicesError, error);
  }, [room]);
  const { devices, activeDeviceId, setActiveMediaDevice } = useMediaDeviceSelect({
    kind,
    room,
    track,
    requestPermissions,
    onError,
  });

  // Applied again whenever the selector is rebuilt (a new preview track), with
  // the caller's current choice, as MediaDeviceSelect did.
  const initial = useRef(initialSelection);
  initial.current = initialSelection;
  useEffect(() => {
    if (initial.current !== undefined) void setActiveMediaDevice(initial.current);
  }, [setActiveMediaDevice]);

  const onChange = useRef(onActiveDeviceChange);
  onChange.current = onActiveDeviceChange;
  const previous = useRef('default');
  useEffect(() => {
    if (activeDeviceId !== previous.current) onChange.current?.(activeDeviceId);
    previous.current = activeDeviceId;
  }, [activeDeviceId]);

  const hasDefault = devices.some((device) => device.label.toLowerCase().startsWith('default'));
  const isActive = (deviceId: string, index: number) =>
    deviceId === activeDeviceId || (!hasDefault && index === 0 && activeDeviceId === 'default');

  return (
    <ul
      className={cn(
        'm-0 flex list-none flex-col p-0',
        variant === 'menu' ? 'gap-0.5' : 'overflow-hidden rounded-md border bg-muted',
      )}
    >
      {devices.map((device, index) => {
        const active = isActive(device.deviceId, index);
        return (
          // hover: the Button inside the option lifts
          <li
            key={device.deviceId}
            id={device.deviceId}
            role="option"
            aria-selected={active}
            className={cn(variant === 'list' && 'border-b last:border-b-0')}
          >
            <Button
              type="button"
              variant="ghost"
              className={cn(
                'w-full justify-start gap-2 font-normal',
                variant === 'menu' ? 'h-auto rounded-md p-2 text-xs' : 'h-10 rounded-none px-3 text-[13px]',
                active && 'font-medium',
              )}
              onClick={() => {
                void setActiveMediaDevice(device.deviceId, { exact: true }).catch(() => {
                  // A device that vanished between listing and choosing: the list refreshes.
                });
              }}
            >
              <span className="min-w-0 flex-1 truncate text-left">{device.label}</span>
              {active && <CheckIcon />}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function CheckIcon() {
  return (
    <svg className="size-3 shrink-0 text-muted-foreground" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
