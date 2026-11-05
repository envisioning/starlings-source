import { cn } from '@/lib/utils';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/ui/breadcrumb';
import { t } from './i18n';
import { usePendingPath } from './navigation';

/**
 * Admin is the org's surface, destinations by verb (docs/ADMIN.md §10):
 * what is happening, who is on the roster, what the outside sources are
 * doing, how the records are set up and who changed them, and the one-off
 * actions. Settings is
 * *me*; nothing here is.
 *
 * Every Admin page — the sections and the per-source Connectors pages
 * beneath them — draws this same nav under the same `Admin` heading, so a
 * member is never on an Admin page that looks like somewhere else.
 */
export type AdminSection = 'operations' | 'agents' | 'people' | 'connectors' | 'records' | 'activity' | 'jobs';

/** People first: `/admin` opens on it (MZ, 2026-10-18). */
export const ADMIN_SECTIONS: Array<{ id: AdminSection; label: string; href: string }> = [
  { id: 'people', label: t('People'), href: '/admin/people' },
  { id: 'operations', label: t('Operations'), href: '/admin/operations' },
  { id: 'agents', label: t('Agents'), href: '/admin/agents' },
  { id: 'connectors', label: t('Connectors'), href: '/admin/connectors' },
  { id: 'records', label: t('Records'), href: '/admin/records' },
  { id: 'activity', label: t('Activity'), href: '/admin/activity' },
  { id: 'jobs', label: t('Jobs'), href: '/admin/jobs' },
];

export function adminSectionLabel(section: AdminSection): string | undefined {
  return ADMIN_SECTIONS.find((row) => row.id === section)?.label;
}

function sectionForPath(pathname: string | null): AdminSection | undefined {
  if (!pathname) return undefined;
  const path = pathname.replace(/\/+$/u, '') || '/';
  if (path.startsWith('/admin/connectors/')) return 'connectors';
  if (path === '/admin') return 'people';
  return ADMIN_SECTIONS.find((row) => (row.href.replace(/\/+$/u, '') || '/') === path)?.id;
}

/** Section links keep their URLs, with a tab bar that belongs to Admin. */
export function AdminNav({ section }: { section: AdminSection }) {
  const pendingSection = sectionForPath(usePendingPath());
  const selectedSection = pendingSection ?? section;

  return (
    <nav className="mb-6 border-b border-border" aria-label={t('Admin sections')} aria-busy={pendingSection ? true : undefined}>
      <div className="flex min-w-full w-max items-stretch gap-1 overflow-x-auto">
        {ADMIN_SECTIONS.map((row) => {
          const selected = row.id === selectedSection;
          return (
            <a
              key={row.id}
              href={row.href}
              aria-current={row.id === section ? 'page' : undefined}
              data-selected={selected ? 'true' : undefined}
              data-pending={row.id === pendingSection ? 'true' : undefined}
              className={cn(
                'relative -mb-px inline-flex min-h-11 flex-none items-center whitespace-nowrap rounded-t-md border-b-2 border-transparent px-4 py-2 text-sm font-medium text-muted-foreground no-underline transition-colors',
                'hover-lift hover:text-foreground',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                selected && 'border-foreground bg-popover text-foreground',
              )}
            >
              {row.label}
            </a>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * The heading every Admin page shares: the word, then the nav. Named for the
 * view transition (styles.css, "Page changes") so switching sections holds it
 * still while only the content under it crosses over.
 */
export function AdminHeader({ section }: { section: AdminSection }) {
  return (
    <div className="[view-transition-name:meet-section-head]">
      <h1>{t('Admin')}</h1>
      <AdminNav section={section} />
    </div>
  );
}

/**
 * A connector's own page (Granola, GitHub, Slack): the Admin heading and
 * nav, a breadcrumb back to Connectors, then the source's name
 * and one lede.
 */
export function ConnectorHeader({ name, lede }: { name: string; lede: string }) {
  return (
    <>
      <AdminHeader section="connectors" />
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink href="/admin/connectors">{t('Connectors')}</BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbPage>{name}</BreadcrumbPage></BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <h2 className="mt-1 mb-2 text-[28px] font-[620] tracking-[-0.01em]">{name}</h2>
      <p className="lede">{lede}</p>
    </>
  );
}
