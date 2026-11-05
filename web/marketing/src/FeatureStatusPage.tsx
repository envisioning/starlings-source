import { useId, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { AppShell } from './SiteChrome';
import { DocToc } from '@shared/DocToc';
import { DocArticle, DocNote } from '@shared/DocArticle';
import { SegmentedFilter } from '@shared/SegmentedFilter';
import { SurfaceStatusMark, SurfaceTable } from '@shared/SurfaceTable';
import {
  CAPABILITIES_REVIEWED_AT,
  CAPABILITY_INTENT_LABEL,
  CAPABILITY_INTENTS,
  CAPABILITY_SECTIONS,
  CAPABILITY_SURFACES,
  SURFACE_LABEL,
  SURFACE_STATUSES,
  SURFACE_SUMMARY,
  capabilitySections,
  surfaceSections,
  type Capability,
  type CapabilityIntent,
  type CapabilitySection,
  type CapabilitySectionId,
} from '@starlings/contracts/capabilities';
import { SystemDiagram } from '@shared/SystemDiagram';
import { AgentAccess } from './AgentAccess';
import { useDocumentTitle } from './document-title';
import { t } from '@shared/i18n';

const ALL_TYPES = 'all';
const ALL_STATUSES = 'all';
type FeatureType = typeof ALL_TYPES | CapabilitySectionId;
type StatusFilter = typeof ALL_STATUSES | CapabilityIntent;

export function FeatureStatusPage() {
  useDocumentTitle(t('Feature status'));
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [activeStatus, setActiveStatus] = useState<StatusFilter>(ALL_STATUSES);
  const [activeType, setActiveType] = useState<FeatureType>(ALL_TYPES);

  const sections = capabilitySections();
  const filtered = filterSections(sections, activeStatus, query, activeType);
  const visibleCount = filtered.reduce((n, section) => n + section.rows.length, 0);
  const totalCount = sections.reduce((n, section) => n + section.rows.length, 0);
  const filtersOn = query.trim() !== '' || activeStatus !== ALL_STATUSES || activeType !== ALL_TYPES;

  return (
    <AppShell variant="document" product="features">
      <DocArticle wide>
        <h1>{t('Feature status')}</h1>
        <p className="lede">
          The state of each feature on every platform. We update it as the app
          changes.
        </p>
        <p className="-mt-4 mb-6 text-[13px] text-muted-foreground">
          Last updated <time dateTime={CAPABILITIES_REVIEWED_AT}>{CAPABILITIES_REVIEWED_AT}</time>.
          What changed, release by release, is in the <a href="/changelog">changelog</a>.
        </p>

        <DocToc
          label={t('On this page')}
          links={[
            ...filtered.map((section) => ({ href: `#${section.id}`, label: section.title })),
            { href: '#surface-completeness', label: t('By surface') },
            { href: '#topology', label: t('How it fits together') },
            { href: '/changelog', label: t('Changelog') },
            { href: '/workspace', label: t('Features') },
          ]}
        />

        <div className="mb-7 flex flex-wrap items-center gap-x-4 gap-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="features-type" className={FILTER_LABEL}>{t('Type')}</Label>
            <NativeSelect
              id="features-type"
              value={activeType}
              onChange={(event) => setActiveType(event.target.value as FeatureType)}
            >
              <NativeSelectOption value={ALL_TYPES}>{t('All')}</NativeSelectOption>
              {CAPABILITY_SECTIONS.map((section) => (
                <NativeSelectOption key={section.id} value={section.id}>
                  {section.title}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={FILTER_LABEL} aria-hidden="true">{t('Status')}</span>
            <SegmentedFilter<StatusFilter>
              label={t('Status')}
              // On a phone the segments wrap; each becomes its own pill so a wrapped row keeps its edges.
              className="max-w-full flex-wrap max-sm:gap-1 max-sm:[&>*]:rounded-md! max-sm:[&>*]:border-l!"
              value={activeStatus}
              onChange={setActiveStatus}
              options={[
                { value: ALL_STATUSES, label: t('All') },
                ...CAPABILITY_INTENTS.map((status) => ({ value: status, label: CAPABILITY_INTENT_LABEL[status] })),
              ]}
            />
          </div>
          <div className="max-w-[280px] flex-[1_1_180px]">
            <Label htmlFor={searchId} className="sr-only">{t('Search')}</Label>
            <Input
              id={searchId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('Search')}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <p className="m-0 ml-auto text-[13px] text-muted-foreground" aria-live="polite">
            {visibleCount === totalCount ? `${totalCount}` : `${visibleCount} of ${totalCount}`}
            {filtersOn && (
              <>
                {' · '}
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-[13px] font-normal text-muted-foreground underline underline-offset-3 hover:text-foreground"
                  onClick={() => {
                    setQuery('');
                    setActiveStatus(ALL_STATUSES);
                    setActiveType(ALL_TYPES);
                  }}
                >
                  {t('Reset')}
                </Button>
              </>
            )}
          </p>
        </div>

        {filtered.length === 0 ? (
          <p className="m-0 mb-6 rounded-lg border border-dashed border-border bg-muted p-5 text-center text-muted-foreground">{t('No matches.')}</p>
        ) : (
          filtered.map((section) => (
            <FeatureSectionBlock key={section.id} section={section} />
          ))
        )}

        <SurfaceCompleteness />

        <section id="topology" className="mt-10">
          <h2>{t('How it fits together')}</h2>
          <p className="max-w-176 text-muted-foreground">
            {t('Every service Starlings runs on, what each one stores, and what data moves between them, down to each bucket and queue.')}
          </p>
          <SystemDiagram detail="full" />
        </section>

        <DocNote>
          Surface snapshot {CAPABILITIES_REVIEWED_AT}. Intent statuses are not a build tracker.{' '}
          <code>packages/contracts/src/capabilities.ts</code>.
        </DocNote>
      </DocArticle>
    </AppShell>
  );
}

const FILTER_LABEL = 'text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase';

/**
 * Five neutral badges, graduated by ink weight. "Have", "Partial", "Want",
 * "Don't want" and "TBD" already say which is which; the wash adds the
 * at-a-glance weight. Decided against is struck through, not red; undecided
 * is a dashed edge, not a hue of its own.
 */
const INTENT_TONE: Record<Capability['intent'], string> = {
  have: 'border-foreground/32 bg-foreground/16 text-foreground',
  partial: 'border-foreground/24 bg-foreground/10 text-foreground',
  want: 'border-border bg-foreground/8 text-muted-foreground',
  'dont-want': 'border-border bg-foreground/6 text-muted-foreground line-through',
  tbd: 'border-dashed border-muted-foreground/50 bg-foreground/8 text-muted-foreground',
};

function SurfaceCompleteness() {
  return (
    <section id="surface-completeness" className="mt-[34px] mb-[52px] rounded-(--radius-card) border border-border bg-popover/40 p-6 max-sm:-mx-1 max-sm:px-3.5 max-sm:py-[18px]">
      <h2 className="mt-0 mb-[18px]">{t('By surface')}</h2>

      <div role="group" className="mb-4 grid grid-cols-4 gap-2 max-sm:grid-cols-2" aria-label={t('Surface summaries')}>
        {CAPABILITY_SURFACES.map((surface) => (
          <Card key={surface} className="min-h-26 gap-[7px] rounded-md bg-muted/85 p-[13px] shadow-none max-sm:min-h-0">
            <strong className="text-[13px] text-foreground">{SURFACE_LABEL[surface]}</strong>
            <span className="text-xs leading-[1.45] text-muted-foreground">{SURFACE_SUMMARY[surface]}</span>
          </Card>
        ))}
      </div>

      <div role="group" className="mb-[26px] flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground" aria-label={t('Surface status legend')}>
        {SURFACE_STATUSES.map((status) => <SurfaceStatusMark key={status} status={status} label="shown" />)}
      </div>

      {surfaceSections().map((section) => (
        <section key={section.id}>
          <h3>{section.title}</h3>
          <SurfaceTable rows={section.rows} last={{ title: t('Notes'), cell: (row) => row.description }} />
        </section>
      ))}
    </section>
  );
}

function FeatureSectionBlock({ section }: { section: CapabilitySection }) {
  return (
    <section id={section.id} className="mb-2">
      <h2>{section.title}</h2>
      <div className="mb-2 overflow-x-auto rounded-(--radius-card) border border-border">
        {/* Under 640px a row is a card: the header goes, and the cells stack. */}
        <Table className="leading-[1.45] max-sm:block">
          <TableHeader className="bg-muted max-sm:hidden">
            <TableRow>
              <TableHead scope="col" className={FEATURE_HEAD}>{t('Feature')}</TableHead>
              <TableHead scope="col" className={FEATURE_HEAD}>{t('Status')}</TableHead>
              <TableHead scope="col" className={FEATURE_HEAD}>{t('Notes')}</TableHead>
              <TableHead scope="col" className={FEATURE_HEAD}>{t('Agent access')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="max-sm:block">
            {section.rows.map((row) => (
              <FeatureTableRow key={row.id} row={row} />
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

const FEATURE_HEAD = 'px-3.5 text-muted-foreground';
const FEATURE_CELL = 'px-3.5 py-3 align-top max-sm:block max-sm:w-full max-sm:p-0 max-sm:[&+td]:mt-2';

function FeatureTableRow({ row }: { row: Capability }) {
  return (
    <TableRow data-status={row.intent} className="max-sm:block max-sm:px-3.5 max-sm:py-3">
      <TableCell className={`${FEATURE_CELL} min-w-48 font-medium whitespace-normal text-foreground max-sm:min-w-0`}>
        {row.name}
        {row.peer && <span className="block text-xs font-normal text-muted-foreground">{row.peer}</span>}
      </TableCell>
      <TableCell className={FEATURE_CELL}>
        <Badge variant="outline" className={INTENT_TONE[row.intent]}>
          {CAPABILITY_INTENT_LABEL[row.intent]}
        </Badge>
      </TableCell>
      <TableCell className={`${FEATURE_CELL} min-w-56 font-light whitespace-normal text-muted-foreground max-sm:min-w-0 max-sm:text-[13px]`}>
        {row.description}
      </TableCell>
      <TableCell className={`${FEATURE_CELL} min-w-40 text-[13px] font-light whitespace-normal text-muted-foreground`}>
        <span className="hidden text-xs font-semibold tracking-[0.04em] uppercase max-sm:mr-1.5 max-sm:inline">{t('Agent access')}</span>
        <AgentAccess row={row} />
      </TableCell>
    </TableRow>
  );
}

function filterSections(
  sections: CapabilitySection[],
  activeStatus: StatusFilter,
  query: string,
  activeType: FeatureType,
): CapabilitySection[] {
  const needle = query.trim().toLowerCase();
  return sections
    .filter((section) => activeType === ALL_TYPES || section.id === activeType)
    .map((section) => ({
      ...section,
      rows: section.rows.filter((row) => {
        if (activeStatus !== ALL_STATUSES && row.intent !== activeStatus) return false;
        if (!needle) return true;
        return (
          row.name.toLowerCase().includes(needle)
          || row.description.toLowerCase().includes(needle)
          || (row.peer?.toLowerCase().includes(needle) ?? false)
          || CAPABILITY_INTENT_LABEL[row.intent].toLowerCase().includes(needle)
          || row.id === needle
        );
      }),
    }))
    .filter((section) => section.rows.length > 0);
}
