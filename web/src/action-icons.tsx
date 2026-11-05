import { CUSTOM_REACTION_LABEL, REACTION_LABELS, RETIRED_REACTION_LABELS } from '@starlings/contracts/reactions';
import { workspaceBrand, type WorkspaceBrand } from './workspace-brand';
import { GatheringDots } from './GatheringDots';
import { isStarlingsRoom } from './meeting-platform';
import type { ReactNode, SVGProps } from 'react';
import { CircleCheckIcon as LucideCircleCheckIcon, ListPlusIcon as LucideListPlusIcon, SplitIcon as LucideSplitIcon, TriangleAlertIcon as LucideTriangleAlertIcon } from 'lucide-react';
import { t } from './i18n';

/** Shared button marks — stroke SVGs matched to Mac SF Symbols. */

/** calendar — Schedule… / Schedule */
export function CalendarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect
        x="2.5"
        y="3.5"
        width="11"
        height="10"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M2.5 6.5h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path
        d="M5.5 2v2.5M10.5 2v2.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Right-side pane — the shared inspector toggle in the surface header. */
export function RightSidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9.5 2.5v11" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/** megaphone — a published CMS event on Home, the Mac's and the phone's glyph */
export function MegaphoneIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M2.5 6.5v3a1 1 0 0 0 1 1H5l6.5 3V2.5L5 5.5H3.5a1 1 0 0 0-1 1Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M13.5 6.5a2 2 0 0 1 0 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <path d="M5.5 10.5l.8 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** video.fill — Start room / Join / Ask to join */
export function VideoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect
        x="1.5"
        y="4"
        width="8.5"
        height="8"
        rx="1.5"
        fill="currentColor"
      />
      <path
        d="M11 6.2 14.5 4.4v7.2L11 9.8Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * person.fill.checkmark / .questionmark / .xmark — the guest mark on a
 * calendar card: other people are on it, and this is what they answered.
 */
export function AttendanceIcon({ attendance, size = 14, className }: {
  attendance: 'confirmed' | 'pending' | 'declined';
  size?: number;
  className?: string;
}) {
  const badge = attendance === 'confirmed'
    ? <path d="m9.6 10.4 1.5 1.5 3.2-3.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    : attendance === 'declined'
      ? <path d="m10.2 8.6 3 3m0-3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      : <path d="M10.4 9.3a1.4 1.4 0 0 1 2.7.4c0 .9-1.3 1-1.3 1.9m0 1.5v.1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />;
  return (
    <svg
      className={['attendance-icon', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="6.2" cy="4.6" r="2.6" fill="currentColor" />
      <path d="M1.4 13.2c.4-3 2.3-4.6 4.8-4.6 1.1 0 2 .3 2.8.8-.6.9-.9 2.1-.7 3.8Z" fill="currentColor" />
      {badge}
    </svg>
  );
}

/**
 * The compact platform mark used by Upcoming and Calendar. Provider marks are
 * deliberately kept here rather than borrowed from a button's generic video
 * icon, so every web surface answers "where will this open?" the same way.
 */
export function MeetingPlatformIcon({ platform, size = 14, className }: {
  platform: string;
  size?: number;
  className?: string;
}) {
  const svgClassName = ['block flex-none', className].filter(Boolean).join(' ');
  if (isStarlingsRoom(platform)) {
    return <WorkspaceMark size={size} className={svgClassName} />;
  }
  if (platform === 'zoom') {
    return (
      <svg className={svgClassName} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M2.3 3.2h11.4v1.45L4.55 11.35h9.15v1.45H2.3v-1.45l9.15-6.7H2.3Z" fill="currentColor" />
      </svg>
    );
  }
  if (platform === 'teams') {
    return (
      <svg className={svgClassName} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M3 3h18v4.25h-6.75V21h-4.5V7.25H3Z" />
      </svg>
    );
  }
  if (platform === 'google_meet') {
    return (
      <svg className={svgClassName} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M12.48 10.92v3.72h5.48c-.24 1.2-1.39 3.52-5.48 3.52-3.3 0-5.99-2.73-5.99-6.1s2.69-6.1 5.99-6.1c1.88 0 3.14.8 3.86 1.49l2.64-2.52C17.2 3.58 15.08 2.5 12.48 2.5 7.24 2.5 3 6.78 3 12s4.24 9.5 9.48 9.5c5.68 0 9.44-3.76 9.44-9.06 0-.61-.07-1.07-.16-1.52h-9.28Z" />
      </svg>
    );
  }
  if (platform === 'none') return <CalendarIcon />;
  return <VideoIcon />;
}

/**
 * hand.wave.fill — the same native symbol used by the Mac and iOS apps. The
 * browser cannot call Image(systemName:), so a mask of the symbol is filled
 * with currentColor, which keeps the control's neutral and disabled states.
 */
const WAVE_SYMBOL = "inline-block size-4 flex-[0_0_16px] bg-current [mask:url('/icons/hand-wave.svg')_center/contain_no-repeat]";

export function WaveIcon({ className }: { className?: string } = {}) {
  return <span className={className ? `${WAVE_SYMBOL} ${className}` : WAVE_SYMBOL} aria-hidden="true" />;
}

/** plus — the quiet affordance for starting a new group conversation. */
export function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** A clipboard — paste, and send what was on it. */
export function PasteIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5.5 3.5h-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1M6 2.5h4v2H6z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

/** arrowshape.turn.up.left — reply to one message inside a conversation. */
export function ReplyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M6 4 2.5 7.5 6 11M3 7.5h6.2a4.3 4.3 0 0 1 4.3 4.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** ellipsis — the one quiet entry point to a message's secondary actions. */
export function MoreActionsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="3" cy="8" r="1.2" fill="currentColor" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <circle cx="13" cy="8" r="1.2" fill="currentColor" />
    </svg>
  );
}

/** Two people — Team, the *who* of Meet. */
export function TeamIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="6" cy="5" r="2.6" fill="currentColor" />
      <path d="M1.4 13.4c0-2.3 2.1-3.8 4.6-3.8s4.6 1.5 4.6 3.8Z" fill="currentColor" />
      <circle cx="11.8" cy="5.8" r="2" fill="currentColor" />
      <path d="M11.1 9.8c2 .1 3.5 1.5 3.5 3.6h-2.9c0-1.4-.4-2.6-1.2-3.5Z" fill="currentColor" />
    </svg>
  );
}

/** Three people — the participant list inside a live meeting, not Team. */
export function MeetingPeopleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="4.2" r="2.1" fill="currentColor" />
      <path d="M3.8 13.5c0-2.4 1.9-4 4.2-4s4.2 1.6 4.2 4Z" fill="currentColor" />
      <circle cx="2.8" cy="6.3" r="1.45" fill="currentColor" />
      <path d="M.5 13.5c.1-1.7 1-2.9 2.5-3.5.6-.2 1.2-.3 1.7-.1-.6.9-1 2.1-1 3.6Z" fill="currentColor" />
      <circle cx="13.2" cy="6.3" r="1.45" fill="currentColor" />
      <path d="M12.3 9.9c.5-.2 1.1-.1 1.7.1 1.5.6 2.4 1.8 2.5 3.5h-3.2c0-1.5-.4-2.7-1-3.6Z" fill="currentColor" />
    </svg>
  );
}

/** A stack — Work, the subject graph rather than only its task list. */
export function DocsIcon() {
  // doc.text — the symbol the Mac and iOS apps use for Docs: a page with its
  // corner turned and lines of text. Outlined, so it reads at nav weight
  // without a knockout colour that would have to track the surface.
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M3.7 2.2h5.4l3.2 3.2v8a.8.8 0 0 1-.8.8H3.7a.8.8 0 0 1-.8-.8V3a.8.8 0 0 1 .8-.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M9.1 2.2v3.2h3.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M5.4 8.2h5.2M5.4 10.4h5.2M5.4 12.6h3.4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function WorkIcon() {
  // tray.full.fill — the same symbol the Mac and iOS apps use for Work: a tray
  // with what is in it, not an abstract stack.
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.2 2.2h7.6M3.4 4.6h9.2M2.6 7h10.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M1.5 9.2h3.3l1.1 1.9h4.2l1.1-1.9h3.3v4.3a.9.9 0 0 1-.9.9H2.4a.9.9 0 0 1-.9-.9Z" fill="currentColor" />
    </svg>
  );
}

/** A compact chart mark for Home's commercial performance card. */
export function ChartIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.5 13.5h11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M4 11V7.5M8 11V4.5M12 11V2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/** A checked list — task actions inside Work, not the Work destination itself. */
export function TasksIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M2 4.4 3.3 5.7 5.6 3.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2 11.2 3.3 12.5 5.6 10.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.55"
      />
      <rect x="7.6" y="3.7" width="6.6" height="1.6" rx="0.8" fill="currentColor" />
      <rect x="7.6" y="10.5" width="6.6" height="1.6" rx="0.8" fill="currentColor" opacity="0.55" />
    </svg>
  );
}

/** doc.on.doc / checkmark — copy action, matches Mac's CopyableURLRow. */
export function CopyLinkIcon({ copied }: { copied: boolean }) {
  if (copied) {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          d="M3.5 8.5 6.5 11.5 12.5 4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect
        x="5.5"
        y="5.5"
        width="7"
        height="8"
        rx="1.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path
        d="M3.5 10.5V3.7A1.2 1.2 0 0 1 4.7 2.5h5.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** An envelope: the channel's forwarding address. */
export function MailIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="2" y="3.5" width="12" height="9" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="m2.6 4.6 5.4 4.2 5.4-4.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** Generic desktop computer — app download affordance without platform branding. */
export function DesktopIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect x="3.5" y="4.5" width="21" height="14.5" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M10 23.5h8M14 19v4.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

/** Generic phone — app download affordance without platform branding. */
export function PhoneIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect x="8" y="2.5" width="12" height="23" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12.5 5.5h3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="14" cy="22" r="0.9" fill="currentColor" />
    </svg>
  );
}

/** exclamationmark.triangle — a room link that no longer resolves. */
export function WarningIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m10.3 4.3-7.2 12.5a1.7 1.7 0 0 0 1.5 2.6h14.8a1.7 1.7 0 0 0 1.5-2.6L13.7 4.3a2 2 0 0 0-3.4 0Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 8.5v4.8m0 3.1v.1" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

/** Arrow up right — marks the only outbound navigation on the home screen. */
export function ExternalLinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path d="M3 11 11 3M5 3h6v6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** xmark — dismiss a sheet or modal. */
export function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="m3.5 3.5 9 9m0-9-9 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** chevron up / down — move a row one place in an ordered list. */
export function ChevronUpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="m3.5 10 4.5-4.5L12.5 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** chevron left / right — the calendar's Earlier and Later. */
export function ChevronLeftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A ring around a dot — the calendar's Today: back to now. */
export function TodayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </svg>
  );
}

export function ChevronRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** magnifier — Search, the ⌘K palette. */
export function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="m10.4 10.4 3.4 3.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function ChevronDownIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="m3.5 6 4.5 4.5L12.5 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** trash — the destructive action, matching the Mac's SF Symbol. */
export function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4.3 5.2h7.4l-.5 8.1H4.8Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M3.2 4.1h9.6M6.1 4.1V2.8h3.8v1.3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.6 6.7v4.3M9.4 6.7v4.3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

/** pencil — the Quick notes row mark, the same `pencil` the Mac and iOS rows draw. */
export function PencilIcon({ size = 16 }: { size?: number } = {}) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="m2.8 13.2.8-3.1 6.8-6.8a1.7 1.7 0 0 1 2.4 0l.7.7a1.7 1.7 0 0 1 0 2.4l-6.8 6.8-3.1.8Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="m9.2 4.2 2.6 2.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/*
 * INBOX marks. No INBOX row draws a bare check in its square: that reads as
 * a checkbox, and no INBOX row completes on a click. Mac and iOS:
 * `WorkInboxItem.glanceSymbolName`.
 */

/** arrow.triangle.branch — a decision, a choice between options. */
export function DecisionIcon({ size = 16 }: { size?: number } = {}) {
  return <LucideSplitIcon width={size} height={size} strokeWidth={1.5} aria-hidden="true" focusable="false" />;
}

/** text.badge.plus — a proposed task, waiting on Accept. */
export function ProposedTaskIcon({ size = 16 }: { size?: number } = {}) {
  return <LucideListPlusIcon width={size} height={size} strokeWidth={1.5} aria-hidden="true" focusable="false" />;
}

/** checkmark.circle — a card in Review; exclamationmark.triangle when Blocked. */
export function InboxCardIcon({ blocked, size = 16 }: { blocked: boolean; size?: number }) {
  const Icon = blocked ? LucideTriangleAlertIcon : LucideCircleCheckIcon;
  return <Icon width={size} height={size} strokeWidth={1.5} aria-hidden="true" focusable="false" />;
}

/** note — the Quick notes row mark. */
export function NoteIcon() {
  return <PencilIcon />;
}

/** calendar — Google Calendar destination, with a small accent mark. */
export function GoogleCalendarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.5 6.5h11M5.5 2v2.5M10.5 2v2.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M5.1 8.6h2.1v2.1H5.1z" fill="var(--accent)" />
    </svg>
  );
}

/** arrow.clockwise — Reload, the same mark the Mac toolbar and iOS use. */
export function ReloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <path
        d="M11.5 7A4.5 4.5 0 1 1 9.9 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M9.3 1.6 9.9 3.5 7.9 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** house.fill — Home, which on every client means today. */
export function HomeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M2.5 7.2 8 2.6l5.5 4.6V13a.8.8 0 0 1-.8.8h-3v-4h-3.4v4h-3a.8.8 0 0 1-.8-.8Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * This workspace's mark (workspace-brand.ts), inked with `currentColor`, so a
 * badge follows its text and the header mark takes `--accent-mark`. An
 * uploaded mark is drawn as a CSS mask: one colour, its outline only, never
 * the file's own colours (MZ, 2026-10-05, the same rule the native apps
 * follow), and as a mask it never runs anything an SVG file might carry.
 * Without an upload, a signed-out page draws the Starlings flock, breathing,
 * never another organization's glyph; signed in, the workspace's initial. No
 * workspace's mark is built in: Envisioning's is its upload too. The product site
 * passes a sample workspace's brand instead of this page's.
 */
export function WorkspaceMark({ size = 14, className, brand = workspaceBrand(), signedOut = false }: {
  size?: number;
  className?: string;
  brand?: WorkspaceBrand;
  /** A page nobody is signed in to: the flock stands in for a missing mark. */
  signedOut?: boolean;
}) {
  if (brand.markUrl) {
    const mask = `url("${brand.markUrl}") center / contain no-repeat`;
    return (
      <span
        className={className}
        aria-hidden="true"
        style={{ display: 'inline-block', width: size, height: size, backgroundColor: 'currentColor', mask, WebkitMask: mask }}
      />
    );
  }
  if (signedOut) return <GatheringDots motion="drift" width={size} height={size} className={className} />;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="24" height="24" rx="6" fill="currentColor" />
      <text x="14" y="19.5" textAnchor="middle" fontSize="15" fontWeight="700" fill="var(--surface-bg, #fff)" fontFamily="Inter, system-ui, sans-serif">
        {Array.from(brand.name.trim())[0]?.toUpperCase() ?? ''}
      </text>
    </svg>
  );
}

/**
 * A chip — Agents, the *software* rather than the *who*. Distinct from
 * `TeamIcon` on purpose: an agent is a peer with no device (see
 * `docs/AGENTS_SURFACE.md`), and the Mac board draws the same idea with SF
 * Symbol `cpu` (`Sources/WorkCardBoardView.swift`).
 */
export function AgentIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="6.8" y="6.8" width="2.4" height="2.4" fill="currentColor" />
      <path
        d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** face.smiling — React, the same SF Symbol the Mac toolbar uses for this button. */
export function ReactionIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="5.9" cy="6.7" r="0.9" fill="currentColor" />
      <circle cx="10.1" cy="6.7" r="0.9" fill="currentColor" />
      <path
        d="M5.4 9.3c.6 1 1.5 1.6 2.6 1.6s2-.6 2.6-1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The semantic label used when a stored reaction has no visible glyph. */
/** The names are the contract's (`reactions.ts`), drawn in the page's language. */
export function reactionLabel(emoji: string): string {
  const label = (REACTION_LABELS as Record<string, string>)[emoji] ?? RETIRED_REACTION_LABELS[emoji] ?? CUSTOM_REACTION_LABEL;
  return t(label);
}

function ReactionSvg({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** Semantic reaction mark — wire emoji stay data, never presentation. */
export function ReactionSymbol({ emoji, size = 16, filled = false }: { emoji: string; size?: number; filled?: boolean }) {
  switch (emoji) {
    case '👍':
      return <ReactionSvg size={size}><path d="M8 10v10H4V10h4Zm0 0 3-7c.3-.7 1.2-1 1.8-.5.7.5 1 1.4.7 2.2L12.8 10h5c1 0 1.7.9 1.5 1.9l-1.2 6.2c-.2 1.1-1.1 1.9-2.2 1.9H8" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></ReactionSvg>;
    case '🎉':
      return <ReactionSvg size={size}><path d="m5 18 4-9 4 4-9 4 1-4Z" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="m13 5 1-2m3 4 2-1m-1 5 2 .5M8 5 7 3M4 8 2 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></ReactionSvg>;
    case '❤️':
      return <ReactionSvg size={size}><path d="M12 20.2S4 15.3 4 9.5C4 7.3 5.6 5.5 7.8 5.5c1.4 0 2.6.8 3.2 1.8.6-1 1.8-1.8 3.2-1.8C16.4 5.5 18 7.3 18 9.5c0 5.8-6 9.6-6 10.7Z" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /></ReactionSvg>;
    case '😂':
      return <ReactionSvg size={size}><circle cx="12" cy="12" r="8.2" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" /><circle cx="9" cy="10" r="1" fill={filled ? 'var(--surface-raised, var(--surface))' : 'currentColor'} /><circle cx="15" cy="10" r="1" fill={filled ? 'var(--surface-raised, var(--surface))' : 'currentColor'} /><path d="M7.5 14c1.1 2 2.6 3 4.5 3s3.4-1 4.5-3" fill="none" stroke={filled ? 'var(--surface-raised, var(--surface))' : 'currentColor'} strokeWidth="1.7" strokeLinecap="round" /></ReactionSvg>;
    case '👏':
      return <ReactionSvg size={size}><path d="m8 20-3.4-6.8a1.4 1.4 0 0 1 2.5-1.2l1.5 2.7-2.2-5a1.3 1.3 0 1 1 2.4-1l2.4 5.1-1.5-5.8a1.3 1.3 0 0 1 2.5-.6l1.8 5.8-.6-3.6a1.2 1.2 0 0 1 2.4-.4l1.3 6.7c.4 2.2-1 4.2-3.2 4.8L8 20Z" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></ReactionSvg>;
    case '🤯':
      return <ReactionSvg size={size}><path d="M8 7.2c-2.2-.3-3.7 1-3.3 3.1-1.3 1.7-.4 3.4 1.3 4.1.1 2.1 1.8 3.1 3.4 2.7 1.2 1.2 2.8 1.1 4 0 1.8.5 3.2-.6 3.1-2.4 1.8-1 1.9-2.8.7-4.2.4-2-1.1-3.4-3.1-3.2-1.4-1.2-3.1-1.1-4.2.1-1.1-.6-1.4-.5-1.9-.2Z" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><path d="M8.5 11h.1m3.2-1.3.1.1m2.1 2.2.1.1m-4 2.2.1.1" stroke={filled ? 'var(--surface-raised, var(--surface))' : 'currentColor'} strokeWidth="2" strokeLinecap="round" /></ReactionSvg>;
    case '👀':
      return <ReactionSvg size={size}><path d="M3.5 12s2.7-4 8.5-4 8.5 4 8.5 4-2.7 4-8.5 4-8.5-4-8.5-4Z" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" /><circle cx="12" cy="12" r="3" fill={filled ? 'var(--surface-raised, var(--surface))' : 'none'} stroke={filled ? 'var(--surface-raised, var(--surface))' : 'currentColor'} strokeWidth="1.2" />{filled && <circle cx="12" cy="12" r="1.35" fill="currentColor" />}</ReactionSvg>;
    case '🙏':
      return <ReactionSvg size={size}><path d="M8.3 4.5c.8 0 1.4.6 1.4 1.4v5.8l-3.2-3.2a1.4 1.4 0 0 0-2 2l4.2 5.2c.7.8 1.7 1.3 2.8 1.3h1c1.1 0 2.1-.5 2.8-1.3l4.2-5.2a1.4 1.4 0 0 0-2-2l-3.2 3.2V5.9c0-.8-.6-1.4-1.4-1.4s-1.4.6-1.4 1.4v5.2" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></ReactionSvg>;
    default:
      return <ReactionIcon />;
  }
}

/** Small semantic mark for work and feature status surfaces. */
export function StatusIcon({ status, size = 16 }: { status: string; size?: number }) {
  if (status === 'works' || status === 'have') {
    return <ReactionSvg size={size}><path d="m5 12 4 4 10-10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></ReactionSvg>;
  }
  if (status === 'partial') {
    return <ReactionSvg size={size}><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M12 4a8 8 0 0 1 0 16" fill="none" stroke="currentColor" strokeWidth="2" /></ReactionSvg>;
  }
  if (status === 'handoff') {
    return <ReactionSvg size={size}><path d="M5 19 19 5m0 0h-7m7 0v7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></ReactionSvg>;
  }
  if (status === 'not-available' || status === 'dont-want') {
    return <ReactionSvg size={size}><path d="M6 6 18 18M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></ReactionSvg>;
  }
  if (status === 'want') {
    return <ReactionSvg size={size}><path d="M12 4v16M4 12h16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></ReactionSvg>;
  }
  return <ReactionSvg size={size}><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeDasharray="2.5 2.5" /></ReactionSvg>;
}

/** Interaction type mark for the Work timeline. */
export function InteractionIcon({ type, size = 16 }: { type: string; size?: number }) {
  switch (type) {
    case 'meeting': return <VideoIcon />;
    case 'email': return <ReactionSvg size={size}><rect x="3.5" y="5" width="17" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="m4 6 8 6 8-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></ReactionSvg>;
    case 'call': return <PhoneIcon />;
    case 'web': return <ExternalLinkIcon />;
    default: return <PencilIcon size={size} />;
  }
}

/** A task glyph; the surrounding square well supplies the record shape. */
export function TaskIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m5 12 4 4 10-10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Empty work checkbox, rendered as a real vector mark. */
export function CheckCircleIcon({ size = 18 }: { size?: number }) {
  return <ReactionSvg size={size}><circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" strokeWidth="1.6" /></ReactionSvg>;
}

/** GitHub issue state mark — neutral ink, with the glyph carrying the meaning. */
/** A pull request: the branch mark GitHub uses, one glyph for every state. */
export function PullIcon({ size = 16 }: { size?: number }) {
  return (
    <ReactionSvg size={size}>
      <circle cx="7" cy="6" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="7" cy="18" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="17" cy="18" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7 8.2v7.6M17 15.8V11a3 3 0 0 0-3-3h-2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </ReactionSvg>
  );
}

export function IssueStateIcon({ open, notPlanned, size = 16 }: {
  open: boolean;
  notPlanned?: boolean;
  size?: number;
}) {
  if (open) {
    return <ReactionSvg size={size}><circle cx="12" cy="12" r="7.8" fill="none" stroke="currentColor" strokeWidth="1.7" /><circle cx="12" cy="12" r="2.2" fill="currentColor" /></ReactionSvg>;
  }
  if (notPlanned) {
    return <ReactionSvg size={size}><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="m7 7 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></ReactionSvg>;
  }
  return <ReactionSvg size={size}><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="m8 12 2.5 2.5L16 9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></ReactionSvg>;
}

/** Settings, from chrome — the header gear on the web, matching the iOS toolbar gear. */
/** A question mark in the same ring the gear and the magnifier sit in. */
export function HelpIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.1 6.3a1.9 1.9 0 1 1 2.7 1.7c-.5.3-.8.6-.8 1.2v.3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.4" r="0.8" fill="currentColor" />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      {/* Eight teeth on the same 45° rhythm as the ring, drawn outside it so
          the gear reads as a gear rather than a dashed circle with spokes. */}
      <path
        d="M8 3V1.4M8 13v1.6M3 8H1.4M13 8h1.6M4.46 4.46 3.32 3.32M11.54 11.54l1.14 1.14M4.46 11.54l-1.14 1.14M11.54 4.46l1.14-1.14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** archive — put a conversation away. */
export function ArchiveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.5 3.5h11v3h-11zM3.5 6.5v6h9v-6M6.5 9h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** bell, struck through while muted. */
export function MuteIcon({ muted = false }: { muted?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4 11.5h8l-1-1.5V7a3 3 0 0 0-6 0v3zM6.5 13.5h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      {muted && <path d="M3 3l10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />}
    </svg>
  );
}

/** send — the arrow in the composer's round button. */
export function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Chevron trigger glyph — matches the transcript disclosure triangle. Points down; `expanded` flips it to point up, toward the row it just opened. */
export function ChevronIcon({ expanded }: { expanded?: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 transition-transform duration-[120ms] ease-in-out${expanded ? ' rotate-180' : ''}`}
    >
      <path
        d="M3 5.5 8 10.5 13 5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A microphone; struck through when it is off. */
export function MicIcon({ on = true }: { on?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {!on && <path d="M2.5 2.5l11 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
    </svg>
  );
}

/** A camera; struck through when it is off. */
export function CameraIcon({ on = true }: { on?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.5" y="4" width="9" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 7l4-2v6l-4-2z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      {!on && <path d="M2.5 2.5l11 11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
    </svg>
  );
}

/** What a call icon takes: a class or a style, as the bar and the tiles size it. */
type CallIconProps = Pick<SVGProps<SVGSVGElement>, 'className' | 'style'>;

/*
 * The call bar's microphone and camera, filled, on and off. Drawn here
 * (paths as LiveKit's components shipped them) so the bar, the prejoin
 * preview and the product site draw one set, with no media library loaded.
 */
export function CallMicIcon({ on = true, ...props }: CallIconProps & { on?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
      {on ? (
        <>
          <path fillRule="evenodd" clipRule="evenodd" d="M2.975 8.002a.5.5 0 0 1 .547.449 4.5 4.5 0 0 0 8.956 0 .5.5 0 1 1 .995.098A5.5 5.5 0 0 1 8.5 13.478V15h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.522a5.5 5.5 0 0 1-4.973-4.929.5.5 0 0 1 .448-.547" />
          <path d="M5 3a3 3 0 1 1 6 0v5a3 3 0 0 1-6 0z" />
        </>
      ) : (
        <>
          <path d="M12.227 11.52a5.48 5.48 0 0 0 1.246-2.97.5.5 0 0 0-.995-.1 4.5 4.5 0 0 1-.962 2.359l-1.07-1.07C10.794 9.247 11 8.647 11 8V3a3 3 0 0 0-6 0v1.293L1.354.646a.5.5 0 1 0-.708.708l14 14a.5.5 0 0 0 .708-.708zM8 12.5c.683 0 1.33-.152 1.911-.425l.743.743c-.649.359-1.378.59-2.154.66V15h2a.5.5 0 0 1 0 1h-5a.5.5 0 0 1 0-1h2v-1.522a5.5 5.5 0 0 1-4.973-4.929.5.5 0 0 1 .995-.098A4.5 4.5 0 0 0 8 12.5" />
          <path d="M8.743 10.907 5 7.164V8a3 3 0 0 0 3.743 2.907" />
        </>
      )}
    </svg>
  );
}

export function CallCameraIcon({ on = true, ...props }: CallIconProps & { on?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
      {on ? (
        <path d="M0 4.5A1.5 1.5 0 0 1 1.5 3h8A1.5 1.5 0 0 1 11 4.5v7A1.5 1.5 0 0 1 9.5 13h-8A1.5 1.5 0 0 1 0 11.5zM15.2 3.6l-2.8 2.1a1 1 0 0 0-.4.8v3a1 1 0 0 0 .4.8l2.8 2.1a.5.5 0 0 0 .8-.4V4a.5.5 0 0 0-.8-.4" />
      ) : (
        <>
          <path d="M1.354.646a.5.5 0 1 0-.708.708l14 14a.5.5 0 0 0 .708-.708L11 10.293V4.5A1.5 1.5 0 0 0 9.5 3H3.707zM0 4.5a1.5 1.5 0 0 1 .943-1.393l9.532 9.533c-.262.224-.603.36-.975.36h-8A1.5 1.5 0 0 1 0 11.5z" />
          <path d="m15.2 3.6-2.8 2.1a1 1 0 0 0-.4.8v3a1 1 0 0 0 .4.8l2.8 2.1a.5.5 0 0 0 .8-.4V4a.5.5 0 0 0-.8-.4" />
        </>
      )}
    </svg>
  );
}

/** The call bar's Leave: a handset put down, as the phone's `phone.down.fill`. */
export function CallLeaveIcon(props: CallIconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
      <path transform="rotate(135 8 8)" fillRule="evenodd" d="M1.885.511a1.745 1.745 0 0 1 2.61.163L6.29 2.98c.329.423.445.974.315 1.494l-.547 2.19a.68.68 0 0 0 .178.643l2.457 2.457a.68.68 0 0 0 .644.178l2.189-.547a1.75 1.75 0 0 1 1.494.315l2.306 1.794c.829.645.905 1.87.163 2.611l-1.034 1.034c-.74.74-1.846 1.065-2.877.702a18.6 18.6 0 0 1-7.01-4.42 18.6 18.6 0 0 1-4.42-7.009c-.362-1.03-.037-2.137.703-2.877z" />
    </svg>
  );
}

/** The call bar's chat. */
export function CallChatIcon(props: CallIconProps) {
  return (
    <svg width="16" height="18" viewBox="0 0 16 18" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
      <path fillRule="evenodd" clipRule="evenodd" d="M0 2.75A2.75 2.75 0 0 1 2.75 0h10.5A2.75 2.75 0 0 1 16 2.75v13.594a.75.75 0 0 1-1.234.572l-3.691-3.12a1.25 1.25 0 0 0-.807-.296H2.75A2.75 2.75 0 0 1 0 10.75zM2.75 1.5c-.69 0-1.25.56-1.25 1.25v8c0 .69.56 1.25 1.25 1.25h7.518c.65 0 1.279.23 1.775.65l2.457 2.077V2.75c0-.69-.56-1.25-1.25-1.25z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M3 4.5a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5m0 2a.5.5 0 0 1 .5-.5h9a.5.5 0 0 1 0 1h-9a.5.5 0 0 1-.5-.5m0 2a.5.5 0 0 1 .5-.5h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5" />
    </svg>
  );
}

/** The call bar's settings: a filled cog, unlike the app chrome's outline GearIcon. */
export function CallSettingsIcon(props: CallIconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
      <path fillRule="evenodd" clipRule="evenodd" d="M8.961.894C8.875-.298 7.125-.298 7.04.894c-.066.912-1.246 1.228-1.76.472-.67-.99-2.186-.115-1.664.96.399.824-.465 1.688-1.288 1.289-1.076-.522-1.95.994-.961 1.665.756.513.44 1.693-.472 1.759-1.192.086-1.192 1.836 0 1.922.912.066 1.228 1.246.472 1.76-.99.67-.115 2.186.96 1.664.824-.399 1.688.465 1.289 1.288-.522 1.076.994 1.95 1.665.961.513-.756 1.693-.44 1.759.472.086 1.192 1.836 1.192 1.922 0 .066-.912 1.246-1.228 1.76-.472.67.99 2.186.115 1.664-.96-.399-.824.465-1.687 1.288-1.289 1.076.522 1.95-.994.961-1.665-.756-.513-.44-1.693.472-1.759 1.192-.086 1.192-1.836 0-1.922-.912-.066-1.228-1.246-.472-1.76.99-.67.115-2.186-.96-1.664-.824.399-1.687-.465-1.289-1.288.522-1.076-.994-1.95-1.665-.961-.513.756-1.693.44-1.759-.472M8 13A5 5 0 1 0 8 3a5 5 0 0 0 0 10" />
    </svg>
  );
}

/** Sharing a screen: a display with an arrow up. */
export function ScreenShareIcon(props: CallIconProps) {
  return (
    <svg width="20" height="16" viewBox="0 0 20 16" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
      <path fillRule="evenodd" clipRule="evenodd" d="M0 2.75A2.75 2.75 0 0 1 2.75 0h14.5A2.75 2.75 0 0 1 20 2.75v10.5A2.75 2.75 0 0 1 17.25 16H2.75A2.75 2.75 0 0 1 0 13.25zM2.75 1.5c-.69 0-1.25.56-1.25 1.25v10.5c0 .69.56 1.25 1.25 1.25h14.5c.69 0 1.25-.56 1.25-1.25V2.75c0-.69-.56-1.25-1.25-1.25z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M9.47 4.22a.75.75 0 0 1 1.06 0l2.25 2.25a.75.75 0 0 1-1.06 1.06l-.97-.97v4.69a.75.75 0 0 1-1.5 0V6.56l-.97.97a.75.75 0 0 1-1.06-1.06z" />
    </svg>
  );
}

/** Stop sharing: the display with a cross. */
export function ScreenShareStopIcon(props: CallIconProps) {
  return (
    <svg width="20" height="16" viewBox="0 0 20 16" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
      <path d="M7.28 4.22a.75.75 0 0 0-1.06 1.06L8.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L10 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L11.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L10 6.94z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M2.75 0A2.75 2.75 0 0 0 0 2.75v10.5A2.75 2.75 0 0 0 2.75 16h14.5A2.75 2.75 0 0 0 20 13.25V2.75A2.75 2.75 0 0 0 17.25 0zM1.5 2.75c0-.69.56-1.25 1.25-1.25h14.5c.69 0 1.25.56 1.25 1.25v10.5c0 .69-.56 1.25-1.25 1.25H2.75c-.69 0-1.25-.56-1.25-1.25z" />
    </svg>
  );
}

/** An encrypted call: a closed padlock. */
export function CallLockIcon(props: CallIconProps) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
      <path fillRule="evenodd" clipRule="evenodd" d="M4 6.104V4a4 4 0 1 1 8 0v2.104c1.154.326 2 1.387 2 2.646v4.5A2.75 2.75 0 0 1 11.25 16h-6.5A2.75 2.75 0 0 1 2 13.25v-4.5c0-1.259.846-2.32 2-2.646M5.5 4a2.5 2.5 0 0 1 5 0v2h-5z" />
    </svg>
  );
}
