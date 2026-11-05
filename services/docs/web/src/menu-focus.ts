import { useRef, type FocusEvent as ReactFocusEvent } from 'react';

/**
 * Where a menu would have returned focus, when an item opened something
 * that took focus instead (a dialog). The item that opened the dialog is
 * gone once the menu closes, so the dialog has nowhere to return to; it
 * returns here (`useDialogReturnFocus`).
 */
let menuOrigin: HTMLElement | null = null;

/**
 * Radix hands focus back to a menu's trigger a tick after the menu closes
 * (`onCloseAutoFocus`). By then an item may have opened a dialog, a sheet or
 * a picker that took the keyboard; handing focus back would pull it out
 * again. Return it only when nothing else has it — the menu closed on
 * Escape, a click outside, or an item that moved nothing.
 */
export function returnFocusIfFree(event: Event, target: HTMLElement | null | undefined): void {
  event.preventDefault();
  const active = document.activeElement;
  if (active && active !== document.body) {
    menuOrigin = target ?? null;
    return;
  }
  menuOrigin = null;
  if (target?.isConnected) target.focus();
}

/**
 * A dialog's or sheet's `onCloseAutoFocus`. Radix returns focus to what was
 * focused when the overlay opened. When that was a menu item, it no longer
 * exists and focus fell to <body>; this sends it to where the menu came from
 * (the row, or the menu's trigger) instead. An overlay opened from a button
 * that still exists keeps Radix's own return.
 */
export function useDialogReturnFocus(onCloseAutoFocus?: (event: Event) => void) {
  const opener = useRef<Element | null>(null);
  return {
    onFocusCapture: (event: ReactFocusEvent<HTMLElement>) => {
      // The first focus into the overlay: what had focus just before it.
      if (opener.current === null) opener.current = (event.relatedTarget as Element | null) ?? document.body;
    },
    onCloseAutoFocus: (event: Event) => {
      onCloseAutoFocus?.(event);
      if (event.defaultPrevented) return;
      const origin = menuOrigin;
      menuOrigin = null;
      if (opener.current?.isConnected && opener.current !== document.body) return;
      if (origin?.isConnected) {
        event.preventDefault();
        origin.focus();
      }
    },
  };
}

/** A menu trigger's ref, and the `onCloseAutoFocus` that returns focus to it when free. */
export function useMenuTrigger<T extends HTMLElement = HTMLButtonElement>() {
  const trigger = useRef<T>(null);
  return { trigger, onCloseAutoFocus: (event: Event) => returnFocusIfFree(event, trigger.current) };
}
