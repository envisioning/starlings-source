import type { ComponentProps, CSSProperties } from 'react';
import { GATHERING_DOTS, GATHERING_MOTION, GATHERING_RADII, GATHERING_VIEWBOX, STARLINGS_WORDMARK } from '@starlings/contracts/gathering-dots';
import { cn } from '@/lib/utils';
import './gathering-dots.css';

// The geometry, the motion and the wordmark's proportions are the registry's
// (@starlings/contracts/gathering-dots); the Mac and the phone draw the same table.
const SIZES = Object.fromEntries(GATHERING_RADII.map((radius, i) => [`--gathering-size-${i}`, `${radius}px`])) as CSSProperties;
const MOTION = {
  '--gathering-drift-period': `${GATHERING_MOTION.driftSeconds}s`,
  '--gathering-drift-low': GATHERING_MOTION.driftLow,
  '--gathering-drift-high': GATHERING_MOTION.driftHigh,
  '--gathering-murmuration-period': `${GATHERING_MOTION.murmurationSeconds}s`,
  '--gathering-thinking-period': `${GATHERING_MOTION.thinkingSeconds}s`,
  '--gathering-busy-period': `${GATHERING_MOTION.busySeconds}s`,
} as CSSProperties;

type GatheringMotion = 'still' | 'drift' | 'murmuration' | 'thinking' | 'busy';

/** A fixed 4 × 4 flock. Motion changes radius only; reduced motion restores the resting icon. */
export function GatheringDots({
  motion = 'still',
  className,
  style,
  ...props
}: ComponentProps<'svg'> & { motion?: GatheringMotion }) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${GATHERING_VIEWBOX} ${GATHERING_VIEWBOX}`}
      width={props.width ?? GATHERING_VIEWBOX}
      height={props.height ?? GATHERING_VIEWBOX}
      fill="currentColor"
      className={cn('gathering-dots', className)}
      data-motion={motion}
      aria-hidden={props['aria-hidden'] ?? (props['aria-label'] ? undefined : true)}
      focusable="false"
      style={{ ...SIZES, ...MOTION, ...style }}
    >
      {GATHERING_DOTS.map((dot, i) => (
        <circle
          key={i}
          cx={dot.x}
          cy={dot.y}
          r={dot.radius}
          style={{ '--gathering-phase': dot.phase, '--gathering-rest': `${dot.radius}px`, '--gathering-drift-phase': dot.driftPhase, '--gathering-drift-factor': dot.driftFactor } as CSSProperties}
        />
      ))}
    </svg>
  );
}

const WORDMARK_STYLE = {
  gap: `${STARLINGS_WORDMARK.gapEm}em`,
  fontWeight: STARLINGS_WORDMARK.weight,
  letterSpacing: `${STARLINGS_WORDMARK.trackingEm}em`,
} satisfies CSSProperties;
const FLOCK_STYLE = { width: `${STARLINGS_WORDMARK.flockEm}em`, height: `${STARLINGS_WORDMARK.flockEm}em` } satisfies CSSProperties;

/**
 * The Starlings wordmark: `Starlings` in Inter, the flock after it,
 * drifting. The product's name wherever no workspace is in view (the public
 * site). The caller sets the font size; the gap, tracking and flock scale
 * with it.
 */
export function StarlingsWordmark({ motion = 'drift', className, style, ...props }: ComponentProps<'span'> & { motion?: GatheringMotion }) {
  return (
    <span {...props} className={cn('inline-flex items-center', className)} style={{ ...WORDMARK_STYLE, ...style }}>
      {STARLINGS_WORDMARK.word}<GatheringDots motion={motion} className="flex-none" style={FLOCK_STYLE} />
    </span>
  );
}
