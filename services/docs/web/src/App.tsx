import { useEffect, useState } from 'react';
import { api, guestToken, setGuestToken, signInURL, type Me } from './api';
import { StaffApp } from './StaffApp';
import { GuestApp } from './GuestApp';
import { CertificateView } from './CertificateView';
import { EnvisioningMark } from './EnvisioningMark';
import { useDeployment } from './deployment';

/**
 * Three surfaces, chosen by URL first and identity second:
 *
 *   /d/<token>        a share link — always the guest flow, even for staff,
 *                     because that is what the sender asked them to see
 *   /certificate/<id> a signature audit certificate
 *   everything else   the staff app, behind Google sign-in
 */
export function App() {
  const [me, setMe] = useState<Me | null | 'loading'>('loading');
  const [route, setRoute] = useState(window.location.pathname);

  useEffect(() => {
    const onNavigate = () => setRoute(window.location.pathname);
    window.addEventListener('popstate', onNavigate);
    window.addEventListener('docs:navigate', onNavigate);
    return () => {
      window.removeEventListener('popstate', onNavigate);
      window.removeEventListener('docs:navigate', onNavigate);
    };
  }, []);

  const shareToken = /^\/d\/([A-Za-z0-9_-]+)$/u.exec(route)?.[1];
  const certificateId = /^\/certificate\/([0-9a-f-]{36})$/u.exec(route)?.[1];
  // A share link belongs to someone with no session; probing /api/me there
  // only produces a guaranteed 401 in their console.
  const needsIdentity = !shareToken && !certificateId;

  useEffect(() => {
    if (!needsIdentity) return;
    let cancelled = false;
    api
      .me()
      .then((value) => !cancelled && setMe(value))
      .catch(() => {
        if (cancelled) return;
        // A stale guest token is worse than none: it makes every call 401.
        if (guestToken()) setGuestToken(null);
        setMe(null);
      });
    return () => {
      cancelled = true;
    };
  }, [route, needsIdentity]);

  if (shareToken) return <GuestApp token={shareToken} />;
  if (certificateId) return <CertificateView requestId={certificateId} />;

  if (me === 'loading') return <Splash>Loading…</Splash>;
  if (!me || me.kind !== 'staff') return <SignIn />;

  return <StaffApp me={me} route={route} />;
}

export function navigate(path: string): void {
  window.history.pushState({}, '', path);
  window.dispatchEvent(new Event('docs:navigate'));
}

function SignIn() {
  // The name and domains are this deployment's, not Envisioning's: a
  // workspace deployment (env.hq) is someone else's Docs.
  const deployment = useDeployment();
  const domains = deployment?.identity_domains ?? [];
  return (
    <Splash>
      <h1>{deployment ? `${deployment.name} Docs` : 'Docs'}</h1>
      <a className="button ghost button--with-icon" href={signInURL(window.location.pathname)}>
        {deployment?.envisioning ? <EnvisioningMark size={16} /> : null}
        {deployment?.envisioning ? 'Sign in with Envisioning' : 'Sign in'}
      </a>
      {domains.length > 0 ? (
        <p className="fine">
          Verified {domains.map((domain, index) => (
            <span key={domain}>{index > 0 ? ' or ' : ''}<code>@{domain}</code></span>
          ))} accounts only. If someone shared a document with you, use the link they sent — it does not
          need an account.
        </p>
      ) : null}
    </Splash>
  );
}

function Splash({ children }: { children: React.ReactNode }) {
  return (
    <div className="splash">
      <div className="splash-card">{children}</div>
    </div>
  );
}
