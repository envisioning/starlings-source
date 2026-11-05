import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Spinner } from '@/ui/spinner';
import { CheckCircleIcon } from './action-icons';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import {
  ADDRESS_SUFFIX,
  addWorkspaceHref,
  addressOf,
  addressOrigin,
  lookUpWorkspace,
  showsSuffix,
  WorkspaceLookupError,
  type KnownWorkspace,
} from './workspace-directory';
import { WorkspaceRowMark } from './workspace-rows';

type Lookup =
  | { kind: 'idle' }
  | { kind: 'looking' }
  | { kind: 'found'; workspace: KnownWorkspace }
  | { kind: 'failed'; message: string };

/**
 * Add a workspace, the browser's half of the flow the apps
 * share: the heading, one address field with the `.<suffix>` suffix,
 * a lookup as the person types, one line on what happens next, and one
 * full-width button that opens the workspace's own sign-in. The workspace
 * says "You're in <name>" when the person lands (workspace-arrival.ts).
 *
 * The web's one entry module. Every door opens it through
 * `AddWorkspaceEntry` (workspace-rows.tsx); no other file looks up an
 * address. A lookup never puts a workspace on the list: only a sign-in does.
 */
export function AddWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const fieldId = useId();
  const [address, setAddress] = useState('');
  const [lookup, setLookup] = useState<Lookup>({ kind: 'idle' });
  const [leaving, setLeaving] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const pending = useRef<AbortController | null>(null);

  // Back from the sign-in restores this page from the cache, still busy.
  useEffect(() => {
    const reset = () => setLeaving(false);
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);

  useEffect(() => {
    pending.current?.abort();
    if (!addressOrigin(address)) {
      setLookup({ kind: 'idle' });
      return;
    }
    setLookup({ kind: 'looking' });
    const controller = new AbortController();
    pending.current = controller;
    const timer = window.setTimeout(() => {
      lookUpWorkspace(address, controller.signal).then(
        (workspace) => { if (!controller.signal.aborted) setLookup({ kind: 'found', workspace }); },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setLookup({ kind: 'failed', message: error instanceof WorkspaceLookupError ? t(error.message) : t('No workspace at that address.') });
        },
      );
    }, 400);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [address, retryKey]);

  const found = lookup.kind === 'found' ? lookup.workspace : null;
  const isHere = found?.origin === window.location.origin;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (isHere || leaving) return;
    let workspace = found;
    if (!workspace) {
      // Return before the lookup rested: look up now.
      pending.current?.abort();
      setLookup({ kind: 'looking' });
      try {
        workspace = await lookUpWorkspace(address);
        setLookup({ kind: 'found', workspace });
      } catch (error) {
        setLookup({ kind: 'failed', message: error instanceof WorkspaceLookupError ? t(error.message) : t('No workspace at that address.') });
        return;
      }
      if (workspace.origin === window.location.origin) return;
    }
    setLeaving(true);
    window.location.assign(addWorkspaceHref(workspace));
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !leaving) onClose(); }}>
      <DialogContent className="gap-4 p-5 sm:max-w-md">
        <DialogTitle>{t('Add a workspace')}</DialogTitle>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
          <div className="grid gap-1.5">
            <Label htmlFor={fieldId}>{t('Workspace address')}</Label>
            <div className="flex h-11 items-center rounded-md border border-input bg-[var(--surface-raised)] pr-3 focus-within:ring-[3px] focus-within:ring-ring/50">
              <Input
                id={fieldId}
                name="workspace"
                autoFocus
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="your-team"
                value={address}
                disabled={leaving}
                onChange={(event) => setAddress(event.target.value)}
                className="h-full min-w-0 flex-1 border-0 bg-transparent text-base shadow-none focus-visible:ring-0 dark:bg-transparent"
              />
              {showsSuffix(address) && <span className="flex-none text-muted-foreground">{ADDRESS_SUFFIX}</span>}
            </div>
          </div>

          {lookup.kind === 'looking' && (
            <p className="m-0 inline-flex items-center gap-2 text-[13px] text-muted-foreground"><Spinner /> {t('Looking up…')}</p>
          )}
          {lookup.kind === 'found' && (
            <div className="flex items-start gap-3 rounded-[10px] border border-border bg-muted p-3">
              <WorkspaceRowMark workspace={lookup.workspace} current={isHere} size={32} />
              <div className="min-w-0">
                <p className="m-0 inline-flex items-center gap-1 text-[14px] font-semibold text-foreground">
                  {lookup.workspace.name} <CheckCircleIcon size={14} />
                </p>
                <p className="m-0 truncate text-xs text-muted-foreground">{addressOf(lookup.workspace.origin)}</p>
                <p className="m-0 text-xs text-muted-foreground">
                  {isHere
                    ? t('You’re in this workspace.')
                    : lookup.workspace.domains.length > 0
                      ? t('For accounts on {domains}.', { domains: lookup.workspace.domains.join(', ') })
                      : null}
                </p>
              </div>
            </div>
          )}
          {lookup.kind === 'failed' && (
            <ErrorNotice
              inline
              message={lookup.message}
              className="text-[13px]"
              action={<Button type="button" variant="outline" size="xs" onClick={() => setRetryKey((key) => key + 1)}>{t('Retry')}</Button>}
            />
          )}

          <DialogDescription className="m-0 text-[13px]">
            {t('You’ll sign in, then land in the new workspace.')}
          </DialogDescription>

          <Button type="submit" size="lg" className="w-full" disabled={!address.trim() || isHere || leaving}>
            {leaving ? <><Spinner /> {t('Signing in…')}</> : t('Continue to sign in')}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
