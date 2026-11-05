import { lazy, Suspense, useEffect, useState } from 'react';

/**
 * The passing word on the web: one capsule at the bottom of the viewport,
 * gone on its own. See docs/DESIGN.md, "Toast — the passing word", for when a
 * toast is the right thing to say.
 *
 * One at a time: a second toast replaces the first rather than stacking. A
 * neutral toast lasts `NEUTRAL_MS`; a danger toast draws through `ErrorNotice`,
 * so it reads red with Copy, and stays `DANGER_MS`. A click dismisses either.
 *
 * `toast()` is a plain function so a handler can call it without threading a
 * prop; `<ToastHost />` is mounted once, at the app root, and is the only
 * thing that listens. The drawing is sonner, which `ToastHost`
 * loads with the first toast: a guest who never sees one never downloads it.
 */
export type ToastTone = 'neutral' | 'danger';

/** A word on the capsule that does something, such as Open on "Sent to Vocab". */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
  action?: ToastAction;
}

export const NEUTRAL_MS = 3_000;
export const DANGER_MS = 8_000;
/** Long enough to read the line and reach for the button. */
export const ACTION_MS = 6_000;

const ToastSonner = lazy(() => import('./ToastSonner'));

let nextId = 1;
let current: ToastItem | null = null;
const listeners = new Set<(item: ToastItem | null) => void>();

export function toast(text: string, tone: ToastTone = 'neutral', action?: ToastAction) {
  const line = text.trim();
  if (!line) return;
  current = { id: nextId++, text: line, tone, ...(action && tone === 'neutral' ? { action } : {}) };
  for (const listener of listeners) listener(current);
}

export function ToastHost() {
  const [item, setItem] = useState<ToastItem | null>(current);

  useEffect(() => {
    listeners.add(setItem);
    return () => { listeners.delete(setItem); };
  }, []);

  // Nothing said yet: nothing loaded, nothing mounted.
  if (!item) return null;
  return (
    <Suspense fallback={null}>
      <ToastSonner item={item} />
    </Suspense>
  );
}
