import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';

/**
 * The row of section links under a document's lede (Privacy, Terms, Features
 * status, a Docs document's outline): outline Button links, one per anchor or
 * related page. A link with `onSelect` is the page's to follow (Docs scrolls
 * its reader or its editor), the address only what a modified click opens.
 */
export function DocToc({ label, links, className }: {
  label: string;
  links: ReadonlyArray<{ href: string; label: string; onSelect?: () => void }>;
  className?: string;
}) {
  return (
    <nav className={cn('mb-7 flex flex-wrap gap-2', className)} aria-label={label}>
      {links.map((link) => (
        <Button
          key={`${link.href}:${link.label}`}
          asChild
          variant="outline"
          size="sm"
          className="h-auto rounded-full px-2.5 py-1.5 text-xs text-muted-foreground no-underline hover:text-foreground"
        >
          <a
            href={link.href}
            onClick={link.onSelect ? (event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              link.onSelect?.();
            } : undefined}
          >
            {link.label}
          </a>
        </Button>
      ))}
    </nav>
  );
}
