import { useEffect, useMemo, useState } from 'react';
import { meetChangelog } from 'virtual:meet-changelog';
import {
  CHANGELOG_AREAS,
  CHANGELOG_KINDS,
  changelogAreaRoot,
  changelogHeadline,
  changelogReleaseOrder,
  type ChangelogArea,
  type ChangelogKind,
} from '@starlings/contracts/changelog-values';
import type { ChangelogUpdate } from '@starlings/contracts/changelog';
import { ChangelogActivity } from '@shared/ChangelogActivity';
import { DocumentMarkdown } from '@shared/document-markdown';
import { Runs, parseSpans } from '@shared/markdown';
import { plural, t } from '@shared/i18n';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';
import { AppShell } from './SiteChrome';
import { DocArticle } from '@shared/DocArticle';
import { useDocumentTitle } from './document-title';

/** The area words, as t() literals so the catalog sees them. Typed, so a new area cannot miss one. */
const AREA_LABELS: Record<ChangelogArea, string> = {
  work: t('Work'),
  'work/events': t('Events'),
  messages: t('Messages'),
  calls: t('Calls'),
  docs: t('Docs'),
  calendar: t('Calendar'),
  keep: t('Secrets'),
  agents: t('Agents'),
  foundation: t('Foundation'),
  site: t('Site'),
  ops: t('Ops'),
};

const KIND_LABELS: Record<ChangelogKind, string> = {
  new: t('New'),
  improved: t('Improved'),
  fixed: t('Fixed'),
  removed: t('Removed'),
};

const ROOTS = CHANGELOG_AREAS.filter((entry) => !entry.id.includes('/')).map((entry) => entry.id);
/** The pill look of the early-access form's choices (InterestPage). */
const CHIP = 'h-8 rounded-full px-3 font-normal data-[state=on]:border-foreground data-[state=on]:bg-foreground data-[state=on]:text-background';

interface Section {
  key: string;
  title: string;
  date: string;
  summary?: string;
  updates: ChangelogUpdate[];
}

/** `?area=work/events&kind=fixed`: a filtered view is a link. */
function filtersFromLocation(): { area: ChangelogArea | null; kind: ChangelogKind | null } {
  const params = new URLSearchParams(window.location.search);
  const area = CHANGELOG_AREAS.find((entry) => entry.id === params.get('area'))?.id ?? null;
  const kind = CHANGELOG_KINDS.find((entry) => entry === params.get('kind')) ?? null;
  return { area, kind };
}

function matches(update: ChangelogUpdate, area: ChangelogArea | null, kind: ChangelogKind | null): boolean {
  if (kind && update.kind !== kind) return false;
  if (!area) return true;
  return area.includes('/') ? update.area === area : changelogAreaRoot(update.area) === area;
}

/**
 * The changelog (changelog/README.md), filterable. An area narrows to its
 * child areas; a kind narrows further. Each update is its headline over its
 * detail. The page prerenders unfiltered; a filter in the address
 * applies after load.
 */
export function ChangelogPage() {
  useDocumentTitle('Changelog');
  const [area, setArea] = useState<ChangelogArea | null>(null);
  const [kind, setKind] = useState<ChangelogKind | null>(null);

  useEffect(() => {
    const initial = filtersFromLocation();
    setArea(initial.area);
    setKind(initial.kind);
  }, []);

  const choose = (nextArea: ChangelogArea | null, nextKind: ChangelogKind | null) => {
    setArea(nextArea);
    setKind(nextKind);
    const params = new URLSearchParams(window.location.search);
    if (nextArea) params.set('area', nextArea); else params.delete('area');
    if (nextKind) params.set('kind', nextKind); else params.delete('kind');
    const query = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  };

  const { releases, updates } = meetChangelog;
  const root = area ? changelogAreaRoot(area) : null;
  const children = root ? CHANGELOG_AREAS.filter((entry) => entry.id.startsWith(`${root}/`)).map((entry) => entry.id) : [];

  const countByRoot = useMemo(() => {
    const counts = new Map<ChangelogArea, number>();
    for (const update of updates) {
      if (kind && update.kind !== kind) continue;
      const key = changelogAreaRoot(update.area);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [updates, kind]);

  const sections = useMemo(() => {
    const filtered = area !== null || kind !== null;
    const byVersion = new Map<string, ChangelogUpdate[]>();
    const waiting: ChangelogUpdate[] = [];
    for (const update of updates) {
      if (!matches(update, area, kind)) continue;
      if (!update.version) waiting.push(update);
      else byVersion.set(update.version, [...(byVersion.get(update.version) ?? []), update]);
    }
    const list: Section[] = releases
      .filter((release) => byVersion.has(release.version) || (!filtered && release.summary))
      .map((release) => ({
        key: `v${release.version}`,
        title: release.version,
        date: release.date,
        summary: filtered ? undefined : release.summary,
        updates: (byVersion.get(release.version) ?? []).sort(changelogReleaseOrder),
      }));
    if (waiting.length > 0) {
      list.unshift({
        key: 'next',
        title: t('Next release'),
        date: '',
        summary: t('On the web now. In the Mac and iPhone apps with the next release.'),
        updates: waiting.sort(changelogReleaseOrder),
      });
    }
    return list;
  }, [releases, updates, area, kind]);

  const shown = sections.reduce((sum, section) => sum + section.updates.length, 0);

  return (
    <AppShell variant="document" product="changelog">
      <DocArticle>
        <h1>What changed in Starlings</h1>
        <ChangelogActivity />

        <div className="my-6 grid gap-2.5">
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={2}
            className="flex-wrap"
            aria-label={t('Area')}
            value={root ?? 'all'}
            onValueChange={(next) => { if (next) choose(next === 'all' ? null : next as ChangelogArea, kind); }}
          >
            <ToggleGroupItem value="all" className={CHIP}>{t('All')}</ToggleGroupItem>
            {ROOTS.map((id) => (
              <ToggleGroupItem key={id} value={id} className={CHIP} disabled={!countByRoot.get(id)}>
                {AREA_LABELS[id]} <span className="tabular-nums opacity-60">{countByRoot.get(id) ?? 0}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {root && children.length > 0 && (
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={2}
              className="flex-wrap"
              aria-label={AREA_LABELS[root]}
              value={area ?? root}
              onValueChange={(next) => { if (next) choose(next as ChangelogArea, kind); }}
            >
              <ToggleGroupItem value={root} className={CHIP}>{t('All of {area}', { area: AREA_LABELS[root] })}</ToggleGroupItem>
              {children.map((id) => <ToggleGroupItem key={id} value={id} className={CHIP}>{AREA_LABELS[id]}</ToggleGroupItem>)}
            </ToggleGroup>
          )}
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={2}
            className="flex-wrap"
            aria-label={t('Kind')}
            value={kind ?? 'all'}
            onValueChange={(next) => { if (next) choose(area, next === 'all' ? null : next as ChangelogKind); }}
          >
            <ToggleGroupItem value="all" className={CHIP}>{t('Every kind')}</ToggleGroupItem>
            {CHANGELOG_KINDS.map((id) => <ToggleGroupItem key={id} value={id} className={CHIP}>{KIND_LABELS[id]}</ToggleGroupItem>)}
          </ToggleGroup>
          <p className="m-0 text-[13px] text-muted-foreground" aria-live="polite">{plural(shown, { one: '{count} update', other: '{count} updates' })}</p>
        </div>

        {shown === 0 && <p>{t('No update matches these filters.')}</p>}
        {sections.map((section) => (
          <section key={section.key} id={section.key}>
            <h2>
              {section.title}
              {section.date && <span className="ml-2 text-[0.7em] font-normal text-muted-foreground">{section.date}</span>}
            </h2>
            {section.summary && <p>{section.summary}</p>}
            {section.updates.length > 0 && (
              <ul className="list-none pl-0">
                {section.updates.map((update) => <UpdateRow key={update.id} update={update} showArea={!area?.includes('/')} />)}
              </ul>
            )}
          </section>
        ))}
      </DocArticle>
    </AppShell>
  );
}

/** One update: its headline over its detail and refs. */
function UpdateRow({ update, showArea }: { update: ChangelogUpdate; showArea: boolean }) {
  const { headline, detail } = changelogHeadline(update.body);
  const title = (
    <>
      <Runs spans={parseSpans(headline)} />
      <span className="ml-2 text-[12px] text-muted-foreground">
        {showArea ? `${AREA_LABELS[update.area]} · ${KIND_LABELS[update.kind]}` : KIND_LABELS[update.kind]}
      </span>
    </>
  );
  return (
    <li id={update.id} className="my-3">
      <div>{title}</div>
      {(detail || update.refs.length > 0) && (
        <div className="mt-1 text-[15px] text-muted-foreground">
          {detail && <DocumentMarkdown text={detail} />}
          {update.refs.length > 0 && <p className="text-[13px]">{update.refs.join(', ')}</p>}
        </div>
      )}
    </li>
  );
}
