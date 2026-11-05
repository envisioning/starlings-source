import { useEffect, useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/ui/avatar';
import { cn } from '@/lib/utils';
import type { WebCalendarAttendee } from './owner-agenda';
import { attendeeIsMember, attendeeStatusLabel } from './owner-agenda';
import { avatarSrc } from './avatars';
import { participantInitials } from './participant-initials';
import { subscribePeers } from './team-presence';
import { t } from './i18n';

/**
 * An attendee as a face with their RSVP as a small badge on its corner
 *: declined is a cross, tentative a question mark, no reply a
 * hollow ring, accepted nothing. The face is the member's Meet profile picture
 * when the address is on the roster, initials on a neutral disc otherwise.
 * A member wears a thin ring rather than a second symbol after the name. The
 * Mac and iOS draw the same thing.
 *
 * The wire carries no picture version for an attendee, so the address is
 * resolved against the roster the tab already polls (`subscribePeers` is one
 * shared timer however many faces read it).
 */

/** Lower-cased address to `avatar_updated_at`, for everyone on the roster with a picture. */
function useRosterAvatars(): ReadonlyMap<string, number> {
  const [versions, setVersions] = useState<ReadonlyMap<string, number>>(() => new Map());
  useEffect(() => subscribePeers({
    onValue: ({ peers }) => {
      const next = new Map<string, number>();
      for (const peer of peers) {
        if (peer.email && peer.avatar_updated_at !== null) next.set(peer.email.toLowerCase(), peer.avatar_updated_at);
      }
      setVersions(next);
    },
  }), []);
  return versions;
}

export function AttendeeAvatar({ name, email, status, member, size = 18, separated = false, version }: {
  name: string;
  email?: string;
  /** Undefined draws no badge (a guest not yet invited). */
  status?: WebCalendarAttendee['status'];
  member: boolean;
  size?: number;
  /** A card-coloured edge, so faces overlapping in a stack read as discs. */
  separated?: boolean;
  /** The roster's picture version, when the caller already has it. */
  version?: number | null;
}) {
  const roster = useRosterAvatars();
  const key = email?.trim().toLowerCase() ?? '';
  const resolved = version ?? (key ? roster.get(key) ?? null : null);
  const src = key && resolved !== null ? avatarSrc({ email: key, avatar_updated_at: resolved }) : null;
  const badge = {
    width: 7,
    height: 7,
    viewBox: '0 0 8 8',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    focusable: false,
  };
  return (
    <span
      className={cn('relative inline-flex flex-none rounded-full', separated && 'ring-2 ring-card', status === 'declined' && 'opacity-55')}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <Avatar className="size-full overflow-hidden">
        {src && <AvatarImage className="rounded-full object-cover" src={src} alt="" loading="lazy" />}
        <AvatarFallback
          className="bg-(--surface-raised) font-semibold leading-none text-muted-foreground"
          style={{ fontSize: Math.max(8, Math.round(size * 0.38)) }}
        >
          {participantInitials(name)}
        </AvatarFallback>
      </Avatar>
      {/* The member ring is drawn inside the face, over the picture, so a
          member's face is the same size as everyone else's (meet#1095). */}
      {member && <span className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-inset ring-muted-foreground/60" />}
      {status && status !== 'accepted' && (
        // Inside the face's box, so it never hangs below the row.
        <span className="absolute right-0 bottom-0 inline-flex size-[9px] items-center justify-center rounded-full bg-card text-foreground">
          {status === 'declined' && <svg {...badge}><path d="m1.5 1.5 5 5m0-5-5 5" /></svg>}
          {status === 'tentative' && <svg {...badge}><path d="M2.6 3a1.5 1.5 0 1 1 2.2 1.3c-.5.3-.8.5-.8 1.1m0 1.1v.1" /></svg>}
          {status !== 'declined' && status !== 'tentative' && <svg {...badge}><circle cx="4" cy="4" r="2.6" /></svg>}
        </span>
      )}
    </span>
  );
}

/**
 * The compact guest list: faces overlapping in a row, at most five, then
 * "+N". The first face is on top, so each face's RSVP badge (bottom right)
 * shows over the next one; a fifth of a face is covered, so two initials
 * stay readable.
 */
export const ATTENDEE_STACK_MAX = 5;

export function AttendeeStack({ attendees, size = 22, className }: {
  attendees: WebCalendarAttendee[];
  size?: number;
  className?: string;
}) {
  if (attendees.length === 0) return null;
  // One face too many is not worth a "+1": show it instead.
  const overflow = attendees.length > ATTENDEE_STACK_MAX ? attendees.length - (ATTENDEE_STACK_MAX - 1) : 0;
  const shown = overflow > 0 ? attendees.slice(0, ATTENDEE_STACK_MAX - 1) : attendees;
  const overlap = Math.round(size * 0.2);
  const names = attendees.map((attendee) => `${attendee.name.trim() || attendee.email}, ${attendeeStatusLabel(attendee.status)}`);
  return (
    <span
      className={cn('flex items-center', className)}
      role="group"
      aria-label={t('Guests: {names}', { names: names.join('; ') })}
      title={attendees.map((attendee) => attendee.name.trim() || attendee.email).join('\n')}
    >
      {shown.map((attendee, index) => (
        <span key={attendee.email || attendee.name} className="relative" style={{ marginLeft: index > 0 ? -overlap : 0, zIndex: shown.length - index }}>
          <AttendeeAvatar
            name={attendee.name.trim() || attendee.email}
            email={attendee.email}
            status={attendee.status}
            member={attendeeIsMember(attendee)}
            size={size}
            separated
          />
        </span>
      ))}
      {overflow > 0 && (
        <span
          className="relative inline-flex flex-none items-center justify-center rounded-full bg-(--surface-raised) font-semibold text-muted-foreground ring-2 ring-card"
          style={{ width: size, height: size, marginLeft: -overlap, fontSize: Math.max(8, Math.round(size * 0.38)) }}
          aria-hidden="true"
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}
