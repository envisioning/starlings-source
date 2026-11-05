import { useState } from 'react';
import { Button } from '@/ui/button';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemSeparator, ItemTitle } from '@/ui/item';
import { CheckCircleIcon } from './action-icons';
import { t } from './i18n';
import { SectionCard } from './SectionCard';
import { addressOf, forgetWorkspace, knownWorkspaces, type KnownWorkspace } from './workspace-directory';
import { AddWorkspaceEntry, WorkspaceRowMark } from './workspace-rows';

/**
 * Settings › Workspaces on the web, the twin of the iPhone's:
 * every workspace this browser reached from here, this one first, then Add
 * workspace. Switching opens the other workspace's own address, where its
 * own session decides what shows. Remove takes another workspace off this
 * browser's list; this one has none, sign-out is elsewhere.
 */
export function WorkspacesSection({ ownerEmail }: { ownerEmail: string }) {
  const [list, setList] = useState<KnownWorkspace[]>(() => knownWorkspaces());
  const [adding, setAdding] = useState(false);
  const here = window.location.origin;

  return (
    <SectionCard id="settings-workspaces" title={t('Workspaces')}>
      <ItemGroup aria-label={t('Workspaces')} className="rounded-xl border bg-muted">
        {list.map((workspace, index) => {
          const current = workspace.origin === here;
          return (
            <div key={workspace.origin} role="listitem">
              {index > 0 && <ItemSeparator />}
              <Item size="sm" className="flex-nowrap">
                <ItemMedia><WorkspaceRowMark workspace={workspace} current={current} /></ItemMedia>
                <ItemContent className="min-w-0 gap-0.5">
                  <ItemTitle className="text-[13px] font-semibold">{workspace.name}</ItemTitle>
                  <ItemDescription className="truncate text-xs">
                    {current ? `${addressOf(workspace.origin)} · ${ownerEmail}` : addressOf(workspace.origin)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {current ? (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><CheckCircleIcon size={14} /> {t('Current')}</span>
                  ) : (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        aria-label={t('Remove {workspace}', { workspace: workspace.name })}
                        onClick={() => {
                          forgetWorkspace(workspace.origin);
                          setList(knownWorkspaces());
                        }}
                      >
                        {t('Remove')}
                      </Button>
                      <Button asChild variant="secondary" size="sm">
                        <a href={`${workspace.origin}/`}>{t('Switch')}</a>
                      </Button>
                    </>
                  )}
                </ItemActions>
              </Item>
            </div>
          );
        })}
      </ItemGroup>
      <div>
        <Button type="button" variant="secondary" onClick={() => setAdding(true)}>{t('Add workspace')}</Button>
      </div>
      {adding && (
        <AddWorkspaceEntry
          onClose={() => {
            setAdding(false);
            setList(knownWorkspaces());
          }}
        />
      )}
    </SectionCard>
  );
}
