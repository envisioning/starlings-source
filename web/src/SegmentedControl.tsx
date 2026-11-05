import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';

/**
 * One choice from a short row, drawn like the Mac and iOS segmented control:
 * one rounded track, the chosen segment filled with the brand accent and dark
 * ink, the others plain muted text. Single choice, so it is a radiogroup with
 * a roving tabindex; the arrow keys move and choose. No Radix, so it can sit
 * in the entry bundle.
 */
export function SegmentedControl<V extends string>({ label, value, options, onChange, disabled, className }: {
  label: string;
  value: V;
  options: ReadonlyArray<{ value: V; label: string }>;
  onChange: (value: V) => void;
  disabled?: boolean;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (event: KeyboardEvent, from: number) => {
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (!forward && !back) return;
    event.preventDefault();
    const to = (from + (forward ? 1 : options.length - 1)) % options.length;
    onChange(options[to].value);
    refs.current[to]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn('grid auto-cols-fr grid-flow-col gap-0.5 rounded-full bg-muted p-0.5', className)}
    >
      {options.map((option, index) => {
        const chosen = option.value === value;
        return (
          // shadcn: no Radix, so it can sit in the entry bundle
          <button
            key={option.value}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="radio"
            aria-checked={chosen}
            tabIndex={chosen ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, index)}
            className={cn(
              'h-7 cursor-pointer rounded-full px-3 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50',
              chosen
                ? 'bg-(--accent-cta) font-medium text-(--on-accent)'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
