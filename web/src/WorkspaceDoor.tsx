import { useState } from 'react';
import { Button } from '@/ui/button';
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/ui/item';
import { HomeTile } from './HomeTile';
import { t } from './i18n';
import { addressOf, knownWorkspaces } from './workspace-directory';
import { AddWorkspaceEntry, WorkspaceRowMark } from './workspace-rows';

/**
 * What the signed-out door shows under Sign in: the other
 * workspaces this browser knows, each a link to its own address, then
 * Enter an address, which opens the one entry module. Nothing here types
 * an address. `variant` follows the Sign in above it: Home's tiles, or a
 * gate's button.
 *
 * Loaded on demand: workspace-directory reads contract code that carries
 * zod, which stays off the guest entry.
 */
export function WorkspaceDoor({ variant = 'button' }: { variant?: 'tile' | 'button' }) {
  const [adding, setAdding] = useState(false);
  const [others] = useState(() => knownWorkspaces().filter((workspace) => workspace.origin !== window.location.origin));

  return (
    <div className="grid gap-3">
      {others.length > 0 && (variant === 'tile' ? (
        others.map((workspace) => (
          <HomeTile
            key={workspace.origin}
            href={`${workspace.origin}/`}
            icon={<WorkspaceRowMark workspace={workspace} current={false} size={22} />}
            iconClassName="[&>svg]:!size-[22px]"
            title={workspace.name}
            detail={addressOf(workspace.origin)}
          />
        ))
      ) : (
        <ItemGroup aria-label={t('Workspaces')} className="rounded-xl border bg-muted">
          {others.map((workspace) => (
            <Item key={workspace.origin} asChild size="sm" className="flex-nowrap no-underline hover-lift" role="listitem">
              <a href={`${workspace.origin}/`}>
                <ItemMedia><WorkspaceRowMark workspace={workspace} current={false} /></ItemMedia>
                <ItemContent className="min-w-0 gap-0.5">
                  <ItemTitle className="text-[13px] font-semibold">{workspace.name}</ItemTitle>
                  <ItemDescription className="truncate text-xs">{addressOf(workspace.origin)}</ItemDescription>
                </ItemContent>
              </a>
            </Item>
          ))}
        </ItemGroup>
      ))}
      <div className="flex justify-center">
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-[13px] font-normal text-muted-foreground hover:text-foreground"
          onClick={() => setAdding(true)}
        >
          {t('Enter an address')}
        </Button>
      </div>
      {adding && <AddWorkspaceEntry onClose={() => setAdding(false)} />}
    </div>
  );
}
