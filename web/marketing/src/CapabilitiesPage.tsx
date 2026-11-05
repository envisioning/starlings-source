import { AppShell } from './SiteChrome';
import { useDocumentTitle } from './document-title';
import { HERO, PAGE } from './bento';
import { FeatureBento, ThemeHead, THEMES } from './features';
import { EarlyAccess } from './EarlyAccess';
import { PageCrumb } from './PageCrumb';
import { t } from '@shared/i18n';

/** The full feature library, grouped by topic. /workspace links here; its old `#feature-…` permalinks land here too. */
export function CapabilitiesPage() {
  useDocumentTitle(t('All capabilities'));
  return <AppShell variant="wide" product="features">
    <div className={PAGE}>
      <PageCrumb href="/workspace" parent={t('Workspace')} page={t('All capabilities')} />
      <header className={HERO}>
        <h1>{t('All capabilities')}</h1>
        <p className="lede">{t('The full feature library, grouped by topic.')}</p>
      </header>
      {THEMES.filter((entry) => entry.page === '/workspace/capabilities').map((entry) => <section key={entry.id}><ThemeHead id={entry.id} /><FeatureBento theme={entry.id} depth="detail" /></section>)}
      <EarlyAccess />
    </div>
  </AppShell>;
}
