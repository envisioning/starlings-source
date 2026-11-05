import { Tip } from './Tip';
import type { FavoriteTarget } from '@starlings/contracts/favorites';
import { useState, type ReactNode } from 'react';
import { StarIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Toggle } from '@/ui/toggle';
import { t } from './i18n';
import { isFavorite, setFavorite, useFavorites } from './favorites';

/** The interactive star control used in detail headers. */
export function StarToggle({ starred, disabled, onToggle, className }: {
  starred: boolean;
  disabled?: boolean;
  onToggle: (next: boolean) => void;
  className?: string;
}) {
  const label = starred ? t('Unstar') : t('Star');
  return (
    <Tip label={label}>
      {/* Tip's trigger would name the slot `tooltip-trigger` and drop the
          component's base reset; the star keeps its own. */}
      <Toggle
        data-slot="toggle"
        size="sm"
        pressed={starred}
        disabled={disabled}
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
        onPressedChange={onToggle}
        className={cn(
          'size-7 min-w-7 flex-none p-0 text-inherit hover:text-foreground disabled:cursor-progress',
          'data-[state=on]:bg-transparent data-[state=on]:text-inherit',
          className,
        )}
      >
        <StarIcon strokeWidth={1.7} className={cn('size-4', starred && 'fill-current')} />
      </Toggle>
    </Tip>
  );
}

/** A quiet status mark for rows without a leading avatar or glyph. */
export function StarMark({ starred, className }: { starred: boolean; className?: string }) {
  if (!starred) return null;
  const label = t('Starred');
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn('inline-flex size-7 flex-none items-center justify-center text-inherit', className)}
    >
      <StarIcon strokeWidth={1.7} className="size-4 fill-current" />
    </span>
  );
}

export { StarredLeading } from './rail-row';

/** The shared-favorites status mark for a row. Changes stay in its menu. */
export function FavoriteMark({ kind, targetRef, className }: {
  kind: FavoriteTarget['kind'];
  targetRef: string;
  className?: string;
}) {
  const { rows } = useFavorites();
  return <StarMark starred={isFavorite(rows, { kind, target_ref: targetRef })} className={className} />;
}

export function FavoriteToggle({ kind, targetRef }: {
  kind: FavoriteTarget['kind'];
  targetRef: string;
}) {
  const { rows } = useFavorites();
  const target = { kind, target_ref: targetRef } satisfies FavoriteTarget;
  const starred = isFavorite(rows, target);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function toggle(next: boolean) {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await setFavorite(target, next);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <StarToggle starred={starred} disabled={busy} onToggle={(next) => { void toggle(next); }} />
      {failed && <span className="sr-only" role="status">{t('Couldn’t update favorites.')}</span>}
    </>
  );
}
