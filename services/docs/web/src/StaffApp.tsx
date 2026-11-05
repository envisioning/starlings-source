import type { Me } from './api';
import { navigate } from './App';
import { useDeployment } from './deployment';
import { TokensPage } from './TokensPage';

/**
 * What a signed-in staff member still does here: tokens. Documents, folders,
 * sharing and signature requests live in the workspace's Meet /docs
 *; the Worker redirects every staff page there, so a
 * person only lands on this screen at `/tokens`, or anywhere in local dev,
 * where no Meet origin is configured.
 */
export function StaffApp({ me, route }: { me: Extract<Me, { kind: 'staff' }>; route: string }) {
  const deployment = useDeployment();

  return (
    <div className="staff">
      <header className="staff-bar">
        <span className="brand">
          {deployment ? `${deployment.name} ` : ''}
          <strong>Docs</strong>
        </span>
        <span className="muted">{me.email}</span>
        <form method="post" action="/api/auth/logout">
          <button className="link" type="submit">
            Sign out
          </button>
        </form>
      </header>
      <main className="main">
        {route === '/tokens' ? (
          <TokensPage />
        ) : (
          <section className="settings">
            <p className="muted">
              Documents are in your workspace&apos;s Docs.{' '}
              <a
                href="/tokens"
                onClick={(event) => {
                  event.preventDefault();
                  navigate('/tokens');
                }}
              >
                Tokens
              </a>{' '}
              are here.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}

