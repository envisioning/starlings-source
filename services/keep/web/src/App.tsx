import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { api, signInURL, type Me } from './api';
import { Enrol } from './Enrol';
import { EnvisioningMark } from './EnvisioningMark';
import { useDeployment } from './deployment';
import { Home } from './Home';
import { AuditPage } from './Audit';
import { Settings } from './Settings';
import { Shell } from './Shell';
import { Unlock } from './Unlock';
import { Vault } from './Vault';
import { MachineVault } from './MachineVault';
import * as session from './session';
import { Gate, Toaster } from './parts';

/**
 * One surface, three gates in order: signed in, enrolled, unlocked. The
 * first two are the server's; the last is this tab's memory.
 */
export function App() {
  const [me, setMe] = useState<Me | null | 'loading'>('loading');
  const [route, setRoute] = useState(window.location.pathname);
  const [unlocked, setUnlocked] = useState(session.isUnlocked());

  useEffect(() => {
    const onNavigate = () => setRoute(window.location.pathname);
    window.addEventListener('popstate', onNavigate);
    window.addEventListener('keep:navigate', onNavigate);
    return () => {
      window.removeEventListener('popstate', onNavigate);
      window.removeEventListener('keep:navigate', onNavigate);
    };
  }, []);

  useEffect(() => session.subscribe(() => setUnlocked(session.isUnlocked())), []);

  const reloadMe = useCallback(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe(null));
  }, []);

  useEffect(reloadMe, [reloadMe]);

  if (me === 'loading') return <p className="grid min-h-screen place-items-center text-muted-foreground">Loading…</p>;
  if (!me) return <SignIn />;
  if (!me.enrolled || !me.key) return <Enrol me={me} onEnrolled={reloadMe} />;

  return (
    <>
      <Shell me={me} unlocked={unlocked} route={route}>
        {!unlocked ? (
          <Unlock staffKey={me.key} />
        ) : (
          <Routed route={route} me={me} onReloadMe={reloadMe} />
        )}
      </Shell>
      <Toaster />
    </>
  );
}

function Routed({ route, me, onReloadMe }: { route: string; me: Me; onReloadMe: () => void }) {
  const vaultId = /^\/vaults\/([0-9a-f-]{36})$/u.exec(route)?.[1];
  if (vaultId) return <Vault key={vaultId} id={vaultId} me={me} />;
  const machineId = /^\/machine-vaults\/([0-9a-f-]{36})$/u.exec(route)?.[1];
  if (machineId) return <MachineVault key={machineId} id={machineId} />;
  if (route === '/settings') return <Settings me={me} onReloadMe={onReloadMe} />;
  if (route === '/audit') return <AuditPage />;
  return <Home me={me} />;
}

function SignIn() {
  // A gate is the mark, the name and the button alone (Meet's copy law). The
  // name is this deployment's, not Envisioning's: a workspace deployment
  // (env.hq) is someone else's Keep.
  const deployment = useDeployment();
  return (
    <Gate
      title={
        <span className="flex items-center gap-2.5">
          {deployment?.envisioning ? <EnvisioningMark size={22} /> : null}
          {deployment ? `${deployment.name} Keep` : 'Keep'}
        </span>
      }
    >
      <Button asChild className="w-fit">
        <a href={signInURL(window.location.pathname)}>Sign in</a>
      </Button>
    </Gate>
  );
}
