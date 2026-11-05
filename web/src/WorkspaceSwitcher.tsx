import { useState } from 'react';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { ChevronDownIcon, WorkspaceMark } from './action-icons';
import { t } from './i18n';
import { useMenuTrigger } from './menu-focus';
import { useOwnerSession } from './owner-session';
import { workspaceBrand } from './workspace-brand';
import { addressOf, knownWorkspaces, type KnownWorkspace } from './workspace-directory';
import { AddWorkspaceEntry, WorkspaceRowMark } from './workspace-rows';

/**
 * The header's workspace badge: the workspace's mark and name,
 * which opens every workspace this browser knows. This one is checked and
 * shows who is signed in; another opens its own address, as Switch does in
 * Settings › Workspaces. Under the rows: Add workspace (the one entry
 * module) and Manage workspaces (Settings › Workspaces).
 *
 * Loaded on demand by `SiteHeader`: DropdownMenu is Radix, and Radix stays
 * off the entry and App's static graph (web/vite.config.ts).
 */
export function WorkspaceSwitcher() {
  const session = useOwnerSession();
  const [list, setList] = useState<KnownWorkspace[]>(() => knownWorkspaces());
  const [adding, setAdding] = useState(false);
  const menu = useMenuTrigger();
  const here = window.location.origin;
  const email = session.kind === 'owner' ? session.owner.email : null;

  return (
    <>
      <DropdownMenu onOpenChange={(open) => { if (open) setList(knownWorkspaces()); }}>
        <DropdownMenuTrigger asChild>
          <Button
            ref={menu.trigger}
            type="button"
            variant="ghost"
            className="-mx-2 h-auto min-w-0 gap-3 px-2 py-1 text-[22px] font-semibold tracking-[-0.02em]"
          >
            <WorkspaceMark className="block size-7 flex-none text-[var(--accent-mark)]" size={28} />
            <span className="truncate text-foreground">{workspaceBrand().name}</span>
            <span className="flex-none text-muted-foreground"><ChevronDownIcon /></span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72 max-w-[calc(100vw-2rem)]" onCloseAutoFocus={menu.onCloseAutoFocus}>
          {list.map((workspace) => {
            const current = workspace.origin === here;
            const address = addressOf(workspace.origin);
            return (
              <DropdownMenuCheckboxItem
                key={workspace.origin}
                checked={current}
                onSelect={() => { if (!current) window.location.assign(`${workspace.origin}/`); }}
              >
                <WorkspaceRowMark workspace={workspace} current={current} size={20} />
                <span className="grid min-w-0">
                  <span className="truncate font-semibold">{workspace.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {current && email ? `${address} · ${email}` : address}
                  </span>
                </span>
              </DropdownMenuCheckboxItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setAdding(true)}>{t('Add workspace')}</DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href="/settings#settings-workspaces">{t('Manage workspaces')}</a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {adding && <AddWorkspaceEntry onClose={() => setAdding(false)} />}
    </>
  );
}
