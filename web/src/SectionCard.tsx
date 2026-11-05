import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';

/**
 * One section of a page as shadcn Card: Settings and Admin draw
 * every section with it. The title is a level-2 heading. Its `id` is what the
 * region's `aria-labelledby` and a hash link (`/settings#settings-home`)
 * point at. The content is one column that lets a wide table scroll inside
 * it rather than widen the page.
 */
export function SectionCard({ id, title, className, children }: {
  id: string;
  title: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card role="region" aria-labelledby={id} className={cn('gap-4 py-5 shadow-none', className)}>
      <CardHeader className="px-5">
        <CardTitle id={id} role="heading" aria-level={2} className="text-[15px]">{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-3 px-5">{children}</CardContent>
    </Card>
  );
}

/**
 * One muted line in or under a section: an empty state, a receipt, a status
 *. The terse copy rule keeps it to one sentence. `as="span"`
 * draws it inline, in a table cell or a toolbar.
 */
export function Note({ as: Tag = 'p', className, ...props }: ComponentProps<'p'> & { as?: 'p' | 'span' }) {
  return <Tag className={cn('m-0 text-[13px] text-muted-foreground', className)} {...props} />;
}

/** The hairline frame a table sits in. A wide table scrolls inside it. */
export function TableFrame({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('overflow-x-auto rounded-[10px] border border-border', className)} {...props} />;
}

/** The page column every Admin, Meetings and connector page draws in. */
export const PAGE = 'w-full text-foreground';

/**
 * The ledger tables: Meetings and each connector's page (Granola, GitHub,
 * Slack). A toolbar over the table, then the title, who and state columns.
 * `controls` holds a row's buttons and the picker they open.
 */
export const LEDGER = {
  toolbar: 'flex flex-wrap items-center justify-between gap-3',
  actions: 'flex flex-wrap items-center gap-3',
  title: 'font-semibold',
  who: 'max-w-[260px] truncate text-muted-foreground',
  state: 'min-w-[260px]',
  check: 'w-7 pr-0',
  controls: 'relative inline-flex flex-wrap items-center gap-1.5',
} as const;
