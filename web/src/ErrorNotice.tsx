import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Alert } from '@/ui/alert';
import { Button } from '@/ui/button';
import { t } from './i18n';
import { helpAvailable, openHelp } from './help-bus';
import { needsClientUpdate } from './client-update';

/** The boxed notice: red ink on a faint red box. */
const ERROR_BOX = 'rounded-[6px] border-(--error-border) bg-(--error-bg) px-3 py-2.5 text-[13px] leading-normal';
/** The inline notice: Alert's frame taken off, the size of the text around it. */
const ERROR_INLINE = 'rounded-none border-0 bg-transparent p-0 text-[length:inherit]';

/**
 * The one way an error reaches a person on the web surface.
 *
 * Every error in Meet reads red and carries a Copy button — the copied text is
 * what a support report needs, so nobody has to retype a message from a
 * screenshot. Inline sites pass the message; the optional `action` (Retry,
 * Try again) sits next to Copy so a failure never renders without its way out.
 *
 * A shadcn Alert (destructive), boxed by default. `inline` takes the box
 * off for a line beside a control; it keeps the red ink and the Copy button.
 * `className` adds to either (a margin, a size).
 */
export function ErrorNotice({
  message,
  inline = false,
  className,
  id,
  role = 'alert',
  action,
  copyText,
}: {
  message: ReactNode;
  inline?: boolean;
  className?: string;
  /** For a field's aria-describedby. */
  id?: string;
  role?: 'alert' | 'status';
  action?: ReactNode;
  /** What Copy puts on the clipboard when `message` is not a plain string. */
  copyText?: string;
}) {
  const text = copyText ?? (typeof message === 'string' ? message : textOf(message));
  // A route this page is too old for: Retry cannot fix it, a reload can.
  const shown = needsClientUpdate(text)
    ? <Button type="button" variant="outline" size="xs" onClick={() => window.location.reload()}>{t('Reload')}</Button>
    : action;
  return (
    <Alert
      id={id}
      variant="destructive"
      role={role}
      className={cn(inline ? ERROR_INLINE : ERROR_BOX, 'flex items-start gap-2.5 text-(--danger-ink)', className)}
    >
      <span className="min-w-0 flex-[1_1_auto] [overflow-wrap:anywhere] [&>p]:m-0">{message}</span>
      <span className="inline-flex flex-none items-center gap-1.5">
        {shown}
        {helpAvailable() && (
          <Button type="button" variant="outline" size="xs" className="flex-none border-destructive/50 bg-transparent text-destructive hover:text-destructive dark:border-destructive/50 dark:bg-transparent" onClick={() => openHelp()}>{t('Get help')}</Button>
        )}
        <CopyErrorButton text={text} />
      </span>
    </Alert>
  );
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return '';
}

export function CopyErrorButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className="flex-none border-destructive/50 bg-transparent text-destructive hover:text-destructive dark:border-destructive/50 dark:bg-transparent"
      aria-label={t('Copy error')}
      onClick={() => {
        void copyErrorText(text).then(ok => setCopied(ok));
      }}
    >
      {copied ? t('Copied') : t('Copy')}
    </Button>
  );
}

/** Message plus where it happened — the two things a report is missing. */
export async function copyErrorText(text: string): Promise<boolean> {
  const stamped = `Meet web — ${text.trim()}\n${window.location.href}\n${navigator.userAgent}`;
  try {
    await navigator.clipboard.writeText(stamped);
    return true;
  } catch {
    return false;
  }
}
