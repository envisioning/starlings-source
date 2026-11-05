import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { Alert } from '@/ui/alert';
import { Button } from '@/ui/button';

const QUIET = 'flex-none border-destructive/50 bg-transparent text-destructive hover:text-destructive dark:border-destructive/50 dark:bg-transparent';

/**
 * The one way an error reaches a person: red, with a Copy button, so nobody
 * retypes a message from a screenshot. The same look as Meet's ErrorNotice
 * (meet web/src/ErrorNotice.tsx), on the kit's Alert. `onDismiss` adds a
 * Dismiss button.
 */
export function ErrorNotice({ message, onDismiss, className }: { message: string; onDismiss?: () => void; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Alert
      variant="destructive"
      className={cn(
        'flex items-start gap-2.5 rounded-[6px] border-(--error-border) bg-(--error-bg) px-3 py-2.5 text-[13px] leading-normal text-(--danger-ink)',
        className,
      )}
    >
      <span className="min-w-0 flex-[1_1_auto] [overflow-wrap:anywhere]">{message}</span>
      <span className="inline-flex flex-none items-center gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="xs"
          className={QUIET}
          aria-label="Copy error"
          onClick={() => {
            void navigator.clipboard?.writeText(message).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        {onDismiss ? (
          <Button type="button" variant="outline" size="xs" className={QUIET} onClick={onDismiss}>
            Dismiss
          </Button>
        ) : null}
      </span>
    </Alert>
  );
}
