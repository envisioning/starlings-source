import { useEffect } from 'react';
import { AppShell } from './SiteChrome';
import { useDocumentTitle } from './document-title';
import { HERO, PAGE } from './bento';
import { LinkPill, LinkTile } from './feature-tiles';
import { ProductOverview, PRODUCT_MESSAGE } from './features';
import { EarlyAccess } from './EarlyAccess';
import { t } from '@shared/i18n';
import { TentpoleShowcase } from './TentpoleShowcase';

/** The capability library moved to its own page; a link to a feature on this page still lands on it. */
const CAPABILITIES = '/workspace/capabilities';

/** Signature chapters first. The complete library is one page on, at /workspace/capabilities. */
export function FeaturesPage() {
  useDocumentTitle('Features');
  useEffect(() => {
    const { hash } = window.location;
    if (hash && !document.getElementById(hash.slice(1))) window.location.replace(`${CAPABILITIES}${hash}`);
  }, []);

  return <AppShell variant="wide" product="features">
    <div className={PAGE}>
      <header className={HERO}>
        <h1>{t('Shared context. Clear attention. Work that moves forward.')}</h1>
        <p className="lede">{PRODUCT_MESSAGE}</p>
      </header>
      <TentpoleShowcase />
      <ProductOverview compact />
      <div className="my-8"><LinkPill href={CAPABILITIES}>{t('Explore all capabilities')}</LinkPill></div>

      <section className="my-12" aria-label={t('Explore further')}>
        <div className="grid grid-cols-3 gap-3 max-[800px]:grid-cols-1">
          <LinkTile href="/use-cases" title={t('See it in practice')} text={t('Explore scripted projects, from sources to human review.')} />
          <LinkTile href="/security" title={t('Security and data')} text={t('Where your data lives, who can see it, and what Starlings never keeps.')} />
          <LinkTile href="/integrations" title={t('Integrations and agents')} text={t('Explore agent connections, providers and setup.')} />
        </div>
      </section>
      <EarlyAccess />
    </div>
  </AppShell>;
}
