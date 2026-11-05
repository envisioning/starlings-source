import { t } from './i18n';
import { ownerSession } from './owner-session';
import { toast } from './Toast';
import { workspaceBrand } from './workspace-brand';
import { addWorkspaceHref, currentWorkspace, rememberOrigin, takeAddedFrom } from './workspace-directory';

/**
 * The page a person lands on after Add a workspace: "You're in
 * <name>" once the session is there, or the way back into sign-in when it
 * is not. The workspace they came from goes on this origin's list.
 * Loaded by App only when the address carries `added_from`.
 */
export async function announceArrival(): Promise<void> {
  const from = takeAddedFrom();
  if (from) void rememberOrigin(from);
  const session = await ownerSession();
  const name = workspaceBrand().name;
  if (session.kind === 'owner') {
    toast(t('You’re in {workspace}', { workspace: name }));
    return;
  }
  toast(t('Sign in to finish adding {workspace}.', { workspace: name }), 'neutral', {
    label: t('Sign in'),
    run: () => window.location.assign(addWorkspaceHref(currentWorkspace(), from ?? undefined)),
  });
}
