import type { ReactNode } from 'react';
import { ArrowRightIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';

/**
 * One tile for every member action on the room-code page: sign in, and the
 * two app downloads. A link and a button draw the same shadcn
 * Button: an icon well, a title over a line, and an arrow that moves on
 * hover. Button is allowed on the guest entry; nothing else here is Radix.
 */
export function HomeTile({ icon, title, detail, href, onClick, iconClassName, className, 'aria-label': ariaLabel }: {
  icon: ReactNode;
  title: ReactNode;
  detail: ReactNode;
  href?: string;
  onClick?: () => void;
  /** The icon's size inside the 48 well; the downloads are 28, the Envisioning glyph 22. */
  iconClassName?: string;
  className?: string;
  'aria-label'?: string;
}) {
  const body = (
    <>
      <span className={cn('grid size-12 flex-none place-items-center rounded-[9px] border bg-(--surface-raised) text-foreground [&>svg]:!size-7', iconClassName)}>
        {icon}
      </span>
      <span className="grid min-w-0 flex-1 gap-[3px]">
        <strong className="text-[15px] leading-[1.2] text-foreground">{title}</strong>
        <span className="text-[13px] leading-[1.2] font-normal text-muted-foreground">{detail}</span>
      </span>
      <ArrowRightIcon
        className="size-5 flex-none text-muted-foreground transition-[transform,color] duration-150 group-hover:translate-x-0.5 group-hover:text-foreground"
        aria-hidden="true"
      />
    </>
  );
  const classes = cn(
    'group h-auto min-h-21 w-full justify-start gap-3 rounded-[10px] border bg-(--surface-raised) p-3.5 text-left whitespace-normal text-foreground no-underline has-[>svg]:px-3.5',
    'hover-edge',
    className,
  );
  if (href) {
    return (
      <Button asChild variant="ghost" className={classes}>
        <a href={href} aria-label={ariaLabel}>{body}</a>
      </Button>
    );
  }
  return (
    <Button type="button" variant="ghost" className={classes} onClick={onClick} aria-label={ariaLabel}>
      {body}
    </Button>
  );
}

/** Two tiles side by side. */
export function HomeTileGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-2.5">{children}</div>;
}
