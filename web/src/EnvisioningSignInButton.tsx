import { useState } from 'react';
import { mintLocalOwnerSession } from './api';
import { Button } from '@/ui/button';
import { envisioningSignInHref } from './config';
import { WorkspaceMark } from './action-icons';
import { t } from './i18n';
import { HomeTile } from './HomeTile';
import { workspaceBrand } from './workspace-brand';

/**
 * The owner sign-in action is a button on every web surface, in every build.
 * `variant="tile"` draws it as one of the door's tiles. Its line names the
 * workspace: you sign in to the workspace, Google is only how.
 */
export function EnvisioningSignInButton({
  returnTo,
  onSignedIn,
  onError,
  className,
  variant = 'button',
}: {
  returnTo: string;
  onSignedIn?: () => void | Promise<void>;
  onError?: (cause: unknown) => void;
  className?: string;
  variant?: 'button' | 'tile';
}) {
  // The page leaves for Google while this is true; the label says so, as
  // "Signing in…" does on Mac and iPhone.
  const [signingIn, setSigningIn] = useState(false);
  const label = signingIn ? t('Signing in…') : t('Sign in');

  function signIn() {
    if (signingIn) return;
    setSigningIn(true);
    if (import.meta.env.DEV) {
      void mintLocalOwnerSession()
        .then(() => onSignedIn?.())
        .catch((cause) => onError?.(cause))
        .finally(() => setSigningIn(false));
      return;
    }
    window.location.assign(envisioningSignInHref(returnTo));
  }

  if (variant === 'tile') {
    return (
      <HomeTile
        className={className}
        onClick={signIn}
        icon={<WorkspaceMark size={22} signedOut />}
        iconClassName="[&>svg]:!size-[22px]"
        title={label}
        detail={workspaceBrand().name}
      />
    );
  }

  return (
    <Button type="button" variant="secondary" className={className} onClick={signIn} aria-busy={signingIn}>
      <WorkspaceMark size={16} signedOut />
      <span>{label}</span>
    </Button>
  );
}
