import { useEffect, useState, type ReactNode } from 'react';
import { HistoryIcon, LockIcon, LockOpenIcon, PanelLeftIcon, SettingsIcon, VaultIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/ui/sheet';
import { api, type Me } from './api';
import { useDeployment } from './deployment';
import { EnvisioningMark } from './EnvisioningMark';
import { Link, errorMessage } from './parts';
import * as session from './session';
import { Tip } from './Tip';
import { useMediaQuery } from './use-media-query';

/** At and under this width the rail is a sheet over the page, as Meet's phone layout. */
const PHONE = '(max-width: 760px)';

const NAV = [
  { to: '/', label: 'Vaults', icon: VaultIcon },
  { to: '/audit', label: 'Activity', icon: HistoryIcon },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
] as const;

/**
 * The window, after Meet's SurfaceShell: a header, a rail on the left and
 * the page beside it. The rail hides and shows from the header. Above the
 * phone it is a column; on the phone it is a sheet that closes when a page
 * opens. The choice lasts while the tab is open: Keep writes nothing to
 * browser storage.
 */
export function Shell({ me, unlocked, route, children }: { me: Me; unlocked: boolean; route: string; children: ReactNode }) {
  const phone = useMediaQuery(PHONE);
  const [railOpen, setRailOpen] = useState(() => !window.matchMedia(PHONE).matches);

  // On the phone a page that opens puts the rail away.
  useEffect(() => {
    if (phone) setRailOpen(false);
  }, [route, phone]);

  const label = railOpen ? 'Hide sidebar' : 'Show sidebar';
  const rail = <Rail me={me} route={route} />;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b bg-[color-mix(in_srgb,var(--surface-bg)_92%,transparent)] backdrop-blur-[10px]">
        <div className="flex min-h-14 items-center gap-3 px-4">
          <Tip label={label}>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="rounded-full text-muted-foreground aria-pressed:bg-popover aria-pressed:text-foreground"
              aria-label={label}
              aria-pressed={railOpen}
              onClick={() => setRailOpen((open) => !open)}
            >
              <PanelLeftIcon />
            </Button>
          </Tip>
          <Brand />
          <LockState unlocked={unlocked} />
        </div>
      </header>
      <div className="flex min-h-0 flex-1 gap-6 p-4 min-[761px]:p-6">
        {railOpen && !phone && (
          <aside
            aria-label="Keep sidebar"
            className="sticky top-[80px] flex h-[calc(100vh-104px)] w-[240px] flex-none flex-col self-start rounded-xl border bg-card p-3"
          >
            {rail}
          </aside>
        )}
        <main className="min-w-0 flex-1 min-[761px]:px-2">{children}</main>
      </div>
      {phone && (
        <Sheet open={railOpen} onOpenChange={setRailOpen}>
          <SheetContent side="left" className="w-[280px] gap-0 p-3 pt-12">
            <SheetTitle className="sr-only">Keep sidebar</SheetTitle>
            <SheetDescription className="sr-only">Vaults, activity and settings</SheetDescription>
            {rail}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

function Brand() {
  const deployment = useDeployment();
  return (
    <Link to="/" className="flex min-w-0 items-center gap-2 text-[15px] tracking-[-0.01em] text-foreground no-underline">
      {deployment?.envisioning ? <EnvisioningMark size={16} /> : null}
      <span className="truncate">
        {deployment ? <strong className="font-[620]">{deployment.name}</strong> : null} Keep
      </span>
    </Link>
  );
}

/** The lock state is the one thing worth a glyph in the header. */
function LockState({ unlocked }: { unlocked: boolean }) {
  return (
    <div className="ml-auto flex items-center gap-2 text-[13px] text-muted-foreground">
      {unlocked ? <LockOpenIcon className="size-4" aria-hidden="true" /> : <LockIcon className="size-4" aria-hidden="true" />}
      <strong className="font-semibold text-foreground">{unlocked ? 'Unlocked' : 'Locked'}</strong>
      {unlocked && (
        <Button type="button" variant="outline" size="sm" onClick={() => session.lock()}>
          Lock
        </Button>
      )}
    </div>
  );
}

function Rail({ me, route }: { me: Me; route: string }) {
  const [signingOut, setSigningOut] = useState(false);
  return (
    <>
      <nav aria-label="Keep">
        <ul className="m-0 grid list-none gap-0.5 p-0">
          {NAV.map(({ to, label, icon: Icon }) => {
            const current = route === to;
            return (
              <li key={to}>
                <Link
                  to={to}
                  current={current}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted-foreground no-underline hover-lift hover:text-foreground',
                    current && 'bg-(--selected) text-foreground',
                  )}
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="mt-auto flex items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
        <span className="truncate" title={me.email}>{me.name}</span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="text-muted-foreground"
          disabled={signingOut}
          onClick={async () => {
            setSigningOut(true);
            session.lock();
            try {
              await api.logout();
            } catch (error) {
              console.warn(errorMessage(error));
            }
            // Through the central sign-out: on a deployment that signs in at
            // the auth host it ends that session too; otherwise it goes to /.
            window.location.href = '/api/auth/central/sign-out';
          }}
        >
          Sign out
        </Button>
      </div>
    </>
  );
}
