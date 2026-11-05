import { SystemDiagram } from '@shared/SystemDiagram';
import { AppShell } from './SiteChrome';
import { useDocumentTitle } from './document-title';
import { HERO, PAGE, SECTION_HERO } from './bento';
import { EyeOffGlyph, LinkTile } from './feature-tiles';
import { FeatureBento, theme } from './features';
import { EarlyAccess } from './EarlyAccess';
import { t } from '@shared/i18n';

/**
 * /security — where a workspace's data lives, who can see it, and what
 * Starlings never keeps. The reader is whoever signs off on a new tool: the
 * IT or security lead on the interest form. Every claim is shipped behaviour.
 * The tiles are the feature library's theme `data` (`features.tsx`), and the
 * hero is that theme's head: the grid has no section head of its own. The
 * architecture diagram and the closing links are the page's own.
 */
export function SecurityPage() {
  useDocumentTitle('Security and data');
  const data = theme('data');

  return (
    <AppShell variant="wide" product="security">
      <div className={PAGE}>
        <header className={HERO} id={data.anchor}>
          <h1>{data.title}</h1>
          <p className="lede">{data.lede}</p>
        </header>

        <FeatureBento theme="data" depth="detail" />

        <header className={SECTION_HERO} id="architecture">
          <h2>How Starlings is built.</h2>
          <p className="lede">
            Every service Starlings runs on, and what data moves between them.
            Video goes directly between participants. The transcript goes to a
            Worker that never sees video. The full diagram, down to the bucket
            and the queue, is on <a href="/workspace/status">feature status</a>.
          </p>
        </header>

        <SystemDiagram className="mb-9" />

        <EarlyAccess
          text={t('Tell us how your team works today, and what your security review needs.')}
          links={<LinkTile href="/privacy" icon={<EyeOffGlyph />} title={t('Privacy policy')} text={t('The full privacy and security contract.')} />}
        />
      </div>
    </AppShell>
  );
}
