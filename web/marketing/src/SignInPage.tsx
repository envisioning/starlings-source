import { useEffect, useId, useState, type FormEvent } from 'react';
import { parseWorkspaceAddress, workspaceSignInURL, WORKSPACE_HOST_SUFFIX } from '@starlings/contracts/workspace-slug';
import { Button } from '@/ui/button';
import { ErrorNotice } from '@shared/ErrorNotice';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { AppShell } from './SiteChrome';
import { HERO, PAGE } from './bento';
import { useDocumentTitle } from './document-title';
import { t } from '@shared/i18n';

/**
 * /sign-in: go to your workspace by its address ( slice 1). The page
 * lists nothing and asks no server: ADR 0004 decision 2 keeps every
 * customer's workspace off the product site. Finding your workspaces by
 * email is slice 2, on the auth host. A gate is the field and the button,
 * with no sentence (docs/DESIGN.md §Copy law).
 */
export function SignInPage() {
  useDocumentTitle('Sign in');
  const fieldId = useId();
  const errorId = useId();
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Back from the workspace restores this page from the cache, still busy.
  useEffect(() => {
    const reset = () => setBusy(false);
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const result = parseWorkspaceAddress(address);
    if (result.ok) {
      setBusy(true);
      window.location.assign(workspaceSignInURL(result.slug));
      return;
    }
    setError(result.reason === 'empty'
      ? 'Type your workspace name.'
      : result.reason === 'reserved'
        ? 'That name is reserved.'
        : 'Use letters, numbers and hyphens.');
  }

  return (
    <AppShell variant="document">
      <div className={PAGE}>
        <header className={HERO}>
          <h1>Sign in</h1>
        </header>
        <form className="grid max-w-[34rem] gap-3" onSubmit={submit} noValidate>
          <Label htmlFor={fieldId}>Workspace</Label>
          <div className="flex items-center gap-2 max-[520px]:flex-wrap">
            <Input
              id={fieldId}
              name="workspace"
              // The field is the page's only task.
              autoFocus
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="Workspace name"
              value={address}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              onChange={(event) => { setAddress(event.target.value); setError(null); }}
              className="h-12 max-w-[18rem] bg-[var(--surface-raised)] text-base"
            />
            <span className="text-muted-foreground">.{WORKSPACE_HOST_SUFFIX}</span>
          </div>
          {error && <ErrorNotice id={errorId} message={error} inline className="text-sm" />}
          <div className="mt-3"><Button type="submit" size="lg" disabled={busy}>{busy ? t('Signing in…') : t('Continue')}</Button></div>
        </form>
      </div>
    </AppShell>
  );
}
