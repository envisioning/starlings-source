import { useEffect, useState, type CSSProperties } from 'react';
import { Toaster, toast as sonner } from 'sonner';
import { Button } from '@/ui/button';
import { ErrorNotice } from './ErrorNotice';
import { ACTION_MS, DANGER_MS, NEUTRAL_MS, type ToastItem } from './Toast';
import { useThemePreference } from './theme';

/** One id for every toast, so a new one replaces the one showing: no stack, no queue. */
const TOAST_ID = 'meet-toast';

/**
 * The sonner half of `Toast.tsx`, loaded with the first toast. The Toaster
 * mounts first and the toast follows a frame later, so a screen reader is
 * already listening to sonner's live region when the text arrives.
 */
export default function ToastSonner({ item }: { item: ToastItem }) {
  const [preference] = useThemePreference();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const danger = item.tone === 'danger';
    sonner.custom((id) => (
      // The capsule is the target: a click or tap dismisses it.
      // hover: a dismiss target, not a control
      <div
        className={`w-full cursor-default rounded-full border bg-popover px-3.5 py-2 text-[13px] leading-snug font-medium text-popover-foreground shadow-[var(--shadow-raised)] [overflow-wrap:anywhere] ${danger ? 'text-left' : 'text-center'}`}
        onClick={() => sonner.dismiss(id)}
      >
        {danger ? <ErrorNotice inline className="items-center" role="status" message={item.text} /> : item.text}
        {item.action && (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="ml-3 h-auto p-0 text-[13px] font-semibold text-(--accent-mark) underline-offset-2"
            onClick={(event) => { event.stopPropagation(); sonner.dismiss(id); item.action?.run(); }}
          >
            {item.action.label}
          </Button>
        )}
      </div>
    ), { id: TOAST_ID, duration: danger ? DANGER_MS : item.action ? ACTION_MS : NEUTRAL_MS });
  }, [ready, item]);

  return (
    <Toaster
      position="bottom-center"
      theme={preference === 'auto' ? 'system' : preference}
      offset={{ bottom: 'calc(24px + env(safe-area-inset-bottom))' }}
      mobileOffset={{ bottom: 'calc(16px + env(safe-area-inset-bottom))' }}
      toastOptions={{ unstyled: true, className: 'flex w-full justify-center' }}
      style={{ '--width': 'min(480px, calc(100vw - 48px))' } as CSSProperties}
    />
  );
}
