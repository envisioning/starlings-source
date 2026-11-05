import { t } from '@shared/i18n';
import type { ReactNode } from 'react';
import { ArrowDown, ArrowRight, ArrowUpRight } from 'lucide-react';
import { Button, buttonVariants } from '@/ui/button';
import { Label } from '@/ui/label';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { cn } from '@/lib/utils';
import { StarlingsWordmark } from '@shared/GatheringDots';
import { PUBLIC_WEB_ORIGIN } from '@starlings/contracts/deployment';
import { currentPath } from './site-path';

/*
 * The public site's header and footer: one source for every page. The React
 * pages render them through AppShell; prerender.mjs renders the same two
 * components into the static home page. They are shadcn components and
 * Tailwind utilities; house.css only sets the tokens, the font and the type.
 * Public navigation never reads a workspace session or links a workspace.
 */

const NAV: ReadonlyArray<readonly [string, string]> = [['/workspace', t('Product')], ['/why', t('Why')], ['/use-cases', t('Use cases')], ['/integrations', t('Integrations')], ['/pricing', t('Pricing')], ['/help', t('Help')]];
/** The footer columns: a heading and its links. An `https:` link opens off the site. */
const FOOTER_COLUMNS: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
  [t('Product'), [['/workspace', t('Workspace')], ['/integrations', t('Integrations')], ['/pricing', t('Pricing')], ['/download', t('Download')], ['/changelog', t('Changelog')], ['/workspace/status', t('Status')]]],
  [t('Solutions'), [['/use-cases', t('Use cases')], ['/for', t('Teams')], ['/compare', t('Compare')], ['/customers/envisioning', t('Customers')], ['/why', t('Why Starlings')]]],
  [t('Open standard'), [['/spec', t('Spec')], ['/agents', t('Agents')], ['/skills', t('Skills')], ['/help', t('Help')]]],
  [t('Company'), [['/about', t('About')], ['/faq', t('FAQ')], ['/field-notes', t('Field notes')], ['/security', t('Security')], [`${PUBLIC_WEB_ORIGIN}/support`, t('Contact')]]],
];
const FOOTER_LEGAL: ReadonlyArray<readonly [string, string]> = [['/privacy', t('Privacy')], ['/terms', t('Terms')]];

/** The page column: every public page, its header and its footer share it. */
export const WRAP = 'mx-auto w-[min(1152px,calc(100%-64px))] max-[800px]:w-[calc(100%-40px)]';

/** A nav link: underlined while its page is open. */
const NAV_LINK = 'aria-[current=page]:underline aria-[current=page]:underline-offset-4';

/** A footer link on a phone: 40px tall, by padding, not by bigger text. */
const FOOTER_TAP = 'max-[800px]:min-h-10';

/** A meter in the brand's primary colour. The native `progress` element draws the browser's green. */
export function Meter({ max, value, label, className }: { max: number; value: number; label: string; className?: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)}>
      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${(value / max) * 100}%` }} />
    </div>
  );
}

/** An arrow after a link's words: `next` for a page on this site, `out` for one that leaves it, `down` for this page. */
export function Arrow({ direction = 'out' }: { direction?: 'out' | 'next' | 'down' }) {
  const Icon = direction === 'down' ? ArrowDown : direction === 'next' ? ArrowRight : ArrowUpRight;
  return <Icon aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.7} />;
}

function current(href: string, path: string | undefined) {
  return path && (path === href || path.startsWith(`${href}/`)) ? 'page' as const : undefined;
}

/** A header button: 32px on a wide screen, 40px where a finger presses it. */
const PHONE_BUTTON = 'hover:no-underline max-[800px]:h-10';

/**
 * The main navigation below 800px, where the header has no room for its
 * links. A native disclosure: it opens and closes with no script, so it
 * works on the static home page, and the summary is a button to the keyboard
 * and to a screen reader.
 */
function PhoneMenu({ path }: { path?: string }) {
  // shadcn: Collapsible needs script, and this menu must open on the static home page without any
  return (
    <details className="relative hidden max-[800px]:block">
      <summary className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-10 cursor-pointer list-none [&::-webkit-details-marker]:hidden')}>
        {t('Menu')}
      </summary>
      <ul className="absolute top-[calc(100%+8px)] right-0 z-20 m-0 flex w-56 max-w-[calc(100vw-40px)] list-none flex-col rounded-md border border-border bg-popover p-1.5 text-sm text-popover-foreground shadow-(--shadow-raised)">
        {NAV.map(([target, label]) => (
          <li key={target}>
            <a href={target} className={cn(NAV_LINK, 'flex min-h-10 items-center rounded-sm px-3 hover-lift')} aria-current={current(target, path)}>{label}</a>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function SiteHeader({ path }: { path?: string }) {
  return <>
    <a className="absolute -top-20 left-6 z-10 bg-primary p-3 text-primary-foreground focus:top-2.5" href="#main">{t('Skip to content')}</a>
    <header className={cn(WRAP, 'flex items-center justify-between gap-7 border-b border-border py-8 max-[800px]:py-[22px] max-[520px]:flex-wrap max-[520px]:gap-y-3')}>
      <a className="text-[30px] hover:no-underline max-[520px]:text-[25px]" href="/" aria-label={t('Starlings home')}>
        <StarlingsWordmark />
      </a>
      <nav className="flex items-center gap-[26px] text-[13px] font-medium max-[520px]:gap-3" aria-label={t('Main navigation')}>
        {NAV.map(([target, label]) => <a key={target} href={target} className={cn(NAV_LINK, 'max-[800px]:hidden')} aria-current={current(target, path)}>{label}</a>)}
        <Button asChild variant="outline" size="sm" className={PHONE_BUTTON}>
          <a href="/sign-in" aria-current={current('/sign-in', path)}>{t('Sign in')}</a>
        </Button>
        <Button asChild variant="outline" size="sm" className={PHONE_BUTTON}>
          <a href="/interest" aria-current={current('/interest', path)}>{t('Early access')} <Arrow direction="next" /></a>
        </Button>
        <PhoneMenu path={path} />
      </nav>
    </header>
  </>;
}

/**
 * The appearance choice. appearance.js owns it: it reads and writes the
 * `[data-site-appearance]` select on every page, the static home included,
 * so this stays a native select (shadcn NativeSelect) with no React state.
 */
function AppearanceSelect() {
  return (
    <div className="inline-flex items-center gap-2">
      <Label htmlFor="site-appearance" className="text-xs font-normal text-muted-foreground">{t('Appearance')}</Label>
      <NativeSelect
        id="site-appearance"
        size="sm"
        data-site-appearance
        defaultValue={typeof document === 'undefined' ? 'dark' : document.documentElement.dataset.theme ?? 'dark'}
        className="text-xs max-[800px]:data-[size=sm]:h-10 max-[800px]:data-[size=sm]:py-2"
      >
        <NativeSelectOption value="auto">{t('System')}</NativeSelectOption>
        <NativeSelectOption value="light">{t('Light')}</NativeSelectOption>
        <NativeSelectOption value="dark">{t('Dark')}</NativeSelectOption>
      </NativeSelect>
    </div>
  );
}

export function SiteFooter() {
  return <footer className={cn(WRAP, 'pt-16 pb-[30px] text-[13px] max-[800px]:pt-12')}>
    <div className="grid grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))] gap-x-8 gap-y-10 max-[960px]:grid-cols-4 max-[560px]:grid-cols-2">
      <div className="flex flex-col items-start gap-4 max-[960px]:col-span-full">
        <a className="text-[22px] hover:no-underline" href="/" aria-label={t('Starlings home')}>
          <StarlingsWordmark />
        </a>
        <p className="m-0 max-w-[32ch] text-muted-foreground">{t('One place for your team and your AI agents to get the work done.')}</p>
      </div>
      {FOOTER_COLUMNS.map(([heading, links]) => (
        <nav key={heading} aria-label={heading} className="flex flex-col gap-3">
          <h2 className="m-0 text-xs font-medium text-muted-foreground">{heading}</h2>
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0 max-[800px]:gap-0">
            {links.map(([target, label]) => {
              const external = target.startsWith('https:');
              return <li key={target}>
                <a href={target} className={cn('inline-flex items-center gap-1', FOOTER_TAP)} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}>
                  {label}{external && <Arrow />}
                </a>
              </li>;
            })}
          </ul>
        </nav>
      ))}
    </div>
    <div className="mt-14 flex items-center justify-between gap-6 border-t border-border pt-6 text-xs text-muted-foreground max-[800px]:mt-10 max-[560px]:flex-col max-[560px]:items-start">
      <p className="m-0">© {new Date().getFullYear()} Envisioning</p>
      <div className="flex flex-wrap items-center gap-6">
        <nav aria-label={t('Legal')} className="flex items-center gap-6">
          {FOOTER_LEGAL.map(([target, label]) => <a key={target} href={target} className={cn('inline-flex items-center', FOOTER_TAP)}>{label}</a>)}
        </nav>
        <AppearanceSelect />
      </div>
    </div>
  </footer>;
}

export function AppShell({ children, variant = 'wide', fullWidth = false }: {
  children: ReactNode; variant?: 'wide' | 'document' | 'centered'; fullWidth?: boolean;
  product?: string | null; current?: string;
}) {
  return <>
    <SiteHeader path={currentPath()} />
    <main
      id="main"
      data-layout={variant}
      className={cn(
        'border-b border-border pt-[72px] pb-24 max-[800px]:pt-12 max-[800px]:pb-16',
        !fullWidth && WRAP,
      )}
    >
      {children}
    </main>
    <SiteFooter />
  </>;
}
