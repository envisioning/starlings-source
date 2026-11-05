import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The page column of a public reference page: Help, Privacy, Terms,
 * Changelog, Feature status and the open standard's pages. It
 * sits on the page like the product pages do: no card, the same title, a
 * column narrow enough to read. The text inside is the `.md` typography
 *.
 *
 * The `h1` rule (base) and `.md` (components) lose to any utility, so a
 * page sets a title size or an element's margin inside `.md` with a plain
 * utility.
 */
export function DocArticle({ wide = false, children }: { wide?: boolean; children: ReactNode }) {
  return (
    <article className={cn(
      'md block text-[16px] text-foreground [&_section]:scroll-mt-22',
      wide ? 'max-w-[920px]' : 'max-w-[720px]',
    )}>
      {children}
    </article>
  );
}

/** The quiet line at the foot of a reference page: its source, its date, what it is not. */
export function DocNote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-7 border-t border-border pt-[18px] text-[13px] text-muted-foreground/70">
      {children}
    </p>
  );
}
