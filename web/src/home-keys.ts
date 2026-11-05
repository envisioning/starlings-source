import { useEffect, useRef, type RefObject } from 'react';

/**
 * Arrow keys over Home's rows.
 *
 * Home is a stack of modules the owner orders, each hiding itself when it has
 * nothing to say, each replacing its rows on every poll. So nothing here is
 * registered and nothing is indexed in state: a row opts in with
 * `data-home-row` on its control, and every keypress reads the rows the
 * document has *right now*, in document order. A module that appears, goes,
 * or redraws between two keypresses cannot leave a stale index behind.
 *
 * Tab stays linear (every row is a real link or button with the global focus
 * ring); the arrows are the fast path over a long page.
 *
 * | Key | Does |
 * | --- | --- |
 * | ↓ / ↑ | next / previous row, across modules |
 * | ⌥↓ / ⌥↑ | first row of the next / previous module |
 * | Home / End | first / last row |
 *
 * A module is the nearest `data-home-module` wrapper (`HomeColumns` draws one
 * per module, whichever column it is in).
 * The row menu (Shift+F10) is the row's own business: `useRowMenu`.
 */

export const HOME_ROW_ATTRIBUTE = 'data-home-row';

function rowsIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[${HOME_ROW_ATTRIBUTE}]`))
    .filter((row) => !(row as HTMLButtonElement).disabled);
}

function moduleOf(container: HTMLElement, row: HTMLElement): HTMLElement | null {
  const module = row.closest<HTMLElement>('[data-home-module]');
  return module && container.contains(module) ? module : null;
}

/** Where a keypress should move focus; `null` leaves the key to the browser. */
export function nextHomeRow(
  container: HTMLElement,
  key: string,
  alt: boolean,
  active: Element | null,
  lastIndex: number,
): HTMLElement | null {
  const rows = rowsIn(container);
  if (rows.length === 0) return null;
  const inRows = active instanceof HTMLElement ? rows.indexOf(active) : -1;
  // The focused row can vanish under the keyboard when a module redraws:
  // start again from where the keyboard last was.
  const focusLost = !(active instanceof HTMLElement) || active === document.body;
  const index = inRows >= 0 ? inRows : focusLost && lastIndex >= 0 ? Math.min(lastIndex, rows.length - 1) : -1;

  switch (key) {
    case 'Home': return rows[0];
    case 'End': return rows[rows.length - 1];
    case 'ArrowDown':
    case 'ArrowUp': {
      const forward = key === 'ArrowDown';
      if (index < 0) return forward ? rows[0] : rows[rows.length - 1];
      if (!alt) return rows[Math.max(0, Math.min(rows.length - 1, index + (forward ? 1 : -1)))] ?? null;
      const modules = rows.map((row) => moduleOf(container, row));
      const current = modules[index];
      if (forward) {
        const next = modules.findIndex((module, i) => i > index && module !== current);
        return next >= 0 ? rows[next] : null;
      }
      const ownFirst = modules.indexOf(current);
      if (ownFirst < index) return rows[ownFirst];
      if (ownFirst === 0) return null;
      return rows[modules.indexOf(modules[ownFirst - 1])];
    }
    default:
      return null;
  }
}

const HANDLED = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

function typingIn(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useHomeKeys(container: RefObject<HTMLElement | null>): void {
  const lastIndex = useRef(-1);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!HANDLED.has(event.key) || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (event.defaultPrevented) return;
      const root = container.current;
      if (!root) return;
      const active = document.activeElement;
      if (typingIn(active)) return;
      // Outside Home (a dialog, the palette, the header): not ours. The one
      // exception is the body, when a row we were on has just been redrawn.
      const inside = active instanceof HTMLElement && root.contains(active);
      if (!inside && !(active === document.body && lastIndex.current >= 0)) return;
      if (inside && !(active as HTMLElement).hasAttribute(HOME_ROW_ATTRIBUTE)) return;
      if (event.altKey && (event.key === 'Home' || event.key === 'End')) return;
      const target = nextHomeRow(root, event.key, event.altKey, active, lastIndex.current);
      if (!target) return;
      event.preventDefault();
      target.focus();
      target.scrollIntoView({ block: 'nearest' });
      lastIndex.current = rowsIn(root).indexOf(target);
    };
    const onFocusIn = (event: FocusEvent) => {
      const root = container.current;
      if (!root || !(event.target instanceof HTMLElement)) return;
      // A row remembers its place; anything else focused forgets it, so an
      // arrow pressed later on the page body scrolls like anywhere else.
      lastIndex.current = event.target.hasAttribute(HOME_ROW_ATTRIBUTE) ? rowsIn(root).indexOf(event.target) : -1;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('focusin', onFocusIn);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('focusin', onFocusIn);
    };
  }, [container]);
}
