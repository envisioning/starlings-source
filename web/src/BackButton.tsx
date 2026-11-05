import { ArrowLeftIcon } from 'lucide-react';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';

/**
 * The site-wide return (docs/SURFACES.md, "Returning one step"): one
 * control, one word, top-left of the surface it returns from. A shadcn
 * ghost Button. The surface shell shows it only on a phone while a column
 * is open.
 */
export function BackButton({ label, onClick, className }: { label: string; onClick: () => void; className?: string }) {
  return (
    <Button type="button" variant="ghost" size="sm" className={cn('-ml-2 mb-3 self-start text-muted-foreground', className)} onClick={onClick}>
      <ArrowLeftIcon aria-hidden="true" />
      {label}
    </Button>
  );
}
