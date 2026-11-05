import type { ReactNode } from 'react';
import { t } from '@shared/i18n';
import { DoorGlyph, LinkTile } from './feature-tiles';

/**
 * The one way a page closes: its crosslinks, then the early-access ask. Both
 * are link tiles (LinkTile), so a visitor reads every one as a way to
 * another page. The ask is the large tile, two columns wide. This block owns
 * the margins above and below, so every page closes with the same rhythm.
 * `text` says why, for that page. `links` are the page's own LinkTiles, two to
 * a row; an odd last one takes the whole row, so no row ends short.
 */
export function EarlyAccess({ text, links }: { text?: string; links?: ReactNode }) {
  return (
    <nav id="early-access" aria-label={t('Next')} className="mt-14 mb-24 grid gap-3 max-[800px]:mt-10 max-[800px]:mb-14">
      {links && <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1 [&>:last-child:nth-child(odd)]:col-span-full">{links}</div>}
      <LinkTile
        large
        icon={<DoorGlyph />}
        href="/interest"
        title={t('Request early access')}
        text={text ?? t('We’re opening Starlings to a few teams beyond Envisioning. Tell us how your people and agents work today, and we’ll set up a workspace for your team.')}
      />
    </nav>
  );
}
