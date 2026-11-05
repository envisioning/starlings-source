import { useState } from 'react';
import { AppShell } from './SiteChrome';
import { GuestCard, GuestLede } from './GuestCard';
import { ErrorNotice } from './ErrorNotice';
import { SignedOutDoor } from './SignedOutDoor';
import { t } from './i18n';

/**
 * A member page's sign-in gate: the page's name, where
 * sign-in leads, then the same door as the visitor root (`SignedOutDoor`): a
 * large Sign in, the workspaces this browser knows, and Starlings under it.
 * Sign-in returns to the address the person opened, query included, so a link
 * such as Admin's `?code=` survives it.
 */
export function SignInGate({ title, onSignedIn, returnTo }: {
  title: string;
  /** After sign-in in this tab. Defaults to reloading the page. */
  onSignedIn?: () => void | Promise<void>;
  /** Defaults to the current path and query. */
  returnTo?: string;
}) {
  const [error, setError] = useState('');
  return (
    <AppShell variant="centered">
      {/* The visitor root's 560px column, not the window (MZ, 2026-10-20). */}
      <div className="grid w-[min(100%,560px)] gap-3">
        <GuestCard className="w-full">
          <h1 className="mt-0">{title}</h1>
          <GuestLede>{t('Sign in to open {page}.', { page: title })}</GuestLede>
          {error && <ErrorNotice message={error} />}
        </GuestCard>
        <SignedOutDoor
          returnTo={returnTo ?? `${window.location.pathname}${window.location.search}`}
          onSignedIn={onSignedIn}
          onError={(cause) => setError(cause instanceof Error ? cause.message : t('Couldn’t sign in.'))}
        />
      </div>
    </AppShell>
  );
}
