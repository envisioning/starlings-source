import { cva, type VariantProps } from 'class-variance-authority';
import type { AgentAvatarIdentity } from '@starlings/contracts/agent-avatar-values';
import { Avatar } from '@/ui/avatar';
import { cn } from '@/lib/utils';

/*
 * The parts of a face that need no data: the sizes, the presence dot and an
 * agent's seeded body. PeerAvatar adds the roster's pictures and presence;
 * the product site draws the same faces with sample identities.
 */

type PresenceStatus = 'in_meeting' | 'busy' | 'available' | 'active' | 'dnd' | 'offline';

/*
 * A face on shadcn Avatar. Two sizes: `row` for rails, rows and
 * headers, `tile` for the lounge. The root does not clip, so the presence dot
 * can sit on the rim; the picture and the initials clip themselves.
 */
export const face = cva('overflow-visible', {
  variants: {
    size: {
      row: 'size-[38px]',
      tile: 'mb-2 size-14',
    },
  },
  defaultVariants: { size: 'row' },
});

export const initials = cva('bg-muted font-semibold tracking-[.04em] text-foreground', {
  variants: {
    size: {
      row: 'text-xs',
      tile: 'text-lg',
    },
  },
  defaultVariants: { size: 'row' },
});

export const dot = cva('absolute rounded-full border-2 border-solid border-card', {
  variants: {
    size: {
      row: '-right-px -bottom-px size-[11px]',
      tile: 'right-px bottom-px size-[13px]',
    },
  },
  defaultVariants: { size: 'row' },
});

export function AgentAvatar({ identity, size, className }: {
  identity: Pick<AgentAvatarIdentity, 'color' | 'body_path' | 'eyes_path'>;
  size?: FaceSize;
  className?: string;
}) {
  return (
    <Avatar className={cn(face({ size }), 'border border-border bg-(--surface-raised)', className)} aria-hidden="true">
      <svg className="size-full overflow-visible" viewBox="-120 -120 240 240" focusable="false">
        <path
          d={identity.body_path}
          fill={identity.color}
          style={{ filter: 'drop-shadow(0 2px 2px rgb(32 33 40 / 18%))' }}
        />
        <path d={identity.eyes_path} fill="#fff" />
      </svg>
    </Avatar>
  );
}

/** The dot's colour per status. Offline has no dot; the face dims instead. */
export const PRESENCE: Record<PresenceStatus, string> = {
  in_meeting: 'bg-[var(--presence-in-meeting)]',
  busy: 'bg-[var(--busy)]',
  available: 'bg-[var(--accent)]',
  active: 'bg-[var(--accent)]',
  // A step below active, mixed opaque: a dot is never translucent (2026-09-15).
  dnd: 'bg-[color-mix(in_srgb,var(--text-muted)_50%,var(--surface))]',
  offline: '',
};

export type FaceSize = VariantProps<typeof face>['size'];
