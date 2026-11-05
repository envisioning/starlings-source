import { lazy, Suspense } from 'react';
import { PRODUCT_SITE_ORIGIN } from '@starlings/contracts/deployment';
import { EnvisioningSignInButton } from './EnvisioningSignInButton';
import { GatheringDots } from './GatheringDots';
import { HomeTile } from './HomeTile';
import { t } from './i18n';

// The door's other workspaces and Enter an address: its own
// chunk, because the workspace directory reads zod-carrying contract code.
const WorkspaceDoor = lazy(async () => ({
  default: (await import('./WorkspaceDoor')).WorkspaceDoor,
}));

/**
 * The signed-out door's tiles, one composition for the visitor root and every
 * member page's sign-in gate: a large Sign in, the workspaces this
 * browser knows, and the product under its own flock. The page makes no
 * product claims of its own.
 */
export function SignedOutDoor({ returnTo, onSignedIn, onError }: {
  returnTo: string;
  onSignedIn?: () => void | Promise<void>;
  onError?: (cause: unknown) => void;
}) {
  return (
    <>
      <EnvisioningSignInButton
        variant="tile"
        returnTo={returnTo}
        onSignedIn={onSignedIn ?? (() => window.location.reload())}
        onError={onError}
      />
      <Suspense fallback={null}><WorkspaceDoor variant="tile" /></Suspense>
      {/* The flock is the size of the workspace's mark in the sign-in tile
          above (MZ, 2026-10-06). */}
      <HomeTile
        className="mt-7"
        href={`${PRODUCT_SITE_ORIGIN}/why`}
        icon={<GatheringDots motion="drift" />}
        iconClassName="[&>svg]:!size-[22px]"
        title={t('Runs on Starlings')}
        detail={t('Where your team and your AI agents work together.')}
      />
    </>
  );
}
