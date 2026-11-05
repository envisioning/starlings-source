import { Tip } from './Tip';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/ui/dropdown-menu';
import { Button } from '@/ui/button';
import { PlusIcon } from './action-icons';
import { MenuIcon, type MenuIconName } from './menu-icons';
import { useMenuTrigger } from './menu-focus';
import { CHROME_ICON_BUTTON } from './chrome-classes';

export type SurfaceCreateItem = {
  /** Ends with `…` when it opens a form or sheet. */
  label: string;
  /** The item's glyph in a menu; a single `+` button draws none. */
  icon?: MenuIconName;
  onSelect: () => void;
  disabled?: boolean;
};

/**
 * The one `+` a surface gets, in the header beside Search — the same spot
 * on every member page, the way the phone's bar and the Mac toolbar keep
 * theirs. One item is a button; more is a menu. A surface that
 * creates nothing passes nothing and the slot stays empty.
 */
export function SurfaceCreate({ label, items }: { label: string; items: SurfaceCreateItem[] }) {
  const menu = useMenuTrigger();
  if (items.length === 0) return null;
  const [only] = items;
  if (items.length === 1 && only) {
    return (
      <Tip label={label}><Button
        type="button"
        variant="ghost" size="icon" className={CHROME_ICON_BUTTON}
        aria-label={label}
        disabled={only.disabled}
        onClick={only.onSelect}
      >
        <PlusIcon />
      </Button></Tip>
    );
  }
  return (
    <DropdownMenu>
      <Tip label={label}><DropdownMenuTrigger asChild>
        <Button ref={menu.trigger} type="button" variant="ghost" size="icon" className={CHROME_ICON_BUTTON} aria-label={label}>
          <PlusIcon />
        </Button>
      </DropdownMenuTrigger></Tip>
      <DropdownMenuContent align="end" onCloseAutoFocus={menu.onCloseAutoFocus}>
        {items.map((item) => (
          <DropdownMenuItem key={item.label} disabled={item.disabled} onSelect={item.onSelect}>
            {item.icon && <MenuIcon name={item.icon} />}
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
