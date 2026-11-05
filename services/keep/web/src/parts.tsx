import { useEffect, useState, type ReactNode } from 'react';
import { EyeIcon, EyeOffIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Alert } from '@/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Input } from '@/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/ui/sheet';
import { Tip } from './Tip';

/*
 * Keep's own parts on the kit (web/src/ui, copied from Meet): navigation,
 * the toast, the panel, the gate card, the notices, the data-loss confirm
 * and the secret input. A screen draws with these and the kit, and with
 * utilities. No screen has a class of its own in styles.css.
 */

export function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new Event('keep:navigate'));
}

export function Link({ to, className, current, children }: { to: string; className?: string; current?: boolean; children: ReactNode }) {
  return (
    <a
      href={to}
      className={className}
      aria-current={current ? 'page' : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/**
 * A panel at the right edge: an item, an editor, the members. The kit's
 * Sheet, so Escape and a click outside close it. The caller mounts it only
 * while it is open, so its state (a revealed value) goes with it.
 */
export function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="w-full gap-0 sm:max-w-[520px]">
        <SheetHeader className="border-b pr-12">
          <SheetTitle className="truncate">{title}</SheetTitle>
          <SheetDescription className="sr-only">{title}</SheetDescription>
        </SheetHeader>
        <div className="grid content-start gap-3 overflow-y-auto p-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * A gate: sign in, set up, unlock. One card in the middle of the window, or
 * of the page column when the shell is already drawn (`inShell`).
 */
export function Gate({ title, inShell = false, children }: { title: ReactNode; inShell?: boolean; children: ReactNode }) {
  return (
    <div className={cn('grid place-items-center', inShell ? 'py-12' : 'min-h-screen p-6')}>
      <Card className="w-[min(440px,100%)] gap-3.5 px-8 py-8 shadow-(--shadow-raised)">
        <h1 className="m-0 text-[26px]">{title}</h1>
        {children}
      </Card>
    </div>
  );
}

/** A page's title, the fact line under it, and its actions. No eyebrow. */
export function PageHeader({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {typeof title === 'string' ? <h1 className="m-0 text-[clamp(24px,2.6vw,30px)]">{title}</h1> : title}
        {meta && <p className="mt-1.5 mb-0 text-[12.5px] text-muted-foreground">{meta}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Small muted text: a footer under a control, a status line. */
export function Fine({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('m-0 text-[13px] leading-normal text-muted-foreground', className)}>{children}</p>;
}

/**
 * An error: red, with a Copy button, so nobody retypes a message from a
 * screenshot. The same look as Meet's ErrorNotice, on the kit's Alert.
 */
export function ErrorNotice({ message, className }: { message: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Alert
      variant="destructive"
      className={cn('flex items-start gap-2.5 rounded-[6px] border-(--error-border) bg-(--error-bg) px-3 py-2.5 text-[13px] leading-normal text-(--danger-ink)', className)}
    >
      <span className="min-w-0 flex-[1_1_auto] [overflow-wrap:anywhere]">{message}</span>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="flex-none border-destructive/50 bg-transparent text-destructive hover:text-destructive dark:border-destructive/50 dark:bg-transparent"
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
    </Alert>
  );
}

/** A warning that stays on screen: no recovery key, a share shown once. */
export function Warning({ children }: { children: ReactNode }) {
  return (
    <Alert role="status" className="block rounded-[6px] border-l-2 border-l-(--accent-cta) px-3 py-2.5 text-[13px] leading-normal">
      {children}
    </Alert>
  );
}

/**
 * The confirm for a destructive act: one that destroys content or ends
 * someone's access (MZ, 2026-10-06). The title asks the act with its object,
 * the body says what is lost, and the action repeats the verb. `final`
 * (the default) adds "This can’t be undone."; an act a member can reverse,
 * such as a revoke, sets it to false.
 */
export function ConfirmDataLoss({ title, body, action, final = true, onConfirm, onCancel }: {
  title: string;
  body: string;
  action: string;
  final?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open onOpenChange={(open) => { if (!open) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{final ? `${body} This can’t be undone.` : body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>{action}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

let toastListener: ((message: string) => void) | null = null;
export function toast(message: string): void {
  toastListener?.(message);
}

/** The passing word: one line at the bottom centre, three seconds, one at a time. */
export function Toaster() {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    toastListener = (next) => setMessage(next);
    return () => {
      toastListener = null;
    };
  }, []);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 3000);
    return () => window.clearTimeout(timer);
  }, [message]);
  return (
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4">
      {message && (
        <div className="pointer-events-auto rounded-md border bg-popover px-3.5 py-2 text-[13px] text-popover-foreground shadow-(--shadow-raised)" onClick={() => setMessage(null)}>
          {message}
        </div>
      )}
    </div>
  );
}

/** Copy, then say so. The clipboard is the one place plaintext leaves this page. */
export async function copy(value: string, label = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast(label);
  } catch {
    toast('Couldn’t copy');
  }
}

export function when(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

/** A secret input with a Show/Hide beside it: a person can always see what they typed. */
export function SecretInput({
  id,
  value,
  onChange,
  autoComplete = 'new-password',
  autoFocus = false,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: 'new-password' | 'current-password' | 'off';
  autoFocus?: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        className="flex-1 font-mono"
        type={shown ? 'text' : 'password'}
        autoComplete={autoComplete}
        spellCheck={false}
        autoCapitalize="off"
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <Tip label={shown ? 'Hide' : 'Show'}>
        <Button type="button" variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={() => setShown((current) => !current)} aria-label={shown ? 'Hide' : 'Show'}>
          {shown ? <EyeOffIcon /> : <EyeIcon />}
        </Button>
      </Tip>
    </div>
  );
}
