import { useState, type DragEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { t } from './i18n';

/**
 * One column of a drag board: a stage head with its count, the cards, and a
 * drop target that names the card by the id its drag carried. The Signals
 * pipeline and a project's Board (docs/BOARD.md) both draw it.
 */
export function BoardColumn({ title, count, onDropCard, children }: {
  title: string;
  count: number;
  /** The id a card's `boardCardDrag` put on the drag. */
  onDropCard: (id: string) => void;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  return (
    <section
      aria-label={title}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        const id = event.dataTransfer.getData('text/plain');
        if (id) onDropCard(id);
      }}
      className={cn('grid min-w-0 content-start gap-2 rounded-md p-2', over ? 'bg-muted' : 'bg-transparent')}
    >
      <h3 className="m-0 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
        {title}{count > 0 && ` · ${count}`}
      </h3>
      {count === 0 && <p className="m-0 text-xs text-muted-foreground">{t('Nothing here.')}</p>}
      {children}
    </section>
  );
}

/** What a draggable card spreads: the drag carries its id and nothing else. */
export function boardCardDrag(id: string) {
  return {
    draggable: true,
    onDragStart: (event: DragEvent<HTMLElement>) => {
      event.dataTransfer.setData('text/plain', id);
      event.dataTransfer.effectAllowed = 'move';
    },
  };
}
