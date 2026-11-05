import { useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { EllipsisIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { returnFocusIfFree } from './menu-focus';
import { t } from './i18n';

/**
 * One row's menu, on any web list: the decisions the Mac and the phone put
 * on a row's context menu (`WorkRowAction`), as far as the browser carries
 * them.
 *
 * Three ways in, one menu:
 * - the `…` button on the row. It shows on hover and on keyboard focus on a
 *   pointer device, and always on touch, where there is no hover;
 * - a right-click on the row;
 * - Shift+F10 or the ContextMenu key while focus is in the row.
 *
 * The menu is shadcn's `DropdownMenu` (Radix), anchored on the `…` button,
 * so Radix owns the arrows, typeahead, Escape and the click outside. When
 * it closes, focus goes back to where the menu came from: the `…` button,
 * or the row's focus target for a right-click or a key. An item that opened
 * something that took the keyboard keeps it (`returnFocusIfFree`).
 *
 * The row's focus target is `options.target`, a selector inside the row.
 * Home passes `[data-home-row]`, the attribute its arrow-key walk reads
 * (`home-keys.ts`), so this file does not know Home. The `…` button never
 * carries that attribute: it is a Tab stop, never an arrow-key stop.
 *
 * ```tsx
 * const menu = useRowMenu({ target: '[data-home-row]' });
 * const row = menu.rowProps(key);
 * <li {...row} className={cn('…', row.className)}>
 *   <a data-home-row href={href}>…</a>
 *   {menu.panel(key, <DropdownMenuItem …>Done</DropdownMenuItem>)}
 * </li>
 * ```
 *
 * `rowProps` carries a `className` (the named group the `…` reads hover and
 * focus from): merge it with the row's own class, never spread it after.
 */
export function useRowMenu(options: { target?: string } = {}): RowMenuController {
  const [menuKey, setMenuKey] = useState<string | null>(null);
  /** Where focus goes when the menu closes. */
  const returnTo = useRef<HTMLElement | null>(null);
  /** An item's own destination, which wins over `returnTo` once. */
  const afterClose = useRef<HTMLElement | null>(null);
  const target = options.target ?? '[data-row-target]';

  function openFor(key: string, row: HTMLElement) {
    returnTo.current = row.querySelector<HTMLElement>(target)
      ?? row.querySelector<HTMLElement>('a[href], button:not([data-row-menu-button])');
    returnTo.current?.focus();
    setMenuKey(key);
  }

  return {
    open: menuKey !== null,
    close: () => setMenuKey(null),
    focusAfterClose: (element) => { afterClose.current = element; },
    rowProps: (key) => ({
      className: 'group/row-menu',
      'data-row-menu': '',
      onContextMenu: (event) => {
        event.preventDefault();
        openFor(key, event.currentTarget);
      },
      onKeyDown: (event) => {
        const contextKey = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
        if (!contextKey || menuKey !== null) return;
        event.preventDefault();
        openFor(key, event.currentTarget);
      },
    }),
    panel: (key, items, panelOptions = {}) => {
      if (items === null || items === undefined || items === false) return null;
      const remember = (event: { currentTarget: HTMLElement }) => { returnTo.current = event.currentTarget; };
      return (
        <DropdownMenu open={menuKey === key} onOpenChange={(open) => setMenuKey(open ? key : null)}>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-row-menu-button=""
              aria-label={t('More actions')}
              onPointerDown={remember}
              onKeyDown={remember}
              className={cn(
                // Quiet: the dots alone, a faint well only under the pointer.
                'size-6 flex-none rounded-md text-muted-foreground/70 hover-lift hover:text-foreground data-[state=open]:bg-foreground/[0.06] data-[state=open]:text-foreground [&_svg:not([class*=size-])]:size-3.5',
                // Hidden until the row is under the pointer or holds focus;
                // always there on touch, where nothing hovers.
                'opacity-0 group-hover/row-menu:opacity-100 group-focus-within/row-menu:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100',
                panelOptions.className,
              )}
            >
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="min-w-[180px]"
            onCloseAutoFocus={(event) => {
              const destination = afterClose.current;
              afterClose.current = null;
              if (destination?.isConnected) {
                event.preventDefault();
                destination.focus();
              } else {
                returnFocusIfFree(event, returnTo.current);
              }
            }}
          >
            {items}
          </DropdownMenuContent>
        </DropdownMenu>
      );
    },
  };
}

/**
 * A `RailRow`'s `menu` prop from one controller: the row's handlers, the
 * select button as the focus target (the hook's default `[data-row-target]`),
 * and the `…` at the row's end. No items, no menu: the row keeps the
 * browser's own right-click.
 */
export function railRowMenu(menu: RowMenuController, key: string, items: ReactNode) {
  if (items === null || items === undefined || items === false) return undefined;
  return {
    rowProps: menu.rowProps(key),
    targetProps: { 'data-row-target': '' },
    panel: menu.panel(key, items, { className: 'mr-1.5' }),
  };
}

export type RowMenuController = {
  open: boolean;
  close: () => void;
  /**
   * Focus this element once the menu has closed. An item's `onSelect` runs
   * while the menu still traps focus, so focusing there is pulled back.
   */
  focusAfterClose: (element: HTMLElement | null) => void;
  rowProps: (key: string) => {
    className: string;
    'data-row-menu': string;
    onContextMenu: (event: MouseEvent<HTMLElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  };
  /**
   * The row's `…` button and its menu. No items (`null`), no button: an
   * action the web cannot do is left out, never faked.
   * `className` places the button: in the row's flow by default; Home's
   * link rows put it in the top corner (`HomeMenuItem`).
   */
  panel: (key: string, items: ReactNode, options?: { className?: string }) => ReactNode;
};
