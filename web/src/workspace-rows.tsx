import { lazy, Suspense } from 'react';
import { WorkspaceMark } from './action-icons';
import type { KnownWorkspace } from './workspace-directory';

/** This workspace's mark comes from its own page; another's is its upload, or its initial. */
export function WorkspaceRowMark({ workspace, current, size = 24 }: { workspace: KnownWorkspace; current: boolean; size?: number }) {
  if (current) return <WorkspaceMark size={size} className="text-foreground" />;
  if (workspace.markUrl) {
    return <img src={workspace.markUrl} alt="" width={size} height={size} className="block object-contain" referrerPolicy="no-referrer" />;
  }
  return <WorkspaceMark size={size} className="text-foreground" brand={{ name: workspace.name, markUrl: null }} />;
}

// The dialog's Radix parts stay off the entry and App's static graph
// (web/vite.config.ts): every door loads the one entry module on first open.
const LazyAddWorkspaceDialog = lazy(async () => ({ default: (await import('./AddWorkspaceDialog')).AddWorkspaceDialog }));

/**
 * The one way into a workspace by its address: Settings ›
 * Workspaces, the header switcher and the signed-out door all open this.
 */
export function AddWorkspaceEntry({ onClose }: { onClose: () => void }) {
  return (
    <Suspense fallback={null}>
      <LazyAddWorkspaceDialog onClose={onClose} />
    </Suspense>
  );
}
